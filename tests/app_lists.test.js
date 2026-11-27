'use strict';
/**
 * D4: lists and moving through them. The library home, a track list, albums / playlists / mixes; the knob, press,
 * tilt and touch (apps/cmocan_tidal/nav.js); only the visible rows drawn (screens.js); text the kit's fonts cannot
 * draw converted (text.js: accented letters to plain ones, anything else to '?').
 */
const assert = require('assert');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const { defaultState } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');
const N = require('../apps/cmocan_tidal/nav');
const L = require('../apps/cmocan_tidal/listview');
const T = require('../apps/cmocan_tidal/text');

const theme = themes.theme('m_tricolour');
const track = (i, extra) => Object.assign({ id: 1000 + i, title: 'Track ' + i, artists: ['Artist ' + i], album: null, coverId: null, duration: 185, streamReady: true, explicit: false }, extra || {});
const loggedIn = () => M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in' }) });
function listOf(items, kind, extra) {
    let s = M.reduce(loggedIn(), Object.assign({ type: 'open-list', key: 'k', title: 'A list', kind: kind || 'tracks', source: { cmd: 'playlist', params: { uuid: 'u' } } }, extra || {}));
    s = M.reduce(s, { type: 'list-loaded', key: 'k', offset: 0, total: items.length, items: items });
    return s;
}
/** apply what nav returns: model events go through the model, the rest is returned */
function apply(s, out) {
    const acts = [];
    out.forEach((a) => { const n = M.reduce(s, a); if (n !== s || a.type === 'cursor' || a.type === 'focus') s = n; else acts.push(a); });
    return { s: s, acts: acts };
}
function drawn(s, ui) { const cv = spyCanvas(); const info = S.draw(cv, theme, s, Object.assign({ now: 0 }, ui || {})); return { cv: cv, info: info }; }

test('text: Romanian and other accented letters become plain ones; anything else becomes ?', () => {
    assert.strictEqual(T.ascii('Știrile'), 'Stirile');
    assert.strictEqual(T.ascii('ăâîșțĂÂÎȘȚ'), 'aaistAAIST');
    assert.strictEqual(T.ascii('şţŞŢ'), 'stST', 'the cedilla forms too');
    assert.strictEqual(T.ascii('Beyoncé, Motörhead, Sigur Rós, Dvořák, Łódź, Øresund'), 'Beyonce, Motorhead, Sigur Ros, Dvorak, Lodz, Oresund');
    assert.strictEqual(T.ascii('Straße Ægir œuvre Þór ð'), 'Strasse AEgir oeuvre Thor d');
    assert.strictEqual(T.ascii('Don’t “Stop” – now…'), 'Don\'t "Stop" - now...');
    assert.strictEqual(T.ascii('東京 Москва 🎵'), '?? ?????? ?', 'one ? per character, also outside the BMP');
    assert.strictEqual(T.ascii('plain ASCII 123 !@#'), 'plain ASCII 123 !@#');
    assert.strictEqual(T.ascii('tab\there\nnew'), 'tab here new', 'control characters become spaces');
    assert.strictEqual(T.ascii(null), '');
    assert.strictEqual(T.ascii(undefined), '');
    assert.strictEqual(T.ascii(42), '42');
});

test('text: a title of 200 characters is cut with ... inside its column', () => {
    const cv = spyCanvas();
    const long = 'A'.repeat(200);
    const s = T.fit(cv, long, 24, 400);
    assert.ok(/\.\.\.$/.test(s), s);
    assert.ok(cv.textWidth(s, 24) <= 400, 'fits: ' + cv.textWidth(s, 24));
    assert.strictEqual(T.fit(cv, 'short', 24, 400), 'short');
    // drawn in a list: the title column holds it
    const { cv: c2 } = drawn(listOf([track(0, { title: 'Ş' + 'x'.repeat(199) })]));
    const t = c2.texts.filter((x) => /^Sx+\.\.\.$/.test(x.s))[0];
    assert.ok(t, 'the title is cut and converted: ' + c2.all());
    assert.ok(c2.textWidth(t.s, t.size) <= 1500 - 140 - 60, 'inside the row, left of its time');
});

test('a 500-row list draws at most the visible rows in a frame', () => {
    const items = [];
    for (let i = 0; i < 500; i++) items.push(track(i));
    const s = listOf(items);
    const { cv, info } = drawn(s);
    const rows = cv.texts.filter((x) => /^Track \d+$/.test(x.s));
    assert.ok(rows.length > 0 && rows.length <= L.VISIBLE, rows.length + ' rows drawn');
    assert.ok(info.hits.filter((h) => h.row != null).length <= L.VISIBLE);
    // further down: the rows around the selection
    let s2 = s;
    for (let i = 0; i < 300; i++) s2 = apply(s2, N.input(s2, null, { knob: 1 })).s;
    const d2 = drawn(s2);
    const r2 = d2.cv.texts.filter((x) => /^Track \d+$/.test(x.s)).map((x) => Number(x.s.slice(6)));
    assert.ok(r2.length <= L.VISIBLE);
    assert.ok(r2.indexOf(300) >= 0, 'the selected row is shown: ' + r2.join(','));
});

test('the knob moves one row per step and stops at both ends', () => {
    const items = [track(0), track(1), track(2)];
    let s = listOf(items);
    assert.strictEqual(M.top(s).sel, 0);
    s = apply(s, N.input(s, null, { knob: -1 })).s;
    assert.strictEqual(M.top(s).sel, 0, 'stops at the top');
    s = apply(s, N.input(s, null, { knob: 1 })).s;
    assert.strictEqual(M.top(s).sel, 1);
    s = apply(s, N.input(s, null, { knob: 1 })).s;
    s = apply(s, N.input(s, null, { knob: 1 })).s;
    s = apply(s, N.input(s, null, { knob: 5 })).s;
    assert.strictEqual(M.top(s).sel, 2, 'stops at the bottom');
    // U1: pushed up / down the controller leaves the list for the tabs / the bar; the row stays (tests/app_nav.test.js)
    const up = apply(s, N.input(s, null, { tilt: 'N' })).s;
    assert.deepStrictEqual([M.top(up).sel, up.focus.area], [2, 'tabs'], 'pushed up: the tabs');
    const down = apply(s, N.input(s, null, { tilt: 'S' })).s;
    assert.deepStrictEqual([M.top(down).sel, down.focus.area], [2, 'bar'], 'pushed down: the bar');
});

test('a press plays from that row, with the ids of the list the user is in', () => {
    let s = listOf([track(0), track(1), track(2)]);
    s = apply(s, N.input(s, null, { knob: 1 })).s;
    const r = apply(s, N.input(s, null, { press: true }));
    assert.deepStrictEqual(r.acts, [{ type: 'play', tracks: [1000, 1001, 1002], index: 1 }]);
});

test('a press on a long list sends at most 1000 ids, around the row pressed (the contract\'s limit)', () => {
    const items = [];
    for (let i = 0; i < 1500; i++) items.push(track(i));
    let s = listOf(items);
    for (let i = 0; i < 1200; i++) s = apply(s, N.input(s, null, { knob: 1 })).s;
    const a = apply(s, N.input(s, null, { press: true })).acts[0];
    assert.strictEqual(a.type, 'play');
    assert.ok(a.tracks.length <= 1000);
    assert.strictEqual(a.tracks[a.index], 1000 + 1200);
});

test('a track that cannot be streamed is greyed out and a press says so instead of playing', () => {
    let s = listOf([track(0, { streamReady: false })]);
    const out = N.input(s, null, { press: true });
    const r = apply(s, out);
    assert.strictEqual(r.s.message, 'This track cannot be played here');
    assert.deepStrictEqual(r.acts, []);
    const { cv } = drawn(s);
    const t = cv.texts.filter((x) => x.s === 'Track 0')[0];
    assert.strictEqual(t.color, S.palette(theme).off, 'greyed out');
});

test('albums, playlists and mixes open their track lists; tilt left goes back', () => {
    const album = { id: 5, title: 'Discovery', artists: ['Daft Punk'], coverId: null, numberOfTracks: 14 };
    let a = apply(listOf([album], 'albums'), N.input(listOf([album], 'albums'), null, { press: true }));
    assert.strictEqual(a.s.screen, 'LIST');
    assert.deepStrictEqual(M.top(a.s).source, { cmd: 'album', params: { albumId: 5 } });
    assert.strictEqual(M.top(a.s).kind, 'tracks');
    const pl = { uuid: 'u-1', title: 'Road trip', numberOfTracks: 42, coverId: null };
    a = apply(listOf([pl], 'playlists'), N.input(listOf([pl], 'playlists'), null, { press: true }));
    assert.deepStrictEqual(M.top(a.s).source, { cmd: 'playlist', params: { uuid: 'u-1' } });
    const mix = { id: 'm1', title: 'My Mix 1', subTitle: 'X', coverId: null };
    a = apply(listOf([mix], 'mixes'), N.input(listOf([mix], 'mixes'), null, { press: true }));
    assert.deepStrictEqual(M.top(a.s).source, { cmd: 'mix', params: { mixId: 'm1' } });
    const b = apply(a.s, N.input(a.s, null, { tilt: 'W' }));
    assert.strictEqual(M.top(b.s).kind, 'mixes', 'back to the mixes');
});

test('the library home: favourites (tracks, albums), playlists, mixes, search; a press opens one', () => {
    let s = loggedIn();
    assert.strictEqual(s.screen, 'LIBRARY');
    const { cv } = drawn(s);
    ['Favourite tracks', 'Favourite albums', 'Playlists', 'Mixes', 'Search'].forEach((l) => assert.ok(cv.has(l), l + '\n' + cv.all()));
    const r = apply(s, N.input(s, null, { press: true }));
    assert.strictEqual(r.s.screen, 'LIST');
    assert.deepStrictEqual(M.top(r.s).source, { cmd: 'favorites', params: { kind: 'tracks' } });
    s = apply(s, N.input(s, null, { knob: 2 })).s;
    const p = apply(s, N.input(s, null, { press: true }));
    assert.deepStrictEqual(M.top(p.s).source, { cmd: 'playlists', params: {} });
    s = apply(s, N.input(s, null, { knob: 10 })).s;
    assert.deepStrictEqual(N.input(s, null, { press: true }), [{ type: 'open-search' }], 'the last row is search');
});

test('touch: a tap on a row acts on that row', () => {
    const s = listOf([track(0), track(1), track(2)]);
    const { info } = drawn(s);
    const h = info.hits.filter((x) => x.row === 2)[0];
    assert.ok(h, 'row 2 has a hit area');
    const r = apply(s, N.input(s, info, { tap: { x: h.x + 5, y: h.y + 5 } }));
    assert.deepStrictEqual(r.acts, [{ type: 'play', tracks: [1000, 1001, 1002], index: 2 }]);
    assert.strictEqual(M.top(r.s).sel, 2, 'the tapped row is selected');
    assert.deepStrictEqual(N.input(s, info, { tap: { x: 1, y: 1 } }), [], 'a tap on nothing does nothing');
});

test('an empty list shows a message, not an empty screen; loading and errors show too', () => {
    const empty = drawn(listOf([]));
    assert.ok(empty.cv.has(/nothing here/i), empty.cv.all());
    const loading = drawn(M.reduce(loggedIn(), { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'mixes' } }));
    assert.ok(loading.cv.has(/loading/i), loading.cv.all());
    let failed = M.reduce(loggedIn(), { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'mixes' } });
    failed = M.reduce(failed, { type: 'list-failed', key: 'k', code: 'timeout' });
    assert.ok(drawn(failed).cv.has(/could not load/i), drawn(failed).cv.all());
    assert.deepStrictEqual(N.input(listOf([]), null, { press: true }), [], 'a press on an empty list does nothing');
});

test('more rows are asked for when the knob nears the end of what is loaded (paged lists only)', () => {
    const items = [];
    for (let i = 0; i < 50; i++) items.push(track(i));
    let s = M.reduce(loggedIn(), { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'favorites', params: { kind: 'tracks' } } });
    s = M.reduce(s, { type: 'list-loaded', key: 'k', offset: 0, total: 120, items: items });
    assert.strictEqual(L.needMore(M.top(s)), null);
    for (let i = 0; i < 46; i++) s = apply(s, N.input(s, null, { knob: 1 })).s;
    assert.deepStrictEqual(L.needMore(M.top(s)), { key: 'k', cmd: 'favorites', params: { kind: 'tracks', offset: 50, limit: 50 } });
});

test('contract 2: album, mix and mixes are paged like the others (offset, limit, total)', () => {
    const items = [];
    for (let i = 0; i < 50; i++) items.push(track(i));
    const opened = (key, cmd, params, kind, list) => M.reduce(M.reduce(loggedIn(), { type: 'open-list', key: key, title: 'T', kind: kind, source: { cmd: cmd, params: params } }),
        { type: 'list-loaded', key: key, offset: 0, total: 60, items: list });
    const near = (s) => L.needMore(Object.assign({}, M.top(s), { sel: 49 }));
    assert.deepStrictEqual(near(opened('a', 'album', { albumId: 1 }, 'tracks', items)), { key: 'a', cmd: 'album', params: { albumId: 1, offset: 50, limit: 50 } });
    assert.deepStrictEqual(near(opened('m', 'mix', { mixId: 'm1' }, 'tracks', items)), { key: 'm', cmd: 'mix', params: { mixId: 'm1', offset: 50, limit: 50 } });
    const mixes = items.map((t, i) => ({ id: 'm' + i, title: 'Mix ' + i, coverId: null }));
    assert.deepStrictEqual(near(opened('x', 'mixes', {}, 'mixes', mixes)), { key: 'x', cmd: 'mixes', params: { offset: 50, limit: 50 } });
    ['favorites', 'playlists', 'playlist', 'album', 'mixes', 'mix', 'search'].forEach((c) => assert.ok(L.PAGED[c], c + ' is paged'));
});

run();
