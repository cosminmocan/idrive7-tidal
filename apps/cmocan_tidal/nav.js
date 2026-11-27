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
 *
 * Now playing (phase 2, seek): the knob goes along the three buttons, as on every screen with buttons, so it cannot
 * also wind. The progress bar is a place of its own above them: pushed up (N) the controller is on the bar
 * ({ type: 'focus', index: 'bar' }), where the knob and left / right wind 10 s a step ({ type: 'seek-step', steps });
 * pushed down, or pressed, it is back on play / pause. A tap on the bar is { type: 'seek-to', position }.
 * Node 8.9.4 syntax.
 */
const L = require('./listview');
const { barPosition } = require('./seek');

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

/** the controller on the progress bar */
function barInput(info, ev) {
    if (typeof ev.knob === 'number' && ev.knob) return [{ type: 'seek-step', steps: ev.knob }];
    if (ev.tilt === 'E') return [{ type: 'seek-step', steps: 1 }];
    if (ev.tilt === 'W') return [{ type: 'seek-step', steps: -1 }];
    if (ev.tilt === 'S' || ev.press) return [{ type: 'focus', index: info.defaultFocus || 0 }];
    return [];
}

/** screens with a few buttons: the knob goes along them (info.focus), a press acts on the focused one */
function buttonInput(s, info, ev) {
    const buttons = ((info && info.hits) || []).filter((h) => h.button);
    if (ev.tap) {
        const h = hitAt(info, ev.tap);
        if (h && h.bar) { const pos = barPosition(h.bar, ev.tap.x); return pos == null ? [] : [{ type: 'seek-to', position: pos }]; }
        return h && h.act ? [h.act] : [];
    }
    const bar = ((info && info.hits) || []).filter((h) => h.bar)[0];
    if (bar && info.barFocus) return barInput(info, ev);
    if (bar && ev.tilt === 'N') return [{ type: 'focus', index: 'bar' }];
    if (ev.tilt === 'W') return s.screen === 'ERROR' || s.screen === 'NOW_PLAYING' ? [{ type: 'back' }] : [{ type: 'leave' }];
    if (!buttons.length) return [];
    // nothing focused yet: the screen's default button (play / pause) is where the controller starts from
    const f = info && typeof info.focus === 'number' && info.focus >= 0 && info.focus < buttons.length ? info.focus : -1;
    const from = f < 0 ? Math.min(buttons.length - 1, (info && info.defaultFocus) || 0) : f;
    const to = (d) => [{ type: 'focus', index: Math.max(0, Math.min(buttons.length - 1, from + d)) }];
    if (typeof ev.knob === 'number' && ev.knob) return to(ev.knob);
    if (ev.tilt === 'E' || ev.tilt === 'S') return to(1);
    if (ev.tilt === 'N') return to(-1);
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
