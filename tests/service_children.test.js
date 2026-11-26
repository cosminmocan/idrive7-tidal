'use strict';
/**
 * C2: the children and their users. client.js (every TIDAL request and the track's bytes) runs as the tool's
 * internet uid, never root; the player is started by player.js with MGU_RUN_AS, MGU_GROUPS and MGU_AUDIO (it drops
 * root itself). A child that dies is reported and started again a limited number of times; the service ends its
 * children before it ends.
 */
const assert = require('assert');
const path = require('path');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService, until, alive, FAKE_PLAYER, ROOT } = require('./fakes/service_harness');
const { createFileServer, pattern } = require('./fakes/fake_tidal_module');

const { createPlayerProcess, AUDIO, RUN_AS, GROUPS } = require(path.join(ROOT, 'native', 'cmocan-tidal', 'player.js'));

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

function readAll(stream) {
    return new Promise((resolve, reject) => {
        const parts = [];
        stream.on('data', (d) => parts.push(d));
        stream.on('end', () => resolve(Buffer.concat(parts)));
        stream.on('error', reject);
    });
}

/* ---------- the client ---------- */

test('the client is forked as the configured uid and gid, with the lease path', async () => {
    const seen = [];
    const mine = [];
    const h = await startService({ client: true, service: { uid: 13150,
        // record what the service asks for, then fork as this user (the tests are not root on every machine)
        forkClient: (file, args, fo) => { seen.push({ file: file, opts: fo }); const f = Object.assign({}, fo); delete f.uid; delete f.gid;
            const c = childProcess.fork(file, args, f); mine.push(c.pid); return c; } } });
    try {
        await until(() => seen.length === 1, 3000, 'the fork');
        assert.strictEqual(path.basename(seen[0].file), 'client.js');
        assert.strictEqual(seen[0].opts.uid, 13150);
        assert.strictEqual(seen[0].opts.gid, 13150);
        assert.strictEqual(seen[0].opts.env.CMOCAN_LEASE, h.leasePath);
        assert.ok(seen[0].opts.stdio.indexOf('ipc') >= 0, 'an IPC channel');
        await until(() => h.status().then((s) => s.children && s.children.client.running), 5000, 'the client running');
    } finally { await h.close(); }
    await until(() => mine.every((p) => !alive(p)), 5000, 'the client to end');
});

test('the client is never started as root', async () => {
    const seen = [];
    const h = await startService({ client: true, service: { uid: 0, forkClient: (f, a, fo) => { seen.push(fo); return null; } } });
    try {
        await h.sleep(300);
        assert.strictEqual(seen.length, 0, 'not forked');
        const s = await h.status();
        assert.strictEqual(s.children.client.running, false);
        assert.ok(/root/.test(s.children.client.error), JSON.stringify(s.children));
        await h.svc.netx.request({ url: 'http://127.0.0.1:9/' }).then(() => assert.fail('no client'), (e) => assert.strictEqual(e.code, 'offline'));
    } finally { await h.close(); }
});

test('bytes and answers come through the client child: requests, and a stream byte for byte', async () => {
    const files = await createFileServer({ size: 3 * 1024 * 1024 + 17 });
    const h = await startService({ client: true });
    try {
        const n = h.svc.netx;
        const r = await n.request({ url: files.url('x'), headers: { Range: 'bytes=0-' } });
        assert.strictEqual(r.status, 206);
        assert.ok(Buffer.isBuffer(r.body)); assert.strictEqual(r.body.length, 3 * 1024 * 1024 + 17);
        const s = await n.openStream({ url: files.url('y') });
        assert.strictEqual(s.status, 200);
        const got = await readAll(s.stream);
        assert.ok(got.equals(pattern(0, 3 * 1024 * 1024 + 17)), 'byte for byte');
        h.online(false);
        await n.request({ url: files.url('z') }).then(() => assert.fail('no lease'), (e) => assert.strictEqual(e.code, 'offline'));
    } finally { await h.close(); await files.close(); }
});

test('a stream read slowly holds the download back (backpressure through the client)', async () => {
    const size = 64 * 1024 * 1024;
    const files = await createFileServer({ size: size });
    const h = await startService({ client: true });
    try {
        const s = await h.svc.netx.openStream({ url: files.url() });
        s.stream.pause();
        await h.sleep(1500);
        assert.ok(files.served < 24 * 1024 * 1024, 'served ' + files.served + ' bytes while nobody read');
        s.stream.destroy();
    } finally { await h.close(); await files.close(); }
});

test('a client that dies is reported in status and started again', async () => {
    const h = await startService({ client: true, service: { restarts: { max: 3, windowMs: 60000, delayMs: 50 } } });
    try {
        await until(() => h.pids.client.length === 1 && h.status().then((s) => s.children.client.running), 5000, 'the client');
        const first = h.pids.client[0];
        process.kill(first, 'SIGKILL');
        await until(() => h.status().then((s) => !s.children.client.running || h.pids.client.length > 1), 3000, 'the death seen');
        await until(() => h.pids.client.length === 2, 3000, 'a second client');
        const s = await until(() => h.status().then((x) => x.children.client.running && x), 5000, 'it runs again');
        assert.strictEqual(s.children.client.restarts, 1);
        assert.ok(/SIGKILL/.test(s.children.client.lastExit), JSON.stringify(s.children.client));
        assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), []);
        assert.ok(!alive(first));
    } finally { await h.close(); }
});

test('a client that keeps dying is started again at most N times in M minutes', async () => {
    const h = await startService({ client: true, service: { restarts: { max: 3, windowMs: 60000, delayMs: 20 },
        clientEnv: { CMOCAN_NETX: '/nonexistent/netx.js' } } });
    try {
        await until(() => h.status().then((s) => s.children.client.gaveUp), 8000, 'the service to give up');
        await h.sleep(300);
        assert.strictEqual(h.pids.client.length, 4, 'the first start and 3 more');
        const s = await h.status();
        assert.strictEqual(s.children.client.running, false);
        assert.strictEqual(s.children.client.restarts, 3);
    } finally { await h.close(); }
});

test('the service ends the client before it exits', async () => {
    let atExit = null;
    const h = await startService({ client: true, service: { exit: (code) => { atExit = { code: code, alive: h.pids.client.map(alive) }; } } });
    try {
        await until(() => h.status().then((s) => s.children.client.running), 5000, 'the client');
        await h.req({ cmd: 'exit' });
        await until(() => atExit, 5000, 'exit');
        assert.deepStrictEqual(atExit, { code: 0, alive: [false] }, 'the client is gone when exit is called');
    } finally { await h.close(); }
});

/* ---------- the player process (player.js) ---------- */

function spawnRec(rec) { return (bin, args, so) => { const c = childProcess.spawn(bin, args, so); rec.push({ bin: bin, args: args, opts: so, pid: c.pid }); return c; }; }

test('the player is started with MGU_RUN_AS, MGU_GROUPS and MGU_AUDIO, fd 3 for commands', async () => {
    const rec = [];
    const events = [];
    const p = createPlayerProcess({ spawn: spawnRec(rec), bin: process.execPath, args: [FAKE_PLAYER], env: { FAKE_TICK_MS: '20', FAKE_SECONDS: '0.5' },
        onEvent: (ev) => events.push(ev) });
    p.stdin.end(pattern(0, 1000));
    const ex = await p.exited;
    assert.strictEqual(rec.length, 1);
    const env = rec[0].opts.env;
    assert.strictEqual(env.MGU_RUN_AS, 'nobody'); assert.strictEqual(RUN_AS, 'nobody');
    assert.strictEqual(env.MGU_GROUPS, 'mgu_alsa,audio'); assert.strictEqual(GROUPS, 'mgu_alsa,audio');
    assert.strictEqual(env.MGU_AUDIO, 'alsa:plug:smartx:CarLifeMedia_CF_48_STEREO'); assert.strictEqual(AUDIO, env.MGU_AUDIO);
    assert.strictEqual(rec[0].opts.stdio.length, 4);
    assert.strictEqual(ex.code, 0);
    assert.deepStrictEqual(events.map((e) => e.ev).filter((e, i, a) => a.indexOf(e) === i), ['open', 'audio', 'tick', 'end']);
    events.forEach((e) => assert.deepStrictEqual(P.validatePlayerEvent(e), [], JSON.stringify(e)));
});

test('pause and resume go to the player on fd 3; kill ends it within 3 s', async () => {
    const events = [];
    const p = createPlayerProcess({ spawn: childProcess.spawn, bin: process.execPath, args: [FAKE_PLAYER], env: { FAKE_TICK_MS: '20', FAKE_SECONDS: '100' },
        audio: 'null', onEvent: (ev) => events.push(ev) });
    p.stdin.end(pattern(0, 1000));
    await until(() => events.some((e) => e.ev === 'tick' && e.state === 'playing'), 3000, 'playing');
    p.ctl('pause');
    await until(() => events.length && events[events.length - 1].state === 'paused', 3000, 'paused');
    p.ctl('resume');
    await until(() => events.length && events[events.length - 1].state === 'playing', 3000, 'playing again');
    const t0 = Date.now();
    await p.kill();
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(!alive(p.pid));
});

test('a player that will not quit is killed', async () => {
    const p = createPlayerProcess({ spawn: childProcess.spawn, bin: process.execPath,
        args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], quitMs: 100, killMs: 300 });
    await new Promise((r) => setTimeout(r, 200));
    const ex = await p.kill();
    assert.strictEqual(ex.signal, 'SIGKILL');
    assert.ok(!alive(p.pid));
});

test('a player that cannot start is reported, not thrown', async () => {
    const events = [];
    const p = createPlayerProcess({ spawn: childProcess.spawn, bin: '/nonexistent/tidal-player', onEvent: (e) => events.push(e) });
    const ex = await p.exited;
    assert.ok(ex.error, JSON.stringify(ex));
    p.stdin.write(Buffer.from('x'));   // no throw
    p.ctl('pause');
    await p.kill();
});

run();
