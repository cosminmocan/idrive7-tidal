'use strict';
/**
 * wheel.js - skip on the steering wheel: right (>) the next track, left (<) the previous one, once per press, on
 * release, and only while one of our tracks is on (so the radio or another app keeps its own skip).
 *
 * The buttons reach apps through de.bmw.infotainment.controlelements.SteeringWheelPushButton, instance 1, field
 * statusSearchSwitch1: its operationPushButtonAudioAutomaticTuningSteeringWheel is SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS
 * (right) or SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS (left) while held, KEINE_AKTION once let go. This is what aurelmarius'
 * apps saw in the car (bmw-apps, apps/aurelm_tvhplayer/wheel.js, GPL-3.0-or-later; written again here for tracks).
 *
 *   const w = createWheel({ skip(dir), active() });
 *   w.onSwitch(value)      the field's value (the struct, or the string)
 * Node 8.9.4 syntax.
 */
const IFACE = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const FIELD = 'statusSearchSwitch1';

function createWheel(o) {
    let down = 0, seen = 0;
    function onSwitch(v) {
        const val = v && typeof v === 'object' ? v.operationPushButtonAudioAutomaticTuningSteeringWheel : v;
        if (typeof val !== 'string') return;
        if (/SKIP_RECHTS/.test(val)) { if (!down) down = 1; return; }
        if (/SKIP_LINKS/.test(val)) { if (!down) down = -1; return; }
        if (!/KEINE_AKTION/.test(val) || !down) return;
        const d = down;
        down = 0;
        let on = false;
        try { on = !!o.active(); } catch (e) { on = false; }
        if (!on) return;
        seen++;
        try { o.skip(d); } catch (e) { /* the app's own */ }
    }
    return { onSwitch: onSwitch, seen: () => seen };
}

module.exports = { createWheel: createWheel, IFACE: IFACE, FIELD: FIELD };
