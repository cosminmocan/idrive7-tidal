'use strict';
/**
 * fake_netx.js - a stand-in for stream A's lib/netx.js (docs/INTERNAL-API.md, "lib/netx.js"), for the service's
 * tests (stream C). Same shape; plain HTTP to local test servers, no DNS, no TLS. It runs in the test process or in
 * the forked client.js (CMOCAN_NETX=<this file>). Node 8.9.4 syntax.
 *
 *   const netx = createNetx({ leasePath });
 *   netx.online()                                   the lease file is there and lists a DNS server
 *   netx.request({ method, url, headers, body, timeoutMs, maxBytes })  -> Promise<{ status, headers, body }>
 *   netx.openStream({ url, headers, timeoutMs })    -> Promise<{ status, headers, stream }>; the stream errors
 *                                                      (never just ends) when the connection breaks
 *   netx.close()
 *
 * No lease: rejects with code 'offline' (as the real one). A refused connection: 'offline'.
 */
const fs = require('fs');
const http = require('http');
const { URL } = require('url');

function err(code, message, status) { const e = new Error(message); e.code = code; if (status) e.status = status; return e; }

function createNetx(opts) {
    const o = opts || {};
    const agent = new http.Agent({ keepAlive: false });

    function online() {
        try {
            const l = JSON.parse(fs.readFileSync(o.leasePath, 'utf8'));
            return !!(l && Array.isArray(l.dns) && l.dns.length);
        } catch (e) { return false; }
    }

    function open(req) {
        return new Promise((resolve, reject) => {
            if (!online()) return reject(err('offline', 'no uplink lease'));
            let u;
            try { u = new URL(req.url); } catch (e) { return reject(err('tidal-error', 'bad url ' + req.url)); }
            const r = http.request({ agent: agent, method: req.method || 'GET', hostname: u.hostname, port: u.port,
                path: u.pathname + u.search, headers: req.headers || {} });
            const t = setTimeout(() => { r.abort(); reject(err('offline', 'timed out')); }, req.timeoutMs || 15000);
            r.on('response', (res) => { clearTimeout(t); resolve({ res: res, timeoutMs: req.timeoutMs || 15000 }); });
            r.on('error', (e) => { clearTimeout(t); reject(err('offline', e.message)); });
            if (req.body) r.write(req.body);
            r.end();
        });
    }

    function request(req) {
        return open(req).then((x) => new Promise((resolve, reject) => {
            const chunks = [];
            let n = 0;
            const max = req.maxBytes || 4 * 1024 * 1024;
            x.res.on('data', (d) => { n += d.length; if (n > max) { x.res.destroy(); reject(err('tidal-error', 'answer too big')); } else chunks.push(d); });
            x.res.on('end', () => resolve({ status: x.res.statusCode, headers: x.res.headers, body: Buffer.concat(chunks) }));
            x.res.on('error', (e) => reject(err('offline', e.message)));
        }));
    }

    function openStream(req) {
        return open(req).then((x) => {
            const res = x.res;
            const expected = res.headers['content-length'] !== undefined ? Number(res.headers['content-length']) : null;
            const { PassThrough } = require('stream');
            const out = new PassThrough();
            let got = 0, done = false;
            function fail(why) { if (done) return; done = true; res.destroy(); out.emit('error', err('offline', why)); }
            let idle = setTimeout(() => fail('idle'), x.timeoutMs);
            res.on('data', (d) => { got += d.length; clearTimeout(idle); idle = setTimeout(() => fail('idle'), x.timeoutMs);
                if (!out.write(d)) { clearTimeout(idle); res.pause(); out.once('drain', () => { idle = setTimeout(() => fail('idle'), x.timeoutMs); res.resume(); }); } });
            res.on('aborted', () => { clearTimeout(idle); fail('connection broken'); });
            res.on('error', () => { clearTimeout(idle); fail('connection broken'); });
            res.on('end', () => {
                clearTimeout(idle);
                if (done) return;
                if (expected !== null && got < expected) return fail('connection broken after ' + got + ' of ' + expected);
                done = true; out.end();
            });
            const destroy = out.destroy ? out.destroy.bind(out) : null;
            out.destroy = function (e) { clearTimeout(idle); done = true; res.destroy(); if (destroy) destroy(e); };
            return { status: res.statusCode, headers: res.headers, stream: out };
        });
    }

    function close() { agent.destroy(); }

    return { online: online, request: request, openStream: openStream, close: close };
}

module.exports = { createNetx: createNetx };
