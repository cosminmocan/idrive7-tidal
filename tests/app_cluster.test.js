'use strict';
/**
 * K5: apps/cmocan_tidal/cluster.js, the playing track on the instrument cluster: a card (cover, title, artist) over
 * the cluster's media widget, drawn through cluster-render (robertnisipeanu/idrive-apps) with its Node client.
 * A stand-in cluster-render socket speaks its protocol here (PROTOCOL.md: u32 length | u8 type | body; 'J' a JSON
 * object, 'F' a frame). First the module by itself, then through tidal.js (the hook) with the fake service and a
 * fake audio manager. The renderer misbehaving (garbage, closing, never reading) must never reach the app (R1).
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const parkedKit = require('../kit/runtime/parked');
const { Canvas } = require('../kit/runtime/canvas');
const { createFakeService, TRACK } = require('./fakes/fake_service');

const APP = path.join(__dirname, '..', 'apps', 'cmocan_tidal');
const need = (name) => require(path.join(APP, name));   // at the test's time: a missing module fails its test only

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock(tag) { return path.join(os.tmpdir(), 'cmocan-' + (tag || 'cr') + '-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(15); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}

// nothing may escape: an exception in a socket handler or a rejected promise nobody took would end the app in the car
const escaped = [];
process.on('uncaughtException', (e) => { escaped.push('uncaught: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { escaped.push('unhandled: ' + (e && e.stack || e)); });

/* ---------- the stand-in cluster-render ---------- */
function msg(type, body) {
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = type;
    body.copy(m, 5);
    return m;
}
const json = (o) => msg(0x4a, Buffer.from(JSON.stringify(o), 'utf8'));
const HELLO = { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' };

/**
 * mode 'ok': answers the hello, says `waiting` for a new layer and `shown` once it has pixels and is visible;
 * 'garbage': answers every connection with what a broken renderer could send; 'close': hangs up at once;
 * 'stall': accepts and never reads or answers.
 * r.ops: every JSON message; r.frames: every frame { ref, rects, px }; r.all: both in order ({ op } | { frame })
 */
function createRenderer(sockPath, mode) {
    const r = { ops: [], frames: [], all: [], conns: [], open: 0, accepted: 0, mode: mode || 'ok' };
    try { fs.unlinkSync(sockPath); } catch (e) { /* none there */ }
    // what the client reads over (every connection gets all of it), and what makes it hang up (one per connection)
    const SOFT = [
        json(null), json([1, 2]), json(7), json('layer'), json({ ev: null }), json({ ev: 'layer' }), json({ ev: 'layer', ref: {}, state: [] }),
        json({ ev: 'target', target: 'panel' }), json({ ev: 'error' }), json({ ev: 'hello', targets: 5, backend: null }), json({ ev: 'host' }),
        json({ ev: 'fps_cap', fps: 'x' }), json({ ev: 'status' }), json({ ev: 'hosting' }), json({ ev: 'budget' }),
        msg(0x4a, Buffer.from('{"ev":"layer","ref":', 'utf8')), msg(0x4a, Buffer.from([0xff, 0xfe, 0x00, 0x7b])), msg(0x51, Buffer.alloc(40, 0x41)),
        msg(0x46, Buffer.alloc(3)), json({ ev: 'layer', ref: 1, state: 'x'.repeat(200000) }), json({ ev: 'layer', ref: 1, state: 'shown' }),
        json({ ev: 'error', op: 'set', ref: 1, reason: 'no' }),
    ];
    const HARD = [
        Buffer.from([0, 0, 0, 0, 0x4a]),                       // a length of 0
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x4a, 1, 2, 3]),  // a length of 4 GiB
        Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n', 'utf8'),
        Buffer.from([0x20, 0, 0, 0, 0x4a, 0x7b]),              // half a message, then the end
        json({ ev: 'error', op: 'layer', ref: 1, reason: 'no' }),
    ];
    const server = net.createServer((conn) => {
        r.conns.push(conn); r.open++; r.accepted++;
        conn.on('error', () => {});
        conn.on('close', () => { r.open--; });
        if (r.mode === 'close') { conn.destroy(); return; }
        if (r.mode === 'stall') { conn.pause(); return; }
        if (r.mode === 'garbage') {
            conn.on('data', () => {});
            if (r.accepted % 2) conn.write(json(HELLO));       // with and without a hello first
            SOFT.forEach((g) => conn.write(g));
            conn.write(HARD[(r.accepted - 1) % HARD.length]);
            setTimeout(() => conn.destroy(), 80);
            return;
        }
        let buf = Buffer.alloc(0);
        const layers = {};
        const tell = (ref) => {
            const l = layers[ref];
            if (!l) return;
            const st = !l.visible ? 'hidden' : l.frames ? 'shown' : 'stalled';
            if (st !== l.state) { l.state = st; conn.write(json({ ev: 'layer', ref: ref, state: st, reason: '' })); }
        };
        conn.on('data', (d) => {
            buf = buf.length ? Buffer.concat([buf, d]) : d;
            let off = 0;
            while (buf.length - off >= 5) {
                const len = buf.readUInt32LE(off);
                if (buf.length - off < 4 + len) break;
                const type = buf[off + 4], body = buf.slice(off + 5, off + 4 + len);
                off += 4 + len;
                if (type === 0x4a) {
                    const o = JSON.parse(body.toString('utf8'));
                    r.ops.push(o); r.all.push({ op: o });
                    if (o.op === 'hello') conn.write(json(HELLO));
                    else if (o.op === 'layer') { layers[o.ref] = { visible: o.visible !== 0, frames: 0, state: null }; tell(o.ref); }
                    else if (o.op === 'set' && layers[o.ref]) { if (o.visible !== undefined) layers[o.ref].visible = o.visible !== 0; tell(o.ref); }
                    else if (o.op === 'drop') delete layers[o.ref];
                } else if (type === 0x46) {
                    const n = body.readUInt16LE(12);
                    const f = { ref: body.readUInt32LE(0), rects: n, px: Buffer.from(body.slice(14 + n * 8)) };
                    r.frames.push(f); r.all.push({ frame: f });
                    if (layers[f.ref]) { layers[f.ref].frames++; tell(f.ref); }
                }
            }
            buf = buf.slice(off);
        });
    });
    r.of = (op) => r.ops.filter((o) => o.op === op);
    r.close = () => new Promise((res) => { r.conns.forEach((c) => c.destroy()); server.close(() => res()); });
    return new Promise((res) => server.listen(sockPath, () => res(r)));
}

/* ---------- the module by itself ---------- */
const playing = (track, state) => ({ state: state || 'playing', track: track === undefined ? TRACK : track, position: 1, duration: 320, queueIndex: 0, queueLength: 1, quality: 'HIGH', error: null });
const SPEAKERS = { on: true, connected: true, error: null, taken: false, yieldedTo: null, lost: false, held: false };
const RED = [200, 30, 40];

/** the card with its surroundings as values a test changes: w.player, w.speakers, w.on, w.stopped; w.hold: the
 *  cover's answer waits until it is false again */
function card(sockPath, extra) {
    const w = { player: playing(), speakers: Object.assign({}, SPEAKERS), on: true, stopped: false, logs: [], asked: [], cover: 'ok', hold: false };
    const log = { info: (m) => w.logs.push('info ' + m), warn: (m) => w.logs.push('warn ' + m), debug() {}, error: (m) => w.logs.push('error ' + m) };
    w.cluster = need('cluster').createCluster(Object.assign({
        log: log, Canvas: Canvas, socketPath: sockPath, tickMs: 20,
        enabled: () => w.on, player: () => w.player, speakers: () => w.speakers, stopped: () => w.stopped,
        request: (cmd, p) => { w.asked.push(p.coverId); return waitFor(() => !w.hold, 15000, 'the cover let go').then(() => w.cover === 'ok' ? { ok: true, mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') } : { ok: false, error: 'not-found' }); },
        decode: () => { const d = new Uint8Array(8 * 8 * 4); for (let i = 0; i < 64; i++) { d[i * 4] = RED[0]; d[i * 4 + 1] = RED[1]; d[i * 4 + 2] = RED[2]; d[i * 4 + 3] = 255; } return { width: 8, height: 8, data: d }; },
    }, extra || {}));
    w.end = async () => { w.stopped = true; await sleep(60); w.cluster.close(); };
    return w;
}
const pxAt = (px, w, x, y) => [px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2], px[(y * w + x) * 4 + 3]];
/** a kit canvas that also keeps the texts drawn on it */
function textCanvas() {
    const texts = [];
    class T extends Canvas { text(s, x, y, size, c, o) { texts.push(String(s)); return super.text(s, x, y, size, c, o); } }
    return { Canvas: T, texts: texts };
}

test('the place is a table: TVH Player\'s for the G-series cluster, inside the panel', () => {
    const C = need('cluster');
    assert.deepStrictEqual(C.PLACE.card, { x: 1130, y: 140, w: 520, h: 420 }, 'TVH Player\'s card, over the right dial\'s media widget');
    assert.ok(C.PLACE.card.x + C.PLACE.card.w <= 1920 && C.PLACE.card.y + C.PLACE.card.h <= 720, 'inside the 1920x720 panel');
    ['cover', 'title', 'artist'].forEach((k) => assert.ok(C.PLACE[k] && typeof C.PLACE[k] === 'object', 'PLACE.' + k));
    assert.ok(C.PLACE.cover.y + C.PLACE.cover.size < C.PLACE.title.y && C.PLACE.title.y < C.PLACE.artist.y && C.PLACE.artist.y < C.PLACE.card.h, 'cover, title, artist from the top down');
});

test('the card for a track: one image layer on the panel over the gauges, its pixels, then shown', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    w.hold = true;
    try {
        await waitFor(() => r.of('set').some((o) => o.visible === 1) && r.frames.length >= 1, 4000, 'the card shown');
        await waitFor(() => w.cluster.state().state === 'shown', 2000, 'the renderer\'s "shown" taken');
        await sleep(100);
        assert.strictEqual(r.frames.length, 1, 'drawn once while it waits for the cover');
        w.hold = false;
        await waitFor(() => r.frames.length === 2, 4000, 'drawn again with the cover');
        assert.deepStrictEqual(r.ops[0], { op: 'hello', app: 'cmocan_tidal', proto: 1 });
        const layers = r.of('layer');
        assert.strictEqual(layers.length, 1, 'one layer');
        const L = layers[0];
        assert.strictEqual(L.kind, 'image');
        assert.strictEqual(L.target, 'panel');
        assert.strictEqual(L.class, 'overlay', 'over the gauges, never the alert class');
        assert.deepStrictEqual([L.x, L.y, L.w, L.h, L.iw, L.ih], [1130, 140, 520, 420, 520, 420]);
        assert.strictEqual(L.visible, 0, 'made hidden: shown only once it has pixels');
        assert.ok(!L.exclusive && !L.contend, 'it hides nothing below it and takes nothing from the car');
        // layer, then pixels, then visible
        const order = r.all.map((x) => (x.frame ? 'frame' : x.op.op + (x.op.op === 'set' ? ':' + x.op.visible : '')));
        assert.ok(order.indexOf('layer') < order.indexOf('frame') && order.indexOf('frame') < order.indexOf('set:1'), order.join(' '));
        r.frames.forEach((f) => { assert.strictEqual(f.ref, L.ref); assert.strictEqual(f.rects, 0, 'the whole card'); assert.strictEqual(f.px.length, 520 * 420 * 4); });
        // what is on it: the first frame without the cover, the last with it
        const C = need('cluster');
        const info = { title: TRACK.title, artist: 'Daft Punk', cover: null };
        assert.ok(Buffer.from(C.render(info, Canvas).d).equals(r.frames[0].px), 'the first frame is the card for this track');
        const last = r.frames[r.frames.length - 1].px, cv = C.PLACE.cover;
        assert.deepStrictEqual(pxAt(last, 520, 260, cv.y + Math.round(cv.size / 2)), RED.concat(255), 'the cover in its place');
        assert.deepStrictEqual(w.asked, [TRACK.coverId], 'the cover asked for once');
        // transparent around the card: nothing of the cluster is covered beyond its field
        [[0, 0], [519, 0], [0, 419], [519, 419], [260, 0], [0, 210]].forEach((p) => assert.strictEqual(pxAt(last, 520, p[0], p[1])[3], 0, 'transparent at ' + p));
        assert.strictEqual(pxAt(last, 520, 260, 210)[3], 255, 'opaque in the middle: the car\'s widget under it does not show through');
        assert.strictEqual(w.cluster.state().state, 'shown');
        assert.strictEqual(r.of('set').length, 1, 'shown once');
        // the same track on and on: nothing more is sent
        const n = r.all.length;
        await sleep(200);
        assert.strictEqual(r.all.length, n, 'nothing sent while nothing changes');
        assert.deepStrictEqual(w.logs.filter((l) => /^(warn|error)/.test(l)), []);
    } finally { await w.end(); await r.close(); }
});

test('title and artist as the app\'s lists write them: ASCII, cut to the card', () => {
    const C = need('cluster');
    let t = textCanvas();
    C.render({ title: 'One More Time', artist: 'Daft Punk', cover: null }, t.Canvas);
    assert.ok(t.texts.indexOf('One More Time') >= 0 && t.texts.indexOf('Daft Punk') >= 0, t.texts.join(' | '));
    t = textCanvas();
    C.render({ title: 'Știrile de azi – „Încă”', artist: 'Beyoncé, Mötley Crüe', cover: null }, t.Canvas);
    assert.ok(t.texts.indexOf('Stirile de azi - "Inca"') >= 0, t.texts.join(' | '));
    assert.ok(t.texts.indexOf('Beyonce, Motley Crue') >= 0, t.texts.join(' | '));
    t = textCanvas();
    const cv = C.render({ title: 'A very long title that goes on and on, far past the width of the card on the cluster', artist: '', cover: null }, t.Canvas);
    const cut = t.texts.filter((s) => /^A very long/.test(s))[0];
    assert.ok(/\.\.\.$/.test(cut), 'cut with ...: ' + cut);
    assert.ok(cv.textWidth(cut, C.PLACE.title.size, { literal: true }) <= C.PLACE.title.w, 'within the title\'s width');
    // nothing to say is no reason to throw
    [{}, { title: null, artist: undefined, cover: null }, { title: 5, artist: {}, cover: { w: 2, h: 2, d: new Uint8Array(1) } }].forEach((i) => C.render(i, Canvas));
});

test('the info: only while a track plays (or is on its way) and the app has the speakers', () => {
    const C = need('cluster');
    assert.deepStrictEqual(C.infoOf(playing(), SPEAKERS), { title: 'One More Time', artist: 'Daft Punk', coverId: TRACK.coverId });
    assert.strictEqual(C.infoOf(playing(Object.assign({}, TRACK, { artists: ['A', 'B'] })), SPEAKERS).artist, 'A, B');
    ['loading', 'buffering'].forEach((st) => assert.ok(C.infoOf(playing(TRACK, st), SPEAKERS), st + ': the next track on its way keeps the card'));
    ['paused', 'idle', 'error', 'stopped', 'constructor'].forEach((st) => assert.strictEqual(C.infoOf(playing(TRACK, st), SPEAKERS), null, st));
    [undefined, null, 5, {}].forEach((st) => assert.strictEqual(C.infoOf(Object.assign(playing(), { state: st }), SPEAKERS), null, 'a state of ' + st));
    assert.strictEqual(C.infoOf(playing(null), SPEAKERS), null, 'no track');
    [{ connected: false }, { lost: true }, { held: true }, { taken: true }].forEach((x) =>
        assert.strictEqual(C.infoOf(playing(), Object.assign({}, SPEAKERS, x)), null, JSON.stringify(x)));
    [null, undefined, 5, 'x', []].forEach((x) => { assert.strictEqual(C.infoOf(x, SPEAKERS), null); assert.strictEqual(C.infoOf(playing(), x), null); });
    assert.strictEqual(C.infoOf(playing({ title: 'T' }), SPEAKERS).artist, '', 'a track without artists');
});

test('another track: the same layer, drawn again', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    try {
        await waitFor(() => r.frames.length >= 1 && r.of('set').length === 1 && w.asked.length === 1, 4000, 'the first card');
        await sleep(150);
        const n = r.frames.length;
        w.hold = true;
        w.player = playing({ id: 2, title: 'Aerodynamic', artists: ['Daft Punk'], coverId: 'other-cover', duration: 200 });
        await waitFor(() => r.frames.length === n + 1, 4000, 'the next card');
        w.hold = false;
        await waitFor(() => r.frames.length === n + 2, 4000, 'and its cover');
        assert.deepStrictEqual(pxAt(r.frames[n + 1].px, 520, 260, need('cluster').PLACE.cover.y + 5), RED.concat(255));
        assert.strictEqual(r.of('layer').length, 1, 'no second layer');
        assert.strictEqual(r.of('drop').length, 0, 'not removed in between');
        const C = need('cluster');
        assert.ok(Buffer.from(C.render({ title: 'Aerodynamic', artist: 'Daft Punk', cover: null }, Canvas).d).equals(r.frames[n].px), 'the new title, the old cover gone');
        assert.deepStrictEqual(w.asked, [TRACK.coverId, 'other-cover']);
        // a track without a cover: drawn once, nothing asked
        const m = r.frames.length;
        w.player = playing({ id: 3, title: 'No cover', artists: ['X'], coverId: null });
        await waitFor(() => r.frames.length === m + 1, 4000, 'the card without a cover');
        await sleep(150);
        assert.strictEqual(r.frames.length, m + 1);
        assert.strictEqual(w.asked.length, 2);
    } finally { await w.end(); await r.close(); }
});

test('removed on pause, idle, error, lost speakers and the setting; back with the music', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    try {
        const gone = [
            ['pause', () => { w.player = playing(TRACK, 'paused'); }, () => { w.player = playing(); }],
            ['idle (stop)', () => { w.player = playing(null, 'idle'); }, () => { w.player = playing(); }],
            ['error', () => { w.player = Object.assign(playing(TRACK, 'error'), { error: 'input' }); }, () => { w.player = playing(); }],
            ['the car switched to another source', () => { w.speakers = Object.assign({}, SPEAKERS, { connected: false, lost: true, held: true }); }, () => { w.speakers = Object.assign({}, SPEAKERS); }],
            ['another app took the speakers', () => { w.speakers = Object.assign({}, SPEAKERS, { connected: false, taken: true, held: true }); }, () => { w.speakers = Object.assign({}, SPEAKERS); }],
            ['the setting off', () => { w.on = false; }, () => { w.on = true; }],
        ];
        let shown = 0, dropped = 0;
        for (const g of gone) {
            shown++;
            await waitFor(() => r.of('layer').length === shown && r.of('set').filter((o) => o.visible === 1).length === shown, 4000, 'shown before: ' + g[0]);
            await waitFor(() => w.cluster.state().state === 'shown', 2000, 'the renderer\'s "shown" taken: ' + g[0]);
            g[1]();
            dropped++;
            await waitFor(() => r.of('drop').length === dropped, 4000, 'removed: ' + g[0]);
            assert.strictEqual(r.of('drop')[dropped - 1].ref, r.of('layer')[shown - 1].ref, 'its own layer');
            assert.notStrictEqual(w.cluster.state().state, 'shown');
            await sleep(80);
            assert.strictEqual(r.of('layer').length, shown, 'nothing while it is off: ' + g[0]);
            g[2]();
        }
        await waitFor(() => r.of('layer').length === shown + 1, 4000, 'back at the end');
        assert.strictEqual(r.accepted, 1, 'one connection all along');
    } finally { await w.end(); await r.close(); }
});

test('the app ends: the connection goes (and the card with it), nothing runs on', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    try {
        await waitFor(() => r.of('set').some((o) => o.visible === 1), 4000, 'shown');
        w.stopped = true;
        await waitFor(() => r.open === 0, 2000, 'the connection closed');
        const n = r.accepted;
        w.player = playing({ id: 9, title: 'After the end', artists: [], coverId: null });
        await sleep(400);
        assert.strictEqual(r.accepted, n, 'no new connection after the end');
        assert.strictEqual(w.cluster.state().state, 'closed');
        w.cluster.close();   // again: harmless
        w.cluster.update();
    } finally { await w.end(); await r.close(); }
});

test('the setting off from the start: no connection, nothing sent', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    w.on = false;
    try {
        await sleep(300);
        assert.strictEqual(r.accepted, 0, 'not even a connection');
        assert.deepStrictEqual(r.all, []);
        assert.deepStrictEqual(w.asked, [], 'no cover asked for');
        assert.strictEqual(w.cluster.state().state, 'off');
    } finally { await w.end(); await r.close(); }
});

test('nothing playing: cluster-render is not even connected to', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const w = card(sock);
    w.player = playing(null, 'idle');
    try {
        await sleep(300);
        assert.strictEqual(r.accepted, 0);
        assert.deepStrictEqual(w.logs, []);
    } finally { await w.end(); await r.close(); }
});

test('cluster-render not installed (no socket): nothing breaks, one log line', async () => {
    const sock = tmpSock('none');
    const w = card(sock);
    try {
        await sleep(500);
        assert.strictEqual(w.cluster.state().state, 'missing');
        const lines = w.logs.filter((l) => /cluster/.test(l));
        assert.strictEqual(lines.length, 1, lines.join('\n'));
        assert.ok(/^info /.test(lines[0]), 'not an error: ' + lines[0]);
        assert.ok(/cluster-render is not installed/.test(lines[0]), lines[0]);
        assert.deepStrictEqual(w.logs.filter((l) => /^(warn|error)/.test(l)), []);
        assert.deepStrictEqual(w.asked, [], 'no cover is fetched for a card nobody draws');
        // tracks come and go: still that one line
        w.player = playing(null, 'idle'); await sleep(60);
        w.player = playing({ id: 4, title: 'Next', artists: ['Y'], coverId: null }); await sleep(120);
        assert.strictEqual(w.logs.length, 1);
        assert.deepStrictEqual(escaped, []);
    } finally { await w.end(); }
});

test('no Canvas, or surroundings that throw: nothing breaks', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock);
    const boom = () => { throw new Error('boom'); };
    const a = card(sock, { Canvas: undefined });
    const b = card(sock, { player: boom });
    const c = card(sock, { speakers: boom, enabled: boom });
    const d = card(sock, { decode: boom });
    const e = card(sock, { request: () => Promise.reject(new Error('no answer')) });
    try {
        await waitFor(() => r.of('set').filter((o) => o.visible === 1).length >= 2, 4000, 'd and e show their cards without a cover');
        await sleep(150);
        assert.strictEqual(a.cluster.state().state, 'off');
        assert.strictEqual(r.accepted, 2, 'only the two that can draw connected');
        assert.deepStrictEqual(escaped, []);
        [a, b, c].forEach((w) => assert.ok(w.logs.length <= 1, w.logs.join('\n')));
    } finally { for (const w of [a, b, c, d, e]) await w.end(); await r.close(); }
});

test('R1: garbage from the renderer never throws, and the log stays short', async () => {
    const sock = tmpSock();
    const r = await createRenderer(sock, 'garbage');
    const w = card(sock);
    try {
        // every kind of garbage at least once: the client connects again after each one that ends the connection
        const t0 = Date.now();
        while (Date.now() - t0 < 5000) {
            w.player = playing({ id: Date.now(), title: 'T' + Date.now(), artists: ['A'], coverId: null });
            await sleep(100);
        }
        assert.ok(r.accepted >= 6, 'it came back after each kind of garbage (' + r.accepted + ' connections)');
        assert.deepStrictEqual(escaped, []);
        assert.ok(w.logs.length <= 12, 'no log line per message: ' + w.logs.length + '\n' + w.logs.slice(0, 20).join('\n'));
        w.cluster.update();
    } finally { await w.end(); await r.close(); }
}, { timeout: 30000 });

test('R1: a renderer that hangs up, and one that never reads or answers', async () => {
    for (const mode of ['close', 'stall']) {
        const sock = tmpSock();
        const r = await createRenderer(sock, mode);
        const w = card(sock);
        try {
            const t0 = Date.now();
            let i = 0, slowest = 0;
            while (Date.now() - t0 < 2500) {
                // a new card each time: 870 kB of pixels each, which the stalled socket does not take
                w.player = playing({ id: ++i, title: 'Track ' + i, artists: ['A'], coverId: null });
                const t = Date.now();
                w.cluster.update();
                slowest = Math.max(slowest, Date.now() - t);
                await sleep(40);
            }
            assert.ok(r.accepted >= 1, mode + ': it connected');
            assert.ok(slowest < 500, mode + ': an update never waits for the renderer (' + slowest + ' ms)');
            assert.deepStrictEqual(escaped, [], mode);
            assert.ok(w.logs.length <= 6, mode + ': the log stays short\n' + w.logs.join('\n'));
            assert.notStrictEqual(w.cluster.state().state, 'shown', mode);
            // what waits for the stalled socket is the newest card, not all of them
            if (mode === 'stall') assert.ok(process.memoryUsage().rss < 400 * 1024 * 1024, 'memory: ' + process.memoryUsage().rss);
        } finally { await w.end(); await r.close(); }
        assert.strictEqual(r.open, 0, mode + ': closed at the end');
    }
}, { timeout: 30000 });

/* ---------- through tidal.js: the hook ---------- */
const SPEC = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));

// one audio manager: connections by id (as tests/app_audio.test.js)
function fakeAm() {
    const list = [], calls = [];
    let next = 40;
    return {
        calls, list,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        on: () => Promise.resolve(),
        watch: () => Promise.resolve({ available: true }),
        call: (p, method, args) => {
            calls.push({ method, args });
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: list.slice() });
            if (method === 'getListMainSinks') return Promise.resolve({ listMainSinks: [] });
            if (method === 'disconnect') { const i = list.findIndex((c) => c.mainConnectionID === args.mainConnectionID); if (i >= 0) list.splice(i, 1); }
            if (method === 'connect') { const id = next++; list.push({ mainConnectionID: id, sourceID: 287 }); return Promise.resolve({ amError: 'E_OK', mainConnectionID: id }); }
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
}
function fakeCtx(am) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-data-'));
    const handlers = {}, loops = {}, frames = [], logs = [], setL = [];
    const values = {};
    SPEC.settings.forEach((x) => { values[x.key] = x.default; });
    const ctx = {
        dataDir, handlers, loops, frames, logs, am,
        log: { info(m) { logs.push('info ' + m); }, debug() {}, warn(m) { logs.push('warn ' + m); }, error(m, e) { logs.push('error ' + m + (e ? ' ' + (e.stack || e) : '')); } },
        ui: { onClick: (n, fn) => { handlers[n] = fn; }, image: (n, cv) => { frames.push(cv); return Promise.resolve(); }, isVisible: () => true, onVisible() {}, close() {} },
        settings: { get: (k) => values[k], onChange: (fn) => setL.push(fn), set(k, v) { values[k] = v; setL.forEach((f) => f(k, v)); } },
        theme: () => themes.theme('m_tricolour'),
        canvas: (w, h) => spyCanvas(w, h),
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        signals: am,
        controller: { grab() {}, onInput() {} },
        onTap() {},
    };
    return ctx;
}
function start(svcSock, crSock, opts) {
    const ctx = fakeCtx(fakeAm());
    const app = need('tidal').createApp(ctx, Object.assign({
        socketPath: svcSock, pollMs: 100, parked: parkedKit.watch(ctx, ctx.log), setImage() {}, decodeJpeg: () => { throw new Error('not a picture'); },
        Canvas: Canvas, clusterSocket: crSock, clusterTickMs: 30,
    }, opts || {}));
    return { ctx, app };
}
const PLAYING = { login: 'logged-in', player: playing() };
const statuses = (svc) => svc.requests.filter((q) => q.cmd === 'status').length;

test('the app: a setting, on by default; cluster-render is not required; origins in NOTICE', () => {
    const set = SPEC.settings.filter((x) => x.key === 'cluster')[0];
    assert.ok(set, 'a setting with the key cluster');
    assert.strictEqual(set.type, 'bool');
    assert.strictEqual(set.default, true);
    assert.strictEqual(set.label, 'Show the track on the instrument cluster');
    assert.strictEqual(SPEC.requires['cluster-render'], undefined, 'optional: the app installs and runs without it');
    assert.deepStrictEqual(Object.keys(SPEC.requires).sort(), ['cmocan-tidal', 'mgu-deploy', 'mgu-render']);
    const notice = fs.readFileSync(path.join(APP, 'NOTICE'), 'utf8');
    assert.ok(/cluster_render_client\.js[\s\S]*robertnisipeanu\/idrive-apps @ 5fc4daa9a636924bf86a4e0385a2d328c2f9f449[\s\S]*MPL-2\.0/.test(notice), 'the client\'s origin, commit and licence');
    assert.ok(/cluster\.js[\s\S]*cluster_card\.js[\s\S]*0976d16dda9be301d98b0253586d4c095160ac2b[\s\S]*GPL-3\.0-or-later/.test(notice), 'the card\'s model');
    // robertnisipeanu's client, unchanged
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(APP, 'cluster_render_client.js'))).digest('hex');
    assert.strictEqual(sha, '345e7b9e93bae1f7eedead7c710d8fc01fa5fda18d8866b9592b318d5dbedb43');
    assert.ok(/SPDX-License-Identifier: MPL-2\.0/.test(fs.readFileSync(path.join(APP, 'cluster_render_client.js'), 'utf8').split('\n')[0]));
    // main.js hands tidal.js the kit's pixel canvas, and tidal.js has the one call
    assert.ok(/Canvas/.test(fs.readFileSync(path.join(APP, 'main.js'), 'utf8')), 'main.js passes the kit\'s Canvas');
    const calls = fs.readFileSync(path.join(APP, 'tidal.js'), 'utf8').split('\n').filter((l) => /cluster/i.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.strictEqual(calls.length, 1, 'one line of code in tidal.js:\n' + calls.join('\n'));
});

test('the app: the card while its track plays on the speakers; gone on pause, when the car takes the speakers, and with the app', async () => {
    const svcSock = tmpSock('svc'), crSock = tmpSock();
    const svc = await createFakeService({ socketPath: svcSock, state: PLAYING });
    const r = await createRenderer(crSock);
    const { ctx, app } = start(svcSock, crSock);
    try {
        await waitFor(() => r.of('set').some((o) => o.visible === 1), 6000, 'the card shown');
        assert.strictEqual(ctx.am.list.length, 1, 'our sound is on the speakers');
        const C = need('cluster');
        assert.ok(Buffer.from(C.render({ title: 'One More Time', artist: 'Daft Punk', cover: null }, Canvas).d).equals(r.frames[0].px), 'the playing track');
        assert.ok(svc.requests.filter((q) => q.cmd === 'cover').length >= 1, 'its cover asked of the service');
        // pause
        svc.state.player.state = 'paused';
        await waitFor(() => r.of('drop').length === 1, 4000, 'removed on pause');
        // resume
        svc.state.player.state = 'playing';
        await waitFor(() => r.of('layer').length === 2 && r.of('set').filter((o) => o.visible === 1).length === 2, 6000, 'back on resume');
        // the driver chooses the radio: the car ends our connection; the service goes on saying "playing" for a while
        svc.answer = (q) => (q.cmd === 'pause' ? { id: q.id, ok: true } : undefined);
        ctx.am.list.length = 0;
        await waitFor(() => r.of('drop').length === 2, 8000, 'removed when the car took the speakers');
        assert.strictEqual(svc.state.player.state, 'playing', 'removed for the speakers, not for the player\'s state');
        await sleep(300);
        assert.strictEqual(r.of('layer').length, 2, 'not back while another source plays');
        // the setting, live
        ctx.am.list.length = 0;
        app.act({ type: 'control', cmd: 'resume' });
        await waitFor(() => r.of('layer').length === 3, 8000, 'back after the driver\'s play');
        ctx.settings.set('cluster', false);
        await waitFor(() => r.of('drop').length === 3, 4000, 'removed with the setting');
        ctx.settings.set('cluster', true);
        await waitFor(() => r.of('layer').length === 4, 4000, 'and back');
        // the app ends
        app.stop();
        await waitFor(() => r.open === 0, 3000, 'the connection to cluster-render closed with the app');
        assert.deepStrictEqual(ctx.logs.filter((l) => /^error/.test(l)), []);
        assert.deepStrictEqual(escaped, []);
    } finally { app.stop(); await svc.close(); await r.close(); }
}, { timeout: 60000 });

test('the app: no cluster-render, a broken one, a stalled one: the status is asked as ever, nothing is shown as an error', async () => {
    for (const mode of ['none', 'garbage', 'close', 'stall']) {
        const svcSock = tmpSock('svc'), crSock = tmpSock();
        const svc = await createFakeService({ socketPath: svcSock, state: PLAYING });
        const r = mode === 'none' ? null : await createRenderer(crSock, mode);
        const { ctx, app } = start(svcSock, crSock);
        try {
            await waitFor(() => app.state().screen !== 'NO_SERVICE' && app.state().player && app.state().player.state === 'playing', 4000, mode + ': playing');
            await sleep(600);
            const n = statuses(svc);
            await sleep(1000);
            const got = statuses(svc) - n;
            assert.ok(got >= 6, mode + ': the status goes on every 100 ms (' + got + ' in 1 s)');
            await ctx.loops.MAIN();
            const screen = ctx.frames[ctx.frames.length - 1];
            assert.ok(!screen.has(/cluster/i), mode + ': nothing about the cluster on the screen');
            assert.strictEqual(app.state().message || null, null, mode + ': no message');
            assert.deepStrictEqual(ctx.logs.filter((l) => /^error/.test(l)), [], mode);
            const lines = ctx.logs.filter((l) => /cluster/i.test(l));
            if (mode === 'none') {
                assert.strictEqual(lines.length, 1, lines.join('\n'));
                assert.ok(/^info .*cluster-render is not installed/.test(lines[0]), lines[0]);
            } else assert.ok(lines.length <= 8, mode + ': a short log\n' + lines.join('\n'));
            assert.deepStrictEqual(escaped, [], mode);
        } finally { app.stop(); await svc.close(); if (r) await r.close(); }
    }
}, { timeout: 60000 });

test('nothing escaped in all of the above', () => assert.deepStrictEqual(escaped, []));

run();
