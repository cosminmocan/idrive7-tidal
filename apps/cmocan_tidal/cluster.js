'use strict';
/**
 * cluster.js - the playing track on the instrument cluster: its cover, title and artist on a card over the media
 * widget in the right dial, while a track plays and our sound is on the speakers.
 *
 * Why a card of our own: the cluster's media widget shows what BMW's media app fills in, and our sound comes in by
 * the CarLife input, so the widget has no title for it (docs/car-log.md, row 5). As aurelmarius' TVH Player does
 * (cluster_card.js, the model of this file), the card is drawn over it through cluster-render (robertnisipeanu/
 * idrive-apps, from the Store): ONE image layer on its `panel` target (1920x720, the whole cluster, over the gauges),
 * class `overlay`, transparent around the card. The client is cluster-render's own (cluster_render_client.js,
 * MPL-2.0, copied unchanged), which speaks its protocol and connects again by itself.
 *
 *   createCluster({ log, Canvas, enabled(), player(), speakers(), stopped(), request, decode, socketPath, tickMs })
 *       Canvas: the kit's pixel canvas (kit/canvas.js); player(): status.player; speakers(): audio.js state();
 *       request('cover', { coverId }) and decode(jpeg): as covers.js takes them; stopped(): the app has ended.
 *       It runs itself (a look every half second): nothing else to call.
 *       -> { update(), close(), state() }     state(): { state: 'off' | 'idle' | 'missing' | 'waiting' | 'shown' |
 *                                             'closed' | a layer state of the renderer, detail }
 *   forApp(ctx, kit, { request, player, speakers, stopped })    the same for tidal.js: the setting, the kit's parts
 *   infoOf(player, speakers)    { title, artist, coverId } when the card is due, else null
 *   render(info, Canvas)        the card's picture for { title, artist, cover: { w, h, d } | null }
 *   PLACE                       where everything is (to adjust after a look in the car)
 *
 * The card is there while the player's state is playing, loading or buffering (as the speakers are wanted, audio.js:
 * no blink between two tracks) and audio.js says the speakers are ours (connected, not lost, not taken, not held).
 * Otherwise its layer is dropped, so the car's own widget shows again: pause, stop, an error, the car or another app
 * taking the speakers, the setting off; the connection closes with the app, and the layer goes with it.
 * Without cluster-render (its socket is not there) nothing is done but one log line; the socket is looked for again
 * every half minute while a track plays. Nothing here waits for the renderer and nothing it sends can throw (R1).
 * Node 8.9.4 syntax.
 */
const fs = require('fs');
const { ClusterRender, DEFAULT_PATH } = require('./cluster_render_client');
const { createCovers } = require('./covers');
const { fit } = require('./text');
const { WANT } = require('./audio');

/**
 * Where everything is. card: panel pixels (1920x720). TVH Player's place for the media widget of a 2020s G-series
 * cluster with the map in the middle (its photo of the car: the widget's cover at about 1320-1460 x 195-330, its
 * lines down to y 490). cover, title, artist: card pixels from the card's top; all three are centred; title and
 * artist: the baseline (y), the text's size and its widest (w).
 */
const PLACE = {
    card: { x: 1130, y: 140, w: 520, h: 420 },
    cover: { y: 52, size: 140 },
    title: { y: 240, size: 34, w: 360 },
    artist: { y: 284, size: 30, w: 360 },
};

const TICK_MS = 500;
const MISSING_MS = 30000;       // no socket: looked for again after this long
const REFUSED_MS = 60000;       // the renderer refused the layer: asked again after this long
const SILENT_MS = 10000;        // no hello for this long: one log line
const MAX_SAID = 8;             // log lines about the renderer in one run of the app

// as BMW's widget: no frame, the lines centred under the cover, white and a softer white; behind them a dark field
// that fades out into the dial (an ellipse, opaque inside FADE_IN of its radius: it hides the widget underneath)
const FIELD = [10, 12, 16], FADE_IN = 0.7;
const TEXT = [255, 255, 255, 255], SOFT = [255, 255, 255, 205], DIM = [255, 255, 255, 150], NO_COVER = [44, 50, 58, 255];

/** the dark field: opaque in the middle, smoothly transparent at the ellipse's edge (TVH Player's) */
function field(cv) {
    const W = cv.w, H = cv.h, rx = W / 2 - 2, ry = H / 2 - 2, cx = W / 2, cy = H / 2, d = cv.d;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const ex = (x + 0.5 - cx) / rx, ey = (y + 0.5 - cy) / ry, r = Math.sqrt(ex * ex + ey * ey);
            if (r >= 1) continue;
            const t = r <= FADE_IN ? 1 : 1 - (r - FADE_IN) / (1 - FADE_IN), a = t * t * (3 - 2 * t);
            const i = (y * W + x) * 4;
            d[i] = FIELD[0]; d[i + 1] = FIELD[1]; d[i + 2] = FIELD[2]; d[i + 3] = Math.round(a * 255);
        }
    }
}

function line(cv, v, at, color) {
    if (typeof v !== 'string' || !v) return;
    const s = fit(cv, v, at.size, at.w, 'label');
    if (s) cv.text(s, cv.w / 2, at.y, at.size, color, { align: 'center', literal: true });
}

function render(info, Canvas) {
    const i = info && typeof info === 'object' ? info : {};
    const cv = new Canvas(PLACE.card.w, PLACE.card.h).clear([0, 0, 0, 0]);
    field(cv);
    const cx = cv.w / 2, k = PLACE.cover, x0 = Math.round(cx - k.size / 2), c = i.cover;
    if (c && c.d && c.w > 0 && c.h > 0 && c.d.length >= c.w * c.h * 4) cv.drawImage(c.d, c.w, c.h, x0, k.y, k.size, k.size);
    else {
        cv.roundRect(x0, k.y, k.size, k.size, 12, NO_COVER);
        cv.text('TIDAL', cx, k.y + k.size / 2 + 10, 28, DIM, { align: 'center', font: 'bold', literal: true });
    }
    line(cv, i.title, PLACE.title, TEXT);
    line(cv, i.artist, PLACE.artist, SOFT);
    return cv;
}

function infoOf(p, sp) {
    if (!p || typeof p !== 'object' || !sp || typeof sp !== 'object') return null;
    const t = p.track;
    if (!t || typeof t !== 'object' || typeof p.state !== 'string' || WANT[p.state] !== true) return null;
    if (sp.connected !== true || sp.lost || sp.held || sp.taken) return null;
    return {
        title: typeof t.title === 'string' ? t.title : '',
        artist: Array.isArray(t.artists) ? t.artists.filter((a) => typeof a === 'string').join(', ') : '',
        coverId: typeof t.coverId === 'string' && t.coverId ? t.coverId : null,
    };
}

/** the client, with nothing the renderer sends able to throw: JSON that is no object is passed over (the client
 *  reads `ev.ev` of whatever parses), and an error while an event is handled goes to onBad */
class Guarded extends ClusterRender {
    constructor(app, socketPath, onBad) { super(app, socketPath); this.onBad = onBad; }
    _event(ev) {
        if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return;
        try { super._event(ev); } catch (e) { try { this.onBad(e); } catch (e2) { /* the log */ } }
    }
}

const short = (v, n) => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' ? String(v) : '?').replace(/[^\x20-\x7e]/g, ' ').slice(0, n || 60);

function createCluster(o) {
    const log = o.log || { info() {}, warn() {} };
    const sockPath = o.socketPath || DEFAULT_PATH;
    const QUIET = { info() {}, warn() {} };          // the screen's covers.js already says why a cover did not come
    let cr = null, layer = 0, key = null, shown = false, closed = false, timer = null;
    let st = { state: 'off', detail: '' }, missingAt = 0, refusedUntil = 0, askedAt = 0;
    const said = {};
    let saidN = 0;
    /** a line about the renderer: each one once, and only a few in all (a broken renderer must not fill the log) */
    function once(level, m) {
        if (said[m] || saidN >= MAX_SAID) return;
        said[m] = true; saidN++;
        log[level]('cluster: ' + m);
    }

    // the card's own covers, at its size (covers.js: asked for, decoded, scaled; a failure is tried again later)
    const pixels = {};
    const covers = createCovers({ request: o.request, decode: o.decode, size: PLACE.cover.size, slots: 2, baseId: 1, log: QUIET,
        setImage: (id, w, h, d) => { pixels[id] = { w: w, h: h, d: d }; } });
    function coverOf(coverId) {
        if (!coverId) return null;
        let c = null;
        try { c = covers.get(coverId); } catch (e) { c = null; }
        return c && pixels[c.id] ? pixels[c.id] : null;
    }

    function client() {
        if (cr) return cr;
        if (missingAt && Date.now() - missingAt < MISSING_MS) return null;
        if (!fs.existsSync(sockPath)) {
            missingAt = Date.now();
            st = { state: 'missing', detail: 'cluster-render is not installed' };
            once('info', 'cluster-render is not installed (no ' + sockPath + '): the track is not shown on the instrument cluster');
            return null;
        }
        missingAt = 0;
        const c = new Guarded('cmocan_tidal', sockPath, (e) => once('warn', 'an answer of cluster-render: ' + short(e && e.message, 100)));
        c.on('layer', (ref, state, reason) => {
            if (!layer || ref !== layer) return;
            const s = short(state, 24) || '?', why = short(reason, 80);
            st = { state: s, detail: why };
            once('info', 'the card is ' + s + (why ? ' (' + why + ')' : ''));
        });
        c.on('target', (name, state, holder, reason) => {
            if (name === 'panel' && state !== 'shown') once('info', 'the panel is ' + short(state, 24) + (holder ? ', held by ' + short(holder, 24) : '') + (reason ? ' (' + short(reason, 80) + ')' : ''));
        });
        c.on('refused', (op, ref, reason) => {
            once('warn', 'cluster-render refused ' + short(op, 16) + ': ' + short(reason, 80));
            // the layer itself refused (no panel on this car, too many layers): let go, and asked again later
            if (op === 'layer' && layer && ref === layer) { forget(); refusedUntil = Date.now() + REFUSED_MS; st = { state: 'error', detail: 'refused: ' + short(reason, 80) }; }
        });
        c.on('disconnected', () => { if (layer) st = { state: 'waiting', detail: 'cluster-render is starting again' }; });
        c.connect();
        cr = c;
        return cr;
    }

    /** the layer dropped, here and (when connected) at the renderer */
    function forget() {
        if (!layer) return;
        const ref = layer;
        layer = 0; key = null; shown = false;
        try { cr.drop(ref); } catch (e) { /* gone already */ }
    }
    function hide(why) {
        if (!layer) return;
        const was = shown;
        forget();
        if (was) log.info('cluster: the card is off (' + why + ')');
    }

    function step() {
        if (o.stopped && o.stopped()) { close(); return; }
        if (!o.Canvas) { st = { state: 'off', detail: 'no canvas' }; return; }
        if (!o.enabled()) { hide('the setting'); st = { state: 'off', detail: 'off in the settings' }; return; }
        const i = infoOf(o.player(), o.speakers());
        if (!i) { hide('nothing of ours plays on the speakers'); st = { state: 'idle', detail: 'nothing of ours plays on the speakers' }; return; }
        if (Date.now() < refusedUntil) return;
        const c = client();
        if (!c) return;
        if (!layer) {
            const p = PLACE.card;
            layer = c.image({ target: 'panel', klass: 'overlay', x: p.x, y: p.y, w: p.w, h: p.h, iw: p.w, ih: p.h, visible: 0 });
            if (!layer) { refusedUntil = Date.now() + REFUSED_MS; once('warn', 'the card does not fit the panel'); return; }
            key = null; shown = false; askedAt = Date.now();
            st = { state: 'waiting', detail: 'asking cluster-render for the panel' };
        }
        const cover = coverOf(i.coverId);
        const k = [i.title, i.artist, i.coverId || '', cover ? 1 : 0].join('\u0000');
        if (k !== key) {
            const cv = render({ title: i.title, artist: i.artist, cover: cover }, o.Canvas);
            c.pixels(layer, null, Buffer.from(cv.d.buffer, cv.d.byteOffset, cv.d.length));
            key = k;
        }
        // made hidden, shown once the renderer is there: its pixels go first (the client sends them with the hello)
        if (!shown && c.ready) { c.set(layer, { visible: 1 }); shown = true; log.info('cluster: the card is on'); }
        if (!shown && Date.now() - askedAt > SILENT_MS) once('info', 'cluster-render does not answer: no card yet');
    }
    function update() {
        if (closed) return;
        try { step(); } catch (e) { once('warn', short(e && e.message, 120) || 'failed'); }
    }
    function close() {
        closed = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (cr) { try { cr.close(); } catch (e) { /* gone */ } }
        cr = null; layer = 0; key = null; shown = false;
        st = { state: 'closed', detail: '' };
    }

    if (o.Canvas) {
        timer = setInterval(update, o.tickMs || TICK_MS);
        if (timer.unref) timer.unref();
    } else once('info', 'no pixel canvas here: the track is not shown on the instrument cluster');

    return { update: update, close: close, state: () => st };
}

/** for tidal.js: the setting "cluster", the kit's canvas and JPEG decoder; ends with the app */
function forApp(ctx, kit, x) {
    const c = createCluster({
        log: ctx.log, Canvas: kit.Canvas, decode: kit.decodeJpeg, socketPath: kit.clusterSocket, tickMs: kit.clusterTickMs,
        enabled: () => ctx.settings.get('cluster') !== false,
        request: x.request, player: x.player, speakers: x.speakers, stopped: x.stopped,
    });
    if (ctx.app && ctx.app.on) ctx.app.on('shutdown', c.close);
    return c;
}

module.exports = { createCluster: createCluster, forApp: forApp, infoOf: infoOf, render: render, PLACE: PLACE };
