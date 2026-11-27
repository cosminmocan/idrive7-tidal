'use strict';
/**
 * model.js - the app's state machine: reduce(state, event) -> state. Pure: no drawing, no I/O, no require; the
 * state it is given is never changed (a new one is returned; the same object when nothing changes).
 *
 * Screens: NO_SERVICE (the tool is missing or not answering), OFFLINE (no internet), LOGIN (the QR code), LIBRARY
 * (favourites, playlists, mixes, search), LIST (a stack of lists: tracks, albums, playlists, mixes, results),
 * NOW_PLAYING, ERROR (a message, back to where it came from).
 *
 * Events (event.type):
 *   status {state, id}        a `status` answer's state (id: its request id; an older one than applied is ignored);
 *                             its loginPending gives the code of a pending login, its loginError how one ended
 *   no-service                the client has no socket to talk to
 *   error {code, cmd, trackId} an error answer (contract codes) or the client's own (no-service, timeout, ...)
 *   login-requested           a login-start was sent;  login-started {url, userCode, expiresIn, now}: its answer
 *   tick {now}                the clock: a login code's expiry
 *   open-library, open-list {key, title, kind, source: {cmd, params}}, list-loaded {key, offset, total, items, stale},
 *   list-failed {key, code}, open-now-playing, played {queue}, back, dismiss, cursor {sel, top}
 *   open-search, open-keyboard, close-keyboard, key {key}, search-submit, driving {moving}   (search, the rules while
 *                             driving: D7)
 *   focus {area, bar, tab, row, key}   where the controller is (U1): area 'page' (a list's row, a message's choice,
 *                             search's letters), 'bar' (bar: 0 PREVIOUS, 1 PLAY / PAUSE, 2 NEXT), 'tabs' (tab: 0 LIBRARY,
 *                             1 NOW PLAYING, then SETTINGS), 'progress' (now playing's progress line); row: a message
 *                             page's choice; key: the search letter
 *   show-library              the LIBRARY tab: where the library was left (the list open, its row)
 *   show-queue                the list that plays (played's queue), on the playing track
 * A new screen or another list puts the controller on the page (now playing: on PLAY / PAUSE in the bar).
 * played {queue: {key, title, tracks}}: a track was started from a list; the screen stays (the owner's decision).
 * Node 8.9.4 syntax.
 */

const SCREENS = ['NO_SERVICE', 'OFFLINE', 'LOGIN', 'LIBRARY', 'LIST', 'NOW_PLAYING', 'ERROR'];
const LOGINS = ['logged-out', 'login-pending', 'logged-in'];
const LOGIN_ERRORS = ['login-expired', 'login-denied'];
const PLAYER_STATES = ['idle', 'loading', 'playing', 'paused', 'buffering', 'error'];
const NO_SERVICE_TEXT = 'The TIDAL service is not installed or not running';
const MOVING_TEXT = 'Search can be typed only while the car is parked';
const MAX_QUERY = 200;
const AREAS = ['page', 'bar', 'tabs', 'progress'];
const BAR_BUTTONS = 3;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), DIGITS = '0123456789'.split('');
/** search's one row of characters: letters (or digits), the switch between them, space, delete, OK */
function speller(digits) { return (digits ? DIGITS : LETTERS).concat([digits ? 'ABC' : '123', 'SPACE', 'DEL', 'OK']); }

/** what each error code does: the screen it leads to (null: the screen stays) and the message shown */
const ERRORS = {
    // the contract's codes (docs/PROTOCOL.md section 1)
    'offline': { screen: 'OFFLINE', message: 'No internet' },
    'not-logged-in': { screen: 'LOGIN', message: 'Please log in' },
    'login-expired': { screen: 'LOGIN', message: 'Please log in again' },
    'not-found': { screen: 'ERROR', message: 'Not found' },
    'not-available': { screen: null, message: 'This track cannot be played here' },
    'rate-limited': { screen: 'ERROR', message: 'Busy, try again shortly' },
    'tidal-error': { screen: 'ERROR', message: 'TIDAL error' },
    'bad-request': { screen: null, message: '' },
    'busy': { screen: null, message: 'The service is busy, trying again' },
    // the client's own (client.js)
    'no-service': { screen: 'NO_SERVICE', message: NO_SERVICE_TEXT },
    'timeout': { screen: null, message: 'The service did not answer' },
    'disconnected': { screen: null, message: 'The connection to the service was lost' },
    'bad-answer': { screen: null, message: 'The service sent something unexpected' },
    'closed': { screen: null, message: '' },
};
const UNKNOWN_ERROR = { screen: null, message: 'Something went wrong' };

function initial() {
    return {
        screen: 'NO_SERVICE', starting: true, message: null, back: null,
        service: { login: null, online: null, version: null, prefs: null },
        player: null, statusId: 0,
        login: null,
        stack: [],
        library: { sel: 0, top: 0 },
        search: { query: '', keyboard: false, key: 0, digits: false },
        moving: false,
        offlineBrowse: false,
        unavailable: {},
        focus: { area: 'page', bar: 1, tab: 0, row: 0 },
        queue: null,
        errorCode: null,
    };
}

/* ---------- small helpers ---------- */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && isFinite(v);
const isIndex = (v) => typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v;
function assign(a, b) { const o = {}; Object.keys(a).forEach((k) => { o[k] = a[k]; }); Object.keys(b).forEach((k) => { o[k] = b[k]; }); return o; }
function top(s) { return s.stack.length ? s.stack[s.stack.length - 1] : null; }
function withTop(s, f) { const st = s.stack.slice(); st[st.length - 1] = f; return assign(s, { stack: st }); }

/** a track from the service, or null when it is not one (rule R1: what comes may be anything) */
function cleanTrack(t) {
    if (!isObj(t) || typeof t.title !== 'string') return null;
    return {
        id: t.id, title: t.title,
        artists: Array.isArray(t.artists) ? t.artists.filter((a) => typeof a === 'string') : [],
        album: isObj(t.album) && typeof t.album.title === 'string' ? { id: t.album.id, title: t.album.title } : null,
        coverId: typeof t.coverId === 'string' ? t.coverId : null,
        duration: isNum(t.duration) ? t.duration : null,
        streamReady: t.streamReady !== false, explicit: t.explicit === true,
    };
}
function cleanPlayer(p) {
    if (!isObj(p)) return null;
    return {
        state: PLAYER_STATES.indexOf(p.state) >= 0 ? p.state : 'idle',
        track: cleanTrack(p.track),
        position: isNum(p.position) && p.position >= 0 ? p.position : 0,
        duration: isNum(p.duration) && p.duration > 0 ? p.duration : null,
        queueIndex: isNum(p.queueIndex) ? p.queueIndex : -1,
        queueLength: isNum(p.queueLength) ? p.queueLength : 0,
        quality: typeof p.quality === 'string' ? p.quality : null,
        error: typeof p.error === 'string' ? p.error : null,
        skipped: Array.isArray(p.skipped) ? p.skipped.filter((k) => isObj(k) && isNum(k.id) && k.id > 0).map((k) => ({ id: k.id, error: typeof k.error === 'string' ? k.error : '' })) : [],
    };
}

/** the title of a track in the lists open (or playing), or null */
function titleOf(s, id) {
    for (let i = s.stack.length - 1; i >= 0; i--) {
        const it = s.stack[i].items.filter((x) => isObj(x) && x.id === id && typeof x.title === 'string')[0];
        if (it) return it.title;
    }
    return s.player && s.player.track && s.player.track.id === id ? s.player.track.title : null;
}
const SKIP_REASON = { 'not-available': 'not available', 'not-found': 'not found' };
/** tracks the service passed over that this state has not seen yet: greyed out, and told (not on the first
 *  status: those were there before the app started) */
function onSkipped(before, n) {
    const now = n.player ? n.player.skipped : [];
    const was = before.player ? before.player.skipped : null;
    const seen = {};
    (was || []).forEach((k) => { seen[k.id] = true; });
    const fresh = now.filter((k) => !seen[k.id]);
    if (!fresh.length) return n;
    const u = assign(n.unavailable, {});
    fresh.forEach((k) => { u[k.id] = true; });
    let r = assign(n, { unavailable: u });
    if (!was) return r;
    const k = fresh[0], why = SKIP_REASON[k.error] || 'could not be played', title = titleOf(n, k.id);
    let text;
    if (fresh.length > 1) text = 'Skipped ' + fresh.length + ' tracks that could not be played';
    else if (title) text = 'Skipped: ' + title + ' (' + why + ')';
    else text = 'Skipped 1 track (' + why + ')';
    r = assign(r, { message: text });
    return r;
}

/** a pending login's code from status.loginPending: {url, userCode, expiresAt}, or null when it is not one (R1) */
function pendingCode(lp) {
    if (!isObj(lp) || typeof lp.url !== 'string' || !/^https:\/\//.test(lp.url) || typeof lp.userCode !== 'string' || !lp.userCode || !isNum(lp.expiresAt)) return null;
    return { url: lp.url, userCode: lp.userCode, expiresAt: lp.expiresAt };
}

/** the screen the app's state calls for when it is not in a page of its own */
function baseScreen(s) {
    if (s.service.online === false && !s.offlineBrowse) return 'OFFLINE';
    if (s.service.login !== 'logged-in') return 'LOGIN';
    return s.stack.length ? 'LIST' : 'LIBRARY';
}
function goTo(s, screen, message) {
    if (screen === s.screen && message === undefined) return s;
    return assign(s, { screen: screen, message: message === undefined ? (screen === 'OFFLINE' ? 'No internet' : null) : message });
}

/* ---------- the events ---------- */
function onStatus(s, ev) {
    const raw = ev.state;
    if (!isObj(raw)) return s;
    if (isNum(ev.id) && ev.id < s.statusId) return s;           // a late answer to an older request
    const was = s.service.login;
    const service = {
        login: LOGINS.indexOf(raw.login) >= 0 ? raw.login : s.service.login,
        online: typeof raw.online === 'boolean' ? raw.online : s.service.online,
        version: typeof raw.version === 'string' ? raw.version : s.service.version,
        prefs: isObj(raw.prefs) ? raw.prefs : s.service.prefs,
    };
    let n = assign(s, { service: service, starting: false, statusId: isNum(ev.id) ? ev.id : s.statusId });
    if (raw.player !== undefined) { n.player = cleanPlayer(raw.player); n = onSkipped(s, n); }
    if (service.online) n.offlineBrowse = false;
    // the login code: gone once logged in; a pending one's code from the status (the app may have restarted);
    // ended (expired, or refused on the phone) when the service gives up on it
    const lp = pendingCode(raw.loginPending), lerr = LOGIN_ERRORS.indexOf(raw.loginError) >= 0 ? raw.loginError : null;
    if (service.login === 'logged-in') n.login = null;
    else if (service.login === 'login-pending') {
        if (lp && (!n.login || !n.login.url || n.login.url !== lp.url)) n.login = { requesting: false, url: lp.url, userCode: lp.userCode, expiresAt: lp.expiresAt, expired: false };
    } else if (service.login === 'logged-out') {
        const watched = n.login && n.login.url && !n.login.expired && was === 'login-pending';
        if (watched) n.login = assign(n.login, { expired: true, denied: lerr === 'login-denied' });
        else if (!n.login && lerr) n.login = { requesting: false, url: null, userCode: null, expiresAt: null, expired: true, denied: lerr === 'login-denied' };
    }
    // the screen
    const cur = s.screen;
    if (cur === 'ERROR') return n;
    let want = cur;
    if (cur === 'NO_SERVICE' || cur === 'OFFLINE' || cur === 'LOGIN') want = baseScreen(n);
    else if (service.login !== 'logged-in') want = 'LOGIN';
    else if (service.online === false && !n.offlineBrowse && cur !== 'NOW_PLAYING') want = 'OFFLINE';
    if (want !== cur) n = goTo(n, want);
    return n;
}

function onError(s, code, extra) {
    const e = ERRORS[code] || UNKNOWN_ERROR;
    let n = s;
    if (code === 'not-available' && extra && extra.trackId != null) {
        const u = assign(s.unavailable, {});
        u[extra.trackId] = true;
        n = assign(n, { unavailable: u });
    }
    if (code === 'login-expired' || code === 'not-logged-in') n = assign(n, { login: null });
    if (code === 'no-service') n = assign(n, { starting: false });
    if (!e.screen) return assign(n, { message: e.message });
    if (e.screen === 'ERROR') return assign(n, { screen: 'ERROR', message: e.message, errorCode: code, back: s.screen === 'ERROR' ? s.back : s.screen });
    if (e.screen === 'OFFLINE') n = assign(n, { offlineBrowse: false });
    return assign(n, { screen: e.screen, message: e.message });
}

function onBack(s) {
    switch (s.screen) {
        case 'ERROR': {
            const to = s.back && s.back !== 'ERROR' ? s.back : baseScreen(s);
            return assign(s, { screen: to === 'LIST' && !s.stack.length ? 'LIBRARY' : to, message: null, back: null });
        }
        case 'NOW_PLAYING': {
            const to = s.back === 'LIST' && s.stack.length ? 'LIST' : 'LIBRARY';
            return assign(s, { screen: to, back: null });
        }
        case 'LIST': {
            const st = s.stack.slice(0, -1);
            return assign(s, { stack: st, screen: st.length ? 'LIST' : 'LIBRARY', search: assign(s.search, { keyboard: false }) });
        }
        default: return s;
    }
}

function newFrame(ev) {
    return {
        key: ev.key, title: typeof ev.title === 'string' ? ev.title : '', kind: ev.kind || 'tracks',
        source: { cmd: ev.source.cmd, params: isObj(ev.source.params) ? ev.source.params : {} },
        items: [], total: null, loading: true, error: null, stale: false, sel: 0, top: 0,
    };
}
/** the search page: results of `query` (none before the first search) */
function searchFrame(query) {
    return {
        key: 'search', title: query ? 'Search: ' + query : 'Search', kind: 'search',
        source: { cmd: 'search', params: { query: query } },
        items: [], total: null, loading: !!query, error: null, stale: false, sel: 0, top: 0,
    };
}
function submitSearch(s) {
    const q = s.search.query.trim();
    if (!s.search.keyboard || s.moving || !q || q.length > MAX_QUERY) return s;
    const f = top(s);
    if (!f || f.kind !== 'search') return s;
    const nf = searchFrame(q);
    nf.key = 'search:' + q;
    return withTop(assign(s, { search: assign(s.search, { keyboard: false }) }), nf);
}
function frameIndex(s, key) { for (let i = s.stack.length - 1; i >= 0; i--) if (s.stack[i].key === key) return i; return -1; }

/** where the controller goes on a screen it comes to: the page (now playing with a track: PLAY / PAUSE in the bar) */
function arrive(n, s) {
    const np = n.screen === 'NOW_PLAYING';
    return { area: np && trackOn(n) ? 'bar' : 'page', bar: np ? 1 : s.focus.bar, tab: np ? 1 : 0, row: 0 };
}
function reduce(s, ev) {
    const n = step(s, ev);
    if (n === s) return n;
    const a = top(s), b = top(n);
    if (n.screen !== s.screen || n.stack.length !== s.stack.length || (a && b && a.key !== b.key)) return assign(n, { focus: arrive(n, s) });
    return n;
}

function onFocus(s, ev) {
    const o = {};
    if (ev.area !== undefined) { if (AREAS.indexOf(ev.area) < 0) return s; o.area = ev.area; }
    if (ev.bar !== undefined) { if (!isIndex(ev.bar) || ev.bar >= BAR_BUTTONS) return s; o.bar = ev.bar; }
    if (ev.tab !== undefined) { if (!isIndex(ev.tab) || ev.tab > 9) return s; o.tab = ev.tab; }
    if (ev.row !== undefined) { if (!isIndex(ev.row) || ev.row > 9) return s; o.row = ev.row; }
    let n = s;
    if (ev.key !== undefined) {
        if (!isIndex(ev.key) || ev.key >= speller(s.search.digits).length) return s;
        if (ev.key !== s.search.key) n = assign(n, { search: assign(s.search, { key: ev.key }) });
    }
    const changed = Object.keys(o).filter((k) => o[k] !== s.focus[k]);
    return changed.length ? assign(n, { focus: assign(s.focus, o) }) : n;
}

/** the list that plays, on the playing track (push right on now playing) */
function showQueue(s) {
    const q = s.queue, i = q ? frameIndex(s, q.key) : -1;
    if (i < 0) return s;
    const f = s.stack[i], id = s.player && s.player.track ? s.player.track.id : null;
    let j = -1;
    if (id != null) for (let k = 0; k < f.items.length; k++) if (isObj(f.items[k]) && f.items[k].id === id) { j = k; break; }
    const st = s.stack.slice(0, i + 1);
    if (j >= 0) st[i] = assign(f, { sel: j, top: Math.max(0, j - 2) });
    return assign(s, { screen: 'LIST', stack: st, back: null, message: null });
}

/** row j of frame f can be played (or opened): not a track the service cannot stream */
function playable(s, f, j) {
    if (f.kind !== 'tracks' && f.kind !== 'search') return true;
    const it = f.items[j];
    return !isObj(it) || (it.streamReady !== false && !(s.unavailable && s.unavailable[it.id]));
}

function step(s, ev) {
    if (!isObj(ev) || typeof ev.type !== 'string') return s;
    switch (ev.type) {
        case 'status': return onStatus(s, ev);
        case 'no-service': return assign(s, { screen: 'NO_SERVICE', starting: false, message: NO_SERVICE_TEXT });
        case 'error': return typeof ev.code === 'string' ? onError(s, ev.code, ev) : s;
        case 'login-requested': return assign(s, { login: { requesting: true, url: null, userCode: null, expiresAt: null, expired: false } });
        case 'login-started': {
            if (typeof ev.url !== 'string' || !ev.url) return s;
            const now = isNum(ev.now) ? ev.now : 0, secs = isNum(ev.expiresIn) && ev.expiresIn > 0 ? ev.expiresIn : 300;
            return assign(s, { login: { requesting: false, url: ev.url, userCode: typeof ev.userCode === 'string' ? ev.userCode : '', expiresAt: now + secs * 1000, expired: false } });
        }
        case 'login-failed': {
            const e = ERRORS[ev.code] || UNKNOWN_ERROR;
            return assign(s, { login: { requesting: false, url: null, userCode: null, expiresAt: null, expired: false, failed: true }, message: e.message || 'Could not get a login code' });
        }
        case 'tick': {
            if (!isNum(ev.now) || !s.login || !s.login.url || s.login.expired || !(ev.now >= s.login.expiresAt)) return s;
            return assign(s, { login: assign(s.login, { expired: true }) });
        }
        case 'open-library':
            if (s.service.login !== 'logged-in') return s;
            return assign(s, { screen: 'LIBRARY', stack: [], message: null, offlineBrowse: s.service.online === false, search: assign(s.search, { keyboard: false }) });
        case 'open-list':
            if (typeof ev.key !== 'string' || !isObj(ev.source) || typeof ev.source.cmd !== 'string') return s;
            return assign(s, { screen: 'LIST', stack: s.stack.concat([newFrame(ev)]), message: null });
        case 'list-loaded': {
            const i = frameIndex(s, ev.key);
            if (i < 0 || !Array.isArray(ev.items)) return s;
            const f = s.stack[i];
            const items = isNum(ev.offset) && ev.offset > 0 ? f.items.concat(ev.items) : ev.items.slice();
            const st = s.stack.slice();
            st[i] = assign(f, { items: items, total: isNum(ev.total) ? ev.total : items.length, loading: false, error: null, stale: ev.stale === true });
            // the knob starts on the first row that can be played
            if (!(isNum(ev.offset) && ev.offset > 0) && f.sel === 0 && !playable(s, st[i], 0)) {
                for (let j = 1; j < items.length; j++) if (playable(s, st[i], j)) { st[i] = assign(st[i], { sel: j, top: 0 }); break; }
            }
            return assign(s, { stack: st });
        }
        case 'list-failed': {
            const i = frameIndex(s, ev.key);
            if (i < 0) return s;
            const st = s.stack.slice();
            st[i] = assign(s.stack[i], { loading: false, error: typeof ev.code === 'string' ? ev.code : 'error' });
            return onError(assign(s, { stack: st }), st[i].error, ev);
        }
        case 'open-now-playing':
            if (s.screen === 'NOW_PLAYING') return s;
            return assign(s, { screen: 'NOW_PLAYING', back: s.screen, message: null });
        case 'played': {
            // the list it was started from: now playing's caption, its next track, push right back to it
            const q = ev.queue;
            if (!isObj(q) || typeof q.key !== 'string' || !Array.isArray(q.tracks)) return s;
            return assign(s, { queue: { key: q.key, title: typeof q.title === 'string' ? q.title : '', tracks: q.tracks.filter(isObj) } });
        }
        case 'show-library': {
            if (s.service.login !== 'logged-in') return s;
            const to = s.service.online === false && !s.offlineBrowse ? 'OFFLINE' : s.stack.length ? 'LIST' : 'LIBRARY';
            if (to === s.screen) return s.focus.area === 'page' ? s : assign(s, { focus: assign(s.focus, { area: 'page' }) });
            return assign(s, { screen: to, message: null, back: null });
        }
        case 'show-queue': return showQueue(s);
        case 'back': return onBack(s);
        case 'dismiss':
            if (s.screen === 'ERROR') return onBack(s);
            return s.message == null ? s : assign(s, { message: null });
        case 'driving': {
            const moving = ev.moving === true;
            if (moving === s.moving) return s;
            if (moving && s.search.keyboard) return assign(s, { moving: true, search: assign(s.search, { keyboard: false }), message: MOVING_TEXT });
            return assign(s, { moving: moving });
        }
        case 'open-search': {
            if (s.service.login !== 'logged-in') return s;
            if (s.moving) return assign(s, { message: MOVING_TEXT });
            const f = top(s);
            const stack = f && f.kind === 'search' ? s.stack : s.stack.concat([searchFrame('')]);
            return assign(s, { screen: 'LIST', stack: stack, message: null, search: assign(s.search, { keyboard: true }) });
        }
        case 'open-keyboard': {
            const f = top(s);
            if (!f || f.kind !== 'search' || s.screen !== 'LIST') return s;
            if (s.moving) return assign(s, { message: MOVING_TEXT });
            return assign(s, { search: assign(s.search, { keyboard: true }), message: null, focus: assign(s.focus, { area: 'page' }) });
        }
        case 'close-keyboard': {
            const f = top(s);
            if (!s.search.keyboard || !f || f.kind !== 'search' || !f.items.length) return s;
            return assign(s, { search: assign(s.search, { keyboard: false }) });
        }
        case 'key': {
            if (s.moving || typeof ev.key !== 'string') return s;
            let b = s;
            if (!s.search.keyboard) {
                // a letter tapped while the controller is on the results: typing again
                const f = top(s);
                if (s.screen !== 'LIST' || !f || f.kind !== 'search') return s;
                b = assign(s, { search: assign(s.search, { keyboard: true }) });
            }
            const q = b.search.query;
            if (ev.key === 'SEARCH') return submitSearch(b);
            if (ev.key === 'DIGITS') {
                const d = !b.search.digits;
                return assign(b, { search: assign(b.search, { digits: d, key: speller(d).indexOf(d ? 'ABC' : '123') }) });
            }
            const next = ev.key === 'DEL' ? q.slice(0, -1) : ev.key === 'CLEAR' ? '' : (q + ev.key).slice(0, MAX_QUERY);
            return next === q ? b : assign(b, { search: assign(b.search, { query: next }) });
        }
        case 'search-submit': return submitSearch(s);
        case 'focus': return onFocus(s, ev);
        case 'cursor': {
            if (!isNum(ev.sel) || !isNum(ev.top)) return s;
            if (s.screen === 'LIST' && s.stack.length) return withTop(s, assign(top(s), { sel: ev.sel, top: ev.top }));
            if (s.screen === 'LIBRARY') return assign(s, { library: { sel: ev.sel, top: ev.top } });
            return s;
        }
        default: return s;
    }
}

/** the login screen has no code and should ask for one: logged out with none pending (once; after expiry or a
 * refusal only when the user asks) */
function wantsLoginCode(s) { return s.screen === 'LOGIN' && !s.login && s.service.login === 'logged-out'; }
/** a track is on: playing, paused or on its way */
function trackOn(s) { const p = s.player; return !!(p && p.track && ['playing', 'paused', 'buffering', 'loading'].indexOf(p.state) >= 0); }

/** now playing has a progress line to seek in: a track on (not an error) with a known length */
function seekable(s) {
    const p = s.player;
    return !!(p && p.track && p.state !== 'idle' && p.state !== 'error' && ((p.duration && p.duration > 0) || (p.track.duration && p.track.duration > 0)));
}
/** where the controller is, as it acts: now playing with a track has no other place on its page than the progress line */
function area(s) {
    const a = s.focus.area;
    if (s.screen === 'NOW_PLAYING') {
        if (a === 'progress') return seekable(s) ? 'progress' : 'bar';
        if (a === 'page' && trackOn(s)) return 'bar';
        return a;
    }
    return a === 'progress' ? 'bar' : a;
}

module.exports = { SCREENS: SCREENS, ERRORS: ERRORS, initial: initial, reduce: reduce, top: top, wantsLoginCode: wantsLoginCode, trackOn: trackOn, seekable: seekable,
    area: area, speller: speller, playable: playable, NO_SERVICE_TEXT: NO_SERVICE_TEXT, MOVING_TEXT: MOVING_TEXT };
