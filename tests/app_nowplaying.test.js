'use strict';
/**
 * D5: now playing. Cover, title, artist, progress, play or pause, next, previous (screens.js, nav.js); the
 * progress follows `status` and never jumps backwards on a late answer (progress.js); buffering and errors show;
 * a missing cover is a placeholder (covers.js decodes the `cover` answer's JPEG with jpeg.js); the steering wheel's
 * skip buttons (SteeringWheelPushButton.statusSearchSwitch1) skip only while a track is on (wheel.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const P = require('./fakes/protocol');
const { defaultState, TRACK } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');
const N = require('../apps/cmocan_tidal/nav');
const NP = require('../apps/cmocan_tidal/nowplaying');
const { createProgress } = require('../apps/cmocan_tidal/progress');
const { createWheel } = require('../apps/cmocan_tidal/wheel');
const { createCovers } = require('../apps/cmocan_tidal/covers');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');

const theme = themes.theme('m_tricolour');
const JPEG = fs.readFileSync(path.join(__dirname, 'golden', 'cover_32x32.jpg'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function playing(state, extra) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = Object.assign({ state: state || 'playing', track: Object.assign({}, TRACK, { title: 'Știrile de azi', artists: ['Ana Blandiană', 'Grigore'] }),
        position: 42.5, duration: 320, queueIndex: 0, queueLength: 14, quality: 'LOSSLESS', error: null }, extra || {});
    let s = M.reduce(M.initial(), { type: 'status', state: st });
    return M.reduce(s, { type: 'open-now-playing' });
}
function drawn(s, ui) { const cv = spyCanvas(); const info = S.draw(cv, theme, s, Object.assign({ now: 0 }, ui || {})); return { cv: cv, info: info }; }
const btn = (info, cmd) => info.hits.filter((h) => h.button && h.act && h.act.cmd === cmd)[0];

test('now playing shows the cover place, the title and artists (converted), the times and three controls', () => {
    const { cv, info } = drawn(playing(), { position: 42.5, duration: 320 });
    assert.ok(cv.has('Stirile de azi'), cv.all());
    assert.ok(cv.has('Ana Blandiana, Grigore'), cv.all());
    assert.ok(cv.has('Discovery'), 'the album');
    assert.ok(cv.has('0:42') && cv.has('5:20'), cv.all());
    assert.strictEqual(info.hits.filter((h) => h.button).length, 3);
    assert.ok(btn(info, 'prev') && btn(info, 'pause') && btn(info, 'next'));
});

test('each control sends the right command (knob along them, press, tap); play / pause follows the state', () => {
    const s = playing();
    const { info } = drawn(s);
    assert.deepStrictEqual(N.input(s, info, { press: true }), [{ type: 'control', cmd: 'pause' }], 'a press with nothing focused: play / pause');
    const p = btn(info, 'prev'), n = btn(info, 'next');
    assert.deepStrictEqual(N.input(s, info, { tap: { x: p.x + 2, y: p.y + 2 } }), [{ type: 'control', cmd: 'prev' }]);
    assert.deepStrictEqual(N.input(s, info, { tap: { x: n.x + 2, y: n.y + 2 } }), [{ type: 'control', cmd: 'next' }]);
    assert.deepStrictEqual(N.input(s, info, { knob: 1 }), [{ type: 'focus', index: 2 }], 'the knob starts at play / pause');
    const f2 = drawn(s, { focus: 2 }).info;
    assert.deepStrictEqual(N.input(s, f2, { press: true }), [{ type: 'control', cmd: 'next' }]);
    const f0 = drawn(s, { focus: 0 }).info;
    assert.deepStrictEqual(N.input(s, f0, { press: true }), [{ type: 'control', cmd: 'prev' }]);
    const ps = playing('paused');
    assert.deepStrictEqual(N.input(ps, drawn(ps).info, { press: true }), [{ type: 'control', cmd: 'resume' }]);
    ['playing', 'buffering', 'loading'].forEach((st) => assert.strictEqual(NP.playPause(playing(st).player), 'pause', st));
    ['paused', 'error'].forEach((st) => assert.strictEqual(NP.playPause(playing(st).player), 'resume', st));
    assert.strictEqual(NP.playPause(null), null, 'nothing to play');
    ['pause', 'resume', 'next', 'prev'].forEach((c) => assert.ok(P.COMMANDS.indexOf(c) >= 0, c));
    assert.deepStrictEqual(N.input(s, info, { tilt: 'W' }), [{ type: 'back' }]);
});

test('progress follows status and moves on between answers while playing, not while paused', () => {
    const pr = createProgress();
    pr.update({ state: 'playing', track: { id: 1 }, position: 10, duration: 100, queueIndex: 0 }, 1, 0);
    assert.strictEqual(pr.at(0).pos, 10);
    assert.strictEqual(pr.at(1500).pos, 11.5);
    assert.strictEqual(pr.at(1500).dur, 100);
    pr.update({ state: 'paused', track: { id: 1 }, position: 12, duration: 100, queueIndex: 0 }, 2, 2000);
    assert.strictEqual(pr.at(5000).pos, 12);
    assert.strictEqual(pr.at(10000000).pos, 12);
    pr.update({ state: 'playing', track: { id: 1 }, position: 99.5, duration: 100, queueIndex: 0 }, 3, 6000);
    assert.strictEqual(pr.at(9000).pos, 100, 'never past the end');
});

test('progress does not jump backwards: a late answer is ignored, a slightly older position waits for the real one', () => {
    const pr = createProgress();
    pr.update({ state: 'playing', track: { id: 1 }, position: 20, duration: 100, queueIndex: 0 }, 5, 0);
    pr.update({ state: 'playing', track: { id: 1 }, position: 12, duration: 100, queueIndex: 0 }, 4, 100);   // the answer to an older request
    assert.ok(pr.at(100).pos >= 20, 'late answer ignored: ' + pr.at(100).pos);
    const shown = pr.at(900).pos;                                                                              // 20.9
    pr.update({ state: 'playing', track: { id: 1 }, position: 20.5, duration: 100, queueIndex: 0 }, 6, 900);
    let last = shown;
    for (let t = 900; t < 3000; t += 100) { const p = pr.at(t).pos; assert.ok(p >= last, 'at ' + t + ': ' + p + ' < ' + last); last = p; }
    assert.ok(Math.abs(pr.at(3000).pos - 22.6) < 1e-9, 'then it follows the real position: ' + pr.at(3000).pos);
});

test('progress: a new track, or a restart of this one (prev after 3 s), starts again from its position', () => {
    const pr = createProgress();
    pr.update({ state: 'playing', track: { id: 1 }, position: 50, duration: 100, queueIndex: 0 }, 1, 0);
    pr.update({ state: 'playing', track: { id: 2 }, position: 0.2, duration: 200, queueIndex: 1 }, 2, 1000);
    assert.strictEqual(pr.at(1000).pos, 0.2);
    assert.strictEqual(pr.at(1000).dur, 200);
    pr.update({ state: 'playing', track: { id: 2 }, position: 60, duration: 200, queueIndex: 1 }, 3, 2000);
    pr.update({ state: 'playing', track: { id: 2 }, position: 0.1, duration: 200, queueIndex: 1 }, 4, 3000);
    assert.strictEqual(pr.at(3000).pos, 0.1, 'restarted');
    pr.update(null, 5, 4000);
    assert.strictEqual(pr.at(4000).pos, 0);
    pr.update({ state: 'playing', track: 'garbage', position: 'x' }, 6, 5000);
    assert.strictEqual(pr.at(5000).pos, 0, 'garbage does not throw');
});

test('buffering, loading and a player error are shown', () => {
    assert.ok(drawn(playing('buffering')).cv.has(/buffering/i));
    assert.ok(drawn(playing('loading')).cv.has(/loading/i));
    const e = drawn(playing('error', { error: 'decode' })).cv;
    assert.ok(e.has(/error/i) && e.has(/decode/), e.all());
    const idle = drawn(M.reduce(playing('idle', { track: null }), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in' }) })).cv;
    assert.ok(idle.has(/nothing is playing/i), idle.all());
});

test('contract 2: a skipped track: the notice shows on now playing (for a few seconds), the track is greyed out in its list', () => {
    const other = Object.assign({}, TRACK, { id: 555, title: 'Gone track' });
    let s = M.reduce(M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in' }) }),
        { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'album', params: { albumId: 1 } } });
    s = M.reduce(s, { type: 'list-loaded', key: 'k', offset: 0, total: 2, items: [TRACK, other] });
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = Object.assign({}, st.player, { state: 'playing', track: TRACK, position: 1, duration: 320, queueIndex: 0, queueLength: 2, quality: 'HIGH' });
    s = M.reduce(M.reduce(s, { type: 'status', state: st }), { type: 'played' });
    const st2 = JSON.parse(JSON.stringify(st));
    st2.player.skipped = [{ id: 555, error: 'not-available' }];
    s = M.reduce(s, { type: 'status', state: st2 });
    const on = drawn(s, { now: 1000, toastUntil: 5000 }).cv;
    assert.ok(on.has('Skipped: Gone track (not available)'), on.all());
    assert.ok(!drawn(s, { now: 6000, toastUntil: 5000 }).cv.has(/Skipped/), 'gone after its time');
    const list = drawn(M.reduce(s, { type: 'back' }), { now: 6000, toastUntil: 5000 }).cv;
    assert.strictEqual(list.texts.filter((x) => x.s === 'Gone track')[0].color, theme.dim, 'greyed out');
    assert.strictEqual(list.texts.filter((x) => x.s === TRACK.title)[0].color, theme.text);
});

test('a missing cover shows a placeholder; a cover that came is drawn', () => {
    const none = drawn(playing(), { cover: () => null });
    assert.strictEqual(none.info.cover, 'placeholder');
    assert.strictEqual(none.cv.images.length, 0);
    const noId = drawn(playing('playing', { track: Object.assign({}, TRACK, { coverId: null }) }), { cover: () => ({ id: 300, w: 10, h: 10 }) });
    assert.strictEqual(noId.info.cover, 'placeholder', 'a track without a cover id');
    const got = drawn(playing(), { cover: (id) => (id === TRACK.coverId ? { id: 301, w: 320, h: 320 } : null) });
    assert.strictEqual(got.info.cover, 'image');
    assert.strictEqual(got.cv.images[0].id, 301);
});

test('covers: asked for once, decoded from the JPEG, registered as an image; bad data is a placeholder, never a throw', async () => {
    const asked = [], images = [];
    let answer = { ok: true, mime: 'image/jpeg', data: JPEG.toString('base64') };
    const covers = createCovers({ request: (cmd, p) => { asked.push([cmd, p.coverId]); return Promise.resolve(answer); },
        decode: decodeJpeg, setImage: (id, w, h, px) => images.push({ id: id, w: w, h: h, n: px.length, px: px }), size: 64, log: { warn() {}, info() {} } });
    assert.strictEqual(covers.get('c1'), null, 'not yet');
    assert.strictEqual(covers.get('c1'), null);
    await sleep(30);
    const e = covers.get('c1');
    assert.ok(e, 'decoded');
    assert.deepStrictEqual(asked, [['cover', 'c1']], 'asked once');
    assert.strictEqual(images.length, 1);
    assert.deepStrictEqual([images[0].w, images[0].h, images[0].n], [64, 64, 64 * 64 * 4]);
    const left = images[0].px.slice(0, 4), right = images[0].px.slice(63 * 4, 63 * 4 + 4);
    assert.ok(left[0] > 150 && left[2] < 90, 'red on the left: ' + Array.from(left));
    assert.ok(right[2] > 150 && right[0] < 90, 'blue on the right: ' + Array.from(right));
    assert.strictEqual(e.id, images[0].id);
    // bad answers: not a JPEG, not base64, an error, nothing
    const bad = [{ ok: true, data: 'bm90IGEganBlZw==' }, { ok: true, data: '%%%' }, { ok: true, data: 42 }, { ok: false, error: 'not-found' }, null, { ok: true, data: Buffer.alloc(300 * 1024).toString('base64') }];
    for (let i = 0; i < bad.length; i++) {
        answer = bad[i];
        assert.strictEqual(covers.get('bad' + i), null);
        await sleep(20);
        assert.strictEqual(covers.get('bad' + i), null, 'placeholder for bad answer ' + i);
    }
    assert.strictEqual(covers.get(null), null);
    assert.strictEqual(covers.get(''), null);
    const n = asked.length;
    covers.get('bad0');
    assert.strictEqual(asked.length, n, 'a failed cover is not asked for again at once');
});

test('the steering wheel: skip right is next, left is previous, on release, only while a track is on', () => {
    const skips = [];
    let on = true;
    const w = createWheel({ skip: (d) => skips.push(d), active: () => on });
    const v = (x) => ({ operationPushButtonAudioAutomaticTuningSteeringWheel: x });
    w.onSwitch(v('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS'));
    assert.deepStrictEqual(skips, [], 'not while held');
    w.onSwitch(v('KEINE_AKTION'));
    assert.deepStrictEqual(skips, [1]);
    w.onSwitch('SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS');
    w.onSwitch('KEINE_AKTION');
    assert.deepStrictEqual(skips, [1, -1], 'the plain string form too');
    on = false;
    w.onSwitch(v('SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS')); w.onSwitch(v('KEINE_AKTION'));
    assert.deepStrictEqual(skips, [1, -1], 'nothing on: the radio keeps its own skip');
    [null, undefined, 42, {}, [], { operationPushButtonAudioAutomaticTuningSteeringWheel: 7 }, 'KEINE_AKTION'].forEach((x) => w.onSwitch(x));
    assert.deepStrictEqual(skips, [1, -1], 'garbage does nothing');
    assert.strictEqual(NP.skipCmd(1), 'next');
    assert.strictEqual(NP.skipCmd(-1), 'prev');
    // "a track is on": the model's view
    assert.strictEqual(M.trackOn(playing('playing')), true);
    assert.strictEqual(M.trackOn(playing('paused')), true);
    assert.strictEqual(M.trackOn(playing('idle')), false);
    assert.strictEqual(M.trackOn(playing('error')), false);
});

run();
