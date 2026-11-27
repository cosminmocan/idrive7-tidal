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
// the fake player writes its recording once it has all its input: wait for the whole file, not the first bytes of it
const recordedAll = (h, id, size) => { const b = recorded(h, id); return b && b.length >= size ? b : null; };
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
        assert.strictEqual(p.quality, 'HIGH', 'the default');
        assert.strictEqual(p.duration, 5);
        const got = recorded(h, 1);
        assert.ok(got && got.length === size, 'size ' + (got && got.length));
        assert.ok(got.equals(pattern(0, size)), 'byte for byte');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl')[0].args[1], 'HIGH');
        assert.strictEqual(livePlayers(h).length, 0);
    } finally { await h.close(); await files.close(); }
});

test('with the connection cut three times mid-file the player still gets it byte for byte, in order, nothing twice', async () => {
    const size = 3 * 1024 * 1024;
    const files = await createFileServer({ size: size, cuts: [100000, 1200001, 2500017] });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        const got = await until(() => recordedAll(h, 1, size), 15000, 'the recording');
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
        const got = await until(() => recordedAll(h, 2, 300000), 8000, 'the recording');
        assert.ok(got.equals(pattern(0, 300000)));
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
        await h.req({ cmd: 'prefs', quality: 'LOSSLESS' });
        await h.req({ cmd: 'play', tracks: [3], index: 0 });
        await until(() => recorded(h, 3), 8000, 'played');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl')[0].args[1], 'LOSSLESS');
        await h.req({ cmd: 'logout' });
        const a = await h.req({ cmd: 'play', tracks: [3], index: 0 });
        assert.strictEqual(a.error, 'not-logged-in');
    } finally { await h.close(); await files.close(); }
});

/* ---------- the track playing, when the service has not seen it in a list ---------- */

test('after a restart the track playing is looked up by id (tidal.track) for status; status does not wait for it', async () => {
    const files = await createFileServer({ size: 50000 });
    const queue = JSON.stringify({ version: 1, tracks: [7, 8], index: 0, position: 0 });
    const h = await startService({ client: true, files: { 'session.json': SESSION, 'queue.json': queue },
        tidal: { library: { tracks: { 7: track(7, 'Seven') } }, trackDelayMs: 800, streamUrl: (id, q) => ({ url: files.url('t' + id), codec: 'flac', quality: q }) },
        service: { playerEnv: { FAKE_TICK_MS: '20', FAKE_SECONDS: '100' } } });
    try {
        await h.req({ cmd: 'resume' });
        const t0 = Date.now();
        const first = await h.status();
        assert.ok(Date.now() - t0 < 500, 'status answered in ' + (Date.now() - t0) + ' ms');
        checkStatus(first);
        assert.strictEqual(first.player.track, null, 'not known yet');
        const s = await until(() => h.status().then((x) => { checkStatus(x); return x.player.track && x; }), 5000, 'the track known');
        assert.strictEqual(s.player.track.id, 7); assert.strictEqual(s.player.track.title, 'Seven');
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'track').map((c) => c.args), [[7]], 'asked once');
    } finally { await h.close(); await files.close(); }
});

test('play with ids the service never saw in a list: looked up too; one TIDAL does not have stays null and is asked once', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { seconds: '100', tidal: { library: { tracks: { 21: track(21, 'Twenty-one') } } } });
    try {
        await h.req({ cmd: 'play', tracks: [22, 21], index: 0 });
        await until(() => h.cfg.calls.some((c) => c.method === 'track'), 3000, 'the lookup');
        for (let i = 0; i < 10; i++) { const x = await h.status(); checkStatus(x); assert.strictEqual(x.player.track, null); await h.sleep(30); }
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'track').length, 1, 'not asked again and again');
        await h.req({ cmd: 'next' });
        const s = await until(() => h.status().then((x) => x.player.track && x), 5000, 'the second track known');
        assert.strictEqual(s.player.track.title, 'Twenty-one');
        assert.strictEqual(s.player.queueIndex, 1);
    } finally { await h.close(); await files.close(); }
});

/* ---------- seek (contract 3): a new player for the same track with MGU_START_MS, the download from the first byte ---------- */

/**
 * a logged-in service playing 1000 s tracks (the fake player: 0.5 s every 20 ms); each player writes the environment
 * it got to <dir>/env-<n>.json once it has its whole input (FAKE_ENV), n counting the players from 1
 */
function setupSeek(files, extra) {
    const x = extra || {};
    let h = null, n = 0;
    return startService({ client: true, files: { 'session.json': SESSION },
        tidal: { library: { search: [track(1, 'One'), track(2, 'Two'), track(3, 'Three')] },
            streamUrl: (id, quality) => ({ url: files.url('t' + id), codec: 'flac', quality: quality }) },
        service: { playerEnv: () => ({ FAKE_TICK_MS: '20', FAKE_SECONDS: x.seconds || '1000', FAKE_ENV: path.join(h.dir, 'env-' + (++n) + '.json') }) },
    }).then((s) => { h = s; return h; });
}
const playerEnv = (h, n) => { try { return JSON.parse(fs.readFileSync(path.join(h.dir, 'env-' + n + '.json'), 'utf8')); } catch (e) { return null; } };
const playingAt = (h, min, max, ms) => until(() => st(h).then((x) => x.state === 'playing' && x.position >= min && x.position < max && x), ms || 8000, 'playing between ' + min + ' and ' + max);
const seekReq = (h, position, id) => {
    const r = { id: id || 1, cmd: 'seek', position: position };
    assert.deepStrictEqual(P.validateRequest(r), [], 'a valid request');
    return h.req(r);
};

test('seek forward: answered at once; the position continues from there; a new player with MGU_START_MS, fed from the first byte', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'search', query: 'x' });
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await playingAt(h, 0, 250);
        const a = await seekReq(h, 300, 25);
        assert.deepStrictEqual(a, { id: 25, ok: true });
        // at once: the position asked for, loading until the new player plays
        const s0 = await h.status();
        checkStatus(s0);
        assert.strictEqual(s0.player.position, 300);
        assert.strictEqual(s0.player.state, 'loading');
        assert.strictEqual(s0.player.queueIndex, 0); assert.strictEqual(s0.player.track.id, 1);
        // from then on never before the position, in any state
        let p = null;
        await until(() => h.status().then((s) => { checkStatus(s); p = s.player; assert(p.position >= 300, 'position ' + p.position + ' while ' + p.state); return p.state === 'playing' && p.position > 300; }), 8000, 'playing past 300');
        assert.strictEqual(p.queueIndex, 0); assert.strictEqual(p.track.id, 1); assert.strictEqual(p.duration, 1000);
        assert(p.position < 600, 'position ' + p.position);
        assert.strictEqual(h.pids.player.length, 2, 'a new player');
        await until(() => livePlayers(h).length === 1, 5000, 'one player');
        assert.strictEqual(livePlayers(h)[0], h.pids.player[1], 'the new one');
        assert.deepStrictEqual(playerEnv(h, 1), { MGU_START_MS: null }, 'play: no start position');
        assert.deepStrictEqual(playerEnv(h, 2), { MGU_START_MS: '300000' });
        // the download: the whole file again, from its first byte
        assert.deepStrictEqual(files.requests.map((r) => r.range), [null, null]);
    } finally { await h.close(); await files.close(); }
});

test('seek back; a position with a fraction is passed in whole milliseconds', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playingAt(h, 0, 250);
        await seekReq(h, 600);
        await playingAt(h, 600, 900);
        assert.strictEqual((await seekReq(h, 12.3456)).ok, true);
        let p = null;
        // no late tick of the player left behind pulls the position back to 600
        await until(() => st(h).then((x) => { p = x; assert(x.position >= 12.3 && x.position < 500, 'position ' + x.position + ' while ' + x.state); return x.state === 'playing' && x.position > 13; }), 8000, 'playing from 12.3');
        for (let i = 0; i < 10; i++) { p = await st(h); assert(p.position < 500, 'position ' + p.position); await h.sleep(20); }
        assert.deepStrictEqual(playerEnv(h, 3), { MGU_START_MS: '12346' });
        await until(() => livePlayers(h).length === 1, 5000, 'one player');
        assert.strictEqual(h.pids.player.length, 3);
    } finally { await h.close(); await files.close(); }
});

test('seek while paused stays paused at the new position; resume plays from there', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playingAt(h, 0, 250);
        await h.req({ cmd: 'pause' });
        await until(() => st(h).then((x) => x.state === 'paused'), 3000, 'paused');
        assert.strictEqual((await seekReq(h, 400)).ok, true);
        await until(() => playerEnv(h, 2), 5000, 'the new player has its input');
        // never playing, and the position stands at 400
        for (let i = 0; i < 15; i++) {
            const s = await h.status();
            checkStatus(s);
            assert.notStrictEqual(s.player.state, 'playing', 'playing after a seek while paused');
            assert.strictEqual(s.player.position, 400);
            await h.sleep(30);
        }
        assert.strictEqual((await st(h)).state, 'paused');
        assert.deepStrictEqual(playerEnv(h, 2), { MGU_START_MS: '400000' });
        await h.req({ cmd: 'resume' });
        const p = await playingAt(h, 400.5, 700);
        assert.strictEqual(p.queueIndex, 0);
        await until(() => livePlayers(h).length === 1, 5000, 'one player');
    } finally { await h.close(); await files.close(); }
});

test('five seeks in quick succession end with exactly one player, at the last position', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await playingAt(h, 0, 250);
        const answers = await Promise.all([100, 200, 300, 400].map((s, i) => seekReq(h, s, 30 + i)));
        answers.forEach((a) => assert.strictEqual(a.ok, true));
        await h.sleep(60);
        await seekReq(h, 700);
        const p = await playingAt(h, 700, 950, 10000);
        assert.strictEqual(p.queueIndex, 0);
        await h.sleep(1500);
        assert.strictEqual(livePlayers(h).length, 1, 'players alive: ' + livePlayers(h).length);
        const q = await st(h);
        assert.strictEqual(q.queueIndex, 0);
        assert(q.position >= 700, 'position ' + q.position);
        const last = h.pids.player.length;
        assert.deepStrictEqual(playerEnv(h, last), { MGU_START_MS: '700000' }, 'the player left is the last seek\'s');
    } finally { await h.close(); await files.close(); }
});

test('seek right after play, before the first player is there: one player, from the position', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        const a = await h.ask([{ id: 1, cmd: 'play', tracks: [2, 1], index: 0 }, { id: 2, cmd: 'seek', position: 150 }]);
        assert.deepStrictEqual(a.map((x) => x.ok), [true, true]);
        const p = await playingAt(h, 150, 600);
        assert.strictEqual(p.queueIndex, 0);
        await h.sleep(500);
        assert.strictEqual(livePlayers(h).length, 1);
        assert.deepStrictEqual(playerEnv(h, h.pids.player.length), { MGU_START_MS: '150000' });
    } finally { await h.close(); await files.close(); }
});

test('seek to the end or past it goes to the next track; on the last track playback ends', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 0 });
        await playingAt(h, 0, 250);
        assert.strictEqual((await seekReq(h, 1000)).ok, true, 'at the end');
        let p = await until(() => st(h).then((x) => x.queueIndex === 1 && x.state === 'playing' && x), 8000, 'the next track');
        assert(p.position < 500, 'from its start: ' + p.position);
        assert.strictEqual((await seekReq(h, 1e9)).ok, true, 'far past the end');
        p = await until(() => st(h).then((x) => x.state === 'idle' && x), 8000, 'idle');
        assert.strictEqual(p.queueIndex, 1); assert.strictEqual(p.error, null);
        await until(() => livePlayers(h).length === 0, 5000, 'no player');
    } finally { await h.close(); await files.close(); }
});

test('seek past the end of a track whose length the service does not know yet: the player says end, the next track plays', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files, { seconds: '50' });
    try {
        // ids no list showed and TIDAL does not know: no duration before the player's open
        const a = await h.ask([{ id: 1, cmd: 'play', tracks: [31, 32], index: 0 }, { id: 2, cmd: 'seek', position: 4000 }]);
        assert.deepStrictEqual(a.map((x) => x.ok), [true, true]);
        const p = await until(() => st(h).then((x) => x.queueIndex === 1 && x.state === 'playing' && x), 8000, 'the next track');
        assert(p.position < 50, 'position ' + p.position);
        assert.deepStrictEqual(playerEnv(h, 1), { MGU_START_MS: '4000000' });
    } finally { await h.close(); await files.close(); }
});

test('seek with a bad position is refused and changes nothing', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playingAt(h, 0, 250);
        const bad = [{ cmd: 'seek' }, { cmd: 'seek', position: -1 }, { cmd: 'seek', position: -0.001 }, { cmd: 'seek', position: '30' }, { cmd: 'seek', position: null },
            { cmd: 'seek', position: true }, { cmd: 'seek', position: [30] }, { cmd: 'seek', position: { s: 30 } }];
        for (let i = 0; i < bad.length; i++) {
            const r = Object.assign({ id: 40 + i }, bad[i]);
            assert.notDeepStrictEqual(P.validateRequest(r), [], 'the contract refuses ' + JSON.stringify(r));
            assert.deepStrictEqual(await h.req(r), { id: 40 + i, ok: false, error: 'bad-request' }, JSON.stringify(r));
        }
        // a number JSON cannot say (1e999 is read as Infinity)
        assert.deepStrictEqual((await h.ask(['{"id":50,"cmd":"seek","position":1e999}']))[0], { id: 50, ok: false, error: 'bad-request' });
        const p = await st(h);
        assert.strictEqual(p.state, 'playing');
        assert.strictEqual(h.pids.player.length, 1, 'the same player');
        assert.strictEqual(livePlayers(h).length, 1);
    } finally { await h.close(); await files.close(); }
});

test('seek with nothing playing is bad-request: no queue, stopped, after the last track, after an error', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files, { seconds: '2' });
    try {
        const no = { id: 1, ok: false, error: 'bad-request' };
        assert.deepStrictEqual(await seekReq(h, 10), no, 'no queue');
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        await h.req({ cmd: 'stop' });
        assert.deepStrictEqual(await seekReq(h, 1), no, 'stopped');
        await h.req({ cmd: 'resume' });
        await until(() => st(h).then((x) => x.state === 'idle' && h.pids.player.length === 2), 8000, 'played to its end');
        assert.deepStrictEqual(await seekReq(h, 1), no, 'after the last track');
        h.cfg.streamUrl = () => ({ error: 'tidal-error' });
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await until(() => st(h).then((x) => x.state === 'error'), 8000, 'error');
        assert.deepStrictEqual(await seekReq(h, 1), no, 'after an error');
        const p = await st(h);
        assert.strictEqual(p.state, 'error', 'the error stays');
        assert.strictEqual(h.pids.player.length, 2, 'no player started by a refused seek');
    } finally { await h.close(); await files.close(); }
});

test('the position of a seek is kept in queue.json', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setupSeek(files);
    try {
        await h.req({ cmd: 'play', tracks: [1, 2], index: 1 });
        await playingAt(h, 0, 250);
        await seekReq(h, 321.5);
        const q = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'queue.json'), 'utf8'));
        assert.deepStrictEqual(P.validateState('queue', q), []);
        assert.strictEqual(q.index, 1); assert.strictEqual(q.position, 321.5);
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
