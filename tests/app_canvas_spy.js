'use strict';
/**
 * app_canvas_spy.js - a drawing surface for the app's tests (not a test itself): it has the methods the app's
 * screens call on the kit's canvas, and keeps what was drawn so a test can ask what is on the screen.
 * Text widths are a fixed 0.5 x size per character, so clipping is predictable.
 */
function spyCanvas(w, h) {
    const cv = {
        w: w || 1600, h: h || 520, texts: [], rects: [], targets: [], images: [], calls: 0,
        clear() { cv.calls++; return cv; },
        text(s, x, y, size, color, opts) { cv.calls++; cv.texts.push({ s: String(s), x, y, size, color, opts: opts || {} }); return String(s).length * size * 0.5; },
        textWidth(s, size) { return String(s).length * size * 0.5; },
        fillRect(x, y, w2, h2, c) { cv.calls++; cv.rects.push({ x, y, w: w2, h: h2, c }); return cv; },
        roundRect(x, y, w2, h2, r, c) { cv.calls++; cv.rects.push({ x, y, w: w2, h: h2, c, r }); return cv; },
        strokeRoundRect() { cv.calls++; return cv; },
        gradientRect() { cv.calls++; return cv; },
        circle() { cv.calls++; return cv; },
        arc() { cv.calls++; return cv; },
        line() { cv.calls++; return cv; },
        quad() { cv.calls++; return cv; },
        polyline() { cv.calls++; return cv; },
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
