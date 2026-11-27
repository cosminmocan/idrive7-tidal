'use strict';
/**
 * D1-D7 together: apps/cmocan_tidal/tidal.js, the app's wiring of client, model, screens, input, covers, speakers,
 * wheel and speed (main.js only hands it the kit's ctx), run against the fake service with a stand-in for the kit's
 * ctx. It polls `status` every 1 to 2 s, asks for a login code by itself, loads lists, plays, controls, follows the
 * steering wheel and the iDrive controller, sends the quality setting, and survives the service misbehaving (R1).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const parkedKit = require('../kit/runtime/parked');
const { createFakeService, TRACK } = require('./fakes/fake_service');
const P = require('./fakes/protocol');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { createApp } = require('../apps/cmocan_tidal/tidal');
const { createCcu } = require('../apps/cmocan_tidal/ccu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-app-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));

function fakeCtx() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-data-'));
    const handlers = {}, loops = {}, frames = [], logs = [], watched = {}, setL = [];
    // the settings as a fresh install has them: app.json's defaults
    const values = {};
    SPEC.settings.forEach((x) => { values[x.key] = x.default; });
    const ctx = {
        dataDir, handlers, loops, frames, logs, watched,
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
    return ctx;
}
function start(sock, opts) {
    const ctx = fakeCtx();
    const app = createApp(ctx, Object.assign({ socketPath: sock, pollMs: 150, parked: parkedKit.watch(ctx, ctx.log), setImage() {}, decodeJpeg: decodeJpeg }, opts || {}));
    return { ctx, app };
}
const cmds = (svc) => svc.requests.map((r) => r.cmd);
const lastOf = (svc, cmd) => svc.requests.filter((r) => r.cmd === cmd).pop();
const noErrors = (ctx) => assert.deepStrictEqual(ctx.logs.filter((l) => /^error/.test(l)), []);

test('no service: NO_SERVICE, drawn, no error', async () => {
    const { ctx, app } = start(tmpSock());
    try {
        await waitFor(() => app.state().screen === 'NO_SERVICE' && !app.state().starting, 3000, 'NO_SERVICE');
        await ctx.loops.MAIN();
        assert.ok(ctx.frames.length >= 1);
        assert.ok(ctx.frames[ctx.frames.length - 1].has(/not installed or not running/));
        noErrors(ctx);
    } finally { app.stop(); }
});

test('logged out: a login code is asked for by itself, once, and shown; logged in: the library', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().login && app.state().login.url, 3000, 'a code');
        await sleep(500);
        assert.strictEqual(cmds(svc).filter((c) => c === 'login-start').length, 1, 'once');
        await ctx.loops.MAIN();
        const cv = ctx.frames[ctx.frames.length - 1];
        assert.ok(cv.has('ABCDE'), cv.all());
        assert.ok(app.info().qr, 'the QR code is drawn');
        svc.state.login = 'logged-in';
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        svc.requests.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), [], JSON.stringify(r)));
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: a login already pending in the service (the app restarted): its code from the status, no login-cancel, no login-start', async () => {
    const sock = tmpSock();
    const lp = { url: 'https://link.tidal.com/KLMNO', userCode: 'KLMNO', expiresAt: Date.now() + 200000 };
    const svc = await createFakeService({ socketPath: sock, state: { login: 'login-pending', loginPending: lp } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().login && app.state().login.url, 3000, 'a code');
        await sleep(500);
        assert.strictEqual(app.state().login.userCode, 'KLMNO');
        const c = cmds(svc);
        assert.ok(c.indexOf('login-cancel') < 0 && c.indexOf('login-start') < 0, c.join(','));
        await ctx.loops.MAIN();
        const cv = ctx.frames[ctx.frames.length - 1];
        assert.ok(cv.has('KLMNO') && app.info().qr, cv.all());
        assert.ok(cv.has(/valid for 4 more minutes/), cv.all());
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: the login refused on the phone (loginError login-denied): its message, no new code until asked; then one', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-out', loginError: 'login-denied' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LOGIN', 3000, 'LOGIN');
        await sleep(500);
        assert.strictEqual(cmds(svc).indexOf('login-start'), -1, 'no code by itself');
        await ctx.loops.MAIN();
        assert.ok(ctx.frames[ctx.frames.length - 1].has(/refused on the phone/i), ctx.frames[ctx.frames.length - 1].all());
        app.input({ press: true });
        await waitFor(() => app.state().login && app.state().login.userCode === 'ABCDE', 3000, 'a new code');
        assert.strictEqual(cmds(svc).filter((c) => c === 'login-start').length, 1);
        assert.strictEqual(cmds(svc).indexOf('login-cancel'), -1, 'nothing to cancel');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: the code runs out while shown (pending -> logged-out, login-expired): "expired", a new code on request', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().login && app.state().login.url, 3000, 'a code');
        await waitFor(() => app.state().service.login === 'login-pending', 3000, 'pending');
        svc.state.login = 'logged-out'; svc.state.loginPending = null; svc.state.loginError = 'login-expired';
        await waitFor(() => app.state().login && app.state().login.expired, 3000, 'expired');
        await ctx.loops.MAIN();
        assert.ok(ctx.frames[ctx.frames.length - 1].has(/code expired/i));
        await sleep(400);
        assert.strictEqual(cmds(svc).filter((c) => c === 'login-start').length, 1, 'not by itself');
        app.input({ press: true });
        await waitFor(() => cmds(svc).filter((c) => c === 'login-start').length === 2, 3000, 'asked again');
        await waitFor(() => app.state().login && app.state().login.url && !app.state().login.expired, 3000, 'a new code shown');
    } finally { app.stop(); await svc.close(); }
});

test('login-start refused: the screen offers to try again (no request storm)', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    svc.answer = (r) => (r.cmd === 'login-start' ? { id: r.id, ok: false, error: 'tidal-error' } : undefined);
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().login && app.state().login.failed, 3000, 'failed');
        await sleep(600);
        assert.strictEqual(cmds(svc).filter((c) => c === 'login-start').length, 1);
        if (app.state().screen === 'ERROR') app.act({ type: 'back' });
        await ctx.loops.MAIN();
        assert.ok(ctx.frames[ctx.frames.length - 1].has(/new code/i), ctx.frames[ctx.frames.length - 1].all());
        svc.answer = null;
        app.input({ press: true });
        await waitFor(() => app.state().login && app.state().login.url, 3000, 'a code after asking again');
    } finally { app.stop(); await svc.close(); }
});

test('library -> favourite tracks -> play: the right requests, then now playing; bar buttons and the wheel control it', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        await ctx.loops.MAIN();
        app.input({ press: true });
        await waitFor(() => app.state().screen === 'LIST' && app.state().stack[0].items.length === 1, 3000, 'list loaded');
        assert.deepStrictEqual(lastOf(svc, 'favorites'), { id: lastOf(svc, 'favorites').id, cmd: 'favorites', kind: 'tracks', offset: 0, limit: 50 });
        await ctx.loops.MAIN();
        app.input({ press: true });
        await waitFor(() => app.state().screen === 'NOW_PLAYING', 3000, 'NOW_PLAYING');
        const play = lastOf(svc, 'play');
        assert.deepStrictEqual([play.tracks, play.index], [[TRACK.id], 0]);
        svc.state.player = { state: 'playing', track: TRACK, position: 10, duration: 320, queueIndex: 0, queueLength: 1, quality: 'LOSSLESS', error: null };
        await waitFor(() => app.state().player && app.state().player.state === 'playing', 3000, 'playing');
        await ctx.handlers.BTN_PLAY();
        await waitFor(() => cmds(svc).indexOf('pause') >= 0, 2000, 'pause sent');
        await ctx.handlers.BTN_NEXT();
        await ctx.handlers.BTN_PREV();
        await waitFor(() => cmds(svc).indexOf('prev') >= 0, 2000, 'prev sent');
        assert.ok(cmds(svc).indexOf('next') >= 0);
        const wheel = ctx.watched['de.bmw.infotainment.controlelements.SteeringWheelPushButton'];
        const n = cmds(svc).filter((c) => c === 'next').length;
        wheel.statusSearchSwitch1({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS' });
        wheel.statusSearchSwitch1({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' });
        await waitFor(() => cmds(svc).filter((c) => c === 'next').length === n + 1, 2000, 'wheel next');
        // phase 2 (S2): held longer than 0.7 s it winds instead: one seek at release, no skip
        wheel.statusSearchSwitch1({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS' });
        await sleep(850);
        wheel.statusSearchSwitch1({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' });
        await waitFor(() => cmds(svc).indexOf('seek') >= 0, 2000, 'wheel seek');
        assert.ok(lastOf(svc, 'seek').position <= 1, '10 s back from 0:10 or so: the start: ' + lastOf(svc, 'seek').position);
        assert.strictEqual(cmds(svc).filter((c) => c === 'prev').length, 1, 'only the bar button\'s prev: the long press did not skip');
        await ctx.loops.MAIN();
        await waitFor(() => cmds(svc).indexOf('cover') >= 0, 2000, 'the cover asked for');
        assert.strictEqual(lastOf(svc, 'cover').coverId, TRACK.coverId);
        svc.requests.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), [], JSON.stringify(r)));
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('the iDrive controller (FrontCCU events) and a tap move and act', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        await ctx.loops.MAIN();
        const ev = (k, pb, df) => ctx.ccu({ frontRotaryEncoderOperation: k, frontRotaryEncoderPushButton: pb, frontRotaryEncoderDeflection: df });
        ev(100, 0, 0); ev(102, 0, 0);                               // two steps clockwise
        assert.strictEqual(app.state().library.sel, 2);
        ev(102, 1, 0); ev(102, 0, 0);                               // pressed: Playlists
        await waitFor(() => app.state().screen === 'LIST', 2000, 'LIST');
        assert.strictEqual(app.state().stack[0].source.cmd, 'playlists');
        ev(102, 0, 10); ev(102, 0, 0);                              // pushed left: back
        assert.strictEqual(app.state().screen, 'LIBRARY');
        await ctx.loops.MAIN();
        const row = app.info().hits.filter((h) => h.row === 3)[0];
        ctx.tap(row.x + 5, row.y + 5);
        await waitFor(() => app.state().screen === 'LIST' && app.state().stack[0].source.cmd === 'mixes', 2000, 'mixes by tap');
    } finally { app.stop(); await svc.close(); }
});

test('without the GPU renderer (the HMI\'s own bar): Up, Down and Select move through lists; where the kit runs the screen they are hidden', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const hidden = [];
    const ctx0 = fakeCtx();
    ctx0.hideButton = (id) => hidden.push(id);
    const app = createApp(ctx0, { socketPath: sock, pollMs: 150, parked: parkedKit.watch(ctx0, ctx0.log), setImage() {}, decodeJpeg: decodeJpeg });
    try {
        assert.deepStrictEqual(hidden.sort(), ['BTN_DOWN', 'BTN_OK', 'BTN_UP']);
        const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));
        const ids = spec.screens[0].buttons.map((b) => b[0]);
        ['BTN_UP', 'BTN_DOWN', 'BTN_OK', 'BTN_PLAY', 'BTN_PREV', 'BTN_NEXT', 'BTN_LIBRARY', 'BTN_SETTINGS'].forEach((b) => assert.ok(ids.indexOf(b) >= 0, b));
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        await ctx0.handlers.BTN_DOWN(); await ctx0.handlers.BTN_DOWN(); await ctx0.handlers.BTN_DOWN(); await ctx0.handlers.BTN_UP();
        assert.strictEqual(app.state().library.sel, 2);
        await ctx0.handlers.BTN_OK();
        await waitFor(() => app.state().screen === 'LIST' && app.state().stack[0].source.cmd === 'playlists', 2000, 'playlists');
        await ctx0.handlers.BTN_LIBRARY();
        assert.strictEqual(app.state().screen, 'LIBRARY');
    } finally { app.stop(); await svc.close(); }
});

test('the controller decoder: knob steps (16-bit counter wrapping), press and push on their edges, no controller', () => {
    const out = [];
    const c = createCcu((e) => out.push(e));
    const ev = (k, pb, df) => c({ frontRotaryEncoderOperation: k, frontRotaryEncoderPushButton: pb, frontRotaryEncoderDeflection: df });
    ev(65534, 0, 0); ev(1, 0, 0);
    assert.deepStrictEqual(out, [{ knob: 3 }]);
    ev(0, 0, 0);
    assert.deepStrictEqual(out[1], { knob: -1 });
    ev(0, 1, 0); ev(0, 1, 0); ev(0, 0, 0);
    assert.deepStrictEqual(out.slice(2), [{ press: true }], 'one press, on the way down');
    ev(0, 0, 7); ev(0, 0, 7); ev(0, 0, 0);
    assert.deepStrictEqual(out.slice(3), [{ tilt: 'S' }]);
    ev(0, 15, 15); ev(500, 0, 0); ev(null, 'x', {});
    assert.strictEqual(out.length, 4, 'no controller, a counter reset and garbage do nothing');
});

test('status is asked for every 1 to 2 s by default', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { app } = start(sock, { pollMs: undefined });
    try {
        await sleep(3600);
        const n = cmds(svc).filter((c) => c === 'status').length;
        assert.ok(n >= 2 && n <= 4, n + ' status requests in 3.6 s');
    } finally { app.stop(); await svc.close(); }
}, { timeout: 15000 });

test('contract 2: the quality setting: HIGH by default, "High (AAC 320)"; Lossless says it plays as High for now; labels short', () => {
    const q = SPEC.settings.filter((x) => x.key === 'quality')[0];
    assert.strictEqual(q.default, 'HIGH');
    assert.strictEqual(q.default, P.DEFAULT_QUALITY, 'the same default as the service');
    const labels = {};
    q.options.forEach((o) => { labels[o[0]] = o[1]; });
    assert.deepStrictEqual(Object.keys(labels).sort(), P.QUALITIES.slice().sort());
    assert.strictEqual(labels.HIGH, 'High (AAC 320)');
    assert.ok(/Lossless \(FLAC\)/.test(labels.LOSSLESS) && /as High/.test(labels.LOSSLESS), labels.LOSSLESS);
    q.options.forEach((o) => assert.ok(o[1].length <= 40, 'short enough for the HMI list: ' + o[1]));
    assert.ok(q.label.length <= 40, q.label);
});

test('the quality setting is sent to the service when it changes', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        ctx.settings.set('quality', 'LOSSLESS');
        await waitFor(() => lastOf(svc, 'prefs') && lastOf(svc, 'prefs').quality === 'LOSSLESS', 2000, 'prefs sent');
        assert.strictEqual(svc.state.prefs.quality, 'LOSSLESS');
        ctx.settings.set('quality', 'HIGH');
        await waitFor(() => lastOf(svc, 'prefs').quality === 'HIGH', 2000, 'HIGH sent');
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: at start, the default setting (HIGH) equals the service default: nothing is sent', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    try {
        assert.strictEqual(ctx.settings.get('quality'), 'HIGH');
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        await sleep(600);
        assert.strictEqual(cmds(svc).filter((c) => c === 'prefs').length, 0, cmds(svc).join(','));
    } finally { app.stop(); await svc.close(); }
});

test('at start, a quality setting that differs from the service\'s is sent once', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const ctx = fakeCtx();
    ctx.settings.set('quality', 'LOSSLESS');
    const app = createApp(ctx, { socketPath: sock, pollMs: 150, parked: parkedKit.watch(ctx, ctx.log), setImage() {}, decodeJpeg: decodeJpeg });
    try {
        await waitFor(() => svc.state.prefs.quality === 'LOSSLESS', 3000, 'LOSSLESS sent');
        await sleep(600);
        assert.strictEqual(cmds(svc).filter((c) => c === 'prefs').length, 1);
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: mixes, a mix and an album are asked for by page, and the next page comes as the knob nears the end', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const many = [];
    for (let i = 0; i < 120; i++) many.push(Object.assign({}, TRACK, { id: 1000 + i, title: 'T' + i }));
    svc.answer = (r) => (r.cmd === 'album' ? { id: r.id, ok: true, total: many.length, items: many.slice(r.offset, r.offset + r.limit) } : undefined);
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        app.act({ type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } });
        await waitFor(() => lastOf(svc, 'mixes'), 2000, 'mixes asked for');
        assert.deepStrictEqual([lastOf(svc, 'mixes').offset, lastOf(svc, 'mixes').limit], [0, 50]);
        await waitFor(() => app.state().stack[0].items.length === 1, 2000, 'mixes loaded');
        app.input({ press: true });
        await waitFor(() => lastOf(svc, 'mix'), 2000, 'mix asked for');
        assert.deepStrictEqual([lastOf(svc, 'mix').mixId, lastOf(svc, 'mix').offset, lastOf(svc, 'mix').limit], ['0123456789abcdef0123456789abcd', 0, 50]);
        app.act({ type: 'open-list', key: 'album:1', title: 'Album', kind: 'tracks', source: { cmd: 'album', params: { albumId: 17927863 } } });
        await waitFor(() => app.state().stack.length === 3 && app.state().stack[2].items.length === 50, 2000, 'the first page');
        for (let i = 0; i < 48; i++) app.input({ knob: 1 });
        await waitFor(() => app.state().stack[2].items.length === 100, 2000, 'the second page');
        assert.deepStrictEqual(svc.requests.filter((r) => r.cmd === 'album').map((r) => r.offset), [0, 50]);
        svc.requests.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), [], JSON.stringify(r)));
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('contract 2: the service skips a track of the queue (player.skipped): now playing tells the user, the list greys it out', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const two = [TRACK, Object.assign({}, TRACK, { id: 17927865, title: 'Aerodynamic' })];
    svc.answer = (r) => (r.cmd === 'favorites' ? { id: r.id, ok: true, total: 2, items: two } : undefined);
    const { ctx, app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        app.input({ press: true });
        await waitFor(() => app.state().screen === 'LIST' && app.state().stack[0].items.length === 2, 3000, 'list loaded');
        app.input({ press: true });
        await waitFor(() => app.state().screen === 'NOW_PLAYING', 3000, 'NOW_PLAYING');
        svc.state.player = Object.assign({}, svc.state.player, { state: 'playing', track: TRACK, position: 1, duration: 320, queueIndex: 0, queueLength: 2, quality: 'HIGH' });
        await waitFor(() => app.state().player && app.state().player.state === 'playing', 3000, 'playing');
        svc.state.player = Object.assign({}, svc.state.player, { skipped: [{ id: 17927865, error: 'not-available' }] });
        await waitFor(() => app.state().message === 'Skipped: Aerodynamic (not available)', 3000, 'the notice');
        await ctx.loops.MAIN();
        assert.ok(ctx.frames[ctx.frames.length - 1].has('Skipped: Aerodynamic (not available)'), ctx.frames[ctx.frames.length - 1].all());
        app.act({ type: 'back' });
        assert.strictEqual(app.state().screen, 'LIST');
        await ctx.loops.MAIN();
        const t = ctx.frames[ctx.frames.length - 1].texts.filter((x) => x.s === 'Aerodynamic')[0];
        assert.strictEqual(t.color, themes.theme('m_tricolour').dim, 'greyed out');
        noErrors(ctx);
    } finally { app.stop(); await svc.close(); }
});

test('errors from the service: a list that is not found shows ERROR; back returns', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    svc.answer = (r) => (r.cmd === 'mixes' ? { id: r.id, ok: false, error: 'not-found' } : undefined);
    const { app } = start(sock);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        app.act({ type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } });
        await waitFor(() => app.state().screen === 'ERROR', 2000, 'ERROR');
        assert.strictEqual(app.state().message, 'Not found');
        app.act({ type: 'back' });
        assert.strictEqual(app.state().screen, 'LIST');
    } finally { app.stop(); await svc.close(); }
});

test('the service sends garbage and goes away: the app carries on, shows NO_SERVICE, and comes back with it (R1)', async () => {
    const sock = tmpSock();
    let svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const { ctx, app } = start(sock);
    const escaped = [];
    const onErr = (e) => escaped.push(e);
    process.on('uncaughtException', onErr);
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        svc.conns.forEach((c) => { c.write('garbage\n{"id":1,"ok":true,"state":"nope"}\n{"id":'); c.write('x'.repeat(100000)); });
        svc.answer = (r) => (r.cmd === 'status' ? { id: r.id, ok: true, state: { login: 99, player: 'x', online: 'maybe' } } : undefined);
        await sleep(400);
        await ctx.loops.MAIN();
        svc.answer = null;
        await svc.close();
        await waitFor(() => app.state().screen === 'NO_SERVICE', 4000, 'NO_SERVICE');
        await ctx.loops.MAIN();
        svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
        await waitFor(() => app.state().screen === 'LIBRARY', 8000, 'back');
        assert.deepStrictEqual(escaped.map(String), []);
        noErrors(ctx);
    } finally { process.removeListener('uncaughtException', onErr); app.stop(); await svc.close(); }
}, { timeout: 20000 });

run();
