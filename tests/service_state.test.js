'use strict';
/**
 * C7: the state on disk (docs/PROTOCOL.md section 3). Preferences and the queue survive a restart; every write is
 * whole (a process killed while writing leaves the old or the new file, never half of one); a file with an unknown
 * version is ignored and replaced; nothing is written outside the state folder given at start (rule R6).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService, until, ROOT } = require('./fakes/service_harness');
const { createFileServer, rmrf } = require('./fakes/fake_tidal_module');

const STATE_JS = path.join(ROOT, 'native', 'cmocan-tidal', 'state.js');
const { createState } = require(STATE_JS);

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const SESSION = JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('preferences and the queue survive a restart', async () => {
    const files = await createFileServer({ size: 50000 });
    const tidal = { streamUrl: (id, q) => ({ url: files.url('t' + id), codec: 'flac', quality: q }) };
    const h1 = await startService({ client: true, files: { 'session.json': SESSION }, tidal: tidal,
        service: { playerEnv: { FAKE_TICK_MS: '20', FAKE_SECONDS: '100' } } });
    let saved;
    try {
        await h1.req({ cmd: 'prefs', quality: 'LOSSLESS' });   // not the default, so it must come from the file
        await h1.req({ cmd: 'play', tracks: [5, 6, 7], index: 1 });
        await until(() => h1.status().then((s) => s.player.state === 'playing' && s.player.position >= 2), 8000, 'playing');
        await h1.req({ cmd: 'pause' });
        saved = {};
        ['prefs.json', 'queue.json', 'session.json'].forEach((n) => { saved[n] = fs.readFileSync(path.join(h1.stateDir, n), 'utf8'); });
    } finally { await h1.close(); await files.close(); }
    assert.deepStrictEqual(P.validateState('prefs', JSON.parse(saved['prefs.json'])), []);
    const q = JSON.parse(saved['queue.json']);
    assert.deepStrictEqual(P.validateState('queue', q), []);
    assert.deepStrictEqual(q.tracks, [5, 6, 7]); assert.strictEqual(q.index, 1);
    assert.ok(q.position >= 2, 'the position at the pause: ' + q.position);
    const h2 = await startService({ files: saved });
    try {
        const s = await h2.status();
        assert.strictEqual(s.prefs.quality, 'LOSSLESS');
        assert.strictEqual(s.player.queueIndex, 1); assert.strictEqual(s.player.queueLength, 3);
        assert.strictEqual(s.player.state, 'idle', 'nothing plays by itself after a restart');
    } finally { await h2.close(); }
});

test('a file with an unknown version, or broken, is ignored and replaced', async () => {
    const h = await startService({ files: { 'prefs.json': JSON.stringify({ version: 2, quality: 'LOSSLESS' }), 'queue.json': '{"version":1,"tracks":[1,2' } });
    try {
        const s = await h.status();
        assert.strictEqual(s.prefs.quality, 'HIGH', 'the default');
        assert.strictEqual(s.player.queueIndex, -1); assert.strictEqual(s.player.queueLength, 0);
        const prefs = readJson(path.join(h.stateDir, 'prefs.json'));
        const queue = readJson(path.join(h.stateDir, 'queue.json'));
        assert.deepStrictEqual(prefs, { version: 1, quality: 'HIGH' });
        assert.deepStrictEqual(P.validateState('queue', queue), []);
        assert.deepStrictEqual(queue.tracks, []);
    } finally { await h.close(); }
});

test('a queue whose index is out of its list is ignored', async () => {
    const h = await startService({ files: { 'queue.json': JSON.stringify({ version: 1, tracks: [1, 2], index: 5, position: 0 }) } });
    try { assert.strictEqual((await h.status()).player.queueLength, 0); } finally { await h.close(); }
});

test('every write is whole: a process killed while writing a hundred times leaves the old or the new file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-state-'));
    try {
        // a writer that alternates two large versions of queue.json as fast as it can
        const writer = 'const s = require(' + JSON.stringify(STATE_JS) + ').createState(process.argv[1]);' +
            'const a = []; for (let i = 1; i <= 1000; i++) a.push(1000000 + i);' +
            'let n = 0; s.write("queue", { tracks: a, index: 0, position: 0 }); process.stdout.write("ready\\n");' +
            'for (;;) { n++; s.write("queue", { tracks: n % 2 ? a.slice().reverse() : a, index: n % 1000, position: n }); }';
        const st = createState(dir);
        let kills = 0, whole = 0;
        for (let round = 0; round < 100; round++) {
            const c = childProcess.spawn(process.execPath, ['-e', writer, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
            await new Promise((resolve) => c.stdout.once('data', resolve));
            await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15)));
            c.kill('SIGKILL');
            await new Promise((resolve) => c.once('exit', resolve));
            kills++;
            const q = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));   // throws when half written
            assert.deepStrictEqual(P.validateState('queue', q), []);
            assert.strictEqual(q.tracks.length, 1000);
            assert.ok(st.read('queue'), 'readable by state.js');
            whole++;
        }
        assert.strictEqual(kills, 100); assert.strictEqual(whole, 100);
        // a left temporary file does not stop the next write
        st.write('queue', { tracks: [1], index: 0, position: 0 });
        assert.deepStrictEqual(st.read('queue').tracks, [1]);
    } finally { rmrf(dir); }
}, { timeout: 240000 });

/* ---------- rule R6 ---------- */

function snapshot(dirs) {
    const out = {};
    dirs.forEach((d) => {
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.forEach((n) => {
            const p = path.join(d, n);
            try { const s = fs.lstatSync(p); out[p] = s.isDirectory() ? 'dir' : s.size + ':' + s.mtime.getTime(); } catch (e) { /* went */ }
        });
    });
    return out;
}
function walk(d, out) {
    fs.readdirSync(d).forEach((n) => { const p = path.join(d, n); out.push(p); if (fs.lstatSync(p).isDirectory()) walk(p, out); });
    return out;
}

test('nothing is written outside the state folder (rule R6)', async () => {
    const watched = [os.tmpdir(), '/run', '/var/opt', '/dev/shm', '/var/tmp', process.env.HOME || '/root', ROOT, path.join(ROOT, 'native', 'cmocan-tidal')];
    const before = snapshot(watched);
    const files = await createFileServer({ size: 50000 });
    const COVER = '24f52ab0-e7d6-414d-a650-20a4c686aa57';
    const h = await startService({ client: true, tidal: { login: ['authorized'], covers: { [COVER]: Buffer.from([0xff, 0xd8, 1]) },
        library: { search: [] }, streamUrl: (id, q) => ({ url: files.url('t' + id), codec: 'flac', quality: q }) } });
    let inside;
    try {
        await h.req({ cmd: 'login-start' });
        await until(() => h.status().then((s) => s.login === 'logged-in'), 5000, 'logged-in');
        await h.req({ cmd: 'prefs', quality: 'LOSSLESS' });
        await h.req({ cmd: 'search', query: 'x' });
        await h.req({ cmd: 'cover', coverId: COVER });
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await until(() => h.status().then((s) => s.player.state === 'idle' && s.player.queueIndex === 1), 10000, 'played');
        inside = walk(h.dir, []).map((p) => path.relative(h.dir, p)).sort();
        const mode = (p) => fs.statSync(path.join(h.dir, p)).mode & 0o777;
        assert.strictEqual(mode('state'), 0o700);
        inside.filter((p) => /^state\/[^/]+\.json$/.test(p)).forEach((p) => assert.strictEqual(mode(p), 0o600, p));
    } finally { await h.close(); await files.close(); }
    // inside the test's folder: the harness's own lease and socket, and the state folder
    inside.forEach((p) => assert.ok(p === 'lease.json' || p === 'c.sock' || p === 'state' || /^state\//.test(p), 'written outside the state folder: ' + p));
    const after = snapshot(watched);
    const changed = Object.keys(after).filter((p) => before[p] !== after[p] && p !== h.dir && p.indexOf('cmocan-svc-') < 0);
    const gone = Object.keys(before).filter((p) => after[p] === undefined && p.indexOf('cmocan-svc-') < 0);
    assert.deepStrictEqual(changed, [], 'new or changed outside: ' + changed.join(', '));
    assert.deepStrictEqual(gone, []);
});

run();
