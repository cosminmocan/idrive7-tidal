'use strict';
/**
 * client.js - the internet side of cmocan-tidal. Two halves in one file:
 *
 * 1. Run as a program (a child of service.js, as the tool's internet uid 13150, never root: mgu-uplink routes that
 *    uid and never root), it holds lib/netx.js and does every HTTPS request for the service. It keeps no file.
 *      parent -> { op: 'request', id, req: { method, url, headers, body | body64, timeoutMs, maxBytes } }
 *                { op: 'open', id, sid, req: { url, headers, timeoutMs } }   { op: 'close', sid }   { op: 'stop' }
 *      child  -> { ev: 'ready', uid }   { ev: 'reply', id, ok, value | error: { code, message, status, retryAfter } }
 *                { ev: 'log', line }
 *    A stream's bytes go to the parent on fd 4 in frames: type (u8: 1 bytes, 2 end, 3 error with a JSON
 *    { code, message }), stream id (u32 LE), length (u32 LE), payload. The pipe's backpressure holds the download:
 *    when the parent stops reading, the HTTP stream is paused.
 *
 * 2. Required by the service (root), createClientLink() forks that program, starts it again when it dies (at most
 *    `max` times in `windowMs`), and gives the service a netx with the shape of docs/INTERNAL-API.md whose requests
 *    and streams go through the child. So the TIDAL module itself (lib/tidal.js) runs in the root service, where its
 *    files (session.json, covers/) stay root's; only the network runs as the internet uid.
 *
 * Model: aurelm-emby's and aurelm-tvhplayer's client.js (aurelmarius, GPL-3.0-or-later): IPC for control, fd 4 frames
 * for the stream, a socket on fd 4 (an fs stream on a pipe would block a worker thread).
 * Node 8.9.4.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Readable } = require('stream');

const T_DATA = 1, T_END = 2, T_ERR = 3;
const HEADER = 9;

function header(type, sid, len) {
    const h = Buffer.alloc(HEADER);
    h.writeUInt8(type, 0); h.writeUInt32LE(sid >>> 0, 1); h.writeUInt32LE(len >>> 0, 5);
    return h;
}
function codeError(code, message, extra) { const e = new Error(message || code); e.code = code; return Object.assign(e, extra || {}); }
function plainError(e) {
    const x = { code: (e && e.code) || 'tidal-error', message: String((e && e.message) || e).slice(0, 300) };
    if (e && e.status) x.status = e.status;
    if (e && e.retryAfter) x.retryAfter = e.retryAfter;
    return x;
}

/* =============================== the child =============================== */

function runChild() {
    const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the parent is gone */ } };
    const log = (line) => send({ ev: 'log', line: String(line) });
    let netx;
    try {
        const mod = require(process.env.CMOCAN_NETX || path.join(__dirname, 'lib', 'netx.js'));
        netx = mod.createNetx({ leasePath: process.env.CMOCAN_LEASE || '/run/mgu-uplink/lease.json',
            caFile: process.env.CMOCAN_CA || path.join(__dirname, 'cacert.pem') });
    } catch (e) {
        log('client: no netx: ' + e.message);
        setTimeout(() => process.exit(2), 50);
        return;
    }

    let pipe = null;
    try { pipe = new net.Socket({ fd: 4, readable: false, writable: true }); pipe.on('error', (e) => log('client: stream pipe: ' + e.message)); }
    catch (e) { log('client: no stream pipe: ' + e.message); }
    const streams = {};   // sid -> Readable
    const held = [];      // streams paused until the pipe drains
    if (pipe) pipe.on('drain', () => { held.splice(0).forEach((s) => { if (!s.gone) s.resume(); }); });
    function frame(type, sid, payload) {
        if (!pipe) return true;
        pipe.write(header(type, sid, payload ? payload.length : 0));
        return payload && payload.length ? pipe.write(payload) : true;
    }

    function onRequest(m) {
        const req = Object.assign({}, m.req);
        if (req.body64 !== undefined) { req.body = Buffer.from(req.body64, 'base64'); delete req.body64; }
        netx.request(req).then((r) => send({ ev: 'reply', id: m.id, ok: true,
            value: { status: r.status, headers: r.headers, body64: Buffer.isBuffer(r.body) ? r.body.toString('base64') : Buffer.from(String(r.body || '')).toString('base64') } }),
        (e) => send({ ev: 'reply', id: m.id, ok: false, error: plainError(e) }));
    }
    function onOpen(m) {
        const sid = m.sid;
        netx.openStream(m.req).then((r) => {
            const s = r.stream;
            if (streams[sid] === null) { try { s.destroy(); } catch (e) { /* gone */ } return; }   // closed while opening
            streams[sid] = s;
            send({ ev: 'reply', id: m.id, ok: true, value: { status: r.status, headers: r.headers } });
            let over = false;
            s.on('data', (d) => {
                if (over) return;
                if (!frame(T_DATA, sid, d)) { s.pause(); held.push(s); }
            });
            s.on('end', () => { if (over) return; over = true; delete streams[sid]; frame(T_END, sid); });
            s.on('error', (e) => { if (over) return; over = true; delete streams[sid]; frame(T_ERR, sid, Buffer.from(JSON.stringify(plainError(e)))); });
        }, (e) => send({ ev: 'reply', id: m.id, ok: false, error: plainError(e) }));
    }
    function onClose(m) {
        const s = streams[m.sid];
        streams[m.sid] = null;
        if (s) { s.gone = true; try { s.destroy(); } catch (e) { /* gone */ } }
        setTimeout(() => { if (streams[m.sid] === null) delete streams[m.sid]; }, 60000);
    }
    function end() {
        Object.keys(streams).forEach((k) => { if (streams[k]) { try { streams[k].destroy(); } catch (e) { /* gone */ } } });
        try { netx.close(); } catch (e) { /* closed */ }
        process.exit(0);
    }

    process.on('message', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.op === 'request') onRequest(m);
        else if (m.op === 'open') onOpen(m);
        else if (m.op === 'close') onClose(m);
        else if (m.op === 'stop') end();
    });
    process.on('disconnect', end);   // the parent went: so do we
    send({ ev: 'ready', uid: process.getuid ? process.getuid() : null });
}

/* =============================== the service's side =============================== */

/**
 * createClientLink({ fork, file, env, uid, leasePath, log, restarts: { max, windowMs, delayMs }, now })
 *   link.start()              forks the client (refused for uid 0)
 *   link.stop() -> Promise    ends it (stop, then SIGTERM, then SIGKILL) and waits for its exit
 *   link.netx                 { online, request, openStream, close }: docs/INTERNAL-API.md's shape
 *   link.state()              { running, restarts, lastExit, gaveUp, error }
 */
function createClientLink(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const now = o.now || Date.now;
    const rs = Object.assign({ max: 5, windowMs: 10 * 60000, delayMs: 2000 }, o.restarts || {});
    const st = { running: false, restarts: 0, lastExit: null, gaveUp: false, error: null };
    let child = null, stopping = false, restartTimer = null, ids = 0, sids = 0;
    const restartsAt = [];
    let pending = {};      // id -> { resolve, reject, timer }
    let streams = {};      // sid -> FrameStream
    let pausedPipe = false;
    let buf = null;

    class FrameStream extends Readable {
        constructor(sid) { super({ highWaterMark: 64 * 1024 }); this.sid = sid; this.on('error', () => { /* the reader has its own */ }); }
        _read() { if (pausedPipe && child && child.stdio[4]) { pausedPipe = false; child.stdio[4].resume(); } }
        _destroy(e, cb) {
            if (streams[this.sid] === this) { delete streams[this.sid]; send({ op: 'close', sid: this.sid }); }
            cb(e);
        }
    }

    function send(m) { if (child && child.connected) { try { child.send(m); return true; } catch (e) { return false; } } return false; }

    function onFrames(d) {
        buf = buf && buf.length ? Buffer.concat([buf, d]) : d;
        let off = 0;
        while (buf.length - off >= HEADER) {
            const type = buf.readUInt8(off), sid = buf.readUInt32LE(off + 1), len = buf.readUInt32LE(off + 5);
            if (buf.length - off < HEADER + len) break;
            const payload = buf.slice(off + HEADER, off + HEADER + len);
            off += HEADER + len;
            const s = streams[sid];
            if (!s) continue;   // a stream that was left: read and dropped
            if (type === T_DATA) {
                if (!s.push(payload) && !pausedPipe && child && child.stdio[4]) { pausedPipe = true; child.stdio[4].pause(); }
            } else if (type === T_END) { delete streams[sid]; s.push(null); }
            else if (type === T_ERR) {
                delete streams[sid];
                let x = {};
                try { x = JSON.parse(payload.toString('utf8')); } catch (e) { /* none */ }
                s.destroy(codeError(x.code || 'offline', x.message || 'the stream broke'));
            }
        }
        buf = off >= buf.length ? null : buf.slice(off);
    }

    function failAll(why) {
        const p = pending; pending = {};
        Object.keys(p).forEach((id) => { clearTimeout(p[id].timer); p[id].reject(codeError('offline', why)); });
        const s = streams; streams = {};
        Object.keys(s).forEach((sid) => s[sid].destroy(codeError('offline', why)));
        buf = null; pausedPipe = false;
    }

    function start() {
        if (child || stopping) return;
        if (o.uid === 0) { st.error = 'refused to run the client as root'; log('client: ' + st.error); return; }
        const env = Object.assign({ PATH: '/usr/bin:/bin', HOME: '/tmp', CMOCAN_LEASE: o.leasePath }, o.env || {});
        const fo = { env: env, cwd: '/', stdio: ['ignore', 'pipe', 'pipe', 'ipc', 'pipe'] };
        if (o.uid !== null && o.uid !== undefined) { fo.uid = o.uid; fo.gid = o.uid; }
        let c;
        try { c = (o.fork || require('child_process').fork)(o.file || __filename, [], fo); }
        catch (e) { st.error = 'the client did not start: ' + e.message; log(st.error); return onExit(null, null, null); }
        if (!c) { st.error = 'the client did not start'; return; }
        child = c;
        st.running = true; st.error = null;
        const lines = (stream) => { if (!stream) return; let b = ''; stream.setEncoding('utf8');
            stream.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { log('client: ' + b.slice(0, i)); b = b.slice(i + 1); } if (b.length > 65536) b = ''; }); };
        lines(c.stdout); lines(c.stderr);
        if (c.stdio[4]) { c.stdio[4].on('data', onFrames); c.stdio[4].on('error', () => {}); }
        c.on('message', (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.ev === 'reply' && pending[m.id]) {
                const p = pending[m.id]; delete pending[m.id]; clearTimeout(p.timer);
                if (m.ok) p.resolve(m.value); else p.reject(codeError((m.error && m.error.code) || 'tidal-error', m.error && m.error.message, { status: m.error && m.error.status, retryAfter: m.error && m.error.retryAfter }));
            } else if (m.ev === 'log') log(m.line);
            else if (m.ev === 'ready') log('client running as uid ' + m.uid);
        });
        c.on('error', (e) => log('client: ' + e.message));
        c.on('exit', (code, signal) => { if (child === c) onExit(c, code, signal); });
    }
    function onExit(c, code, signal) {
        child = null;
        st.running = false;
        st.lastExit = signal ? signal : 'code ' + code;
        failAll('the client ended');
        if (stopping) return;
        log('client ended (' + st.lastExit + ')');
        const t = now();
        while (restartsAt.length && t - restartsAt[0] > rs.windowMs) restartsAt.shift();
        if (restartsAt.length >= rs.max) { st.gaveUp = true; st.error = 'the client ended ' + (rs.max + 1) + ' times; not started again'; log(st.error); return; }
        restartsAt.push(t);
        st.restarts++;
        restartTimer = setTimeout(start, rs.delayMs);
    }
    function stop() {
        stopping = true;
        clearTimeout(restartTimer);
        const c = child;
        if (!c) return Promise.resolve();
        return new Promise((resolve) => {
            c.once('exit', () => { clearTimeout(t1); clearTimeout(t2); resolve(); });
            send({ op: 'stop' });
            const t1 = setTimeout(() => { try { c.kill('SIGTERM'); } catch (e) { /* gone */ } }, 1000);
            const t2 = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* gone */ } }, 4000);
        });
    }

    function call(m, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!child) return reject(codeError('offline', st.error || 'the client is not running'));
            const id = ++ids;
            m.id = id;
            pending[id] = { resolve: resolve, reject: reject, timer: setTimeout(() => {
                if (pending[id]) { delete pending[id]; reject(codeError('offline', 'the client did not answer')); }
            }, timeoutMs) };
            if (!send(m)) { clearTimeout(pending[id].timer); delete pending[id]; reject(codeError('offline', 'the client is not reachable')); }
        });
    }
    const leaseOnline = () => {
        try { const l = JSON.parse(fs.readFileSync(o.leasePath, 'utf8')); return !!(l && Array.isArray(l.dns) && l.dns.length); } catch (e) { return false; }
    };
    const netx = {
        online: leaseOnline,
        request: (req) => {
            const r = { method: req.method, url: req.url, headers: req.headers, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes };
            if (Buffer.isBuffer(req.body)) r.body64 = req.body.toString('base64'); else if (req.body !== undefined) r.body = req.body;
            return call({ op: 'request', req: r }, (req.timeoutMs || 30000) + 15000)
                .then((v) => ({ status: v.status, headers: v.headers, body: Buffer.from(v.body64 || '', 'base64') }));
        },
        openStream: (req) => {
            const sid = ++sids;
            const s = new FrameStream(sid);
            streams[sid] = s;
            return call({ op: 'open', sid: sid, req: { url: req.url, headers: req.headers, timeoutMs: req.timeoutMs } }, (req.timeoutMs || 30000) + 15000)
                .then((v) => ({ status: v.status, headers: v.headers, stream: s }), (e) => { if (streams[sid] === s) delete streams[sid]; throw e; });
        },
        close: () => {},
    };
    return { start: start, stop: stop, netx: netx, state: () => Object.assign({}, st) };
}

module.exports = { createClientLink: createClientLink };

if (require.main === module) runChild();
