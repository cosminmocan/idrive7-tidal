'use strict';
/**
 * nav.js - the iDrive controller and the touchscreen on the app's screens: input(state, info, ev) -> a list of
 * model events (model.js) and acts for main.js ({ type: 'play', tracks, index }, { type: 'control', cmd },
 * { type: 'login-new' }, { type: 'open-search' }, { type: 'leave' }, ...). Pure.
 *
 *   ev: { knob: d }      the knob turned d steps (+ clockwise)
 *       { press: true }  the knob pressed
 *       { tilt: 'N' | 'S' | 'E' | 'W' }   the controller pushed up / down / right / left
 *       { tap: { x, y } }                 a finger on the screen (the app's drawing px)
 *   info: what screens.draw returned for the frame on the screen (its hit areas), or null
 * Node 8.9.4 syntax.
 */
const L = require('./listview');

function hitAt(info, p) {
    if (!info || !p) return null;
    const hits = info.hits || [];
    for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) return h;
    }
    return null;
}
const trackOn = (s) => { const p = s.player; return !!(p && p.track && ['playing', 'paused', 'buffering', 'loading'].indexOf(p.state) >= 0); };

function listInput(s, info, ev) {
    const count = L.rows(s).length, cur = L.cursor(s);
    const moveBy = (d) => { const c = L.move(cur, d, count); return c.sel === cur.sel && c.top === cur.top ? [] : [{ type: 'cursor', sel: c.sel, top: c.top }]; };
    if (typeof ev.knob === 'number' && ev.knob) return moveBy(ev.knob);
    if (ev.tilt === 'N') return moveBy(-1);
    if (ev.tilt === 'S') return moveBy(1);
    if (ev.tilt === 'W') return s.screen === 'LIST' ? [{ type: 'back' }] : [{ type: 'leave' }];
    if (ev.tilt === 'E') return trackOn(s) ? [{ type: 'open-now-playing' }] : [];
    if (ev.press) return count ? L.rowActs(s, cur.sel) : [];
    if (ev.tap) {
        const h = hitAt(info, ev.tap);
        if (!h) return [];
        if (typeof h.row === 'number') {
            const c = L.move({ sel: h.row, top: cur.top }, 0, count);
            return [{ type: 'cursor', sel: c.sel, top: c.top }].concat(L.rowActs(s, h.row));
        }
        return h.act ? [h.act] : [];
    }
    return [];
}

/** screens with a few buttons: the knob goes along them (info.focus), a press acts on the focused one */
function buttonInput(s, info, ev) {
    const buttons = ((info && info.hits) || []).filter((h) => h.button);
    if (ev.tap) { const h = hitAt(info, ev.tap); return h && h.act ? [h.act] : []; }
    if (ev.tilt === 'W') return s.screen === 'ERROR' || s.screen === 'NOW_PLAYING' ? [{ type: 'back' }] : [{ type: 'leave' }];
    if (!buttons.length) return [];
    const f = info && typeof info.focus === 'number' ? info.focus : -1;
    if (typeof ev.knob === 'number' && ev.knob) {
        const to = Math.max(0, Math.min(buttons.length - 1, (f < 0 ? (info.defaultFocus || 0) : f + ev.knob)));
        return [{ type: 'focus', index: to }];
    }
    if (ev.tilt === 'E' || ev.tilt === 'S') return [{ type: 'focus', index: Math.min(buttons.length - 1, f + 1) }];
    if (ev.tilt === 'N') return [{ type: 'focus', index: Math.max(0, f - 1) }];
    if (ev.press) {
        const b = buttons[f >= 0 ? f : (info.defaultFocus || 0)];
        return b && b.act ? [b.act] : [];
    }
    return [];
}

function input(s, info, ev) {
    if (!s || !ev || typeof ev !== 'object') return [];
    if (s.screen === 'LIBRARY' || (s.screen === 'LIST' && !(s.search && s.search.keyboard))) return listInput(s, info, ev);
    return buttonInput(s, info, ev);
}

module.exports = { input: input, hitAt: hitAt };
