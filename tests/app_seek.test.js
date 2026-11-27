'use strict';
/**
 * Phase 2, S2: seek in the car app (docs/PROTOCOL.md section 1, `seek {position}`). The progress bar on now playing
 * takes a finger (the position follows it, one `seek` when it lifts); the controller, on the bar, moves the position
 * in 10 s steps (one `seek` 500 ms after the last step); the steering wheel's skip buttons held longer than 0.7 s
 * wind 10 s for every 0.5 s (one `seek` at release, never a skip too). While a seek is on its way the bar shows the
 * target and a late status does not pull it back. Never more than 2 seek requests a second. Rule R1 for the answers.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const { createFakeService, defaultState, TRACK } = require('./fakes/fake_service');
const P = require('./fakes/protocol');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');
const N = require('../apps/cmocan_tidal/nav');
const { createProgress } = require('../apps/cmocan_tidal/progress');
const { createWheel } = require('../apps/cmocan_tidal/wheel');
const { createSeeker, STEP_S, SEND_GAP_MS } = require('../apps/cmocan_tidal/seek');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { createApp } = require('../apps/cmocan_tidal/tidal');

const theme = themes.theme('m_tricolour');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const turn = () => new Promise((r) => setImmediate(r));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-seek-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}

/** a clock and timers a test moves by hand */
function fakeClock() {
    let t = 0, n = 0;
    const q = [];
    return {
        now: () => t,
        setTimeout(fn, ms) { const h = { at: t + Math.max(0, ms || 0), fn: fn, n: n++ }; q.push(h); return h; },
        clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
        /** ms on, running what falls due on the way (and letting promises settle after each) */
        async advance(ms) {
            const end = t + ms;
            await turn();
            for (;;) {
                q.sort((a, b) => a.at - b.at || a.n - b.n);
                if (!q.length || q[0].at > end) break;
                const h = q.shift();
                t = h.at;
                h.fn();
                await turn();
            }
            t = end;
            await turn();
        },
    };
}

/* ---------- the seeker: the target, when it is sent, how often ---------- */

function seeker(clock, extra) {
    const sent = [], done = [];
    const w = { pos: 100, dur: 320, key: 'a/0' };
    let answer = (pos, id) => ({ id: id, ok: true });
    const sk = createSeeker(Object.assign({
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        where: () => w,
        send: (pos) => { sent.push({ pos: pos, at: clock.now() }); return Promise.resolve(answer(pos, 100 + sent.length)); },
        onDone: (pos, a) => done.push({ pos: pos, id: a.id }),
    }, extra || {}));
    return { sk: sk, sent: sent, done: done, where: w, setAnswer(fn) { answer = fn; } };
}

test('seeker: steps of 10 s add up from the position shown; one seek 500 ms after the last step', async () => {
    const c = fakeClock(), k = seeker(c);
    assert.strictEqual(STEP_S, 10);
    assert.strictEqual(k.sk.target(), null, 'nothing pending at first');
    k.sk.nudge(1); k.sk.commit(500);
    assert.strictEqual(k.sk.target(), 110, 'the bar shows the target at once');
    await c.advance(300);
    k.sk.nudge(1); k.sk.commit(500);
    await c.advance(400);
    k.sk.nudge(1); k.sk.commit(500);
    assert.strictEqual(k.sk.target(), 130);
    await c.advance(499);
    assert.deepStrictEqual(k.sent, [], 'not before 500 ms after the last step');
    await c.advance(1);
    assert.deepStrictEqual(k.sent.map((x) => x.pos), [130], 'one seek, with the sum');
    assert.strictEqual(k.sk.target(), null, 'answered: the bar is the player\'s again');
    assert.deepStrictEqual(k.done, [{ pos: 130, id: 101 }], 'the caller is told where it went and the answer\'s id');
    await c.advance(5000);
    assert.strictEqual(k.sent.length, 1, 'and no more');
    k.sk.nudge(-3); k.sk.commit(500);
    await c.advance(500);
    assert.deepStrictEqual(k.sent.map((x) => x.pos), [130, 70], 'backwards too');
});

test('seeker: the target stays inside the track; without a track nothing happens; a position is a plain number', async () => {
    const c = fakeClock(), k = seeker(c);
    k.sk.nudge(-50);
    assert.strictEqual(k.sk.target(), 0, 'not before the start');
    k.sk.nudge(500);
    assert.ok(k.sk.target() < 320 && k.sk.target() >= 315, 'a little before the end, so a seek does not skip: ' + k.sk.target());
    k.sk.set(123.456); k.sk.commit(0);
    await c.advance(0);
    assert.deepStrictEqual(k.sent.map((x) => x.pos), [123.5], 'tenths of a second');
    [NaN, Infinity, -Infinity, 'x', null, undefined, {}].forEach((v) => { k.sk.set(v); k.sk.nudge(v); });
    assert.strictEqual(k.sk.target(), null, 'garbage is no target');
    k.where.dur = null;
    k.sk.nudge(100);
    assert.strictEqual(k.sk.target(), 1100, 'no duration known: only the start is a limit');
    k.sk.cancel();
    k.where.key = null;
    assert.strictEqual(k.sk.nudge(1), false);
    assert.strictEqual(k.sk.set(50), false);
    k.sk.commit(0);
    await c.advance(1000);
    assert.strictEqual(k.sk.target(), null);
    assert.strictEqual(k.sent.length, 1, 'nothing sent with no track on');
});

test('seeker: at most 2 seek requests a second, whatever the input does', async () => {
    const c = fakeClock(), k = seeker(c);
    assert.strictEqual(SEND_GAP_MS, 500);
    for (let i = 0; i < 100; i++) { k.sk.set(i * 3); k.sk.commit(0); await c.advance(37); }
    await c.advance(2000);
    assert.ok(k.sent.length >= 2, 'it did send');
    for (let i = 1; i < k.sent.length; i++) assert.ok(k.sent[i].at - k.sent[i - 1].at >= 500, 'sends ' + (i - 1) + ' and ' + i + ' are ' + (k.sent[i].at - k.sent[i - 1].at) + ' ms apart');
    assert.strictEqual(k.sent[k.sent.length - 1].pos, 297, 'the last target is the one that counts');
    assert.strictEqual(k.sk.target(), null);
});

test('seeker: a target changed while a seek is on its way is sent after its answer, not lost and not doubled', async () => {
    const c = fakeClock(), k = seeker(c);
    const waiting = [];
    k.setAnswer((pos, id) => new Promise((r) => waiting.push(() => r({ id: id, ok: true }))));
    k.sk.set(50); k.sk.commit(0);
    await c.advance(0);
    assert.strictEqual(k.sent.length, 1);
    k.sk.set(80); k.sk.commit(0);
    await c.advance(3000);
    assert.strictEqual(k.sent.length, 1, 'one at a time');
    assert.strictEqual(k.sk.target(), 80, 'the newer target is shown');
    waiting.shift()();
    await c.advance(1000);
    assert.deepStrictEqual(k.sent.map((x) => x.pos), [50, 80]);
    assert.strictEqual(k.sk.target(), 80, 'still on its way');
    waiting.shift()();
    await c.advance(0);
    assert.strictEqual(k.sk.target(), null);
});

test('seeker: an error, a strange answer, a send that throws or rejects: the target goes, nothing throws (R1)', async () => {
    const c = fakeClock(), k = seeker(c);
    const answers = [{ ok: false, error: 'bad-request' }, { ok: false, error: 'timeout', local: true }, null, undefined, 'garbage', 42, { ok: 'yes' }, {}, []];
    for (let i = 0; i < answers.length; i++) {
        k.setAnswer(() => answers[i]);
        k.sk.set(60 + i); k.sk.commit(0);
        assert.strictEqual(k.sk.target(), 60 + i);
        await c.advance(600);
        assert.strictEqual(k.sk.target(), null, 'after ' + JSON.stringify(answers[i]));
    }
    assert.deepStrictEqual(k.done, [], 'none of them counts as a seek done');
    k.setAnswer(() => { throw new Error('boom'); });
    k.sk.set(10); k.sk.commit(0);
    await c.advance(600);
    assert.strictEqual(k.sk.target(), null);
    k.setAnswer(() => Promise.reject(new Error('boom')));
    k.sk.set(10); k.sk.commit(0);
    await c.advance(600);
    assert.strictEqual(k.sk.target(), null);
    k.setAnswer((pos, id) => ({ id: id, ok: true }));
    k.sk.set(10); k.sk.commit(0);
    await c.advance(600);
    assert.strictEqual(k.done.length, 1, 'and the next one works');
});

test('seeker: another track while a target waits drops it; a target nobody sends (the finger never lifted) goes by itself', async () => {
    const c = fakeClock(), k = seeker(c);
    k.sk.nudge(2); k.sk.commit(500);
    k.where.key = 'b/1';
    assert.strictEqual(k.sk.target(), null, 'the next track does not inherit the target');
    await c.advance(1000);
    assert.deepStrictEqual(k.sent, []);
    k.sk.set(40);
    assert.strictEqual(k.sk.target(), 40);
    await c.advance(120000);
    assert.strictEqual(k.sk.target(), null, 'forgotten');
    assert.deepStrictEqual(k.sent, []);
});

test('seeker and progress: the bar shows the target while pending; a late status does not pull it back', async () => {
    const c = fakeClock(), pr = createProgress();
    const player = (pos, state) => ({ state: state || 'playing', track: { id: 1 }, position: pos, duration: 320, queueIndex: 0 });
    pr.update(player(100), 7, c.now());
    const waiting = [];
    const sk = createSeeker({
        now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
        where: () => { const p = pr.at(c.now()); return { pos: p.pos, dur: p.dur, key: '1/0' }; },
        send: () => new Promise((r) => waiting.push(r)),
        onDone: (pos, a) => pr.jump(pos, c.now(), a.id),
    });
    const shown = () => { const t = sk.target(); return t != null ? t : pr.at(c.now()).pos; };
    sk.set(200); sk.commit(0);
    await c.advance(0);
    assert.strictEqual(shown(), 200);
    pr.update(player(100.4), 8, c.now());                   // a status from before the seek, while it is on its way
    assert.strictEqual(shown(), 200, 'pending: the target');
    await c.advance(300);
    waiting.shift()({ id: 10, ok: true });                  // the seek's answer (request 10)
    await c.advance(0);
    assert.strictEqual(sk.target(), null);
    assert.strictEqual(shown(), 200, 'answered: the bar carries on from the target');
    pr.update(player(100.9), 9, c.now());                   // a status asked for before the seek, answered after it
    assert.ok(shown() >= 200, 'a late status does not pull the bar back: ' + shown());
    pr.update(player(200, 'loading'), 11, c.now());         // the first one after it: loading, at the target
    await c.advance(2000);
    assert.ok(Math.abs(shown() - 200) < 0.5, 'loading: the bar waits at the target: ' + shown());
    pr.update(player(200.2), 12, c.now());
    await c.advance(1000);
    assert.ok(Math.abs(shown() - 201.2) < 0.5, 'then it plays on from there: ' + shown());
    // back by less than 3 s too (progress.js otherwise holds the bar)
    sk.set(199.5); sk.commit(0);
    await c.advance(600);
    waiting.shift()({ id: 13, ok: true });
    await c.advance(0);
    assert.ok(Math.abs(shown() - 199.5) < 0.2, 'a short seek back is shown: ' + shown());
});

/* ---------- the steering wheel ---------- */

function wheelOn(clock, on) {
    const ev = [];
    const w = createWheel({
        skip: (d) => ev.push('skip ' + d), active: () => on.v,
        seek: { step: (d) => ev.push('step ' + d), end: () => ev.push('end') },
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    return { w: w, ev: ev };
}
const RIGHT = { operationPushButtonAudioAutomaticTuningSteeringWheel: 'SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS' };
const LEFT = { operationPushButtonAudioAutomaticTuningSteeringWheel: 'SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS' };
const NONE = { operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' };

test('the wheel: a press let go before 0.7 s is a skip, as before, and never a seek', async () => {
    const c = fakeClock(), k = wheelOn(c, { v: true });
    k.w.onSwitch(RIGHT);
    await c.advance(699);
    assert.deepStrictEqual(k.ev, [], 'nothing while held');
    k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev, ['skip 1']);
    await c.advance(5000);
    assert.deepStrictEqual(k.ev, ['skip 1'], 'no step follows a short press');
    k.w.onSwitch(LEFT); await c.advance(100); k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev, ['skip 1', 'skip -1']);
});

test('the wheel: held longer it winds, a step at 0.7 s and one more for every 0.5 s, the seek at release, never a skip', async () => {
    const c = fakeClock(), k = wheelOn(c, { v: true });
    k.w.onSwitch(RIGHT);
    await c.advance(700);
    assert.deepStrictEqual(k.ev, ['step 1'], 'the first step when the press becomes a long one');
    k.w.onSwitch(RIGHT);                                    // the car may say "held" again
    await c.advance(500);
    assert.deepStrictEqual(k.ev, ['step 1', 'step 1']);
    await c.advance(1000);
    assert.strictEqual(k.ev.length, 4);
    k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev, ['step 1', 'step 1', 'step 1', 'step 1', 'end'], 'one end, no skip');
    await c.advance(5000);
    assert.strictEqual(k.ev.length, 5, 'and it stops');
    k.w.onSwitch(NONE);
    assert.strictEqual(k.ev.length, 5, 'a second release does nothing');
    k.ev.length = 0;
    k.w.onSwitch(LEFT); await c.advance(1200); k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev, ['step -1', 'step -1', 'end'], 'left winds back');
});

test('the wheel: nothing of ours on: a long press neither winds nor skips; a release that never comes ends by itself', async () => {
    const c = fakeClock(), on = { v: false }, k = wheelOn(c, on);
    k.w.onSwitch(RIGHT); await c.advance(3000); k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev, [], 'the radio keeps its buttons');
    on.v = true;
    k.w.onSwitch(RIGHT);
    await c.advance(10 * 60 * 1000);
    const steps = k.ev.filter((e) => e === 'step 1').length;
    assert.ok(steps >= 10 && steps <= 60, steps + ' steps');
    assert.deepStrictEqual(k.ev.filter((e) => e === 'end'), ['end'], 'ended once without the release');
    assert.strictEqual(k.ev.filter((e) => /skip/.test(e)).length, 0);
    k.w.onSwitch(NONE);
    assert.strictEqual(k.ev.filter((e) => /skip/.test(e)).length, 0, 'the late release is not a skip');
    // the track ends while held: winding stops, no skip
    k.ev.length = 0;
    k.w.onSwitch(RIGHT); await c.advance(1200); on.v = false; await c.advance(2000); k.w.onSwitch(NONE);
    assert.deepStrictEqual(k.ev.filter((e) => /skip/.test(e)), []);
    assert.strictEqual(k.ev.filter((e) => e === 'step 1').length, 2);
    // handlers that throw do not reach the caller
    const w = createWheel({ skip() { throw new Error('x'); }, active: () => true, seek: { step() { throw new Error('x'); }, end() { throw new Error('x'); } },
        now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
    w.onSwitch(RIGHT); await c.advance(1300); w.onSwitch(NONE);
    w.onSwitch(RIGHT); w.onSwitch(NONE);
});

test('the wheel without a seek (as before): a press of any length is a skip on release', async () => {
    const skips = [];
    const w = createWheel({ skip: (d) => skips.push(d), active: () => true });
    w.onSwitch(RIGHT);
    await sleep(30);
    w.onSwitch(NONE);
    assert.deepStrictEqual(skips, [1]);
});

/* ---------- the screen and the controller ---------- */

function playing(state, extra) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = Object.assign({ state: state || 'playing', track: TRACK, position: 40, duration: 320, queueIndex: 0, queueLength: 14, quality: 'HIGH', error: null }, extra || {});
    return M.reduce(M.reduce(M.initial(), { type: 'status', state: st }), { type: 'open-now-playing' });
}
function drawn(s, ui) { const cv = spyCanvas(); const info = S.draw(cv, theme, s, Object.assign({ now: 0 }, ui || {})); return { cv: cv, info: info }; }
const barOf = (info) => info.hits.filter((h) => h.bar)[0];

test('now playing: the progress bar is a place for a finger, wider than it is drawn; none without a track or a duration', () => {
    const { info } = drawn(playing(), { position: 40, duration: 320 });
    const b = barOf(info);
    assert.ok(b, 'a bar');
    assert.ok(b.h >= 48, 'tall enough for a finger: ' + b.h);
    assert.ok(b.bar.w > 600 && b.bar.x >= b.x && b.bar.dur === 320, JSON.stringify(b));
    assert.strictEqual(info.hits.filter((h) => h.button).length, 0, 'U1: no buttons on the page (the bar has them)');
    assert.strictEqual(barOf(drawn(playing('idle', { track: null })).info), undefined);
    assert.strictEqual(barOf(drawn(playing('loading', { duration: null, track: Object.assign({}, TRACK, { duration: null }) })).info), undefined, 'no duration: nowhere to point at');
    assert.strictEqual(barOf(drawn(playing('error', { error: 'decode' })).info), undefined, 'not on an error');
});

test('now playing: while seeking the bar and the time show the target; state loading shows as before', () => {
    const a = drawn(playing(), { position: 200, duration: 320, seeking: true });
    assert.ok(a.cv.has('3:20'), a.cv.all());
    const target = a.cv.texts.filter((t) => t.s === '3:20')[0];
    assert.deepStrictEqual([target.color, target.opts.font], [theme.text, 'bold'], 'the target\'s time stands out');
    const b = drawn(playing(), { position: 200, duration: 320 });
    assert.strictEqual(b.cv.texts.filter((t) => t.s === '3:20')[0].color, theme.dim);
    const l = drawn(playing('loading', { position: 200 }), { position: 200, duration: 320 });
    assert.ok(l.cv.has('Loading...') && l.cv.has('3:20'), l.cv.all());
});

test('the controller on now playing (U1): it starts on PAUSE in the bar; pushed up it is on the progress line, where the knob and left / right wind 10 s a step', () => {
    const s = playing();
    const go = (st, ev) => N.input(st, null, ev).reduce((x, a) => M.reduce(x, a), st);
    assert.deepStrictEqual([s.focus.area, s.focus.bar], ['bar', 1]);
    assert.deepStrictEqual(N.input(s, null, { knob: 1 }), [{ type: 'focus', area: 'bar', bar: 2 }], 'on the bar the knob goes along its buttons');
    assert.deepStrictEqual(N.input(s, null, { tilt: 'W' }), [{ type: 'back' }], 'left is back');
    assert.deepStrictEqual(N.input(s, null, { tilt: 'N' }), [{ type: 'focus', area: 'progress' }], 'up: the progress line');
    const on = go(s, { tilt: 'N' });
    assert.strictEqual(drawn(on, { position: 40, duration: 320 }).info.barFocus, true);
    assert.deepStrictEqual(N.input(on, null, { knob: 1 }), [{ type: 'seek-step', steps: 1 }]);
    assert.deepStrictEqual(N.input(on, null, { knob: -3 }), [{ type: 'seek-step', steps: -3 }]);
    assert.deepStrictEqual(N.input(on, null, { tilt: 'E' }), [{ type: 'seek-step', steps: 1 }]);
    assert.deepStrictEqual(N.input(on, null, { tilt: 'W' }), [{ type: 'seek-step', steps: -1 }]);
    assert.deepStrictEqual(N.input(on, null, { tilt: 'S' }), [{ type: 'focus', area: 'bar' }], 'down: back to the bar');
    assert.deepStrictEqual(N.input(on, null, { press: true }), [{ type: 'focus', area: 'bar' }], 'a press leaves the line too');
    assert.deepStrictEqual(go(on, { tilt: 'N' }).focus.area, 'tabs', 'up again: the tabs');
    // nothing to seek in (nothing playing): no progress line, a stale focus on it does nothing odd
    const idle = M.reduce(playing('idle', { track: null }), { type: 'focus', area: 'progress' });
    assert.strictEqual(drawn(idle).info.barFocus, false);
    assert.deepStrictEqual(N.input(idle, null, { knob: 1 }).filter((a) => a.type === 'seek-step'), []);
});

test('a tap on the bar (where only taps arrive) seeks to that point', () => {
    const s = playing();
    const info = drawn(s, { position: 40, duration: 320 }).info, b = barOf(info);
    const at = (f) => ({ tap: { x: b.bar.x + b.bar.w * f, y: b.y + b.h / 2 } });
    const mid = N.input(s, info, at(0.5));
    assert.strictEqual(mid.length, 1);
    assert.strictEqual(mid[0].type, 'seek-to');
    assert.ok(Math.abs(mid[0].position - 160) < 0.01, String(mid[0].position));
    assert.strictEqual(N.input(s, info, { tap: { x: b.x + 1, y: b.y + 1 } })[0].position, 0, 'left of the bar\'s start: the start');
    assert.ok(Math.abs(N.input(s, info, { tap: { x: b.x + b.w - 1, y: b.y + 1 } })[0].position - 320) < 0.01, 'right of its end: the end');
});

/* ---------- the app against the fake service ---------- */

function fakeCtx() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-data-'));
    const handlers = {}, loops = {}, frames = [], logs = [], watched = {};
    const values = { quality: 'HIGH', wheel: true };
    const ctx = {
        dataDir, handlers, loops, frames, logs, watched,
        log: { info() {}, debug() {}, warn(m) { logs.push('warn ' + m); }, error(m, e) { logs.push('error ' + m + (e ? ' ' + (e.stack || e) : '')); } },
        ui: { onClick: (n, fn) => { handlers[n] = fn; }, image: (n, cv) => { frames.push(cv); return Promise.resolve(); }, isVisible: () => true, onVisible() {}, close() {} },
        settings: { get: (k) => values[k], onChange() {} },
        theme: () => theme,
        canvas: (w, h) => spyCanvas(w, h),
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        signals: {
            watch: (iface, inst, h) => { watched[iface] = h; return Promise.resolve({ available: true }); },
            proxy: () => Promise.reject(new Error('no SOME/IP in the test')), call: () => Promise.reject(new Error('none')),
            on: () => Promise.reject(new Error('none')), onAvailable: () => {},
        },
        controller: { grab() {}, onInput(fn) { ctx.ccu = fn; } },
        onTap(fn) { ctx.tap = fn; },
        onTouch(fn) { ctx.touch = fn; },
    };
    return ctx;
}
const seeks = (svc) => svc.requests.filter((r) => r.cmd === 'seek');
const count = (svc, cmd) => svc.requests.filter((r) => r.cmd === cmd).length;
const noErrors = (ctx) => assert.deepStrictEqual(ctx.logs.filter((l) => /^error/.test(l)), []);
async function frame(ctx) { await ctx.loops.MAIN(); return ctx.frames[ctx.frames.length - 1]; }
/** the app on now playing, a track of 320 s playing at `position` */
async function onNowPlaying(position, opts) {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    svc.state.player = { state: 'playing', track: TRACK, position: position, duration: 320, queueIndex: 0, queueLength: 3, quality: 'HIGH', error: null, skipped: [] };
    const ctx = fakeCtx();
    const app = createApp(ctx, Object.assign({ socketPath: sock, pollMs: 150, setImage() {}, decodeJpeg: decodeJpeg }, opts || {}));
    await waitFor(() => app.state().player && app.state().player.state === 'playing', 3000, 'playing');
    app.act({ type: 'open-now-playing' });
    assert.strictEqual(app.state().screen, 'NOW_PLAYING');
    await frame(ctx);
    return { svc: svc, ctx: ctx, app: app, done: async () => { app.stop(); await svc.close(); } };
}

test('app: a finger on the bar: the position follows it, one seek when it lifts; a touch elsewhere is not taken', async () => {
    const a = await onNowPlaying(10);
    try {
        const b = barOf(a.app.info()), y = b.y + b.h / 2, at = (f) => b.bar.x + b.bar.w * f;
        assert.ok(!a.ctx.touch(1, 100, 100), 'the cover is not the bar');
        a.ctx.touch(3, 100, 100);
        assert.strictEqual(a.ctx.touch(1, at(0.5), y), true, 'the bar takes the gesture');
        assert.ok((await frame(a.ctx)).has('2:40'), 'down at the middle: 2:40');
        a.ctx.touch(2, at(0.25), y - 80);
        assert.ok((await frame(a.ctx)).has('1:20'), 'dragged to a quarter (the finger may leave the bar\'s height)');
        a.ctx.touch(2, at(0.75), y);
        await sleep(700);
        assert.ok((await frame(a.ctx)).has('4:00'), 'the target stays while the finger rests, whatever the status says');
        assert.strictEqual(seeks(a.svc).length, 0, 'nothing sent while the finger is down');
        a.ctx.touch(3, at(0.75), y);
        await waitFor(() => seeks(a.svc).length === 1, 2000, 'the seek');
        assert.ok(Math.abs(seeks(a.svc)[0].position - 240) < 0.5, 'to 4:00: ' + seeks(a.svc)[0].position);
        assert.deepStrictEqual(P.validateRequest(seeks(a.svc)[0]), []);
        await sleep(800);
        assert.strictEqual(seeks(a.svc).length, 1, 'a drag sends one');
        assert.ok((await frame(a.ctx)).has(/^4:0\d$/), 'and the bar plays on from there');
        // a touch that began elsewhere and ends on the bar is not a seek
        a.ctx.touch(2, at(0.1), y); a.ctx.touch(3, at(0.1), y);
        await sleep(300);
        assert.strictEqual(seeks(a.svc).length, 1);
        noErrors(a.ctx);
    } finally { await a.done(); }
});

test('app: the knob on the bar: 10 s a step, one seek 500 ms after the last step; on the buttons it does not seek', async () => {
    const a = await onNowPlaying(10);
    try {
        let k = 100;
        const ev = (pb, df) => a.ctx.ccu({ frontRotaryEncoderOperation: k, frontRotaryEncoderPushButton: pb, frontRotaryEncoderDeflection: df });
        ev(0, 0);
        k += 1; ev(0, 0);                                           // on the buttons: along them
        await sleep(700);
        assert.strictEqual(seeks(a.svc).length, 0, 'the knob on the buttons is not a seek');
        await frame(a.ctx);
        ev(0, 1); ev(0, 0);                                         // pushed up: onto the bar
        await frame(a.ctx);
        assert.strictEqual(a.app.info().barFocus, true);
        let last = 0;
        for (let i = 0; i < 3; i++) { if (i) await sleep(100); k += 1; last = Date.now(); ev(0, 0); }
        assert.ok((await frame(a.ctx)).has(/^0:4\d$/), 'the bar shows the target at once');
        await sleep(250);
        assert.strictEqual(seeks(a.svc).length, 0, 'not yet');
        await waitFor(() => seeks(a.svc).length === 1, 2000, 'the seek');
        assert.ok(Date.now() - last >= 480, 'about 500 ms after the last step: ' + (Date.now() - last));
        const p = seeks(a.svc)[0].position;
        assert.ok(p >= 40 && p <= 43, '10 s + what played + 30 s: ' + p);
        await sleep(700);
        assert.strictEqual(seeks(a.svc).length, 1, 'three steps, one seek');
        k -= 20; ev(0, 0);                                          // far back: the start
        await waitFor(() => seeks(a.svc).length === 2, 2000, 'the second seek');
        assert.strictEqual(seeks(a.svc)[1].position, 0);
        ev(0, 7); ev(0, 0);                                         // pushed down: the buttons again
        await frame(a.ctx);
        assert.strictEqual(a.app.info().barFocus, false);
        seeks(a.svc).forEach((r) => assert.deepStrictEqual(P.validateRequest(r), []));
        noErrors(a.ctx);
    } finally { await a.done(); }
});

test('app: the wheel: a short press skips and does not seek; a long press winds 10 s per 0.5 s, one seek, no skip; while driving too', async () => {
    const a = await onNowPlaying(10, { parked: { moving: () => true } });
    try {
        await waitFor(() => a.app.state().moving === true, 2000, 'driving');
        const wheel = a.ctx.watched['de.bmw.infotainment.controlelements.SteeringWheelPushButton'].statusSearchSwitch1;
        wheel(RIGHT); await sleep(100); wheel(NONE);
        await waitFor(() => count(a.svc, 'next') === 1, 2000, 'next');
        await sleep(700);
        assert.strictEqual(seeks(a.svc).length, 0, 'a short press is a skip only');
        wheel(RIGHT);
        await sleep(1350);                                          // steps at 0.7 s and 1.2 s
        assert.strictEqual(seeks(a.svc).length, 0, 'nothing sent while held');
        assert.ok((await frame(a.ctx)).has(/^0:3\d$/), 'the bar shows where it will go');
        wheel(NONE);
        await waitFor(() => seeks(a.svc).length === 1, 2000, 'the seek');
        const p = seeks(a.svc)[0].position;
        assert.ok(p >= 30 && p <= 34, '20 s on from about 0:11: ' + p);
        wheel(LEFT); await sleep(800); wheel(NONE);                 // one step back
        await waitFor(() => seeks(a.svc).length === 2, 2000, 'the seek back');
        const q = seeks(a.svc)[1].position;
        assert.ok(q >= 20 && q <= 26, '10 s back: ' + q);
        await sleep(600);
        assert.strictEqual(count(a.svc, 'next'), 1, 'a long press never also skips');
        assert.strictEqual(count(a.svc, 'prev'), 0);
        assert.strictEqual(seeks(a.svc).length, 2);
        noErrors(a.ctx);
    } finally { await a.done(); }
});

test('app: a status that was on its way when the seek went does not pull the bar back', async () => {
    const a = await onNowPlaying(10);
    try {
        // hold one status answer back: the app gets an answer nobody waits for instead (dropped), the real one later
        let hold = true, held = null;
        a.svc.answer = (r) => {
            if (r.cmd !== 'status' || !hold || held) return undefined;
            held = { id: r.id, ok: true, state: JSON.parse(JSON.stringify(a.svc.state)) };
            return { id: 0x7ffffff0, ok: true };
        };
        await waitFor(() => held, 2000, 'a status on its way');
        hold = false;
        a.app.act({ type: 'seek-to', position: 200 });
        await waitFor(() => seeks(a.svc).length === 1, 2000, 'the seek');
        assert.ok(seeks(a.svc)[0].id > held.id, 'the status was asked for first');
        await sleep(60);
        a.svc.conns[0].write(JSON.stringify(held) + '\n');          // the old position (0:10), after the seek's answer
        await sleep(60);
        assert.ok((await frame(a.ctx)).has(/^3:2\d$/), 'still at the target: ' + a.ctx.frames[a.ctx.frames.length - 1].all());
        const n = count(a.svc, 'status');
        await waitFor(() => count(a.svc, 'status') >= n + 2, 3000, 'newer statuses');
        assert.ok((await frame(a.ctx)).has(/^3:2\d$/), 'and after the next ones');
        noErrors(a.ctx);
    } finally { await a.done(); }
});

test('app: seek answers that are errors or garbage: the app carries on, the bar goes back to the player\'s position (R1)', async () => {
    const a = await onNowPlaying(10);
    try {
        const answers = [
            (r) => ({ id: r.id, ok: false, error: 'bad-request', message: 'nothing is playing' }),
            (r) => ({ id: r.id, ok: false, error: 'never-heard-of-it' }),
            (r) => ({ id: r.id, ok: 'yes' }),
            (r) => ({ id: r.id, ok: false }),
            (r) => ({ id: r.id, ok: true, position: 'x', junk: { a: [1, 2, 3] }, state: 7 }),
        ];
        for (let i = 0; i < answers.length; i++) {
            a.svc.answer = (r) => (r.cmd === 'seek' ? answers[i](r) : undefined);
            a.app.act({ type: 'seek-to', position: 250 });
            assert.ok((await frame(a.ctx)).has('4:10'), 'the target while it is asked');
            await waitFor(() => seeks(a.svc).length === i + 1, 2000, 'seek ' + i);
            await sleep(700);                                       // (also the 500 ms between two seeks)
            assert.strictEqual(a.app.state().screen, 'NOW_PLAYING', 'answer ' + i);
            assert.ok((await frame(a.ctx)).has(/^0:[01]\d$/), 'answer ' + i + ': back at the player\'s position: ' + a.ctx.frames[a.ctx.frames.length - 1].all());
        }
        // the track ended in the service just before the seek: bad-request from the service itself
        a.svc.answer = null;
        a.svc.state.player = defaultState().player;
        a.app.act({ type: 'seek-to', position: 100 });
        await waitFor(() => seeks(a.svc).length === answers.length + 1, 2000, 'the seek with nothing playing');
        await waitFor(() => a.app.state().player.state === 'idle', 2000, 'idle');
        assert.ok((await frame(a.ctx)).has('Nothing is playing'));
        a.app.act({ type: 'seek-to', position: 100 });
        a.app.act({ type: 'seek-step', steps: 2 });
        await sleep(900);
        assert.strictEqual(seeks(a.svc).length, answers.length + 1, 'with nothing on, no seek is sent at all');
        // and it still works afterwards
        a.svc.state.player = { state: 'paused', track: TRACK, position: 5, duration: 320, queueIndex: 0, queueLength: 3, quality: 'HIGH', error: null, skipped: [] };
        await waitFor(() => a.app.state().player.state === 'paused', 2000, 'paused');
        a.app.act({ type: 'seek-to', position: 100 });
        await waitFor(() => seeks(a.svc).length === answers.length + 2, 2000, 'a seek while paused');
        await sleep(400);
        assert.ok((await frame(a.ctx)).has('1:40'), 'paused: the bar waits at the new position');
        noErrors(a.ctx);
    } finally { await a.done(); }
});

test('app: the service goes away during a drag: no seek storm, no error, NO_SERVICE', async () => {
    const a = await onNowPlaying(10);
    try {
        const b = barOf(a.app.info()), y = b.y + b.h / 2;
        assert.strictEqual(a.ctx.touch(1, b.bar.x + 10, y), true);
        await a.svc.close();
        a.ctx.touch(2, b.bar.x + 300, y);
        a.ctx.touch(3, b.bar.x + 300, y);
        await waitFor(() => a.app.state().screen === 'NO_SERVICE', 4000, 'NO_SERVICE');
        await frame(a.ctx);
        assert.ok(!a.ctx.touch(1, b.bar.x + 10, y), 'no bar on that screen');
        noErrors(a.ctx);
    } finally { a.app.stop(); }
});

run();
