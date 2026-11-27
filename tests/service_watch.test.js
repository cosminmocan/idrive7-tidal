'use strict';
/**
 * C6: the app's watch (rule R8) and the idle end, with an injected clock. While a track plays, 90 s with no
 * request from the app stops it (the app was closed or crashed); a request at 89 s keeps it; 10 minutes with no
 * request and nothing playing ends the service with exit code 0.
 */
const assert = require('assert');
const { test, run } = require('./lib/t');
const { startService, until, alive } = require('./fakes/service_harness');
const { createFileServer } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const SESSION = JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });
const S = 1000;

function setup(files) {
    const clock = { t: 1000000 };
    return startService({ client: true, files: { 'session.json': SESSION },
        tidal: { streamUrl: (id, q) => ({ url: files.url('t' + id), codec: 'flac', quality: q }) },
        service: { now: () => clock.t, tickMs: 3600 * S, playerEnv: { FAKE_TICK_MS: '20', FAKE_SECONDS: '1000' } } })
        .then((h) => { h.clock = clock; return h; });
}
const st = (h) => h.status().then((s) => s.player);
const playing = (h) => until(() => st(h).then((p) => p.state === 'playing'), 8000, 'playing');

test('no request for 90 s while playing stops playback', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playing(h);                      // the last request: at clock.t
        h.clock.t += 89 * S; h.svc.tick();
        await h.sleep(100);
        h.clock.t += 2 * S; h.svc.tick();       // 91 s since the last request
        const pids = h.pids.player.slice();
        await until(() => pids.every((p) => !alive(p)), 5000, 'the player ended');
        const p = await st(h);
        assert.strictEqual(p.state, 'idle');
        assert.strictEqual(p.queueLength, 1, 'the queue is kept');
        assert.deepStrictEqual(h.exits, [], 'the service keeps running');
    } finally { await h.close(); await files.close(); }
});

test('a request at 89 s keeps it playing', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playing(h);
        h.clock.t += 89 * S;
        await h.req({ cmd: 'status' });
        h.clock.t += 89 * S; h.svc.tick();
        await h.sleep(300);
        assert.strictEqual((await st(h)).state, 'playing');
        assert.strictEqual(h.pids.player.filter(alive).length, 1);
    } finally { await h.close(); await files.close(); }
});

test('paused counts as playing: 90 s without the app ends it too', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playing(h);
        await h.req({ cmd: 'pause' });
        h.clock.t += 91 * S; h.svc.tick();
        await until(() => h.pids.player.every((p) => !alive(p)), 5000, 'the player ended');
    } finally { await h.close(); await files.close(); }
});

test('10 minutes with no request and nothing playing ends the service with exit code 0', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'status' });
        h.clock.t += 9 * 60 * S; h.svc.tick();
        await h.sleep(200);
        assert.deepStrictEqual(h.exits, [], 'not after 9 minutes');
        h.clock.t += 61 * S; h.svc.tick();
        await until(() => h.exits.length === 1, 5000, 'the exit');
        assert.deepStrictEqual(h.exits, [0]);
        await until(() => h.pids.client.every((p) => !alive(p)), 5000, 'the client ended');
    } finally { await h.close(); await files.close(); }
});

test('nothing ends while a track plays and the app keeps asking', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        await h.req({ cmd: 'play', tracks: [1], index: 0 });
        await playing(h);
        for (let i = 0; i < 12; i++) { h.clock.t += 60 * S; await h.req({ cmd: 'status' }); h.svc.tick(); }   // 12 minutes, asked each minute
        await h.sleep(200);
        assert.deepStrictEqual(h.exits, []);
        assert.strictEqual((await st(h)).state, 'playing');
    } finally { await h.close(); await files.close(); }
});

run();
