'use strict';
/**
 * D7: the rules while driving (rule R9). The car's speed comes from the kit's parked.js (Vehicle2.statusCarSpeed2,
 * moving above 3 km/h; a quiet signal keeps the last reading; no speed at all = parked). While moving, typing a
 * search is closed and blocked (model.js, screens.js); lists, play, pause and skip stay available (nav.js).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const parkedKit = require('../kit/runtime/parked');
const { defaultState, TRACK } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');
const N = require('../apps/cmocan_tidal/nav');

const theme = themes.theme('m_tricolour');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** kit/parked.js on a fake ctx.signals: feed(kmh) is a speed notification, feedRaw(v) a raw one */
function speedSource() {
    let h = null;
    const ctx = { signals: { watch: (iface, inst, handlers) => { if (iface === 'de.bmw.infotainment.vehicle.Vehicle2') h = handlers; return Promise.resolve({ available: true }); } } };
    const parked = parkedKit.watch(ctx, { info() {} });
    return {
        parked,
        feed: (kmh) => h.statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh / 0.015625) }),
        feedRaw: (v) => h.statusCarSpeed2(v),
    };
}
const loggedIn = () => M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in' }) });
const at = (s, moving) => M.reduce(s, { type: 'driving', moving: moving });
function drawn(s) { const cv = spyCanvas(); const info = S.draw(cv, theme, s, { now: 0 }); return { cv, info }; }
const key = (info, k) => info.hits.filter((h) => h.act && h.act.type === 'key' && h.act.key === k)[0];
function typeWord(s, word) {
    for (const ch of word) {
        const h = key(drawn(s).info, ch);
        assert.ok(h, 'a key for ' + ch);
        N.input(s, drawn(s).info, { tap: { x: h.x + 2, y: h.y + 2 } }).forEach((a) => { s = M.reduce(s, a); });
    }
    return s;
}

test('app.json asks for the car\'s speed as kit/parked.js needs it', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));
    assert.strictEqual(spec.signals['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2, 'rs');
});

test('at 0 km/h search opens with the keyboard; typing and searching work', () => {
    const src = speedSource();
    src.feed(0);
    assert.strictEqual(src.parked.moving(), false);
    let s = M.reduce(at(loggedIn(), src.parked.moving()), { type: 'open-search' });
    assert.strictEqual(s.screen, 'LIST');
    assert.strictEqual(M.top(s).kind, 'search');
    assert.strictEqual(s.search.keyboard, true);
    const d = drawn(s);
    assert.ok(key(d.info, 'Q') && key(d.info, 'M') && key(d.info, '7'), 'letters and digits on the keyboard');
    s = typeWord(s, 'DAFT');
    s = M.reduce(s, { type: 'key', key: ' ' });
    s = typeWord(s, 'PUNK');
    assert.strictEqual(s.search.query, 'DAFT PUNK');
    s = M.reduce(s, { type: 'key', key: 'DEL' });
    assert.strictEqual(s.search.query, 'DAFT PUN');
    const go = key(drawn(s).info, 'SEARCH');
    N.input(s, drawn(s).info, { tap: { x: go.x + 2, y: go.y + 2 } }).forEach((a) => { s = M.reduce(s, a); });
    assert.strictEqual(s.search.keyboard, false);
    assert.deepStrictEqual(M.top(s).source, { cmd: 'search', params: { query: 'DAFT PUN' } });
    assert.strictEqual(M.top(s).loading, true);
});

test('an empty or too long query is not searched', () => {
    let s = M.reduce(loggedIn(), { type: 'open-search' });
    assert.strictEqual(M.reduce(s, { type: 'key', key: 'SEARCH' }).search.keyboard, true, 'nothing typed: stays');
    for (let i = 0; i < 230; i++) s = M.reduce(s, { type: 'key', key: 'A' });
    assert.strictEqual(s.search.query.length, 200, 'at most 200 characters (the contract)');
});

test('at 10 km/h search does not open, and an open keyboard closes', () => {
    const src = speedSource();
    src.feed(10);
    assert.strictEqual(src.parked.moving(), true);
    let s = M.reduce(at(loggedIn(), src.parked.moving()), { type: 'open-search' });
    assert.strictEqual(s.screen, 'LIBRARY', 'not opened');
    assert.ok(/parked/i.test(s.message), s.message);
    s = M.reduce(at(loggedIn(), false), { type: 'open-search' });
    s = M.reduce(s, { type: 'key', key: 'A' });
    assert.strictEqual(s.search.keyboard, true);
    s = at(s, true);
    assert.strictEqual(s.search.keyboard, false, 'closed when the car moves');
    assert.ok(/parked/i.test(s.message), s.message);
    const d = drawn(s);
    assert.ok(!key(d.info, 'Q'), 'no keyboard drawn while moving');
    assert.strictEqual(M.reduce(s, { type: 'key', key: 'B' }).search.query, 'A', 'typing blocked');
    assert.strictEqual(M.reduce(s, { type: 'open-keyboard' }).search.keyboard, false, 'cannot be reopened');
    s = at(s, false);
    assert.strictEqual(M.reduce(s, { type: 'open-keyboard' }).search.keyboard, true, 'parked again: it can');
});

test('the speed signal going quiet after driving still counts as moving; invalid readings change nothing', async () => {
    const src = speedSource();
    src.feed(50);
    await sleep(50);
    assert.strictEqual(src.parked.moving(), true, 'quiet after driving: moving');
    src.feedRaw({ speedVehicleCentreOfGravity: 65535 });
    assert.strictEqual(src.parked.moving(), true, 'an invalid reading keeps the last one');
    src.feedRaw(null); src.feedRaw({}); src.feedRaw('x');
    assert.strictEqual(src.parked.moving(), true);
    src.feed(2);
    assert.strictEqual(src.parked.moving(), false, 'at or under 3 km/h: parked');
    src.feed(3.5);
    assert.strictEqual(src.parked.moving(), true, 'above 3 km/h: moving');
});

test('no speed signal at all counts as parked (rule R9)', () => {
    const src = speedSource();
    assert.strictEqual(src.parked.moving(), false);
    assert.strictEqual(src.parked.speed(), null);
    const s = M.reduce(at(loggedIn(), src.parked.moving()), { type: 'open-search' });
    assert.strictEqual(s.search.keyboard, true);
});

test('while moving, lists, play, pause and skip stay available', () => {
    let s = at(loggedIn(), true);
    s = M.reduce(s, { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'mixes' } });
    s = M.reduce(s, { type: 'list-loaded', key: 'k', offset: 0, total: 2, items: [TRACK, Object.assign({}, TRACK, { id: 2 })] });
    const moved = N.input(s, null, { knob: 1 });
    assert.strictEqual(moved[0].type, 'cursor');
    s = M.reduce(s, moved[0]);
    assert.deepStrictEqual(N.input(s, null, { press: true }), [{ type: 'play', tracks: [TRACK.id, 2], index: 1 }]);
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = { state: 'playing', track: TRACK, position: 1, duration: 320, queueIndex: 0, queueLength: 2, quality: 'HIGH', error: null };
    let np = M.reduce(M.reduce(at(loggedIn(), true), { type: 'status', state: st }), { type: 'open-now-playing' });
    const info = drawn(np).info;
    assert.deepStrictEqual(N.input(np, info, { press: true }), [{ type: 'control', cmd: 'pause' }]);
    const next = info.hits.filter((h) => h.act && h.act.cmd === 'next')[0];
    assert.deepStrictEqual(N.input(np, info, { tap: { x: next.x + 1, y: next.y + 1 } }), [{ type: 'control', cmd: 'next' }]);
});

test('search results stay usable while moving; a new search is offered only when parked', () => {
    let s = M.reduce(loggedIn(), { type: 'open-search' });
    s = M.reduce(M.reduce(s, { type: 'key', key: 'A' }), { type: 'key', key: 'SEARCH' });
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 1, items: [TRACK] });
    s = at(s, true);
    const d = drawn(s);
    assert.ok(d.cv.has('One More Time'), d.cv.all());
    assert.ok(d.cv.has(/new search/i), d.cv.all());
    const acts = N.input(s, d.info, { press: true });              // on "New search" (the first row)
    s = M.reduce(s, acts[0]);
    assert.strictEqual(s.search.keyboard, false, 'not while moving');
    s = M.reduce(s, { type: 'cursor', sel: 1, top: 0 });
    assert.deepStrictEqual(N.input(s, d.info, { press: true }), [{ type: 'play', tracks: [TRACK.id], index: 0 }], 'a result plays');
});

run();
