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
 *   list-failed {key, code}, open-now-playing, played, back, dismiss, cursor {sel, top}
 *   open-search, type {text}, search-submit, driving {moving}      (search and the rules while driving: D7)
 * Node 8.9.4 syntax.
 */

const SCREENS = ['NO_SERVICE', 'OFFLINE', 'LOGIN', 'LIBRARY', 'LIST', 'NOW_PLAYING', 'ERROR'];
const LOGINS = ['logged-out', 'login-pending', 'logged-in'];
const LOGIN_ERRORS = ['login-expired', 'login-denied'];
const PLAYER_STATES = ['idle', 'loading', 'playing', 'paused', 'buffering', 'error'];
const NO_SERVICE_TEXT = 'The TIDAL service is not installed or not running';
const MOVING_TEXT = 'Search can be typed only while the car is parked';
const MAX_QUERY = 200;

/** what each error code does: the screen it leads to (null: the screen stays) and the message shown */
const ERRORS = {
    // the contract's codes (docs/PROTOCOL.md section 1)
    'offline': { screen: 'OFFLINE', message: 'No internet' },
    'not-logged-in': { screen: 'LOGIN', message: 'Please log in' },
    'login-expired': { screen: 'LOGIN', message: 'Please log in again' },
    'not-found': { screen: 'ERROR', message: 'Not found' },
    'not-available': { screen: null, message: 'This track cannot be played' },
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
        search: { query: '', keyboard: false },
        moving: false,
        offlineBrowse: false,
        unavailable: {},
    };
}

/* ---------- small helpers ---------- */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && isFinite(v);
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
    };
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
    if (raw.player !== undefined) n.player = cleanPlayer(raw.player);
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
    if (e.screen === 'ERROR') return assign(n, { screen: 'ERROR', message: e.message, back: s.screen === 'ERROR' ? s.back : s.screen });
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
            const f = top(s);
            // the keyboard over results that are there: back closes the keyboard only
            if (s.search.keyboard && f && f.kind === 'search' && f.source.params.query) return assign(s, { search: assign(s.search, { keyboard: false }) });
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

function reduce(s, ev) {
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
        case 'played':
            if (s.screen === 'NOW_PLAYING') return s;
            return assign(s, { screen: 'NOW_PLAYING', back: s.screen, message: null });
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
            return assign(s, { search: assign(s.search, { keyboard: true }), message: null });
        }
        case 'key': {
            if (!s.search.keyboard || s.moving || typeof ev.key !== 'string') return s;
            const q = s.search.query;
            if (ev.key === 'SEARCH') return submitSearch(s);
            const next = ev.key === 'DEL' ? q.slice(0, -1) : ev.key === 'CLEAR' ? '' : (q + ev.key).slice(0, MAX_QUERY);
            return next === q ? s : assign(s, { search: assign(s.search, { query: next }) });
        }
        case 'search-submit': return submitSearch(s);
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

module.exports = { SCREENS: SCREENS, ERRORS: ERRORS, initial: initial, reduce: reduce, top: top, wantsLoginCode: wantsLoginCode, trackOn: trackOn, NO_SERVICE_TEXT: NO_SERVICE_TEXT };
