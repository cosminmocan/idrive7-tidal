'use strict';
/**
 * V1c, the picture on the GPU path. mgu-render's video (mgu-store native/mgu-render/PROTOCOL.md, "Video"): a player
 * writes decoded frames to /dev/shm/mgu-video-<name>; the app names that file with message 13 (VIDEO: u32 id, the
 * path, NUL padded) and draws op 19 (`x y w h r id`: the newest frame fitted into the rect) in its frames; a shown
 * app still sends at least one message a second. The kit's renderer client (kit/runtime/renderd.js) speaks it in
 * mgu-render/1; the app (status.player.video) decides where and whether the picture shows.
 *
 * Here: the staged app on the kit's stubbed head unit (tests/lib/staged_gpu.js) with a stand-in renderer that
 * answers as mgu-render/1 with video (X_READY caps 16), a fake service where a video plays; and the kit's
 * RenderClient alone.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const G = require('./lib/staged_gpu');
const rec = require('../kit/runtime/record');
const { RenderClient } = require('../kit/runtime/renderd');
const { createFakeService, defaultState, VIDEO } = require('./fakes/fake_service');

const FILE = '/dev/shm/mgu-video-cmocan-tidal';
const PICTURE = { file: FILE, width: 1280, height: 720 };
const M = { FRAME: 7, VIDEO: 13, DROP_VIDEO: 14, X_GRAB: 0x4d520002 };
const CAPS_VIDEO = 1 | 2 | 4 | 8 | 16;
const near = (a, b) => Math.abs(a - b) < 0.05;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + what);
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-vid-')); }

function videoService(sock, video) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = { state: 'playing', track: VIDEO, position: 30, duration: 175, queueIndex: 0, queueLength: 1, quality: 'HIGH', error: null, skipped: [], video: video };
    return createFakeService({ socketPath: sock, state: st });
}
const frames = (msgs) => msgs.filter((m) => m.type === M.FRAME);
const videos = (msgs) => msgs.filter((m) => m.type === M.VIDEO).map((m) => ({ id: m.p.readUInt32LE(0), file: m.p.slice(4).toString('utf8').replace(/\0+$/, ''), at: msgs.indexOf(m), len: m.p.length }));
const opsOf = (f) => G.videoOps(f.p);

/** the staged app against a video service and a stand-in renderer; returns { out, rd, svc } (closed) */
async function staged(o) {
    const tmp = tmpDir();
    const svc = await videoService(path.join(tmp, 'service.sock'), o.video === undefined ? PICTURE : o.video);
    const rd = await G.standIn(path.join(tmp, 'render.sock'), { native: true, caps: o.caps != null ? o.caps : CAPS_VIDEO });
    try {
        const out = await G.runStaged({ tmp: tmp, serviceSock: path.join(tmp, 'service.sock'), rendererSock: path.join(tmp, 'render.sock'),
            until: 'frames', frames: o.frames || 8, sets: o.sets, kmh: o.kmh, quietMs: o.quietMs, ms: 15000 });
        assert.deepStrictEqual(out.errors, [], 'errors logged:\n' + out.logs.join('\n'));
        assert.ok(out.logs.some((l) => /renderd: connected.*mgu-render\/1/.test(l)), 'mgu-render/1:\n' + out.logs.join('\n'));
        return { out: out, rd: rd, svc: svc };
    } finally { await rd.close(); await svc.close(); }
}

test('status.player.video set: a VIDEO message names /dev/shm/mgu-video-cmocan-tidal, then the frames draw op 19 at the fitted rect', async () => {
    const { rd } = await staged({});
    const v = videos(rd.msgs);
    assert.strictEqual(v.length, 1, 'named once: ' + JSON.stringify(v));
    assert.deepStrictEqual([v[0].id, v[0].file], [1, FILE]);
    assert.strictEqual(v[0].len % 4, 0, 'NUL padded to words');
    const fs2 = frames(rd.msgs), withOp = fs2.filter((f) => opsOf(f).length);
    assert.ok(withOp.length >= 3, 'frames with the picture: ' + withOp.length + ' of ' + fs2.length);
    assert.ok(rd.msgs.indexOf(withOp[0]) > v[0].at, 'named before the first frame that draws it');
    const op = opsOf(withOp[withOp.length - 1]);
    assert.strictEqual(op.length, 1);
    // 1280 x 720 into the page (1600 x 520): 520 high, 924.4 wide, centred
    assert.ok(op[0].id === 1 && op[0].r === 0 && near(op[0].x, 337.78) && near(op[0].y, 0) && near(op[0].w, 924.44) && near(op[0].h, 520), JSON.stringify(op[0]));
    // every frame still parses (op 19 is known to the kit's walker: pictures after it keep mgu-render/1's form)
    fs2.forEach((f) => G.imageOps(f.p, 'native'));
}, { timeout: 60000 });

test('status.player.video null: no VIDEO message, no op 19', async () => {
    const { rd } = await staged({ video: null });
    assert.deepStrictEqual(videos(rd.msgs), []);
    assert.ok(frames(rd.msgs).length >= 3);
    frames(rd.msgs).forEach((f) => assert.deepStrictEqual(opsOf(f), []));
}, { timeout: 60000 });

test('"Picture only while parked" on and the car moving: no op 19, the sound goes on (no pause, no stop sent)', async () => {
    const { rd, svc } = await staged({ sets: { videoParkedOnly: true }, kmh: 50 });
    assert.ok(frames(rd.msgs).length >= 3);
    frames(rd.msgs).forEach((f) => assert.deepStrictEqual(opsOf(f), []));
    assert.deepStrictEqual(videos(rd.msgs), [], 'not named either');
    assert.ok(!svc.requests.some((r) => r.cmd === 'pause' || r.cmd === 'stop'), svc.requests.map((r) => r.cmd).join(' '));
}, { timeout: 60000 });

test('the setting off (the default) and the car moving: op 19 still there', async () => {
    const { rd } = await staged({ kmh: 50 });
    assert.ok(frames(rd.msgs).some((f) => opsOf(f).length === 1), 'the picture while driving');
}, { timeout: 60000 });

test('while the picture shows the renderer gets a frame at least once a second, also when the app draws nothing new', async () => {
    const { rd } = await staged({ frames: 4, quietMs: 3500 });
    const fs2 = frames(rd.msgs);
    const last = fs2[fs2.length - 1].at, quiet = fs2.filter((f) => f.at >= last - 3500);
    assert.ok(quiet.length >= 3, quiet.length + ' frames in the quiet 3.5 s');
    for (let i = 1; i < quiet.length; i++) assert.ok(quiet[i].at - quiet[i - 1].at <= 1100, 'a gap of ' + (quiet[i].at - quiet[i - 1].at) + ' ms');
    quiet.forEach((f) => assert.strictEqual(opsOf(f).length, 1, 'with the picture'));
}, { timeout: 60000 });

test('an mgu-render/1 without video (no caps 16): no VIDEO message, no op 19', async () => {
    const { rd } = await staged({ caps: 1 | 2 | 4 | 8 });
    assert.deepStrictEqual(videos(rd.msgs), []);
    frames(rd.msgs).forEach((f) => assert.deepStrictEqual(opsOf(f), []));
}, { timeout: 60000 });

/* ---- the kit's RenderClient alone ---- */

async function client(sockPath, opts) {
    const logs = [];
    const log = { info(m) { logs.push('info ' + m); }, warn(m) { logs.push('warn ' + m); }, error(m) { logs.push('error ' + m); } };
    const gpu = new RenderClient('test_app', log, Object.assign({ socket: sockPath }, opts));
    gpu.connect();
    await waitFor(() => gpu.ready, 3000, 'READY');
    gpu.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
    return { gpu: gpu, logs: logs };
}
const renderd = require('../kit/runtime/renderd');
function drawing(id) {
    const r = new rec.Recorder(1600, 520);
    r.clear('#000000');
    renderd.videoOp(r, id, 10, 20, 300, 200);
    r.fillRect(40, 40, 5, 5, '#00ff00');
    return r;
}

test('RenderClient on mgu-render/1: X_READY caps 16 is info.video; VIDEO (13) once per naming, before the frame; DROP_VIDEO (14) when forgotten', async () => {
    const tmp = tmpDir(), sock = path.join(tmp, 'r.sock');
    const rd = await G.standIn(sock, { native: true, caps: CAPS_VIDEO });
    const { gpu, logs } = await client(sock, { native: true });
    try {
        assert.strictEqual(gpu.info.video, true);
        renderd.setVideo(7, '/dev/shm/mgu-video-test');
        gpu.frame(drawing(7)); gpu.frame(drawing(7));
        await waitFor(() => frames(rd.msgs).length === 2, 3000, 'the frames');
        const v = videos(rd.msgs);
        assert.deepStrictEqual(v.map((x) => [x.id, x.file]), [[7, '/dev/shm/mgu-video-test']]);
        assert.ok(v[0].at < rd.msgs.indexOf(frames(rd.msgs)[0]));
        assert.deepStrictEqual(opsOf(frames(rd.msgs)[0]), [{ x: 10, y: 20, w: 300, h: 200, r: 0, id: 7 }]);
        // named again (a new video in the same file): sent again
        renderd.setVideo(7, '/dev/shm/mgu-video-test');
        gpu.frame(drawing(7));
        await waitFor(() => frames(rd.msgs).length === 3, 3000, 'the third frame');
        assert.strictEqual(videos(rd.msgs).length, 2);
        // forgotten: dropped
        renderd.setVideo(7, null);
        const r = new rec.Recorder(1600, 520).clear('#000000');
        gpu.frame(r);
        await waitFor(() => frames(rd.msgs).length === 4, 3000, 'the fourth frame');
        const drops = rd.msgs.filter((m) => m.type === M.DROP_VIDEO);
        assert.deepStrictEqual(drops.map((m) => m.p.readUInt32LE(0)), [7]);
        assert.deepStrictEqual(logs.filter((l) => /^warn/.test(l)), []);
    } finally { renderd.setVideo(7, null); gpu.close(); await rd.close(); }
});

test('RenderClient: the upstream dialect never gets VIDEO; the software path (record.js play) passes op 19 over', async () => {
    const tmp = tmpDir(), sock = path.join(tmp, 'r.sock');
    const rd = await G.standIn(sock, { native: false });
    const { gpu } = await client(sock, {});
    try {
        renderd.setVideo(8, '/dev/shm/mgu-video-test');
        gpu.frame(drawing(8));
        await waitFor(() => frames(rd.msgs).length === 1, 3000, 'the frame');
        assert.deepStrictEqual(videos(rd.msgs), []);
    } finally { renderd.setVideo(8, null); gpu.close(); await rd.close(); }
    // played in software: what follows op 19 is still drawn
    const drawn = [];
    const cv = new Proxy({}, { get: (o, k) => (...a) => { drawn.push(k); return cv; } });
    rec.play(drawing(9).words(), cv);
    assert.deepStrictEqual(drawn, ['clear', 'fillRect']);
});

run();
