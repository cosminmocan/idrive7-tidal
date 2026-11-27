'use strict';
/**
 * ui-mock.js - the pictures of the interface proposal (docs/ui-redesign.md, task U1 step 1), drawn with the kit's
 * own canvas, fonts and colour themes (kit/runtime/canvas.js, fonts, themes.js, gauges.js), so they show only what
 * the kit can draw. No app code is used for the proposal itself; the app's QR code (qr.js) and, for the one
 * picture of today's interface, its screens (screens.js) are read as they are.
 *
 *   node tools/ui-mock.js [outDir]      every picture as <outDir>/<name>.png, 1920 x 720 (default docs/ui-mock)
 *   THEME=m_red node tools/ui-mock.js   in another of the kit's themes (default m_tricolour, the car's today)
 *
 * In Docker (Node is not on the Mac), with the image `make app-preview` builds:
 *   docker run --rm -v "$PWD:/w" -w /w cmocan-tidal-kit node tools/ui-mock.js
 *
 * Each picture is the whole centre display. BMW's parts of it are sketched from the owner's photos, with shapes of
 * our own (no BMW artwork): the title strip with the home button and the status corner, and the back arrow column.
 * The header's name and tabs and the bar are the kit's (G.header, G.menuBar), placed as kit/runtime/display.js
 * places them; the page is drawn in the app's 1600 x 520 units at the kit's scale for this layout.
 * a-*.png: option A (our drawn screens). b-*.png: option B, a sketch of lists drawn by BMW's HMI (the real ones
 * look as the car's own lists do). today-*.png: today's interface in the same frame.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));
const themes = require(path.join(ROOT, 'kit', 'runtime', 'themes'));
const G = require(path.join(ROOT, 'kit', 'runtime', 'gauges'));
const QR = require(path.join(ROOT, 'apps', 'cmocan_tidal', 'qr'));

/* the screen and the kit's full-screen layout on it (kit/runtime/display.js: HMI7, FULL, _place) */
const SW = 1920, SH = 720, HEAD = 80, BAR = 48, LEFT = 84, STATUS_X = 1340;
const SRC = { x: 12, y: 38, w: 1576, h: 482 };
const K = Math.floor(Math.min((SW - LEFT) / SRC.w, (SH - HEAD - BAR) / SRC.h) * 1000) / 1000;
const OX = LEFT + Math.round((SW - LEFT - SRC.w * K) / 2 - SRC.x * K);
const OY = Math.round(HEAD + (SH - HEAD - BAR - SRC.h * K) / 2 - SRC.y * K);

const T = themes.theme(process.env.THEME || 'm_tricolour');
const FOCUS = T.sel || T.accent;
const a = (c, v) => G.withAlpha(c, v);
const WHITE = '#ffffff';
const HMI_ARROW = '#f25a2e';        // the HMI's own back arrow in the photos (not ours to choose)

/* ---------- the page: the app's 1600 x 520 units on the screen ---------- */
function pageOf(cv) {
    const X = (x) => OX + x * K, Y = (y) => OY + y * K;
    const P = {
        cv: cv,
        fillRect: (x, y, w, h, c) => { cv.fillRect(Math.round(X(x)), Math.round(Y(y)), Math.max(1, Math.round(w * K)), Math.max(1, Math.round(h * K)), c); return P; },
        roundRect: (x, y, w, h, r, c) => { cv.roundRect(X(x), Y(y), w * K, h * K, r * K, c); return P; },
        strokeRoundRect: (x, y, w, h, r, lw, c) => { cv.strokeRoundRect(X(x), Y(y), w * K, h * K, r * K, lw * K, c); return P; },
        circle: (x, y, r, c) => { cv.circle(X(x), Y(y), r * K, c); return P; },
        ring: (x, y, r0, r1, c, a0, a1) => { cv.arc(X(x), Y(y), r0 * K, r1 * K, a0 == null ? 0 : a0, a1 == null ? 360 : a1, c); return P; },
        line: (xa, ya, xb, yb, lw, c) => { cv.line(X(xa), Y(ya), X(xb), Y(yb), lw * K, c); return P; },
        stroke: (pts, lw, c) => { cv.stroke(pts.map((p) => [X(p[0]), Y(p[1])]), lw * K, c); return P; },
        fill: (pts, c) => { cv.fill(pts.map((p) => [X(p[0]), Y(p[1])]), c); return P; },
        text: (s, x, y, size, c, o) => cv.text(String(s), X(x), Y(y), size * K, c, opts(o)) / K,
        textWidth: (s, size, o) => cv.textWidth(String(s), size * K, opts(o)) / K,
        image: (img, x, y, w, h) => { cv.drawImage(img.d, img.w, img.h, X(x), Y(y), w * K, h * K); return P; },
        px: (v) => Math.round(v * K),
    };
    function opts(o) { return { literal: true, font: (o && o.font) || 'label', align: (o && o.align) || 'left', spacing: ((o && o.spacing) || 0) * K }; }
    return P;
}
/** s cut with an ellipsis so it is at most maxW wide */
function fit(P, s, size, maxW, o) {
    s = String(s);
    if (P.textWidth(s, size, o) <= maxW) return s;
    let n = s.length;
    while (n > 1 && P.textWidth(s.slice(0, n).replace(/\s+$/, '') + '…', size, o) > maxW) n--;
    return s.slice(0, n).replace(/\s+$/, '') + '…';
}
function label(P, s, x, y, size, c, o) { return P.text(o && o.w ? fit(P, s, size, o.w, o) : s, x, y, size, c, o); }

/* ---------- covers for the pictures: patterns, no real artwork ---------- */
function cover(n, hue) {
    const c = new Canvas(n, n);
    const pal = [['#2a2f6e', '#c2306e'], ['#0f3d3a', '#d39a2c'], ['#3a1650', '#3d9bd6'], ['#5a1a1a', '#e0b060'], ['#14324f', '#7fd1c0'], ['#3b3b3b', '#b9b9b9']][hue % 6];
    c.gradientRect(0, 0, n, n, [[0, pal[0]], [1, pal[1]]]);
    const m = hue % 3;
    if (m === 0) c.fill([[n / 2, n * 0.24], [n * 0.76, n / 2], [n / 2, n * 0.76], [n * 0.24, n / 2]], a(WHITE, 0.28));
    else if (m === 1) { c.arc(n / 2, n / 2, n * 0.2, n * 0.32, 0, 360, a(WHITE, 0.3)); c.circle(n / 2, n / 2, n * 0.07, a(WHITE, 0.4)); }
    else { c.fillRect(Math.round(n * 0.22), Math.round(n * 0.3), Math.round(n * 0.56), Math.round(n * 0.06), a(WHITE, 0.35)); c.fillRect(Math.round(n * 0.22), Math.round(n * 0.47), Math.round(n * 0.4), Math.round(n * 0.06), a(WHITE, 0.28)); c.fillRect(Math.round(n * 0.22), Math.round(n * 0.64), Math.round(n * 0.5), Math.round(n * 0.06), a(WHITE, 0.2)); }
    return c;
}

/* ---------- our icons: lines and circles, drawn here ---------- */
const ICON = {
    heart(P, x, y, s, c) {
        const k = s / 24, pts = [];
        for (let i = 0; i <= 40; i++) {
            const t = Math.PI * 2 * i / 40;
            pts.push([x + 0.7 * k * 16 * Math.pow(Math.sin(t), 3), y - 0.7 * k * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) - k]);
        }
        P.stroke(pts, 2.4, c);
    },
    disc(P, x, y, s, c) { P.ring(x, y, s * 0.46, s * 0.46 + 2.4, c); P.ring(x, y, s * 0.12, s * 0.12 + 2.4, c); },
    list(P, x, y, s, c) { [-0.3, 0, 0.3].forEach((d) => { P.circle(x - s * 0.42, y + s * d, 2.2, c); P.line(x - s * 0.22, y + s * d, x + s * 0.46, y + s * d, 2.4, c); }); },
    mix(P, x, y, s, c) { [[-0.42, 0.18], [-0.21, 0.36], [0, 0.46], [0.21, 0.28], [0.42, 0.14]].forEach((b) => P.line(x + s * b[0], y - s * b[1], x + s * b[0], y + s * b[1], 2.6, c)); },
    search(P, x, y, s, c) { P.ring(x - s * 0.1, y - s * 0.1, s * 0.3, s * 0.3 + 2.6, c); P.line(x + s * 0.16, y + s * 0.16, x + s * 0.46, y + s * 0.46, 3, c); },
    note(P, x, y, s, c) { P.circle(x - s * 0.16, y + s * 0.3, s * 0.15, c); P.line(x - s * 0.02, y + s * 0.3, x - s * 0.02, y - s * 0.4, 2.6, c); P.line(x - s * 0.02, y - s * 0.4, x + s * 0.3, y - s * 0.28, 2.6, c); },
    gear(P, x, y, s, c) { P.ring(x, y, s * 0.2, s * 0.2 + 2.4, c); for (let i = 0; i < 8; i++) { const t = Math.PI * i / 4; P.line(x + Math.sin(t) * s * 0.34, y - Math.cos(t) * s * 0.34, x + Math.sin(t) * s * 0.46, y - Math.cos(t) * s * 0.46, 3, c); } },
    /** the playing track's mark: three bars of different heights */
    playing(P, x, y, s, c) { [[-0.3, 0.28], [0, 0.46], [0.3, 0.16]].forEach((b) => P.line(x + s * b[0], y + s * 0.44, x + s * b[0], y + s * 0.44 - s * b[1] * 2, 3.4, c)); },
    chevron(P, x, y, s, c) { P.stroke([[x - s * 0.18, y - s * 0.34], [x + s * 0.16, y], [x - s * 0.18, y + s * 0.34]], 2.4, c); },
    warn(P, x, y, s, c) { P.stroke([[x, y - s * 0.46], [x + s * 0.5, y + s * 0.4], [x - s * 0.5, y + s * 0.4], [x, y - s * 0.46]], 3, c); P.line(x, y - s * 0.14, x, y + s * 0.12, 3.2, c); P.circle(x, y + s * 0.26, 2.2, c); },
    back(P, x, y, s, c) { P.stroke([[x + s * 0.1, y - s * 0.3], [x - s * 0.2, y], [x + s * 0.1, y + s * 0.3]], 2.6, c); P.line(x - s * 0.2, y, x + s * 0.44, y, 2.6, c); },
    space(P, x, y, s, c) { P.stroke([[x - s * 0.4, y - s * 0.02], [x - s * 0.4, y + s * 0.22], [x + s * 0.4, y + s * 0.22], [x + s * 0.4, y - s * 0.02]], 2.4, c); },
    none() {},
};

/* ---------- the frame: BMW's strip and column (sketched), the kit's header and bar ---------- */
function barButtons(labels) {
    const m = new Canvas(1, 1);
    let x = 132;                                       // display.js HMI7.btn: from x 132, each its label + 180 px
    return labels.map((l) => { const w = Math.round(m.textWidth(l, 40, { font: 'label', literal: true }) * 1.465) + 180; const r = { label: l, x: x, w: w }; x += w; return r; });
}
function hmiStrip(cv) {
    cv.fillRect(0, 0, SW, HEAD, '#000000');
    cv.fillRect(0, 0, LEFT, 530, '#000000');
    cv.fillRect(LEFT, HEAD - 2, SW - LEFT, 2, a(WHITE, 0.22));
    // the home button (a plain house) and the mark under it
    cv.fill([[42, 22], [62, 40], [56, 40], [56, 56], [46, 56], [46, 45], [38, 45], [38, 56], [28, 56], [28, 40], [22, 40]], WHITE);
    cv.fillRect(0, HEAD - 5, LEFT, 5, '#8f9197');
    // the back arrow
    cv.stroke([[52, 384], [34, 405], [52, 426]], 4, HMI_ARROW);
    // the status corner: placeholders for the car's own icons, and the clock
    const y = 40, c = '#e8e8e8';
    cv.fill([[1576, y - 6], [1584, y - 6], [1594, y - 14], [1594, y + 14], [1584, y + 6], [1576, y + 6]], c);
    cv.roundRect(1646, y - 15, 10, 21, 5, c); cv.arc(1651, y, 11, 13.2, 90, 270, c); cv.fillRect(1650, y + 12, 2, 6, c);
    cv.circle(1716, y - 6, 7, c); cv.arc(1716, y + 16, 13, 15.4, 300, 420, c);
    cv.text('19:14', SW - 32, y + 13, 36, c, { literal: true, font: 'light', align: 'right' });
}
/** opt: { tabs, tab, tabFocus, bar: [labels], barFocus, title, hmiTitle (a screen BMW's HMI draws: its own title, no kit header) } */
function chrome(cv, opt) {
    hmiStrip(cv);
    if (opt.hmiTitle) {
        cv.text(opt.hmiTitle, LEFT + 24, 54, 40, WHITE, { literal: true, font: 'light' });
    } else {
        const tabs = opt.tabs || [];
        G.header(cv, Object.assign({}, T, { bg: '#000000' }), LEFT, 0, STATUS_X - LEFT, HEAD, 'TIDAL', tabs, opt.tab == null ? -1 : opt.tab, [], true, true);
        const ft = opt.tabFocus != null && (cv.tabRects || []).filter((q) => q.i === opt.tabFocus)[0];
        if (ft) { cv.strokeRoundRect(ft.x + 1, ft.y + 7, ft.w - 2, ft.h - 14, 12, 5, a(FOCUS, 0.28)); cv.strokeRoundRect(ft.x + 4, ft.y + 10, ft.w - 8, ft.h - 20, 10, 2.5, FOCUS); }
    }
    if (opt.bar && opt.bar.length) G.menuBar(cv, T, 0, SH - BAR, SW, BAR, barButtons(opt.bar), opt.barFocus == null ? -1 : opt.barFocus, 'slim', -1);
}
const TABS = ['Library', 'Now playing', 'Settings'];
const TRANSPORT = (playing) => ['Previous', playing === false ? 'Play' : 'Pause', 'Next'];
function newScreen() { const cv = new Canvas(SW, SH); cv.clear(T.bg); return cv; }

/* ---------- option A: the pieces ---------- */
const M = { x: 40, w: 1500, capY: 72, y0: 92, rowH: 70, rows: 6 };
function caption(P, left, right, warnText) {
    if (warnText) { ICON.warn(P, M.x + 22, M.capY - 9, 26, T.warn); label(P, warnText, M.x + 48, M.capY, 24, T.warn, { w: 1100 }); }
    else label(P, left, M.x + 8, M.capY, 24, T.dim, { w: 1000 });
    if (right) label(P, right, M.x + M.w - 8, M.capY, 22, T.dim, { align: 'right' });
    P.fillRect(M.x, M.y0 - 6, M.w, 1, a(WHITE, 0.14));
}
function focusPlate(P, x, y, w, h, r) {
    P.roundRect(x, y, w, h, r, a(FOCUS, 0.26));
    P.strokeRoundRect(x, y, w, h, r, 2.5, FOCUS);
}
function rowBase(P, i, focused) {
    const y = M.y0 + i * M.rowH;
    if (focused) focusPlate(P, M.x, y + 3, M.w, M.rowH - 6, 10);
    else P.fillRect(M.x + 8, y + M.rowH - 1, M.w - 16, 1, a(WHITE, 0.07));
    return y;
}
function scrollBar(P, first, visible, total, y0, h) {
    if (total <= visible) return;
    const x = M.x + M.w + 16;
    P.roundRect(x, y0, 5, h, 2.5, a(WHITE, 0.12));
    const kh = Math.max(28, h * visible / total);
    P.roundRect(x, y0 + (h - kh) * first / Math.max(1, total - visible), 5, kh, 2.5, a(WHITE, 0.6));
}
/** a menu row: icon, text, a value on the right, the arrow of a row that opens something */
function menuRow(P, i, r, focused) {
    const y = rowBase(P, i, focused), mid = y + M.rowH / 2;
    (ICON[r.icon] || ICON.none)(P, M.x + 46, mid, 30, T.text);
    label(P, r.label, M.x + 92, mid + 11, 30, T.text, { w: 700 });
    if (r.value) label(P, r.value, M.x + M.w - 56, mid + 8, 23, T.dim, { align: 'right', w: 620 });
    ICON.chevron(P, M.x + M.w - 28, mid, 24, focused ? T.text : T.dim);
}
/** a row of two lines: the number (or the playing mark), a cover, title and artist, the time */
function mediaRow(P, i, r, focused, y0) {
    const y = y0 == null ? rowBase(P, i, focused) : y0, mid = y + M.rowH / 2;
    const off = r.unavailable, c1 = off ? a(T.text, 0.36) : T.text, c2 = off ? a(T.dim, 0.5) : T.dim;
    if (r.playing) ICON.playing(P, M.x + 34, mid - 4, 22, T.text);
    else if (r.num != null) label(P, String(r.num), M.x + 50, mid + 8, 22, c2, { align: 'right' });
    if (r.cover != null) { P.image(cover(P.px(52), r.cover), M.x + 68, y + 9, 52, 52); if (off) P.fillRect(M.x + 68, y + 9, 52, 52, a(T.bg, 0.6)); }
    const tx = M.x + (r.cover != null ? 140 : 68), rightW = r.right ? P.textWidth(r.right, 22) + 40 : 20;
    const w = M.x + M.w - 24 - rightW - tx;
    label(P, r.title, tx, y + 31, 27, c1, { w: w });
    label(P, r.sub, tx, y + 57, 20, c2, { w: w });
    if (r.right) label(P, r.right, M.x + M.w - 24, mid + 8, 22, c2, { align: 'right' });
}

const TRACKS = [
    { title: 'One More Time', sub: 'Daft Punk  ·  Discovery', right: '5:20', cover: 0 },
    { title: 'Stirile de azi (editia de seara)', sub: 'Ana Blandiana, Grigore Vieru  ·  Album', right: '4:01', cover: 1 },
    { title: 'Ein sehr, sehr langer Titel, der niemals in eine Zeile passt, weil er immer weiter und weiter geht und nicht aufhoert, bis die Anzeige zu Ende ist', sub: 'Die Aerzte  ·  Album', right: '3:19', cover: 2 },
    { title: 'Not streamable here', sub: 'Somebody  ·  Album', right: 'Not available', cover: 5, unavailable: true },
    { title: 'Harder, Better, Faster, Stronger', sub: 'Daft Punk  ·  Discovery', right: '3:44', cover: 0 },
    { title: 'Digital Love', sub: 'Daft Punk  ·  Discovery', right: '5:01', cover: 0 },
];

/* ---------- option A: the screens ---------- */
function aHome() {
    const cv = newScreen(), P = pageOf(cv);
    caption(P, 'My music', null);
    [{ icon: 'heart', label: 'Favourite tracks' }, { icon: 'disc', label: 'Favourite albums' }, { icon: 'list', label: 'Playlists' },
        { icon: 'mix', label: 'Mixes' }, { icon: 'search', label: 'Search' },
        { icon: 'playing', label: 'Now playing', value: 'One More Time  ·  Daft Punk' }].forEach((r, i) => menuRow(P, i, r, i === 0));
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(true) });
    return cv;
}
function aTracks() {
    const cv = newScreen(), P = pageOf(cv);
    caption(P, 'Favourite tracks', '3 of 120');
    TRACKS.forEach((r, i) => mediaRow(P, i, Object.assign({ num: i + 1, playing: i === 0 }, r), i === 2));
    scrollBar(P, 0, M.rows, 120, M.y0, M.rows * M.rowH);
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(true) });
    return cv;
}
function aAlbums() {
    const cv = newScreen(), P = pageOf(cv);
    caption(P, 'Favourite albums', '2 of 23');
    [{ title: 'Discovery', sub: 'Daft Punk', right: '14 tracks', cover: 0 }, { title: 'Random Access Memories', sub: 'Daft Punk', right: '13 tracks', cover: 4 },
        { title: 'Cantece de drum', sub: 'Phoenix', right: '11 tracks', cover: 3 }, { title: 'Mezzanine', sub: 'Massive Attack', right: '11 tracks', cover: 5 },
        { title: 'Moon Safari', sub: 'Air', right: '10 tracks', cover: 1 }, { title: 'Dummy', sub: 'Portishead', right: '11 tracks', cover: 2 }]
        .forEach((r, i) => mediaRow(P, i, r, i === 1));
    scrollBar(P, 0, M.rows, 23, M.y0, M.rows * M.rowH);
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(true) });
    return cv;
}
function aNowPlaying() {
    const cv = newScreen(), P = pageOf(cv);
    const size = 400, cx = 56, cy = 76;
    P.image(cover(P.px(size), 0), cx, cy, size, size);
    const x = cx + size + 64, r = M.x + M.w, w = r - x;
    label(P, 'Favourite tracks  ·  3 of 14', x, 116, 23, T.dim, { w: w - 200 });
    label(P, 'AAC 320', r, 116, 22, T.dim, { align: 'right' });
    label(P, 'One More Time', x, 192, 54, T.text, { font: 'light', w: w });      // light: 64 px on screen is its largest size with letters
    label(P, 'Daft Punk', x, 246, 32, T.text, { w: w });
    label(P, 'Discovery', x, 286, 25, T.dim, { w: w });
    const by = 372, f = 98 / 320;
    P.roundRect(x, by, w, 6, 3, a(WHITE, 0.16));
    P.roundRect(x, by, w * f, 6, 3, T.text);
    P.circle(x + w * f, by + 3, 9, T.text);
    label(P, '1:38', x, by + 42, 23, T.dim);
    label(P, '5:20', r, by + 42, 23, T.dim, { align: 'right' });
    label(P, 'Next', x, 468, 22, T.dim);
    label(P, 'Aerodynamic  ·  Daft Punk', x + 66, 468, 22, a(T.text, 0.8), { w: w - 80 });
    chrome(cv, { tabs: TABS, tab: 1, bar: TRANSPORT(true), barFocus: 1 });
    return cv;
}
function aSearch() {
    const cv = newScreen(), P = pageOf(cv);
    // what was typed
    P.roundRect(M.x, 50, M.w, 58, 8, a(WHITE, 0.08));
    ICON.search(P, M.x + 34, 80, 28, T.dim);
    const tw = label(P, 'DAFT', M.x + 70, 91, 32, T.text);
    P.fillRect(M.x + 70 + tw + 5, 62, 2.5, 36, FOCUS);
    label(P, '4 tracks', M.x + M.w - 20, 89, 22, T.dim, { align: 'right' });
    // one row of characters: the knob goes along it
    const cells = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').concat(['123', 'space', 'del', 'OK']);
    const cw = M.w / cells.length, y = 118, h = 62, fi = cells.indexOf('T');
    P.roundRect(M.x, y, M.w, h, 8, a(WHITE, 0.04));
    cells.forEach((ch, i) => {
        const x = M.x + i * cw, mid = x + cw / 2, on = i === fi;
        if (on) focusPlate(P, x - 4, y - 5, cw + 8, h + 10, 10);
        const c = on ? WHITE : a(T.text, 0.85);
        if (ch === 'space') ICON.space(P, mid, y + h / 2 + 2, 30, c);
        else if (ch === 'del') ICON.back(P, mid, y + h / 2, 30, c);
        else label(P, ch, mid, y + h / 2 + (on ? 13 : 10), ch.length > 1 ? 21 : on ? 36 : 28, c, { align: 'center', font: ch.length > 1 || on ? 'bold' : 'label' });
        if (i === 25 || i === 26) P.fillRect(x + cw, y + 14, 1, h - 28, a(WHITE, 0.16));
    });
    // the results
    const y0 = 196;
    [TRACKS[0], TRACKS[4], TRACKS[5], { title: 'Aerodynamic', sub: 'Daft Punk  ·  Discovery', right: '3:32', cover: 0 }].forEach((r, i) => {
        const ry = y0 + i * M.rowH;
        P.fillRect(M.x + 8, ry + M.rowH - 1, M.w - 16, 1, a(WHITE, 0.07));
        mediaRow(P, i, Object.assign({ num: i + 1 }, r), false, ry);
    });
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(true) });
    return cv;
}
function aLogin() {
    const cv = newScreen(), P = pageOf(cv);
    const m = QR.matrix('https://link.tidal.com/ABCDE');
    const box = 404, lay = QR.layout(m.n, P.px(box));
    QR.draw(cv, m, Math.round(OX + 56 * K), Math.round(OY + 76 * K + (P.px(box) - lay.size) / 2), lay.cell);
    const x = 56 + box + 64;
    label(P, 'Sign in to TIDAL', x, 134, 50, T.text, { font: 'light' });
    label(P, '1', x, 196, 27, T.dim); label(P, 'Scan the code with your phone\'s camera', x + 40, 196, 27, T.text);
    label(P, '2', x, 240, 27, T.dim); label(P, 'Or open  link.tidal.com  and enter this code', x + 40, 240, 27, T.text);
    label(P, 'ABCDE', x + 40, 330, 64, T.text, { font: 'bold', spacing: 10 });
    label(P, 'The code is valid for 4 more minutes.', x + 40, 376, 22, T.dim);
    focusPlate(P, x + 36, 412, 420, 64, 10);
    label(P, 'New code', x + 60, 455, 30, T.text);
    chrome(cv, { tabs: ['Settings'], tab: -1, bar: TRANSPORT(false) });
    return cv;
}
function aError() {
    const cv = newScreen(), P = pageOf(cv);
    const x = 150;
    ICON.warn(P, x + 32, 156, 68, T.warn);
    label(P, 'No internet', x + 96, 176, 50, T.text, { font: 'light' });
    label(P, 'The car is not online right now. Lists you opened before still work.', x + 96, 228, 26, T.dim, { w: 1200 });
    const rows = ['Try again', 'Open the library (lists from before)'];
    rows.forEach((s, i) => {
        const y = 282 + i * M.rowH;
        if (i === 0) focusPlate(P, x + 76, y + 3, 760, M.rowH - 6, 10);
        else P.fillRect(x + 84, y + M.rowH - 1, 744, 1, a(WHITE, 0.07));
        label(P, s, x + 100, y + 46, 30, T.text);
        ICON.chevron(P, x + 76 + 760 - 28, y + M.rowH / 2, 24, i === 0 ? T.text : T.dim);
    });
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(false) });
    return cv;
}
/** a message that keeps the screen: in the caption line for a few seconds, never over a row */
function aNotice() {
    const cv = newScreen(), P = pageOf(cv);
    caption(P, null, '5 of 120', 'This track cannot be played here');
    TRACKS.forEach((r, i) => mediaRow(P, i, Object.assign({ num: i + 1, playing: i === 0 }, r), i === 4));
    scrollBar(P, 0, M.rows, 120, M.y0, M.rows * M.rowH);
    chrome(cv, { tabs: TABS, tab: 0, bar: TRANSPORT(true) });
    return cv;
}

/* ---------- option B: lists drawn by BMW's HMI (a sketch of them; screen px) ---------- */
function note(cv, s) { cv.text(s, STATUS_X + 190, 47, 20, a(WHITE, 0.5), { literal: true, align: 'right' }); }
function hmiList(title, rows, focus, scroll, twoLine) {
    const cv = newScreen();
    cv.clear('#000000');
    const x = LEFT + 40, w = SW - x - 70, h = twoLine ? 102 : 88, y0 = HEAD + 12;
    rows.forEach((r, i) => {
        const y = y0 + i * h, off = r.off;
        if (i === focus) { cv.roundRect(x - 16, y + 3, w + 32, h - 6, 6, a(FOCUS, 0.22)); cv.strokeRoundRect(x - 16, y + 3, w + 32, h - 6, 6, 3, FOCUS); }
        else cv.fillRect(x, y + h - 1, w, 1, a(WHITE, 0.16));
        const c = off ? a(WHITE, 0.34) : WHITE;
        let tx = x + 8;
        if (r.check != null) {
            cv.strokeRoundRect(x + 8, y + h / 2 - 17, 34, 34, 5, 2.5, WHITE);
            if (r.check) cv.stroke([[x + 16, y + h / 2], [x + 23, y + h / 2 + 8], [x + 35, y + h / 2 - 8]], 3.4, WHITE);
            tx += 56;
        }
        const fitTo = (s, size, maxW) => { let t = String(s); if (cv.textWidth(t, size, { literal: true }) <= maxW) return t; while (t.length > 1 && cv.textWidth(t + '...', size, { literal: true }) > maxW) t = t.slice(0, -1); return t.replace(/\s+$/, '') + '...'; };
        if (twoLine) {
            cv.text(fitTo(r.a, 36, w - 40), tx, y + 45, 36, c, { literal: true });
            cv.text(fitTo(r.b || '', 27, w - 40), tx, y + 84, 27, off ? a(WHITE, 0.26) : '#a9adb5', { literal: true });
        } else {
            cv.text(fitTo(r.a, 38, w - 40 - (r.b ? 620 : 0)), tx, y + h / 2 + 13, 38, c, { literal: true });
            if (r.b) cv.text(fitTo(r.b, 30, 600), x + w - 8, y + h / 2 + 11, 30, '#a9adb5', { literal: true, align: 'right' });
        }
    });
    if (scroll) { cv.roundRect(SW - 34, y0, 6, rows.length * h, 3, a(WHITE, 0.14)); cv.roundRect(SW - 34, y0 + scroll[0] * rows.length * h, 6, scroll[1] * rows.length * h, 3, a(WHITE, 0.7)); }
    chrome(cv, { hmiTitle: title });
    note(cv, 'Sketch: these rows are drawn by BMW\'s HMI. In the car they look like the car\'s own lists.');
    return cv;
}
function bHome() {
    return hmiList('TIDAL', [{ a: 'Favourite tracks' }, { a: 'Favourite albums' }, { a: 'Playlists' }, { a: 'Mixes' }, { a: 'Search' },
        { a: 'Now playing', b: 'One More Time - Daft Punk' }, { a: 'Skip on the steering wheel', check: true }], 0, [0, 0.8], false);
}
function bTracks() {
    return hmiList('Favourite tracks', [
        { a: 'One More Time', b: 'Playing  ·  Daft Punk  ·  5:20' },
        { a: 'Stirile de azi (editia de seara)', b: 'Ana Blandiana, Grigore Vieru  ·  4:01' },
        { a: TRACKS[2].title, b: 'Die Aerzte  ·  3:19' },
        { a: 'Not streamable here', b: 'Not available  ·  Somebody', off: true },
        { a: 'Harder, Better, Faster, Stronger', b: 'Daft Punk  ·  3:44' },
        { a: 'Digital Love', b: 'Daft Punk  ·  5:01' }], 2, [0, 0.12], true);
}
function bTracksEnd() {
    return hmiList('Favourite tracks', [
        { a: 'Track number 46', b: 'Artist 4  ·  2:52' }, { a: 'Track number 47', b: 'Artist 5  ·  3:29' }, { a: 'Track number 48', b: 'Artist 6  ·  4:06' },
        { a: 'Track number 49', b: 'Artist 7  ·  4:43' }, { a: 'Track number 50', b: 'Artist 1  ·  2:30' },
        { a: 'More tracks', b: '51 to 100 of 120' }], 5, [0.88, 0.12], true);
}

/* ---------- today's interface in the same frame (the app's own screens.js, as tools/screens.js draws it) ---------- */
function today() {
    const { Recorder, play } = require(path.join(ROOT, 'kit', 'runtime', 'record'));
    const APP = path.join(ROOT, 'apps', 'cmocan_tidal');
    const Mo = require(path.join(APP, 'model')), S = require(path.join(APP, 'screens')), L = require(path.join(APP, 'listview'));
    const items = [{ uuid: 'p1', title: 'Road trip', numberOfTracks: 42 }, { uuid: 'p2', title: 'Morning drive', numberOfTracks: 18 }, { uuid: 'p3', title: 'Liniste', numberOfTracks: 7 },
        { uuid: 'p4', title: 'Late night', numberOfTracks: 31 }, { uuid: 'p5', title: 'Workout', numberOfTracks: 25 }];
    const player = { state: 'playing', track: { id: 1, title: 'One More Time', artists: ['Daft Punk'], duration: 320 }, position: 98, duration: 320, queueIndex: 2, queueLength: 14, quality: 'HIGH', error: null, skipped: [] };
    const st = [{ type: 'status', state: { login: 'logged-in', online: true, version: '0.1.0', prefs: { quality: 'HIGH' }, player: player } },
        { type: 'cursor', sel: 2, top: 0 },                                   // the knob on "Playlists" (row 3 of the library)
        { type: 'open-list', key: 'playlists', title: 'Playlists', kind: 'playlists', source: { cmd: 'playlists', params: {} } },
        { type: 'list-loaded', key: 'playlists', offset: 0, total: items.length, items: items }].reduce((s, e) => Mo.reduce(s, e), Mo.initial());
    const r = new Recorder(1600, 520, { textScale: 1 });
    r.clear(T.bg);
    S.draw(r, T, st, { now: 100000 });
    const page = new Canvas(1600, 520);
    play(r.words(), page);
    const cv = newScreen();
    cv.drawImage(page.d, 1600, 520, OX, OY, 1600 * K, 520 * K);
    // the kit's controller mark (display.js _drawChrome) stays on the place with the key it had: "row:2"
    const y = L.Y0 + 2 * L.ROW_H, fx = OX + 40 * K, fy = OY + y * K, fw = 1500 * K, fh = L.ROW_H * K, fr = 10 * K;
    cv.roundRect(fx, fy, fw, fh, fr, a(WHITE, 0.08));
    cv.strokeRoundRect(fx - 8, fy - 8, fw + 16, fh + 16, fr + 8, 6, a(FOCUS, 0.55));
    cv.strokeRoundRect(fx - 4, fy - 4, fw + 8, fh + 8, fr + 4, 2.5, WHITE);
    chrome(cv, { tabs: ['Settings'], tab: -1, bar: ['Play / Pause', 'Next', 'Library'] });
    return cv;
}

const PICTURES = {
    'a-home': aHome, 'a-tracks': aTracks, 'a-albums': aAlbums, 'a-now-playing': aNowPlaying, 'a-search': aSearch, 'a-login': aLogin,
    'a-error': aError, 'a-notice': aNotice, 'b-home': bHome, 'b-tracks': bTracks, 'b-tracks-end': bTracksEnd, 'today-playlists': today,
};

if (require.main === module) {
    const out = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'ui-mock'));
    try { fs.mkdirSync(out); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    Object.keys(PICTURES).forEach((name) => {
        fs.writeFileSync(path.join(out, name + '.png'), PICTURES[name]().png(9));
        process.stdout.write(name + '.png\n');
    });
}

module.exports = { PICTURES: PICTURES, K: K, OX: OX, OY: OY };
