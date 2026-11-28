'use strict';
/**
 * playback.js - what plays: the queue, one player per track, the track's bytes from TIDAL to the player's stdin.
 * Runs in the root service; the bytes come through netx (in the car: the client child, the internet uid).
 * Model: aurelm-emby's and aurelm-tvhplayer's playback.js (aurelmarius, GPL-3.0-or-later): a new stream and a new
 * player per item, a broken stream opened again for 2 minutes with growing waits. Unlike theirs, a track is a
 * file, so a break is continued from the byte it stopped at (HTTP Range), not started again.
 *
 *   const pb = createPlayback({ tidal, netx, startPlayer(id, onEvent, startMs, { kind, baseMs }) -> player.js process,
 *                               quality() -> 'HIGH'|'LOSSLESS', videoHeight() -> 480|720|1080,
 *                               trackInfo(id, kind) -> track | video | null (asked again by status() until known),
 *                               onQueue({ tracks, index, position, kinds? }), log, now, retryWaits, outageMs,
 *                               streamTimeoutMs, segmentTries });
 *   pb.play(ids, index, kinds)  pb.pause()  pb.resume()  pb.next()  pb.prev()  pb.stop()
 *                           kinds: 'track' or 'video' for each id (none: every id is a track)
 *   pb.seek(seconds) -> false when nothing plays. A new player for the same track, started at the position
 *                           (startMs -> MGU_START_MS): the download starts again at the file's first byte and the
 *                           player throws away the sound before the position (docs/PROTOCOL.md, seek). Paused stays
 *                           paused. At the track's end or past it: the next track. A video starts again at the HLS
 *                           segment holding the position (baseMs -> MGU_BASE_MS: that segment's start).
 *   pb.restore(queue)       a queue from queue.json: idle, ready for resume
 *   pb.status()             the contract's status.player (plus `skipped`: the tracks passed over, and why; `video`:
 *                           the picture { file, width, height } once the video player says it is open, else null)
 *   pb.active()             loading, playing, buffering or paused
 *   pb.players()            { running, exits, lastExit }
 *   pb.close() -> Promise   ends the player and the download
 *
 * A video (contract 4): tidal.videoUrl() gives TIDAL's HLS master playlist; the variant closest to videoHeight() (not
 * above it when a lower one exists, lib/tidal/hls.js) is fetched, then its MPEG-TS segments one after another into the
 * one player's stdin, with the pipes' backpressure. A break inside a segment continues with Range, as a track's; a
 * segment the server refuses (an HTTP error) is tried again, and skipped after segmentTries (logged); an expired
 * address (401, 403, 410) asks TIDAL for a new master once and continues at the same segment.
 *
 * Node 8.9.4.
 */
const hls = require('./lib/tidal/hls');

const WAITS = [1000, 2000, 4000, 8000, 10000];
const OUTAGE_MS = 120000;
const STREAM_TIMEOUT_MS = 15000;
const PREV_RESTART_S = 3;
const SKIPPED_KEPT = 10;
const MAX_START_MS = 24 * 3600 * 1000;   // the player's limit for MGU_START_MS; no track is that long
const SEGMENT_TRIES = 2;                 // a video segment the server refuses this many times is skipped
const PLAYLIST_TRIES = 3;
const PLAYLIST_MAX_BYTES = 1024 * 1024;
const DEFAULT_VIDEO_HEIGHT = 720;
const ACTIVE = ['loading', 'playing', 'buffering', 'paused'];

function codeError(code, message) { const e = new Error(message || code); e.code = code; return e; }
/** seconds for the log: at most one decimal */
function secs(s) { return String(Math.round(Number(s) * 10) / 10); }
const isSize = (v) => typeof v === 'number' && Math.floor(v) === v && v >= 16 && v <= 2048;
const destroy = (s) => { try { s.destroy(); } catch (e) { /* gone */ } };

function createPlayback(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const waits = o.retryWaits || WAITS;
    const outageMs = o.outageMs || OUTAGE_MS;
    const streamTimeoutMs = o.streamTimeoutMs || STREAM_TIMEOUT_MS;
    const segmentTries = o.segmentTries || SEGMENT_TRIES;
    const tidal = o.tidal, netx = o.netx;

    let tracks = [], kinds = [], index = -1;
    let gen = 0;
    let cur = null;                       // the track being played: see startTrack
    let idle = { state: 'idle', error: null };   // what status says when nothing plays
    let skipped = [];
    let killChain = Promise.resolve();   // a new player starts once every one before it has ended (the sound device)
    const pl = { running: 0, exits: 0, lastExit: null };

    const kindAt = (i) => (kinds[i] === 'video' ? 'video' : 'track');
    const what = (c) => c.kind + ' ' + c.id;
    const live = (c) => cur === c && c.gen === gen;
    function saveQueue() {
        if (!o.onQueue) return;
        const q = { tracks: tracks.slice(), index: index, position: cur ? Math.max(0, cur.position) : 0 };
        // the kinds only when a video is in it: a queue of tracks is written as before
        if (kinds.indexOf('video') >= 0) q.kinds = tracks.map((t, i) => kindAt(i));
        try { o.onQueue(q); } catch (e) { log('queue: ' + e.message); }
    }

    /* ---------- one track ---------- */
    function endTrack(c) {
        if (!c) return;
        c.over = true;
        clearTimeout(c.timer);
        if (c.stream) { const s = c.stream; c.stream = null; destroy(s); }
        if (c.player) { const p = c.player; killChain = killChain.then(() => p.kill()).then(() => {}, () => {}); }
    }
    /**
     * The queue's track i, in a new player (the one before is ended first). `from` (a seek, or the track after one):
     * { position (s), paused, and of the same track: url, quality, duration, hls (a video's playlists) }. `why`, for
     * the log: play, next, prev, resume, queue (the track before ended or was skipped), seek.
     */
    function startTrack(i, why, from) {
        const f = from || {};
        const old = cur;
        endTrack(old);
        index = i;
        const id = tracks[i];
        const kind = kindAt(i);
        const position = f.position > 0 ? f.position : 0;
        if (why === 'seek') log('seek: ' + kind + ' ' + id + ' to ' + secs(f.position) + ' s' + (f.hls ? seekWhere(f.hls, position) : ''));
        else log(why + ': ' + kind + ' ' + id + ' (' + (i + 1) + ' of ' + tracks.length + ')');
        const info = (o.trackInfo && o.trackInfo(id, kind)) || null;
        const c = { gen: ++gen, id: id, kind: kind, index: i, info: info, state: f.paused ? 'paused' : 'loading', position: position,
            startMs: Math.min(Math.round(position * 1000), MAX_START_MS), baseMs: 0,
            duration: typeof f.duration === 'number' ? f.duration : (info && info.duration ? info.duration : null),
            quality: f.quality || null, url: null, codec: null, said: false, error: null, player: null, stream: null, timer: null, paused: !!f.paused, over: false, ended: false, playerError: null,
            hls: null, video: null, decoder: null };
        cur = c;
        idle = { state: 'idle', error: null };
        saveQueue();
        if (kind === 'video') return startVideo(c, f);
        const quality = f.quality || (o.quality ? o.quality() : 'HIGH');
        // a seek plays the address the track has (one that expired meanwhile is asked for again by the download)
        const url = f.url ? Promise.resolve({ url: f.url, quality: quality }) : Promise.resolve().then(() => tidal.streamUrl(id, quality));
        Promise.all([url, killChain]).then((r) => {
            if (!live(c)) return;
            c.quality = r[0].quality || quality;
            c.url = r[0].url;
            spawn(c);
            download(c, r[0].url);
        }, (e) => notStarted(c, e));
    }
    /** the stream address (or a video's playlists) could not be had: not available is skipped, the rest is an error */
    function notStarted(c, e) {
        if (!live(c)) return;
        if (e && e.code === 'not-available') {
            log(what(c) + ': not available, skipped');
            skipped.push({ id: c.id, error: 'not-available' });
            if (skipped.length > SKIPPED_KEPT) skipped.shift();
            return advance(c);
        }
        fail(c, (e && e.code) || 'tidal-error', e && e.message);
    }
    function spawn(c) {
        let p;
        try { p = o.startPlayer(c.id, (ev) => onEvent(c, ev), c.startMs, { kind: c.kind, baseMs: c.baseMs }); } catch (e) { return fail(c, 'internal', e.message); }
        c.player = p;
        pl.running++;
        if (c.paused) p.ctl('pause');
        p.exited.then((x) => {
            pl.running--; pl.exits++;
            pl.lastExit = x.error ? x.error : (x.signal ? x.signal : 'code ' + x.code);
            if (live(c)) c.video = null;
            if (!live(c) || c.over) return;
            if (c.ended) return advance(c);
            if (c.playerError) return fail(c, c.playerError, 'the player said ' + c.playerError);
            fail(c, 'internal', 'the player ended (' + pl.lastExit + ')');
        });
    }
    function onEvent(c, ev) {
        if (!live(c)) return;
        // a video's length is its playlist's (an MPEG-TS input does not say it)
        if (ev.ev === 'open') { if (typeof ev.duration === 'number' && !c.hls) c.duration = ev.duration; if (typeof ev.codec === 'string') c.codec = ev.codec; }
        else if (ev.ev === 'video') {
            // the picture: there once the player says where it goes; an error: the sound plays alone
            const ok = ev.state === 'open' && typeof ev.file === 'string' && ev.file[0] === '/' && isSize(ev.width) && isSize(ev.height);
            c.video = ok ? { file: ev.file, width: ev.width, height: ev.height } : null;
            if (typeof ev.decoder === 'string') c.decoder = ev.decoder;
            if (!ok) log(what(c) + ': no picture (' + String(ev.message || ev.state).slice(0, 100) + '), the sound plays alone');
        } else if (ev.ev === 'tick') {
            if (typeof ev.pos === 'number' && ev.pos >= 0) c.position = ev.pos;
            if (c.paused) c.state = 'paused';
            // a player started by a seek says buffering while it throws away the sound before the position: still loading
            else if (ev.state === 'buffering' && c.startMs && !c.said) c.state = 'loading';
            else if (ev.state === 'buffering' || ev.state === 'playing') c.state = ev.state;
            // once for each player, when its sound starts: what plays, and how
            if (ev.state === 'playing' && !c.said) {
                c.said = true;
                const from = c.startMs ? ' from ' + secs(c.startMs / 1000) + ' s' : '';
                if (c.kind === 'video') log('playing video ' + c.id + ' (' + (c.hls && c.hls.height ? c.hls.height + 'p' : '?p') + (c.decoder ? ', ' + c.decoder : '') + (c.video ? '' : ', no picture') + ')' + from);
                else log('playing track ' + c.id + ' (' + c.quality + (c.codec ? ', ' + c.codec : '') + ')' + from);
            }
        } else if (ev.ev === 'end') c.ended = true;
        else if (ev.ev === 'error') c.playerError = ev.code || 'internal';
    }
    function fail(c, code, message) {
        if (!live(c)) return;
        log(what(c) + ': ' + code + (message && message !== code ? ' (' + message + ')' : ''));
        c.state = 'error'; c.error = code; c.video = null;
        endTrack(c);
    }
    function advance(c, from) {
        if (!live(c)) return;
        if (c.index + 1 < tracks.length) return startTrack(c.index + 1, 'queue', from);
        log('queue: the last track is over');
        endTrack(c);
        cur = null;
        idle = { state: 'idle', error: null };
        saveQueue();
    }

    /* ---------- the download: TIDAL -> the player's stdin ---------- */
    function download(c, firstUrl) {
        let url = firstUrl, offset = 0, refreshed = false, breakAt = null, tries = 0;
        let full = false, brokeWhileFull = false;
        function broke(why) {
            if (!live(c) || c.over) return;
            if (breakAt === null) breakAt = now();
            if (now() - breakAt > outageMs) return fail(c, 'offline', 'the download broke ' + Math.round((now() - breakAt) / 1000) + ' s ago: ' + why);
            const wait = waits[Math.min(tries, waits.length - 1)];
            tries++;
            log('track ' + c.id + ': download broke at byte ' + offset + ' (' + why + '); again in ' + wait + ' ms');
            c.timer = setTimeout(open, wait);
        }
        function open() {
            if (!live(c) || c.over) return;
            const headers = offset > 0 ? { Range: 'bytes=' + offset + '-' } : {};
            Promise.resolve().then(() => netx.openStream({ url: url, headers: headers, timeoutMs: streamTimeoutMs })).then((r) => {
                if (!live(c) || c.over) { destroy(r.stream); return; }
                const status = r.status;
                if (status === 403 || status === 401 || status === 410) {
                    destroy(r.stream);
                    if (refreshed) return fail(c, 'tidal-error', 'the stream address was refused again (' + status + ')');
                    refreshed = true;
                    log('track ' + c.id + ': the stream address expired (' + status + '), asking for a new one');
                    return Promise.resolve().then(() => tidal.streamUrl(c.id, c.quality)).then((u) => { url = u.url; if (live(c)) c.url = u.url; open(); },
                        (e) => fail(c, (e && e.code) || 'tidal-error', e && e.message));
                }
                if (status === 429 || status >= 500) { destroy(r.stream); return broke('HTTP ' + status); }
                if (status !== 200 && status !== 206) { destroy(r.stream); return fail(c, 'tidal-error', 'HTTP ' + status); }
                // where this answer starts: a server that ignores Range sends it all again
                let skip = 0;
                if (offset > 0) {
                    let start = 0;
                    const m = status === 206 ? /^bytes (\d+)-/.exec(r.headers['content-range'] || '') : null;
                    if (m) start = Number(m[1]);
                    if (start > offset) { destroy(r.stream); return fail(c, 'tidal-error', 'the server continued at ' + start + ', not ' + offset); }
                    skip = offset - start;
                }
                const s = r.stream;
                c.stream = s;
                s.on('data', (d) => {
                    if (c.stream !== s) return;
                    if (skip) { if (d.length <= skip) { skip -= d.length; return; } d = d.slice(skip); skip = 0; }
                    offset += d.length;
                    breakAt = null; tries = 0;
                    if (!c.player.stdin.write(d) && !full) {
                        full = true;
                        s.pause();
                        c.player.stdin.once('drain', () => {
                            full = false;
                            if (c.stream === s) s.resume();
                            else if (brokeWhileFull) { brokeWhileFull = false; broke('broken while the player was full'); }
                        });
                    }
                });
                s.on('end', () => {
                    if (c.stream !== s) return;
                    c.stream = null;
                    log('track ' + c.id + ': downloaded, ' + offset + ' bytes');
                    try { c.player.stdin.end(); } catch (e) { /* gone */ }
                });
                s.on('error', (e) => {
                    if (c.stream !== s) return;
                    c.stream = null;
                    // a connection that went quiet while the player had enough: continued when it wants more
                    if (full) { brokeWhileFull = true; return; }
                    broke(e && e.message);
                });
            }, (e) => {
                if (!live(c) || c.over) return;
                if (e && (e.code === 'not-logged-in' || e.code === 'login-expired')) return fail(c, e.code, e.message);
                broke(e && e.message);
            });
        }
        open();
    }

    /* ---------- a video: its HLS playlists, then its segments -> the player's stdin ---------- */
    /** ' (segment 3 of 5, from 12 s)': where a seek in a video starts, for the log */
    function seekWhere(h, position) {
        const k = hls.segmentAt(h.segments, position);
        return ' (segment ' + (k + 1) + ' of ' + h.segments.length + ', from ' + secs(h.segments[k].start) + ' s)';
    }
    /** a playlist's text, tried again after a network or server failure; a refused address is a tidal-error */
    function fetchText(c, url) {
        let n = 0;
        function attempt() {
            if (!live(c) || c.over) return Promise.reject(codeError('tidal-error', 'not wanted any more'));
            n++;
            return Promise.resolve().then(() => netx.request({ method: 'GET', url: url, headers: {}, timeoutMs: streamTimeoutMs, maxBytes: PLAYLIST_MAX_BYTES })).then((r) => {
                if (r.status === 200) return r.body.toString('utf8');
                const e = codeError(r.status === 404 ? 'not-available' : 'tidal-error', 'the video playlist: HTTP ' + r.status);
                e.retry = r.status === 429 || r.status >= 500;
                throw e;
            }).catch((e) => {
                const again = e && (e.retry || e.code === 'offline');
                if (!again || n >= PLAYLIST_TRIES || !live(c) || c.over) throw e;
                const wait = waits[Math.min(n - 1, waits.length - 1)];
                log(what(c) + ': the playlist failed (' + (e.message || e.code) + '); again in ' + wait + ' ms');
                return new Promise((r) => setTimeout(r, wait)).then(attempt);
            });
        }
        return attempt();
    }
    /**
     * The video's playlists: TIDAL's master address, the variant closest to `height`, its segments.
     * -> { height (wanted), variant, segments, duration, quality }
     */
    function loadHls(c, height) {
        return Promise.resolve().then(() => tidal.videoUrl(c.id, height)).then((u) => fetchText(c, u.url).then((text) => {
            if (!hls.isMaster(text)) return [{ url: u.url, width: null, height: null, bandwidth: 0 }, text];
            const variant = hls.chooseVariant(hls.parseMaster(text, u.url), height);
            return fetchText(c, variant.url).then((t) => [variant, t]);
        }).then((vt) => {
            const variant = vt[0];
            const m = hls.parseMedia(vt[1], variant.url);
            if (m.encrypted) throw codeError('not-available', 'the video is encrypted');
            log(what(c) + ': ' + (variant.width && variant.height ? variant.width + 'x' + variant.height : 'one picture size') + ', ' + m.segments.length + ' segments, ' + secs(m.duration) + ' s' +
                (variant.bandwidth ? ' (' + secs(variant.bandwidth / 1e6) + ' Mbit/s)' : ''));
            return { wanted: height, height: variant.height, variant: variant, segments: m.segments, duration: m.duration, quality: u.quality || null };
        }));
    }
    function startVideo(c, f) {
        const height = o.videoHeight ? o.videoHeight() : DEFAULT_VIDEO_HEIGHT;
        const load = f.hls ? Promise.resolve(f.hls) : loadHls(c, height);
        Promise.all([load, killChain]).then((r) => {
            if (!live(c)) return;
            const h = r[0];
            c.hls = h;
            c.quality = h.quality;
            c.duration = h.duration;
            // a seek (or a restart at a position): the segment holding it; the player is told where its input starts
            const k = c.position > 0 ? hls.segmentAt(h.segments, c.position) : 0;
            c.baseMs = Math.min(Math.round(h.segments[k].start * 1000), MAX_START_MS);
            spawn(c);
            if (c.player) downloadVideo(c, k);
        }, (e) => notStarted(c, e));
    }
    function downloadVideo(c, first) {
        let i = first, offset = 0, fails = 0, refreshed = false, breakAt = null, tries = 0, bytes = 0, skippedSegs = 0;
        let waiting = false, brokeWhileFull = false;
        const segs = () => c.hls.segments;
        const label = (k) => 'segment ' + (k + 1) + ' of ' + segs().length;
        function next() {
            i++; offset = 0; fails = 0;
            if (i < segs().length) return open();
            log(what(c) + ': downloaded, ' + (segs().length - first) + ' segments, ' + bytes + ' bytes' + (skippedSegs ? ', ' + skippedSegs + ' skipped' : ''));
            try { c.player.stdin.end(); } catch (e) { /* gone */ }
        }
        /** the connection broke (or none could be made): the same segment again, with Range, until the outage time */
        function broke(why) {
            if (!live(c) || c.over) return;
            if (breakAt === null) breakAt = now();
            if (now() - breakAt > outageMs) return fail(c, 'offline', 'the download broke ' + Math.round((now() - breakAt) / 1000) + ' s ago: ' + why);
            const wait = waits[Math.min(tries, waits.length - 1)];
            tries++;
            log(what(c) + ': ' + label(i) + ' broke at byte ' + offset + ' (' + why + '); again in ' + wait + ' ms');
            c.timer = setTimeout(open, wait);
        }
        /** the server refused the segment: tried again, then skipped (the player's demuxer finds its way past a gap) */
        function refused(why) {
            if (!live(c) || c.over) return;
            fails++;
            if (fails >= segmentTries) {
                log(what(c) + ': ' + label(i) + ' skipped (' + why + ')');
                skippedSegs++;
                return next();
            }
            const wait = waits[Math.min(fails - 1, waits.length - 1)];
            log(what(c) + ': ' + label(i) + ' failed (' + why + '); again in ' + wait + ' ms');
            c.timer = setTimeout(open, wait);
        }
        function open() {
            if (!live(c) || c.over) return;
            const headers = offset > 0 ? { Range: 'bytes=' + offset + '-' } : {};
            Promise.resolve().then(() => netx.openStream({ url: segs()[i].url, headers: headers, timeoutMs: streamTimeoutMs })).then((r) => {
                if (!live(c) || c.over) { destroy(r.stream); return; }
                const status = r.status;
                if (status === 403 || status === 401 || status === 410) {
                    destroy(r.stream);
                    if (refreshed) return fail(c, 'tidal-error', 'the video address was refused again (' + status + ')');
                    refreshed = true;
                    log(what(c) + ': the stream address expired (' + status + '), asking for a new one');
                    // the same picture size as before, so the stream the player has goes on the same
                    return loadHls(c, c.hls.wanted).then((h) => {
                        if (!live(c) || c.over) return;
                        c.hls = h;
                        if (i >= segs().length) { i = segs().length - 1; return next(); }
                        open();
                    }, (e) => fail(c, (e && e.code) || 'tidal-error', e && e.message));
                }
                if (status === 429) { destroy(r.stream); return broke('HTTP 429'); }
                if (status !== 200 && status !== 206) { destroy(r.stream); return refused('HTTP ' + status); }
                let skip = 0;
                if (offset > 0) {
                    let start = 0;
                    const m = status === 206 ? /^bytes (\d+)-/.exec(r.headers['content-range'] || '') : null;
                    if (m) start = Number(m[1]);
                    if (start > offset) { destroy(r.stream); return refused('the server continued at ' + start + ', not ' + offset); }
                    skip = offset - start;
                }
                const s = r.stream;
                c.stream = s;
                s.on('data', (d) => {
                    if (c.stream !== s) return;
                    if (skip) { if (d.length <= skip) { skip -= d.length; return; } d = d.slice(skip); skip = 0; }
                    offset += d.length; bytes += d.length;
                    breakAt = null; tries = 0;
                    if (!c.player.stdin.write(d)) {
                        s.pause();
                        if (waiting) return;
                        waiting = true;
                        // whichever segment is being read when the player wants more goes on
                        c.player.stdin.once('drain', () => {
                            waiting = false;
                            if (c.stream) c.stream.resume();
                            else if (brokeWhileFull) { brokeWhileFull = false; broke('broken while the player was full'); }
                        });
                    }
                });
                s.on('end', () => {
                    if (c.stream !== s) return;
                    c.stream = null;
                    refreshed = false;   // this address worked: a later expiry may ask again
                    next();
                });
                s.on('error', (e) => {
                    if (c.stream !== s) return;
                    c.stream = null;
                    if (waiting) { brokeWhileFull = true; return; }
                    broke(e && e.message);
                });
            }, (e) => {
                if (!live(c) || c.over) return;
                if (e && (e.code === 'not-logged-in' || e.code === 'login-expired')) return fail(c, e.code, e.message);
                broke(e && e.message);
            });
        }
        open();
    }

    /* ---------- the commands ---------- */
    function play(list, i, k) {
        tracks = list.slice();
        kinds = Array.isArray(k) && k.length === tracks.length ? k.map((x) => (x === 'video' ? 'video' : 'track')) : tracks.map(() => 'track');
        skipped = [];
        startTrack(i, 'play');
    }
    function pause() {
        const c = cur;
        if (!c || ACTIVE.indexOf(c.state) < 0 || c.paused) return;
        c.paused = true;
        c.state = 'paused';
        log('pause: ' + what(c));
        if (c.player) c.player.ctl('pause');
        saveQueue();
    }
    function resume() {
        const c = cur;
        if (c && c.paused && c.state === 'paused') {
            c.paused = false;
            c.state = c.player ? 'playing' : 'loading';
            log('resume: ' + what(c));
            if (c.player) c.player.ctl('resume');
            return;
        }
        if (c && ACTIVE.indexOf(c.state) >= 0) return;
        if (tracks.length && index >= 0) startTrack(index, 'resume');   // stopped, ended, or failed: the queue's track again
    }
    function next() { if (tracks.length && index + 1 < tracks.length) startTrack(index + 1, 'next'); }
    function prev() {
        if (!tracks.length || index < 0) return;
        const active = cur && ACTIVE.indexOf(cur.state) >= 0;
        if (active && (cur.position > PREV_RESTART_S || index === 0)) return startTrack(index, 'prev');
        if (index > 0) startTrack(index - 1, 'prev');
    }
    function seek(position) {
        const c = cur;
        if (!c || ACTIVE.indexOf(c.state) < 0) return false;
        // at the end or past it: the next track (after the last one playback ends), paused if this one was
        if (c.duration !== null && position >= c.duration) {
            log('seek: ' + what(c) + ' to ' + secs(position) + ' s, its end (' + secs(c.duration) + ' s)');
            advance(c, { paused: c.paused });
            return true;
        }
        // a length not known yet: the player says `end` at once when the position is past it
        startTrack(c.index, 'seek', { position: position, paused: c.paused, url: c.url, quality: c.quality, duration: c.duration, hls: c.hls });
        return true;
    }
    function stop() {
        if (!cur) return;
        const c = cur;
        log('stop: ' + what(c));
        endTrack(c);
        gen++;
        cur = null;
        idle = { state: 'idle', error: null };
        saveQueue();
    }
    function restore(q) {
        if (!q || !Array.isArray(q.tracks)) return;
        tracks = q.tracks.slice();
        kinds = Array.isArray(q.kinds) && q.kinds.length === tracks.length ? q.kinds.map((x) => (x === 'video' ? 'video' : 'track')) : tracks.map(() => 'track');
        index = tracks.length ? Math.max(0, Math.min(q.index, tracks.length - 1)) : -1;
    }
    function status() {
        const c = cur;
        // a track not known at its start (looked up meanwhile by trackInfo, which never waits)
        if (c && !c.info && o.trackInfo) {
            c.info = o.trackInfo(c.id, c.kind) || null;
            if (c.info && c.duration === null && c.info.duration) c.duration = c.info.duration;
        }
        const info = c ? c.info : null;
        const base = { queueIndex: tracks.length ? index : -1, queueLength: tracks.length, skipped: skipped.slice() };
        if (!c) return Object.assign({ state: idle.state, track: null, position: 0, duration: null, quality: null, error: idle.error, video: null }, base);
        return Object.assign({ state: c.state, track: info, position: Math.max(0, c.position), duration: c.duration, quality: c.quality, error: c.error,
            video: c.video ? { file: c.video.file, width: c.video.width, height: c.video.height } : null }, base);
    }
    function close() {
        if (cur) endTrack(cur);
        gen++;
        cur = null;
        return killChain;
    }
    return {
        play: play, pause: pause, resume: resume, next: next, prev: prev, seek: seek, stop: stop, restore: restore, status: status, close: close,
        active: () => !!(cur && ACTIVE.indexOf(cur.state) >= 0),
        players: () => ({ running: pl.running > 0, exits: pl.exits, lastExit: pl.lastExit }),
        queue: () => ({ tracks: tracks.slice(), index: index, position: cur ? cur.position : 0 }),
    };
}

module.exports = { createPlayback: createPlayback, codeError: codeError };
