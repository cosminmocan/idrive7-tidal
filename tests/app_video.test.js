'use strict';
/**
 * V1c: video in the car app (docs/PROTOCOL.md, contract 4). Video items in the lists (a film mark, their length, the
 * playing mark and "Not available" as for tracks), My music's "Videos" row (favorites kind:videos), `play` with
 * `kinds`, a video opened from a list goes to now playing; status.player.video drawn as the picture (aspect kept,
 * black bars) where the GPU renderer shows video, else the cover view with a line; the setting "Picture only while
 * parked" (off by default: the picture also while driving, the owner's decision); "Video size" sent as
 * prefs {videoHeight}; the cluster card names the video; garbage in player.video never crashes (R1).
 * The renderer's side (VIDEO message, op 19, keepalive) is tests/app_video_gpu.test.js.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const parkedKit = require('../kit/runtime/parked');
const { createFakeService, defaultState, TRACK, VIDEO } = require('./fakes/fake_service');
const P = require('./fakes/protocol');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');
const L = require('../apps/cmocan_tidal/listview');
const C = require('../apps/cmocan_tidal/cluster');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { createApp } = require('../apps/cmocan_tidal/tidal');

const theme = themes.theme('m_tricolour');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));
const FILE = '/dev/shm/mgu-video-cmocan-tidal';
const PICTURE = { file: FILE, width: 1280, height: 720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}
const near = (a, b) => Math.abs(a - b) < 0.05;

const track = (i, o) => Object.assign({ id: 1000 + i, title: 'Track ' + i, artists: ['Artist ' + i], album: { id: 7, title: 'Album' }, coverId: null, duration: 185, streamReady: true, explicit: false }, o || {});
const video = (i, o) => Object.assign({}, VIDEO, { id: 9000 + i, title: 'Video ' + i }, o || {});
function status(player) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    if (player) st.player = player;
    return { type: 'status', state: st };
}
const playing = (t, o) => Object.assign({ state: 'playing', track: t, position: 30, duration: t.duration, queueIndex: 0, queueLength: 2, quality: 'HIGH', error: null, skipped: [] }, o || {});
function listOf(s, items) {
    let n = M.reduce(s, { type: 'open-list', key: 'k', title: 'A playlist', kind: 'tracks', source: { cmd: 'playlist', params: { uuid: 'u' } } });
    n = M.reduce(n, { type: 'list-loaded', key: 'k', offset: 0, total: items.length, items: items });
    return n;
}
function drawn(s, ui) { const cv = spyCanvas(); const info = S.draw(cv, theme, s, Object.assign({ now: 0 }, ui || {})); return { cv: cv, info: info }; }

/* ---------- lists ---------- */

test('a video in a list is a row like a track: title, artists, its length, and a film mark (a track has none)', () => {
    const items = [track(0), video(1)];
    const s = listOf(M.reduce(M.initial(), status()), items);
    const rows = L.rows(s);
    assert.strictEqual(rows[1].label, 'Video 1');
    assert.strictEqual(rows[1].sub, 'Daft Punk', 'no album: the artists alone');
    assert.strictEqual(rows[1].right, '2:55');
    assert.strictEqual(rows[1].video, true, 'the row knows it is a video');
    assert.ok(!rows[0].video, 'a track is no video');
    // the film mark is drawn: the same item as a track draws less
    const asTrack = listOf(M.reduce(M.initial(), status()), [track(0), Object.assign({}, video(1), { kind: 'track' })]);
    const a = drawn(s).cv, b = drawn(asTrack).cv;
    assert.ok(a.has('Video 1') && a.has('2:55'), a.all());
    assert.ok(a.calls > b.calls, 'a film mark on the video row (' + a.calls + ' calls, as a track ' + b.calls + ')');
});

test('a video row: the playing mark while it plays, "Not available" and greyed when it cannot be streamed', () => {
    const items = [track(0), video(1), video(2, { streamReady: false })];
    let s = listOf(M.reduce(M.initial(), status()), items);
    s = M.reduce(s, status(playing(video(1))));
    const rows = L.rows(s);
    assert.strictEqual(rows[1].playing, true, 'the playing mark on the video that plays');
    assert.ok(!rows[0].playing);
    assert.strictEqual(rows[2].off, true);
    assert.strictEqual(rows[2].right, 'Not available');
    assert.deepStrictEqual(L.rowActs(s, 2), [{ type: 'error', code: 'not-available', trackId: 9002 }]);
    assert.strictEqual(L.move({ sel: 1, top: 0 }, 1, 3, 6, L.skips(s)).sel, 1, 'skipped by the knob');
});

test('play: `kinds` go with the ids whenever the list holds videos; a list of tracks alone sends none', () => {
    const mixed = listOf(M.reduce(M.initial(), status()), [track(0), video(1), track(2)]);
    const a = L.rowActs(mixed, 0)[0];
    assert.strictEqual(a.type, 'play');
    assert.deepStrictEqual(a.tracks, [1000, 9001, 1002]);
    assert.deepStrictEqual(a.kinds, ['track', 'video', 'track']);
    assert.strictEqual(a.index, 0);
    assert.ok(!a.watch, 'a track: the list stays');
    const v = L.rowActs(mixed, 1)[0];
    assert.deepStrictEqual([v.kinds, v.index, v.watch], [['track', 'video', 'track'], 1, true], 'a video: watched on now playing');
    const tracks = listOf(M.reduce(M.initial(), status()), [track(0), track(1)]);
    const t = L.rowActs(tracks, 1)[0];
    assert.ok(!('kinds' in t), 'no kinds without videos: ' + JSON.stringify(t));
    // what the app would send follows the contract
    const req = { id: 1, cmd: 'play', tracks: a.tracks, kinds: a.kinds, index: a.index };
    assert.deepStrictEqual(P.validateRequest(req), []);
});

test('My music: a "Videos" row (favorites kind:videos) among the lists; "Now playing" stays the last row', () => {
    const s = M.reduce(M.initial(), status());
    const labels = L.rows(s).map((r) => r.label);
    assert.deepStrictEqual(labels, ['Favourite tracks', 'Favourite albums', 'Playlists', 'Mixes', 'Videos', 'Search']);
    const act = L.rowActs(s, 4)[0];
    assert.strictEqual(act.type, 'open-list');
    assert.deepStrictEqual(act.source, { cmd: 'favorites', params: { kind: 'videos' } });
    assert.strictEqual(act.kind, 'tracks', 'its rows play as a track list does');
    const on = M.reduce(s, status(playing(TRACK)));
    assert.strictEqual(L.rows(on).pop().label, 'Now playing');
    const cv = drawn(s).cv;
    assert.ok(cv.has('Videos'), cv.all());
});

test('the model keeps a video\'s kind and status.player.video; garbage there is null (R1)', () => {
    let s = M.reduce(M.initial(), status(playing(VIDEO, { video: PICTURE })));
    assert.strictEqual(s.player.track.kind, 'video');
    assert.deepStrictEqual(s.player.video, PICTURE);
    s = M.reduce(s, status(playing(VIDEO, { video: null })));
    assert.strictEqual(s.player.video, null);
    const garbage = [undefined, 'x', 5, true, [], {}, [PICTURE], { file: 5, width: 1280, height: 720 }, { file: FILE }, { file: FILE, width: '1280', height: 720 },
        { file: FILE, width: 1280, height: -720 }, { file: FILE, width: 0, height: 720 }, { file: FILE, width: 99999, height: 720 }, { file: FILE, width: NaN, height: 720 },
        { file: FILE, width: 1280.5, height: 720 }, { file: 'mgu-video-x', width: 1280, height: 720 }, { file: '/etc/passwd', width: 1280, height: 720 },
        { file: '/dev/shm/mgu-video-../../etc/shadow', width: 1280, height: 720 }, { file: '/dev/shm/mgu-video-.hidden', width: 1280, height: 720 },
        { file: '/dev/shm/mgu-video-' + 'a'.repeat(65), width: 1280, height: 720 }, { file: '/dev/shm/mgu-video-a b', width: 1280, height: 720 },
        { file: FILE, width: Infinity, height: 720 }, Object.create(null)];
    garbage.forEach((g) => {
        const n = M.reduce(M.initial(), status(playing(VIDEO, { video: g })));
        assert.strictEqual(n.player.video, null, JSON.stringify(g));
        ['NOW_PLAYING', 'LIBRARY'].forEach((sc) => {
            const t = sc === 'NOW_PLAYING' ? M.reduce(n, { type: 'open-now-playing' }) : n;
            drawn(t, { video: null, videoNote: 'x' });
        });
    });
    // the player's other fields as before
    const t = M.reduce(M.initial(), status(playing(TRACK)));
    assert.ok(!t.player.track.kind || t.player.track.kind === 'track');
    assert.ok(t.player.video == null);
});

/* ---------- now playing ---------- */

function videoOn(o) {
    let s = M.reduce(M.initial(), status(playing(VIDEO, Object.assign({ video: PICTURE }, o || {}))));
    s = M.reduce(s, { type: 'open-now-playing' });
    return s;
}
function pictureUi(over) {
    const calls = [];
    return { calls: calls, ui: Object.assign({ position: 30, duration: 175, video: { w: 1280, h: 720, overlay: false, draw: (cv, x, y, w, h) => { calls.push({ x: x, y: y, w: w, h: h }); } } }, over || {}) };
}

test('now playing a video: the picture over the page\'s full width, aspect kept (1280 x 720 into 1600 x 520), black bars, no cover', () => {
    const s = videoOn();
    const p = pictureUi();
    const { cv, info } = drawn(s, p.ui);
    assert.strictEqual(p.calls.length, 1, 'the picture drawn once');
    const r = p.calls[0];
    assert.ok(near(r.x, 337.78) && near(r.y, 0) && near(r.w, 924.44) && near(r.h, 520), JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(info.video).sort(), ['h', 'w', 'x', 'y']);
    assert.ok(cv.rects.some((q) => q.x === 0 && q.y === 0 && q.w === 1600 && q.h === 520 && /^#000000/.test(q.c)), 'black under the picture (the bars)');
    assert.strictEqual(cv.images.length, 0, 'no cover');
    assert.ok(!cv.has('Around the World'), 'no title while the controls are hidden');
    // a tall picture: bars left and right; a wide one: top and bottom
    const tall = pictureUi({ video: { w: 720, h: 1280, draw: (c, x, y, w, h) => tall.calls.push({ x: x, y: y, w: w, h: h }) } });
    drawn(s, tall.ui);
    assert.ok(near(tall.calls[0].h, 520) && near(tall.calls[0].w, 292.5) && near(tall.calls[0].x, 653.75), JSON.stringify(tall.calls[0]));
    const wide = pictureUi({ video: { w: 2048, h: 512, draw: (c, x, y, w, h) => wide.calls.push({ x: x, y: y, w: w, h: h }) } });
    drawn(s, wide.ui);
    assert.ok(near(wide.calls[0].w, 1600) && near(wide.calls[0].h, 400) && near(wide.calls[0].y, 60), JSON.stringify(wide.calls[0]));
});

test('controls over the picture: with the overlay the title and the seek bar (a finger seeks there); a tap on the picture asks for them', () => {
    const s = videoOn();
    const hidden = drawn(s, pictureUi().ui).info;
    assert.ok(!hidden.hits.some((h) => h.bar), 'no seek bar while hidden');
    const tap = hidden.hits.filter((h) => h.act && h.act.type === 'video-overlay')[0];
    assert.ok(tap && tap.w >= 900, 'the picture takes a tap: ' + JSON.stringify(hidden.hits));
    const shown = drawn(s, pictureUi({ video: { w: 1280, h: 720, overlay: true, draw() {} } }));
    assert.ok(shown.cv.has('Around the World') && shown.cv.has('Daft Punk'), shown.cv.all());
    assert.ok(shown.cv.has('0:30') && shown.cv.has('2:55'), 'both times');
    const bar = shown.info.hits.filter((h) => h.bar)[0];
    assert.ok(bar && bar.bar.dur === 175, 'the seek bar: ' + JSON.stringify(shown.info.hits));
    // the controller pushed up onto the line: it shows, highlighted
    const up = M.reduce(s, { type: 'focus', area: 'progress' });
    const f = drawn(up, pictureUi({ video: { w: 1280, h: 720, overlay: true, draw() {} } })).info;
    assert.strictEqual(f.focus && f.focus.key, 'progress');
});

test('without the picture (software path, or hidden): the cover view of the video with the line given', () => {
    const s = videoOn();
    const { cv } = drawn(s, { position: 30, duration: 175, video: null, videoNote: 'Video picture needs the GPU renderer', cover: () => ({ id: 5, w: 400, h: 400 }) });
    assert.ok(cv.has('Around the World') && cv.has('Video picture needs the GPU renderer'), cv.all());
    assert.strictEqual(cv.images.length, 1, 'the cover');
});

test('the cluster card names the video as it names a track', () => {
    const s = M.reduce(M.initial(), status(playing(VIDEO, { video: PICTURE })));
    assert.deepStrictEqual(C.infoOf(s.player, { connected: true }), { title: 'Around the World', artist: 'Daft Punk', coverId: VIDEO.coverId });
});

/* ---------- the app, against the fake service ---------- */

function fakeCtx(o) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-data-'));
    const handlers = {}, loops = {}, frames = [], logs = [], watched = {}, setL = [];
    const values = {};
    SPEC.settings.forEach((x) => { values[x.key] = x.default; });
    Object.assign(values, (o && o.sets) || {});
    const ctx = {
        dataDir, handlers, loops, frames, logs, watched, values,
        log: { info() {}, debug() {}, warn(m) { logs.push('warn ' + m); }, error(m, e) { logs.push('error ' + m + (e ? ' ' + (e.stack || e) : '')); } },
        ui: { onClick: (n, fn) => { handlers[n] = fn; }, image: (n, cv) => { frames.push(cv); return Promise.resolve(); }, isVisible: () => true, onVisible() {}, close() {} },
        settings: { get: (k) => values[k], onChange: (fn) => setL.push(fn), set(k, v) { values[k] = v; setL.forEach((f) => f(k, v)); } },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => spyCanvas(w, h),
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        signals: {
            watch: (iface, inst, h) => { watched[iface] = h; return Promise.resolve({ available: true }); },
            proxy: () => Promise.reject(new Error('no SOME/IP in the test')), call: () => Promise.reject(new Error('none')),
            on: () => Promise.reject(new Error('none')), onAvailable: () => {},
        },
        controller: { grab() {}, onInput(fn) { ctx.ccu = fn; } },
        onTap(fn) { ctx.tap = fn; },
    };
    // the kit's display where the GPU renderer speaks mgu-render/1 with video (o.gpu), else none (software)
    if (o && o.gpu) ctx.display = { gpu: { ready: true, native: true, info: { touch: true, controller: true, video: o.gpu === 'video' } }, active: () => true };
    return ctx;
}
/** kit/runtime/renderd.js's video calls, as the app makes them */
function videoKit() {
    const k = { named: [], ops: [] };
    k.setVideo = (id, file) => { k.named.push([id, file]); };
    k.videoOp = (cv, id, x, y, w, h) => { k.ops.push({ id: id, x: x, y: y, w: w, h: h }); };
    return k;
}
function start(sock, o) {
    const ctx = fakeCtx(o);
    const vk = videoKit();
    let t = 1000000;
    const clock = { now: () => t, add: (ms) => { t += ms; } };
    const app = createApp(ctx, Object.assign({ socketPath: sock, pollMs: 100, parked: parkedKit.watch(ctx, ctx.log), setImage() {}, decodeJpeg: decodeJpeg, video: vk, now: clock.now }, (o && o.kit) || {}));
    return { ctx, app, vk, clock };
}
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-video-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
const noErrors = (ctx) => assert.deepStrictEqual(ctx.logs.filter((l) => /^error/.test(l)), []);
const lastFrame = (ctx) => ctx.frames[ctx.frames.length - 1];
async function frame(ctx) { await ctx.loops.MAIN(); return lastFrame(ctx); }
function videoService(sock, video) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = playing(VIDEO, { video: video === undefined ? PICTURE : video });
    return createFakeService({ socketPath: sock, state: st });
}
const speed = (ctx, kmh) => ctx.watched['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) });

test('app: My music > Videos asks for favorites kind:videos; choosing a video plays it with kinds and goes to now playing', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        app.act({ type: 'row', index: 4 });
        await waitFor(() => app.state().screen === 'LIST' && M.top(app.state()).items.length === 1, 3000, 'the videos');
        const fav = svc.requests.filter((r) => r.cmd === 'favorites').pop();
        assert.strictEqual(fav.kind, 'videos');
        assert.strictEqual(M.top(app.state()).title, 'Videos');
        app.act({ type: 'row', index: 0 });
        await waitFor(() => svc.requests.some((r) => r.cmd === 'play'), 3000, 'play');
        const play = svc.requests.filter((r) => r.cmd === 'play').pop();
        assert.deepStrictEqual([play.tracks, play.kinds, play.index], [[VIDEO.id], ['video'], 0]);
        assert.deepStrictEqual(P.validateRequest(play), []);
        await waitFor(() => app.state().screen === 'NOW_PLAYING', 3000, 'now playing: videos are watched');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: a track chosen from a list still stays in the list, and is sent without kinds', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        app.act({ type: 'row', index: 0 });
        await waitFor(() => app.state().screen === 'LIST' && M.top(app.state()).items.length === 1, 3000, 'the tracks');
        app.act({ type: 'row', index: 0 });
        await waitFor(() => svc.requests.some((r) => r.cmd === 'play'), 3000, 'play');
        await sleep(300);
        const play = svc.requests.filter((r) => r.cmd === 'play').pop();
        assert.ok(!('kinds' in play), JSON.stringify(play));
        assert.strictEqual(app.state().screen, 'LIST');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app on the GPU renderer with video: status.player.video names the frame file and the picture is drawn fitted; null: none', async () => {
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app, vk } = start(sock, { gpu: 'video' });
    try {
        await waitFor(() => app.state().player && app.state().player.video, 3000, 'the video');
        app.act({ type: 'open-now-playing' });
        await frame(ctx);
        assert.deepStrictEqual(vk.named.filter((n) => n[1]).pop(), [1, FILE], 'the frame file named');
        const op = vk.ops.pop();
        assert.ok(op && op.id === 1 && near(op.x, 337.78) && near(op.y, 0) && near(op.w, 924.44) && near(op.h, 520), JSON.stringify(op));
        // named once, not with every frame
        await frame(ctx); await frame(ctx);
        assert.strictEqual(vk.named.filter((n) => n[1]).length, 1, JSON.stringify(vk.named));
        // the picture goes: forgotten, no op
        svc.state.player = Object.assign({}, svc.state.player, { video: null });
        await waitFor(() => app.state().player.video === null, 3000, 'no video');
        const n = vk.ops.length;
        const cv = await frame(ctx);
        assert.strictEqual(vk.ops.length, n, 'no picture drawn');
        assert.deepStrictEqual(vk.named[vk.named.length - 1], [1, null], 'the renderer forgets it');
        assert.ok(cv.has('Around the World'), 'the cover view: ' + cv.all());
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: a tap or a controller step on the picture shows title and seek bar for 4 s; a tap on the bar then seeks', async () => {
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app, clock } = start(sock, { gpu: 'video' });
    try {
        await waitFor(() => app.state().player && app.state().player.video, 3000, 'the video');
        app.act({ type: 'open-now-playing' });
        let cv = await frame(ctx);
        assert.ok(!cv.has('Around the World'), 'only the picture at first');
        ctx.tap(800, 200);
        cv = await frame(ctx);
        assert.ok(cv.has('Around the World'), 'title over the picture: ' + cv.all());
        const bar = app.info().hits.filter((h) => h.bar)[0];
        assert.ok(bar, 'the seek bar');
        ctx.tap(bar.bar.x + bar.bar.w / 2, bar.y + bar.h / 2);
        await waitFor(() => svc.requests.some((r) => r.cmd === 'seek'), 3000, 'a seek');
        assert.ok(Math.abs(svc.requests.filter((r) => r.cmd === 'seek').pop().position - 87.5) < 2);
        clock.add(4100);
        cv = await frame(ctx);
        assert.ok(!cv.has('Around the World'), 'gone after 4 s');
        app.input({ knob: 1 });
        cv = await frame(ctx);
        assert.ok(cv.has('Around the World'), 'the knob shows them again');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: "Picture only while parked" on and the car moving: the cover view, the sound plays on (no pause); parked again: the picture', async () => {
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app, vk } = start(sock, { gpu: 'video', sets: { videoParkedOnly: true } });
    try {
        await waitFor(() => app.state().player && app.state().player.video && ctx.watched['de.bmw.infotainment.vehicle.Vehicle2'], 3000, 'the video');
        speed(ctx, 50);
        app.act({ type: 'open-now-playing' });
        const cv = await frame(ctx);
        assert.deepStrictEqual(vk.ops, [], 'no picture while moving');
        assert.ok(cv.has('Around the World') && cv.has(/parked/), cv.all());
        await sleep(400);
        assert.ok(!svc.requests.some((r) => r.cmd === 'pause' || r.cmd === 'stop'), 'the sound plays on');
        speed(ctx, 0);
        await frame(ctx);
        assert.strictEqual(vk.ops.length, 1, 'parked: the picture');
        speed(ctx, 30);
        await frame(ctx);
        assert.strictEqual(vk.ops.length, 1, 'moving again: hidden again');
        assert.deepStrictEqual(vk.named[vk.named.length - 1], [1, null]);
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: the setting off (the default): the picture also while driving', async () => {
    assert.strictEqual(SPEC.settings.filter((x) => x.key === 'videoParkedOnly')[0].default, false);
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app, vk } = start(sock, { gpu: 'video' });
    try {
        await waitFor(() => app.state().player && app.state().player.video && ctx.watched['de.bmw.infotainment.vehicle.Vehicle2'], 3000, 'the video');
        speed(ctx, 120);
        app.act({ type: 'open-now-playing' });
        await frame(ctx);
        assert.strictEqual(vk.ops.length, 1, 'the picture while moving');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app without the GPU renderer (software path): no picture, the cover view with "Video picture needs the GPU renderer"', async () => {
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app, vk } = start(sock);
    try {
        await waitFor(() => app.state().player && app.state().player.video, 3000, 'the video');
        app.act({ type: 'open-now-playing' });
        const cv = await frame(ctx);
        assert.deepStrictEqual(vk.ops, []);
        assert.ok(cv.has('Video picture needs the GPU renderer') && cv.has('Around the World'), cv.all());
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: settings "Picture only while parked" (off) and "Video size" (480 / 720 / 1080, 720) in app.json', () => {
    const park = SPEC.settings.filter((x) => x.key === 'videoParkedOnly')[0];
    assert.ok(park, 'the parked setting');
    assert.deepStrictEqual([park.type, park.default, park.label], ['bool', false, 'Picture only while parked']);
    const size = SPEC.settings.filter((x) => x.key === 'videoHeight')[0];
    assert.ok(size, 'the size setting');
    assert.strictEqual(size.type, 'choice');
    assert.deepStrictEqual(size.options.map((o) => o[0]), ['480', '720', '1080']);
    assert.strictEqual(size.default, '720');
    assert.ok(/^Video size/.test(size.label), size.label);
});

test('app: "Video size" is sent as prefs {videoHeight}: once at start when it differs from the service\'s, and when changed', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock, { sets: { videoHeight: '1080' } });
    try {
        await waitFor(() => svc.requests.some((r) => r.cmd === 'prefs' && r.videoHeight), 3000, 'prefs videoHeight');
        await sleep(400);
        const sent = svc.requests.filter((r) => r.cmd === 'prefs' && r.videoHeight);
        assert.deepStrictEqual(sent.map((r) => r.videoHeight), [1080], 'once, a number');
        sent.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), []));
        ctx.settings.set('videoHeight', '480');
        await waitFor(() => svc.requests.filter((r) => r.cmd === 'prefs' && r.videoHeight).length === 2, 3000, 'the change');
        assert.strictEqual(svc.requests.filter((r) => r.cmd === 'prefs' && r.videoHeight).pop().videoHeight, 480);
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('app: the default size (720) equals the service\'s: nothing sent; a service without video (no prefs.videoHeight): nothing sent', async () => {
    for (const prefs of [{ quality: 'HIGH', videoHeight: 720 }, { quality: 'HIGH' }]) {
        const sock = tmpSock();
        const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in', prefs: prefs } });
        const { ctx, app } = start(sock, prefs.videoHeight ? {} : { sets: { videoHeight: '1080' } });
        try {
            await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
            await sleep(500);
            assert.ok(!svc.requests.some((r) => r.cmd === 'prefs' && r.videoHeight), JSON.stringify(prefs));
            noErrors(ctx);
        } finally { app.stop(); await svc.close(); }
    }
});

test('app (R1): garbage in status.player.video and in a video item never crashes; drawn every time', async () => {
    const sock = tmpSock();
    const svc = await videoService(sock);
    const { ctx, app } = start(sock, { gpu: 'video' });
    const bad = ['x', 5, [], { file: 5 }, { file: '/dev/shm/mgu-video-../x', width: 1280, height: 720 }, { file: FILE, width: 1e9, height: 720 },
        { file: FILE, width: 1280, height: 720, extra: { deep: [1, 2] } }, null, { file: '/dev/shm/mgu-video-' + 'A'.repeat(5000), width: 1, height: 1 }];
    try {
        await waitFor(() => app.state().player && app.state().player.video, 3000, 'the video');
        app.act({ type: 'open-now-playing' });
        for (const v of bad) {
            const n = ctx.frames.length;
            svc.state.player = Object.assign({}, svc.state.player, { video: v, track: Object.assign({}, VIDEO, { kind: v && v.file === 5 ? 7 : 'video' }) });
            await sleep(250);
            await frame(ctx);
            assert.ok(ctx.frames.length > n, 'drawn with ' + JSON.stringify(v).slice(0, 60));
        }
        noErrors(ctx);
        assert.strictEqual(app.state().screen, 'NOW_PLAYING');
    } finally { app.stop(); await svc.close(); }
});

run();
