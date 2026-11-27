'use strict';
/**
 * U1 (phase 2): the HMI's back arrow and BACK key. The app is one RHMI screen, so the HMI's back closes it and the
 * app is left (docs/ui-redesign.md section 1). Option A's answer (section 4): when the HMI closes the screen while a
 * list (or now playing, or an error) is open, the app goes up one level and opens its screen again
 * (apps/cmocan_tidal/hmiback.js). The app cannot tell the HMI's back from its home key or another app taking the
 * screen: all three only hide the screen. So it is a trial behind a setting (off by default) until the car shows how
 * it behaves; push left on the controller is back one level in any case (tests/app_nav.test.js).
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { createHmiBack } = require('../apps/cmocan_tidal/hmiback');
const { kitApp } = require('./lib/kit_display');
const { createFakeService } = require('./fakes/fake_service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-hb-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + what);
}

function fake(o) {
    let t = 0, level = o.level;
    const log = [];
    const hb = createHmiBack({
        enabled: () => o.on !== false, canPop: () => level > 0, pop: () => { level--; log.push('pop'); }, reopen: () => log.push('open'),
        now: () => t, setTimeout: (fn) => { fn(); return 0; },
    });
    return { hb: hb, log: log, at: (ms) => { t = ms; }, level: () => level };
}

test('the screen hidden while a level is open: up one level and the screen again; on the top level: left closed', () => {
    const f = fake({ level: 2 });
    f.hb.onVisible('MAIN', true);
    f.at(5000); f.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(f.log, ['pop', 'open']);
    f.hb.onVisible('MAIN', true);
    f.at(10000); f.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(f.log, ['pop', 'open', 'pop', 'open']);
    f.hb.onVisible('MAIN', true);
    f.at(15000); f.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(f.log, ['pop', 'open', 'pop', 'open'], 'My music: the HMI\'s back leaves the app');
    f.hb.onVisible('SETTINGS', false);
    assert.strictEqual(f.log.length, 4, 'other screens are not ours to watch');
});

test('never a loop: hidden again within 2 s of opening it again is left closed; off: nothing at all', () => {
    const f = fake({ level: 5 });
    f.hb.onVisible('MAIN', true);
    f.at(1000); f.hb.onVisible('MAIN', false);
    f.hb.onVisible('MAIN', true);
    f.at(1500); f.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(f.log, ['pop', 'open'], 'the second hide is the user leaving (or the HMI insisting)');
    const off = fake({ level: 2, on: false });
    off.hb.onVisible('MAIN', true);
    off.at(5000); off.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(off.log, []);
    const never = fake({ level: 2 });
    never.hb.onVisible('MAIN', false);
    assert.deepStrictEqual(never.log, [], 'hidden without having been shown: nothing');
});

test('the app on the kit: the setting on, the HMI closes the screen in a list: one level up, the screen open again', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const h = await kitApp({ socketPath: sock, settings: { hmiBack: true } });
    try {
        await waitFor(() => h.app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        h.app.act({ type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } });
        await sleep(2100);
        h.ui.close('MAIN');                                   // what the HMI's back does to the app's screen
        await waitFor(() => h.opened.indexOf('MAIN') >= 0, 2000, 'opened again');
        assert.strictEqual(h.app.state().screen, 'LIBRARY', 'one level up');
        assert.ok(h.ui.isVisible('MAIN'));
        await sleep(2100);
        h.ui.close('MAIN');
        await sleep(300);
        assert.strictEqual(h.opened.length, 1, 'from My music it leaves');
        assert.ok(!h.ui.isVisible('MAIN'));
    } finally { h.close(); await svc.close(); }
});

test('the app: the setting is there, off by default (the car decides it)', () => {
    const spec = require('../apps/cmocan_tidal/app.json');
    const s = spec.settings.filter((x) => x.key === 'hmiBack')[0];
    assert.ok(s, 'a setting');
    assert.strictEqual(s.type, 'bool');
    assert.strictEqual(s.default, false);
});

run();
