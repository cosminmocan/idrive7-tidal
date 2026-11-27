'use strict';
/**
 * wheel.js - the steering wheel's skip buttons: right (>) the next track, left (<) the previous one, once per press,
 * on release; held longer than 0.7 s they wind instead, 10 s for every 0.5 s held, and the press is then never a
 * skip. Only while one of our tracks is on (so the radio or another app keeps its own buttons).
 *
 * The buttons reach apps through de.bmw.infotainment.controlelements.SteeringWheelPushButton, instance 1, field
 * statusSearchSwitch1: its operationPushButtonAudioAutomaticTuningSteeringWheel is SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS
 * (right) or SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS (left) while held, KEINE_AKTION once let go. This is what aurelmarius'
 * apps saw in the car (bmw-apps, apps/aurelm_tvhplayer/wheel.js, GPL-3.0-or-later; written again here for tracks).
 * The field says "held" when the press starts (and may say it again); how long it is held is our own clock.
 *
 *   const w = createWheel({ skip(dir), active(), seek: { step(dir), end() }, setTimeout, clearTimeout });
 *   w.onSwitch(value)      the field's value (the struct, or the string)
 *
 * seek.step(dir) is called at 0.7 s and then every 0.5 s while held, seek.end() once at the release (the app sends
 * one `seek` then: a seek costs the service a new player, so not one per step). A release that never comes (the
 * signal lost) ends the winding after MAX_HOLD_MS. Without `seek`, a press of any length is a skip, as before.
 * Node 8.9.4 syntax.
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const FIELD = 'statusSearchSwitch1';
const HOLD_MS = 700;            // a press let go before this is a skip
const STEP_MS = 500;            // one step for each of these held after it
const MAX_HOLD_MS = 30000;

function createWheel(o) {
    const later = o.setTimeout || setTimeout, never = o.clearTimeout || clearTimeout;
    const seek = o.seek && typeof o.seek.step === 'function' ? o.seek : null;
    let down = 0, seen = 0, timer = null, long = false, winding = false, held = 0;

    function isOn() { try { return !!o.active(); } catch (e) { return false; } }
    function endWinding() {
        if (timer) { never(timer); timer = null; }
        if (!winding) return;
        winding = false;
        try { if (seek.end) seek.end(); } catch (e) { /* the app's own */ }
    }
    /** the press is a long one: a step now, and one more every STEP_MS while it is held and a track is on */
    function wind() {
        timer = null;
        if (!down) return;
        const first = !long;
        long = true;
        held += first ? HOLD_MS : STEP_MS;
        if ((!first && !winding) || !isOn() || held > MAX_HOLD_MS) { endWinding(); return; }
        winding = true;
        try { seek.step(down); } catch (e) { /* the app's own */ }
        timer = later(wind, STEP_MS);
    }
    function press(d) {
        if (down) return;                               // "held" said again
        down = d; long = false; winding = false; held = 0;
        if (seek) timer = later(wind, HOLD_MS);
    }
    function onSwitch(v) {
        const val = v && typeof v === 'object' ? v.operationPushButtonAudioAutomaticTuningSteeringWheel : v;
        if (typeof val !== 'string') return;
        if (/SKIP_RECHTS/.test(val)) { press(1); return; }
        if (/SKIP_LINKS/.test(val)) { press(-1); return; }
        if (!/KEINE_AKTION/.test(val) || !down) return;
        const d = down, wasLong = long;
        down = 0;
        endWinding();
        if (wasLong || !isOn()) return;
        seen++;
        try { o.skip(d); } catch (e) { /* the app's own */ }
    }
    return { onSwitch: onSwitch, seen: () => seen };
}

module.exports = { createWheel: createWheel, IFACE: IFACE, FIELD: FIELD, HOLD_MS: HOLD_MS, STEP_MS: STEP_MS };
