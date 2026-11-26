'use strict';
/**
 * screens.js - draws the app's screens from the model's state (model.js). No kit require: the canvas and the
 * colour theme come in, so the same code draws on the car (the kit's recorder), in the preview and in the tests.
 *
 *   const info = draw(cv, theme, state, ui)
 *     ui:   { now, act(a) }                act: called by the canvas's touch / controller targets (cv.target)
 *     info: { hits: [{ x, y, w, h, key, act, button }], qr: { x, y, cell, size, n } | null }
 *   defaultAct(state, info)      what a press of the controller does when nothing else is focused
 *
 * An act is plain data for main.js: { type: 'login-new' }, { type: 'back' }, ...
 * Node 8.9.4 syntax.
 */
const QR = require('./qr');

const W = 1600, H = 520, TOP = 44, BOTTOM = 512;
const ACCENT = '#33d6ff', RED = '#ff4d4d';

/* ---------- pieces ---------- */
function str(v) { return v == null ? '' : String(v); }

function button(c, x, y, w, h, label, act, key, primary) {
    const cv = c.cv, t = c.t;
    cv.roundRect(x, y, w, h, h / 2, primary ? ACCENT : '#ffffff1f');
    cv.text(label, x + w / 2, y + h / 2 + 9, 24, primary ? '#000000' : t.text, { align: 'center', font: 'bold', literal: true });
    const hit = { x: x, y: y, w: w, h: h, key: key, act: act, button: true };
    c.info.hits.push(hit);
    if (typeof cv.target === 'function' && c.ui.act) cv.target(x, y, w, h, () => c.ui.act(act), key, h / 2);
    return hit;
}
function title(c, text) { c.cv.text(text, 60, TOP + 50, 34, c.t.text, { font: 'bold', literal: true }); }
function centred(c, big, small, y) {
    c.cv.text(big, W / 2, y || 230, 34, c.t.text, { align: 'center', font: 'bold', literal: true });
    if (small) c.cv.text(small, W / 2, (y || 230) + 44, 22, c.t.dim, { align: 'center', literal: true });
}
function shortUrl(url) { return str(url).replace(/^[a-z]+:\/\//i, '').replace(/\/$/, ''); }

/* ---------- the screens ---------- */
function drawNoService(c) {
    const s = c.s;
    if (s.starting) centred(c, 'Connecting to the TIDAL service...', null);
    else centred(c, 'The TIDAL service is not installed or not running', 'Install "cmocan-tidal" from the Store, then open the app again.');
}

function drawLogin(c) {
    const cv = c.cv, t = c.t, s = c.s, l = s.login;
    title(c, 'Log in to TIDAL');
    if (s.message) cv.text(str(s.message), 60, TOP + 92, 24, ACCENT, { literal: true });
    if (!l || l.requesting || !l.url) {
        cv.text('Getting a code...', 60, TOP + 160, 26, t.dim, { literal: true });
        return;
    }
    if (l.expired) {
        cv.text('The code expired.', 60, TOP + 160, 28, t.text, { font: 'bold', literal: true });
        cv.text('Get a new one and scan it with your phone.', 60, TOP + 200, 22, t.dim, { literal: true });
        button(c, 60, TOP + 240, 300, 64, 'New code', { type: 'login-new' }, 'login-new', true);
        return;
    }
    const m = QR.matrix(l.url);
    cv.text('1.  Scan the code with your phone\'s camera', 60, TOP + 150, 24, t.text, { literal: true });
    cv.text('2.  Or open this address and enter the code:', 60, TOP + 196, 24, t.text, { literal: true });
    cv.text(shortUrl(l.url), 100, TOP + 240, 26, t.text, { font: 'bold', literal: true });
    cv.text(str(l.userCode), 100, TOP + 320, 64, ACCENT, { font: 'bold', literal: true, spacing: 6 });
    if (c.ui.now && l.expiresAt) {
        const left = Math.max(0, Math.ceil((l.expiresAt - c.ui.now) / 60000));
        cv.text('The code is valid for ' + left + ' more minute' + (left === 1 ? '' : 's') + '.', 60, TOP + 380, 20, t.dim, { literal: true });
    }
    if (!m) return;
    const box = BOTTOM - TOP - 40, lay = QR.layout(m.n, box);
    const x = W - 80 - lay.size, y = TOP + Math.max(10, Math.floor((BOTTOM - TOP - lay.size) / 2));
    QR.draw(cv, m, x, y, lay.cell);
    c.info.qr = { x: x, y: y, cell: lay.cell, size: lay.size, n: m.n };
}

function drawError(c) {
    centred(c, str(c.s.message) || 'Something went wrong', null, 220);
    button(c, W / 2 - 120, 300, 240, 64, 'Back', { type: 'back' }, 'error-back', true);
}

function drawOffline(c) {
    centred(c, 'No internet', 'The head unit has no internet connection right now. Lists fetched before still open.', 200);
    if (c.s.service.login === 'logged-in') button(c, W / 2 - 130, 300, 260, 64, 'Library', { type: 'open-library' }, 'offline-library', true);
}

const DRAW = { NO_SERVICE: drawNoService, LOGIN: drawLogin, ERROR: drawError, OFFLINE: drawOffline };

function draw(cv, t, s, ui) {
    const c = { cv: cv, t: t, s: s, ui: ui || {}, info: { hits: [], qr: null } };
    const fn = DRAW[s.screen];
    if (fn) fn(c);
    return c.info;
}

/** the controller's press with nothing focused: the screen's first button */
function defaultAct(s, info) {
    const b = info && info.hits.filter((h) => h.button)[0];
    return b ? b.act : null;
}

module.exports = { draw: draw, defaultAct: defaultAct, W: W, H: H, TOP: TOP, BOTTOM: BOTTOM, ACCENT: ACCENT, RED: RED };
