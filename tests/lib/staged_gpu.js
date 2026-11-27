'use strict';
/**
 * staged_gpu.js - the staged car app (as tests/app_smoke.test.js stages it: kit/tools/build.py --preview-only, no BMW
 * SDK) on the kit's stubbed head unit (kit/tools/hu-stub.js), drawing through the kit's GPU path: display.js and
 * renderd.js, to a renderer's socket (MGU_RENDERD_SOCKET) or into a file (MGU_RENDERD_FILE, the stream
 * `mgu-render --replay` reads). The app talks to a fake service where a track plays, and is taken to now playing with
 * the controller, so its frames carry the track's cover. Also here: reading such a stream.
 *
 *   const out = await runStaged({ tmp, serviceSock, rendererSock | file, ms });   // { logs, errors, covers, frames }
 *   coverService(sock, jpeg)      the fake service, logged in, a track playing, its cover that JPEG
 *   messages(buf)                 [{ type, p }] of a client stream (u32 type, u32 length, payload)
 *   imageOps(words, form)         the IMAGE ops (18) in draw words, read as 'native' (x y w h r id) or 'upstream'
 * Node 8.9.4 syntax.
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps', 'cmocan_tidal');
const KIT = path.join(ROOT, 'kit');

function copyDir(from, to) {
    fs.mkdirSync(to);
    fs.readdirSync(from).forEach((n) => {
        const a = path.join(from, n), b = path.join(to, n);
        if (fs.statSync(a).isDirectory()) copyDir(a, b);
        else fs.writeFileSync(b, fs.readFileSync(a));
    });
}

/** <into> as build.py --preview-only makes dist/<id> (English): source/javascript/{app.js, *.js, kit/} */
function stage(into) {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const js = path.join(into, 'source', 'javascript');
    fs.mkdirSync(into);
    fs.mkdirSync(path.join(into, 'source'));
    fs.mkdirSync(js);
    fs.readdirSync(APP).filter((f) => /\.js$/.test(f)).forEach((f) => {
        fs.writeFileSync(path.join(js, f === 'main.js' ? 'app.js' : f), fs.readFileSync(path.join(APP, f)));
    });
    copyDir(path.join(KIT, 'runtime'), path.join(js, 'kit'));
    const rt = {};
    ['id', 'title', 'version', 'screens', 'settings', 'config', 'startWidget'].forEach((k) => { rt[k] = spec[k] === undefined ? null : spec[k]; });
    rt.stateIds = {};
    fs.writeFileSync(path.join(js, 'kit', 'app-spec.json'), JSON.stringify(rt));
    fs.writeFileSync(path.join(js, 'kit', 'locale.json'), JSON.stringify({ language: 'en', strings: {} }));
    return spec;
}

// the child: the stubbed head unit with the screen shown; the controller is pushed right (now playing) until the
// cover is a picture (kit/record.js imageById), then a few more frames are drawn; what was logged is printed as JSON
const CHILD = `
const path = require('path');
const [stageDir, dataDir, hustub, ms] = process.argv.slice(1);
const logs = [], errors = [];
const keep = (l) => (...a) => { const s = a.map((x) => (x && x.stack) || String(x)).join(' '); logs.push(l + ' ' + s); if (l === 'error') errors.push(s); };
const log = { info: keep('info'), warn: keep('warn'), error: keep('error'), debug: () => {} };
console.error = log.error; console.warn = log.warn; console.log = () => {}; console.info = () => {};
process.on('uncaughtException', (e) => errors.push('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e && e.stack || e)));
const { headUnit } = require(hustub);
const hu = headUnit(stageDir, { dataDir, fresh: true, log, image: () => Promise.resolve() });
hu.ui.isVisible = (n) => n === 'MAIN';
hu.start();
const rec = require(path.join(hu.kitDir, 'record'));
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const ccu = (df) => hu.display.onCcu && hu.display.onCcu({ frontSequenceNumberOperatingElement: 0, frontRotaryEncoderOperation: 0, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: df });
(async () => {
    const end = Date.now() + Number(ms);
    let frames = 0, after = 0;
    await sleep(300);
    while (Date.now() < end && after < 4) {
        if (!rec.imageById.size) { ccu(0); ccu(4); } else after++;
        try { await hu.loopFn(); frames++; } catch (e) { errors.push('loop: ' + (e && e.stack || e)); }
        await sleep(120);
    }
    const covers = [];
    rec.imageById.forEach((im, id) => covers.push({ id, w: im.w, h: im.h, ver: im.ver }));
    await sleep(200);
    if (hu.display.gpu) hu.display.gpu.close();
    process.stdout.write(JSON.stringify({ logs, errors, covers, frames }) + '\\n');
    process.exit(0);
})();
`;

/** Run the staged app (staged into o.tmp/cmocan_tidal) until its cover was drawn, o.ms (8000) at most. */
function runStaged(o) {
    const stageDir = path.join(o.tmp, 'cmocan_tidal'), dataDir = path.join(o.tmp, 'data');
    stage(stageDir);
    fs.mkdirSync(dataDir);
    const env = Object.assign({}, process.env, { CMOCAN_TIDAL_SOCK: o.serviceSock });
    delete env.MGU_RENDERD_FILE; delete env.MGU_RENDERD_SOCKET; delete env.MGU_RENDERD_PROTO; delete env.MGU_RENDERER;
    if (o.file) env.MGU_RENDERD_FILE = o.file;
    else env.MGU_RENDERD_SOCKET = o.rendererSock;
    return new Promise((resolve, reject) => {
        const ch = childProcess.spawn(process.execPath, ['-e', CHILD, stageDir, dataDir, path.join(KIT, 'tools', 'hu-stub.js'), String(o.ms || 8000)], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        ch.stdout.on('data', (d) => { out += d; });
        ch.stderr.on('data', (d) => { err += d; });
        ch.on('error', reject);
        ch.on('close', (code) => {
            if (code !== 0) return reject(new Error('the staged app ended with ' + code + '\n' + err + out));
            try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error('the staged app printed no result\n' + err + out)); }
            return undefined;
        });
    });
}

/** The fake service with a track playing whose cover is `jpeg` (a Buffer). */
function coverService(socketPath, jpeg) {
    const { createFakeService, defaultState, TRACK } = require('../fakes/fake_service');
    const st = Object.assign(defaultState(), { login: 'logged-in' });
    st.player = { state: 'playing', track: TRACK, position: 42.5, duration: 320, queueIndex: 0, queueLength: 14, quality: 'HIGH', error: null, skipped: [] };
    return createFakeService({ socketPath: socketPath, state: st }).then((svc) => {
        svc.answer = (r) => (r.cmd === 'cover' ? { id: r.id, ok: true, mime: 'image/jpeg', data: jpeg.toString('base64') } : null);
        return svc;
    });
}

/** The whole messages of a stream: [{ type, p }] */
function messages(buf) {
    const out = [];
    let at = 0;
    while (at + 8 <= buf.length) {
        const type = buf.readUInt32LE(at), len = buf.readUInt32LE(at + 4);
        if (at + 8 + len > buf.length) break;
        out.push({ type: type, p: buf.slice(at + 8, at + 8 + len) });
        at += 8 + len;
    }
    return out;
}

// words after each draw op (the renderer's PROTOCOL.md, "Draw ops"); GRAD, CARD, TRIS and GLYPHS carry a count
const OP_WORDS = { 1: 1, 2: 5, 3: 5, 4: 6, 5: 7, 6: 6, 7: 8, 8: 11, 9: 6, 10: 1, 11: 3, 12: 3, 13: 4, 14: 0, 15: 9, 16: 1, 17: 3, 18: 6, 19: 6 };
/** The IMAGE ops of a FRAME's or LAYER's draw words (a Buffer), each read in the dialect's form. Throws on an unknown op. */
function imageOps(b, form) {
    const n = b.length >> 2, u = (i) => b.readUInt32LE(i * 4), f = (i) => b.readFloatLE(i * 4), out = [];
    let i = 0;
    while (i < n) {
        const op = u(i);
        let len = OP_WORDS[op];
        if (len === undefined) throw new Error('unknown draw op ' + op + ' at word ' + i);
        if (op === 3) len += 2 * u(i + 5);
        else if (op === 6) len += 2 * u(i + 6);
        else if (op === 10) len += 9 * u(i + 1);
        else if (op === 11) len += 8 * u(i + 3);
        else if (op === 18) {
            out.push(form === 'upstream' ? { id: u(i + 1), ver: u(i + 2), x: f(i + 3), y: f(i + 4), w: f(i + 5), h: f(i + 6) }
                : { x: f(i + 1), y: f(i + 2), w: f(i + 3), h: f(i + 4), r: f(i + 5), id: u(i + 6) });
        }
        i += 1 + len;
    }
    return out;
}

module.exports = { stage: stage, runStaged: runStaged, coverService: coverService, messages: messages, imageOps: imageOps, ROOT: ROOT };
