'use strict';
/**
 * playback.js - what plays: the queue, one player per track, the track's bytes from TIDAL to the player's stdin.
 * Runs in the root service; the bytes come through netx (in the car: the client child, the internet uid).
 * Model: aurelm-emby's and aurelm-tvhplayer's playback.js (aurelmarius, GPL-3.0-or-later): a new stream and a new
 * player per item, a broken stream opened again for 2 minutes with growing waits. Unlike theirs, a track is a
 * file, so a break is continued from the byte it stopped at (HTTP Range), not started again.
 *
 *   const pb = createPlayback({ tidal, netx, startPlayer(trackId, onEvent) -> player.js process, quality() -> 'HIGH'|'LOSSLESS',
 *                               trackInfo(id) -> track | null (asked again by status() until known), onQueue({ tracks, index, position }), log, now,
 *                               retryWaits, outageMs, streamTimeoutMs });
 *   pb.play(tracks, index)  pb.pause()  pb.resume()  pb.next()  pb.prev()  pb.stop()
 *   pb.restore(queue)       a queue from queue.json: idle, ready for resume
 *   pb.status()             the contract's status.player (plus `skipped`: the tracks passed over, and why)
 *   pb.active()             loading, playing, buffering or paused
 *   pb.players()            { running, exits, lastExit }
 *   pb.close() -> Promise   ends the player and the download
 *
 * Node 8.9.4.
 */
const WAITS = [1000, 2000, 4000, 8000, 10000];
const OUTAGE_MS = 120000;
const STREAM_TIMEOUT_MS = 15000;
const PREV_RESTART_S = 3;
const SKIPPED_KEPT = 10;
const ACTIVE = ['loading', 'playing', 'buffering', 'paused'];

function codeError(code, message) { const e = new Error(message || code); e.code = code; return e; }

function createPlayback(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const waits = o.retryWaits || WAITS;
    const outageMs = o.outageMs || OUTAGE_MS;
    const streamTimeoutMs = o.streamTimeoutMs || STREAM_TIMEOUT_MS;
    const tidal = o.tidal, netx = o.netx;

    let tracks = [], index = -1;
    let gen = 0;
    let cur = null;                       // the track being played: see startTrack
    let idle = { state: 'idle', error: null };   // what status says when nothing plays
    let skipped = [];
    let killChain = Promise.resolve();   // a new player starts once every one before it has ended (the sound device)
    const pl = { running: 0, exits: 0, lastExit: null };

    const live = (c) => cur === c && c.gen === gen;
    function saveQueue() {
        if (!o.onQueue) return;
        try { o.onQueue({ tracks: tracks.slice(), index: index, position: cur ? Math.max(0, cur.position) : 0 }); } catch (e) { log('queue: ' + e.message); }
    }

    /* ---------- one track ---------- */
    function endTrack(c) {
        if (!c) return;
        c.over = true;
        clearTimeout(c.timer);
        if (c.stream) { const s = c.stream; c.stream = null; try { s.destroy(); } catch (e) { /* gone */ } }
        if (c.player) { const p = c.player; killChain = killChain.then(() => p.kill()).then(() => {}, () => {}); }
    }
    function startTrack(i) {
        const old = cur;
        endTrack(old);
        index = i;
        const id = tracks[i];
        const info = (o.trackInfo && o.trackInfo(id)) || null;
        const c = { gen: ++gen, id: id, index: i, info: info, state: 'loading', position: 0, duration: info && info.duration ? info.duration : null,
            quality: null, error: null, player: null, stream: null, timer: null, paused: false, over: false, ended: false, playerError: null };
        cur = c;
        idle = { state: 'idle', error: null };
        saveQueue();
        const quality = o.quality ? o.quality() : 'HIGH';
        const url = Promise.resolve().then(() => tidal.streamUrl(id, quality));
        Promise.all([url, killChain]).then((r) => {
            if (!live(c)) return;
            c.quality = r[0].quality || quality;
            spawn(c);
            download(c, r[0].url);
        }, (e) => {
            if (!live(c)) return;
            if (e && e.code === 'not-available') {
                log('track ' + id + ': not available, skipped');
                skipped.push({ id: id, error: 'not-available' });
                if (skipped.length > SKIPPED_KEPT) skipped.shift();
                return advance(c);
            }
            fail(c, (e && e.code) || 'tidal-error', e && e.message);
        });
    }
    function spawn(c) {
        let p;
        try { p = o.startPlayer(c.id, (ev) => onEvent(c, ev)); } catch (e) { return fail(c, 'internal', e.message); }
        c.player = p;
        pl.running++;
        if (c.paused) p.ctl('pause');
        p.exited.then((x) => {
            pl.running--; pl.exits++;
            pl.lastExit = x.error ? x.error : (x.signal ? x.signal : 'code ' + x.code);
            if (!live(c) || c.over) return;
            if (c.ended) return advance(c);
            if (c.playerError) return fail(c, c.playerError, 'the player said ' + c.playerError);
            fail(c, 'internal', 'the player ended (' + pl.lastExit + ')');
        });
    }
    function onEvent(c, ev) {
        if (!live(c)) return;
        if (ev.ev === 'open') { if (typeof ev.duration === 'number') c.duration = ev.duration; }
        else if (ev.ev === 'tick') {
            if (typeof ev.pos === 'number' && ev.pos >= 0) c.position = ev.pos;
            if (c.paused) c.state = 'paused';
            else if (ev.state === 'buffering' || ev.state === 'playing') c.state = ev.state;
        } else if (ev.ev === 'end') c.ended = true;
        else if (ev.ev === 'error') c.playerError = ev.code || 'internal';
    }
    function fail(c, code, message) {
        if (!live(c)) return;
        log('track ' + c.id + ': ' + code + (message ? ' (' + message + ')' : ''));
        c.state = 'error'; c.error = code;
        endTrack(c);
    }
    function advance(c) {
        if (!live(c)) return;
        if (c.index + 1 < tracks.length) return startTrack(c.index + 1);
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
                if (!live(c) || c.over) { try { r.stream.destroy(); } catch (e) { /* gone */ } return; }
                const status = r.status;
                if (status === 403 || status === 401 || status === 410) {
                    try { r.stream.destroy(); } catch (e) { /* gone */ }
                    if (refreshed) return fail(c, 'tidal-error', 'the stream address was refused again (' + status + ')');
                    refreshed = true;
                    log('track ' + c.id + ': the stream address expired (' + status + '), asking for a new one');
                    return Promise.resolve().then(() => tidal.streamUrl(c.id, c.quality)).then((u) => { url = u.url; open(); },
                        (e) => fail(c, (e && e.code) || 'tidal-error', e && e.message));
                }
                if (status === 429 || status >= 500) { try { r.stream.destroy(); } catch (e) { /* gone */ } return broke('HTTP ' + status); }
                if (status !== 200 && status !== 206) { try { r.stream.destroy(); } catch (e) { /* gone */ } return fail(c, 'tidal-error', 'HTTP ' + status); }
                // where this answer starts: a server that ignores Range sends it all again
                let skip = 0;
                if (offset > 0) {
                    let start = 0;
                    const m = status === 206 ? /^bytes (\d+)-/.exec(r.headers['content-range'] || '') : null;
                    if (m) start = Number(m[1]);
                    if (start > offset) { try { r.stream.destroy(); } catch (e) { /* gone */ } return fail(c, 'tidal-error', 'the server continued at ' + start + ', not ' + offset); }
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

    /* ---------- the commands ---------- */
    function play(list, i) {
        tracks = list.slice();
        skipped = [];
        startTrack(i);
    }
    function pause() {
        const c = cur;
        if (!c || ACTIVE.indexOf(c.state) < 0 || c.paused) return;
        c.paused = true;
        c.state = 'paused';
        if (c.player) c.player.ctl('pause');
        saveQueue();
    }
    function resume() {
        const c = cur;
        if (c && c.paused && c.state === 'paused') {
            c.paused = false;
            c.state = c.player ? 'playing' : 'loading';
            if (c.player) c.player.ctl('resume');
            return;
        }
        if (c && ACTIVE.indexOf(c.state) >= 0) return;
        if (tracks.length && index >= 0) startTrack(index);   // stopped, ended, or failed: the queue's track again
    }
    function next() { if (tracks.length && index + 1 < tracks.length) startTrack(index + 1); }
    function prev() {
        if (!tracks.length || index < 0) return;
        const active = cur && ACTIVE.indexOf(cur.state) >= 0;
        if (active && (cur.position > PREV_RESTART_S || index === 0)) return startTrack(index);
        if (index > 0) startTrack(index - 1);
    }
    function stop() {
        if (!cur) return;
        const c = cur;
        endTrack(c);
        gen++;
        cur = null;
        idle = { state: 'idle', error: null };
        saveQueue();
    }
    function restore(q) {
        if (!q || !Array.isArray(q.tracks)) return;
        tracks = q.tracks.slice();
        index = tracks.length ? Math.max(0, Math.min(q.index, tracks.length - 1)) : -1;
    }
    function status() {
        const c = cur;
        // a track not known at its start (looked up meanwhile by trackInfo, which never waits)
        if (c && !c.info && o.trackInfo) {
            c.info = o.trackInfo(c.id) || null;
            if (c.info && c.duration === null && c.info.duration) c.duration = c.info.duration;
        }
        const info = c ? c.info : null;
        const base = { queueIndex: tracks.length ? index : -1, queueLength: tracks.length, skipped: skipped.slice() };
        if (!c) return Object.assign({ state: idle.state, track: null, position: 0, duration: null, quality: null, error: idle.error }, base);
        return Object.assign({ state: c.state, track: info, position: Math.max(0, c.position), duration: c.duration, quality: c.quality, error: c.error }, base);
    }
    function close() {
        if (cur) endTrack(cur);
        gen++;
        cur = null;
        return killChain;
    }
    return {
        play: play, pause: pause, resume: resume, next: next, prev: prev, stop: stop, restore: restore, status: status, close: close,
        active: () => !!(cur && ACTIVE.indexOf(cur.state) >= 0),
        players: () => ({ running: pl.running > 0, exits: pl.exits, lastExit: pl.lastExit }),
        queue: () => ({ tracks: tracks.slice(), index: index, position: cur ? cur.position : 0 }),
    };
}

module.exports = { createPlayback: createPlayback, codeError: codeError };
