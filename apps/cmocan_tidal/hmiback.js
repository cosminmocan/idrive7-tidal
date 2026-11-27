'use strict';
/**
 * hmiback.js - the HMI's back arrow and BACK key as "up one level" (task U1, docs/ui-redesign.md section 4, option A).
 *
 * The app is one RHMI screen (MAIN). The HMI's back closes it, so the app is left even inside a list. Here: when the
 * screen is hidden while a level can be popped (a list, now playing, an error), the app pops one level and opens
 * its screen again (ui.open). Not known before the car shows it: whether the reopen flickers, and that the app cannot
 * tell the HMI's back from its home key, the media key or another app taking the screen (all of them only hide the
 * screen). So it is a trial: on only while the setting is on (app.json "hmiBack", off by default). Push left on the
 * controller is back one level in any case (nav.js).
 *
 *   const hb = createHmiBack({ enabled(), canPop(), pop(), reopen(), now, setTimeout });
 *   ctx.ui.onVisible(hb.onVisible)
 * Never a loop: a hide within GUARD_MS of the last reopen is left as it is (the user leaving, or the HMI insisting),
 * and a hide of a screen that was never shown does nothing. Node 8.9.4 syntax.
 */
const SCREEN = 'MAIN';
const GUARD_MS = 2000;
const REOPEN_MS = 150;          // after the HMI's own close has gone through

function createHmiBack(o) {
    const now = o.now || Date.now, later = o.setTimeout || setTimeout;
    let shown = false, lastOpen = -Infinity;
    const safe = (fn) => { try { return fn(); } catch (e) { return undefined; } };
    function onVisible(name, visible) {
        if (name !== SCREEN) return;
        if (visible) { shown = true; return; }
        if (!shown) return;
        shown = false;
        if (!safe(o.enabled) || !safe(o.canPop) || now() - lastOpen < GUARD_MS) return;
        lastOpen = now();
        safe(o.pop);
        later(() => safe(o.reopen), REOPEN_MS);
    }
    return { onVisible: onVisible };
}

module.exports = { createHmiBack: createHmiBack, GUARD_MS: GUARD_MS };
