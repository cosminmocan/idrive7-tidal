'use strict';
/**
 * D1: the app's client for the control socket (docs/PROTOCOL.md section 1), apps/cmocan_tidal/client.js.
 * Answers are matched to requests by id; a request with no answer times out and the next one still works;
 * nothing the service sends can make it throw (rule R1): garbage, half lines, a huge line, silence, a closed
 * socket; it reconnects with growing waits; a missing socket is one clear state, `no-service`.
 */
const assert = require('assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { createFakeService } = require('./fakes/fake_service');
const { createClient } = require('../apps/cmocan_tidal/client');

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-cl-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }

// any throw out of the client would end the process: count them instead and fail the test that caused them
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(e));
process.on('unhandledRejection', (e) => escaped.push(e));
function noEscapes() { assert.deepStrictEqual(escaped.map(String), []); }

/** a raw server: onLine(conn, line) for each request line it gets */
function rawServer(sock, onLine, onConn) {
    const conns = [];
    const server = net.createServer((c) => {
        conns.push(c);
        c.on('error', () => {});
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); onLine(c, l); }
        });
        if (onConn) onConn(c);
    });
    return new Promise((res) => server.listen(sock, () => res({
        conns,
        close: () => new Promise((r) => { conns.forEach((c) => c.destroy()); server.close(() => { try { fs.unlinkSync(sock); } catch (e) { /* gone */ } r(); }); }),
    })));
}

async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 3000);
    while (Date.now() < end) { if (fn()) return; await sleep(10); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}

test('a request reaches the fake service in the contract\'s form and gets its answer', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    const c = createClient({ socketPath: sock, log: quiet });
    try {
        const a = await c.request('status');
        assert.strictEqual(a.ok, true);
        assert.deepStrictEqual(P.validateAnswer('status', a), []);
        const f = await c.request('favorites', { kind: 'tracks', offset: 0, limit: 50 });
        assert.strictEqual(f.ok, true);
        assert.strictEqual(f.items[0].title, 'One More Time');
        svc.requests.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), [], JSON.stringify(r)));
        assert.deepStrictEqual(svc.requests.map((r) => r.cmd), ['status', 'favorites']);
        assert.ok(svc.requests[1].id > svc.requests[0].id, 'ids grow');
        assert.strictEqual(c.state(), 'connected');
    } finally { c.close(); await svc.close(); }
    noEscapes();
});

test('answers that come in another order are matched to their requests by id', async () => {
    const sock = tmpSock();
    let held = null;
    const srv = await rawServer(sock, (conn, line) => {
        const r = JSON.parse(line);
        if (!held) { held = r; return; }
        conn.write(JSON.stringify({ id: r.id, ok: true, which: r.cmd }) + '\n');
        conn.write(JSON.stringify({ id: held.id, ok: true, which: held.cmd }) + '\n');
    });
    const c = createClient({ socketPath: sock, log: quiet });
    try {
        const p1 = c.request('playlists', { offset: 0, limit: 10 }), p2 = c.request('mixes');
        const [a1, a2] = await Promise.all([p1, p2]);
        assert.strictEqual(a1.which, 'playlists');
        assert.strictEqual(a2.which, 'mixes');
    } finally { c.close(); await srv.close(); }
    noEscapes();
});

test('a request with no answer times out with an error; the next request still works; a late answer is ignored', async () => {
    const sock = tmpSock();
    let first = null;
    const srv = await rawServer(sock, (conn, line) => {
        const r = JSON.parse(line);
        if (!first) { first = r; return; }           // silence for the first
        conn.write(JSON.stringify({ id: r.id, ok: true, n: 2 }) + '\n');
    });
    const c = createClient({ socketPath: sock, log: quiet, timeoutMs: 150 });
    try {
        const t0 = Date.now();
        const a = await c.request('status');
        assert.strictEqual(a.ok, false);
        assert.strictEqual(a.error, 'timeout');
        assert.ok(Date.now() - t0 >= 140, 'waited for the timeout');
        const b = await c.request('status');
        assert.strictEqual(b.ok, true); assert.strictEqual(b.n, 2);
        srv.conns[0].write(JSON.stringify({ id: first.id, ok: true, late: true }) + '\n');   // too late: nobody waits
        await sleep(30);
        const d = await c.request('status', {}, { timeoutMs: 1000 });
        assert.strictEqual(d.ok, true); assert.strictEqual(d.late, undefined);
    } finally { c.close(); await srv.close(); }
    noEscapes();
});

test('garbage, half lines, JSON that is not an answer and unknown ids never throw; real answers still arrive (R1)', async () => {
    const sock = tmpSock();
    const srv = await rawServer(sock, (conn, line) => {
        const r = JSON.parse(line);
        conn.write('{not json\n');
        conn.write('\n\n   \n');
        conn.write('null\n42\n"text"\n[1,2]\ntrue\n');
        conn.write('{"ok":true}\n{"id":"7","ok":true}\n{"id":-1,"ok":true}\n{"id":999999,"ok":true}\n{"id":null,"ok":false,"error":"bad-request"}\n');
        conn.write('\u0000ÿ� binary \u0001\n');
        conn.write('{"id":' + r.id + ',"ok":tr');                      // half an answer...
        setTimeout(() => conn.write('ue,"state":{"x":1}}\n'), 20);     // ...and the rest of it later
    });
    const c = createClient({ socketPath: sock, log: quiet, timeoutMs: 2000 });
    try {
        const a = await c.request('status');
        assert.strictEqual(a.ok, true);
        assert.deepStrictEqual(a.state, { x: 1 });
        assert.ok(c.stats.garbage >= 5, 'garbage counted: ' + c.stats.garbage);
    } finally { c.close(); await srv.close(); }
    noEscapes();
});

test('a huge line (3 MiB, no newline for a while) is dropped, its request times out, the connection stays usable (R1)', async () => {
    const sock = tmpSock();
    let n = 0;
    const srv = await rawServer(sock, (conn, line) => {
        const r = JSON.parse(line);
        n++;
        if (n === 1) {
            const chunk = 'x'.repeat(256 * 1024);
            conn.write('{"id":' + r.id + ',"ok":true,"pad":"');
            for (let i = 0; i < 12; i++) conn.write(chunk);
            conn.write('"}\n');
            return;
        }
        conn.write(JSON.stringify({ id: r.id, ok: true, n: n }) + '\n');
    });
    const c = createClient({ socketPath: sock, log: quiet, timeoutMs: 600 });
    try {
        const a = await c.request('status');
        assert.strictEqual(a.ok, false); assert.strictEqual(a.error, 'timeout');
        const b = await c.request('status');
        assert.strictEqual(b.ok, true); assert.strictEqual(b.n, 2);
        assert.ok(c.stats.dropped >= 1, 'the long line counted as dropped');
    } finally { c.close(); await srv.close(); }
    noEscapes();
});

test('the socket closed while requests wait: they end with an error at once, and the client connects again', async () => {
    const sock = tmpSock();
    let n = 0;
    const srv = await rawServer(sock, (conn, line) => {
        const r = JSON.parse(line);
        n++;
        if (n === 1) { conn.write('{"id":' + r.id + ',"ok":tr'); setTimeout(() => conn.destroy(), 20); return; }   // half a line, then gone
        conn.write(JSON.stringify({ id: r.id, ok: true }) + '\n');
    });
    const c = createClient({ socketPath: sock, log: quiet, timeoutMs: 3000, retry: { first: 20, max: 200 } });
    try {
        const t0 = Date.now();
        const a = await c.request('status');
        assert.strictEqual(a.ok, false); assert.strictEqual(a.error, 'disconnected');
        assert.ok(Date.now() - t0 < 1000, 'not left to the timeout');
        await waitFor(() => c.state() === 'connected', 3000, 'connected again');
        const b = await c.request('status');
        assert.strictEqual(b.ok, true);
        assert.ok(c.stats.connects >= 2);
    } finally { c.close(); await srv.close(); }
    noEscapes();
});

test('a missing socket (the tool is not installed) is one clear state, no-service; requests end at once with it', async () => {
    const sock = tmpSock();
    const states = [];
    const c = createClient({ socketPath: sock, log: quiet, retry: { first: 20, max: 80 } });
    c.onState((s) => states.push(s));
    try {
        const a = await c.request('status');
        assert.strictEqual(a.ok, false); assert.strictEqual(a.error, 'no-service');
        assert.strictEqual(c.state(), 'no-service');
        await sleep(400);                                     // several retries meanwhile
        assert.deepStrictEqual(states.filter((s) => s !== 'connecting'), ['no-service'], 'told once: ' + states.join(','));
        assert.strictEqual(c.state(), 'no-service', 'no flapping between retries');
        // a socket file with nobody behind it (the service stopped, socket left): also no-service
        fs.writeFileSync(sock, '');
        await sleep(150);
        assert.strictEqual(c.state(), 'no-service');
        fs.unlinkSync(sock);
    } finally { c.close(); }
    noEscapes();
});

test('reconnects with growing waits (capped), and connects once the service is there', async () => {
    const sock = tmpSock();
    const c = createClient({ socketPath: sock, log: quiet, retry: { first: 20, max: 160 } });
    let svc = null;
    try {
        await sleep(700);
        const w = c.stats.waits.slice();
        assert.ok(w.length >= 4, 'retried: ' + w.join(','));
        for (let i = 1; i < w.length; i++) assert.ok(w[i] >= w[i - 1], 'never shorter: ' + w.join(','));
        assert.ok(w[w.length - 1] > w[0], 'grows: ' + w.join(','));
        assert.ok(Math.max.apply(null, w) <= 160, 'capped: ' + w.join(','));
        svc = await createFakeService({ socketPath: sock });
        await waitFor(() => c.state() === 'connected', 2000, 'connected');
        const a = await c.request('status');
        assert.strictEqual(a.ok, true);
        // after a connection the wait starts small again
        const k = c.stats.waits.length;
        await svc.close(); svc = null;
        await waitFor(() => c.state() === 'no-service', 2000, 'no-service after the service went');
        assert.strictEqual(c.stats.waits[k], 20, 'first wait after the connection: ' + c.stats.waits.slice(k).join(','));
    } finally { c.close(); if (svc) await svc.close(); }
    noEscapes();
});

test('close() ends everything: waiting requests get an error, no more connects', async () => {
    const sock = tmpSock();
    const srv = await rawServer(sock, () => {});
    const c = createClient({ socketPath: sock, log: quiet, timeoutMs: 5000 });
    const p = c.request('status');
    await sleep(50);
    c.close();
    const a = await p;
    assert.strictEqual(a.ok, false);
    const b = await c.request('status');
    assert.strictEqual(b.ok, false); assert.strictEqual(b.error, 'closed');
    await srv.close();
    noEscapes();
});

run();
