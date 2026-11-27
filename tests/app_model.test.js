'use strict';
/**
 * D2: the app's state machine, apps/cmocan_tidal/model.js: one pure function (state, event) -> state for the
 * screens NO_SERVICE, OFFLINE, LOGIN, LIBRARY, LIST, NOW_PLAYING, ERROR. No drawing and no require in it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { defaultState } = require('./fakes/fake_service');
const M = require('../apps/cmocan_tidal/model');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'model.js'), 'utf8');

function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); }
    return o;
}
/** reduce with frozen states and events: the model must never change what it is given */
function go(state) {
    let s = deepFreeze(state);
    for (let i = 1; i < arguments.length; i++) s = deepFreeze(M.reduce(s, deepFreeze(arguments[i])));
    return s;
}
function status(over) {
    const st = defaultState();
    Object.keys(over || {}).forEach((k) => { st[k] = over[k]; });
    return { type: 'status', state: st };
}
const LOGGED_IN = status({ login: 'logged-in' });
const TRACK = { id: 1, title: 'A', artists: ['X'], album: null, coverId: null, duration: 10, streamReady: true, explicit: false };
const libraryState = () => go(M.initial(), LOGGED_IN);

test('the screens are the seven named ones; the model starts on NO_SERVICE, connecting', () => {
    assert.deepStrictEqual(M.SCREENS.slice().sort(), ['ERROR', 'LIBRARY', 'LIST', 'LOGIN', 'NOW_PLAYING', 'NO_SERVICE', 'OFFLINE']);
    const s = M.initial();
    assert.strictEqual(s.screen, 'NO_SERVICE');
    assert.strictEqual(s.starting, true);
});

test('model.js requires nothing (no kit, no SDK) and does not change the state or event it is given', () => {
    assert.ok(!/require\s*\(/.test(SRC), 'model.js has a require');
    go(M.initial(), LOGGED_IN, { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'mixes' } }, { type: 'back' });
});

test('no service: NO_SERVICE with a message, also after having been connected', () => {
    let s = go(M.initial(), { type: 'no-service' });
    assert.strictEqual(s.screen, 'NO_SERVICE');
    assert.strictEqual(s.starting, false);
    assert.ok(/service/i.test(s.message), s.message);
    s = go(libraryState(), { type: 'no-service' });
    assert.strictEqual(s.screen, 'NO_SERVICE');
    s = go(s, LOGGED_IN);
    assert.strictEqual(s.screen, 'LIBRARY', 'back when the service answers again');
});

test('status: logged out -> LOGIN, pending -> LOGIN, logged in -> LIBRARY, no internet -> OFFLINE', () => {
    assert.strictEqual(go(M.initial(), status({ login: 'logged-out' })).screen, 'LOGIN');
    assert.strictEqual(go(M.initial(), status({ login: 'login-pending' })).screen, 'LOGIN');
    assert.strictEqual(go(M.initial(), LOGGED_IN).screen, 'LIBRARY');
    const off = go(M.initial(), status({ login: 'logged-in', online: false }));
    assert.strictEqual(off.screen, 'OFFLINE');
    assert.strictEqual(off.message, 'No internet');
    assert.strictEqual(go(off, LOGGED_IN).screen, 'LIBRARY', 'internet back');
    assert.strictEqual(go(M.initial(), status({ login: 'logged-out', online: false })).screen, 'OFFLINE');
});

test('logged out while in the library, a list or now playing -> LOGIN', () => {
    const lo = status({ login: 'logged-out' });
    assert.strictEqual(go(libraryState(), lo).screen, 'LOGIN');
    assert.strictEqual(go(libraryState(), { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'mixes' } }, lo).screen, 'LOGIN');
    assert.strictEqual(go(libraryState(), { type: 'open-now-playing' }, lo).screen, 'LOGIN');
});

test('the status is kept: player, login, online, version', () => {
    const st = defaultState();
    st.login = 'logged-in';
    st.player = { state: 'playing', track: TRACK, position: 3, duration: 10, queueIndex: 0, queueLength: 1, quality: 'HIGH', error: null };
    const s = go(M.initial(), { type: 'status', state: st });
    assert.strictEqual(s.service.login, 'logged-in');
    assert.strictEqual(s.service.online, true);
    assert.strictEqual(s.player.state, 'playing');
    assert.strictEqual(s.player.track.title, 'A');
});

test('a late status answer (an older request id) is ignored', () => {
    let s = go(M.initial(), { type: 'status', id: 5, state: Object.assign(defaultState(), { login: 'logged-in' }) });
    s = go(s, { type: 'status', id: 4, state: Object.assign(defaultState(), { login: 'logged-out' }) });
    assert.strictEqual(s.screen, 'LIBRARY');
    assert.strictEqual(s.service.login, 'logged-in');
});

test('login: the code is kept with its expiry; past it the screen offers a new one; logged in clears it', () => {
    let s = go(M.initial(), status({ login: 'logged-out' }));
    assert.strictEqual(M.wantsLoginCode(s), true, 'asks for a code at once');
    s = go(s, { type: 'login-requested' });
    assert.strictEqual(M.wantsLoginCode(s), false, 'not twice');
    s = go(s, { type: 'login-started', url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresIn: 300, now: 1000 });
    assert.deepStrictEqual([s.login.url, s.login.userCode, s.login.expiresAt, s.login.expired], ['https://link.tidal.com/ABCDE', 'ABCDE', 301000, false]);
    s = go(s, status({ login: 'login-pending' }), { type: 'tick', now: 200000 });
    assert.strictEqual(s.login.expired, false);
    s = go(s, { type: 'tick', now: 301000 });
    assert.strictEqual(s.login.expired, true, 'expired by the clock');
    assert.strictEqual(s.screen, 'LOGIN');
    assert.strictEqual(M.wantsLoginCode(s), false, 'a new code only when asked for (the screen offers it)');
    s = go(s, { type: 'login-requested' });
    assert.strictEqual(s.login.requesting, true);
    s = go(s, { type: 'login-started', url: 'https://link.tidal.com/FGHIJ', userCode: 'FGHIJ', expiresIn: 300, now: 400000 });
    assert.strictEqual(s.login.userCode, 'FGHIJ');
    s = go(s, LOGGED_IN);
    assert.strictEqual(s.screen, 'LIBRARY');
    assert.strictEqual(s.login, null);
});

test('login: the service gives up on a pending code (back to logged-out) -> expired', () => {
    let s = go(M.initial(), status({ login: 'logged-out' }), { type: 'login-requested' },
        { type: 'login-started', url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresIn: 300, now: 0 },
        status({ login: 'login-pending' }), status({ login: 'logged-out' }));
    assert.strictEqual(s.login.expired, true);
});

test('contract 2: a login pending in the service (the app restarted): its code comes from status.loginPending, none is asked for', () => {
    const lp = { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresAt: 1795000300000 };
    let s = go(M.initial(), status({ login: 'login-pending', loginPending: lp }));
    assert.strictEqual(s.screen, 'LOGIN');
    assert.deepStrictEqual([s.login.url, s.login.userCode, s.login.expiresAt, s.login.expired, s.login.requesting], [lp.url, 'ABCDE', lp.expiresAt, false, false]);
    assert.strictEqual(M.wantsLoginCode(s), false, 'no login-start while one is pending');
    // the same code in the next status changes nothing; past its time the clock still expires it
    assert.strictEqual(M.reduce(s, status({ login: 'login-pending', loginPending: lp })).login, s.login);
    s = go(s, { type: 'tick', now: lp.expiresAt });
    assert.strictEqual(s.login.expired, true);
    assert.strictEqual(go(s, status({ login: 'login-pending', loginPending: lp })).login.expired, true, 'the old code is not shown again');
    // a new code (asked for on the phone or by another app run) replaces the shown one
    const lp2 = { url: 'https://link.tidal.com/FGHIJ', userCode: 'FGHIJ', expiresAt: lp.expiresAt + 300000 };
    assert.strictEqual(go(s, status({ login: 'login-pending', loginPending: lp2 })).login.userCode, 'FGHIJ');
    // asked for, then the status carries it before the login-start answer does
    s = go(M.initial(), status({ login: 'logged-out' }), { type: 'login-requested' }, status({ login: 'login-pending', loginPending: lp }));
    assert.strictEqual(s.login.userCode, 'ABCDE');
    // garbage in loginPending: ignored (rule R1), still no login-start while pending
    [null, 'x', { url: 7 }, { url: 'https://a', userCode: '' }, { url: 'https://a', userCode: 'A', expiresAt: 'soon' }].forEach((bad) => {
        const b = go(M.initial(), status({ login: 'login-pending', loginPending: bad }));
        assert.strictEqual(b.screen, 'LOGIN');
        assert.ok(!b.login || !b.login.url, JSON.stringify(bad));
        assert.strictEqual(M.wantsLoginCode(b), false, JSON.stringify(bad));
    });
});

test('contract 2: status.loginError: login-expired -> the code expired, login-denied -> refused; a new code only on request', () => {
    const lp = { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresAt: 1795000300000 };
    const pending = status({ login: 'login-pending', loginPending: lp });
    // while the app watched the code
    let s = go(M.initial(), pending, status({ login: 'logged-out', loginError: 'login-denied' }));
    assert.deepStrictEqual([s.screen, s.login.expired, s.login.denied], ['LOGIN', true, true]);
    assert.strictEqual(M.wantsLoginCode(s), false);
    s = go(M.initial(), pending, status({ login: 'logged-out', loginError: 'login-expired' }));
    assert.deepStrictEqual([s.login.expired, !!s.login.denied], [true, false]);
    assert.strictEqual(M.wantsLoginCode(s), false);
    // the app started after the login ended
    s = go(M.initial(), status({ login: 'logged-out', loginError: 'login-denied' }));
    assert.deepStrictEqual([s.screen, s.login.denied, M.wantsLoginCode(s)], ['LOGIN', true, false]);
    s = go(M.initial(), status({ login: 'logged-out', loginError: 'login-expired' }));
    assert.deepStrictEqual([s.login.expired, !!s.login.denied, M.wantsLoginCode(s)], [true, false, false]);
    // asked for again: a stale status with the old loginError does not undo it
    s = go(s, { type: 'login-requested' }, status({ login: 'logged-out', loginError: 'login-expired' }));
    assert.strictEqual(s.login.requesting, true);
    s = go(s, { type: 'login-started', url: 'https://link.tidal.com/FGHIJ', userCode: 'FGHIJ', expiresIn: 300, now: 0 }, status({ login: 'logged-out', loginError: 'login-expired' }));
    assert.deepStrictEqual([s.login.userCode, s.login.expired], ['FGHIJ', false]);
    // no loginError and logged out: a code is asked for by itself; garbage loginError is ignored
    assert.strictEqual(M.wantsLoginCode(go(M.initial(), status({ login: 'logged-out' }))), true);
    assert.strictEqual(M.wantsLoginCode(go(M.initial(), status({ login: 'logged-out', loginError: 'nope' }))), true);
});

test('contract 2: player.skipped: a newly skipped track is greyed out and named in a notice; the count when its title is not known', () => {
    const T2 = Object.assign({}, TRACK, { id: 2, title: 'Second' }), T3 = Object.assign({}, TRACK, { id: 3, title: 'Third' });
    const playingWith = (skipped) => { const st = defaultState(); st.login = 'logged-in'; st.player = Object.assign({}, st.player, { state: 'playing', track: TRACK, queueIndex: 0, queueLength: 3, skipped: skipped }); return { type: 'status', state: st }; };
    let s = go(libraryState(), { type: 'open-list', key: 'k', title: 'T', kind: 'tracks', source: { cmd: 'playlist', params: { uuid: 'u' } } },
        { type: 'list-loaded', key: 'k', offset: 0, total: 3, items: [TRACK, T2, T3] }, playingWith([]), { type: 'open-now-playing' });
    assert.deepStrictEqual(s.player.skipped, []);
    s = go(s, playingWith([{ id: 2, error: 'not-available' }]));
    assert.strictEqual(s.message, 'Skipped: Second (not available)');
    assert.strictEqual(s.unavailable[2], true, 'greyed out in the lists');
    assert.strictEqual(s.screen, 'NOW_PLAYING');
    const same = go(s, { type: 'dismiss' }, playingWith([{ id: 2, error: 'not-available' }]));
    assert.strictEqual(same.message, null, 'told once');
    s = go(s, playingWith([{ id: 2, error: 'not-available' }, { id: 3, error: 'not-found' }]));
    assert.strictEqual(s.message, 'Skipped: Third (not found)');
    s = go(s, playingWith([{ id: 2, error: 'not-available' }, { id: 3, error: 'not-found' }, { id: 98, error: 'not-available' }, { id: 99, error: 'tidal-error' }]));
    assert.strictEqual(s.message, 'Skipped 2 tracks that could not be played');
    s = go(s, playingWith([{ id: 97, error: 'not-available' }]));
    assert.strictEqual(s.message, 'Skipped 1 track (not available)', 'a new queue: its own skips; a title not in the lists: the count');
    // the app started while the queue had skips already: greyed out, no notice
    const fresh = go(M.initial(), playingWith([{ id: 2, error: 'not-available' }]));
    assert.strictEqual(fresh.message, null);
    assert.strictEqual(fresh.unavailable[2], true);
    // garbage (rule R1)
    ['x', null, [1, null, { id: 'a' }, { error: 'not-available' }, { id: -1, error: 'x' }], {}].forEach((bad) => {
        const st = defaultState(); st.login = 'logged-in'; st.player = Object.assign({}, st.player, { skipped: bad });
        const b = go(libraryState(), { type: 'status', state: st });
        assert.ok(Array.isArray(b.player.skipped), JSON.stringify(bad));
        assert.strictEqual(b.screen, 'LIBRARY');
    });
});

test('lists: open (loading), loaded, deeper, back pops, back from the first goes to the library', () => {
    let s = go(libraryState(), { type: 'open-list', key: 'playlists', title: 'Playlists', kind: 'playlists', source: { cmd: 'playlists' } });
    assert.strictEqual(s.screen, 'LIST');
    assert.strictEqual(M.top(s).loading, true);
    s = go(s, { type: 'list-loaded', key: 'playlists', offset: 0, total: 2, items: [{ uuid: 'u1', title: 'P1', numberOfTracks: 1, coverId: null }, { uuid: 'u2', title: 'P2', numberOfTracks: 1, coverId: null }] });
    assert.strictEqual(M.top(s).loading, false);
    assert.strictEqual(M.top(s).items.length, 2);
    s = go(s, { type: 'open-list', key: 'playlist:u1', title: 'P1', kind: 'tracks', source: { cmd: 'playlist', params: { uuid: 'u1' } } });
    assert.strictEqual(s.stack.length, 2);
    s = go(s, { type: 'list-loaded', key: 'playlist:u1', offset: 0, total: 3, items: [TRACK, TRACK] });
    s = go(s, { type: 'list-loaded', key: 'playlist:u1', offset: 2, total: 3, items: [TRACK] });
    assert.strictEqual(M.top(s).items.length, 3, 'the next page appended');
    s = go(s, { type: 'list-loaded', key: 'nope', offset: 0, total: 1, items: [TRACK] });
    assert.strictEqual(M.top(s).items.length, 3, 'a page for a list no longer open is ignored');
    s = go(s, { type: 'back' });
    assert.strictEqual(s.screen, 'LIST'); assert.strictEqual(M.top(s).key, 'playlists');
    s = go(s, { type: 'back' });
    assert.strictEqual(s.screen, 'LIBRARY'); assert.strictEqual(s.stack.length, 0);
    assert.strictEqual(go(s, { type: 'back' }).screen, 'LIBRARY', 'back on the library stays (the HMI leaves the app)');
});

test('now playing: opened from anywhere, back returns; a started play stays in its list (U1) and keeps which list it is', () => {
    let s = go(libraryState(), { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes' } }, { type: 'open-now-playing' });
    assert.strictEqual(s.screen, 'NOW_PLAYING');
    s = go(s, { type: 'back' });
    assert.strictEqual(s.screen, 'LIST');
    const l = go(libraryState(), { type: 'open-list', key: 'k', title: 'Favourite tracks', kind: 'tracks', source: { cmd: 'favorites' } },
        { type: 'list-loaded', key: 'k', offset: 0, total: 2, items: [TRACK, Object.assign({}, TRACK, { id: 2 })] }, { type: 'cursor', sel: 1, top: 0 });
    s = go(l, { type: 'played', queue: { key: 'k', title: 'Favourite tracks', tracks: [TRACK, Object.assign({}, TRACK, { id: 2 })] } });
    assert.deepStrictEqual([s.screen, M.top(s).sel, s.focus.area], ['LIST', 1, 'page'], 'the same list, the same row');
    assert.deepStrictEqual([s.queue.key, s.queue.title, s.queue.tracks.length], ['k', 'Favourite tracks', 2]);
    assert.strictEqual(go(l, { type: 'played' }), l, 'without its list: nothing');
    assert.strictEqual(go(l, { type: 'played', queue: 'x' }), l);
    assert.strictEqual(go(libraryState(), { type: 'open-library' }).screen, 'LIBRARY');
});

test('every error code of the contract leads to a named screen and a message', () => {
    P.ERROR_CODES.forEach((code) => {
        const e = M.ERRORS[code];
        assert.ok(e, 'no entry for ' + code);
        const s = go(libraryState(), { type: 'error', code: code, cmd: 'favorites' });
        assert.ok(M.SCREENS.indexOf(s.screen) >= 0, code + ' -> ' + s.screen);
        assert.strictEqual(typeof s.message, 'string', code);
    });
    const at = (code) => go(libraryState(), { type: 'error', code: code, cmd: 'favorites' });
    assert.deepStrictEqual([at('offline').screen, at('offline').message], ['OFFLINE', 'No internet']);
    assert.deepStrictEqual([at('not-logged-in').screen], ['LOGIN']);
    assert.deepStrictEqual([at('login-expired').screen, at('login-expired').message], ['LOGIN', 'Please log in again']);
    assert.deepStrictEqual([at('not-found').screen, at('not-found').message], ['ERROR', 'Not found']);
    assert.deepStrictEqual([at('rate-limited').screen, at('rate-limited').message], ['ERROR', 'Busy, try again shortly']);
    assert.deepStrictEqual([at('tidal-error').screen, at('tidal-error').message], ['ERROR', 'TIDAL error']);
    assert.strictEqual(at('bad-request').screen, 'LIBRARY', 'a bug: logged, the screen stays');
    assert.strictEqual(at('busy').screen, 'LIBRARY', 'retried, the screen stays');
    const na = go(libraryState(), { type: 'error', code: 'not-available', cmd: 'play', trackId: 77 });
    assert.strictEqual(na.screen, 'LIBRARY');
    assert.strictEqual(na.unavailable[77], true, 'the track is marked (greyed out)');
});

test('the client\'s own errors: no-service -> NO_SERVICE; timeout and disconnected keep the screen with a message', () => {
    assert.strictEqual(go(libraryState(), { type: 'error', code: 'no-service' }).screen, 'NO_SERVICE');
    ['timeout', 'disconnected', 'bad-answer', 'closed', 'something-new'].forEach((code) => {
        const s = go(libraryState(), { type: 'error', code: code });
        assert.strictEqual(s.screen, 'LIBRARY', code);
        assert.strictEqual(typeof s.message, 'string', code);
    });
});

test('ERROR: back (or dismiss) returns to the screen before it', () => {
    let s = go(libraryState(), { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes' } },
        { type: 'error', code: 'not-found', cmd: 'mix' });
    assert.strictEqual(s.screen, 'ERROR');
    assert.strictEqual(go(s, { type: 'back' }).screen, 'LIST');
    assert.strictEqual(go(s, { type: 'dismiss' }).screen, 'LIST');
    assert.strictEqual(go(s, { type: 'dismiss' }).message, null);
    assert.strictEqual(go(s, LOGGED_IN).screen, 'ERROR', 'a status does not hide the error');
});

test('a failed list load: the list shows the error, and the error code acts as above', () => {
    let s = go(libraryState(), { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes' } },
        { type: 'list-failed', key: 'mixes', code: 'tidal-error' });
    assert.strictEqual(s.screen, 'ERROR');
    assert.strictEqual(M.top(s).loading, false);
    assert.strictEqual(M.top(s).error, 'tidal-error');
    s = go(libraryState(), { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes' } },
        { type: 'list-failed', key: 'mixes', code: 'timeout' });
    assert.strictEqual(s.screen, 'LIST');
    assert.strictEqual(M.top(s).error, 'timeout');
});

test('offline: the library can still be opened (lists come stale); it stays until the internet is back and goes again', () => {
    const offline = status({ login: 'logged-in', online: false });
    let s = go(M.initial(), offline);
    assert.strictEqual(s.screen, 'OFFLINE');
    s = go(s, { type: 'open-library' }, offline);
    assert.strictEqual(s.screen, 'LIBRARY');
    s = go(s, LOGGED_IN, offline);
    assert.strictEqual(s.screen, 'OFFLINE', 'offline again after being online');
});

test('an unknown event, or a malformed one, leaves the state unchanged (the same object); garbage status does not throw', () => {
    const s = libraryState();
    assert.strictEqual(M.reduce(s, { type: 'warp-drive' }), s);
    assert.strictEqual(M.reduce(s, null), s);
    assert.strictEqual(M.reduce(s, undefined), s);
    assert.strictEqual(M.reduce(s, 42), s);
    assert.strictEqual(M.reduce(s, {}), s);
    [{ type: 'status' }, { type: 'status', state: null }, { type: 'status', state: 'x' }, { type: 'status', state: { login: 7, online: 'yes', player: 'p' } },
        { type: 'status', state: { login: 'logged-in', player: { state: 'playing', track: 'x', position: 'a' } } },
        { type: 'list-loaded', key: 'k', items: 'no' }, { type: 'open-list' }, { type: 'login-started' }, { type: 'error' }, { type: 'tick' }]
        .forEach((ev) => { const r = M.reduce(s, ev); assert.ok(M.SCREENS.indexOf(r.screen) >= 0, JSON.stringify(ev)); });
});

run();
