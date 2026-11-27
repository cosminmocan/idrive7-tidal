'use strict';
/**
 * kitfocus.js - the app's one controller rule and its one highlight where the kit runs the screen (task U1).
 *
 * With the Store's renderer (mgu-render/1, full-screen layout) the kit's display (kit/runtime/display.js) holds the
 * iDrive controller and handles it itself: its gpu 'ccu' handler calls display._ccu, never the app's ctx.controller
 * handler (display.js: `if (this.onCcu && !this.own()) this.onCcu(v); else this._ccu(v)`), and _ccu walks one chain
 * of the header's tabs, the page's targets and the bar (docs/ui-redesign.md section 1: the first turn on SETTINGS,
 * push left closing the app). Its focus (display.focusKey, display.focused) is drawn by display._drawChrome: the
 * tab's ring, the bar button lit, and a white ring round the page target it is on.
 *
 * Two small hooks on that display object, as tidal.js already wrapped its _focus (the kit's files stay as they are):
 *   _ccu         the controller goes to the app's rule (nav.js: input(step)), decoded as ccu.js does; only while one
 *                of the kit's sheets is open (the settings, the QR log) does the kit's own _ccu have it. The kit's
 *                last controller state (ccuLast) is kept in step, so a sheet opened later starts from there.
 *   _drawChrome  draws as before but no ring of its own on the page: there the app draws the one highlight.
 * and sync(): the kit's focus is set (display._focus) to where the app's is (place(): { k: 'bar:BTN_PLAY', bar } |
 * { k: 'tab:2', tab } | { k: 'tgt:row:3' } | null), so the kit lights the bar button or tab the app's rule is on, and
 * its key names the page target the app highlights.
 *
 *   const kf = hookDisplay(display, { input(step), place() });  // null when the display has no such parts
 *   kf.sync()      after the app's state changed and before each frame
 *   kf.own()       the kit runs the screen now (bar presses then go through display._click, as the HMI's do)
 * Node 8.9.4 syntax.
 */
const { createCcu } = require('./ccu');

function hookDisplay(disp, o) {
    if (!disp || typeof disp._ccu !== 'function' || typeof disp._focus !== 'function') return null;
    let toKit = false;
    const steps = createCcu((step) => { if (!toKit) o.input(step); });
    const ccu0 = disp._ccu.bind(disp);
    disp._ccu = (v) => {
        toKit = !!disp.sheet;
        steps(v);                                   // (its own last state follows every event)
        if (toKit) return ccu0(v);
        if (v && typeof v === 'object') {
            const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
            if (isFinite(k) && isFinite(pb) && isFinite(df)) disp.ccuLast = { k: k, pb: pb, df: df };
        }
        sync();
        return undefined;
    };
    if (typeof disp._drawChrome === 'function') {
        const chrome0 = disp._drawChrome.bind(disp);
        disp._drawChrome = (r) => {
            const k = disp.focusKey;
            if (typeof k !== 'string' || k.indexOf('tgt:') !== 0) return chrome0(r);
            disp.focusKey = null;
            try { return chrome0(r); } finally { disp.focusKey = k; }
        };
    }
    function own() { try { return typeof disp.own === 'function' && !!disp.own(); } catch (e) { return false; } }
    function sync() {
        if (disp.sheet || !own()) return;
        let p = null;
        try { p = o.place(); } catch (e) { p = null; }
        const k = p ? p.k : null, bar = p && p.bar ? p.bar : null;
        if (disp.focusKey === k && (disp.focused || null) === bar) return;
        disp._focus(p);
        if (typeof disp._repaint === 'function') disp._repaint();
    }
    return { sync: sync, own: own };
}

module.exports = { hookDisplay: hookDisplay };
