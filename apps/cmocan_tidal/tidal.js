'use strict';
/**
 * tidal.js - the app, wired: the service client (client.js), the state machine (model.js), the screens
 * (screens.js), the controller and touch (nav.js, ccu.js), covers, the speakers and the volume (audio.js,
 * car_volume.js), the steering wheel (wheel.js) and the car's speed (the kit's parked.js). main.js hands it the
 * kit's ctx; the tests hand it a stand-in.
 *
 *   const app = createApp(ctx, { socketPath, parked, setImage, decodeJpeg, pollMs });
 *   app.state() / app.info()     the model's state, the last frame's hit areas
 *   app.input(ev) / app.act(a)   controller steps (nav.js) / acts (screens.js, nav.js)
 *   app.stop()
 *
 * The status is asked for every 1.5 s while the app runs (the service also takes it as a sign of life: rule R8).
 * Node 8.9.4 syntax.
 */
const path = require('path');
const { createClient } = require('./client');
const M = require('./model');
const S = require('./screens');
const N = require('./nav');
const L = require('./listview');
const NP = require('./nowplaying');
const { createProgress } = require('./progress');
const { createCovers } = require('./covers');
const { createAudio, WANT } = require('./audio');
const { createCarVolume } = require('./car_volume');
const { createWheel, IFACE: WHEEL_IFACE } = require('./wheel');
const { createCcu } = require('./ccu');

const W = 1600, H = 520;
const POLL_MS = 1500;
const TOAST_MS = 5000;
const SLOW_MS = 15000;          // login-start, search, lists: TIDAL is behind them
const QUALITIES = ['LOSSLESS', 'HIGH'];

function createApp(ctx, kit) {
    const log = ctx.log;
    const now = kit.now || Date.now;
    const client = createClient({ socketPath: kit.socketPath || '/run/cmocan-tidal.sock', log: log, timeoutMs: 6000 });
    let s = M.initial(), info = null, focus = -1, toastUntil = 0, stopped = false, loopHandle = null;
    const progress = createProgress();
    const loading = {};                 // list requests on their way, by frame key + params
    const timers = [];

    /* ---------- drawing ---------- */
    function render() { if (loopHandle && loopHandle.kick) loopHandle.kick(); }
    function draw() {
        const t = ctx.theme();
        const cv = ctx.canvas(W, H).clear(t.bg);
        const p = progress.at(now());
        let vol = null;
        try { vol = volume.popup(); } catch (e) { vol = null; }
        try {
            info = S.draw(cv, t, s, { now: now(), act: act, focus: focus, cover: covers.get, position: p.pos, duration: p.dur, volume: vol, toastUntil: toastUntil });
        } catch (e) { log.warn('draw: ' + (e && e.stack || e)); }
        return ctx.ui.image('MAIN_GFX', cv);
    }

    /* ---------- the model ---------- */
    function dispatch(ev) {
        const before = s;
        s = M.reduce(s, ev);
        if (s === before) return;
        if (s.screen !== before.screen) focus = -1;
        if (s.message && s.message !== before.message) toastUntil = now() + TOAST_MS;
        after();
        render();
    }
    function after() {
        if (M.wantsLoginCode(s)) login();
        const f = M.top(s);
        if (s.screen === 'LIST' && f) {
            if (f.loading && !f.items.length) load(f, 0);
            const more = L.needMore(f);
            if (more) load(f, more.params.offset);
        }
    }

    /* ---------- requests ---------- */
    const ask = (cmd, params, ms) => client.request(cmd, params || {}, ms ? { timeoutMs: ms } : undefined);
    function command(cmd, params) {
        return ask(cmd, params).then((a) => {
            if (!a.ok) dispatch({ type: 'error', code: a.error, cmd: cmd, trackId: params && params.tracks ? params.tracks[params.index] : undefined });
            setTimeout(poll, 300);
            return a;
        });
    }
    function load(f, offset) {
        const params = {};
        Object.keys(f.source.params || {}).forEach((k) => { params[k] = f.source.params[k]; });
        if (L.PAGED[f.source.cmd]) { params.offset = offset; params.limit = L.PAGE; }
        const token = f.key + '|' + JSON.stringify(params);
        if (loading[token]) return;
        loading[token] = true;
        ask(f.source.cmd, params, SLOW_MS).then((a) => {
            delete loading[token];
            if (a.ok && Array.isArray(a.items)) dispatch({ type: 'list-loaded', key: f.key, offset: offset, total: a.total, items: a.items, stale: a.stale === true });
            else if (!a.ok) dispatch({ type: 'list-failed', key: f.key, code: a.error });
            else dispatch({ type: 'list-failed', key: f.key, code: 'bad-answer' });
        });
    }
    let loggingIn = false;
    /** a login code: by itself only when logged out with none pending (a pending one's code comes in the status);
     *  a new code the user asked for while the service still holds the old one (its time ran out on our clock
     *  first) cancels that one first, as login-start would answer it again */
    function login(fresh) {
        if (loggingIn) return;
        loggingIn = true;
        const cancel = fresh && s.service.login === 'login-pending';
        dispatch({ type: 'login-requested' });
        (cancel ? ask('login-cancel') : Promise.resolve()).then(() => ask('login-start', {}, SLOW_MS)).then((a) => {
            loggingIn = false;
            if (a.ok && typeof a.url === 'string') dispatch({ type: 'login-started', url: a.url, userCode: a.userCode, expiresIn: a.expiresIn, now: now() });
            else {
                dispatch({ type: 'login-failed', code: a.error });
                if (a.error === 'offline' || a.error === 'no-service') dispatch({ type: 'error', code: a.error, cmd: 'login-start' });
            }
        });
    }

    /* ---------- polling ---------- */
    let polling = false, qualitySent = false;
    function poll() {
        if (polling || stopped) return;
        polling = true;
        ask('status').then((a) => {
            polling = false;
            if (a.ok && a.state && typeof a.state === 'object') {
                dispatch({ type: 'status', state: a.state, id: a.id });
                progress.update(s.player, a.id, now());
                // the app's setting is the one that counts: sent once when the service has another
                const q = ctx.settings.get('quality'), has = s.service.prefs && s.service.prefs.quality;
                if (!qualitySent && has && QUALITIES.indexOf(q) >= 0 && q !== has) { qualitySent = true; sendQuality(); }
            } else if (a.error === 'no-service') dispatch({ type: 'no-service' });
            audio.update(s.player);
            dispatch({ type: 'tick', now: now() });
            if (kit.parked) dispatch({ type: 'driving', moving: !!kit.parked.moving() });
            render();
        });
    }
    client.onState((st) => { if (st === 'no-service') dispatch({ type: 'no-service' }); });

    /* ---------- acts: from screens (targets), nav (controller, taps), bar buttons, the wheel ---------- */
    function act(a) {
        if (!a || typeof a !== 'object') return;
        switch (a.type) {
            case 'play':
                audio.userPlay();
                command('play', { tracks: a.tracks, index: a.index }).then((r) => { if (r.ok) dispatch({ type: 'played' }); });
                return;
            case 'control':
                if (a.cmd !== 'pause' && a.cmd !== 'stop') audio.userPlay();
                command(a.cmd);
                return;
            case 'login-new': loggingIn = false; login(true); return;
            case 'focus': focus = a.index; render(); return;
            case 'row': L.rowActs(s, a.index).forEach(act); dispatch({ type: 'cursor', sel: a.index, top: L.cursor(s).top }); return;
            case 'leave': if (ctx.ui.close) Promise.resolve(ctx.ui.close('MAIN')).catch(() => {}); return;
            default: dispatch(a);
        }
    }
    function input(ev) { N.input(s, info, ev).forEach(act); }
    function playPause() { const cmd = NP.playPause(s.player); if (cmd) act({ type: 'control', cmd: cmd }); }

    ctx.ui.onClick('BTN_PLAY', playPause);
    ctx.ui.onClick('BTN_PREV', () => act({ type: 'control', cmd: 'prev' }));
    ctx.ui.onClick('BTN_NEXT', () => act({ type: 'control', cmd: 'next' }));
    ctx.ui.onClick('BTN_LIBRARY', () => act({ type: 'open-library' }));
    // the HMI's own bar (no GPU renderer: the knob goes along the bar's buttons, the picture takes no touch): Up,
    // Down and Select stand in for the knob on the page; where the kit runs the screen they are left out
    ctx.ui.onClick('BTN_UP', () => input({ knob: -1 }));
    ctx.ui.onClick('BTN_DOWN', () => input({ knob: 1 }));
    ctx.ui.onClick('BTN_OK', () => input({ press: true }));
    if (ctx.hideButton) ['BTN_UP', 'BTN_DOWN', 'BTN_OK'].forEach((id) => ctx.hideButton(id));

    /* ---------- the car: speakers, volume, wheel, controller, touch ---------- */
    // one proxy per interface for the speakers and the volume (both use the audio manager)
    const proxies = {};
    const sig = ctx.signals && ctx.signals.proxy ? Object.assign({}, ctx.signals, {
        proxy: (iface, inst) => {
            const k = iface + '/' + inst;
            if (!proxies[k]) proxies[k] = ctx.signals.proxy(iface, inst).catch((e) => { delete proxies[k]; throw e; });
            return proxies[k];
        },
    }) : ctx.signals;
    const audio = createAudio({ signals: sig, log: log, file: ctx.dataDir ? path.join(ctx.dataDir, 'car-audio.json') : null, send: (cmd) => command(cmd) });
    const volume = createCarVolume(sig, log, { onChange: render });
    const covers = createCovers({ request: (cmd, p) => ask(cmd, p, SLOW_MS), decode: kit.decodeJpeg, setImage: kit.setImage, size: 400, log: log });
    covers.onChange(render);
    const wheel = createWheel({
        skip: (d) => act({ type: 'control', cmd: NP.skipCmd(d) }),
        active: () => ctx.settings.get('wheel') !== false && !!(s.player && s.player.track && WANT[s.player.state]),
    });
    if (ctx.signals && ctx.signals.watch) {
        Promise.resolve().then(() => ctx.signals.watch(WHEEL_IFACE, '1', { statusSearchSwitch1: wheel.onSwitch }, log))
            .catch((e) => log.warn('steering wheel: ' + e));
    }
    if (ctx.controller) {
        ctx.controller.onInput(createCcu(input));
        if (ctx.ui.onVisible) ctx.ui.onVisible((name, v) => { if (name === 'MAIN') ctx.controller.grab(!!v); });
        if (!ctx.ui.isVisible || ctx.ui.isVisible('MAIN')) ctx.controller.grab(true);
    }
    if (ctx.onTap) ctx.onTap((x, y) => input({ tap: { x: x, y: y } }));
    // where the kit runs the screen, its controller ring goes through our rows (cv.target): the list follows it
    const disp = ctx.display;
    if (disp && typeof disp._focus === 'function') {
        const focus0 = disp._focus.bind(disp);
        disp._focus = (p) => {
            focus0(p);
            const m = /^tgt:row:(\d+)$/.exec((p && p.k) || '');
            if (m && (s.screen === 'LIST' || s.screen === 'LIBRARY')) {
                const c = L.move({ sel: Number(m[1]), top: L.cursor(s).top }, 0, L.rows(s).length);
                // one row of the next ones in view, so the knob can go on to it
                const c2 = L.move(c, 1, L.rows(s).length);
                dispatch({ type: 'cursor', sel: c.sel, top: Math.max(c.top, c2.top) });
            }
        };
    }

    /* ---------- settings ---------- */
    function sendQuality() {
        const q = ctx.settings.get('quality');
        if (QUALITIES.indexOf(q) >= 0) ask('prefs', { quality: q });
    }
    if (ctx.settings.onChange) ctx.settings.onChange((k) => { if (k === 'quality') sendQuality(); });

    /* ---------- start ---------- */
    loopHandle = ctx.loop('MAIN', 2, draw);
    timers.push(setInterval(poll, kit.pollMs || POLL_MS));
    poll();
    if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => { audio.stop(); client.close(); });

    return {
        state: () => s, info: () => info, input: input, act: act, draw: draw,
        stop() { stopped = true; timers.forEach(clearInterval); client.close(); audio.stop(); },
    };
}

module.exports = { createApp: createApp };
