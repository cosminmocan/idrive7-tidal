'use strict';
/**
 * app_canvas_spy.js - a drawing surface for the app's tests (not a test itself): it has the methods the app's
 * screens call on the kit's canvas, and keeps what was drawn so a test can ask what is on the screen.
 * Text widths are a fixed 0.5 x size per character, so clipping is predictable.
 *   texts, rects (fills), strokes (strokeRoundRect), images, targets: what was drawn;
 *   colors: [{ op, c }] every colour any call used
 */
function spyCanvas(w, h) {
    const used = (op, c) => { cv.colors.push({ op: op, c: c }); };
    const cv = {
        w: w || 1600, h: h || 520, texts: [], rects: [], strokes: [], targets: [], images: [], colors: [], calls: 0,
        clear(c) { cv.calls++; if (c) used('clear', c); return cv; },
        text(s, x, y, size, color, opts) { cv.calls++; used('text', color); cv.texts.push({ s: String(s), x, y, size, color, opts: opts || {} }); return String(s).length * size * 0.5; },
        textWidth(s, size) { return String(s).length * size * 0.5; },
        fillRect(x, y, w2, h2, c) { cv.calls++; used('fillRect', c); cv.rects.push({ x, y, w: w2, h: h2, c }); return cv; },
        roundRect(x, y, w2, h2, r, c) { cv.calls++; used('roundRect', c); cv.rects.push({ x, y, w: w2, h: h2, c, r }); return cv; },
        strokeRoundRect(x, y, w2, h2, r, lw, c) { cv.calls++; used('strokeRoundRect', c); cv.strokes.push({ x, y, w: w2, h: h2, r, lw, c }); return cv; },
        gradientRect() { cv.calls++; return cv; },
        circle(x, y, r, c) { cv.calls++; used('circle', c); return cv; },
        arc(x, y, r0, r1, a0, a1, c) { cv.calls++; used('arc', c); return cv; },
        line(xa, ya, xb, yb, lw, c) { cv.calls++; used('line', c); return cv; },
        quad(pts, c) { cv.calls++; used('quad', c); return cv; },
        polyline(pts, lw, c) { cv.calls++; used('polyline', c); return cv; },
        stroke(pts, lw, c) { cv.calls++; used('stroke', c); return cv; },
        fill(pts, c) { cv.calls++; used('fill', c); return cv; },
        clip() { return cv; },
        noclip() { return cv; },
        alpha() { return cv; },
        image(id, x, y, w2, h2) { cv.calls++; cv.images.push({ id, x, y, w: w2, h: h2 }); return cv; },
        target(x, y, w2, h2, run, key) { cv.targets.push({ x, y, w: w2, h: h2, run, key }); return cv; },
        /** every text drawn, joined */
        all() { return cv.texts.map((t) => t.s).join('\n'); },
        has(re) { return cv.texts.some((t) => (re instanceof RegExp ? re.test(t.s) : t.s.indexOf(re) >= 0)); },
    };
    return cv;
}

module.exports = { spyCanvas };
