'use strict';
/**
 * service.js - cmocan-tidal, the background service for the app cmocan_tidal. Root, the unit's /usr/bin/node.
 *
 * Started by the app's first connection to /run/cmocan-tidal.sock (systemd socket activation), never at boot.
 * The control socket is docs/PROTOCOL.md section 1: one JSON request a line, one JSON answer a line, by id.
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

const VERSION = '0.1.0';
const MAX_LINE = 64 * 1024;
const LEASE = '/run/mgu-uplink/lease.json';
const STATE_DIR = '/var/opt/cmocan-tidal/state';
const SOCK = '/run/cmocan-tidal.sock';
const CACHE_MS = 5 * 60000;      // a list is asked again after this
const CACHE_LISTS = 200;
const CACHE_TRACKS = 5000;
const WATCH_MS = 90 * 1000;        // playing and no request from the app for this long: stopped (rule R8)
const IDLE_MS = 10 * 60 * 1000;    // nothing playing and no request for this long: the service ends (exit 0)
const TICK_MS = 5000;
const NET_UID = 13150;    // component.json "uids": the only uid of this tool mgu-uplink routes

const COMMANDS = ['status', 'login-start', 'login-cancel', 'logout', 'favorites', 'playlists', 'playlist', 'album',
    'mixes', 'mix', 'search', 'cover', 'play', 'pause', 'resume', 'next', 'prev', 'stop', 'prefs', 'exit'];
const ERROR_CODES = ['offline', 'not-logged-in', 'login-expired', 'not-found', 'not-available', 'rate-limited',
    'tidal-error', 'bad-request', 'busy'];
const QUALITIES = ['LOSSLESS', 'HIGH'];

/* ---------- the requests (docs/PROTOCOL.md, "Requests") ---------- */
const isInt = (v) => typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// ids TIDAL gives: UUIDs and hex strings; anything else never reaches a path or an address
const ID_TEXT = /^[A-Za-z0-9_-]{1,64}$/;
function paging(r) {
    return (r.offset === undefined || (isInt(r.offset) && r.offset >= 0)) && (r.limit === undefined || (isInt(r.limit) && r.limit >= 1 && r.limit <= 100));
}
const PARAMS = {
    favorites: (r) => (r.kind === 'tracks' || r.kind === 'albums') && paging(r),
    playlists: paging,
    playlist: (r) => typeof r.uuid === 'string' && ID_TEXT.test(r.uuid) && paging(r),
    album: (r) => isInt(r.albumId) && r.albumId >= 1 && paging(r),
    mix: (r) => typeof r.mixId === 'string' && ID_TEXT.test(r.mixId),
    search: (r) => typeof r.query === 'string' && r.query.length >= 1 && r.query.length <= 200 && paging(r),
    cover: (r) => typeof r.coverId === 'string' && ID_TEXT.test(r.coverId),
    play: (r) => Array.isArray(r.tracks) && r.tracks.length >= 1 && r.tracks.length <= 1000 && r.tracks.every((t) => isInt(t) && t > 0) &&
        isInt(r.index) && r.index >= 0 && r.index < r.tracks.length,
    prefs: (r) => r.quality === undefined || QUALITIES.indexOf(r.quality) >= 0,
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
    const log = o.log;

    /* ---------- state ---------- */
    const st = createState(o.stateDir);
    let prefs = st.read('prefs') || { quality: 'LOSSLESS' };

    /* ---------- the client (internet uid): every request goes through it; tests may give a netx instead ---------- */
    const link = o.netx ? null : createClientLink({ fork: o.forkClient, file: o.clientPath || path.join(__dirname, 'client.js'),
        env: o.clientEnv, uid: o.uid, leasePath: o.leasePath, log: log, restarts: o.restarts, now: now });
    const netx = o.netx || link.netx;

    /* ---------- TIDAL ---------- */
    const createTidal = o.createTidal || require('./lib/tidal').createTidal;
    const tidal = createTidal({ netx: netx, sessionFile: path.join(o.stateDir, 'session.json'), coverDir: path.join(o.stateDir, 'covers') });

    /* ---------- login ---------- */
    let login = null;        // a pending device login: { timer, until }
    let loginError = null;   // why the last login ended without one (login-expired), for the app's screen
    function loginState() { return login ? 'login-pending' : (tidal.loggedIn() ? 'logged-in' : 'logged-out'); }
    function endLogin(why) {
        if (!login) return;
        clearTimeout(login.timer);
        login = null;
        loginError = why || null;
    }
    /** polls TIDAL every `interval` seconds until the code is approved, refused or past its time */
    function startLogin(v) {
        const l = { timer: null, until: now() + Math.max(1, Number(v.expiresIn) || 300) * 1000, ms: Math.max(10, (Number(v.interval) || 5) * 1000) };
        login = l;
        loginError = null;
        const poll = () => {
            if (login !== l) return;
            if (now() >= l.until) { log('login: the code expired'); return endLogin('login-expired'); }
            Promise.resolve().then(() => tidal.loginPoll()).then((r) => {
                if (login !== l) return;
                const state = r && r.state;
                if (state === 'authorized') { log('login: done'); endLogin(null); cache.clear(); return; }
                if (state === 'expired') { log('login: the code expired'); return endLogin('login-expired'); }
                if (state === 'denied') { log('login: refused'); return endLogin('login-expired'); }
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
    const tracks = new Map();   // id -> track object
    function remember(t) {
        if (!t || !isInt(t.id) || typeof t.title !== 'string' || t.numberOfTracks !== undefined) return;
        tracks.delete(t.id);
        tracks.set(t.id, t);
        while (tracks.size > CACHE_TRACKS) tracks.delete(tracks.keys().next().value);
    }

    /* ---------- playback: one player per track (as root; it drops to nobody itself) ---------- */
    const pb = createPlayback({
        tidal: tidal, netx: netx, log: log, now: now, retryWaits: o.retryWaits, outageMs: o.outageMs,
        quality: () => prefs.quality,
        trackInfo: (id) => tracks.get(id) || null,
        onQueue: (q) => { try { st.write('queue', q); } catch (e) { log('queue.json: ' + e.message); } },
        startPlayer: (id, onEvent) => createPlayerProcess({
            spawn: o.spawn || require('child_process').spawn,
            bin: o.playerBin || path.join(__dirname, 'tidal-player'), args: o.playerArgs || [],
            env: typeof o.playerEnv === 'function' ? o.playerEnv(id) : o.playerEnv, audio: o.audio, log: log, onEvent: onEvent }),
    });
    const savedQueue = st.read('queue');
    if (savedQueue) pb.restore(savedQueue);

    /* ---------- status ---------- */
    function player() { return pb.status(); }
    function status() {
        return { login: loginState(), online: leaseOnline(o.leasePath), version: VERSION, prefs: { quality: prefs.quality }, player: player(),
            // not in the contract: why the last login went back to logged-out (login-expired), else null
            loginError: loginError,
            // not in the contract: how the service's children are (a child that died, and how often it was started again)
            children: { client: link ? link.state() : { running: false, inProcess: true }, player: pb.players() } };
    }

    /* ---------- the commands ---------- */
    function needLogin() { if (!tidal.loggedIn()) throw codeError('not-logged-in'); }
    const lists = {
        favorites: (r) => tidal.favorites(r.kind, r.offset || 0, r.limit || 50),
        playlists: (r) => tidal.playlists(r.offset || 0, r.limit || 50),
        playlist: (r) => tidal.playlist(r.uuid, r.offset || 0, r.limit || 50),
        album: (r) => tidal.album(r.albumId, r.offset || 0, r.limit || 50),
        mixes: () => tidal.mixes(),
        mix: (r) => tidal.mix(r.mixId),
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
        'login-start': () => {
            if (login) throw codeError('busy', 'a login is already running');
            return tidal.loginStart().then((v) => {
                if (login) throw codeError('busy', 'a login is already running');
                startLogin(v);
                return { url: v.url, userCode: v.userCode, expiresIn: v.expiresIn };
            });
        },
        'login-cancel': () => { endLogin(null); return {}; },
        logout: () => {
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
        play: (r) => { needLogin(); pb.play(r.tracks, r.index); return {}; },
        pause: () => { pb.pause(); return {}; },
        resume: () => { if (!pb.active()) needLogin(); pb.resume(); return {}; },
        next: () => { pb.next(); return {}; },
        prev: () => { pb.prev(); return {}; },
        stop: () => { pb.stop(); return {}; },
        prefs: (r) => {
            if (r.quality && r.quality !== prefs.quality) {
                prefs = { quality: r.quality };
                try { st.write('prefs', prefs); } catch (e) { log('prefs: ' + e.message); }
            }
            return { prefs: { quality: prefs.quality } };
        },
        exit: () => { setTimeout(() => stop(0), 50); return {}; },
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
        const quiet = now() - lastReq;
        if (pb.active()) {
            if (quiet > watchMs) { log('the app has not asked for ' + Math.round(quiet / 1000) + ' s: stopping playback'); pb.stop(); }
            return;
        }
        if (!login && quiet > idleMs) { log('idle for ' + Math.round(quiet / 60000) + ' minutes: ending'); stop(0); }
    }
    function start() {
        log('cmocan-tidal ' + VERSION);
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
    svc.listen(fd !== null ? fd : (process.env.CMOCAN_SOCK || SOCK)).then(() => svc.start());
    process.on('SIGTERM', () => svc.stop(0));
    process.on('SIGINT', () => svc.stop(0));
}

module.exports = { createService: createService, VERSION: VERSION, NET_UID: NET_UID, check: check, leaseOnline: leaseOnline };
