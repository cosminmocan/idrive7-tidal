'use strict';
/**
 * Phase 4, small fix: `openEntryState ... INVALID_UUID` when the app is opened right after a popup (the car's log,
 * docs/car-logs/2026-11-28-video-first-run.log, 16:36:23). kit/runtime/mgu.js opens the main screen on a tile tap
 * (entryPointExecute) with ui.rhmi.openEntryState; right after a popup the HMI can refuse it once (INVALID_UUID /
 * INVALID_COMPONENTID). Then it is asked again, 0.8 s apart, 3 tries at most, without an ERROR line; any other
 * error is logged once and not asked again; a second tap while a try or its wait is under way starts no second chain.
 * mgu.js's real run() with an SDK stand-in whose RHMI application answers openEntryState as each test says
 * (kit/tools/kit_harness.js, its stand-in replaced by one with screens). Node 8.9.4 syntax.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { harness } = require('../kit/tools/kit_harness');

process.env.MGU_PANIC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-entry-panic-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = '2661afa3-1d8c-5c9d-8ac2-6a96f37f7f99';
// the SDK's error as the car logged it
const refused = (what) => new Error('RhmiApplication[687e3e4e-4a12-5a49-b2bc-83e7c07512df]::openEntryState(' + UUID + ') failed due to { RemoteError: \'' + what + '\' }');

// the SDK stand-in: an RHMI application whose components answer everything, openEntryState as global.__kitEntry says
const SDK = [
    "const EventEmitter = require('events');",
    'const ok = () => Promise.resolve();',
    'class Comp extends EventEmitter {',
    '    constructor(n) { super(); this.name = n; }',
    '    getId() { return 7; } updateResources() { return ok(); } setValue() { return ok(); } setProperty() { return ok(); } setRowCount() { return ok(); }',
    '}',
    'class Rhmi extends EventEmitter {',
    '    constructor() { super(); this.comps = {}; }',
    "    getByName(n) { if (n === 'KIT_HMI_ID8') return null; return this.comps[n] || (this.comps[n] = new Comp(n)); }",
    '    mapEntryState(uuid) { global.__kitEntry.mapped.push(uuid); return ok(); }',
    '    openEntryState(uuid) { return global.__kitEntry.open(uuid); }',
    '    openState() { return ok(); } closeState() { return ok(); } getResourceBundle() { return {}; }',
    '}',
    'class OnlineApp extends EventEmitter {',
    '    constructor() { super(); this.rhmiApplication = new Rhmi(); this.startReason = "TEST"; global.__kitEntry.app = this; }',
    '    async start() {} async registerActive() {} async initialized() {} async registerHmiVisible() {} async unregisterHmiVisible() {}',
    '}',
    'const quiet = { info() {}, warn() {}, error() {}, debug() {} };',
    'module.exports = { OnlineApp, logging: { getSDKLogger: () => quiet } };',
].join('\n');

/** mgu.run() with one entry point; answers: what each openEntryState call does in turn (an Error rejects, a
 *  number waits that many ms and resolves, a function's promise is the answer); later calls resolve */
async function start(answers) {
    const h = harness({ id: 'entry', screens: [], settings: [] });
    fs.writeFileSync(path.join(h.root, 'node_modules', 'oap-sdk', 'index.js'), SDK);
    fs.mkdirSync(path.join(h.root, 'rhmiData'));
    fs.writeFileSync(path.join(h.root, 'rhmiData', 'application.json'), JSON.stringify({ application: { entryPoints: [{ uuid: UUID }] } }));
    const calls = [];
    const st = global.__kitEntry = {
        mapped: [], calls: calls, app: null,
        open(uuid) {
            const a = answers[calls.length];
            calls.push({ uuid: uuid, t: Date.now() });
            if (typeof a === 'function') return a();
            if (a instanceof Error) return Promise.reject(a);
            if (typeof a === 'number') return sleep(a);
            return Promise.resolve();
        },
    };
    await h.start({});
    const tap = () => st.app.emit('entryPointExecute', UUID, 'ENTRY_POINT', 'CMOCAN_TIDAL_ENTRY');
    const errors = () => h.log().split('\n').filter((l) => / ERROR /.test(l));
    return { h: h, calls: calls, tap: tap, errors: errors };
}
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + what);
}

test('INVALID_UUID on the first try, the second goes through: asked again, no ERROR line', async () => {
    const s = await start([refused('INVALID_UUID')]);
    s.tap();
    await waitFor(() => s.calls.length >= 2, 3000, 'a second openEntryState');
    await sleep(1200);
    assert.strictEqual(s.calls.length, 2, 'no third try after the second went through');
    assert.ok(s.calls[1].t - s.calls[0].t >= 700, 'about 0.8 s apart: ' + (s.calls[1].t - s.calls[0].t) + ' ms');
    assert.ok(s.calls.every((c) => c.uuid === UUID));
    assert.deepStrictEqual(s.errors(), [], 'a refusal that a second try cures is no error');
});

test('INVALID_COMPONENTID is treated the same', async () => {
    const s = await start([refused('INVALID_COMPONENTID')]);
    s.tap();
    await waitFor(() => s.calls.length >= 2, 3000, 'a second openEntryState');
    assert.deepStrictEqual(s.errors(), []);
});

test('any other error: logged once, not asked again', async () => {
    const s = await start([refused('TIMEOUT')]);
    s.tap();
    await waitFor(() => s.errors().length >= 1, 3000, 'the ERROR line');
    await sleep(1500);
    assert.strictEqual(s.calls.length, 1, 'one try only');
    assert.strictEqual(s.errors().length, 1, s.errors().join('\n'));
    assert.ok(/ERROR open entry state .*TIMEOUT/.test(s.errors()[0]), s.errors()[0]);
});

test('refused every time: 3 tries 0.8 s apart, then one ERROR line', async () => {
    const s = await start([refused('INVALID_UUID'), refused('INVALID_UUID'), refused('INVALID_UUID'), refused('INVALID_UUID')]);
    s.tap();
    await waitFor(() => s.errors().length >= 1, 5000, 'the ERROR line');
    await sleep(1500);
    assert.strictEqual(s.calls.length, 3, 'three tries: ' + s.calls.length);
    for (let i = 1; i < 3; i++) assert.ok(s.calls[i].t - s.calls[i - 1].t >= 700, 'try ' + (i + 1) + ' after ' + (s.calls[i].t - s.calls[i - 1].t) + ' ms');
    assert.strictEqual(s.errors().length, 1, s.errors().join('\n'));
    assert.ok(/ERROR open entry state .*INVALID_UUID/.test(s.errors()[0]));
});

test('a second tap while a try or its wait is under way starts no second chain; a tap after it opens again', async () => {
    // the first try is refused after 200 ms, the second waits 300 ms and goes through
    const s = await start([() => sleep(200).then(() => { throw refused('INVALID_UUID'); }), 300]);
    s.tap();
    s.tap();                                        // MainApp's own double (UNSPECIFIED, then ENTRY_POINT), during the try
    await waitFor(() => s.calls.length >= 1, 2000, 'the first try');
    await sleep(300);
    s.tap();                                        // in the 0.8 s wait before the second try
    await waitFor(() => s.calls.length >= 2, 3000, 'the second try');
    s.tap();                                        // during the second try
    await sleep(1500);
    assert.strictEqual(s.calls.length, 2, 'one chain: ' + s.calls.length + ' tries');
    assert.deepStrictEqual(s.errors(), []);
    s.tap();
    await waitFor(() => s.calls.length >= 3, 2000, 'a later tap\'s own try');
    assert.deepStrictEqual(s.errors(), []);
});

run().then(() => process.exit(process.exitCode || 0));
