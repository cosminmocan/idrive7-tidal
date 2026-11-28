'use strict';
/**
 * app.js - the car app's logic without its screen, for the end-to-end test (tests/e2e.test.js): the app's real
 * service client (apps/cmocan_tidal/client.js) and state machine (apps/cmocan_tidal/model.js), wired as the app's
 * tidal.js wires them: `status` every 1.5 s (also the service's sign of life, rule R8), a login code asked for when
 * the login screen has none, a list loaded when it is opened, play as a press on a row of the list the user is in
 * (apps/cmocan_tidal/listview.js: the list's ids, the kinds when it holds a video; a video goes to now playing).
 *
 *   const app = createAppDriver({ socketPath, pollMs, log });
 *   app.state()                      the model's state
 *   app.screens                      every screen the model went to, in order
 *   app.statuses                     every status.player seen: { at, state, queueIndex, position, trackId, trackKind, video, error }
 *   app.sent                         every command the app sent: { cmd, params }
 *   app.poll() -> Promise<state>     one status now
 *   app.silent(bool)                 stops (true) or starts again the polling: the app gone, or back
 *   app.request(cmd, params, ms)     a command as the app sends it; an error answer goes to the model
 *   app.openList(key, title, kind, cmd, params) -> Promise<frame>   a list opened and loaded
 *   app.play(index) -> Promise<answer>   row index of the top list pressed: play (its ids and kinds) from there
 *   app.until(fn, ms, what) -> Promise   waits for fn(state) to be truthy (each poll and every 50 ms)
 *   app.close()
 * Node 8 syntax.
 */
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'cmocan_tidal');
const createClient = require(path.join(APP, 'client.js')).createClient;
const M = require(path.join(APP, 'model.js'));
const LV = require(path.join(APP, 'listview.js'));

const POLL_MS = 1500;     // as the app (tidal.js)
const SLOW_MS = 15000;    // as the app: login-start, lists

function createAppDriver(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const clog = { info: (l) => log('app: ' + l), warn: (l) => log('app: ' + l), error: (l) => log('app: ' + l) };
    const client = createClient({ socketPath: o.socketPath, log: clog, timeoutMs: 6000 });
    const pollMs = o.pollMs || POLL_MS;
    let s = M.initial();
    let quiet = false, closed = false, timer = null, asking = false;
    const screens = [s.screen];
    const statuses = [];
    const sent = [];

    function dispatch(ev) {
        const before = s;
        s = M.reduce(s, ev);
        if (s === before) return;
        if (s.screen !== before.screen) { screens.push(s.screen); log('app: screen ' + s.screen + (s.message ? ' (' + s.message + ')' : '')); }
        after();
    }
    function after() { if (M.wantsLoginCode(s)) login(); }
    function ask(cmd, params, ms) {
        if (cmd !== 'status') sent.push({ cmd: cmd, params: params || {} });
        return client.request(cmd, params || {}, ms ? { timeoutMs: ms } : undefined);
    }

    function login() {
        if (asking) return;
        asking = true;
        dispatch({ type: 'login-requested' });
        ask('login-start', {}, SLOW_MS).then((a) => {
            asking = false;
            if (a.ok && typeof a.url === 'string') dispatch({ type: 'login-started', url: a.url, userCode: a.userCode, expiresIn: a.expiresIn, now: Date.now() });
            else dispatch({ type: 'login-failed', code: a.error });
        });
    }

    function poll() {
        return ask('status').then((a) => {
            if (a.ok && a.state) {
                const p = a.state.player || {};
                statuses.push({ at: Date.now(), state: p.state, queueIndex: p.queueIndex, position: p.position, trackId: p.track ? p.track.id : null,
                    trackKind: p.track ? (p.track.kind === 'video' ? 'video' : 'track') : null, video: p.video || null,
                    error: p.error, online: a.state.online, login: a.state.login });
                dispatch({ type: 'status', state: a.state, id: a.id });
            } else if (a.error === 'no-service') dispatch({ type: 'no-service' });
            dispatch({ type: 'tick', now: Date.now() });
            return s;
        });
    }
    function loop() {
        timer = null;
        if (closed || quiet) return;
        poll().then(() => { if (!closed && !quiet && !timer) timer = setTimeout(loop, pollMs); });
    }

    function request(cmd, params, ms) {
        return ask(cmd, params, ms).then((a) => {
            if (!a.ok) dispatch({ type: 'error', code: a.error, cmd: cmd, trackId: params && params.tracks ? params.tracks[params.index] : undefined });
            return a;
        });
    }
    function openList(key, title, kind, cmd, params) {
        dispatch({ type: 'open-list', key: key, title: title, kind: kind, source: { cmd: cmd, params: params || {} } });
        const p = Object.assign({}, params || {}, { offset: 0, limit: 50 });
        return ask(cmd, p, SLOW_MS).then((a) => {
            if (a.ok && Array.isArray(a.items)) dispatch({ type: 'list-loaded', key: key, offset: 0, total: a.total, items: a.items, stale: a.stale === true });
            else dispatch({ type: 'list-failed', key: key, code: a.ok ? 'bad-answer' : a.error });
            return M.top(s);
        });
    }
    /** as the app's tidal.js does with a row's 'play' act */
    function play(index) {
        const act = LV.rowActs(s, index).filter((x) => x && x.type === 'play')[0];
        if (!act) return Promise.reject(new Error('row ' + index + ' of screen ' + s.screen + ' does not play: ' + JSON.stringify(LV.rowActs(s, index))));
        const req = { tracks: act.tracks, index: act.index };
        if (Array.isArray(act.kinds)) req.kinds = act.kinds;
        return request('play', req).then((a) => {
            if (a.ok) {
                dispatch({ type: 'played', queue: act.queue });
                if (act.watch) dispatch({ type: 'open-now-playing' });
            }
            return a;
        });
    }
    function until(fn, ms, what) {
        const end = Date.now() + (ms || 10000);
        return new Promise((resolve, reject) => {
            (function again() {
                let v = null;
                try { v = fn(s); } catch (e) { return reject(e); }
                if (v) return resolve(v);
                if (Date.now() > end) return reject(new Error('timed out waiting for ' + (what || fn.toString()) + '; screen ' + s.screen + ', player ' + JSON.stringify(s.player)));
                setTimeout(again, 50);
            })();
        });
    }

    loop();
    return {
        state: () => s, screens: screens, statuses: statuses, sent: sent, poll: poll, request: request, openList: openList, play: play, until: until,
        dispatch: dispatch,
        silent: (on) => { quiet = !!on; if (quiet) { clearTimeout(timer); timer = null; } else if (!timer) loop(); },
        close: () => { closed = true; clearTimeout(timer); client.close(); },
    };
}

module.exports = { createAppDriver: createAppDriver };
