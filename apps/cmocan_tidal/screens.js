'use strict';
/**
 * screens.js - draws the app's screens from the model's state (model.js), as the approved pictures of task U1
 * (docs/ui-mock/a-*.png, docs/ui-redesign.md section 3). No kit require: the canvas and the colour theme come in,
 * so the same code draws on the car (the kit's recorder), in the preview and in the tests.
 *
 *   const info = draw(cv, theme, state, ui)
 *     ui:   { now, act(a), cover(id), thumb(id), position, duration, seeking, volume, toastUntil }
 *           act: called by the canvas's touch targets (cv.target); cover / thumb: a decoded cover for now playing
 *           (400 px) / a list row (small), or null; position, duration: the progress line's (seconds); seeking: the
 *           position is a target the user is choosing (seek.js); volume: the car's volume popup; toastUntil: a
 *           message shows until then
 *     info: { hits: [{ x, y, w, h, key, act, row, bar }], qr, cover, barFocus, focus }
 *           focus: where the one highlight was drawn on the page, { key, x, y, w, h } (key: the target's, 'row:3',
 *           'choice:0', 'key:19', 'progress'), or null when the controller is on the bar or the tabs (the kit draws it
 *           there); barFocus: the controller is on now playing's progress line
 *   defaultAct(state, info)      what a press on the page's focused choice does
 *   palette(theme)               the colours drawn, all from the theme: text, dim, focus (theme.sel), plate, warn, off
 *
 * Layout in the app's 1600 x 520 units (the kit scales them onto the screen): margins 40, the caption line at y 72,
 * rows of 70 from y 92 (six), track rows of two lines with a 52 px cover. The theme's focus colour marks only where
 * the controller is. Every text from the service goes through text.js (the kit's fonts). Node 8.9.4 syntax.
 */
const QR = require('./qr');
const T = require('./text');
const L = require('./listview');
const NP = require('./nowplaying');
const M = require('./model');
const P = require('./pages');

const W = 1600, H = 520;
const LAY = { x: 40, w: 1500, capY: 72, y0: L.Y0, rowH: L.ROW_H };
const DOT = '  ·  ';

/* ---------- colours: all from the theme ---------- */
function alpha(c, a) {
    let h = String(c || '#ffffff');
    if (/^#[0-9a-f]{3}$/i.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    h = h.slice(0, 7);
    const v = Math.max(0, Math.min(255, Math.round(a * 255)));
    return h + (v < 16 ? '0' : '') + v.toString(16);
}
function palette(t) {
    const focus = t.sel || t.accent;
    return {
        bg: t.bg, text: t.text, dim: t.dim, focus: focus, plate: alpha(focus, 0.26), warn: t.warn || t.text,
        off: alpha(t.text, 0.36), offDim: alpha(t.dim, 0.5), hair: alpha(t.text, 0.07), line: alpha(t.text, 0.14),
        tile: alpha(t.text, 0.08), note: alpha(t.text, 0.25), track: alpha(t.text, 0.16), knob: alpha(t.text, 0.6), soft: alpha(t.text, 0.85),
    };
}

/* ---------- pieces ---------- */
function str(v) { return v == null ? '' : String(v); }
/** text, cut to o.w with '...'; returns its width */
function txt(c, s, x, y, size, color, o) {
    const opts = { literal: true, font: (o && o.font) || 'label', align: (o && o.align) || 'left' };
    if (o && o.spacing) opts.spacing = o.spacing;
    const v = o && o.w ? T.fit(c.cv, s, size, o.w, opts.font) : T.ascii(s);
    c.cv.text(v, x, y, size, color, opts);
    return c.cv.textWidth(v, size, opts);
}
function target(c, hit, r) {
    c.info.hits.push(hit);
    if (typeof c.cv.target === 'function' && c.ui.act && hit.act) c.cv.target(hit.x, hit.y, hit.w, hit.h, () => c.ui.act(hit.act), hit.key, r == null ? 10 : r);
    return hit;
}
/** the one highlight: the plate filled with the focus colour, lighter, and its edge in the full colour */
function focusPlate(c, key, x, y, w, h, r) {
    c.cv.roundRect(x, y, w, h, r, c.p.plate);
    c.cv.strokeRoundRect(x, y, w, h, r, 2.5, c.p.focus);
    c.info.focus = { key: key, x: x, y: y, w: w, h: h };
}
const onPage = (c) => P.area(c.s) === 'page';
function messageOn(c) { const u = c.ui; return !!c.s.message && (!u.toastUntil || !u.now || u.now < u.toastUntil); }

/* ---------- icons: lines and circles of our own ---------- */
const ICON = {
    heart(cv, x, y, s, c) {
        const k = s / 24, pts = [];
        for (let i = 0; i <= 40; i++) {
            const a = Math.PI * 2 * i / 40;
            pts.push([x + 0.7 * k * 16 * Math.pow(Math.sin(a), 3), y - 0.7 * k * (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) - k]);
        }
        cv.stroke(pts, 2.4, c);
    },
    disc(cv, x, y, s, c) { cv.arc(x, y, s * 0.46, s * 0.46 + 2.4, 0, 360, c); cv.arc(x, y, s * 0.12, s * 0.12 + 2.4, 0, 360, c); },
    list(cv, x, y, s, c) { [-0.3, 0, 0.3].forEach((d) => { cv.circle(x - s * 0.42, y + s * d, 2.2, c); cv.line(x - s * 0.22, y + s * d, x + s * 0.46, y + s * d, 2.4, c); }); },
    mix(cv, x, y, s, c) { [[-0.42, 0.18], [-0.21, 0.36], [0, 0.46], [0.21, 0.28], [0.42, 0.14]].forEach((b) => cv.line(x + s * b[0], y - s * b[1], x + s * b[0], y + s * b[1], 2.6, c)); },
    search(cv, x, y, s, c) { cv.arc(x - s * 0.1, y - s * 0.1, s * 0.3, s * 0.3 + 2.6, 0, 360, c); cv.line(x + s * 0.16, y + s * 0.16, x + s * 0.46, y + s * 0.46, 3, c); },
    /** the playing track's mark: three bars of different heights */
    playing(cv, x, y, s, c) { [[-0.3, 0.28], [0, 0.46], [0.3, 0.16]].forEach((b) => cv.line(x + s * b[0], y + s * 0.44, x + s * b[0], y + s * 0.44 - s * b[1] * 2, 3.4, c)); },
    chevron(cv, x, y, s, c) { cv.stroke([[x - s * 0.18, y - s * 0.34], [x + s * 0.16, y], [x - s * 0.18, y + s * 0.34]], 2.4, c); },
    warn(cv, x, y, s, c) { cv.stroke([[x, y - s * 0.46], [x + s * 0.5, y + s * 0.4], [x - s * 0.5, y + s * 0.4], [x, y - s * 0.46]], 3, c); cv.line(x, y - s * 0.14, x, y + s * 0.12, 3.2, c); cv.circle(x, y + s * 0.26, 2.2, c); },
    back(cv, x, y, s, c) { cv.stroke([[x + s * 0.1, y - s * 0.3], [x - s * 0.2, y], [x + s * 0.1, y + s * 0.3]], 2.6, c); cv.line(x - s * 0.2, y, x + s * 0.44, y, 2.6, c); },
    space(cv, x, y, s, c) { cv.stroke([[x - s * 0.4, y - s * 0.02], [x - s * 0.4, y + s * 0.22], [x + s * 0.4, y + s * 0.22], [x + s * 0.4, y - s * 0.02]], 2.4, c); },
    none() {},
};

/** a square for a missing cover: a dim tile with a note on it */
function placeholder(c, x, y, size) {
    const cv = c.cv, k = size / 100, col = c.p.note;
    cv.roundRect(x, y, size, size, Math.max(3, size * 0.06), c.p.tile);
    cv.circle(x + 40 * k, y + 68 * k, 9 * k, col);
    cv.circle(x + 66 * k, y + 62 * k, 9 * k, col);
    cv.fillRect(x + 46 * k, y + 28 * k, 3.5 * k, 40 * k, col);
    cv.fillRect(x + 72 * k, y + 22 * k, 3.5 * k, 40 * k, col);
    cv.quad([[x + 46 * k, y + 28 * k], [x + 75.5 * k, y + 22 * k], [x + 75.5 * k, y + 30 * k], [x + 46 * k, y + 36 * k]], col);
}
function cover(c, coverId, x, y, size, small) {
    const get = small ? c.ui.thumb : c.ui.cover;
    const img = coverId && typeof get === 'function' ? get(coverId) : null;
    if (img && typeof c.cv.image === 'function') { c.cv.image(img.id, x, y, size, size); return 'image'; }
    placeholder(c, x, y, size);
    return 'placeholder';
}

/** the caption line: the list's name (or a message, in the warning colour) and, on the right, where one is */
function caption(c, left, right) {
    const x = LAY.x, y = LAY.capY;
    if (messageOn(c)) {
        ICON.warn(c.cv, x + 22, y - 9, 26, c.p.warn);
        txt(c, c.s.message, x + 48, y, 24, c.p.warn, { w: right ? 1100 : 1400 });
    } else if (left) txt(c, left, x + 8, y, 24, c.p.dim, { w: right ? 1000 : 1400 });
    if (right) txt(c, right, x + LAY.w - 8, y, 22, c.p.dim, { align: 'right' });
    c.cv.fillRect(x, LAY.y0 - 6, LAY.w, 1, c.p.line);
}
function scrollBar(c, first, vis, total, y0, h) {
    if (total <= vis) return;
    const x = LAY.x + LAY.w + 16, kh = Math.max(28, h * vis / total);
    c.cv.roundRect(x, y0, 5, h, 2.5, c.p.track);
    c.cv.roundRect(x, y0 + (h - kh) * first / Math.max(1, total - vis), 5, kh, 2.5, c.p.knob);
}

/** a row of My music: icon, words, the value on the right, the arrow of a row that opens something */
function menuRow(c, y, row, focused) {
    const cv = c.cv, x = LAY.x, mid = y + LAY.rowH / 2;
    (ICON[row.icon] || ICON.none)(cv, x + 46, mid, 30, c.p.text);
    txt(c, row.label, x + 92, mid + 11, 30, c.p.text, { w: 700 });
    if (row.right) txt(c, row.right, x + LAY.w - 56, mid + 8, 23, c.p.dim, { align: 'right', w: 620 });
    ICON.chevron(cv, x + LAY.w - 28, mid, 24, focused ? c.p.text : c.p.dim);
}
/** a row of two lines: the number (or the playing mark), a cover, the title over its second line, the right column */
function mediaRow(c, y, row) {
    const x = LAY.x, mid = y + LAY.rowH / 2, off = !!row.off;
    const c1 = off ? c.p.off : c.p.text, c2 = off ? c.p.offDim : c.p.dim;
    if (row.kind === 'tracks' || row.kind === 'search') {
        if (row.playing) ICON.playing(c.cv, x + 34, mid - 4, 22, c.p.text);
        else txt(c, String(row.index + 1), x + 50, mid + 8, 22, c2, { align: 'right' });
    }
    cover(c, row.coverId, x + 68, y + 9, 52, true);
    if (off) c.cv.fillRect(x + 68, y + 9, 52, 52, alpha(c.p.bg, 0.6));
    const tx = x + 140, rightW = row.right ? c.cv.textWidth(T.ascii(row.right), 22, { literal: true }) + 40 : 20;
    const w = x + LAY.w - 24 - rightW - tx;
    txt(c, row.label, tx, y + 31, 27, c1, { w: w });
    if (row.sub) txt(c, row.sub, tx, y + 57, 20, c2, { w: w });
    if (row.right) txt(c, row.right, x + LAY.w - 24, mid + 8, 22, c2, { align: 'right' });
}
/** the rows on screen (only those: a list of 500 draws six), the highlight on the selected one, a scroll bar */
function drawRows(c, rows, cur, y0, vis, focusOn) {
    const r = L.range(cur, rows.length, vis);
    for (let i = r.first; i < r.last; i++) {
        const row = rows[i], y = y0 + (i - r.first) * LAY.rowH, focused = focusOn && i === cur.sel;
        if (focused) focusPlate(c, 'row:' + i, LAY.x, y + 3, LAY.w, LAY.rowH - 6, 10);
        else c.cv.fillRect(LAY.x + 8, y + LAY.rowH - 1, LAY.w - 16, 1, c.p.hair);
        if (row.kind === 'menu') menuRow(c, y, row, focused);
        else mediaRow(c, y, row);
        target(c, { x: LAY.x, y: y, w: LAY.w, h: LAY.rowH, key: 'row:' + i, row: i, act: { type: 'row', index: i } }, 10);
    }
    scrollBar(c, r.first, vis, rows.length, y0, vis * LAY.rowH);
}
function centredNote(c, text, y) { txt(c, text, W / 2, y, 26, c.p.dim, { align: 'center', w: LAY.w - 80 }); }

/* ---------- the screens ---------- */
function drawLibrary(c) {
    caption(c, 'My music', c.s.offlineBrowse ? 'Offline: lists from before' : null);
    drawRows(c, L.rows(c.s), L.cursor(c.s), LAY.y0, L.VISIBLE, onPage(c));
}

function drawList(c) {
    const s = c.s, f = M.top(s);
    if (f.kind === 'search') return drawSearch(c, f);
    const total = typeof f.total === 'number' && f.total > f.items.length ? f.total : f.items.length;
    const where = f.items.length ? (Math.min(f.sel, f.items.length - 1) + 1) + ' of ' + total : '';
    caption(c, f.title, [f.stale ? 'Not up to date (offline)' : '', where].filter(Boolean).join(DOT));
    if (!f.items.length) {
        if (f.loading) centredNote(c, 'Loading...', 250);
        else if (f.error) centredNote(c, 'Could not load this list (' + f.error + ').', 250);
        else centredNote(c, 'Nothing here yet.', 250);
        return;
    }
    drawRows(c, L.rows(s), L.cursor(s), LAY.y0, L.VISIBLE, onPage(c));
}

/** search: what was typed, one row of characters the knob goes along, the results under it */
function drawSearch(c, f) {
    const s = c.s, cv = c.cv, x = LAY.x, w = LAY.w, typing = s.search.keyboard && !s.moving;
    const lettersOn = typing && onPage(c);
    cv.roundRect(x, 50, w, 58, 8, c.p.tile);
    ICON.search(cv, x + 34, 80, 28, c.p.dim);
    const q = s.search.query;
    const tw = q ? txt(c, q, x + 70, 91, 32, c.p.text, { w: w - 520 }) : 0;
    if (typing) cv.fillRect(x + 70 + tw + (q ? 5 : 0), 62, 2.5, 36, lettersOn ? c.p.focus : c.p.dim);
    let right = '', rc = c.p.dim;
    if (messageOn(c)) { right = s.message; rc = c.p.warn; } else if (s.moving) right = 'Typing only while parked';
    else if (f.source.params.query) right = f.loading ? 'Searching...' : f.error ? 'The search failed (' + f.error + ')' : (f.total != null ? f.total : f.items.length) + ' track' + ((f.total != null ? f.total : f.items.length) === 1 ? '' : 's');
    if (right) txt(c, right, x + w - 20, 89, 22, rc, { align: 'right', w: 440 });
    // one row of characters
    const cells = M.speller(s.search.digits), cw = w / cells.length, y = 118, h = 62, fi = s.search.key;
    cv.roundRect(x, y, w, h, 8, alpha(c.p.text, 0.04));
    cells.forEach((ch, i) => {
        const cx = x + i * cw, mid = cx + cw / 2, on = lettersOn && i === fi;
        if (on) focusPlate(c, 'key:' + i, cx - 4, y - 5, cw + 8, h + 10, 10);
        const col = s.moving ? c.p.off : on ? c.p.text : c.p.soft;
        if (ch === 'SPACE') ICON.space(cv, mid, y + h / 2 + 2, 30, col);
        else if (ch === 'DEL') ICON.back(cv, mid, y + h / 2, 30, col);
        else txt(c, ch, mid, y + h / 2 + (on ? 13 : 10), ch.length > 1 ? 21 : on ? 36 : 28, col, { align: 'center', font: ch.length > 1 || on ? 'bold' : 'label' });
        if (ch === 'Z' || ch === '9' || ch === '123' || ch === 'ABC') cv.fillRect(cx + cw, y + 14, 1, h - 28, c.p.line);
        if (!s.moving) {
            const key = ch === '123' || ch === 'ABC' ? 'DIGITS' : ch === 'SPACE' ? ' ' : ch === 'OK' ? 'SEARCH' : ch;
            target(c, { x: cx, y: y, w: cw, h: h, key: 'key:' + i, act: { type: 'key', key: key } }, 8);
        }
    });
    // the results
    if (!f.items.length) {
        const note = f.loading ? 'Searching...' : f.error ? 'The search failed (' + f.error + ').' : f.source.params.query ? 'No tracks found.' : typing ? 'Type a name, then OK.' : '';
        if (note) centredNote(c, note, L.SEARCH_Y0 + 100);
        return;
    }
    drawRows(c, L.rows(s), L.cursor(s), L.SEARCH_Y0, L.SEARCH_VISIBLE, onPage(c) && !typing);
}

/** a message page: a headline (with the warning sign), a sentence or two, the choices as rows */
function drawMessage(c, m) {
    const x = 150, cv = c.cv;
    if (m.icon === 'warn') ICON.warn(cv, x + 32, 156, 68, c.p.warn);
    txt(c, m.title, x + 96, 176, 50, c.p.text, { font: 'light', w: 1300 });
    (m.lines || []).forEach((l, i) => txt(c, l, x + 96, 228 + i * 36, 26, c.p.dim, { w: 1300 }));
    choices(c, m.choices, x + 76, 282 + Math.max(0, (m.lines || []).length - 1) * 36, 760);
}
function choices(c, list, x, y0, w) {
    const sel = Math.max(0, Math.min((list || []).length - 1, c.s.focus.row));
    (list || []).forEach((ch, i) => {
        const y = y0 + i * LAY.rowH, focused = onPage(c) && i === sel;
        if (focused) focusPlate(c, 'choice:' + i, x, y + 3, w, LAY.rowH - 6, 10);
        else c.cv.fillRect(x + 8, y + LAY.rowH - 1, w - 16, 1, c.p.hair);
        txt(c, ch.label, x + 24, y + 46, 30, c.p.text, { w: w - 80 });
        ICON.chevron(c.cv, x + w - 28, y + LAY.rowH / 2, 24, focused ? c.p.text : c.p.dim);
        target(c, { x: x, y: y, w: w, h: LAY.rowH, key: 'choice:' + i, act: ch.act }, 10);
    });
}

function shortHost(url) { return str(url).replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''); }

/** the login: the QR code on the left, two numbered steps and the code on the right, "New code" */
function drawLogin(c) {
    const s = c.s, l = s.login, cv = c.cv, box = 404, x = 56 + box + 64;
    txt(c, 'Sign in to TIDAL', x, 134, 50, c.p.text, { font: 'light' });
    if (s.message) txt(c, s.message, x, 170, 22, c.p.warn, { w: 980 });
    const m = P.message(s), offer = (y) => choices(c, m.choices, x + 36, y, 420);
    const two = (a, b) => { txt(c, a, x, 216, 27, c.p.text, { w: 980 }); txt(c, b, x, 258, 22, c.p.dim, { w: 980 }); offer(300); };
    if (l && l.failed) return two('Could not get a login code.', 'Try again in a moment.');
    if (!l || l.requesting || (!l.url && !l.expired)) { txt(c, 'Getting a code...', x, 216, 27, c.p.dim); return undefined; }
    if (l.denied) return two('The login was refused on the phone.', 'Get a new code to try again.');
    if (l.expired) return two('The code expired.', 'Get a new one and scan it with your phone.');
    txt(c, '1', x, 196, 27, c.p.dim); txt(c, 'Scan the code with your phone\'s camera', x + 40, 196, 27, c.p.text, { w: 940 });
    txt(c, '2', x, 240, 27, c.p.dim); txt(c, 'Or open  ' + shortHost(l.url) + '  and enter this code', x + 40, 240, 27, c.p.text, { w: 940 });
    txt(c, l.userCode, x + 40, 330, 64, c.p.text, { font: 'bold', spacing: 10, w: 940 });
    if (c.ui.now && l.expiresAt) {
        const left = Math.max(0, Math.ceil((l.expiresAt - c.ui.now) / 60000));
        txt(c, 'The code is valid for ' + left + ' more minute' + (left === 1 ? '' : 's') + '.', x + 40, 376, 22, c.p.dim);
    }
    offer(405);
    const q = QR.matrix(l.url);
    if (!q) return undefined;
    const lay = QR.layout(q.n, box), qx = 56, qy = 76 + Math.floor((box - lay.size) / 2);
    QR.draw(cv, q, qx, qy, lay.cell);
    c.info.qr = { x: qx, y: qy, cell: lay.cell, size: lay.size, n: q.n };
    return undefined;
}

const NP_STATE = { buffering: 'Buffering...', loading: 'Loading...', paused: 'Paused' };

/** the track after the one on, when the list it plays from is known */
function nextOf(s) {
    const p = s.player, q = s.queue;
    if (!q || !p || !p.track || !(p.queueIndex >= 0)) return null;
    const here = q.tracks[p.queueIndex];
    if (!here || here.id !== p.track.id) return null;
    const n = q.tracks[p.queueIndex + 1];
    return n && typeof n.title === 'string' ? n : null;
}
/** the list it plays from, while it is the one playing */
function sourceOf(s) {
    const p = s.player, q = s.queue;
    return q && p && p.track && q.tracks.some((t) => t && t.id === p.track.id) ? q.title : '';
}

function drawNowPlaying(c) {
    const s = c.s, cv = c.cv, p = s.player;
    const m = P.message(s);
    if (m) return drawMessage(c, m);
    const tr = p.track, size = 400, cx = 56, cy = 76;
    c.info.cover = cover(c, tr.coverId, cx, cy, size, false);
    const x = cx + size + 64, r = LAY.x + LAY.w, w = r - x;
    // the caption: a message, the player's error, or its state, the list and where in it
    const quality = NP.qualityText(p.quality);
    if (messageOn(c)) {
        ICON.warn(cv, x + 14, 107, 24, c.p.warn);
        txt(c, s.message, x + 38, 116, 23, c.p.warn, { w: w - 240 });
    } else if (p.state === 'error') txt(c, NP.errorText(p.error), x, 116, 23, c.p.warn, { w: w - 200 });
    else {
        const where = p.queueLength > 0 && p.queueIndex >= 0 ? (p.queueIndex + 1) + ' of ' + p.queueLength : '';
        const cap = [NP_STATE[p.state] || '', sourceOf(s), where].filter(Boolean).join(DOT);
        if (cap) txt(c, cap, x, 116, 23, c.p.dim, { w: w - 200 });
    }
    if (quality) txt(c, quality, r, 116, 22, c.p.dim, { align: 'right' });
    txt(c, tr.title, x, 192, 54, c.p.text, { font: 'light', w: w });
    txt(c, L.joinArtists(tr.artists), x, 246, 32, c.p.text, { w: w });
    if (tr.album && tr.album.title) txt(c, tr.album.title, x, 286, 25, c.p.dim, { w: w });
    // the progress line (the finger, the controller pushed up onto it, the wheel held: seek.js)
    const pos = typeof c.ui.position === 'number' ? c.ui.position : p.position;
    const dur = typeof c.ui.duration === 'number' ? c.ui.duration : (p.duration || tr.duration || null);
    const by = 372, seekable = !!dur && p.state !== 'error';
    const seeking = seekable && c.ui.seeking === true, onLine = seekable && P.area(s) === 'progress';
    c.info.barFocus = onLine;
    if (onLine) focusPlate(c, 'progress', x - 18, by - 17, w + 36, 40, 12);
    cv.roundRect(x, by, w, 6, 3, c.p.track);
    const f = dur ? Math.max(0, Math.min(1, pos / dur)) : 0;
    if (dur) cv.roundRect(x, by, Math.max(6, w * f), 6, 3, p.state === 'playing' || seeking ? c.p.text : c.p.dim);
    if (dur) cv.circle(x + w * f, by + 3, seeking || onLine ? 12 : 9, c.p.text);
    txt(c, L.mmss(pos) || '0:00', x, by + 42, 23, seeking ? c.p.text : c.p.dim, seeking ? { font: 'bold' } : undefined);
    if (dur) txt(c, L.mmss(dur), r, by + 42, 23, c.p.dim, { align: 'right' });
    if (seekable) c.info.hits.push({ x: x - 24, y: by - 26, w: w + 48, h: 60, key: 'np-bar', bar: { x: x, w: w, dur: dur } });
    const n = nextOf(s);
    if (n) {
        txt(c, 'Next', x, 468, 22, c.p.dim);
        const by2 = L.joinArtists(n.artists);
        txt(c, n.title + (by2 ? DOT + by2 : ''), x + 66, 468, 22, alpha(c.p.text, 0.8), { w: w - 80 });
    }
    return undefined;
}

/** the car's volume (the HMI shows no popup of its own on source 287): a bar and the number, or Mute */
function drawVolume(c, v) {
    const cv = c.cv, pw = 520, ph = 80, x = W - pw - 40, y = 50, cy = y + ph / 2;
    cv.roundRect(x - 2, y - 2, pw + 4, ph + 4, 24, alpha(c.p.text, 0.19));
    cv.roundRect(x, y, pw, ph, 22, alpha(c.p.bg, 0.98));
    const level = typeof v.volume === 'number' && v.max ? Math.max(0, Math.min(1, v.volume / v.max)) : 0;
    const bx = x + 40, bw = pw - 200;
    cv.roundRect(bx, cy - 5, bw, 10, 5, c.p.track);
    if (!v.muted && level > 0) cv.roundRect(bx, cy - 5, Math.max(10, bw * level), 10, 5, c.p.text);
    const label = v.muted ? 'Mute' : typeof v.volume === 'number' ? String(Math.round(v.volume)) : '-';
    cv.text(label, x + pw - 40, cy + 12, 34, v.muted ? c.p.dim : c.p.text, { align: 'right', font: 'bold', literal: true });
}

const DRAW = {
    NO_SERVICE: (c) => drawMessage(c, P.message(c.s)), OFFLINE: (c) => drawMessage(c, P.message(c.s)), ERROR: (c) => drawMessage(c, P.message(c.s)),
    LOGIN: drawLogin, LIBRARY: drawLibrary, LIST: drawList, NOW_PLAYING: drawNowPlaying,
};

function draw(cv, t, s, ui) {
    const c = { cv: cv, t: t, p: palette(t), s: s, ui: ui || {}, info: { hits: [], qr: null, cover: null, barFocus: false, focus: null } };
    const fn = DRAW[s.screen];
    if (fn) fn(c);
    if (c.ui.volume) drawVolume(c, c.ui.volume);
    return c.info;
}

/** the controller's press on the page's focused choice (message pages, the login) */
function defaultAct(s) {
    const m = P.message(s), list = (m && m.choices) || [];
    const ch = list[Math.max(0, Math.min(list.length - 1, s.focus.row))];
    return ch ? ch.act : null;
}

module.exports = { draw: draw, defaultAct: defaultAct, palette: palette, alpha: alpha, W: W, H: H, LAY: LAY };
