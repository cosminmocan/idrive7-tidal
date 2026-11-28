'use strict';
/**
 * service.js - cmocan-tidal, the background service for the app cmocan_tidal. Root, the unit's /usr/bin/node.
 *
 * Started by the app's first connection to /run/cmocan-tidal.sock (systemd socket activation), never at boot.
 * The control socket is docs/PROTOCOL.md section 1: one JSON request a line, one JSON answer a line, by id.
 *
 *   service.js (root)   the control socket, the state (state.js), the TIDAL module (lib/tidal.js) and the queue
 *                       (playback.js); TIDAL's requests go through
 *   client.js           a child as the tool's internet uid (13150): lib/netx.js, the only process with internet
 *   tidal-player        one per track (player.js), started as root with MGU_RUN_AS=nobody, MGU_GROUPS=mgu_alsa,audio
 *   tidal-video         one per video instead (contract 4), the same way, with MGU_VIDEO=shm:cmocan-tidal,
 *                       MGU_VIDEO_DECODER=auto, MGU_GROUPS=mgu_alsa,audio,video; its stdin: the HLS segments in order
 *
 * The log (log.js): every line goes to the journal and into the newest 200 the `log` command returns, with no token
 * and no address's query in it.
 *
 * The app's watch: 90 s without a request while a track plays (or is paused) stops it (rule R8); 10 minutes without
 * a request while nothing plays ends the service (exit 0). README.md has the rest.
 *
 *   const svc = createService({ stateDir, leasePath, uid, now, log, exit(code), createTidal, netx (no client child),
 *       forkClient, clientPath, clientEnv, restarts: { max, windowMs, delayMs }, spawn, playerBin, playerArgs,
 *       videoBin, videoArgs, videoName ('cmocan-tidal': the frame file /dev/shm/mgu-video-<name>), videoDecoder ('auto'),
 *       playerEnv (object, or (id, kind) -> object), audio, retryWaits, outageMs, segmentTries, cacheMs, watchMs, idleMs, tickMs });
 *   svc.listen(path | fd) -> Promise   svc.start()   svc.stop(code) -> Promise (children ended, then exit(code))
 *   svc.tick()   (the watch, every tickMs)   svc.status()   svc.netx
 *
 * Node 8.9.4 syntax. Every path, uid, clock and spawn is an option, so the tests run it unprivileged in a temp folder.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createState, rmrf } = require('./state');
const { createClientLink } = require('./client');
const { createPlayback } = require('./playback');
const { createPlayerProcess } = require('./player');
const { createLog } = require('./log');

const VERSION = '0.1.2';
const MAX_LINE = 64 * 1024;
const LEASE = '/run/mgu-uplink/lease.json';
const STATE_DIR = '/var/opt/cmocan-tidal/state';
const SOCK = '/run/cmocan-tidal.sock';
const CACHE_MS = 5 * 60000;      // a list is asked again after this
const CACHE_LISTS = 200;
const CACHE_TRACKS = 5000;
const LOOKUP_RETRY_MS = 60000;   // a track TIDAL could not give (offline, not-found) is asked again after this
const WATCH_MS = 90 * 1000;        // playing and no request from the app for this long: stopped (rule R8)
const IDLE_MS = 10 * 60 * 1000;    // nothing playing and no request for this long: the service ends (exit 0)
const TICK_MS = 5000;
const NET_UID = 13150;    // component.json "uids": the only uid of this tool mgu-uplink routes

const COMMANDS = ['status', 'login-start', 'login-cancel', 'logout', 'favorites', 'playlists', 'playlist', 'album',
    'mixes', 'mix', 'search', 'cover', 'play', 'pause', 'resume', 'next', 'prev', 'stop', 'seek', 'prefs', 'log', 'exit'];
const ERROR_CODES = ['offline', 'not-logged-in', 'login-expired', 'not-found', 'not-available', 'rate-limited',
    'tidal-error', 'bad-request', 'busy'];
const QUALITIES = ['LOSSLESS', 'HIGH'];
const KINDS = ['track', 'video'];
const FAVORITE_KINDS = ['tracks', 'albums', 'videos'];
const VIDEO_HEIGHTS = [480, 720, 1080];
const VIDEO_HEIGHT = 720;           // the default: 3.1 Mbit/s on LTE (WORKPLAN.md, V1)
const VIDEO_NAME = 'cmocan-tidal';  // the frame file /dev/shm/mgu-video-cmocan-tidal (docs/PROTOCOL.md section 2)
const VIDEO_GROUPS = 'mgu_alsa,audio,video';

/* ---------- the requests (docs/PROTOCOL.md, "Requests") ---------- */
const isInt = (v) => typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ids TIDAL gives: UUIDs and hex strings; anything else never reaches a path or an address
const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
function paging(r) {
    return (r.offset === undefined || (isInt(r.offset) && r.offset >= 0)) && (r.limit === undefined || (isInt(r.limit) && r.limit >= 1 && r.limit <= 100));
}
const PARAMS = {
    favorites: (r) => FAVORITE_KINDS.indexOf(r.kind) >= 0 && paging(r),
    playlists: paging,
    playlist: (r) => typeof r.uuid === 'string' && ID_TEXT.test(r.uuid) && paging(r),
    album: (r) => isInt(r.albumId) && r.albumId >= 1 && paging(r),
    mixes: paging,
    mix: (r) => typeof r.mixId === 'string' && ID_TEXT.test(r.mixId) && paging(r),
    search: (r) => typeof r.query === 'string' && r.query.length >= 1 && r.query.length <= 200 && paging(r),
    cover: (r) => typeof r.coverId === 'string' && ID_TEXT.test(r.coverId),
    play: (r) => Array.isArray(r.tracks) && r.tracks.length >= 1 && r.tracks.length <= 1000 && r.tracks.every((t) => isInt(t) && t > 0) &&
        isInt(r.index) && r.index >= 0 && r.index < r.tracks.length &&
        (r.kinds === undefined || (Array.isArray(r.kinds) && r.kinds.length === r.tracks.length && r.kinds.every((k) => KINDS.indexOf(k) >= 0))),
    prefs: (r) => (r.quality === undefined || QUALITIES.indexOf(r.quality) >= 0) && (r.videoHeight === undefined || VIDEO_HEIGHTS.indexOf(r.videoHeight) >= 0),
    seek: (r) => typeof r.position === 'number' && isFinite(r.position) && r.position >= 0,
    log: (r) => r.lines === undefined || (isInt(r.lines) && r.lines >= 1 && r.lines <= 200),
};
/** the request's id (or null), and whether it is a valid request */
function check(r) {
    const id = isObj(r) && isInt(r.id) && r.id >= 1 ? r.id : null;
    if (id === null || COMMANDS.indexOf(r.cmd) < 0) return { id: id, ok: false };
    return { id: id, ok: !PARAMS[r.cmd] || PARAMS[r.cmd](r) };
}

function codeError(code, message) { const e = new Error(message || code); e.code = code; return e; }
/** an error as the contract's answer: its code passed on when it is one of the contract's, else tidal-error */
function errorAnswer(id, e) {
    const a = { id: id, ok: false, error: e && ERROR_CODES.indexOf(e.code) >= 0 ? e.code : 'tidal-error' };
    if (e && e.message && e.message !== a.error) a.message = String(e.message).slice(0, 300);
    if (a.error === 'rate-limited' && e.retryAfter) a.retryAfter = Math.max(1, Math.ceil(Number(e.retryAfter)) || 1);
    return a;
}

/** the uplink's lease: there, and lists a DNS server (the rule of lib/netx.js online()) */
function leaseOnline(p) {
    try { const l = JSON.parse(fs.readFileSync(p, 'utf8')); return !!(l && Array.isArray(l.dns) && l.dns.length); } catch (e) { return false; }
}

function createService(opts) {
    const o = Object.assign({
        stateDir: process.env.CMOCAN_STATE || STATE_DIR,
        leasePath: process.env.CMOCAN_LEASE || LEASE,
        now: Date.now,
        log: (l) => console.log(l),
        exit: (code) => process.exit(code),
        createTidal: null,
        uid: NET_UID,
        clientEnv: {},
    }, opts || {});
    const now = o.now;
    // every line: scrubbed (no token, no address's query), kept for the `log` command, then to the journal
    const lg = createLog({ now: now, out: o.log, sessionFile: path.join(o.stateDir, 'session.json') });
    const log = lg.log;

    /* ---------- state ---------- */
    const st = createState(o.stateDir);
    // HIGH by default: TIDAL's device (QR) login gets AAC 320 at most (docs/PROTOCOL.md, prefs)
    let prefs = st.load('prefs', { quality: 'HIGH' });
    // the picture size asked for a video: 720 unless prefs.json says otherwise (docs/PROTOCOL.md, prefs)
    const videoHeight = () => (VIDEO_HEIGHTS.indexOf(prefs.videoHeight) >= 0 ? prefs.videoHeight : VIDEO_HEIGHT);
    const prefsOut = () => ({ quality: prefs.quality, videoHeight: videoHeight() });

    /* ---------- the client (internet uid): every request goes through it; tests may give a netx instead ---------- */
    const link = o.netx ? null : createClientLink({ fork: o.forkClient, file: o.clientPath || path.join(__dirname, 'client.js'),
        env: o.clientEnv, uid: o.uid, leasePath: o.leasePath, log: log, restarts: o.restarts, now: now });
    const netx = o.netx || link.netx;

    /* ---------- TIDAL ---------- */
    const createTidal = o.createTidal || require('./lib/tidal').createTidal;
    const tidal = createTidal({ netx: netx, sessionFile: path.join(o.stateDir, 'session.json'), coverDir: path.join(o.stateDir, 'covers') });

    /* ---------- login ---------- */
    let login = null;        // a pending device login: { timer, until (ms since 1970), ms, url, userCode }
    let starting = null;     // the loginStart() in flight: a login-start meanwhile waits for the same one
    let loginError = null;   // why the last login ended without one (login-expired, login-denied), for the app's screen
    function loginState() { return login ? 'login-pending' : (tidal.loggedIn() ? 'logged-in' : 'logged-out'); }
    /** the login ends: why (a contract loginError, or null); tell, to stop the TIDAL module's pending login too */
    function endLogin(why, tell) {
        if (!login) return;
        clearTimeout(login.timer);
        login = null;
        loginError = why || null;
        if (tell && tidal.loginCancel) { try { tidal.loginCancel(); } catch (e) { log('login cancel: ' + e.message); } }
    }
    /** the pending login as login-start answers it: the same link and code, the seconds left */
    function pendingAnswer(l) {
        return { url: l.url, userCode: l.userCode, expiresIn: Math.max(1, Math.ceil((l.until - now()) / 1000)) };
    }
    /** polls TIDAL every `interval` seconds until the code is approved, refused or past its time */
    function startLogin(v) {
        const l = { timer: null, until: Math.round(now() + Math.max(1, Number(v.expiresIn) || 300) * 1000), ms: Math.max(10, (Number(v.interval) || 5) * 1000),
            url: v.url, userCode: v.userCode };
        login = l;
        loginError = null;
        log('login: started (the code is good for ' + Math.round((l.until - now()) / 1000) + ' s)');
        const poll = () => {
            if (login !== l) return;
            if (now() >= l.until) { log('login: the code expired'); return endLogin('login-expired', true); }
            Promise.resolve().then(() => tidal.loginPoll()).then((r) => {
                if (login !== l) return;
                const state = r && r.state;
                if (state === 'authorized') { log('login: done'); endLogin(null); cache.clear(); return; }
                if (state === 'expired') { log('login: the code expired'); return endLogin('login-expired'); }
                if (state === 'denied') { log('login: refused'); return endLogin('login-denied'); }
                l.timer = setTimeout(poll, l.ms);
            }, (e) => {
                // a network error while polling is "pending": try again at the next interval
                if (login !== l) return;
                log('login poll: ' + e.message);
                l.timer = setTimeout(poll, l.ms);
            });
        };
        l.timer = setTimeout(poll, l.ms);
    }

    /* ---------- the lists' cache, and the tracks seen in them (status shows the track playing) ---------- */
    const cacheMs = o.cacheMs || CACHE_MS;
    const cache = new Map();
    // videos and tracks have separate id spaces at TIDAL: kept by kind and id
    const tracks = new Map();   // 'track:<id>' | 'video:<id>' -> track or video object
    const keyOf = (kind, id) => (kind === 'video' ? 'video:' : 'track:') + id;
    function remember(t) {
        if (!t || !isInt(t.id) || typeof t.title !== 'string' || t.numberOfTracks !== undefined) return;
        const k = keyOf(t.kind, t.id);
        tracks.delete(k);
        tracks.set(k, t);
        while (tracks.size > CACHE_TRACKS) tracks.delete(tracks.keys().next().value);
    }

    /**
     * The track (or video) for status: from the lists seen; else looked up with tidal.track(id) (tidal.video(id)) in
     * the background (a queue from before a restart, ids the app had from elsewhere). Never waits: null until TIDAL
     * answers.
     */
    const lookups = new Map();   // key -> { pending, at }
    function trackInfo(id, kind) {
        const t = tracks.get(keyOf(kind, id));
        if (t) return t;
        lookUp(id, kind === 'video' ? 'video' : 'track');
        return null;
    }
    function lookUp(id, kind) {
        if (typeof tidal[kind] !== 'function' || !tidal.loggedIn()) return;
        const key = keyOf(kind, id);
        const was = lookups.get(key);
        if (was && (was.pending || now() - was.at < LOOKUP_RETRY_MS)) return;
        const e = { pending: true, at: now() };
        lookups.delete(key);
        lookups.set(key, e);
        while (lookups.size > CACHE_LISTS) lookups.delete(lookups.keys().next().value);
        Promise.resolve().then(() => tidal[kind](id)).then((t) => {
            e.pending = false; e.at = now();
            if (t && t.id === id) remember(kind === 'video' ? Object.assign({}, t, { kind: 'video' }) : t);
        }, (err) => {
            e.pending = false; e.at = now();
            log(kind + ' ' + id + ': not looked up (' + ((err && (err.code || err.message)) || 'error') + ')');
        });
    }

    /* ---------- playback: one player per track (as root; it drops to nobody itself) ---------- */
    /**
     * A track: tidal-player. A video: tidal-video, its pictures to the frame file (MGU_VIDEO), the car's hardware
     * decoder when it loads (MGU_VIDEO_DECODER=auto), the GPU's group too, and MGU_BASE_MS: where in the video its
     * input starts (a seek starts at a later segment). startMs (a seek): where it starts playing, MGU_START_MS.
     */
    function startPlayer(id, onEvent, startMs, extra) {
        const video = extra && extra.kind === 'video';
        const base = typeof o.playerEnv === 'function' ? o.playerEnv(id, video ? 'video' : 'track') : o.playerEnv;
        const env = Object.assign({}, video ? { MGU_VIDEO: 'shm:' + (o.videoName || VIDEO_NAME), MGU_VIDEO_DECODER: o.videoDecoder || 'auto' } : {},
            base, startMs > 0 ? { MGU_START_MS: String(startMs) } : {}, video && extra.baseMs > 0 ? { MGU_BASE_MS: String(extra.baseMs) } : {});
        return createPlayerProcess({
            spawn: o.spawn || require('child_process').spawn,
            bin: video ? (o.videoBin || path.join(__dirname, 'tidal-video')) : (o.playerBin || path.join(__dirname, 'tidal-player')),
            args: (video ? o.videoArgs : o.playerArgs) || [],
            env: env, groups: video ? VIDEO_GROUPS : undefined,
            audio: o.audio, log: log, onEvent: onEvent });
    }
    const pb = createPlayback({
        tidal: tidal, netx: netx, log: log, now: now, retryWaits: o.retryWaits, outageMs: o.outageMs, segmentTries: o.segmentTries,
        quality: () => prefs.quality,
        videoHeight: videoHeight,
        trackInfo: trackInfo,
        onQueue: (q) => { try { st.write('queue', q); } catch (e) { log('queue.json: ' + e.message); } },
        startPlayer: startPlayer,
    });
    pb.restore(st.load('queue', { tracks: [], index: -1, position: 0 }));

    /* ---------- status ---------- */
    function player() { return pb.status(); }
    /** the uplink's lease; its coming and going is logged (looked at by every status and every tick) */
    let wasOnline = null;
    function online() {
        const on = leaseOnline(o.leasePath);
        if (on !== wasOnline) { wasOnline = on; log('internet: ' + (on ? 'online' : 'offline')); }
        return on;
    }
    function status() {
        return { login: loginState(), loginPending: login ? { url: login.url, userCode: login.userCode, expiresAt: login.until } : null,
            loginError: loginError, online: online(), version: VERSION, prefs: prefsOut(), player: player(),
            // optional in the contract (the log, the Status page): how the service's children are
            children: { client: link ? link.state() : { running: false, inProcess: true }, player: pb.players() } };
    }

    /* ---------- the commands ---------- */
    function needLogin() { if (!tidal.loggedIn()) throw codeError('not-logged-in'); }
    const lists = {
        favorites: (r) => tidal.favorites(r.kind, r.offset || 0, r.limit || 50),
        playlists: (r) => tidal.playlists(r.offset || 0, r.limit || 50),
        playlist: (r) => tidal.playlist(r.uuid, r.offset || 0, r.limit || 50),
        album: (r) => tidal.album(r.albumId, r.offset || 0, r.limit || 50),
        mixes: (r) => tidal.mixes(r.offset || 0, r.limit || 50),
        mix: (r) => tidal.mix(r.mixId, r.offset || 0, r.limit || 50),
        search: (r) => tidal.search(r.query, r.offset || 0, r.limit || 50),
    };
    /**
     * A list: from the cache inside cacheMs; else from TIDAL (one request for calls at once). With no lease, or TIDAL
     * unreachable, the last one fetched comes back marked stale; with none, offline.
     */
    function list(r) {
        needLogin();
        const key = JSON.stringify([r.cmd, r.kind, r.uuid, r.albumId, r.mixId, r.query, r.offset || 0, r.limit || 50]);
        const kept = cache.get(key);
        const stale = () => {
            if (kept && kept.value) return Object.assign({ stale: true }, kept.value);
            throw codeError('offline');
        };
        if (!leaseOnline(o.leasePath)) return stale();
        if (kept && kept.value && now() - kept.at < cacheMs) return kept.value;
        if (kept && kept.pending) return kept.pending;
        const entry = kept || {};
        entry.pending = Promise.resolve().then(() => lists[r.cmd](r)).then((v) => {
            const a = { items: (v && Array.isArray(v.items)) ? v.items : [] };
            if (v && isInt(v.total)) a.total = v.total;
            a.items.forEach(remember);
            entry.pending = null; entry.value = a; entry.at = now();
            return a;
        }, (e) => {
            entry.pending = null;
            if (e && e.code === 'offline') return stale();
            throw e;
        });
        cache.delete(key);
        cache.set(key, entry);
        while (cache.size > CACHE_LISTS) cache.delete(cache.keys().next().value);
        return entry.pending;
    }
    const handlers = {
        status: () => ({ state: status() }),
        // a login-start while one is pending (or being started) answers that one
        'login-start': () => {
            if (login) return pendingAnswer(login);
            if (!starting) {
                starting = Promise.resolve().then(() => tidal.loginStart()).then((v) => {
                    starting = null;
                    if (login) return pendingAnswer(login);
                    startLogin(v);
                    return { url: v.url, userCode: v.userCode, expiresIn: v.expiresIn };
                }, (e) => { starting = null; throw e; });
            }
            return starting;
        },
        'login-cancel': () => { if (login) log('login: cancelled'); endLogin(null, true); return {}; },
        logout: () => {
            log('logout');
            endLogin(null);
            pb.stop();
            return Promise.resolve().then(() => tidal.logout()).catch((e) => log('logout: ' + e.message)).then(() => {
                // the TIDAL module removes them; so does the service, whatever it left
                st.remove('session');
                rmrf(path.join(o.stateDir, 'covers'));
                cache.clear();
                return {};
            });
        },
        cover: (r) => { needLogin(); return tidal.cover(r.coverId).then((b) => ({ mime: 'image/jpeg', data: b.toString('base64') })); },
        // kinds (contract 4): which ids are videos; without it every id is a track
        play: (r) => { needLogin(); pb.play(r.tracks, r.index, r.kinds); return {}; },
        pause: () => { pb.pause(); return {}; },
        resume: () => { if (!pb.active()) needLogin(); pb.resume(); return {}; },
        next: () => { pb.next(); return {}; },
        prev: () => { pb.prev(); return {}; },
        stop: () => { pb.stop(); return {}; },
        // with nothing playing (idle, stopped, an error) there is nothing to move: bad-request
        seek: (r) => { if (!pb.seek(r.position)) throw codeError('bad-request'); return {}; },
        // a new quality applies from the next track, a new videoHeight from the next video
        prefs: (r) => {
            const quality = r.quality || prefs.quality;
            const height = r.videoHeight || videoHeight();
            if (quality !== prefs.quality || height !== videoHeight() || (r.videoHeight && prefs.videoHeight === undefined)) {
                prefs = { quality: quality, videoHeight: height };
                try { st.write('prefs', prefs); } catch (e) { log('prefs: ' + e.message); }
                if (r.videoHeight) log('prefs: videos at ' + height + 'p');
            }
            return { prefs: prefsOut() };
        },
        log: (r) => ({ lines: lg.lines(r.lines) }),
        exit: () => { log('exit: asked by the app'); setTimeout(() => stop(0), 50); return {}; },
    };
    Object.keys(lists).forEach((k) => { handlers[k] = list; });

    /** one request line -> Promise<answer> */
    function handleLine(line) {
        lastReq = now();   // any line from the app: it is alive
        let r;
        try { r = JSON.parse(line); } catch (e) { r = undefined; }
        const c = check(r);
        if (!c.ok) return Promise.resolve({ id: c.id, ok: false, error: 'bad-request' });
        return Promise.resolve().then(() => handlers[r.cmd](r))
            .then((fields) => Object.assign({ id: c.id, ok: true }, fields || {}), (e) => errorAnswer(c.id, e))
            .catch((e) => errorAnswer(c.id, e));
    }

    /* ---------- the socket ---------- */
    let server = null;
    const conns = [];
    function onConnection(c) {
        conns.push(c);
        let buf = '';
        let dropping = false;
        let open = true;
        c.setEncoding('utf8');
        const send = (a) => {
            if (!open) return;
            try { c.write(JSON.stringify(a) + '\n'); } catch (e) { /* gone */ }
        };
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (dropping) { dropping = false; continue; }   // the rest of an over-long line
                handleLine(line).then(send);
            }
            if (buf.length > MAX_LINE) {
                buf = '';
                if (!dropping) { dropping = true; send({ id: null, ok: false, error: 'bad-request', message: 'line too long' }); }
            }
        });
        c.on('error', () => { open = false; });
        c.on('close', () => { open = false; const k = conns.indexOf(c); if (k >= 0) conns.splice(k, 1); });
    }
    function listen(where) {
        server = net.createServer(onConnection);
        server.on('error', (e) => log('control socket: ' + e.message));
        return new Promise((resolve) => {
            if (typeof where === 'number') server.listen({ fd: where }, resolve);
            else {
                try { fs.unlinkSync(where); } catch (e) { /* none */ }
                server.listen(where, resolve);
            }
        });
    }

    /* ---------- start and end ---------- */
    let stopping = null;
    let lastReq = now();
    let ticker = null;
    const watchMs = o.watchMs || WATCH_MS, idleMs = o.idleMs || IDLE_MS;
    /** the app's watch and the idle end; every tickMs */
    function tick() {
        if (stopping) return;
        online();
        const quiet = now() - lastReq;
        if (pb.active()) {
            if (quiet > watchMs) { log('the app has not asked for ' + Math.round(quiet / 1000) + ' s: stopping playback'); pb.stop(); }
            return;
        }
        if (!login && quiet > idleMs) { log('idle for ' + Math.round(quiet / 60000) + ' minutes: ending'); stop(0); }
    }
    function start() {
        log('cmocan-tidal ' + VERSION);
        log('login: ' + (tidal.loggedIn() ? 'logged in' : 'logged out'));
        online();
        if (link) link.start();
        ticker = setInterval(tick, o.tickMs || TICK_MS);
    }
    function stop(code) {
        if (stopping) return stopping;
        stopping = new Promise((resolve) => {
            endLogin(null);
            clearInterval(ticker);
            conns.slice().forEach((c) => c.destroy());
            if (server) { try { server.close(); } catch (e) { /* closed */ } }
            resolve();
        }).then(() => pb.close()).then(() => (link ? link.stop() : null)).then(() => { o.exit(code || 0); });
        return stopping;
    }

    return { listen: listen, start: start, stop: stop, tick: tick, status: status, handleLine: handleLine, netx: netx };
}

if (require.main === module) {
    const svc = createService();
    // systemd passes the socket as fd 3 (LISTEN_FDS); outside it, CMOCAN_SOCK
    const fd = process.env.LISTEN_FDS && Number(process.env.LISTEN_FDS) >= 1 ? 3 : null;
    const where = fd !== null ? fd : (process.env.CMOCAN_SOCK || SOCK);
    svc.listen(where).then(() => {
        // the app installed after the socket was made: its group now (sockgroup.js, as the socket unit does)
        try { const g = require('./sockgroup').apply(process.env.CMOCAN_SOCK || SOCK); console.log('control socket: ' + (g === null ? 'root only' : 'group ' + g)); }
        catch (e) { console.log('control socket mode: ' + e.message); }
        svc.start();
    });
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
}

module.exports = { createService: createService, VERSION: VERSION, NET_UID: NET_UID, check: check, leaseOnline: leaseOnline };
