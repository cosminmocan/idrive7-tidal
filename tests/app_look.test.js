'use strict';
/**
 * U1 (phase 2): the screens as the approved pictures (docs/ui-mock/a-*.png, docs/ui-redesign.md section 3):
 * rows of 70 from y 92, six on a screen; track rows of two lines with a small cover, the number or the playing mark,
 * a track that cannot be played greyed with "Not available"; one highlight, where the controller is, in the
 * theme's colour (ctx.theme(): no fixed colour in the app); messages in the caption line, never over a row; now
 * playing with no buttons of its own (the bar has them); the message pages with their choices.
 */
const assert = require('assert');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const { defaultState, TRACK } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');
const S = require('../apps/cmocan_tidal/screens');

const theme = themes.theme('m_tricolour');
// a theme of its own colours: everything drawn must come from these
const ODD = { bg: '#010203', text: '#fefdfc', dim: '#8a8b8c', sel: '#12c034', accent: '#a0a0a1', warn: '#f0b010', crit: '#e01010' };
const track = (i, extra) => Object.assign({ id: 1000 + i, title: 'Track ' + i, artists: ['Artist ' + i], album: { id: 9, title: 'Album ' + i }, coverId: 'c' + i, duration: 185, streamReady: true, explicit: false }, extra || {});
function status(player, extra) {
    const st = Object.assign(defaultState(), { login: 'logged-in' }, extra || {});
    if (player) st.player = Object.assign({ state: 'playing', track: TRACK, position: 98, duration: 320, queueIndex: 2, queueLength: 14, quality: 'HIGH', error: null, skipped: [] }, player);
    return { type: 'status', state: st };
}
const loggedIn = (player) => M.reduce(M.initial(), status(player));
function list(s, items, kind, title) {
    s = M.reduce(s, { type: 'open-list', key: 'k', title: title || 'Favourite tracks', kind: kind || 'tracks', source: { cmd: 'favorites', params: { kind: 'tracks' } } });
    return M.reduce(s, { type: 'list-loaded', key: 'k', offset: 0, total: items.length, items: items });
}
function drawn(s, ui, t) { const cv = spyCanvas(); const info = S.draw(cv, t || theme, s, Object.assign({ now: 0 }, ui || {})); return { cv: cv, info: info }; }
const textAt = (cv, s) => cv.texts.filter((x) => x.s === s)[0];
const rowOf = (y) => Math.floor((y - 92) / 70);
const plates = (cv, t) => cv.strokes.filter((x) => x.c === (t || theme).sel);
const SIX = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => track(i));

test('track rows: two lines (title, then artist and album), a small cover, the number; six rows of 70 from y 92', () => {
    const { cv, info } = drawn(list(loggedIn(), SIX), { thumb: (id) => (id === 'c1' ? { id: 77, w: 104, h: 104 } : null) });
    const rows = info.hits.filter((h) => typeof h.row === 'number');
    assert.deepStrictEqual(rows.map((h) => h.row), [0, 1, 2, 3, 4, 5], 'six rows');
    rows.forEach((h, i) => assert.deepStrictEqual([h.y, h.h], [92 + 70 * i, 70]));
    const t1 = textAt(cv, 'Track 1'), s1 = textAt(cv, 'Artist 1  ·  Album 1');
    assert.ok(t1 && s1, cv.all());
    assert.strictEqual(rowOf(t1.y), 1); assert.strictEqual(rowOf(s1.y), 1);
    assert.ok(s1.y > t1.y && t1.size === 27 && s1.size === 20, 'the second line under the title, smaller');
    assert.strictEqual(t1.color, theme.text); assert.strictEqual(s1.color, theme.dim);
    assert.strictEqual(rowOf(textAt(cv, '2').y), 1, 'the number');
    assert.ok(textAt(cv, '3:05'), 'the time');
    assert.deepStrictEqual(cv.images.map((im) => [im.id, im.w, im.h, rowOf(im.y)]), [[77, 52, 52, 1]], 'the cover that came, 52 x 52; the others a tile');
});

test('track rows: the playing track has the playing mark in place of its number; it moves with the track', () => {
    const s = list(loggedIn({ track: SIX[2] }), SIX);
    const { cv } = drawn(s);
    assert.ok(!textAt(cv, '3'), 'no number on the playing row');
    assert.ok(textAt(cv, '2') && textAt(cv, '4'));
    const s2 = M.reduce(s, status({ track: SIX[4] }));
    const c2 = drawn(s2).cv;
    assert.ok(textAt(c2, '3') && !textAt(c2, '5'), 'the mark moved to the fifth row');
});

test('track rows: a track that cannot be played is greyed and says "Not available"', () => {
    const items = [track(0), track(1, { streamReady: false }), track(2)];
    const { cv } = drawn(list(loggedIn(), items));
    const p = S.palette(theme);
    assert.strictEqual(textAt(cv, 'Track 1').color, p.off);
    assert.notStrictEqual(p.off, theme.text);
    const na = textAt(cv, 'Not available');
    assert.ok(na && rowOf(na.y) === 1, cv.all());
    assert.ok(!textAt(cv, '3:05') || cv.texts.filter((x) => x.s === '3:05').length === 2, 'its time gives way to the words');
    assert.strictEqual(textAt(cv, 'Track 2').color, theme.text);
});

test('albums, playlists, mixes: cover, title, second line, the count on the right; the caption counts the highlighted row', () => {
    const albums = [{ id: 1, title: 'Discovery', artists: ['Daft Punk'], coverId: null, numberOfTracks: 14 }, { id: 2, title: 'Random Access Memories', artists: ['Daft Punk'], coverId: null, numberOfTracks: 13 }];
    let s = list(loggedIn(), albums, 'albums', 'Favourite albums');
    s = M.reduce(s, { type: 'cursor', sel: 1, top: 0 });
    const { cv } = drawn(s);
    ['Favourite albums', '2 of 2', 'Discovery', 'Daft Punk', '14 tracks', '13 tracks'].forEach((x) => assert.ok(textAt(cv, x), x + '\n' + cv.all()));
    assert.strictEqual(textAt(cv, 'Favourite albums').y, 72, 'the caption line');
});

test('one highlight: the row the controller is on, in the theme\'s colour; none on the page while the controller is on the bar or the tabs', () => {
    let s = M.reduce(list(loggedIn(), SIX), { type: 'cursor', sel: 3, top: 0 });
    let d = drawn(s);
    assert.strictEqual(plates(d.cv).length, 1, 'one');
    assert.strictEqual(rowOf(plates(d.cv)[0].y), 3);
    assert.deepStrictEqual(d.info.focus, { key: 'row:3', x: plates(d.cv)[0].x, y: plates(d.cv)[0].y, w: plates(d.cv)[0].w, h: plates(d.cv)[0].h });
    assert.ok(d.cv.rects.some((r) => r.c === S.palette(theme).plate && rowOf(r.y) === 3), 'the plate filled with the colour, lighter');
    assert.ok(d.info.hits.some((h) => h.key === 'row:3'), 'a target of that key (the kit\'s focus)');
    ['bar', 'tabs'].forEach((a) => {
        const o = drawn(M.reduce(s, { type: 'focus', area: a }));
        assert.strictEqual(plates(o.cv).length, 0, a);
        assert.strictEqual(o.info.focus, null, a);
    });
    // My music, an error's choices, search's letters: the same plate
    assert.strictEqual(plates(drawn(loggedIn()).cv).length, 1);
    const e = drawn(M.reduce(loggedIn(), { type: 'error', code: 'not-found' }));
    assert.strictEqual(plates(e.cv).length, 1);
    assert.strictEqual(e.info.focus.key, 'choice:0');
    const k = drawn(M.reduce(M.reduce(loggedIn(), { type: 'open-search' }), { type: 'focus', key: 19 }));
    assert.strictEqual(k.info.focus.key, 'key:19');
});

test('colours: every colour drawn comes from the theme (ctx.theme()); the highlight is the theme\'s focus colour', () => {
    const base = (c) => String(c).slice(0, 7).toLowerCase();
    const ours = [ODD.bg, ODD.text, ODD.dim, ODD.sel, ODD.warn, ODD.crit];
    const states = [
        loggedIn({}),
        list(loggedIn({ track: SIX[1] }), SIX.concat([track(9, { streamReady: false })])),
        M.reduce(list(loggedIn(), SIX), { type: 'error', code: 'not-available', trackId: 1003 }),
        M.reduce(loggedIn({}), { type: 'open-now-playing' }),
        M.reduce(M.reduce(loggedIn({}), { type: 'open-now-playing' }), { type: 'focus', area: 'progress' }),
        M.reduce(loggedIn({ state: 'error', error: 'decode' }), { type: 'open-now-playing' }),
        M.reduce(loggedIn(), { type: 'error', code: 'tidal-error' }),
        M.reduce(loggedIn(), { type: 'open-search' }),
        M.reduce(loggedIn(), status(null, { online: false })),
    ];
    states.forEach((s, i) => {
        const { cv } = drawn(s, { volume: i === 3 ? { volume: 20, max: 62, muted: false } : null }, ODD);
        const odd = cv.colors.filter((x) => ours.indexOf(base(x.c)) < 0);
        assert.deepStrictEqual(odd, [], 'state ' + i + ' (' + s.screen + ')');
    });
    assert.strictEqual(S.ACCENT, undefined, 'no fixed accent colour');
    const { cv } = drawn(list(loggedIn(), SIX), {}, ODD);
    assert.strictEqual(plates(cv, ODD).length, 1);
});

test('messages: in the caption line, in the warning colour, for a few seconds; never over a row', () => {
    const s = M.reduce(list(loggedIn(), SIX), { type: 'error', code: 'not-available', trackId: 1003 });
    const on = drawn(s, { now: 1000, toastUntil: 5000 }).cv;
    const m = on.texts.filter((x) => /cannot be played/.test(x.s))[0];
    assert.ok(m, on.all());
    assert.strictEqual(m.y, 72, 'the caption line');
    assert.strictEqual(m.color, theme.warn);
    assert.ok(!textAt(on, 'Favourite tracks'), 'in place of the list\'s name');
    const off = drawn(s, { now: 6000, toastUntil: 5000 }).cv;
    assert.ok(!off.has(/cannot be played/) && textAt(off, 'Favourite tracks'), 'gone after its time');
    assert.ok(on.rects.every((r) => r.c !== theme.warn || r.y < 92), 'nothing in the warning colour over the rows');
});

test('My music: icons, six rows; "Now playing" the last row, with the track, only while a track is loaded', () => {
    const none = drawn(loggedIn()).cv;
    ['My music', 'Favourite tracks', 'Favourite albums', 'Playlists', 'Mixes', 'Videos', 'Search'].forEach((x) => assert.ok(textAt(none, x), x));
    assert.ok(!none.has('Now playing'));
    // (the seventh row: the list moves up by one when the knob reaches it)
    const on = drawn(M.reduce(loggedIn({}), { type: 'cursor', sel: 6, top: 1 })).cv;
    const np = textAt(on, 'Now playing');
    assert.ok(np && rowOf(np.y) === 5, on.all());
    assert.ok(on.has('One More Time  ·  Daft Punk'), on.all());
});

test('now playing: cover, the list and its position, title, artist, album, the progress line and the next track; no buttons of its own', () => {
    const items = [track(0), track(1), Object.assign({}, TRACK), track(3)];
    let s = list(loggedIn({ track: TRACK, queueIndex: 2, queueLength: 4 }), items, 'tracks', 'Favourite tracks');
    s = M.reduce(s, { type: 'played', queue: { key: 'k', title: 'Favourite tracks', tracks: items } });
    s = M.reduce(s, { type: 'open-now-playing' });
    const { cv, info } = drawn(s, { position: 98, duration: 320, cover: () => ({ id: 5, w: 400, h: 400 }) });
    ['Favourite tracks  ·  3 of 4', 'One More Time', 'Daft Punk', 'Discovery', 'AAC 320', '1:38', '5:20', 'Next', 'Track 3  ·  Artist 3'].forEach((x) => assert.ok(textAt(cv, x), x + '\n' + cv.all()));
    assert.strictEqual(textAt(cv, 'One More Time').size, 54);
    assert.strictEqual(textAt(cv, 'One More Time').opts.font, 'light');
    assert.deepStrictEqual(cv.images.map((im) => [im.x, im.y, im.w]), [[56, 76, 400]]);
    assert.deepStrictEqual(info.hits.filter((h) => h.button || (h.act && h.act.type === 'control')), [], 'no buttons on the page');
    assert.ok(info.hits.some((h) => h.bar), 'the progress line for a finger');
    assert.strictEqual(plates(cv).length, 0, 'the controller is in the bar (the kit draws it there)');
    const onLine = drawn(M.reduce(s, { type: 'focus', area: 'progress' }), { position: 98, duration: 320 });
    assert.strictEqual(plates(onLine.cv).length, 1, 'on the progress line: the line is highlighted');
    assert.strictEqual(onLine.info.barFocus, true);
});

test('search: what was typed, one row of letters, the results under it; while driving the letters are grey and take no press', () => {
    let s = M.reduce(loggedIn(), { type: 'open-search' });
    ['D', 'A', 'F', 'T'].forEach((k) => { s = M.reduce(s, { type: 'key', key: k }); });
    let d = drawn(s);
    assert.ok(textAt(d.cv, 'DAFT'), d.cv.all());
    const keys = d.info.hits.filter((h) => h.act && h.act.type === 'key');
    assert.strictEqual(keys.length, 30, 'A to Z, 123, space, delete, OK');
    assert.ok(keys.every((h) => h.y >= 110 && h.y + h.h <= 190), 'one row');
    assert.deepStrictEqual(keys.map((h) => h.act.key).slice(-4), ['DIGITS', ' ', 'DEL', 'SEARCH']);
    s = M.reduce(s, { type: 'key', key: 'SEARCH' });
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 2, items: [track(0), track(1)] });
    d = drawn(s);
    assert.ok(textAt(d.cv, '2 tracks') && textAt(d.cv, 'Track 1'), d.cv.all());
    assert.deepStrictEqual(d.info.hits.filter((h) => typeof h.row === 'number').map((h) => h.y), [196, 266], 'the results under the letters');
    const m = drawn(M.reduce(s, { type: 'driving', moving: true }), { now: 0, toastUntil: 5000 });
    assert.strictEqual(m.info.hits.filter((h) => h.act && h.act.type === 'key').length, 0, 'no letters to press while moving');
    assert.ok(m.cv.has(/parked/), m.cv.all());
    assert.ok(textAt(m.cv, 'Track 1'), 'the results stay');
});

test('message pages: a headline, a sentence, the choices as rows with the first highlighted (no internet, an error, no service)', () => {
    const o = drawn(M.reduce(loggedIn(), status(null, { online: false })));
    ['No internet', 'Try again', 'Open the library (lists from before)'].forEach((x) => assert.ok(textAt(o.cv, x), x + '\n' + o.cv.all()));
    assert.strictEqual(textAt(o.cv, 'No internet').size, 50);
    assert.deepStrictEqual(o.info.hits.filter((h) => h.act).map((h) => h.act.type), ['retry', 'open-library']);
    assert.strictEqual(o.info.focus.key, 'choice:0');
    const e = drawn(M.reduce(loggedIn(), { type: 'error', code: 'rate-limited' }));
    assert.ok(e.cv.has(/Busy/) && e.cv.has('Back'), e.cv.all());
    const n = drawn(M.reduce(M.initial(), { type: 'no-service' })).cv;
    assert.ok(n.has(/not installed or not running/), n.all());
    const idle = drawn(M.reduce(loggedIn(), { type: 'open-now-playing' })).cv;
    assert.ok(idle.has(/nothing is playing/i) && idle.has('Open the library'), idle.all());
});

test('login: the QR code on the left, the steps and the code on the right, "New code" when it ran out', () => {
    let s = M.reduce(M.initial(), status(null, { login: 'logged-out' }));
    s = M.reduce(M.reduce(s, { type: 'login-requested' }), { type: 'login-started', url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresIn: 300, now: 0 });
    const d = drawn(s, { now: 60000 });
    assert.ok(d.info.qr && d.info.qr.x < 500, 'the QR code on the left');
    ['Sign in to TIDAL', 'ABCDE', 'The code is valid for 4 more minutes.'].forEach((x) => assert.ok(textAt(d.cv, x), x + '\n' + d.cv.all()));
    assert.ok(d.cv.has(/link\.tidal\.com/));
    const x = M.reduce(s, { type: 'tick', now: 400000 });
    const e = drawn(x, { now: 400000 });
    assert.strictEqual(e.info.qr, null);
    assert.strictEqual(e.info.focus.key, 'choice:0');
    assert.deepStrictEqual(e.info.hits.filter((h) => h.act).map((h) => h.act.type), ['login-new']);
});

run();
