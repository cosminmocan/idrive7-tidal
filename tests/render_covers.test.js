'use strict';
/**
 * C1 (phase 2), album art drawn by the REAL renderer: the staged app's now-playing frames, with a known cover
 * (tests/golden/cover_blocks_32x32.jpg: 16 blocks of 8 x 8 pixels, each its own colour, no symmetry), are written as the byte stream the app sends to the renderer in the car (the
 * kit's file sink, MGU_RENDERD_FILE: HELLO asking for mgu-render/1, X_MODE, PLACE, the picture, FRAMEs), and
 * mgu-render itself draws that stream offscreen (`mgu-render --replay FILE --out F.pam`, Mesa's llvmpipe). The
 * cover's pixels must be in the drawn picture, where the frame puts the cover.
 *
 * Needs the renderer's binary: MGU_RENDER=<path> (`make test-render` builds it from mgu-store at a fixed commit and
 * runs this file in the renderer's own test image). Without it (in `make test`) the test skips.
 * MGU_RENDER_OUT=<dir>: the stream, the renderer's log and the picture (PNG) are kept there.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');
const G = require('./lib/staged_gpu');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { Canvas } = require('../kit/runtime/canvas');

const RENDER = process.env.MGU_RENDER;
const JPEG = fs.readFileSync(path.join(__dirname, 'golden', 'cover_blocks_32x32.jpg'));

function readPam(file) {
    const b = fs.readFileSync(file), end = b.indexOf('ENDHDR\n');
    assert.ok(end > 0, 'a PAM picture');
    const head = b.slice(0, end).toString('latin1');
    const w = Number(/WIDTH (\d+)/.exec(head)[1]), h = Number(/HEIGHT (\d+)/.exec(head)[1]);
    const d = b.slice(end + 7);
    assert.strictEqual(d.length, w * h * 4, 'RGBA, ' + w + ' x ' + h);
    return { w: w, h: h, d: d, at: (x, y) => { const i = (Math.floor(y) * w + Math.floor(x)) * 4; return [d[i], d[i + 1], d[i + 2]]; } };
}
const far = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

if (!RENDER) {
    test('the real renderer draws the cover: SKIPPED, no MGU_RENDER (run `make test-render`)', () => {});
} else {
    test('mgu-render draws the app\'s now-playing stream: the cover\'s pixels are in the picture at the cover\'s place', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-render-'));
        const keep = process.env.MGU_RENDER_OUT || tmp;
        const stream = path.join(keep, 'now-playing.bin'), pam = path.join(tmp, 'now-playing.pam');
        const svc = await G.coverService(path.join(tmp, 'service.sock'), JPEG);
        let out;
        try { out = await G.runStaged({ tmp: tmp, serviceSock: path.join(tmp, 'service.sock'), file: stream }); } finally { await svc.close(); }
        assert.deepStrictEqual(out.errors, [], 'errors logged');
        assert.strictEqual(out.covers.length, 1, 'the cover is a picture in the kit');

        // the stream: mgu-render/1 asked for, where the surface goes, and the last frame's picture
        const msgs = G.messages(fs.readFileSync(stream));
        assert.ok(msgs[0].type === 1 && msgs[0].p.toString('latin1').indexOf('cmocan_tidal\0proto=mgu-render/1') === 0, 'HELLO asks for mgu-render/1');
        const places = msgs.filter((m) => m.type === 2), frames = msgs.filter((m) => m.type === 7);
        assert.ok(places.length >= 1 && frames.length >= 1, 'PLACE and FRAME');
        const pl = places[places.length - 1].p;
        const place = { w: pl.readInt32LE(8), h: pl.readInt32LE(12), scale: pl.readFloatLE(16), ox: pl.readFloatLE(20), oy: pl.readFloatLE(24) };

        // the real renderer
        const r = childProcess.spawnSync(RENDER, ['--replay', stream, '--out', pam], {
            encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { LIBGL_ALWAYS_SOFTWARE: '1', EGL_PLATFORM: 'surfaceless' }),
        });
        const rlog = String(r.stdout) + String(r.stderr);
        if (process.env.MGU_RENDER_OUT) fs.writeFileSync(path.join(keep, 'mgu-render.log'), rlog);
        assert.strictEqual(r.status, 0, 'mgu-render --replay ended with ' + r.status + (r.error ? ' ' + r.error : '') + '\n' + rlog);
        assert.ok(/native dialect/.test(rlog), 'the renderer read the stream as mgu-render/1:\n' + rlog);
        assert.ok(!/bad message|at most|already/.test(rlog), 'nothing refused:\n' + rlog);
        const pic = readPam(pam);
        assert.deepStrictEqual({ w: pic.w, h: pic.h }, { w: place.w, h: place.h }, 'the picture is the surface');
        if (process.env.MGU_RENDER_OUT) {
            const cv = new Canvas(pic.w, pic.h);
            for (let i = 0; i < pic.d.length; i += 4) { cv.d[i] = pic.d[i]; cv.d[i + 1] = pic.d[i + 1]; cv.d[i + 2] = pic.d[i + 2]; cv.d[i + 3] = 255; }
            fs.writeFileSync(path.join(keep, 'now-playing.png'), cv.png());
        }

        // the cover's place: the page's 400 x 400 square at 60, 78 (screens.js drawNowPlaying), through the placement
        const sq = { x: 60 * place.scale + place.ox, y: 78 * place.scale + place.oy, s: 400 * place.scale };
        assert.ok(sq.s >= 300 && sq.x >= 0 && sq.y >= 0 && sq.x + sq.s <= pic.w && sq.y + sq.s <= pic.h, 'the square is on the surface: ' + JSON.stringify(sq) + ' ' + JSON.stringify(place));

        // the cover: each of the JPEG's 32 x 32 pixels is a block of the square; its middle must have that colour
        const img = decodeJpeg(JPEG, { formatAsRGBA: true });
        assert.deepStrictEqual({ w: img.width, h: img.height }, { w: 32, h: 32 });
        const colours = {};
        let bad = 0, worst = 0, first = null;
        for (let j = 0; j < 32; j++) {
            for (let i = 0; i < 32; i++) {
                const want = [img.data[(j * 32 + i) * 4], img.data[(j * 32 + i) * 4 + 1], img.data[(j * 32 + i) * 4 + 2]];
                colours[want.map((v) => v >> 4).join(',')] = true;
                const got = pic.at(sq.x + (i + 0.5) * sq.s / 32, sq.y + (j + 0.5) * sq.s / 32);
                const d = far(want, got);
                worst = Math.max(worst, d);
                if (d > 8) { bad++; if (!first) first = 'block ' + i + ',' + j + ': the cover has ' + want + ', the picture ' + got; }
            }
        }
        assert.ok(Object.keys(colours).length >= 16, 'the test cover has many colours (a flat one would prove little): ' + Object.keys(colours).length);
        assert.strictEqual(bad, 0, bad + ' of 1024 blocks of the cover are not in the picture; ' + first);
        // and it ends where the square ends: just outside is the page, not the cover's edge colours going on
        const edge = [img.data[16 * 32 * 4], img.data[16 * 32 * 4 + 1], img.data[16 * 32 * 4 + 2]];
        assert.ok(far(edge, pic.at(sq.x - 12, sq.y + 16.5 * sq.s / 32)) > 8, 'left of the square is the page, not the cover');
        console.log('       mgu-render: ' + (/(\d+) frames.*$/m.exec(rlog) || [''])[0].replace(/ -> .*/, '') + '; worst block off by ' + worst);
    }, { timeout: 180000 });
}

run();
