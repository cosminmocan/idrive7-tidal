'use strict';
/**
 * D8: picture tests of every screen. tools/screens.js draws every screen in every state from fixed data, the way the
 * car's software path does (the kit's recorder played into its canvas); each picture must equal the approved one in
 * tests/golden/screen-<name>.png. A difference fails and writes the new picture beside the approved one as
 * screen-<name>.new.png (or, when the repository is mounted read-only as in `make test`, into the temp folder
 * named in the failure) for review; `node tools/screens.js --golden` makes the new ones the approved ones.
 * A tiny tolerance absorbs floating point differences between Node versions at antialiased edges.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { test, run } = require('./lib/t');
const M = require('../apps/cmocan_tidal/model');
const screens = require('../tools/screens');

const GOLDEN = path.join(__dirname, 'golden');
const MAX_BAD = 0.002;          // share of pixels allowed to differ (antialiasing between Node versions)
const CHANNEL = 24;             // a pixel differs when a channel is off by more than this

/** the kit's own PNGs: 8-bit RGBA, filter 0 on every row (kit/runtime/canvas.js png()) */
function readPng(buf) {
    assert.strictEqual(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG');
    let p = 8, w = 0, h = 0;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p), type = buf.slice(p + 4, p + 8).toString('ascii'), body = buf.slice(p + 8, p + 8 + len);
        if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); assert.strictEqual(body[8], 8); assert.strictEqual(body[9], 6); }
        if (type === 'IDAT') idat.push(body);
        p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4 + 1, px = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        assert.strictEqual(raw[y * stride], 0, 'filter 0');
        raw.copy(px, y * w * 4, y * stride + 1, (y + 1) * stride);
    }
    return { w, h, px };
}
function writeNew(name, png) {
    const beside = path.join(GOLDEN, 'screen-' + name + '.new.png');
    try { fs.writeFileSync(beside, png); return beside; } catch (e) { /* read-only: the temp folder */ }
    const dir = path.join(os.tmpdir(), 'cmocan-screens');
    try { fs.mkdirSync(dir); } catch (e) { /* there */ }
    const f = path.join(dir, 'screen-' + name + '.new.png');
    fs.writeFileSync(f, png);
    return f;
}

const cases = screens.cases();

test('every screen of the model has pictures, every case a unique name', () => {
    const shown = {};
    cases.forEach((c) => { shown[c.state.screen] = true; });
    M.SCREENS.forEach((sc) => assert.ok(shown[sc], 'no picture of ' + sc));
    const names = cases.map((c) => c.name);
    assert.strictEqual(new Set(names).size, names.length);
    assert.ok(cases.length >= 25, cases.length + ' cases');
});

cases.forEach((c) => {
    test('screen ' + c.name + ' equals the approved picture', () => {
        const cv = screens.render(c);
        const file = path.join(GOLDEN, 'screen-' + c.name + '.png');
        if (!fs.existsSync(file)) {
            const at = writeNew(c.name, cv.png());
            assert.fail('no approved picture ' + path.relative(process.cwd(), file) + ': the new one is ' + at);
        }
        const g = readPng(fs.readFileSync(file));
        assert.deepStrictEqual([g.w, g.h], [cv.w, cv.h], 'size');
        let bad = 0;
        const a = g.px, b = cv.d;
        for (let i = 0; i < a.length; i += 4) {
            if (Math.abs(a[i] - b[i]) > CHANNEL || Math.abs(a[i + 1] - b[i + 1]) > CHANNEL || Math.abs(a[i + 2] - b[i + 2]) > CHANNEL || Math.abs(a[i + 3] - b[i + 3]) > CHANNEL) bad++;
        }
        if (bad > MAX_BAD * cv.w * cv.h) {
            const at = writeNew(c.name, cv.png());
            assert.fail(bad + ' pixels differ from ' + path.relative(process.cwd(), file) + ': the new picture is ' + at);
        }
    });
});

run();
