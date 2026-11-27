'use strict';
/**
 * C1 (phase 2), album art on the GPU path: the car's renderer is mgu-render, and the app talks to it in its own
 * dialect (mgu-render/1: touch and the controller on one connection). There a picture is uploaded with message 10
 * (IMAGE: id, w, h, premultiplied RGBA) and drawn with op 18 as `x y w h r id`; the other ("upstream") dialect
 * uploads with message 9 and draws op 18 as `id ver x y w h` (mgu-store native/mgu-render/PROTOCOL.md). In the car
 * the kit uploaded nothing in mgu-render/1 and logged `renderd: pixel images need the upstream dialect`
 * (docs/car-log.md, row 7).
 *
 * Here: the staged app on the kit's stubbed head unit (tests/lib/staged_gpu.js) with a stand-in renderer on a unix
 * socket that answers as mgu-render/1, and the kit's RenderClient alone against both kinds of renderer. The real
 * renderer draws the same stream in `make test-render` (tests/render_covers.test.js).
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const G = require('./lib/staged_gpu');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { scale } = require('../apps/cmocan_tidal/covers');
const rec = require('../kit/runtime/record');
const { RenderClient } = require('../kit/runtime/renderd');

const JPEG = fs.readFileSync(path.join(__dirname, 'golden', 'cover_blocks_32x32.jpg'));
const M = { HELLO: 1, PLACE: 2, SHOW: 3, FRAME: 7, M9: 9, M10: 10, READY: 101, TICK: 102 };
const X = { MODE: 0x4d520001, GRAB: 0x4d520002, READY: 0x4d520101, STATE: 0x4d520102 };
const WARNING = /pixel images need the upstream dialect/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + what);
}
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-gpu-')); }
function u32(type, arr) {
    const b = Buffer.alloc(8 + arr.length * 4);
    b.writeUInt32LE(type, 0); b.writeUInt32LE(arr.length * 4, 4);
    arr.forEach((v, i) => b.writeInt32LE(v | 0, 8 + i * 4));
    return b;
}

/**
 * A renderer on a unix socket. native: as mgu-render (X_READY with its caps, then READY, to a HELLO that asks for
 * mgu-render/1; X_STATE "on screen, in front" once shown); else as an older renderer: READY alone. A TICK for
 * every FRAME. r.msgs: every message that came, in order.
 */
function standIn(sockPath, native) {
    const r = { msgs: [], hello: null };
    const conns = [];
    const server = net.createServer((c) => {
        conns.push(c);
        let buf = Buffer.alloc(0), frames = 0, isNative = false;
        c.on('error', () => {});
        c.on('data', (d) => {
            buf = Buffer.concat([buf, d]);
            const ms = G.messages(buf);
            ms.forEach((m) => {
                buf = buf.slice(8 + m.p.length);
                r.msgs.push({ type: m.type, p: Buffer.from(m.p) });
                if (m.type === M.HELLO) {
                    r.hello = m.p.toString('latin1');
                    isNative = native && r.hello.indexOf('\0proto=mgu-render/1') > 0;
                    // version 1, modes: layer, caps: touch, controller, front gate, pixmaps; no embed box, no app
                    // area; the largest pixmap side, 60 Hz
                    if (isNative) c.write(u32(X.READY, [1, 1, 1 | 2 | 4 | 8, 0, 0, 0, 0, 0, 0, 0, 0, 2048, 60000]));
                    c.write(u32(M.READY, [4, 1920, 720, 1]));
                } else if (m.type === M.SHOW && isNative && m.p.readUInt32LE(0)) c.write(u32(X.STATE, [1, 1, 1]));
                else if (m.type === M.FRAME) c.write(u32(M.TICK, [++frames, frames * 16]));
            });
        });
    });
    r.close = () => new Promise((resolve) => { conns.forEach((c) => c.destroy()); server.close(() => { try { fs.unlinkSync(sockPath); } catch (e) { /* gone */ } resolve(); }); });
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(sockPath, () => resolve(r)); });
}

/** the pictures in a stream: message `type` with id, w, h and exactly w x h x 4 bytes */
function pictures(msgs, type) {
    return msgs.filter((m) => m.type === type && m.p.length >= 12 && m.p.length === 12 + m.p.readUInt32LE(4) * m.p.readUInt32LE(8) * 4)
        .map((m) => ({ id: m.p.readUInt32LE(0), w: m.p.readUInt32LE(4), h: m.p.readUInt32LE(8), px: m.p.slice(12), at: msgs.indexOf(m) }));
}
const frames = (msgs) => msgs.filter((m) => m.type === M.FRAME);

test('the app on mgu-render/1: the cover is uploaded as a picture (message 10) and the now-playing frame draws it', async () => {
    const tmp = tmpDir();
    const svc = await G.coverService(path.join(tmp, 'service.sock'), JPEG);
    const rd = await standIn(path.join(tmp, 'render.sock'), true);
    try {
        const out = await G.runStaged({ tmp: tmp, serviceSock: path.join(tmp, 'service.sock'), rendererSock: path.join(tmp, 'render.sock') });
        assert.deepStrictEqual(out.errors, [], 'errors logged');
        assert.ok(svc.requests.some((q) => q.cmd === 'cover'), 'the cover was asked for');
        assert.strictEqual(out.covers.length, 1, 'the cover is a picture in the kit: ' + JSON.stringify(out.covers));
        assert.ok(out.logs.some((l) => /renderd: connected.*mgu-render\/1/.test(l)), 'the connection is mgu-render/1:\n' + out.logs.join('\n'));
        assert.ok(rd.hello.indexOf('cmocan_tidal\0proto=mgu-render/1') === 0, 'HELLO asks for mgu-render/1');
        assert.deepStrictEqual(out.logs.filter((l) => WARNING.test(l)), [], 'the warning seen in the car');

        // the upload: the service's JPEG, decoded and scaled to the cover's 400 x 400 as covers.js does, opaque
        const ups = pictures(rd.msgs, M.M10);
        assert.ok(ups.length >= 1, 'a picture upload (message 10) came; messages: ' + rd.msgs.map((m) => m.type).join(' '));
        const up = ups[ups.length - 1];
        assert.deepStrictEqual({ id: up.id, w: up.w, h: up.h }, { id: out.covers[0].id, w: 400, h: 400 });
        const img = decodeJpeg(JPEG, { formatAsRGBA: true });
        assert.ok(Buffer.from(scale(img.data, img.width, img.height, 400)).equals(up.px), 'the uploaded pixels are the cover\'s');
        assert.strictEqual(ups.length, 1, 'uploaded once, not with every frame');
        // nothing in the other dialect's form: there message 9 is the picture, here it is the touch claims
        assert.deepStrictEqual(pictures(rd.msgs, M.M9), []);

        // the frame: op 18 in mgu-render/1's form (x y w h r id), the cover's square on the left of the page
        const later = frames(rd.msgs.slice(up.at));
        assert.ok(later.length >= 1, 'a frame after the upload');
        const ops = G.imageOps(later[later.length - 1].p, 'native');
        assert.deepStrictEqual(ops, [{ x: 60, y: 78, w: 400, h: 400, r: 0, id: up.id }]);
        // every frame parses as draw ops, and none draws a picture before it was uploaded
        frames(rd.msgs.slice(0, up.at)).forEach((f) => assert.deepStrictEqual(G.imageOps(f.p, 'native'), []));

        // touch and the controller as before: still mgu-render/1's own messages on this connection
        assert.ok(rd.msgs.some((m) => m.type === X.MODE), 'X_MODE');
        assert.ok(rd.msgs.some((m) => m.type === X.GRAB && m.p.readUInt32LE(0) === 1), 'the controller is asked for (X_GRAB)');
        assert.ok(rd.msgs.some((m) => m.type === M.M9 && m.p.length === 4 + m.p.readUInt32LE(0) * 16 && m.p.readUInt32LE(0) >= 1), 'touch areas are claimed (CLAIM)');
    } finally { await rd.close(); await svc.close(); }
}, { timeout: 40000 });

/* ---- the kit's RenderClient alone: both dialects, and what it must not touch ---- */

function picture(id, w, h) {
    const d = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { d[i * 4] = i & 255; d[i * 4 + 1] = 200; d[i * 4 + 2] = (i >> 8) & 255; d[i * 4 + 3] = 255; }
    return rec.setImage(id, w, h, d);
}
async function client(sockPath, opts) {
    const logs = [];
    const log = { info(m) { logs.push('info ' + m); }, warn(m) { logs.push('warn ' + m); }, error(m) { logs.push('error ' + m); } };
    const gpu = new RenderClient('test_app', log, Object.assign({ socket: sockPath }, opts));
    gpu.connect();
    await waitFor(() => gpu.ready, 3000, 'READY');
    gpu.place({ x: 0, y: 0, w: 1920, h: 720, scale: 1, ox: 0, oy: 0 });
    return { gpu: gpu, logs: logs };
}
function drawing(id) {
    const r = new rec.Recorder(1600, 520);
    r.clear('#000000').fillRect(10, 10, 20, 20, '#ff0000');
    r.image(id, 100, 50, 64, 48);
    r.fillRect(40, 40, 5, 5, '#00ff00');
    return r;
}

test('RenderClient on mgu-render/1: message 10 and op 18 as x y w h r id; the recording itself stays as it was', async () => {
    const tmp = tmpDir(), sock = path.join(tmp, 'r.sock');
    const rd = await standIn(sock, true);
    const { gpu, logs } = await client(sock, { native: true });
    try {
        assert.strictEqual(gpu.native, true);
        const im = picture(901, 8, 6), r = drawing(901);
        const before = Buffer.from(Buffer.from(r.words().buffer, r.words().byteOffset, r.words().byteLength));
        assert.ok(gpu.frame(r) !== false);
        await waitFor(() => frames(rd.msgs).length === 1, 3000, 'the frame');
        const ups = pictures(rd.msgs, M.M10);
        assert.strictEqual(ups.length, 1, 'messages: ' + rd.msgs.map((m) => m.type).join(' '));
        assert.deepStrictEqual({ id: ups[0].id, w: ups[0].w, h: ups[0].h }, { id: 901, w: 8, h: 6 });
        assert.ok(Buffer.from(im.data).equals(ups[0].px));
        assert.deepStrictEqual(pictures(rd.msgs, M.M9), []);
        const f = frames(rd.msgs)[0];
        assert.ok(ups[0].at < rd.msgs.indexOf(f), 'the picture comes before the frame that draws it');
        assert.deepStrictEqual(G.imageOps(f.p, 'native'), [{ x: 100, y: 50, w: 64, h: 48, r: 0, id: 901 }]);
        assert.strictEqual(f.p.length, before.length, 'the same number of words');
        // the recorder's own words are the software path's (record.js play) and display.js's "same frame?" check
        assert.ok(Buffer.from(r.words().buffer, r.words().byteOffset, r.words().byteLength).equals(before), 'the recording was not rewritten');
        assert.deepStrictEqual(G.imageOps(before, 'upstream'), [{ id: 901, ver: im.ver, x: 100, y: 50, w: 64, h: 48 }]);

        // the same picture again: no second upload; a new version of it: uploaded again
        gpu.frame(r);
        await waitFor(() => frames(rd.msgs).length === 2, 3000, 'the second frame');
        assert.strictEqual(pictures(rd.msgs, M.M10).length, 1);
        picture(901, 8, 6);
        gpu.frame(drawing(901));
        await waitFor(() => frames(rd.msgs).length === 3, 3000, 'the third frame');
        assert.strictEqual(pictures(rd.msgs, M.M10).length, 2);
        assert.deepStrictEqual(logs.filter((l) => /^warn/.test(l)), []);
    } finally { gpu.close(); await rd.close(); }
});

test('RenderClient on mgu-render/1: a picture wider than 1024 is not sent (message 10 takes 1..1024) and is said once', async () => {
    const tmp = tmpDir(), sock = path.join(tmp, 'r.sock');
    const rd = await standIn(sock, true);
    const { gpu, logs } = await client(sock, { native: true });
    try {
        picture(903, 1025, 2);
        gpu.frame(drawing(903)); gpu.frame(drawing(903));
        await waitFor(() => frames(rd.msgs).length === 2, 3000, 'the frames');
        assert.deepStrictEqual(pictures(rd.msgs, M.M10), []);
        assert.strictEqual(logs.filter((l) => /^warn renderd: .*1025/.test(l)).length, 1, logs.join('\n'));
    } finally { gpu.close(); await rd.close(); }
});

['an app that asks for the upstream dialect', 'mgu-render/1 asked for, an older renderer answers READY alone'].forEach((name, k) => {
    test('RenderClient, upstream dialect unchanged (' + name + '): message 9 and op 18 as id ver x y w h', async () => {
        const tmp = tmpDir(), sock = path.join(tmp, 'r.sock');
        const rd = await standIn(sock, false);
        const { gpu, logs } = await client(sock, k ? { native: true } : {});
        try {
            assert.strictEqual(gpu.native, false);
            const im = picture(904, 8, 6), r = drawing(904);
            const before = Buffer.from(Buffer.from(r.words().buffer, r.words().byteOffset, r.words().byteLength));
            gpu.frame(r);
            await waitFor(() => frames(rd.msgs).length === 1, 3000, 'the frame');
            const ups = pictures(rd.msgs, M.M9);
            assert.strictEqual(ups.length, 1);
            assert.deepStrictEqual({ id: ups[0].id, w: ups[0].w, h: ups[0].h }, { id: 904, w: 8, h: 6 });
            assert.ok(Buffer.from(im.data).equals(ups[0].px));
            assert.deepStrictEqual(pictures(rd.msgs, M.M10), []);
            assert.ok(frames(rd.msgs)[0].p.equals(before), 'the frame is the recording, word for word');
            assert.deepStrictEqual(logs.filter((l) => /^warn/.test(l)), []);
        } finally { gpu.close(); await rd.close(); }
    });
});

run();
