'use strict';
/**
 * client.js - the app's side of the control socket (docs/PROTOCOL.md section 1): one connection to
 * /run/cmocan-tidal.sock, one JSON object per line each way, answers matched to requests by `id`.
 *
 *   const c = createClient({ socketPath, log, timeoutMs: 5000, retry: { first: 250, max: 5000 } });
 *   c.request('status').then((a) => ...)        // always resolves, never rejects:
 *       the service's answer ({ id, ok: true, ... } or { id, ok: false, error }), or one of ours
 *       { ok: false, error: 'timeout' | 'no-service' | 'disconnected' | 'closed' | 'bad-answer', local: true }
 *   c.state()          'connecting' | 'connected' | 'no-service' | 'disconnected' | 'closed'
 *   c.onState(fn)      fn(state) on each change
 *   c.close()
 *
 * Rule R1: nothing the service sends ends the app. A line that is not JSON, not an object, has no known id, or is
 * longer than maxLine is counted and dropped; a closed socket ends the waiting requests at once with
 * `disconnected` and the client connects again, waiting longer each time (first, 2 x first, ... max). A socket that
 * is not there, or that nobody answers on (the tool is not installed or not running), is `no-service`: requests then
 * end at once with it, and the state does not flap while the client keeps trying. Node 8.9.4 syntax.
 */
const net = require('net');

const NO_SERVICE = { ENOENT: true, ECONNREFUSED: true, ENOTSOCK: true, EACCES: true, EPERM: true };
const MAX_ID = 0x7fffffff;

function createClient(opts) {
    const o = opts || {};
    const log = o.log || { info() {}, warn() {}, error() {} };
    const socketPath = o.socketPath;
    const timeoutMs = o.timeoutMs || 5000;
    const first = (o.retry && o.retry.first) || 250;
    const max = (o.retry && o.retry.max) || 5000;
    const maxLine = o.maxLine || 2 * 1024 * 1024;       // the contract's answers are at most 1 MiB a line
    const stats = { garbage: 0, dropped: 0, late: 0, connects: 0, waits: [] };

    let st = 'connecting', sock = null, closed = false, retryTimer = null, wait = first, nextId = 1;
    let buf = '', dropping = false;
    const pending = new Map();      // id -> { resolve, timer, line, sent }
    const listeners = [];

    function setState(s) {
        if (s === st) return;
        st = s;
        listeners.forEach((fn) => { try { fn(s); } catch (e) { log.warn('client: state listener: ' + e); } });
    }
    function finish(id, answer) {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        try { p.resolve(answer); } catch (e) { /* a promise's resolve does not throw */ }
    }
    const local = (id, error) => ({ id: id, ok: false, error: error, local: true });
    function failAll(error, onlyUnsent) {
        Array.from(pending.keys()).forEach((id) => { if (!onlyUnsent || !pending.get(id).sent) finish(id, local(id, error)); });
    }

    function onLine(line) {
        if (line.length > maxLine) { stats.dropped++; return; }
        if (!line.trim()) return;
        let a;
        try { a = JSON.parse(line); } catch (e) { stats.garbage++; return; }
        if (!a || typeof a !== 'object' || Array.isArray(a)) { stats.garbage++; return; }
        if (a.id === null && a.ok === false) { stats.garbage++; log.warn('client: the service did not understand a request: ' + String(a.error) + ' ' + String(a.message || '').slice(0, 200)); return; }
        if (typeof a.id !== 'number' || Math.floor(a.id) !== a.id || a.id < 1) { stats.garbage++; return; }
        if (!pending.has(a.id)) { stats.late++; return; }
        if (typeof a.ok !== 'boolean') { stats.garbage++; finish(a.id, local(a.id, 'bad-answer')); return; }
        finish(a.id, a);
    }
    function onData(d) {
        let s = String(d);
        if (dropping) {
            const i = s.indexOf('\n');
            if (i < 0) return;
            s = s.slice(i + 1);
            dropping = false;
        }
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try { onLine(line); } catch (e) { stats.garbage++; log.warn('client: ' + e); }
        }
        if (buf.length > maxLine) { buf = ''; dropping = true; stats.dropped++; log.warn('client: an answer longer than ' + maxLine + ' bytes was dropped'); }
    }

    function schedule() {
        if (closed || retryTimer) return;
        stats.waits.push(wait);
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
        wait = Math.min(max, wait * 2);
    }
    function connect() {
        if (closed || sock) return;
        let s;
        try { s = net.connect(socketPath); } catch (e) { setState('no-service'); failAll('no-service'); schedule(); return; }
        sock = s;
        let up = false, ended = false;
        buf = ''; dropping = false;
        s.setEncoding('utf8');
        s.on('connect', () => {
            if (closed || sock !== s) return;
            up = true;
            wait = first;
            stats.connects++;
            setState('connected');
            pending.forEach((p) => { if (!p.sent) { p.sent = true; write(p.line); } });
        });
        s.on('data', (d) => { if (sock === s) onData(d); });
        const end = (err) => {
            if (ended) return;
            ended = true;
            if (sock === s) sock = null;
            try { s.destroy(); } catch (e) { /* gone */ }
            if (closed) return;
            if (up) {
                log.info('client: the service closed the connection' + (err ? ' (' + (err.code || err.message) + ')' : ''));
                setState('disconnected');
                failAll('disconnected');
            } else if (err && NO_SERVICE[err.code]) {
                setState('no-service');
                failAll('no-service');
            } else {
                if (st !== 'no-service') setState('disconnected');
                failAll(st === 'no-service' ? 'no-service' : 'disconnected');
            }
            schedule();
        };
        s.on('error', (e) => end(e));
        s.on('close', () => end(null));
    }
    function write(line) {
        if (!sock) return;
        try { sock.write(line); } catch (e) { log.warn('client: write: ' + e); }
    }

    function request(cmd, params, ropts) {
        return new Promise((resolve) => {
            if (closed) { resolve(local(null, 'closed')); return; }
            const id = nextId;
            nextId = nextId >= MAX_ID ? 1 : nextId + 1;
            if (st === 'no-service') { resolve(local(id, 'no-service')); return; }
            const req = {};
            if (params && typeof params === 'object') Object.keys(params).forEach((k) => { req[k] = params[k]; });
            req.id = id;
            req.cmd = cmd;
            let line;
            try { line = JSON.stringify(req) + '\n'; } catch (e) { resolve(local(id, 'bad-request')); return; }
            const t = (ropts && ropts.timeoutMs) || timeoutMs;
            const p = { resolve: resolve, line: line, sent: false, timer: setTimeout(() => finish(id, local(id, 'timeout')), t) };
            pending.set(id, p);
            if (st === 'connected' && sock) { p.sent = true; write(line); } else connect();
        });
    }

    function close() {
        if (closed) return;
        closed = true;
        clearTimeout(retryTimer); retryTimer = null;
        if (sock) { try { sock.destroy(); } catch (e) { /* gone */ } sock = null; }
        failAll('closed');
        setState('closed');
    }

    connect();
    return {
        request: request,
        state: () => st,
        onState: (fn) => { listeners.push(fn); },
        close: close,
        stats: stats,
    };
}

module.exports = { createClient: createClient };
