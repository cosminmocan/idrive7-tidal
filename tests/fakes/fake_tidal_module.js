'use strict';
/**
 * fake_tidal_module.js - stand-ins for the service's tests (stream C), with the shapes of docs/INTERNAL-API.md:
 *
 *   createFakeTidal(cfg)(opts)   a createTidal: (opts { netx, sessionFile, coverDir }) -> the tidal module's object.
 *                                cfg (the test's knobs, may be changed while the test runs):
 *                                  library: { favorites: { tracks: [], albums: [] }, playlists: [], playlist: { <uuid>: [] },
 *                                             album: { <id>: [] }, mixes: [], mix: { <id>: [] }, search: [] }
 *                                  login: ['pending', 'authorized'] (the poll answers in turn; the last one repeats)
 *                                  interval (s), expiresIn (s)
 *                                  streams: { <trackId>: { url, codec, quality } | { error: code, retryAfter } }
 *                                  streamUrl: (id, quality, n) -> answer   (overrides streams; n: the call's number for this id)
 *                                  covers: { <coverId>: Buffer }
 *                                  fail: { <method>: code }   every call of that method rejects with code
 *                                  calls: [] (filled: { method, args })
 *                                  logoutLeavesFiles: true   logout() forgets the session but leaves its files
 *   createFileServer(opts)       a local HTTP server for the track's bytes, with Range, cuts and expired addresses.
 *   pattern(len) / patternAt(i)  the bytes the file server serves: "fLaC" then a counter, so a byte out of place,
 *                                missing or twice is seen.
 *
 * Every list method rejects with 'offline' when netx.online() is false (as the real one, whose netx refuses then).
 * Node 8.9.4 syntax.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const TRACK = { id: 17927864, title: 'One More Time', artists: ['Daft Punk'], album: { id: 17927863, title: 'Discovery' },
    coverId: '24f52ab0-e7d6-414d-a650-20a4c686aa57', duration: 320, streamReady: true, explicit: false };

function track(id, title) { return Object.assign({}, TRACK, { id: id, title: title || ('Track ' + id) }); }

function err(code, extra) { const e = new Error(code); e.code = code; return Object.assign(e, extra || {}); }

function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) { fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n))); fs.rmdirSync(p); } else fs.unlinkSync(p);
}

function createFakeTidal(cfg) {
    cfg.calls = cfg.calls || [];
    return function createTidal(opts) {
        const netx = opts.netx;
        let session = null;
        try {
            const s = JSON.parse(fs.readFileSync(opts.sessionFile, 'utf8'));
            if (s && s.version === 1 && s.accessToken) session = s;
        } catch (e) { /* logged out */ }
        let polls = 0;
        const streamCalls = {};

        function call(method, args, fn) {
            cfg.calls.push({ method: method, args: args });
            if (cfg.fail && cfg.fail[method]) return Promise.reject(err(cfg.fail[method], cfg.fail.retryAfter ? { retryAfter: cfg.fail.retryAfter } : {}));
            return Promise.resolve().then(fn);
        }
        function needLogin() { if (!session) throw err('not-logged-in'); }
        function needNet() { if (!netx.online()) throw err('offline'); }
        function page(list, offset, limit) {
            const l = list || [];
            return { items: l.slice(offset || 0, (offset || 0) + (limit || 50)), total: l.length };
        }
        const lib = () => cfg.library || {};

        return {
            loggedIn: () => !!session,
            loginStart: () => call('loginStart', [], () => {
                needNet(); polls = 0;
                return { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresIn: cfg.expiresIn || 300, interval: cfg.interval || 0.05 };
            }),
            loginPoll: () => call('loginPoll', [], () => {
                const seq = cfg.login || ['pending'];
                const st = seq[Math.min(polls, seq.length - 1)];
                polls++;
                if (st === 'authorized') {
                    session = { version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600000, userId: 1, countryCode: 'RO' };
                    fs.writeFileSync(opts.sessionFile, JSON.stringify(session), { mode: 0o600 });
                }
                return { state: st };
            }),
            logout: () => call('logout', [], () => {
                session = null;
                if (cfg.logoutLeavesFiles) return;   // to check that the service removes them itself
                try { fs.unlinkSync(opts.sessionFile); } catch (e) { /* none */ }
                rmrf(opts.coverDir);
            }),
            favorites: (kind, offset, limit) => call('favorites', [kind, offset, limit], () => {
                needLogin(); needNet(); return page((lib().favorites || {})[kind], offset, limit);
            }),
            playlists: (offset, limit) => call('playlists', [offset, limit], () => { needLogin(); needNet(); return page(lib().playlists, offset, limit); }),
            playlist: (uuid, offset, limit) => call('playlist', [uuid, offset, limit], () => {
                needLogin(); needNet();
                const l = (lib().playlist || {})[uuid]; if (!l) throw err('not-found');
                return page(l, offset, limit);
            }),
            album: (id, offset, limit) => call('album', [id, offset, limit], () => {
                needLogin(); needNet();
                const l = (lib().album || {})[id]; if (!l) throw err('not-found');
                return page(l, offset, limit);
            }),
            mixes: () => call('mixes', [], () => { needLogin(); needNet(); return { items: lib().mixes || [] }; }),
            mix: (id) => call('mix', [id], () => {
                needLogin(); needNet();
                const l = (lib().mix || {})[id]; if (!l) throw err('not-found');
                return { items: l };
            }),
            search: (q, offset, limit) => call('search', [q, offset, limit], () => { needLogin(); needNet(); return page(lib().search, offset, limit); }),
            streamUrl: (id, quality) => call('streamUrl', [id, quality], () => {
                needLogin(); needNet();
                streamCalls[id] = (streamCalls[id] || 0) + 1;
                const a = cfg.streamUrl ? cfg.streamUrl(id, quality, streamCalls[id]) : (cfg.streams || {})[id];
                if (!a) throw err('not-found');
                if (a.error) throw err(a.error, a.retryAfter ? { retryAfter: a.retryAfter } : {});
                return a;
            }),
            cover: (coverId) => call('cover', [coverId], () => {
                needLogin();
                const f = path.join(opts.coverDir, coverId + '.jpg');
                try { return fs.readFileSync(f); } catch (e) { /* not cached */ }
                needNet();
                const b = (cfg.covers || {})[coverId];
                if (!b) throw err('not-found');
                try { fs.mkdirSync(opts.coverDir, 0o700); } catch (e) { /* there */ }
                fs.writeFileSync(f, b);
                return b;
            }),
        };
    };
}

/* ---------- the file server ---------- */
function patternAt(i) {
    if (i < 4) return 'fLaC'.charCodeAt(i);
    const w = Math.floor((i - 4) / 4), k = (i - 4) % 4;
    return (w >>> (8 * k)) & 255;
}
function pattern(start, end) {
    const b = Buffer.alloc(end - start);
    for (let i = start; i < end; i++) b[i - start] = patternAt(i);
    return b;
}

/**
 * createFileServer({ size, cuts: [byte offsets], expired: n (the first n requests of each path get 403),
 *                    status: (req) -> code (overrides), chunk }) -> Promise<{ url(name), requests, served, close() }>
 * Each cut is used once: the connection is destroyed once that byte has been sent. `served`: bytes sent in all.
 */
function createFileServer(opts) {
    const o = Object.assign({ size: 1024 * 1024, cuts: [], expired: 0, chunk: 16384 }, opts || {});
    const srv = { requests: [], served: 0, sockets: [] };
    const cuts = o.cuts.slice().sort((a, b) => a - b);
    const seen = {};
    const server = http.createServer((req, res) => {
        srv.requests.push({ url: req.url, range: req.headers.range || null });
        seen[req.url] = (seen[req.url] || 0) + 1;
        const code = o.status ? o.status(req) : null;
        if (code) { res.writeHead(code); return res.end(); }
        if (seen[req.url] <= o.expired) { res.writeHead(403); return res.end('expired'); }
        let start = 0;
        const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        if (m) start = Number(m[1]);
        if (start >= o.size) { res.writeHead(416); return res.end(); }
        const headers = { 'Content-Type': 'audio/flac', 'Content-Length': String(o.size - start) };
        if (m) headers['Content-Range'] = 'bytes ' + start + '-' + (o.size - 1) + '/' + o.size;
        res.writeHead(m ? 206 : 200, headers);
        let pos = start;
        function more() {
            while (pos < o.size) {
                let end = Math.min(o.size, pos + o.chunk);
                const cut = cuts.length && cuts[0] > pos && cuts[0] <= end ? cuts[0] : null;
                if (cut !== null) end = cut;
                const ok = res.write(pattern(pos, end));
                srv.served += end - pos;
                pos = end;
                if (cut !== null) { cuts.shift(); setTimeout(() => res.socket && res.socket.destroy(), 20); return; }
                if (!ok) { res.once('drain', more); return; }
            }
            res.end();
        }
        more();
    });
    server.on('connection', (s) => { srv.sockets.push(s); s.on('close', () => { srv.sockets = srv.sockets.filter((x) => x !== s); }); });
    srv.url = (name) => 'http://127.0.0.1:' + server.address().port + '/' + (name || 'track.flac');
    srv.close = () => new Promise((resolve) => { srv.sockets.forEach((s) => s.destroy()); server.close(() => resolve()); });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(srv)));
}

module.exports = { createFakeTidal: createFakeTidal, createFileServer: createFileServer, pattern: pattern, patternAt: patternAt,
    track: track, TRACK: TRACK, rmrf: rmrf };
