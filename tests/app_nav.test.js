'use strict';
/**
 * U1 (phase 2): one rule for the iDrive controller on every screen (docs/ui-redesign.md, section 2, and the owner's
 * decisions). The model (model.js) keeps where the controller is: on the page (a list's row, a message's choice,
 * the search's letters), on the bar (PREVIOUS, PLAY / PAUSE, NEXT), on the header's tabs (LIBRARY, NOW PLAYING,
 * SETTINGS) or on now playing's progress line; nav.js turns knob, press and push into model events and acts.
 *
 *   turn        moves inside the list (or along the bar, the tabs, the letters); stops at both ends, never leaves
 *   press       chooses
 *   push left   back one level (the list stack: the row left is restored); from My music: leaves the app
 *   push right  now playing (while a track is on); on now playing: the list that plays, at the playing track
 *   push down   the bar (it remembers its button; first time PLAY / PAUSE)
 *   push up     the tabs (from the bar: back to the page; on now playing: the progress line first)
 * The knob starts on the first row of a list (the first that can be played), or on the row it was left on.
 */
const assert = require('assert');
const { test, run } = require('./lib/t');
const { defaultState, TRACK } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');
const N = require('../apps/cmocan_tidal/nav');

const track = (i, extra) => Object.assign({ id: 1000 + i, title: 'Track ' + i, artists: ['Artist ' + i], album: null, coverId: null, duration: 185, streamReady: true, explicit: false }, extra || {});
function status(player) {
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    if (player) st.player = Object.assign({ state: 'playing', track: TRACK, position: 40, duration: 320, queueIndex: 0, queueLength: 3, quality: 'HIGH', error: null, skipped: [] }, player);
    return { type: 'status', state: st };
}
const loggedIn = (player) => M.reduce(M.initial(), status(player));
function opened(s, key, kind, items, title) {
    s = M.reduce(s, { type: 'open-list', key: key, title: title || key, kind: kind, source: { cmd: 'playlist', params: { uuid: key } } });
    return M.reduce(s, { type: 'list-loaded', key: key, offset: 0, total: items.length, items: items });
}
// what nav returns that is not the model's (main.js does these)
const ACTS = ['leave', 'play', 'control', 'bar', 'tab', 'seek-step', 'seek-to', 'login-new', 'retry'];
/** the controller input ev on state s: model events applied, the rest returned as acts */
function go(s, ev) {
    const acts = [];
    N.input(s, null, ev).forEach((a) => { if (ACTS.indexOf(a.type) >= 0) acts.push(a); else s = M.reduce(s, a); });
    return { s: s, acts: acts };
}
function walk(s, evs) { evs.forEach((ev) => { s = go(s, ev).s; }); return s; }
const at = (s) => s.focus.area;
const sel = (s) => (s.screen === 'LIBRARY' ? s.library.sel : M.top(s).sel);
const TRACKS = [track(0), track(1), track(2), track(3), track(4)];

test('start: the knob is on the first row of the library and of a list just opened, never on the tabs or the bar', () => {
    let s = loggedIn();
    assert.strictEqual(s.screen, 'LIBRARY');
    assert.strictEqual(at(s), 'page');
    assert.strictEqual(sel(s), 0);
    s = walk(s, [{ knob: 2 }, { press: true }]);                     // Playlists
    assert.strictEqual(s.screen, 'LIST');
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 3, items: [{ uuid: 'a', title: 'A' }, { uuid: 'b', title: 'B' }, { uuid: 'c', title: 'C' }] });
    assert.strictEqual(at(s), 'page');
    assert.strictEqual(sel(s), 0, 'the first row, not the library\'s third');
    // the first row cannot be played: the first that can
    const off = opened(loggedIn(), 'k', 'tracks', [track(0, { streamReady: false }), track(1), track(2)]);
    assert.strictEqual(sel(off), 1);
    assert.strictEqual(at(off), 'page');
});

test('turn: moves inside the list and stops at both ends; it never leaves into the tabs or the bar', () => {
    let s = opened(loggedIn(), 'k', 'tracks', TRACKS);
    s = walk(s, [{ knob: -1 }, { knob: -5 }]);
    assert.deepStrictEqual([at(s), sel(s)], ['page', 0], 'stops at the top');
    s = walk(s, [{ knob: 1 }]);
    assert.strictEqual(sel(s), 1);
    s = walk(s, [{ knob: 3 }, { knob: 1 }, { knob: 1 }, { knob: 20 }]);
    assert.deepStrictEqual([at(s), sel(s)], ['page', 4], 'stops at the bottom');
    // the library too
    let l = walk(loggedIn(), [{ knob: -3 }]);
    assert.deepStrictEqual([at(l), sel(l)], ['page', 0]);
    l = walk(l, [{ knob: 50 }]);
    assert.deepStrictEqual([at(l), sel(l)], ['page', 4], 'Search is the last row while nothing plays');
});

test('turn: a track that cannot be played is skipped', () => {
    let s = opened(loggedIn(), 'k', 'tracks', [track(0), track(1, { streamReady: false }), track(2), track(3, { streamReady: false })]);
    s = walk(s, [{ knob: 1 }]);
    assert.strictEqual(sel(s), 2, 'over the greyed row');
    s = walk(s, [{ knob: 1 }]);
    assert.strictEqual(sel(s), 2, 'nothing to play below: stays');
    s = M.reduce(s, { type: 'error', code: 'not-available', trackId: 1000 });     // the service said so for the first
    s = walk(s, [{ knob: -1 }]);
    assert.strictEqual(sel(s), 2, 'nothing to play above either');
});

test('push left: back one level, on the row it was left on; from My music it leaves the app', () => {
    let s = walk(loggedIn(), [{ knob: 2 }, { press: true }]);
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 3, items: [{ uuid: 'a', title: 'A' }, { uuid: 'b', title: 'B' }, { uuid: 'c', title: 'C' }] });
    s = walk(s, [{ knob: 1 }, { press: true }]);                     // the playlist B
    assert.strictEqual(s.stack.length, 2);
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 5, items: TRACKS });
    s = walk(s, [{ knob: 3 }]);
    s = walk(s, [{ tilt: 'W' }]);
    assert.deepStrictEqual([s.screen, s.stack.length, sel(s), at(s)], ['LIST', 1, 1, 'page'], 'the playlists, on B');
    s = walk(s, [{ tilt: 'W' }]);
    assert.deepStrictEqual([s.screen, sel(s), at(s)], ['LIBRARY', 2, 'page'], 'My music, on Playlists');
    assert.deepStrictEqual(go(s, { tilt: 'W' }).acts, [{ type: 'leave' }]);
    // the same from the bar and from the tabs: one level, not the top
    let b = walk(opened(opened(loggedIn(), 'a', 'albums', [{ id: 1, title: 'X' }]), 'b', 'tracks', TRACKS), [{ tilt: 'S' }]);
    assert.strictEqual(at(b), 'bar');
    b = walk(b, [{ tilt: 'W' }]);
    assert.deepStrictEqual([b.screen, M.top(b).key, at(b)], ['LIST', 'a', 'page']);
    b = walk(b, [{ tilt: 'N' }]);
    assert.strictEqual(at(b), 'tabs');
    b = walk(b, [{ tilt: 'W' }]);
    assert.deepStrictEqual([b.screen, at(b)], ['LIBRARY', 'page']);
});

test('push down: the bar, first on PLAY / PAUSE, then the button it was left on; the knob goes along it; push up: back to the row', () => {
    let s = walk(opened(loggedIn(), 'k', 'tracks', TRACKS), [{ knob: 2 }, { tilt: 'S' }]);
    assert.deepStrictEqual([at(s), s.focus.bar], ['bar', 1]);
    s = walk(s, [{ knob: -5 }]);
    assert.strictEqual(s.focus.bar, 0, 'stops at PREVIOUS');
    s = walk(s, [{ knob: 9 }]);
    assert.strictEqual(s.focus.bar, 2, 'stops at NEXT');
    assert.deepStrictEqual(go(s, { press: true }).acts, [{ type: 'bar', id: 'BTN_NEXT' }]);
    assert.deepStrictEqual(go(walk(s, [{ knob: -1 }]), { press: true }).acts, [{ type: 'bar', id: 'BTN_PLAY' }]);
    assert.deepStrictEqual(go(walk(s, [{ knob: -2 }]), { press: true }).acts, [{ type: 'bar', id: 'BTN_PREVIOUS' }]);
    s = walk(s, [{ tilt: 'S' }]);
    assert.strictEqual(at(s), 'bar', 'down from the bar: nothing');
    s = walk(s, [{ tilt: 'N' }]);
    assert.deepStrictEqual([at(s), sel(s)], ['page', 2], 'up: the row left');
    s = walk(s, [{ tilt: 'S' }]);
    assert.deepStrictEqual([at(s), s.focus.bar], ['bar', 2], 'the bar remembers its button');
    assert.strictEqual(sel(walk(s, [{ knob: 1 }])), 2, 'the knob on the bar does not move the list');
});

test('push up: the tabs (LIBRARY, NOW PLAYING, SETTINGS); the knob goes along them, a press opens one, push down returns', () => {
    let s = walk(opened(loggedIn(), 'k', 'tracks', TRACKS), [{ knob: 3 }, { tilt: 'N' }]);
    assert.deepStrictEqual([at(s), s.focus.tab], ['tabs', 0], 'on LIBRARY, the tab of the page shown');
    assert.strictEqual(sel(s), 3, 'the row stays');
    s = walk(s, [{ knob: 5 }]);
    assert.strictEqual(s.focus.tab, 2, 'Settings is the last');
    assert.deepStrictEqual(go(s, { press: true }).acts, [{ type: 'tab', index: 2 }]);
    s = walk(s, [{ knob: -9 }]);
    assert.strictEqual(s.focus.tab, 0);
    s = walk(s, [{ tilt: 'S' }]);
    assert.deepStrictEqual([at(s), sel(s)], ['page', 3]);
    // the tabs' own pages (model events, as main.js routes a tab: 0 library, 1 now playing)
    const np = M.reduce(walk(opened(loggedIn({}), 'k', 'tracks', TRACKS), [{ knob: 2 }]), { type: 'open-now-playing' });
    const back = M.reduce(np, { type: 'show-library' });
    assert.deepStrictEqual([back.screen, sel(back), back.stack.length], ['LIST', 2, 1], 'LIBRARY: where the library was left, not its top');
});

test('push right: now playing while a track is on (nothing otherwise); there, push right goes to the list that plays, at its track', () => {
    const none = opened(loggedIn(), 'k', 'tracks', TRACKS);
    assert.deepStrictEqual(N.input(none, null, { tilt: 'E' }), []);
    let s = opened(loggedIn({ track: TRACKS[3] }), 'k', 'tracks', TRACKS, 'Favourite tracks');
    s = M.reduce(s, { type: 'played', queue: { key: 'k', title: 'Favourite tracks', tracks: TRACKS } });
    s = walk(s, [{ tilt: 'E' }]);
    assert.strictEqual(s.screen, 'NOW_PLAYING');
    s = M.reduce(s, { type: 'show-library' });
    s = M.reduce(s, { type: 'open-list', key: 'other', title: 'Other', kind: 'tracks', source: { cmd: 'mixes' } });
    s = walk(s, [{ tilt: 'E' }, { tilt: 'E' }]);
    assert.deepStrictEqual([s.screen, M.top(s).key, sel(s), at(s)], ['LIST', 'k', 3, 'page'], 'the list that plays, on the playing track');
});

test('now playing: the knob starts on PAUSE in the bar; up is the progress line, where the knob winds; down or a press is done', () => {
    let s = M.reduce(loggedIn({}), { type: 'open-now-playing' });
    assert.deepStrictEqual([at(s), s.focus.bar], ['bar', 1]);
    assert.deepStrictEqual(go(s, { press: true }).acts, [{ type: 'bar', id: 'BTN_PLAY' }], 'a press pauses at once');
    s = walk(s, [{ tilt: 'N' }]);
    assert.strictEqual(at(s), 'progress');
    assert.deepStrictEqual(go(s, { knob: 2 }).acts, [{ type: 'seek-step', steps: 2 }]);
    assert.deepStrictEqual(go(s, { tilt: 'E' }).acts, [{ type: 'seek-step', steps: 1 }]);
    assert.deepStrictEqual(go(s, { tilt: 'W' }).acts, [{ type: 'seek-step', steps: -1 }]);
    assert.strictEqual(at(go(s, { press: true }).s), 'bar');
    assert.strictEqual(at(go(s, { tilt: 'S' }).s), 'bar');
    s = walk(s, [{ tilt: 'N' }]);
    assert.deepStrictEqual([at(s), s.focus.tab], ['tabs', 1], 'up again: the tabs, on NOW PLAYING');
    // nothing to seek in (no duration, an error): up goes to the tabs at once
    const e = M.reduce(loggedIn({ state: 'error', error: 'decode' }), { type: 'open-now-playing' });
    assert.strictEqual(at(walk(e, [{ tilt: 'N' }])), 'tabs');
    // left: back where it came from
    let l = walk(opened(loggedIn({}), 'k', 'tracks', TRACKS), [{ knob: 2 }, { tilt: 'E' }]);
    l = walk(l, [{ tilt: 'W' }]);
    assert.deepStrictEqual([l.screen, sel(l), at(l)], ['LIST', 2, 'page']);
});

test('message pages (an error, no internet, the login, nothing playing): the knob on their choices, press chooses, left is back', () => {
    let e = M.reduce(loggedIn(), { type: 'error', code: 'not-found', cmd: 'mix' });
    assert.deepStrictEqual([e.screen, at(e), e.focus.row], ['ERROR', 'page', 0]);
    assert.strictEqual(go(e, { press: true }).s.screen, 'LIBRARY', 'its one choice: back');
    assert.strictEqual(go(e, { tilt: 'W' }).s.screen, 'LIBRARY');
    let o = M.reduce(loggedIn(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in', online: false }) });
    assert.strictEqual(o.screen, 'OFFLINE');
    assert.deepStrictEqual(go(o, { press: true }).acts, [{ type: 'retry' }], 'first: try again');
    o = walk(o, [{ knob: 5 }]);
    assert.strictEqual(o.focus.row, 1, 'stops at the last choice');
    assert.strictEqual(go(o, { press: true }).s.screen, 'LIBRARY', 'the library, lists from before');
    let l = M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-out', loginError: 'login-denied' }) });
    assert.deepStrictEqual(go(l, { press: true }).acts, [{ type: 'login-new' }]);
    assert.deepStrictEqual([at(walk(l, [{ tilt: 'S' }])), at(walk(l, [{ tilt: 'N' }]))], ['bar', 'tabs']);
    const idle = M.reduce(loggedIn(), { type: 'open-now-playing' });
    assert.strictEqual(at(idle), 'page', 'nothing playing: the page\'s choice');
    assert.strictEqual(go(idle, { press: true }).s.screen, 'LIBRARY');
});

test('search: the knob goes along the letters, a press types, OK searches and goes to the results; up from them: the letters', () => {
    let s = M.reduce(loggedIn(), { type: 'open-search' });
    assert.deepStrictEqual([s.screen, s.search.keyboard, at(s), s.search.key], ['LIST', true, 'page', 0]);
    s = walk(s, [{ knob: 3 }, { press: true }, { knob: -3 }, { press: true }]);
    assert.strictEqual(s.search.query, 'DA');
    s = walk(s, [{ knob: -1 }]);
    assert.strictEqual(s.search.key, 0, 'stops at A');
    s = walk(s, [{ knob: 100 }]);
    assert.strictEqual(N.speller(s)[s.search.key], 'OK', 'OK is the last');
    s = walk(s, [{ press: true }]);
    assert.deepStrictEqual([s.search.keyboard, M.top(s).source.params.query], [false, 'DA']);
    s = M.reduce(s, { type: 'list-loaded', key: M.top(s).key, offset: 0, total: 3, items: TRACKS.slice(0, 3) });
    assert.deepStrictEqual([at(s), sel(s)], ['page', 0], 'on the first result');
    s = walk(s, [{ knob: 1 }]);
    assert.deepStrictEqual(go(s, { press: true }).acts.map((a) => a.type), ['play']);
    s = walk(s, [{ tilt: 'N' }]);
    assert.deepStrictEqual([s.search.keyboard, at(s)], [true, 'page'], 'up: the letters');
    s = walk(s, [{ tilt: 'S' }]);
    assert.deepStrictEqual([s.search.keyboard, at(s), sel(s)], [false, 'page', 1], 'down: the results, on the row left');
    s = walk(s, [{ tilt: 'S' }]);
    assert.strictEqual(at(s), 'bar');
    // the digits: 123 swaps the letters for them
    let d = M.reduce(loggedIn(), { type: 'open-search' });
    d = walk(d, [{ knob: 26 }]);
    assert.strictEqual(N.speller(d)[d.search.key], '123');
    d = walk(d, [{ press: true }]);
    assert.strictEqual(N.speller(d)[0], '0');
    d = walk(d, [{ knob: -30 }, { knob: 7 }, { press: true }]);
    assert.strictEqual(d.search.query, '7');
    // while the car moves: no letters; up from the results is the tabs
    let m = M.reduce(M.reduce(s, { type: 'driving', moving: true }), { type: 'focus', area: 'page' });
    m = walk(m, [{ tilt: 'N' }]);
    assert.deepStrictEqual([m.search.keyboard, at(m)], [false, 'tabs']);
    // left from the letters: back to My music
    assert.strictEqual(walk(M.reduce(loggedIn(), { type: 'open-search' }), [{ tilt: 'W' }]).screen, 'LIBRARY');
});

test('garbage in: no input, an unknown push, a strange focus event change nothing and never throw', () => {
    const s = opened(loggedIn(), 'k', 'tracks', TRACKS);
    [null, undefined, 7, 'x', {}, { tilt: 'Q' }, { knob: 'a' }, { knob: NaN }].forEach((ev) => assert.deepStrictEqual(N.input(s, null, ev), [], JSON.stringify(ev)));
    [{ type: 'focus' }, { type: 'focus', area: 'moon' }, { type: 'focus', bar: 9 }, { type: 'focus', tab: -1 }, { type: 'focus', row: 'x' }].forEach((ev) => {
        const n = M.reduce(s, ev);
        assert.deepStrictEqual(n.focus, s.focus, JSON.stringify(ev));
    });
});

run();
