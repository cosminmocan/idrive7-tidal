'use strict';
/**
 * pages.js - what each screen offers, as data (no drawing, no I/O): the header's tabs, the bar's words, and the
 * message pages (no internet, no service, an error, the login, nothing playing) with their choices. screens.js
 * draws them, nav.js moves through them, tidal.js hands the tabs and the bar's words to the kit.
 *
 *   tabs(state)        { tabs: ['Library', 'Now playing'] (none before the login: the kit adds Settings), sel }
 *   tabCount(state)    the tabs the controller goes along: the app's and the kit's SETTINGS
 *   area(state)        where the controller is: 'page', 'bar', 'tabs' or 'progress' (model.js area; a page with
 *                      nothing on it: 'bar')
 *   bar(state)         the bar's words: ['Previous', 'Pause' | 'Play', 'Next'] (the word says what a press does)
 *   BAR                the bar's buttons (app.json ids), in that order
 *   pageKey(state)     the page's place the controller is on ('row:3', 'choice:0', 'key:19', 'progress') or null
 *   kitPlace(state)    where the kit's focus goes: { k: 'bar:BTN_PLAY', bar } / { k: 'tab:0', tab } / { k: 'tgt:row:3' } / null
 *   message(state)     a message page: { icon, title, lines: [text], choices: [{ label, act }] }, or null for the screens
 *                      drawn otherwise (lists, now playing with a track); the login's choices are in it too
 * Node 8.9.4 syntax.
 */
const NP = require('./nowplaying');
const M = require('./model');
const L = require('./listview');

const BAR = ['BTN_PREVIOUS', 'BTN_PLAY', 'BTN_NEXT'];
const TABS = ['Library', 'Now playing'];

function tabs(s) {
    if (s.service.login !== 'logged-in' || s.screen === 'LOGIN' || s.screen === 'NO_SERVICE') return { tabs: [], sel: -1 };
    return { tabs: TABS.slice(), sel: s.screen === 'NOW_PLAYING' ? 1 : 0 };
}
function tabCount(s) { return tabs(s).tabs.length + 1; }

/** where the controller is, as it acts and shows (model.js area; a page with nothing on it: the bar) */
function area(s) {
    const a = M.area(s);
    if (a === 'page' && s.screen === 'NOW_PLAYING' && !message(s)) return 'bar';
    return a;
}

function bar(s) { return ['Previous', NP.playPause(s.player) === 'pause' ? 'Pause' : 'Play', 'Next']; }

const ERROR_TEXT = {
    'not-found': 'TIDAL does not have this any more.',
    'rate-limited': 'TIDAL asked to wait a moment. Try again shortly.',
    'tidal-error': 'TIDAL could not answer this time. Try again in a moment.',
};
const NEW_CODE = { label: 'New code', act: { type: 'login-new' } };

function message(s) {
    switch (s.screen) {
        case 'NO_SERVICE':
            if (s.starting) return { icon: null, title: 'Connecting to the TIDAL service...', lines: [], choices: [] };
            return { icon: 'warn', title: 'No TIDAL service', lines: [M.NO_SERVICE_TEXT + '.', 'Install "cmocan-tidal" from the Store, then open the app again.'],
                choices: [{ label: 'Try again', act: { type: 'retry' } }] };
        case 'OFFLINE': {
            const choices = [{ label: 'Try again', act: { type: 'retry' } }];
            if (s.service.login === 'logged-in') choices.push({ label: 'Open the library (lists from before)', act: { type: 'open-library' } });
            return { icon: 'warn', title: 'No internet', lines: ['The car is not online right now. Lists you opened before still work.'], choices: choices };
        }
        case 'ERROR':
            return { icon: 'warn', title: s.message || 'Something went wrong', lines: ERROR_TEXT[s.errorCode] ? [ERROR_TEXT[s.errorCode]] : [], choices: [{ label: 'Back', act: { type: 'back' } }] };
        case 'NOW_PLAYING': {
            const p = s.player;
            if (p && p.track && p.state !== 'idle') return null;
            return { icon: null, title: 'Nothing is playing', lines: ['Choose a track in the library.'], choices: [{ label: 'Open the library', act: { type: 'show-library' } }] };
        }
        case 'LOGIN': {
            const l = s.login;
            const offer = !!(l && !l.requesting && (l.failed || l.denied || l.expired || l.url));
            return { login: true, choices: offer ? [NEW_CODE] : [] };
        }
        default: return null;
    }
}

/**
 * the key of the page's place the controller is on (the target screens.js draws the highlight on): 'row:3',
 * 'choice:0', 'key:19' (search's letters), 'progress' (now playing's line), or null (on the bar, the tabs, or nothing)
 */
function pageKey(s) {
    const a = area(s);
    if (a === 'progress') return 'progress';
    if (a !== 'page') return null;
    if (s.screen === 'LIST' || s.screen === 'LIBRARY') {
        const f = M.top(s);
        if (s.screen === 'LIST' && f && f.kind === 'search' && s.search.keyboard && !s.moving) return 'key:' + s.search.key;
        const n = L.rows(s).length;
        return n ? 'row:' + Math.max(0, Math.min(n - 1, L.cursor(s).sel)) : null;
    }
    const m = message(s), ch = (m && m.choices) || [];
    return ch.length ? 'choice:' + Math.max(0, Math.min(ch.length - 1, s.focus.row)) : null;
}

/** where the kit's focus goes (display.js _focus): the bar button, the tab, or the page target the app highlights */
function kitPlace(s) {
    const a = area(s);
    if (a === 'bar') { const id = BAR[Math.max(0, Math.min(BAR.length - 1, s.focus.bar))]; return { k: 'bar:' + id, bar: id }; }
    if (a === 'tabs') { const t = Math.max(0, Math.min(tabCount(s) - 1, s.focus.tab)); return { k: 'tab:' + t, tab: t }; }
    const k = pageKey(s);
    return k && k !== 'progress' ? { k: 'tgt:' + k } : null;
}

module.exports = { tabs: tabs, tabCount: tabCount, area: area, bar: bar, message: message, pageKey: pageKey, kitPlace: kitPlace, BAR: BAR };
