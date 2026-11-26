'use strict';
/**
 * A1: netx.js, the HTTPS layer (docs/INTERNAL-API.md). No real network: a fake DNS server on UDP 127.0.0.1 and
 * local TLS servers with a test-only CA (tests/fixtures/tidal/TEST-ONLY-*).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const https = require('https');
const http = require('http');
const { test, run } = require('./lib/t');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'tidal');
const { createNetx } = require(path.join(ROOT, 'native', 'cmocan-tidal', 'lib', 'netx'));

const CA = fs.readFileSync(path.join(FIX, 'TEST-ONLY-ca.pem'), 'utf8');
const GOOD = { key: fs.readFileSync(path.join(FIX, 'TEST-ONLY-server.key')), cert: fs.readFileSync(path.join(FIX, 'TEST-ONLY-server.pem')) };
const ROGUE = { key: fs.readFileSync(path.join(FIX, 'TEST-ONLY-rogue-server.key')), cert: fs.readFileSync(path.join(FIX, 'TEST-ONLY-rogue-server.pem')) };
const CODES = ['offline', 'not-logged-in', 'login-expired', 'not-found', 'not-available', 'rate-limited', 'tidal-error', 'bad-request'];

let tmpN = 0;
function tmpDir() {
    const d = path.join(os.tmpdir(), 'netx-test-' + process.pid + '-' + (tmpN++));
    fs.mkdirSync(d);
    return d;
}

/* ---------- a fake DNS server: answers A queries from a table, NXDOMAIN otherwise ---------- */
function fakeDns(table) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        const queries = [];
        sock.on('message', (msg, rinfo) => {
            let off = 12;
            const labels = [];
            while (off < msg.length && msg[off] !== 0) { labels.push(msg.slice(off + 1, off + 1 + msg[off]).toString()); off += msg[off] + 1; }
            const name = labels.join('.').toLowerCase();
            const qtype = msg.readUInt16BE(off + 1);
            const qend = off + 5;
            queries.push({ name: name, type: qtype });
            const ip = qtype === 1 ? table[name] : undefined;
            const head = Buffer.alloc(12);
            msg.copy(head, 0, 0, 2);
            head.writeUInt16BE(ip ? 0x8180 : 0x8183, 2);
            head.writeUInt16BE(1, 4);
            head.writeUInt16BE(ip ? 1 : 0, 6);
            const parts = [head, msg.slice(12, qend)];
            if (ip) {
                const ans = Buffer.alloc(16);
                ans.writeUInt16BE(0xc00c, 0); ans.writeUInt16BE(1, 2); ans.writeUInt16BE(1, 4); ans.writeUInt32BE(60, 6); ans.writeUInt16BE(4, 10);
                ip.split('.').forEach((b, i) => { ans[12 + i] = Number(b); });
                parts.push(ans);
            }
            sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
        });
        sock.bind(0, '127.0.0.1', () => resolve({ port: sock.address().port, queries: queries, close: () => sock.close() }));
    });
}

/* ---------- servers ---------- */
function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function closeServer(server) {
    return new Promise((resolve) => {
        (server.conns || []).forEach((c) => c.destroy());
        server.close(() => resolve());
    });
}
/** an HTTPS server with the given handler; counts its connections */
function tlsServer(handler, certs) {
    const s = https.createServer(certs || GOOD, handler);
    s.conns = [];
    s.on('secureConnection', (c) => { s.conns.push(c); });
    s.on('connection', (c) => { s.tcpConns = (s.tcpConns || 0) + 1; c.on('error', () => {}); });
    s.keepAliveTimeout = 30000;
    return s;
}

/** a netx whose lease lists the fake DNS server, which resolves the given names to 127.0.0.1 */
function setup(names, extra) {
    const dir = tmpDir();
    const leasePath = path.join(dir, 'lease.json');
    const table = {};
    names.forEach((n) => { table[n] = '127.0.0.1'; });
    return fakeDns(table).then((dns) => {
        fs.writeFileSync(leasePath, JSON.stringify({ ip: '10.0.0.2', dns: ['127.0.0.1:' + dns.port] }));
        const netx = createNetx(Object.assign({ leasePath: leasePath, ca: CA }, extra || {}));
        return { netx: netx, dns: dns, leasePath: leasePath, done: () => { netx.close(); dns.close(); } };
    });
}

function expectCode(p, code, re) {
    return p.then(
        (v) => { throw new Error('expected a rejection with ' + code + ', got ' + JSON.stringify(v && v.status)); },
        (e) => {
            assert.strictEqual(e.code, code, 'code ' + e.code + ': ' + e.message);
            assert.ok(e instanceof Error);
            if (re) assert.ok(re.test(e.message), e.message);
            return e;
        });
}

function readAll(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (d) => chunks.push(d));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

/* ---------- online / offline ---------- */

test('online() is false with no lease file, or a lease with no DNS server; true with one', () => {
    const dir = tmpDir();
    const leasePath = path.join(dir, 'lease.json');
    const netx = createNetx({ leasePath: leasePath, ca: CA });
    assert.strictEqual(netx.online(), false);
    fs.writeFileSync(leasePath, '{"ip":"10.0.0.2","dns":[]}');
    assert.strictEqual(netx.online(), false);
    fs.writeFileSync(leasePath, '{"ip":"10.0.0');
    assert.strictEqual(netx.online(), false);
    fs.writeFileSync(leasePath, '{"ip":"10.0.0.2","dns":["192.0.2.53"]}');
    assert.strictEqual(netx.online(), true);
    netx.close();
});

test('no lease file: a request is rejected with offline and no connection is made', () => {
    const server = tlsServer((req, res) => res.end('hi'));
    return listen(server).then((port) => {
        const netx = createNetx({ leasePath: path.join(tmpDir(), 'none.json'), ca: CA, resolver: () => Promise.resolve('127.0.0.1') });
        return expectCode(netx.request({ url: 'https://tidal.test:' + port + '/' }), 'offline')
            .then(() => expectCode(netx.openStream({ url: 'https://tidal.test:' + port + '/' }), 'offline'))
            .then(() => { assert.strictEqual(server.tcpConns || 0, 0); netx.close(); return closeServer(server); });
    });
});

/* ---------- DNS ---------- */

test('the name is resolved by the lease\'s DNS server, not the system\'s', () => {
    const server = tlsServer((req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end('hello ' + req.headers.host); });
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        // "tidal.test" does not exist anywhere but in the fake DNS server
        return env.netx.request({ url: 'https://tidal.test:' + port + '/x' });
    })).then((r) => {
        assert.strictEqual(r.status, 200);
        assert.ok(Buffer.isBuffer(r.body));
        assert.strictEqual(r.body.toString(), 'hello tidal.test:' + server.address().port);
        assert.strictEqual(r.headers['content-type'], 'text/plain');
        assert.ok(env.dns.queries.some((q) => q.name === 'tidal.test' && q.type === 1), JSON.stringify(env.dns.queries));
    }).then(() => { env.done(); return closeServer(server); });
});

test('a name the DNS server does not know is offline', () => {
    let env;
    return setup([]).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://nowhere.test/', timeoutMs: 3000 }), 'offline');
    }).then(() => env.done());
});

test('the resolver option replaces DNS (tests)', () => {
    const server = tlsServer((req, res) => res.end('ok'));
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'lease.json'), '{"ip":"10.0.0.2","dns":["192.0.2.53"]}');
    const asked = [];
    const netx = createNetx({ leasePath: path.join(dir, 'lease.json'), ca: CA, resolver: (h) => { asked.push(h); return Promise.resolve('127.0.0.1'); } });
    return listen(server).then((port) => netx.request({ url: 'https://api.tidal.test:' + port + '/' })).then((r) => {
        assert.strictEqual(r.body.toString(), 'ok');
        assert.deepStrictEqual(asked, ['api.tidal.test']);
        netx.close();
        return closeServer(server);
    });
});

/* ---------- certificates ---------- */

test('a certificate not signed by the bundle is refused', () => {
    let hits = 0;
    const server = tlsServer((req, res) => { hits++; res.end('secret'); }, ROGUE);
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/' }), 'tidal-error', /certificate|self.signed|issuer/i);
    })).then(() => expectCode(env.netx.openStream({ url: 'https://tidal.test:' + server.address().port + '/' }), 'tidal-error'))
        .then(() => { assert.strictEqual(hits, 0, 'no request reached the server'); env.done(); return closeServer(server); });
});

test('a certificate for another name is refused', () => {
    const server = tlsServer((req, res) => res.end('x'));
    let env;
    return listen(server).then((port) => setup(['other.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://other.test:' + port + '/' }), 'tidal-error');
    })).then(() => { env.done(); return closeServer(server); });
});

test('the bundled cacert.pem is used when no ca is given, and it does not trust the test CA', () => {
    const server = tlsServer((req, res) => res.end('x'));
    let env;
    return listen(server).then((port) => setup(['tidal.test'], { ca: undefined, caFile: path.join(ROOT, 'native', 'cmocan-tidal', 'cacert.pem') }).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/' }), 'tidal-error');
    })).then(() => { env.done(); return closeServer(server); });
});

/* ---------- timeouts ---------- */

test('connect timeout: a server that takes the TCP connection but never does TLS', () => {
    const silent = net.createServer((c) => { silent.conns.push(c); c.on('error', () => {}); });
    silent.conns = [];
    let env;
    const t0 = Date.now();
    return listen(silent).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/', timeoutMs: 400 }), 'offline', /connect/i);
    })).then(() => {
        const took = Date.now() - t0;
        assert.ok(took >= 350 && took < 3000, 'took ' + took);
        env.done();
        return closeServer(silent);
    });
});

test('first-byte timeout: the server reads the request and never answers', () => {
    const server = tlsServer(() => { /* never answers */ });
    let env;
    let t0;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        t0 = Date.now();
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/', timeoutMs: 400 }), 'offline', /answer/i);
    })).then(() => {
        const took = Date.now() - t0;
        assert.ok(took >= 350 && took < 3000, 'took ' + took);
        env.done();
        return closeServer(server);
    });
});

test('idle timeout: the answer starts and then stalls', () => {
    const server = tlsServer((req, res) => { res.writeHead(200, { 'Content-Length': 1000 }); res.write('partial'); });
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/', timeoutMs: 400 }), 'offline', /idle|stalled/i);
    })).then(() => { env.done(); return closeServer(server); });
});

test('a slow answer that keeps coming is not cut off by the idle timeout', () => {
    const server = tlsServer((req, res) => {
        res.writeHead(200, { 'Content-Length': 10 });
        let n = 0;
        const t = setInterval(() => { res.write('x'); if (++n === 10) { clearInterval(t); res.end(); } }, 60);
    });
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.request({ url: 'https://tidal.test:' + port + '/', timeoutMs: 300 });
    })).then((r) => { assert.strictEqual(r.body.toString(), 'xxxxxxxxxx'); env.done(); return closeServer(server); });
});

/* ---------- size cap ---------- */

test('an answer over the size cap is cut off with an error (Content-Length and chunked)', () => {
    const server = tlsServer((req, res) => {
        const big = Buffer.alloc(5000, 97);
        if (req.url === '/len') { res.writeHead(200, { 'Content-Length': big.length }); res.end(big); return; }
        res.writeHead(200); // chunked
        res.write(big.slice(0, 2000));
        setTimeout(() => res.end(big.slice(2000)), 20);
    });
    let env;
    let port;
    return listen(server).then((p) => { port = p; return setup(['tidal.test']); }).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/len', maxBytes: 4096 }), 'tidal-error', /large|cap|bytes/i);
    }).then(() => expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/chunked', maxBytes: 4096 }), 'tidal-error', /large|cap|bytes/i))
        .then(() => env.netx.request({ url: 'https://tidal.test:' + port + '/len', maxBytes: 5000 }))
        .then((r) => { assert.strictEqual(r.body.length, 5000); env.done(); return closeServer(server); });
});

test('the default size cap is 4 MiB', () => {
    const server = tlsServer((req, res) => { res.writeHead(200, { 'Content-Length': 4 * 1024 * 1024 + 1 }); res.end(Buffer.alloc(4 * 1024 * 1024 + 1)); });
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/' }), 'tidal-error');
    })).then(() => { env.done(); return closeServer(server); });
});

/* ---------- keep-alive and the one retry ---------- */

test('requests share one kept-alive connection; method, headers and body arrive', () => {
    const seen = [];
    const server = tlsServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { seen.push({ method: req.method, url: req.url, h: req.headers['x-test'], body: body }); res.end('ok' + seen.length); });
    });
    let env;
    let port;
    return listen(server).then((p) => { port = p; return setup(['tidal.test']); }).then((e) => {
        env = e;
        return env.netx.request({ method: 'POST', url: 'https://tidal.test:' + port + '/a?b=1', headers: { 'X-Test': 'yes', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'k=v' });
    }).then((r) => {
        assert.strictEqual(r.body.toString(), 'ok1');
        return env.netx.request({ url: 'https://tidal.test:' + port + '/c' });
    }).then((r) => {
        assert.strictEqual(r.body.toString(), 'ok2');
        assert.deepStrictEqual(seen, [{ method: 'POST', url: '/a?b=1', h: 'yes', body: 'k=v' }, { method: 'GET', url: '/c', h: undefined, body: '' }]);
        assert.strictEqual(server.tcpConns, 1, 'one connection for both');
        env.done();
        return closeServer(server);
    });
});

test('a kept-alive connection the server closed is retried once on a fresh one', () => {
    let n = 0;
    const server = tlsServer((req, res) => {
        n++;
        if (n === 2) { req.socket.destroy(); return; } // the server dropped the idle connection as the request came
        res.end('answer ' + n);
    });
    let env;
    let port;
    return listen(server).then((p) => { port = p; return setup(['tidal.test']); }).then((e) => {
        env = e;
        return env.netx.request({ url: 'https://tidal.test:' + port + '/1' });
    }).then((r) => {
        assert.strictEqual(r.body.toString(), 'answer 1');
        return env.netx.request({ url: 'https://tidal.test:' + port + '/2' });
    }).then((r) => {
        assert.strictEqual(r.body.toString(), 'answer 3');
        assert.strictEqual(server.tcpConns, 2, 'the retry used a fresh connection');
        env.done();
        return closeServer(server);
    });
});

test('a fresh connection that is dropped is not retried: offline', () => {
    const server = tlsServer((req) => { req.socket.destroy(); });
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.request({ url: 'https://tidal.test:' + port + '/' }), 'offline');
    })).then(() => { assert.strictEqual(server.tcpConns, 1); env.done(); return closeServer(server); });
});

test('close() ends kept-alive connections', () => {
    const server = tlsServer((req, res) => res.end('ok'));
    let env;
    let closed = false;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.request({ url: 'https://tidal.test:' + port + '/' });
    })).then(() => {
        assert.strictEqual(server.conns.length, 1);
        server.conns[0].on('close', () => { closed = true; });
        env.netx.close();
        return new Promise((r) => setTimeout(r, 200));
    }).then(() => { assert.ok(closed, 'the server saw the connection end'); env.dns.close(); return closeServer(server); });
});

/* ---------- R2: any answer ---------- */

test('garbage instead of HTTP is a rejection, not a crash', () => {
    const server = tls.createServer(GOOD, (c) => { c.on('error', () => {}); c.on('data', () => { c.end('NOT HTTP AT ALL\r\n\r\n'); }); });
    server.conns = [];
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.request({ url: 'https://tidal.test:' + port + '/' }).then(
            () => { throw new Error('expected a rejection'); },
            (err) => { assert.ok(CODES.indexOf(err.code) >= 0, err.code); });
    })).then(() => { env.done(); return closeServer(server); });
});

test('plain http:// works too (the local fake TIDAL in tests)', () => {
    const server = http.createServer((req, res) => res.end('plain'));
    server.conns = [];
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'lease.json'), '{"ip":"10.0.0.2","dns":["192.0.2.53"]}');
    const netx = createNetx({ leasePath: path.join(dir, 'lease.json'), ca: CA });
    return listen(server).then((port) => netx.request({ url: 'http://127.0.0.1:' + port + '/' })).then((r) => {
        assert.strictEqual(r.body.toString(), 'plain');
        netx.close();
        return closeServer(server);
    });
});

/* ---------- openStream ---------- */

const FILE = Buffer.alloc(200000);
for (let i = 0; i < FILE.length; i++) FILE[i] = i % 251;

function fileServer(mode) {
    return tlsServer((req, res) => {
        const m = /bytes=(\d+)-/.exec(req.headers.range || '');
        const start = m ? Number(m[1]) : 0;
        const body = FILE.slice(start);
        const head = { 'Content-Length': body.length, 'Content-Type': 'audio/flac' };
        if (m) head['Content-Range'] = 'bytes ' + start + '-' + (FILE.length - 1) + '/' + FILE.length;
        res.writeHead(m ? 206 : 200, head);
        if (mode === 'cut') { res.write(body.slice(0, 50000)); setTimeout(() => req.socket.destroy(), 50); return; }
        if (mode === 'stall') { res.write(body.slice(0, 50000)); return; }
        res.end(body);
    });
}

test('openStream gives the status, headers and the whole body; Range is passed on', () => {
    const server = fileServer();
    let env;
    let port;
    return listen(server).then((p) => { port = p; return setup(['tidal.test']); }).then((e) => {
        env = e;
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac' });
    }).then((r) => {
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers['content-type'], 'audio/flac');
        return readAll(r.stream);
    }).then((buf) => {
        assert.ok(buf.equals(FILE));
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac', headers: { Range: 'bytes=150000-' } });
    }).then((r) => {
        assert.strictEqual(r.status, 206);
        return readAll(r.stream);
    }).then((buf) => { assert.ok(buf.equals(FILE.slice(150000))); env.done(); return closeServer(server); });
});

test('openStream: the stream errors (never just ends) when the connection breaks', () => {
    const server = fileServer('cut');
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac', timeoutMs: 5000 });
    })).then((r) => expectCode(readAll(r.stream), 'offline'))
        .then(() => { env.done(); return closeServer(server); });
});

test('openStream: the stream errors when it stays idle past timeoutMs', () => {
    const server = fileServer('stall');
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac', timeoutMs: 400 });
    })).then((r) => expectCode(readAll(r.stream), 'offline', /idle|stalled/i))
        .then(() => { env.done(); return closeServer(server); });
});

test('openStream: a reader that pauses longer than timeoutMs is not an idle connection', () => {
    const server = fileServer();
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac', timeoutMs: 300 });
    })).then((r) => new Promise((resolve, reject) => {
        const chunks = [];
        let paused = false;
        r.stream.on('error', reject);
        r.stream.on('data', (d) => {
            chunks.push(d);
            if (!paused) { paused = true; r.stream.pause(); setTimeout(() => r.stream.resume(), 900); }
        });
        r.stream.on('end', () => resolve(Buffer.concat(chunks)));
    })).then((buf) => { assert.ok(buf.equals(FILE)); env.done(); return closeServer(server); });
});

test('openStream: destroying the stream ends the download', () => {
    const server = fileServer('stall');
    let env;
    let serverClosed = false;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return env.netx.openStream({ url: 'https://tidal.test:' + port + '/f.flac', timeoutMs: 5000 });
    })).then((r) => {
        server.conns[0].on('close', () => { serverClosed = true; });
        r.stream.on('error', () => {});
        r.stream.destroy();
        return new Promise((res) => setTimeout(res, 300));
    }).then(() => { assert.ok(serverClosed); env.done(); return closeServer(server); });
});

test('openStream: a server that never answers times out with offline', () => {
    const server = tlsServer(() => {});
    let env;
    return listen(server).then((port) => setup(['tidal.test']).then((e) => {
        env = e;
        return expectCode(env.netx.openStream({ url: 'https://tidal.test:' + port + '/', timeoutMs: 300 }), 'offline');
    })).then(() => { env.done(); return closeServer(server); });
});

run();
