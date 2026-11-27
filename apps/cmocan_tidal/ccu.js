'use strict';
/**
 * ccu.js - the iDrive controller's raw state (FrontCCU.statusRotaryEncoderState, as the kit's ctx.controller.onInput
 * hands it: numbers) to steps: { knob: d }, { press: true }, { tilt: 'N' | 'E' | 'S' | 'W' }. As the kit's
 * display.js reads it: the knob is a 16-bit counter (wraps), a press and a push count once, when they start;
 * 15 / 15 is no controller (a VM); a jump of more than 64 steps is a counter reset.
 *
 *   const onInput = createCcu((step) => ...);   ctx.controller.onInput(onInput)
 * Node 8.9.4 syntax.
 */
const TILT = { 1: 'N', 2: 'N', 4: 'E', 5: 'E', 7: 'S', 8: 'S', 10: 'W', 11: 'W' };
const down = (x) => x === 1 || x === 2;

function createCcu(emit) {
    let last = null;
    return function onInput(v) {
        if (!v || typeof v !== 'object') return;
        const k = Number(v.frontRotaryEncoderOperation), pb = Number(v.frontRotaryEncoderPushButton), df = Number(v.frontRotaryEncoderDeflection);
        if (!isFinite(k) || !isFinite(pb) || !isFinite(df) || v.frontRotaryEncoderOperation === null) return;
        const L = last;
        last = { k: k, pb: pb, df: df };
        if (pb === 15 && df === 15) return;
        let d = L ? ((k - L.k + 32768) & 0xffff) - 32768 : 0;
        if (Math.abs(d) > 64) d = 0;
        const out = [];
        if (d) out.push({ knob: d });
        if (down(pb) && !(L && down(L.pb))) out.push({ press: true });
        const tilt = TILT[df] && !(L && TILT[L.df] === TILT[df]) ? TILT[df] : null;
        if (tilt) out.push({ tilt: tilt });
        out.forEach((e) => { try { emit(e); } catch (err) { /* the app's own */ } });
    };
}

module.exports = { createCcu: createCcu, TILT: TILT };
