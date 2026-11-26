'use strict';
/**
 * protocol.js - docs/PROTOCOL.md as code. Every fake and every real part is tested against these validators, so a
 * part that breaks the contract fails its own tests. Each validate* returns a list of problems ([] = valid).
 * Node 8.9.4 syntax.
 */

const COMMANDS = ['status', 'login-start', 'login-cancel', 'logout', 'favorites', 'playlists', 'playlist', 'album',
    'mixes', 'mix', 'search', 'cover', 'play', 'pause', 'resume', 'next', 'prev', 'stop', 'prefs', 'exit'];
const ERROR_CODES = ['offline', 'not-logged-in', 'login-expired', 'not-found', 'not-available', 'rate-limited',
    'tidal-error', 'bad-request', 'busy'];
const PLAYER_EVENTS = ['open', 'audio', 'tick', 'end', 'error'];
const PLAYER_ERROR_CODES = ['input', 'decode', 'audio', 'internal'];
const STATE_FILES = ['session', 'prefs', 'queue'];
const LOGIN_STATES = ['logged-out', 'login-pending', 'logged-in'];
const PLAYER_STATES = ['idle', 'loading', 'playing', 'paused', 'buffering', 'error'];
const QUALITIES = ['LOSSLESS', 'HIGH'];
const MAX_LIMIT = 100;

/* ---------- small checks: each pushes a problem into errs and returns whether the value was fine ---------- */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
function need(errs, ok, what) { if (!ok) errs.push(what); return ok; }
function str(errs, o, k, opt) { if (opt && o[k] === undefined) return true; return need(errs, typeof o[k] === 'string', k + ' must be a string'); }
function nestr(errs, o, k) { return need(errs, typeof o[k] === 'string' && o[k].length > 0, k + ' must be a non-empty string'); }
function int(errs, o, k, min, max, opt) {
    if (opt && o[k] === undefined) return true;
    return need(errs, isInt(o[k]) && o[k] >= min && (max === undefined || o[k] <= max), k + ' must be an integer' + ' >= ' + min + (max === undefined ? '' : ' and <= ' + max));
}
function num(errs, o, k, min, opt) {
    if (opt && o[k] === undefined) return true;
    return need(errs, typeof o[k] === 'number' && isFinite(o[k]) && o[k] >= min, k + ' must be a number >= ' + min);
}
function bool(errs, o, k, opt) { if (opt && o[k] === undefined) return true; return need(errs, typeof o[k] === 'boolean', k + ' must be true or false'); }
function oneOf(errs, o, k, list, opt) { if (opt && o[k] === undefined) return true; return need(errs, list.indexOf(o[k]) >= 0, k + ' must be one of ' + list.join(', ')); }
function nullable(errs, o, k, fn) { if (o[k] === null) return true; return fn(); }
function paging(errs, o) { int(errs, o, 'offset', 0, undefined, true); int(errs, o, 'limit', 1, MAX_LIMIT, true); }
function list(errs, o, k, itemFn) {
    if (!need(errs, Array.isArray(o[k]), k + ' must be a list')) return;
    o[k].forEach((it, i) => { const e = []; if (need(e, isObj(it), 'must be an object')) itemFn(e, it); e.forEach((m) => errs.push(k + '[' + i + '] ' + m)); });
}

/* ---------- the objects ---------- */
function track(errs, t) {
    int(errs, t, 'id', 1); nestr(errs, t, 'title');
    need(errs, Array.isArray(t.artists) && t.artists.every((a) => typeof a === 'string'), 'artists must be a list of strings');
    nullable(errs, t, 'album', () => need(errs, isObj(t.album) && isInt(t.album.id) && typeof t.album.title === 'string', 'album must be {id, title} or null'));
    nullable(errs, t, 'coverId', () => str(errs, t, 'coverId'));
    int(errs, t, 'duration', 0); bool(errs, t, 'streamReady'); bool(errs, t, 'explicit');
}
function album(errs, a) {
    int(errs, a, 'id', 1); nestr(errs, a, 'title');
    need(errs, Array.isArray(a.artists) && a.artists.every((x) => typeof x === 'string'), 'artists must be a list of strings');
    nullable(errs, a, 'coverId', () => str(errs, a, 'coverId')); int(errs, a, 'numberOfTracks', 0);
}
function playlist(errs, p) {
    nestr(errs, p, 'uuid'); nestr(errs, p, 'title'); int(errs, p, 'numberOfTracks', 0);
    nullable(errs, p, 'coverId', () => str(errs, p, 'coverId'));
}
function mix(errs, m) { nestr(errs, m, 'id'); nestr(errs, m, 'title'); str(errs, m, 'subTitle', true); nullable(errs, m, 'coverId', () => str(errs, m, 'coverId')); }

/* ---------- control socket: requests ---------- */
const REQUEST_PARAMS = {
    favorites: (e, r) => { oneOf(e, r, 'kind', ['tracks', 'albums']); paging(e, r); },
    playlists: (e, r) => paging(e, r),
    playlist: (e, r) => { nestr(e, r, 'uuid'); paging(e, r); },
    album: (e, r) => { int(e, r, 'albumId', 1); paging(e, r); },
    mix: (e, r) => { nestr(e, r, 'mixId'); },
    search: (e, r) => { if (nestr(e, r, 'query')) need(e, r.query.length <= 200, 'query is at most 200 characters'); paging(e, r); },
    cover: (e, r) => { nestr(e, r, 'coverId'); },
    play: (e, r) => {
        if (need(e, Array.isArray(r.tracks) && r.tracks.length > 0 && r.tracks.length <= 1000 && r.tracks.every((t) => isInt(t) && t > 0), 'tracks must be 1 to 1000 track ids')) {
            int(e, r, 'index', 0, r.tracks.length - 1);
        }
    },
    prefs: (e, r) => { oneOf(e, r, 'quality', QUALITIES, true); },
};

function validateRequest(r) {
    const errs = [];
    if (!need(errs, isObj(r), 'a request is a JSON object')) return errs;
    int(errs, r, 'id', 1);
    if (!oneOf(errs, r, 'cmd', COMMANDS)) return errs;
    if (REQUEST_PARAMS[r.cmd]) REQUEST_PARAMS[r.cmd](errs, r);
    return errs;
}

/* ---------- control socket: answers ---------- */
function status(errs, s) {
    if (!need(errs, isObj(s), 'state must be an object')) return;
    oneOf(errs, s, 'login', LOGIN_STATES); bool(errs, s, 'online');
    if (need(errs, isObj(s.player), 'state.player must be an object')) {
        const p = s.player;
        oneOf(errs, p, 'state', PLAYER_STATES);
        nullable(errs, p, 'track', () => { const e = []; if (need(e, isObj(p.track), 'must be an object')) track(e, p.track); e.forEach((m) => errs.push('player.track ' + m)); });
        num(errs, p, 'position', 0); nullable(errs, p, 'duration', () => num(errs, p, 'duration', 0));
        int(errs, p, 'queueIndex', -1); int(errs, p, 'queueLength', 0);
        nullable(errs, p, 'quality', () => oneOf(errs, p, 'quality', QUALITIES));
        nullable(errs, p, 'error', () => oneOf(errs, p, 'error', ERROR_CODES.concat(PLAYER_ERROR_CODES)));
    }
    if (need(errs, isObj(s.prefs), 'state.prefs must be an object')) oneOf(errs, s.prefs, 'quality', QUALITIES);
    nestr(errs, s, 'version');
}
const listAnswer = (itemFn) => (e, a) => { list(e, a, 'items', itemFn); int(e, a, 'total', 0, undefined, true); bool(e, a, 'stale', true); };
const ANSWER_FIELDS = {
    status: (e, a) => status(e, a.state),
    'login-start': (e, a) => { if (str(e, a, 'url')) need(e, /^https:\/\//.test(a.url), 'url must start with https://'); nestr(e, a, 'userCode'); int(e, a, 'expiresIn', 1); },
    favorites: (e, a) => list(e, a, 'items', (x, it) => (it.numberOfTracks !== undefined ? album(x, it) : track(x, it))),
    playlists: listAnswer(playlist),
    playlist: listAnswer(track),
    album: listAnswer(track),
    mixes: listAnswer(mix),
    mix: listAnswer(track),
    search: listAnswer(track),
    cover: (e, a) => { oneOf(e, a, 'mime', ['image/jpeg']); if (nestr(e, a, 'data')) need(e, /^[A-Za-z0-9+/]+=*$/.test(a.data), 'data must be base64'); },
    prefs: (e, a) => { if (need(e, isObj(a.prefs), 'prefs must be an object')) oneOf(e, a.prefs, 'quality', QUALITIES); },
};

function validateAnswer(cmd, a) {
    const errs = [];
    if (!need(errs, isObj(a), 'an answer is a JSON object')) return errs;
    // an answer to a line that was not a request has no id
    if (a.id !== null) int(errs, a, 'id', 1);
    if (!bool(errs, a, 'ok')) return errs;
    if (a.ok === false) {
        oneOf(errs, a, 'error', ERROR_CODES); str(errs, a, 'message', true);
        int(errs, a, 'retryAfter', 1, undefined, true);
        return errs;
    }
    if (ANSWER_FIELDS[cmd]) ANSWER_FIELDS[cmd](errs, a);
    return errs;
}

/* ---------- player events ---------- */
const EVENT_FIELDS = {
    open: (e, v) => { oneOf(e, v, 'codec', ['flac', 'aac']); int(e, v, 'rate', 8000, 384000); int(e, v, 'channels', 1, 8); nullable(e, v, 'duration', () => num(e, v, 'duration', 0)); },
    audio: (e, v) => { oneOf(e, v, 'state', ['open', 'busy', 'error']); nestr(e, v, 'device'); str(e, v, 'message', true); },
    tick: (e, v) => { num(e, v, 'pos', 0); oneOf(e, v, 'state', ['playing', 'paused', 'buffering']); num(e, v, 'buffered', 0); int(e, v, 'dropped', 0); },
    end: () => {},
    error: (e, v) => { oneOf(e, v, 'code', PLAYER_ERROR_CODES); str(e, v, 'message'); },
};

function validatePlayerEvent(v) {
    const errs = [];
    if (!need(errs, isObj(v), 'an event is a JSON object')) return errs;
    if (!oneOf(errs, v, 'ev', PLAYER_EVENTS)) return errs;
    EVENT_FIELDS[v.ev](errs, v);
    return errs;
}

/** one line of the player's stdout: the event after "MGU ", or null for anything else (log lines) */
function parsePlayerLine(line) {
    if (line.slice(0, 4) !== 'MGU ') return null;
    try { const v = JSON.parse(line.slice(4)); return isObj(v) ? v : null; } catch (e) { return null; }
}

/* ---------- state files ---------- */
const STATE_FIELDS = {
    session: (e, s) => {
        nestr(e, s, 'accessToken'); nestr(e, s, 'refreshToken'); oneOf(e, s, 'tokenType', ['Bearer']);
        int(e, s, 'expiresAt', 0); int(e, s, 'userId', 1); if (str(e, s, 'countryCode')) need(e, /^[A-Z]{2}$/.test(s.countryCode), 'countryCode must be two capital letters');
    },
    prefs: (e, s) => { oneOf(e, s, 'quality', QUALITIES); },
    queue: (e, s) => {
        need(e, Array.isArray(s.tracks) && s.tracks.every((t) => isInt(t) && t > 0), 'tracks must be a list of track ids');
        int(e, s, 'index', -1, Array.isArray(s.tracks) ? s.tracks.length - 1 : undefined); num(e, s, 'position', 0);
    },
};

function validateState(name, s) {
    const errs = [];
    if (!need(errs, STATE_FILES.indexOf(name) >= 0, 'unknown state file ' + name)) return errs;
    if (!need(errs, isObj(s), 'a state file is a JSON object')) return errs;
    if (!need(errs, s.version === 1, 'version must be 1')) return errs;
    STATE_FIELDS[name](errs, s);
    return errs;
}

/** valid parameters for each command, for tests that send every command */
function sampleParams(cmd) {
    return ({
        favorites: { kind: 'tracks', offset: 0, limit: 50 }, playlists: { offset: 0, limit: 50 },
        playlist: { uuid: '36ea71a8-445e-41a4-82ab-6628c581535d' }, album: { albumId: 17927863 }, mix: { mixId: '0123456789abcdef0123456789abcd' },
        search: { query: 'daft punk' }, cover: { coverId: '24f52ab0-e7d6-414d-a650-20a4c686aa57' },
        play: { tracks: [17927864, 17927865], index: 0 }, prefs: { quality: 'LOSSLESS' },
    })[cmd] || {};
}

module.exports = {
    COMMANDS: COMMANDS, ERROR_CODES: ERROR_CODES, PLAYER_EVENTS: PLAYER_EVENTS, PLAYER_ERROR_CODES: PLAYER_ERROR_CODES,
    STATE_FILES: STATE_FILES, PLAYER_STATES: PLAYER_STATES, QUALITIES: QUALITIES, MAX_LIMIT: MAX_LIMIT,
    validateRequest: validateRequest, validateAnswer: validateAnswer, validatePlayerEvent: validatePlayerEvent,
    validateState: validateState, parsePlayerLine: parsePlayerLine, sampleParams: sampleParams,
};
