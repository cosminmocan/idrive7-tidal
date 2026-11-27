'use strict';
/**
 * qr.js - the login link as a QR code: the matrix (Kazuhiko Arase's generator, qrcode.js, MIT, error correction M),
 * where it goes (a quiet border of 4 cells, cells of at least 6 px) and drawing it in black on white.
 *
 *   const m = matrix(url)            // { n, dark(r, c) } or null (nothing to encode, or too long for a QR code)
 *   const l = layout(m.n, 400)       // { cell, quiet: 4, size }: the whole square, border included, in px
 *   draw(cv, m, x, y, l.cell)        // the square with its top left corner at x, y
 * Node 8.9.4 syntax.
 */
const qrcode = require('./qrcode');

const QUIET = 4, MIN_CELL = 6;

function matrix(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
        const q = qrcode(0, 'M');
        q.addData(text);
        q.make();
        const n = q.getModuleCount(), rows = [];
        for (let r = 0; r < n; r++) { const row = []; for (let c = 0; c < n; c++) row.push(q.isDark(r, c)); rows.push(row); }
        return { n: n, dark: (r, c) => !!(rows[r] && rows[r][c]) };
    } catch (e) {
        return null;
    }
}

/** the biggest whole cell that fits `box` px with the border, but never under 6 px */
function layout(n, box) {
    const cell = Math.max(MIN_CELL, Math.floor(box / (n + 2 * QUIET)));
    return { cell: cell, quiet: QUIET, size: cell * (n + 2 * QUIET) };
}

function draw(cv, m, x, y, cell) {
    const size = cell * (m.n + 2 * QUIET), o = QUIET * cell;
    cv.fillRect(x, y, size, size, '#ffffff');
    // one rectangle per run of dark modules in a row
    for (let r = 0; r < m.n; r++) {
        let c = 0;
        while (c < m.n) {
            if (!m.dark(r, c)) { c++; continue; }
            const c0 = c;
            while (c < m.n && m.dark(r, c)) c++;
            cv.fillRect(x + o + c0 * cell, y + o + r * cell, (c - c0) * cell, cell, '#000000');
        }
    }
    return size;
}

module.exports = { matrix: matrix, layout: layout, draw: draw, QUIET: QUIET, MIN_CELL: MIN_CELL };
