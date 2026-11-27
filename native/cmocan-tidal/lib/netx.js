'use strict';
/**
 * netx.js - every connection to TIDAL goes through here (docs/INTERNAL-API.md, task A1). Node 8.9.4.
 *
 * The head unit's own resolver does not resolve internet names: names go to the DNS servers mgu-uplink lists in
 * its lease (/run/mgu-uplink/lease.json, present while online). The firmware has no public CA list and Node
 * 8.9.4's own one is too old: certificates are checked against the bundled cacert.pem only.
 *
 *   const netx = createNetx({ leasePath, caFile });       // tests: resolver: (host) => Promise<ip>, ca: <PEM>, now
 *   netx.online()                                          // the lease is there and lists a DNS server
 *   netx.request({ method, url, headers, body, timeoutMs, maxBytes }) -> Promise<{ status, headers, body }>
 *   netx.openStream({ url, headers, timeoutMs })           -> Promise<{ status, headers, stream }>
 *   netx.close()                                           // ends kept-alive connections
 *
 * Errors: code 'offline' (no lease, no name, no connection, a timeout, a broken connection) or 'tidal-error'
 * (a certificate we do not trust, an answer that is not HTTP, an answer over the size cap).
 * timeoutMs limits each phase on its own: connecting (DNS, TCP and TLS), the first byte, and any silence after.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const url = require('url');
const PassThrough = require('stream').PassThrough;

const LEASE = '/run/mgu-uplink/lease.json';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_MS = 10000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const FREE_IDLE_MS = 20000;          // a kept-alive connection unused this long is closed by us
const DNS_MAX_TTL_S = 300;
const MAX_REDIRECTS = 3;

function netError(code, message, extra) {
    const e = new Error(message);
    e.code = code;
    if (extra) Object.keys(extra).forEach((k) => { if (extra[k] !== undefined) e[k] = extra[k]; });
    return e;
}

/** a low-level error -> our code: certificates and non-HTTP answers are TIDAL's side, the rest is the network */
function classify(err) {
    const c = String((err && err.code) || '');
    const m = String((err && err.message) || '');
    if (/CERT|SIGNATURE|SELF_SIGNED|ISSUER|ALTNAME|UNABLE_TO|ERR_SSL|EPROTO/.test(c) || (err && err.reason) || /certificate|altnames/i.test(m)) return 'tidal-error';
    if (/^HPE_/.test(c) || /parse error/i.test(m)) return 'tidal-error';
    return 'offline';
}

function wrap(err, host) {
    const code = classify(err);
    const what = code === 'tidal-error' && /CERT|SIGNATURE|SELF_SIGNED|ISSUER|ALTNAME|UNABLE_TO/.test(String(err.code || '') + String(err.message || ''))
        ? 'TLS: ' : '';
    return netError(code, what + (err.message || String(err)) + ' (' + host + ')', { cause: err.code });
}

const DNS_ENTRY = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/;

function createNetx(o) {
    const opts = o || {};
    const leasePath = opts.leasePath || LEASE;
    const now = opts.now || Date.now;
    const connectMs = opts.connectTimeoutMs || DEFAULT_CONNECT_MS;
    const dnsCache = {};
    let ca = null;

    function caList() {
        if (ca === null) {
            let pem = opts.ca;
            if (pem === undefined) {
                try { pem = fs.readFileSync(opts.caFile || path.join(__dirname, '..', 'cacert.pem'), 'utf8'); } catch (e) { pem = ''; }
            }
            ca = (Array.isArray(pem) ? pem : String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/))
                .filter((c) => String(c).indexOf('BEGIN CERTIFICATE') >= 0);
        }
        return ca;
    }

    function dnsServers() {
        try {
            const l = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
            return (l && Array.isArray(l.dns) ? l.dns : []).filter((s) => typeof s === 'string' && DNS_ENTRY.test(s));
        } catch (e) { return null; }
    }

    function online() {
        const s = dnsServers();
        return !!(s && s.length);
    }

    /** host -> IPv4 address, through the lease's DNS servers (or opts.resolver) */
    function resolve(host) {
        if (net.isIP(host)) return Promise.resolve(host);
        if (opts.resolver) return Promise.resolve().then(() => opts.resolver(host));
        const c = dnsCache[host];
        if (c && c.until > now()) return Promise.resolve(c.ip);
        const servers = dnsServers();
        if (!servers || !servers.length) return Promise.reject(netError('offline', 'no internet: mgu-uplink lists no DNS server'));
        return new Promise((res, rej) => {
            const r = new dns.Resolver();
            r.setServers(servers);
            r.resolve4(host, { ttl: true }, (err, addrs) => {
                if (err || !addrs || !addrs.length) {
                    rej(netError('offline', 'cannot resolve ' + host + ': ' + ((err && err.code) || 'no address')));
                    return;
                }
                const ttl = Math.min(DNS_MAX_TTL_S, Math.max(0, Number(addrs[0].ttl) || 0));
                dnsCache[host] = { ip: addrs[0].address, until: now() + ttl * 1000 };
                res(addrs[0].address);
            });
        });
    }

    function lookup(host, options, cb) {
        if (typeof options === 'function') { cb = options; options = {}; }
        resolve(host).then(
            (ip) => { if (options && options.all) cb(null, [{ address: ip, family: 4 }]); else cb(null, ip, 4); },
            (err) => cb(err));
    }

    const agents = {};
    function agentFor(isTls) {
        const k = isTls ? 'https' : 'http';
        if (!agents[k]) {
            const a = new (isTls ? https : http).Agent({ keepAlive: true, maxSockets: 6, maxFreeSockets: 4 });
            a.on('free', (sock) => {
                sock.__netxFree = true;
                sock.setTimeout(FREE_IDLE_MS);
                if (!sock.__netxIdleHook) {
                    sock.__netxIdleHook = true;
                    sock.on('timeout', () => { if (sock.__netxFree) sock.destroy(); });
                }
            });
            agents[k] = a;
        }
        return agents[k];
    }

    function options(u, method, headers, agent) {
        const isTls = u.protocol === 'https:';
        const o = {
            method: method || 'GET', host: u.hostname, port: Number(u.port) || (isTls ? 443 : 80), path: u.path,
            headers: headers, agent: agent, lookup: lookup,
        };
        if (isTls) {
            o.ca = caList();
            o.rejectUnauthorized = true;
            if (!net.isIP(u.hostname)) o.servername = u.hostname;
        }
        return o;
    }

    function parseUrl(s) {
        const u = url.parse(String(s || ''));
        if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
        return u;
    }

    /* ---------- request: a whole answer in memory ---------- */

    function attempt(r, fresh) {
        return new Promise((resolveP, rejectP) => {
            const u = parseUrl(r.url);
            if (!u) { rejectP(netError('tidal-error', 'not an http(s) address: ' + r.url)); return; }
            const isTls = u.protocol === 'https:';
            const host = u.hostname;
            const timeoutMs = r.timeoutMs || DEFAULT_TIMEOUT_MS;
            const maxBytes = r.maxBytes || DEFAULT_MAX_BYTES;
            const headers = Object.assign({}, r.headers || {});
            let body = r.body;
            if (body !== undefined && body !== null) {
                if (!Buffer.isBuffer(body)) body = Buffer.from(String(body));
                headers['Content-Length'] = body.length;
            }
            let done = false;
            let timer = null;
            let gotResponse = false;
            let reused = false;
            let req = null;
            const finish = (err, val) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (err) { try { req.abort(); } catch (e) { /* gone */ } rejectP(err); } else resolveP(val);
            };
            const arm = (ms, what) => {
                clearTimeout(timer);
                timer = setTimeout(() => finish(netError('offline', what + ' (' + host + ', ' + ms + ' ms)')), ms);
            };
            arm(Math.min(timeoutMs, connectMs), 'could not connect in time');
            try {
                req = (isTls ? https : http).request(options(u, r.method, headers, fresh ? false : agentFor(isTls)), (res) => {
                    gotResponse = true;
                    const status = res.statusCode;
                    const len = res.headers['content-length'] !== undefined ? Number(res.headers['content-length']) : -1;
                    if (len > maxBytes) { finish(netError('tidal-error', 'answer too large: ' + len + ' bytes, the cap is ' + maxBytes + ' (' + host + ')', { status: status })); return; }
                    const chunks = [];
                    let size = 0;
                    const idle = () => arm(timeoutMs, 'the answer stalled (idle)');
                    idle();
                    res.on('data', (d) => {
                        if (done) return;
                        size += d.length;
                        if (size > maxBytes) { finish(netError('tidal-error', 'answer too large: over ' + maxBytes + ' bytes (' + host + ')', { status: status })); return; }
                        chunks.push(d);
                        idle();
                    });
                    // Node 8 says 'aborted' also when the server closed after the whole answer, before it was read
                    res.on('aborted', () => { if (!res.complete) finish(netError('offline', 'the connection broke during the answer (' + host + ')')); });
                    res.on('error', (e) => finish(wrap(e, host)));
                    res.on('end', () => {
                        if (res.complete === false) { finish(netError('offline', 'the connection broke during the answer (' + host + ')')); return; }
                        finish(null, { status: status, headers: res.headers, body: Buffer.concat(chunks) });
                    });
                });
            } catch (e) { finish(wrap(e, host)); return; }
            req.on('socket', (sock) => {
                if (sock.__netxUsed) {
                    reused = true;
                    sock.__netxFree = false;
                    sock.setTimeout(0);
                    arm(timeoutMs, 'the server did not answer in time');
                    return;
                }
                sock.__netxUsed = true;
                sock.once(isTls ? 'secureConnect' : 'connect', () => { if (!gotResponse && !done) arm(timeoutMs, 'the server did not answer in time'); });
            });
            req.on('error', (e) => {
                const err = wrap(e, host);
                // a kept-alive connection the server had closed: one more try, on a fresh connection
                if (reused && !gotResponse && !fresh) err.retryable = true;
                finish(err);
            });
            req.end(body);
        });
    }

    function request(r) {
        if (!online()) return Promise.reject(netError('offline', 'no internet: mgu-uplink is not online'));
        return attempt(r || {}, false).catch((e) => {
            if (e.retryable) return attempt(r, true);
            throw e;
        });
    }

    /* ---------- openStream: the track's bytes ---------- */

    function streamAttempt(r, hops) {
        return new Promise((resolveP, rejectP) => {
            const u = parseUrl(r.url);
            if (!u) { rejectP(netError('tidal-error', 'not an http(s) address: ' + r.url)); return; }
            const isTls = u.protocol === 'https:';
            const host = u.hostname;
            const timeoutMs = r.timeoutMs || DEFAULT_TIMEOUT_MS;
            let timer = null;
            let opened = false;   // the promise is settled
            let ended = false;    // the stream is finished, one way or another
            let req = null;
            const pt = new PassThrough();
            const stop = () => { clearTimeout(timer); try { req.abort(); } catch (e) { /* gone */ } };
            const failStream = (err) => { if (ended) return; ended = true; stop(); pt.destroy(err); };
            const failOpen = (err) => {
                if (opened) { failStream(err); return; }
                opened = true; ended = true; stop(); rejectP(err);
            };
            pt._destroy = (err, cb) => { if (!ended) { ended = true; stop(); } cb(err); };
            const arm = (ms, what) => {
                clearTimeout(timer);
                timer = setTimeout(() => failOpen(netError('offline', what + ' (' + host + ', ' + ms + ' ms)')), ms);
            };
            arm(Math.min(timeoutMs, connectMs), 'could not connect in time');
            try {
                req = (isTls ? https : http).request(options(u, 'GET', Object.assign({}, r.headers || {}), false), (res) => {
                    const loc = res.headers.location;
                    if (res.statusCode >= 300 && res.statusCode < 400 && loc && hops < MAX_REDIRECTS) {
                        opened = true; ended = true; stop(); res.resume();
                        streamAttempt(Object.assign({}, r, { url: url.resolve(r.url, loc) }), hops + 1).then(resolveP, rejectP);
                        return;
                    }
                    opened = true;
                    clearTimeout(timer);
                    const expected = res.headers['content-length'] !== undefined ? Number(res.headers['content-length']) : -1;
                    let got = 0;
                    let flowing = true;
                    const idle = () => {
                        clearTimeout(timer);
                        if (flowing && !ended) timer = setTimeout(() => failStream(netError('offline', 'the download stalled (idle ' + timeoutMs + ' ms, ' + host + ')')), timeoutMs);
                    };
                    const broke = () => failStream(netError('offline', 'the connection broke after ' + got + ' bytes (' + host + ')'));
                    res.on('data', (d) => {
                        if (ended) return;
                        got += d.length;
                        // a reader that is behind holds the download back; that silence is not the server's
                        if (!pt.write(d)) { flowing = false; res.pause(); clearTimeout(timer); } else idle();
                    });
                    pt.on('drain', () => { if (ended) return; flowing = true; res.resume(); idle(); });
                    // Node 8 says 'aborted' (and 'close') also when the server closed the connection after the whole
                    // answer had arrived, while the reader is behind: the rest is still to come, then 'end'
                    res.on('aborted', () => { if (!res.complete) broke(); });
                    res.on('error', (e) => failStream(wrap(e, host)));
                    res.on('close', () => { if (!ended && !res.complete) broke(); });
                    res.on('end', () => {
                        if (ended) return;
                        if (res.complete === false || (expected >= 0 && got < expected)) { broke(); return; }
                        ended = true;
                        clearTimeout(timer);
                        pt.end();
                    });
                    idle();
                    resolveP({ status: res.statusCode, headers: res.headers, stream: pt });
                });
            } catch (e) { failOpen(wrap(e, host)); return; }
            req.on('socket', (sock) => {
                sock.once(isTls ? 'secureConnect' : 'connect', () => { if (!opened) arm(timeoutMs, 'the server did not answer in time'); });
            });
            req.on('error', (e) => failOpen(wrap(e, host)));
            req.end();
        });
    }

    function openStream(r) {
        if (!online()) return Promise.reject(netError('offline', 'no internet: mgu-uplink is not online'));
        return streamAttempt(r || {}, 0);
    }

    function close() {
        Object.keys(agents).forEach((k) => { try { agents[k].destroy(); } catch (e) { /* gone */ } });
    }

    return { online: online, request: request, openStream: openStream, close: close, resolve: resolve };
}

module.exports = { createNetx: createNetx, LEASE: LEASE };
