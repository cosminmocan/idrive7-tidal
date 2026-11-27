'use strict';
/**
 * nav.js - the iDrive controller and the touchscreen on the app's screens: input(state, info, ev) -> a list of
 * model events (model.js) and acts for tidal.js ({ type: 'play', tracks, index }, { type: 'bar', id }, { type: 'tab',
 * index }, { type: 'seek-step', steps }, { type: 'seek-to', position }, { type: 'login-new' }, { type: 'retry' },
 * { type: 'leave' }, ...). Pure.
 *
 *   ev: { knob: d }      the knob turned d steps (+ clockwise)
 *       { press: true }  the knob pressed
 *       { tilt: 'N' | 'S' | 'E' | 'W' }   the controller pushed up / down / right / left
 *       { tap: { x, y } }                 a finger on the screen (the app's drawing px)
 *   info: what screens.draw returned for the frame on the screen (its hit areas), or null
 *
 * One rule on every screen (U1, docs/ui-redesign.md section 2). Where the controller is, is the model's focus:
 *   page      turn: along the list (stops at its ends, skips tracks that cannot be played) or a message's choices or
 *             search's letters; press: choose; up: the tabs (search's results: its letters); down: the bar
 *   bar       PREVIOUS, PLAY / PAUSE, NEXT: turn along them, press presses; up: back to the page (now playing: its
 *             progress line, when there is one to seek in)
 *   tabs      LIBRARY, NOW PLAYING, SETTINGS: turn along them, press opens; down: back to the page
 *   progress  now playing's progress line (phase 2, S2): turn and left / right wind 10 s a step; press or down: done
 * Everywhere (but on the progress line): left = back one level (from a top screen: leave the app), right = now
 * playing while a track is on (on now playing: the list that plays). Turning never leaves the place it is in.
 * Node 8.9.4 syntax.
 */
const M = require('./model');
const L = require('./listview');
const P = require('./pages');
const { barPosition } = require('./seek');

const TILTS = ['N', 'S', 'E', 'W'];

function hitAt(info, p) {
    if (!info || !p) return null;
    const hits = info.hits || [];
    for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) return h;
    }
    return null;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isList = (s) => s.screen === 'LIBRARY' || s.screen === 'LIST';
const letters = (s) => s.screen === 'LIST' && s.search.keyboard && !s.moving && M.top(s) && M.top(s).kind === 'search';

/** where the controller is, as it acts (a page with nothing on it: the bar) */
function area(s) {
    const a = M.area(s);
    if (a === 'page' && s.screen === 'NOW_PLAYING' && !P.message(s)) return 'bar';
    return a;
}
function tabOf(s) { return s.screen === 'NOW_PLAYING' ? 1 : 0; }
const toTabs = (s) => [{ type: 'focus', area: 'tabs', tab: Math.min(tabOf(s), P.tabCount(s) - 1) }];
const toBar = [{ type: 'focus', area: 'bar' }];

/** left and right, the same everywhere */
function sideways(s, tilt) {
    if (tilt === 'W') return s.screen === 'LIST' || s.screen === 'NOW_PLAYING' || s.screen === 'ERROR' ? [{ type: 'back' }] : [{ type: 'leave' }];
    if (s.screen === 'NOW_PLAYING') return s.queue ? [{ type: 'show-queue' }] : [];
    return M.trackOn(s) ? [{ type: 'open-now-playing' }] : [];
}

function listPage(s, knob, tilt, press) {
    const count = L.rows(s).length, cur = L.cursor(s);
    if (knob) {
        const c = L.move(cur, knob, count, L.visible(s), L.skips(s));
        return c.sel === cur.sel && c.top === cur.top ? [] : [{ type: 'cursor', sel: c.sel, top: c.top }];
    }
    if (press) return count ? L.rowActs(s, cur.sel) : [];
    const f = M.top(s);
    if (tilt === 'N') return s.screen === 'LIST' && f && f.kind === 'search' && !s.moving ? [{ type: 'open-keyboard' }] : toTabs(s);
    if (tilt === 'S') return toBar;
    return sideways(s, tilt);
}

function letterPage(s, knob, tilt, press) {
    const cells = M.speller(s.search.digits), k = clamp(s.search.key, 0, cells.length - 1);
    if (knob) { const n = clamp(k + knob, 0, cells.length - 1); return n === s.search.key ? [] : [{ type: 'focus', key: n }]; }
    if (press) {
        const c = cells[k];
        return [{ type: 'key', key: c === '123' || c === 'ABC' ? 'DIGITS' : c === 'SPACE' ? ' ' : c === 'OK' ? 'SEARCH' : c }];
    }
    if (tilt === 'N') return toTabs(s);
    if (tilt === 'S') return M.top(s).items.length ? [{ type: 'close-keyboard' }] : toBar;
    return sideways(s, tilt);
}

function messagePage(s, knob, tilt, press) {
    const m = P.message(s), choices = (m && m.choices) || [], row = clamp(s.focus.row, 0, Math.max(0, choices.length - 1));
    if (knob) { const n = clamp(row + knob, 0, Math.max(0, choices.length - 1)); return n === s.focus.row ? [] : [{ type: 'focus', row: n }]; }
    if (press) return choices[row] ? [Object.assign({}, choices[row].act)] : [];
    if (tilt === 'N') return toTabs(s);
    if (tilt === 'S') return toBar;
    return sideways(s, tilt);
}

function barPlace(s, knob, tilt, press) {
    const b = clamp(s.focus.bar, 0, P.BAR.length - 1);
    if (knob) { const n = clamp(b + knob, 0, P.BAR.length - 1); return n === s.focus.bar ? [] : [{ type: 'focus', area: 'bar', bar: n }]; }
    if (press) return [{ type: 'bar', id: P.BAR[b] }];
    if (tilt === 'N') {
        if (s.screen === 'NOW_PLAYING') return M.seekable(s) ? [{ type: 'focus', area: 'progress' }] : P.message(s) ? [{ type: 'focus', area: 'page' }] : toTabs(s);
        return [{ type: 'focus', area: 'page' }];
    }
    if (tilt === 'S') return [];
    return sideways(s, tilt);
}

function tabPlace(s, knob, tilt, press) {
    const n = P.tabCount(s), t = clamp(s.focus.tab, 0, n - 1);
    if (knob) { const to = clamp(t + knob, 0, n - 1); return to === s.focus.tab ? [] : [{ type: 'focus', area: 'tabs', tab: to }]; }
    if (press) return [{ type: 'tab', index: t }];
    if (tilt === 'S') {
        if (s.screen === 'NOW_PLAYING' && !P.message(s)) return M.seekable(s) ? [{ type: 'focus', area: 'progress' }] : toBar;
        return [{ type: 'focus', area: 'page' }];
    }
    if (tilt === 'N') return [];
    return sideways(s, tilt);
}

function progressPlace(s, knob, tilt, press) {
    if (knob) return [{ type: 'seek-step', steps: knob }];
    if (tilt === 'E') return [{ type: 'seek-step', steps: 1 }];
    if (tilt === 'W') return [{ type: 'seek-step', steps: -1 }];
    if (tilt === 'S' || press) return toBar;
    if (tilt === 'N') return toTabs(s);
    return [];
}

/** a finger: rows, choices, letters and the progress line under it (info's hit areas) */
function tapInput(s, info, p) {
    const h = hitAt(info, p);
    if (!h) return [];
    if (h.bar) { const pos = barPosition(h.bar, p.x); return pos == null ? [] : [{ type: 'seek-to', position: pos }]; }
    if (typeof h.row === 'number' && isList(s)) {
        const count = L.rows(s).length, c = L.move({ sel: h.row, top: L.cursor(s).top }, 0, count, L.visible(s));
        return [{ type: 'cursor', sel: c.sel, top: c.top }].concat(L.rowActs(s, h.row));
    }
    return h.act ? [Object.assign({}, h.act)] : [];
}

function input(s, info, ev) {
    if (!s || !ev || typeof ev !== 'object') return [];
    if (ev.tap && typeof ev.tap === 'object') return tapInput(s, info, ev.tap);
    const knob = typeof ev.knob === 'number' && isFinite(ev.knob) ? Math.round(ev.knob) : 0;
    const tilt = TILTS.indexOf(ev.tilt) >= 0 ? ev.tilt : null, press = ev.press === true;
    if (!knob && !tilt && !press) return [];
    switch (area(s)) {
        case 'bar': return barPlace(s, knob, tilt, press);
        case 'tabs': return tabPlace(s, knob, tilt, press);
        case 'progress': return progressPlace(s, knob, tilt, press);
        default:
            if (letters(s)) return letterPage(s, knob, tilt, press);
            if (isList(s)) return listPage(s, knob, tilt, press);
            return messagePage(s, knob, tilt, press);
    }
}

module.exports = { input: input, hitAt: hitAt, area: area, speller: (s) => M.speller(s.search.digits), BAR: P.BAR };
