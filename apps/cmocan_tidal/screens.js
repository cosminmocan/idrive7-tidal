'use strict';
/**
 * screens.js - draws the app's screens from the model's state (model.js). No kit require: the canvas and the
 * colour theme come in, so the same code draws on the car (the kit's recorder), in the preview and in the tests.
 *
 *   const info = draw(cv, theme, state, ui)
 *     ui:   { now, act(a), focus }      act: called by the canvas's touch / controller targets (cv.target);
 *                                       focus: the controller's button on screens with buttons (nav.js)
 *     info: { hits: [{ x, y, w, h, key, act, button, row }], qr: {...} | null, focus, defaultFocus }
 *   defaultAct(state, info)      what a press of the controller does when nothing else is focused
 *
 * Every text from the service goes through text.js (the fonts are ASCII). An act is plain data for main.js and
 * nav.js: { type: 'login-new' }, { type: 'back' }, ... Node 8.9.4 syntax.
 */
const QR = require('./qr');
const T = require('./text');
const L = require('./listview');
const NP = require('./nowplaying');
const NP_cmd = NP.playPause;

const W = 1600, H = 520, TOP = 44, BOTTOM = 512;
const ACCENT = '#33d6ff', RED = '#ff4d4d', ROW_SEL = '#33d6ff2e', BTN = '#ffffff1f';

/* ---------- pieces ---------- */
function str(v) { return v == null ? '' : String(v); }
function txt(c, s, x, y, size, color, o) {
    const opts = { literal: true, font: (o && o.font) || 'label', align: (o && o.align) || 'left' };
    if (o && o.spacing) opts.spacing = o.spacing;
    const v = o && o.w ? T.fit(c.cv, s, size, o.w, opts.font) : T.ascii(s);
    c.cv.text(v, x, y, size, color, opts);
    return v;
}
function target(c, hit, r) {
    c.info.hits.push(hit);
    if (typeof c.cv.target === 'function' && c.ui.act && hit.act) c.cv.target(hit.x, hit.y, hit.w, hit.h, () => c.ui.act(hit.act), hit.key, r || 6);
    return hit;
}
function button(c, x, y, w, h, label, act, key, primary) {
    const i = c.info.hits.filter((b) => b.button).length;
    const focused = c.ui.focus === i;
    c.cv.roundRect(x, y, w, h, h / 2, primary ? ACCENT : BTN);
    if (focused) c.cv.strokeRoundRect(x - 4, y - 4, w + 8, h + 8, h / 2 + 4, 3, '#ffffff');
    c.cv.text(label, x + w / 2, y + h / 2 + 9, 24, primary ? '#000000' : c.t.text, { align: 'center', font: 'bold', literal: true });
    return target(c, { x: x, y: y, w: w, h: h, key: key, act: act, button: true }, h / 2);
}
function title(c, text, right) {
    txt(c, text, 60, TOP + 50, 34, c.t.text, { font: 'bold', w: 1100 });
    if (right) txt(c, right, W - 60, TOP + 50, 22, c.t.dim, { align: 'right' });
}
function centred(c, big, small, y) {
    txt(c, big, W / 2, y || 230, 34, c.t.text, { align: 'center', font: 'bold', w: W - 120 });
    if (small) txt(c, small, W / 2, (y || 230) + 44, 22, c.t.dim, { align: 'center', w: W - 120 });
}
function shortUrl(url) { return str(url).replace(/^[a-z]+:\/\//i, '').replace(/\/$/, ''); }

/* ---------- the screens ---------- */
function drawNoService(c) {
    if (c.s.starting) centred(c, 'Connecting to the TIDAL service...', null);
    else centred(c, 'The TIDAL service is not installed or not running', 'Install "cmocan-tidal" from the Store, then open the app again.');
}

function drawLogin(c) {
    const cv = c.cv, t = c.t, s = c.s, l = s.login;
    title(c, 'Log in to TIDAL');
    if (s.message) txt(c, s.message, 60, TOP + 92, 24, ACCENT, { w: 900 });
    if (!l || l.requesting || !l.url) {
        txt(c, 'Getting a code...', 60, TOP + 160, 26, t.dim);
        return;
    }
    if (l.expired) {
        txt(c, 'The code expired.', 60, TOP + 160, 28, t.text, { font: 'bold' });
        txt(c, 'Get a new one and scan it with your phone.', 60, TOP + 200, 22, t.dim);
        button(c, 60, TOP + 240, 300, 64, 'New code', { type: 'login-new' }, 'login-new', true);
        return;
    }
    const m = QR.matrix(l.url);
    txt(c, '1.  Scan the code with your phone\'s camera', 60, TOP + 150, 24, t.text);
    txt(c, '2.  Or open this address and enter the code:', 60, TOP + 196, 24, t.text);
    txt(c, shortUrl(l.url), 100, TOP + 240, 26, t.text, { font: 'bold', w: 900 });
    txt(c, l.userCode, 100, TOP + 320, 64, ACCENT, { font: 'bold', spacing: 6, w: 900 });
    if (c.ui.now && l.expiresAt) {
        const left = Math.max(0, Math.ceil((l.expiresAt - c.ui.now) / 60000));
        txt(c, 'The code is valid for ' + left + ' more minute' + (left === 1 ? '' : 's') + '.', 60, TOP + 380, 20, t.dim);
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

/** the rows on screen (only those: a list of 500 draws a handful), with the selection and a scroll bar */
function drawRows(c, rows, cur) {
    const cv = c.cv, t = c.t;
    const r = L.range(cur, rows.length);
    for (let i = r.first; i < r.last; i++) {
        const row = rows[i], y = L.Y0 + (i - r.first) * L.ROW_H, mid = y + L.ROW_H / 2 + 8;
        if (i === cur.sel) cv.roundRect(40, y + 3, W - 100, L.ROW_H - 6, 10, ROW_SEL);
        const col = row.dim ? t.dim : t.text;
        if (row.kind === 'tracks' || row.kind === 'search') txt(c, String(i + 1), L.COLS.num.x + L.COLS.num.w, mid, 20, t.dim, { align: 'right' });
        txt(c, row.label, L.COLS.title.x, mid, 24, col, { font: row.kind === 'menu' ? 'bold' : 'label', w: L.COLS.title.w });
        if (row.sub) txt(c, row.sub, L.COLS.sub.x, mid, 20, t.dim, { w: L.COLS.sub.w });
        if (row.right) txt(c, row.right, L.COLS.right.x, mid, 20, t.dim, { align: 'right', w: L.COLS.right.w });
        target(c, { x: 40, y: y, w: W - 100, h: L.ROW_H, key: 'row:' + i, row: i, act: { type: 'row', index: i } }, 10);
    }
    if (rows.length > L.VISIBLE) {
        const x = W - 44, y0 = L.Y0, h = L.VISIBLE * L.ROW_H;
        cv.roundRect(x, y0, 6, h, 3, BTN);
        const kh = Math.max(24, h * L.VISIBLE / rows.length), ky = y0 + (h - kh) * (r.first / Math.max(1, rows.length - L.VISIBLE));
        cv.roundRect(x, ky, 6, kh, 3, t.dim);
    }
}

function drawLibrary(c) {
    title(c, 'TIDAL', c.s.offlineBrowse ? 'offline: lists fetched before' : null);
    drawRows(c, L.rows(c.s), L.cursor(c.s));
}

function drawList(c) {
    const s = c.s, f = s.stack[s.stack.length - 1], t = c.t;
    const count = f.total != null && f.total > f.items.length ? f.items.length + ' of ' + f.total : '';
    title(c, f.title, [f.stale ? 'not up to date (offline)' : '', count].filter(Boolean).join('   '));
    if (!f.items.length) {
        if (f.loading) txt(c, 'Loading...', W / 2, 280, 26, t.dim, { align: 'center' });
        else if (f.error) txt(c, 'Could not load this list (' + f.error + ').', W / 2, 280, 26, t.dim, { align: 'center' });
        else txt(c, 'Nothing here yet.', W / 2, 280, 26, t.dim, { align: 'center' });
        return;
    }
    drawRows(c, L.rows(s), L.cursor(s));
}

/** a square for a missing cover: a dim tile with a note on it */
function placeholder(c, x, y, size) {
    const cv = c.cv, k = size / 100, col = '#ffffff40';
    cv.roundRect(x, y, size, size, 12, '#ffffff14');
    cv.circle(x + 40 * k, y + 68 * k, 9 * k, col);
    cv.circle(x + 66 * k, y + 62 * k, 9 * k, col);
    cv.fillRect(x + 46 * k, y + 28 * k, 3.5 * k, 40 * k, col);
    cv.fillRect(x + 72 * k, y + 22 * k, 3.5 * k, 40 * k, col);
    cv.quad([[x + 46 * k, y + 28 * k], [x + 75.5 * k, y + 22 * k], [x + 75.5 * k, y + 30 * k], [x + 46 * k, y + 36 * k]], col);
}
function cover(c, coverId, x, y, size) {
    const img = coverId && typeof c.ui.cover === 'function' ? c.ui.cover(coverId) : null;
    if (img && typeof c.cv.image === 'function') { c.cv.image(img.id, x, y, size, size); return 'image'; }
    placeholder(c, x, y, size);
    return 'placeholder';
}

const NP_STATE = { buffering: 'Buffering...', loading: 'Loading...', paused: 'Paused' };

function drawNowPlaying(c) {
    const s = c.s, t = c.t, cv = c.cv, p = s.player;
    const on = !!(p && p.track && p.state !== 'idle');
    if (!on) {
        centred(c, 'Nothing is playing', 'Choose a track in the library.', 210);
        button(c, W / 2 - 130, 300, 260, 64, 'Library', { type: 'back' }, 'np-library', true);
        return;
    }
    const tr = p.track, size = 400, cx = 60, cy = TOP + 34;
    c.info.cover = cover(c, tr.coverId, cx, cy, size);
    const x = cx + size + 60, w = W - 60 - x;
    txt(c, tr.title, x, TOP + 86, 44, t.text, { font: 'bold', w: w });
    txt(c, (tr.artists || []).join(', '), x, TOP + 134, 28, t.text, { w: w });
    if (tr.album && tr.album.title) txt(c, tr.album.title, x, TOP + 172, 22, t.dim, { w: w });
    let state = NP_STATE[p.state] || '';
    if (p.state === 'error') state = 'Playback error' + (p.error ? ' (' + p.error + ')' : '');
    if (state) txt(c, state, x, TOP + 220, 24, p.state === 'error' ? RED : ACCENT, { font: 'bold', w: w });
    const right = [p.queueLength > 0 && p.queueIndex >= 0 ? 'Track ' + (p.queueIndex + 1) + ' of ' + p.queueLength : '', p.quality || ''].filter(Boolean).join('   ');
    if (right) txt(c, right, W - 60, TOP + 220, 20, t.dim, { align: 'right' });
    // the progress
    const pos = typeof c.ui.position === 'number' ? c.ui.position : p.position;
    const dur = typeof c.ui.duration === 'number' ? c.ui.duration : (p.duration || tr.duration || null);
    const by = TOP + 252;
    cv.roundRect(x, by, w, 8, 4, BTN);
    if (dur) cv.roundRect(x, by, Math.max(8, w * Math.max(0, Math.min(1, pos / dur))), 8, 4, p.state === 'playing' ? ACCENT : t.dim);
    txt(c, L.mmss(pos) || '0:00', x, by + 38, 20, t.dim);
    if (dur) txt(c, L.mmss(dur), x + w, by + 38, 20, t.dim, { align: 'right' });
    // the controls: previous, play / pause, next (the knob starts on play / pause)
    const pp = NP_cmd(p), by2 = TOP + 330, mid = x + w / 2;
    button(c, mid - 290, by2, 170, 76, 'Previous', { type: 'control', cmd: 'prev' }, 'np-prev', false);
    button(c, mid - 100, by2, 200, 76, pp === 'pause' ? 'Pause' : 'Play', { type: 'control', cmd: pp || 'resume' }, 'np-playpause', true);
    button(c, mid + 120, by2, 170, 76, 'Next', { type: 'control', cmd: 'next' }, 'np-next', false);
    c.info.defaultFocus = 1;
}

/** a message over the bottom of the page for a few seconds (an error that keeps the screen) */
function drawToast(c, text) {
    const w = Math.min(1200, c.cv.textWidth(T.ascii(text), 22, { literal: true }) + 60), x = (W - w) / 2, y = BOTTOM - 62;
    c.cv.roundRect(x, y, w, 46, 23, '#1e2430eb');
    txt(c, text, W / 2, y + 31, 22, c.t.text, { align: 'center', w: w - 40 });
}

const DRAW = { NO_SERVICE: drawNoService, LOGIN: drawLogin, ERROR: drawError, OFFLINE: drawOffline, LIBRARY: drawLibrary, LIST: drawList, NOW_PLAYING: drawNowPlaying };

function draw(cv, t, s, ui) {
    const c = { cv: cv, t: t, s: s, ui: ui || {}, info: { hits: [], qr: null, cover: null, focus: ui && typeof ui.focus === 'number' ? ui.focus : -1, defaultFocus: 0 } };
    const fn = DRAW[s.screen];
    if (fn) fn(c);
    if (s.message && (s.screen === 'LIBRARY' || s.screen === 'LIST') && (!c.ui.toastUntil || !c.ui.now || c.ui.now < c.ui.toastUntil)) drawToast(c, s.message);
    return c.info;
}

/** the controller's press with nothing focused: the screen's first button */
function defaultAct(s, info) {
    const b = info && info.hits.filter((h) => h.button)[(info.defaultFocus || 0)];
    return b ? b.act : null;
}

module.exports = { draw: draw, defaultAct: defaultAct, W: W, H: H, TOP: TOP, BOTTOM: BOTTOM, ACCENT: ACCENT, RED: RED };
