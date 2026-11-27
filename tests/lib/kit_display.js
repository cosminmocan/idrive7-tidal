'use strict';
/**
 * kit_display.js - the app (apps/cmocan_tidal/tidal.js) on the kit's own display (kit/runtime/display.js) as it is in
 * the car: the GPU path with mgu-render/1 and touch, the full-screen layout, so the kit runs the screen (its header
 * with the tabs, its slim bar, the controller held: display.own()). The renderer is the kit's file sink
 * (MGU_RENDERD_FILE: RenderClient writes the stream to a file and is ready at once, as kit/tools/preview.js uses it);
 * the RHMI is a stand-in with components that are event emitters, as kit/tools/hu-stub.js has them.
 *
 *   const h = await kitApp({ socketPath, settings });   // { app, disp, ui, ctx, comps, frame(), ccu(ev), close() }
 *     h.frame()      the app draws one frame (as the kit's loop does): the display composes header and bar over it
 *     h.ccu(ev)      the controller as the renderer hands it over: { knob: +n | -n, press, tilt: 'N' | 'E' | 'S' | 'W' }
 *     h.clicked      bar buttons the HMI was told were pressed (ids, in order)
 * Node 8.9.4 syntax.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..', '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));
const TILT = { N: 1, E: 4, S: 7, W: 10 };

function kitApp(o) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-kit-'));
    const prev = process.env.MGU_RENDERD_FILE;
    process.env.MGU_RENDERD_FILE = path.join(tmp, 'stream.bin');
    const themes = require(path.join(ROOT, 'kit', 'runtime', 'themes'));
    const { Display } = require(path.join(ROOT, 'kit', 'runtime', 'display'));
    const { createApp } = require(path.join(ROOT, 'apps', 'cmocan_tidal', 'tidal'));
    const logs = [];
    const log = { info() {}, debug() {}, warn(m) { logs.push('warn ' + m); }, error(m, e) { logs.push('error ' + m + (e ? ' ' + (e.stack || e) : '')); } };
    const values = Object.assign({ theme: 'm_tricolour', layout: 'full', renderer: 'auto', cluster: false, wheel: true, quality: 'HIGH' }, o.settings || {});
    const setL = [];
    const settings = { get: (k) => values[k], onChange: (fn) => setL.push(fn), set(k, v) { values[k] = v; setL.forEach((fn) => fn(k, v)); } };
    const comps = {}, visH = [], clicked = [], opened = [], closed = [];
    const comp = (n) => comps[n] || (comps[n] = Object.assign(new EventEmitter(), { name: n }));
    let visible = { MAIN: true };
    const ui = {
        rhmi: { getByName: comp },
        onVisible: (fn) => visH.push(fn),
        onFocus() {},
        isVisible: (n) => !!visible[n],
        hasFocus: () => true,
        visible: () => Promise.resolve(),
        onClick: (n, fn) => comp(n).on('action', (ev) => { clicked.push(n); Promise.resolve().then(() => fn(ev || {})); }),
        text: (n, t) => { disp.label(n, t); return Promise.resolve(); },
        image: (n, cv) => disp.present(n, cv, () => Promise.resolve()),
        open: (n) => { opened.push(n); setVisible(n, true); return Promise.resolve(); },
        close: (n) => { closed.push(n); setVisible(n, false); return Promise.resolve(); },
    };
    function setVisible(n, on) { if (!!visible[n] === on) return; visible = Object.assign({}, visible); visible[n] = on; visH.forEach((fn) => fn(n, on)); }
    const theme = () => themes.theme(values.theme);
    const disp = new Display(ui, log, SPEC, settings, theme);
    ui.display = disp;
    const loops = {};
    const ctx = {
        ui: ui, settings: settings, log: log, theme: theme, display: disp, dataDir: tmp,
        canvas: (w, h) => disp.canvas(w, h),
        loop: (n, fps, fn) => { loops[n] = fn; return { kick() {}, stop() {} }; },
        controller: { grab(on) { disp.grab(on); }, onInput(fn) { disp.onCcu = fn; } },
        onTab(fn) { disp.onTab = fn; },
        onTap(fn) { disp.onTap = fn; },
        onTouch(fn) { disp.onTouch = fn; },
        hideButton(id) { disp.hideButton(id); },
        signals: {
            watch: () => Promise.resolve({ available: false }),
            proxy: () => Promise.reject(new Error('no SOME/IP in the test')), call: () => Promise.reject(new Error('none')),
            on: () => Promise.reject(new Error('none')), onAvailable: () => {},
        },
    };
    let k = 1000, app = null;
    const raw = { k: k, pb: 0, df: 0 };
    const send = () => disp.gpu.emit('ccu', { frontRotaryEncoderOperation: raw.k & 0xffff, frontRotaryEncoderPushButton: raw.pb, frontRotaryEncoderDeflection: raw.df });
    const h = {
        disp: disp, ui: ui, ctx: ctx, comps: comps, clicked: clicked, opened: opened, closed: closed, logs: logs, setVisible: setVisible,
        frame: () => Promise.resolve(loops.MAIN && loops.MAIN()),
        ccu(ev) {
            if (ev.knob) { raw.k += ev.knob; send(); }
            if (ev.press) { raw.pb = 1; send(); raw.pb = 0; send(); }
            if (ev.tilt) { raw.df = TILT[ev.tilt]; send(); raw.df = 0; send(); }
        },
        close() {
            if (app) app.stop();
            try { disp.closeSheet(); } catch (e) { /* gone */ }
            if (disp.sheetTimer) clearInterval(disp.sheetTimer);
            if (disp.showTimer) clearTimeout(disp.showTimer);
            if (disp.gpu) disp.gpu.close();
            if (disp.poll) clearInterval(disp.poll);
            if (disp.keepTimer) clearInterval(disp.keepTimer);
            if (prev === undefined) delete process.env.MGU_RENDERD_FILE; else process.env.MGU_RENDERD_FILE = prev;
        },
    };
    // the renderer's READY comes on the next turn: the placement, then the kit runs the screen
    return new Promise((resolve) => setImmediate(resolve)).then(() => {
        app = createApp(ctx, Object.assign({ socketPath: o.socketPath, pollMs: 150, setImage() {}, decodeJpeg: require(path.join(ROOT, 'apps', 'cmocan_tidal', 'jpeg')) }, o.kit || {}));
        h.app = app;
        send();                         // the controller's state at rest: what the first turn counts from
        return h;
    });
}

module.exports = { kitApp: kitApp };
