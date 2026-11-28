'use strict';
/**
 * V1b, the service's part: videos (contract 4). `play` with `kinds`; a video plays with the video player
 * (tidal-video, docs/PROTOCOL.md section 2 "The video player") with MGU_VIDEO=shm:cmocan-tidal, MGU_VIDEO_DECODER=auto
 * and the `video` group; the service fetches TIDAL's HLS master playlist, the variant closest to prefs.videoHeight,
 * then each segment in order through the client child and pipes one continuous MPEG-TS to the player's stdin; a
 * segment that fails is tried again, then skipped; seek starts at the segment holding the position (MGU_BASE_MS,
 * MGU_START_MS); status.player.video once the player says its picture is open.
 * Runs the real client.js child, the fake player in video mode (FAKE_RECORD, FAKE_ENV) and a fake HLS server.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService, until, alive, FAKE_PLAYER } = require('./fakes/service_harness');
const { createFileServer, createHlsServer, pattern, track, video } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const SESSION = JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });
const V = 143792065, V2 = 143792066;
const FRAME = '/dev/shm/mgu-video-cmocan-tidal';
// made up here, of parts: not a real token
const QUERY_TOKEN = ['FAKE', 'HLS', 'c2VjcmV0', '0123456789'].join('-');

/** a logged-in service; videos from `hls`, tracks from `files`; every player records its input and environment */
function setup(hls, files, extra) {
    const x = extra || {};
    let h = null, n = 0;
    const tidal = Object.assign({
        library: { favorites: { videos: [video(V), video(V2, 'Second')] }, search: [track(1, 'One'), track(2, 'Two')], videos: { [V]: video(V) } },
        videoUrl: () => ({ url: hls.masterUrl, quality: 'HIGH' }),
        streamUrl: (id, q) => ({ url: files ? files.url('t' + id) : 'http://127.0.0.1:1/none', codec: 'flac', quality: q }),
    }, x.tidal || {});
    return startService({ client: true, files: x.files || { 'session.json': SESSION }, tidal: tidal,
        service: Object.assign({
            playerEnv: (id) => { n++; return { FAKE_TICK_MS: x.tickMs || '20', FAKE_SECONDS: x.seconds || '1', FAKE_RECORD: path.join(h.dir, 'rec-' + id + '-' + n + '.bin'), FAKE_ENV: path.join(h.dir, 'env-' + id + '-' + n + '.json') }; },
            videoBin: process.execPath, videoArgs: [FAKE_PLAYER, '--video'],
        }, x.service || {}) }).then((s) => { h = s; return h; });
}
const st = (h) => h.status().then((s) => s.player);
function checkStatus(s) { assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), [], JSON.stringify(s)); }
const read = (f) => { try { return fs.readFileSync(f); } catch (e) { return null; } };
/** the k-th player's recording (once the whole input has come) and its environment, as the fake player wrote them */
const recording = (h, k, size) => { const s = h.spawns[k]; const b = s && read(s.env.FAKE_RECORD); return b && b.length >= size ? b : null; };
const envOf = (h, k) => { const b = h.spawns[k] && read(h.spawns[k].env.FAKE_ENV); return b ? JSON.parse(b.toString()) : null; };
const playVideo = (h, ids, index) => h.req({ cmd: 'play', tracks: ids, kinds: ids.map(() => 'video'), index: index || 0 });
const played = (hls, re) => hls.requests.filter((r) => re.test(r.path)).length;

test('a video plays with tidal-video: the 720p variant\'s segments in order, byte for byte; status.player.video; the length from the playlist', async () => {
    const hls = await createHlsServer();
    const h = await setup(hls, null, { seconds: '20' });
    try {
        await h.req({ cmd: 'favorites', kind: 'videos' });   // the service learns the video from the list
        assert.deepStrictEqual(await h.req({ id: 28, cmd: 'play', tracks: [V], kinds: ['video'], index: 0 }), { id: 28, ok: true });
        const p = await until(() => h.status().then((s) => { checkStatus(s); return s.player.state === 'playing' && s.player.video && s.player; }), 8000, 'the picture');
        assert.deepStrictEqual(p.video, { file: FRAME, width: 1280, height: 720 });
        assert.strictEqual(p.track.kind, 'video'); assert.strictEqual(p.track.id, V); assert.strictEqual(p.track.title, 'Video ' + V);
        assert.strictEqual(p.duration, 28.5, 'the sum of the segments');
        assert.strictEqual(p.quality, 'HIGH');
        const expected = hls.expected(720);
        const got = await until(() => recording(h, 0, expected.length), 8000, 'the recording');
        assert.ok(got.equals(expected), 'byte for byte, in order (' + got.length + ' of ' + expected.length + ')');
        const s = h.spawns[0];
        assert.strictEqual(s.bin, process.execPath); assert.deepStrictEqual(s.args, [FAKE_PLAYER, '--video'], 'the video player');
        assert.strictEqual(s.env.MGU_VIDEO, 'shm:cmocan-tidal');
        assert.strictEqual(s.env.MGU_VIDEO_DECODER, 'auto');
        assert.deepStrictEqual(s.env.MGU_GROUPS.split(',').sort(), ['audio', 'mgu_alsa', 'video']);
        assert.strictEqual(s.env.MGU_BASE_MS, undefined); assert.strictEqual(s.env.MGU_START_MS, undefined);
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'videoUrl').map((c) => c.args), [[V, 720]]);
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl').length, 0);
        assert.strictEqual(played(hls, /^\/master\.m3u8$/), 1);
        assert.deepStrictEqual(hls.requests.filter((r) => /index\.m3u8$/.test(r.path)).map((r) => r.path), ['/720/index.m3u8'], 'only the chosen variant');
        const end = await until(() => st(h).then((x) => x.state === 'idle' && x), 15000, 'idle');
        assert.strictEqual(end.video, null, 'no picture once it is over');
    } finally { await h.close(); await hls.close(); }
});

test('the variant follows prefs.videoHeight (480, 1080), kept in prefs.json; 720 by default; a height between two: the lower', async () => {
    const hls = await createHlsServer();
    const h = await setup(hls);
    try {
        let s = await h.status();
        assert.strictEqual(s.prefs.videoHeight, 720, 'the default');
        assert.strictEqual((await h.req({ cmd: 'prefs', videoHeight: 600 })).error, 'bad-request');
        const a = await h.req({ id: 23, cmd: 'prefs', videoHeight: 480 });
        assert.deepStrictEqual(a, { id: 23, ok: true, prefs: { quality: 'HIGH', videoHeight: 480 } });
        await playVideo(h, [V]);
        let exp = hls.expected(480);
        assert.ok((await until(() => recording(h, 0, exp.length), 8000, '480p')).equals(exp));
        await until(() => st(h).then((x) => x.state === 'idle'), 8000, 'idle');
        await h.req({ cmd: 'prefs', videoHeight: 1080 });
        await playVideo(h, [V]);
        exp = hls.expected(1080);
        assert.ok((await until(() => recording(h, 1, exp.length), 8000, '1080p')).equals(exp));
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'videoUrl').map((c) => c.args[1]), [480, 1080]);
        const saved = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'prefs.json'), 'utf8'));
        assert.deepStrictEqual(saved, { version: 1, quality: 'HIGH', videoHeight: 1080 });
        assert.deepStrictEqual(P.validateState('prefs', saved), []);
        s = await h.status();
        assert.strictEqual(s.prefs.videoHeight, 1080);
        checkStatus(s);
    } finally { await h.close(); await hls.close(); }
    const two = await createHlsServer({ heights: [360, 1080] });
    const h2 = await setup(two);
    try {
        await playVideo(h2, [V]);   // 720 wanted: 360 is the closest not above it
        const exp = two.expected(360);
        assert.ok((await until(() => recording(h2, 0, exp.length), 8000, '360p')).equals(exp));
    } finally { await h2.close(); await two.close(); }
});

test('prefs.videoHeight survives a restart', async () => {
    const hls = await createHlsServer();
    const h = await setup(hls);
    let saved;
    try {
        await h.req({ cmd: 'prefs', videoHeight: 480 });
        saved = { 'session.json': SESSION, 'prefs.json': fs.readFileSync(path.join(h.stateDir, 'prefs.json'), 'utf8') };
    } finally { await h.close(); }
    const h2 = await setup(hls, null, { files: saved });
    try { assert.strictEqual((await h2.status()).prefs.videoHeight, 480); } finally { await h2.close(); await hls.close(); }
});

test('seek on a video: the player starts at the segment holding the position (MGU_BASE_MS its start, MGU_START_MS the position)', async () => {
    const hls = await createHlsServer();   // 6, 6, 6, 6, 4.5 s
    const h = await setup(hls, null, { seconds: '1000' });
    try {
        await playVideo(h, [V]);
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        assert.deepStrictEqual(await h.req({ id: 25, cmd: 'seek', position: 13.25 }), { id: 25, ok: true });
        const p = await until(() => st(h).then((x) => x.state === 'playing' && h.spawns.length === 2 && x), 8000, 'playing after the seek');
        assert.ok(p.position >= 13.25, 'from the position: ' + p.position);
        assert.strictEqual(p.duration, 28.5);
        const exp = hls.expected(720, 2);
        const got = await until(() => recording(h, 1, exp.length), 8000, 'the recording after the seek');
        assert.ok(got.equals(exp), 'from the third segment on');
        assert.deepStrictEqual(envOf(h, 1), { MGU_START_MS: '13250', MGU_BASE_MS: '12000', MGU_VIDEO: 'shm:cmocan-tidal' });
        assert.strictEqual(played(hls, /^\/master\.m3u8$/), 1, 'the playlists are not fetched again for a seek');
        // paused stays paused, at the new position
        await h.req({ cmd: 'pause' });
        await until(() => st(h).then((x) => x.state === 'paused'), 3000, 'paused');
        await h.req({ cmd: 'seek', position: 24 });
        await until(() => h.spawns.length === 3 && envOf(h, 2), 8000, 'the third player');
        assert.deepStrictEqual(envOf(h, 2), { MGU_START_MS: '24000', MGU_BASE_MS: '24000', MGU_VIDEO: 'shm:cmocan-tidal' });
        await h.sleep(300);
        const q = await st(h);
        assert.strictEqual(q.state, 'paused'); assert.ok(q.position >= 24 && q.position < 25, String(q.position));
        // back to the start: no base, no start
        await h.req({ cmd: 'resume' });
        await h.req({ cmd: 'seek', position: 0 });
        await until(() => h.spawns.length === 4 && envOf(h, 3), 8000, 'the fourth player');
        assert.deepStrictEqual(envOf(h, 3), { MGU_START_MS: null, MGU_VIDEO: 'shm:cmocan-tidal' });
        // at the end: the queue is over
        await h.req({ cmd: 'seek', position: 28.5 });
        await until(() => st(h).then((x) => x.state === 'idle'), 8000, 'idle at the end');
        await until(() => h.pids.player.every((x) => !alive(x)), 5000, 'no player');
    } finally { await h.close(); await hls.close(); }
});

test('a segment that fails twice is skipped (and logged); one that fails once, or breaks in the middle, is continued', async () => {
    const hls = await createHlsServer({ fail: { '720/1': 1, '720/3': 2 }, cuts: { '720/2': 1500 } });
    const h = await setup(hls);
    try {
        await playVideo(h, [V]);
        const exp = hls.expected(720, 0, [3]);
        const got = await until(() => recording(h, 0, exp.length), 10000, 'the recording');
        assert.ok(got.equals(exp), 'every segment but the fourth, byte for byte');
        assert.strictEqual(hls.segmentRequests(720, 1).length, 2, 'tried again');
        assert.strictEqual(hls.segmentRequests(720, 3).length, 2, 'tried twice, then skipped');
        assert.deepStrictEqual(hls.segmentRequests(720, 2).map((r) => r.range), [null, 'bytes=1500-'], 'continued with Range');
        assert.strictEqual(hls.segmentRequests(720, 4).length, 1);
        await until(() => st(h).then((x) => x.state === 'idle'), 8000, 'played to the end');
        const log = (await h.req({ cmd: 'log' })).lines.join('\n');
        assert.ok(/video 143792065: segment 4 of 5 skipped/.test(log), log);
        assert.ok(/video 143792065: segment 2 of 5 failed \(HTTP 500\)/.test(log), log);
    } finally { await h.close(); await hls.close(); }
});

test('a segment refused as expired (403): the address asked for again, and the video continues at that segment', async () => {
    const hls = await createHlsServer({ expired: { '720/2': 1 } });
    const h = await setup(hls);
    try {
        await playVideo(h, [V]);
        const exp = hls.expected(720);
        const got = await until(() => recording(h, 0, exp.length), 10000, 'the recording');
        assert.ok(got.equals(exp), 'byte for byte, nothing twice');
        assert.strictEqual(h.cfg.calls.filter((c) => c.method === 'videoUrl').length, 2);
        assert.strictEqual(played(hls, /^\/master\.m3u8$/), 2);
        assert.strictEqual(hls.segmentRequests(720, 0).length, 1, 'not started again');
    } finally { await h.close(); await hls.close(); }
});

test('a mixed queue track -> video -> track: tidal-player, tidal-video, tidal-player; one player at a time; kinds kept in queue.json', async () => {
    const hls = await createHlsServer();
    const files = await createFileServer({ size: 50000 });
    const h = await setup(hls, files);
    try {
        await h.req({ cmd: 'play', tracks: [1, V, 2], kinds: ['track', 'video', 'track'], index: 0 });
        await until(() => st(h).then((x) => x.state === 'idle' && h.spawns.length === 3), 15000, 'the queue played');
        const s = h.spawns;
        assert.deepStrictEqual(s.map((x) => x.args), [[FAKE_PLAYER], [FAKE_PLAYER, '--video'], [FAKE_PLAYER]]);
        assert.deepStrictEqual(s.map((x) => x.env.MGU_VIDEO || null), [null, 'shm:cmocan-tidal', null]);
        assert.deepStrictEqual(s[0].env.MGU_GROUPS, 'mgu_alsa,audio', 'a track: the sound groups only');
        for (let k = 1; k < s.length; k++) assert.ok(s[k - 1].exitAt !== null && s[k].at >= s[k - 1].exitAt, 'player ' + k + ' started after the one before ended');
        assert.ok(recording(h, 0, 50000).equals(pattern(0, 50000)));
        assert.ok(recording(h, 1, hls.expected(720).length).equals(hls.expected(720)));
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'streamUrl').map((c) => c.args[0]), [1, 2]);
        const q = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'queue.json'), 'utf8'));
        assert.deepStrictEqual(P.validateState('queue', q), []);
        assert.deepStrictEqual(q.tracks, [1, V, 2]); assert.deepStrictEqual(q.kinds, ['track', 'video', 'track']);
        // without kinds every id is a track; kinds that do not fit the ids are bad-request
        await h.req({ cmd: 'play', tracks: [2], index: 0 });
        await until(() => h.spawns.length === 4, 8000, 'a track');
        assert.deepStrictEqual(h.spawns[3].args, [FAKE_PLAYER]);
        assert.strictEqual((await h.req({ cmd: 'play', tracks: [1, V], kinds: ['video'], index: 0 })).error, 'bad-request');
        assert.strictEqual((await h.req({ cmd: 'play', tracks: [1], kinds: ['film'], index: 0 })).error, 'bad-request');
    } finally { await h.close(); await hls.close(); await files.close(); }
});

test('after a restart the queue still knows its video: resume plays it with tidal-video; it is looked up by id for status', async () => {
    const hls = await createHlsServer();
    const queue = JSON.stringify({ version: 1, tracks: [V, 1], kinds: ['video', 'track'], index: 0, position: 0 });
    const h = await setup(hls, null, { seconds: '1000', files: { 'session.json': SESSION, 'queue.json': queue } });
    try {
        await h.req({ cmd: 'resume' });
        const p = await until(() => st(h).then((x) => x.state === 'playing' && x.track && x), 8000, 'playing, known');
        assert.deepStrictEqual(h.spawns[0].args, [FAKE_PLAYER, '--video']);
        assert.strictEqual(p.track.kind, 'video');
        assert.ok(h.cfg.calls.some((c) => c.method === 'video' && c.args[0] === V), 'looked up as a video');
        assert.ok(!h.cfg.calls.some((c) => c.method === 'track' && c.args[0] === V), 'not as a track');
    } finally { await h.close(); await hls.close(); }
});

test('pause, resume, next, prev and stop on videos; the picture goes with stop; the app\'s 90 s watch stops a video', async () => {
    const hls = await createHlsServer();
    const clock = { t: 1000000 };
    // ticks of 200 ms (0.5 s each): prev comes before 3 s have played
    const h = await setup(hls, null, { seconds: '1000', tickMs: '200', service: { now: () => clock.t, tickMs: 3600 * 1000 } });
    try {
        await h.req({ cmd: 'favorites', kind: 'videos' });   // the service learns both videos from the list
        await playVideo(h, [V, V2]);
        await until(() => st(h).then((x) => x.state === 'playing' && x.video), 8000, 'playing');
        await h.req({ cmd: 'pause' });
        await until(() => st(h).then((x) => x.state === 'paused'), 3000, 'paused');
        await h.req({ cmd: 'resume' });
        await until(() => st(h).then((x) => x.state === 'playing'), 3000, 'playing again');
        await h.req({ cmd: 'next' });
        let p = await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 1 && x.video && x), 8000, 'the second video');
        assert.strictEqual(p.track && p.track.id, V2);
        await h.req({ cmd: 'prev' });   // under 3 s: back one
        await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 0), 8000, 'back to the first');
        await h.req({ cmd: 'stop' });
        p = await until(() => st(h).then((x) => x.state === 'idle' && x), 3000, 'idle');
        assert.strictEqual(p.video, null);
        await until(() => h.pids.player.every((x) => !alive(x)), 5000, 'no player');
        await h.req({ cmd: 'resume' });
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        clock.t += 91 * 1000; h.svc.tick();
        await until(() => h.pids.player.every((x) => !alive(x)), 5000, 'stopped by the watch');
        assert.strictEqual(h.svc.status().player.state, 'idle');
    } finally { await h.close(); await hls.close(); }
});

test('the log has the video\'s play, seek and segment lines, and no address\'s query (where TIDAL puts its tokens)', async () => {
    const hls = await createHlsServer({ query: '?token=' + QUERY_TOKEN, fail: { '720/1': 2 } });
    const h = await setup(hls, null, { seconds: '1000' });
    try {
        await playVideo(h, [V]);
        await until(() => st(h).then((x) => x.state === 'playing'), 8000, 'playing');
        await h.req({ cmd: 'seek', position: 13 });
        await until(() => st(h).then((x) => x.state === 'playing' && h.spawns.length === 2), 8000, 'after the seek');
        const lines = (await h.req({ cmd: 'log' })).lines;
        const all = lines.join('\n');
        assert.ok(/play: video 143792065 \(1 of 1\)/.test(all), all);
        assert.ok(/video 143792065: 1280x720, 5 segments, 28\.5 s/.test(all), all);
        assert.ok(/playing video 143792065 \(720p/.test(all), all);
        assert.ok(/seek: video 143792065 to 13 s \(segment 3 of 5, from 12 s\)/.test(all), all);
        assert.ok(/video 143792065: segment 2 of 5 skipped/.test(all), all);
        assert.ok(all.indexOf(QUERY_TOKEN) < 0 && h.logs.join('\n').indexOf(QUERY_TOKEN) < 0, 'no token in the log or the journal');
        assert.ok(hls.requests.every((r) => r.query === 'token=' + QUERY_TOKEN), 'the addresses were used with their query');
    } finally { await h.close(); await hls.close(); }
});

run();
