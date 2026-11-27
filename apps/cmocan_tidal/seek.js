'use strict';
/**
 * seek.js - where the user wants the track to go, and when the service is told (`seek {position}`,
 * docs/PROTOCOL.md section 1). The finger on the progress bar, the controller on it and the steering wheel's held
 * skip buttons all move one target; the bar shows it from the first move until the service answered.
 *
 *   const sk = createSeeker({ where, send, onDone, onChange, now, setTimeout, clearTimeout });
 *     where()  -> { pos, dur, key }    what the bar shows now (seconds; dur null when not known) and which track it
 *                                      is (key null: nothing to seek in)
 *     send(position) -> Promise        the request; its answer ({ ok, id, ... }, or anything: rule R1)
 *     onDone(position, answer)         the service took it (ok): progress.js carries on from there
 *     onChange()                       the target changed or went: draw again
 *   sk.nudge(steps)     the target moves by steps x 10 s (from the target, or from the position shown); false when
 *                       there is nothing to seek in
 *   sk.set(position)    the target is position (the finger)
 *   sk.commit(delayMs)  send the target delayMs after now (the knob: 500 ms after its last step; a lifted finger
 *                       and a released wheel button: 0)
 *   sk.target()         the target while there is one (not yet sent, or sent and not answered), else null
 *   sk.cancel()
 *
 * A seek costs the service a new player and the track's download from its start, so: one request at a time, never
 * two within SEND_GAP_MS (at most 2 a second), and a target that changed while one was on its way goes out after its
 * answer. A target for another track than the one on is dropped, as is one that nobody commits (a finger that
 * never lifts: the touch went to a sheet). The target stops END_GAP_S before the end, so a seek is never a skip.
 * Node 8.9.4 syntax.
 */
const STEP_S = 10;
const SEND_GAP_MS = 500;
const END_GAP_S = 2;
const FORGET_MS = 60000;

const isNum = (v) => typeof v === 'number' && isFinite(v);

function createSeeker(o) {
    const now = o.now || Date.now;
    const later = o.setTimeout || setTimeout, never = o.clearTimeout || clearTimeout;
    let target = null, key = null;      // the target and the track it is for
    let dirty = false;                  // the target is newer than what was sent
    let timer = null, flying = false, again = false, lastSent = -Infinity, touched = 0;

    function changed() { if (o.onChange) { try { o.onChange(); } catch (e) { /* the app's own */ } } }
    function here() {
        let w = null;
        try { w = o.where(); } catch (e) { w = null; }
        if (!w || typeof w !== 'object' || w.key == null) return null;
        return { pos: isNum(w.pos) && w.pos > 0 ? w.pos : 0, dur: isNum(w.dur) && w.dur > 0 ? w.dur : null, key: w.key };
    }
    function drop() {
        if (timer) { never(timer); timer = null; }
        const had = target != null;
        target = null; key = null; dirty = false; again = false;
        return had;
    }
    function cancel() { if (drop()) changed(); }
    /** the track to seek in, or null; a target for another track goes */
    function begin() {
        const h = here();
        if (target != null && (!h || h.key !== key)) drop();
        return h;
    }
    function aim(h, pos) {
        const max = h.dur != null ? Math.max(0, h.dur - END_GAP_S) : Infinity;
        target = Math.max(0, Math.min(max, pos));
        key = h.key; dirty = true; touched = now();
        changed();
        return true;
    }
    function nudge(steps) {
        const h = begin();
        if (!h || !isNum(steps) || !steps) return false;
        return aim(h, (target != null ? target : h.pos) + steps * STEP_S);
    }
    function set(pos) {
        const h = begin();
        if (!h || !isNum(pos)) return false;
        return aim(h, pos);
    }

    function commit(delayMs) {
        if (target == null || !dirty) return;
        if (timer) never(timer);
        const t = now(), at = Math.max(t + (isNum(delayMs) && delayMs > 0 ? delayMs : 0), lastSent + SEND_GAP_MS);
        timer = later(fire, at - t);
    }
    function fire() {
        timer = null;
        if (target == null || !dirty) return;
        if (flying) { again = true; return; }           // after its answer
        const h = here();
        if (!h || h.key !== key) { cancel(); return; }
        const pos = Math.round(target * 10) / 10;
        dirty = false; again = false; flying = true; lastSent = now();
        Promise.resolve().then(() => o.send(pos)).catch(() => null).then((a) => {
            flying = false;
            const ok = !!(a && typeof a === 'object' && a.ok === true);
            if (dirty) { if (again) commit(0); return; }      // a newer target: it is the one shown
            if (target == null) return;                       // cancelled meanwhile
            target = null; key = null;
            if (ok && o.onDone) { try { o.onDone(pos, a); } catch (e) { /* the app's own */ } }
            changed();
        });
    }

    function shown() {
        if (target == null) return null;
        const h = here();
        if (!h || h.key !== key) { drop(); return null; }
        if (dirty && !timer && !flying && now() - touched > FORGET_MS) { drop(); return null; }
        return target;
    }

    return { nudge: nudge, set: set, commit: commit, cancel: cancel, target: shown };
}

/** the position a point on the bar stands for: bar = { x, w, dur } (screens.js), x in the same px */
function barPosition(bar, x) {
    if (!bar || !isNum(bar.w) || bar.w <= 0 || !isNum(bar.dur) || !isNum(x)) return null;
    return Math.max(0, Math.min(1, (x - bar.x) / bar.w)) * bar.dur;
}

/**
 * The finger on the bar, for the kit's ctx.onTouch: fn(phase, x, y), phase 1 down, 2 move, 3 up. A down on the bar's
 * place (hit(x, y) -> its { x, w, dur } or null) takes the gesture (true); the target follows the finger wherever
 * it goes, and is sent when it lifts.
 */
function barTouch(sk, hit) {
    let bar = null;
    return function onTouch(phase, x, y) {
        if (phase === 1) {
            bar = null;
            let b = null;
            try { b = hit(x, y); } catch (e) { b = null; }
            const pos = barPosition(b, x);
            if (pos == null || !sk.set(pos)) return false;
            bar = b;
            return true;
        }
        if (!bar) return false;
        const pos = barPosition(bar, x);
        if (pos != null) sk.set(pos);
        if (phase === 3) { bar = null; sk.commit(0); }
        return true;
    };
}

module.exports = { createSeeker: createSeeker, barPosition: barPosition, barTouch: barTouch, STEP_S: STEP_S, SEND_GAP_MS: SEND_GAP_MS };
