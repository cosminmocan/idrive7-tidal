'use strict';
/**
 * C5: playback. A queue from the app's list; one player per track; the track's bytes from the (fake) TIDAL file
 * server through the client child to the player's stdin with backpressure; a broken download continued with an
 * HTTP Range from the byte it stopped at; an expired address asked for again once; next, prev, pause, resume, stop.
 * Runs the real client.js child, the fake player (which records what it received) and the fake TIDAL module.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService, until, alive } = require('./fakes/service_harness');
const { createFileServer, pattern, track } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const SESSION = JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });

/** a logged-in service whose tracks 1..n are served by `files`; tidal knobs in extra.tidal */
function setup(files, extra) {
    const x = extra || {};
    const tidal = Object.assign({
        library: { search: [track(1, 'One'), track(2, 'Two'), track(3, 'Three')] },
        streamUrl: (id, quality) => ({ url: files.url('t' + id), codec: 'flac', quality: quality }),
    }, x.tidal || {});
    return startService({ client: true, record: true, files: { 'session.json': SESSION }, tidal: tidal,
        service: Object.assign({ playerEnv: { FAKE_TICK_MS: '20', FAKE_SECONDS: x.seconds || '0.5' } }, x.service || {}) });
}
const st = (h) => h.status().then((s) => s.player);
const recorded = (h, id) => { try { return fs.readFileSync(path.join(h.dir, 'rec-' + id + '.bin')); } catch (e) { return null; } };
const livePlayers = (h) => h.pids.player.filter(alive);
function checkStatus(s) { assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), [], JSON.stringify(s)); }

test('the player receives the file byte for byte; status follows it to the end, then idle', async () => {
    const size = 2 * 1024 * 1024 + 3;
    const files = await createFileServer({ size: size });
    const h = await setup(files, { seconds: '5' });
    try {
        await h.req({ cmd: 'search', query: 'x' });   // the service learns the tracks' titles from the lists
        const a = await h.req({ id: 17, cmd: 'play', tracks: [1], index: 0 });
        assert.deepStrictEqual(a, { id: 17, ok: true });
        const seen = {};
        await until(() => h.status().then((s) => { checkStatus(s); seen[s.player.state] = s.player; return s.player.state === 'idle' && seen.playing; }), 8000, 'played, then idle');
        const p = seen.playing;
        assert.strictEqual(p.track.title, 'One');
        assert.strictEqual(p.queueIndex, 0); assert.strictEqual(p.queueLength, 1);
        assert.strictEqual(p.quality, 'LOSSLESS');
        assert.strictEqual(p.duration, 5);
        const got = recorded(h, 1);
        assert.ok(got && got.length === size, 'size ' + (got && got.length));
        assert.ok(got.equals(pattern(0, size)), 'byte for byte');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl')[0].args[1], 'LOSSLESS');
        assert.strictEqual(livePlayers(h).length, 0);
    } finally { await h.close(); await files.close(); }
});

test('with the connection cut three times mid-file the player still gets it byte for byte, in order, nothing twice', async () => {
    const size = 3 * 1024 * 1024;
    const files = await createFileServer({ size: size, cuts: [100000, 1200001, 2500017] });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await until(() => recorded(h, 1), 15000, 'the recording');
        const got = recorded(h, 1);
        assert.strictEqual(got.length, size);
        assert.ok(got.equals(pattern(0, size)), 'byte for byte');
        const ranges = files.requests.map((r) => r.range);
        assert.strictEqual(ranges.length, 4, JSON.stringify(files.requests));
        assert.strictEqual(ranges[0], null);
        let last = 0;
        ranges.slice(1).forEach((r) => { const n = Number(/^bytes=(\d+)-$/.exec(r)[1]); assert.ok(n > last && n <= size); last = n; });
    } finally { await h.close(); await files.close(); }
});

test('an expired stream address (403) is asked for again once', async () => {
    const files = await createFileServer({ size: 300000, expired: 1 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [2], index: 0 });
        await until(() => recorded(h, 2), 8000, 'the recording');
        assert.ok(recorded(h, 2).equals(pattern(0, 300000)));
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl').length, 2);
    } finally { await h.close(); await files.close(); }
});

test('an address refused twice gives an error, not a loop', async () => {
    const files = await createFileServer({ size: 300000, expired: 100 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [2], index: 0 });
        const p = await until(() => st(h).then((x) => x.state === 'error' && x), 8000, 'error');
        assert.strictEqual(p.error, 'tidal-error');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl').length, 2);
    } finally { await h.close(); await files.close(); }
});

test('the next track starts when the player ends; after the last one the state is idle', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1, 2, 3], index: 1 });
        await until(() => recorded(h, 3), 8000, 'the third track');
        const p = await until(() => st(h).then((x) => x.state === 'idle' && x), 8000, 'idle');
        assert.ok(!recorded(h, 1), 'the queue started at index 1');
        assert.ok(recorded(h, 2));
        assert.strictEqual(p.queueIndex, 2); assert.strictEqual(p.queueLength, 3);
        assert.strictEqual(p.error, null);
    } finally { await h.close(); await files.close(); }
});

test('next at the end and prev at the start are harmless', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { seconds: '100' });
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 1 });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        assert.strictEqual((await h.req({ cmd: 'next' })).ok, true);
        let p = await st(h);
        assert.strictEqual(p.queueIndex, 1); assert.notStrictEqual(p.state, 'error');
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 0), 8000, 'playing 1');
        assert.strictEqual((await h.req({ cmd: 'prev' })).ok, true);
        p = await until(() => st(h).then((x) => x.state === 'playing' && x), 8000, 'playing again');
        assert.strictEqual(p.queueIndex, 0);
        await until(() => livePlayers(h).length === 1, 5000, 'one player');
    } finally { await h.close(); await files.close(); }
});

test('prev after 3 s restarts the track; before, it goes back one', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { seconds: '100' });
    try {
        await h.req({ cmd: 'play', tracks: [1, 2, 3], index: 1 });
        await until(() => st(h).then((x) => x.position > 3), 8000, 'past 3 s');   // 0.5 s per 20 ms tick
        await h.req({ cmd: 'prev' });
        let p = await until(() => st(h).then((x) => x.state === 'playing' && x.position < 3 && x), 8000, 'restarted');
        assert.strictEqual(p.queueIndex, 1);
        await h.req({ cmd: 'prev' });
        p = await until(() => st(h).then((x) => x.queueIndex === 0 && x.state === 'playing' && x), 8000, 'back one');
        assert.strictEqual(p.queueIndex, 0);
    } finally { await h.close(); await files.close(); }
});

test('a track that is not available is skipped, and the skip is reported', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { tidal: { streamUrl: (id, q) => (id === 1 ? { error: 'not-available' } : { url: files.url('t' + id), codec: 'flac', quality: 'HIGH' }) } });
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await until(() => recorded(h, 2), 8000, 'the second track');
        const p = await until(() => st(h).then((x) => x.state === 'idle' && x), 8000, 'idle');
        assert.deepStrictEqual(p.skipped, [{ id: 1, error: 'not-available' }]);
        assert.ok(!recorded(h, 1));
    } finally { await h.close(); await files.close(); }
});

test('ten next commands in one second end with exactly one player running', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { seconds: '100' });
    try {
        const ids = []; for (let i = 1; i <= 12; i++) ids.push(i);
        await h.req({ cmd: 'play', tracks: ids, index: 0 });
        for (let i = 0; i < 10; i++) { await h.req({ id: 20 + i, cmd: 'next' }); await h.sleep(60); }
        const p = await until(() => st(h).then((x) => x.state === 'playing' && x), 10000, 'playing');
        assert.strictEqual(p.queueIndex, 10);
        await h.sleep(1500);
        assert.strictEqual(livePlayers(h).length, 1, 'players alive: ' + livePlayers(h).length);
        assert.strictEqual((await st(h)).queueIndex, 10);
    } finally { await h.close(); await files.close(); }
});

test('pause, resume and stop; stop keeps the queue', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { seconds: '100' });
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        await h.req({ cmd: 'pause' });
        const p1 = await until(() => st(h).then((x) => x.state === 'paused' && x), 3000, 'paused');
        await h.sleep(200);
        const p2 = await st(h);
        assert.strictEqual(p2.state, 'paused');
        assert.ok(p2.position - p1.position <= 0.5, 'the position stands still');
        await h.req({ cmd: 'resume' });
        await until(() => st(h).then((x) => x.state === 'playing' && x.position > p2.position), 3000, 'playing again');
        await h.req({ cmd: 'stop' });
        const p = await until(() => st(h).then((x) => x.state === 'idle' && x), 3000, 'idle');
        assert.strictEqual(p.queueLength, 2); assert.strictEqual(p.queueIndex, 0);
        await until(() => livePlayers(h).length === 0, 5000, 'no player');
        await h.req({ cmd: 'resume' });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'resume after stop plays the queue again');
    } finally { await h.close(); await files.close(); }
});

test('a download broken for longer than the outage time ends in offline', async () => {
    const files = await createFileServer({ size: 1000000, cuts: [200000], status: (req) => (req.headers.range ? 503 : null) });
    const h = await setup(files, { service: { outageMs: 800 } });
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        const p = await until(() => st(h).then((x) => x.state === 'error' && x), 8000, 'error');
        assert.strictEqual(p.error, 'offline');
        assert.ok(files.requests.length >= 3, 'tried again: ' + files.requests.length);
        await until(() => livePlayers(h).length === 0, 5000, 'no player');
    } finally { await h.close(); await files.close(); }
});

test('the bytes wait for a player that does not read (backpressure to the server)', async () => {
    const files = await createFileServer({ size: 64 * 1024 * 1024 });
    const h = await setup(files, { service: { playerArgs: ['-e', 'process.stdin.pause(); setInterval(() => {}, 1000)'] } });
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await until(() => files.served > 0, 5000, 'the download');
        await h.sleep(1500);
        assert.ok(files.served < 24 * 1024 * 1024, 'served ' + files.served);
    } finally { await h.close(); await files.close(); }
});

test('quality comes from the prefs; play needs a login', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'prefs', quality: 'HIGH' });
        await h.req({ cmd: 'play', tracks: [3], index: 0 });
        await until(() => recorded(h, 3), 8000, 'played');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl')[0].args[1], 'HIGH');
        await h.req({ cmd: 'logout' });
        const a = await h.req({ cmd: 'play', tracks: [3], index: 0 });
        assert.strictEqual(a.error, 'not-logged-in');
    } finally { await h.close(); await files.close(); }
});

test('the service ends the player and the client before it exits', async () => {
    const files = await createFileServer({ size: 50000 });
    let atExit = null;
    const h = await setup(files, { seconds: '100', service: { exit: (code) => { atExit = h.pids.player.concat(h.pids.client).filter(alive); } } });
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        await h.req({ cmd: 'exit' });
        await until(() => atExit, 8000, 'exit');
        assert.deepStrictEqual(atExit, [], 'no child alive when exit is called');
    } finally { await h.close(); await files.close(); }
});

run();
