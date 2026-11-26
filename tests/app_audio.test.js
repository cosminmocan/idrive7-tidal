'use strict';
/**
 * D6: the speakers and the volume. car_audio.js and car_volume.js are aurelmarius' (bmw-apps @0976d16,
 * apps/aurelm_tvhplayer, GPL-3.0-or-later) copied unchanged, sharing the claims folder /tmp/aurelm-287 with his apps;
 * apps/cmocan_tidal/audio.js ties them to our player. Against a fake audio manager (after aurelmarius'
 * tests/car_audio_claims.test.js): the route only while a track plays; pause or stop releases it; only our own
 * connection is ever disconnected; a leftover from a crash in this boot is cleared, one from an earlier boot is
 * forgotten; the car taking the speakers pauses us and they are not taken back until play in our app (rule R7);
 * another app claiming them later makes ours let go and pause.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const { defaultState, TRACK } = require('./fakes/fake_service');
const APP = path.join(__dirname, '..', 'apps', 'cmocan_tidal');
const { createCarAudio } = require(path.join(APP, 'car_audio'));
const { createAudio } = require(path.join(APP, 'audio'));
const M = require(path.join(APP, 'model'));
const S = require(path.join(APP, 'screens'));

// one audio manager for every app: connections by id
function fakeAm() {
    const list = [];
    let next = 40;
    const calls = [];
    return {
        calls, list,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        on: () => Promise.resolve(),
        call: (p, method, args) => {
            calls.push({ method, args });
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: list.slice() });
            if (method === 'disconnect') { const i = list.findIndex((c) => c.mainConnectionID === args.mainConnectionID); if (i >= 0) list.splice(i, 1); }
            if (method === 'connect') { const id = next++; list.push({ mainConnectionID: id, sourceID: 287 }); return Promise.resolve({ amError: 'E_OK', mainConnectionID: id }); }
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
}
const log = { info() {}, warn() {} };
const settle = (ms) => new Promise((r) => setTimeout(r, ms || 60));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-claims-'));
const player = (state) => ({ state: state, track: state === 'idle' ? null : TRACK, position: 1, duration: 320, queueIndex: 0, queueLength: 1, quality: 'HIGH', error: null });
const disconnected = (am) => am.calls.filter((c) => c.method === 'disconnect').map((c) => c.args.mainConnectionID);
const connects = (am) => am.calls.filter((c) => c.method === 'connect').length;
function ours(am, extra) {
    const sent = [];
    const a = createAudio(Object.assign({ signals: am, log, file: path.join(dir(), 'car-audio.json'), claimDir: dir(), bootId: () => 'boot-1', send: (cmd) => sent.push(cmd) }, extra || {}));
    return { a, sent };
}
/** each status calls update(); the module looks again every second or two, as in the car */
async function statuses(a, p, n, ms) { for (let i = 0; i < (n || 1); i++) { a.update(p); await settle(ms || 60); } }

test('car_audio.js and car_volume.js are aurelmarius\' files, unchanged', () => {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(APP, f))).digest('hex');
    assert.strictEqual(sha('car_audio.js'), '1a6be46a7623d35450c31a18ac63ec511d02048beab9754fc1d78f11697fff2f');
    assert.strictEqual(sha('car_volume.js'), '0b8bd7179c773c623566ebb3d0c9abe9b7b5d08a7ace886775454830f5c18fcf');
    assert.ok(/car_audio\.js[\s\S]*aurelmarius[\s\S]*GPL-3\.0/.test(fs.readFileSync(path.join(APP, 'NOTICE'), 'utf8')), 'origin noted in NOTICE');
});

test('app.json declares what the audio manager calls need (and the claims folder is aurelmarius\' one)', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const cc = spec.signals['org.genivi.am.commandinterface.CommandControl'];
    assert.deepStrictEqual(cc._methods.slice().sort(), ['connect', 'disconnect', 'getListMainConnections', 'getListMainSinks']);
    assert.deepStrictEqual(cc._broadcasts.slice().sort(), ['sinkMuteStateChanged', 'volumeChanged']);
    assert.deepStrictEqual(spec.signals['org.genivi.am.routinginterface.RoutingControlObserver']._methods, ['hookSourceAvailablityStatusChange']);
    assert.ok(/'\/tmp\/aurelm-287'/.test(fs.readFileSync(path.join(APP, 'car_audio.js'), 'utf8')));
    assert.ok(!/claimDir:/.test(fs.readFileSync(path.join(APP, 'main.js'), 'utf8')), 'main.js keeps the shared default folder');
});

test('the route is asked for only while a track plays; pause or stop releases it', async () => {
    const am = fakeAm();
    const { a } = ours(am);
    await statuses(a, player('idle'), 3);
    await statuses(a, null, 1);
    assert.strictEqual(connects(am), 0, 'nothing plays: no route');
    await statuses(a, player('loading'), 2);
    assert.strictEqual(connects(am), 1, 'on its way: connected');
    assert.strictEqual(a.state().connected, true);
    await statuses(a, player('playing'), 3);
    assert.strictEqual(connects(am), 1, 'once');
    await statuses(a, player('paused'), 2);
    assert.strictEqual(a.state().connected, false);
    assert.strictEqual(am.list.length, 0, 'paused: released');
    await statuses(a, player('playing'), 2);
    assert.strictEqual(a.state().connected, true);
    await statuses(a, player('idle'), 2);
    assert.strictEqual(am.list.length, 0, 'stopped: released');
    await statuses(a, player('playing'), 2);
    await statuses(a, player('error'), 2);
    assert.strictEqual(am.list.length, 0, 'player error: released');
});

test('only our own connection id is ever disconnected (another app\'s 287 connection is left alone)', async () => {
    const am = fakeAm();
    am.list.push({ mainConnectionID: 9, sourceID: 287 });            // another app's, with no claim (the old rule)
    const { a } = ours(am);
    await statuses(a, player('playing'), 5, 120);
    assert.strictEqual(a.state().connected, false);
    assert.strictEqual(a.state().taken, true);
    await statuses(a, player('paused'), 2);
    assert.deepStrictEqual(am.list.map((c) => c.mainConnectionID), [9]);
    assert.deepStrictEqual(disconnected(am), [], 'never theirs');
    am.list.length = 0;                                               // they stop
    await statuses(a, player('playing'), 25, 120);
    assert.strictEqual(a.state().connected, true);
    const mine = am.list[0].mainConnectionID;
    await statuses(a, player('paused'), 2);
    assert.deepStrictEqual(disconnected(am), [mine]);
});

test('a connection a crash left in this boot is cleared at start; one from an earlier boot is forgotten, not disconnected', async () => {
    let am = fakeAm();
    am.list.push({ mainConnectionID: 41, sourceID: 287 });
    let file = path.join(dir(), 'car-audio.json');
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 41, bootId: 'boot-1' }));
    ours(am, { file });
    await settle(100);
    assert.deepStrictEqual(disconnected(am), [41], 'ours from this boot: disconnected');
    assert.ok(!fs.existsSync(file), 'and forgotten');
    am = fakeAm();
    am.list.push({ mainConnectionID: 41, sourceID: 287 });            // the id now belongs to someone else
    file = path.join(dir(), 'car-audio.json');
    fs.writeFileSync(file, JSON.stringify({ mainConnectionID: 41, bootId: 'boot-0' }));
    ours(am, { file });
    await settle(100);
    assert.deepStrictEqual(disconnected(am), [], 'from an earlier boot: never disconnected');
    assert.ok(!fs.existsSync(file), 'forgotten');
});

test('the driver chooses another source: playback pauses, and the speakers are not taken back until play in our app (R7)', async () => {
    const am = fakeAm();
    const { a, sent } = ours(am);
    await statuses(a, player('playing'), 2);
    assert.strictEqual(a.state().connected, true);
    am.list.length = 0;                                               // the audio manager ended ours (the radio)
    for (let i = 0; i < 30 && sent.indexOf('pause') < 0; i++) await statuses(a, player('playing'), 1, 150);
    assert.deepStrictEqual(sent, ['pause'], 'paused');
    const n = connects(am);
    await statuses(a, player('playing'), 20, 120);                    // still reported playing for a while
    assert.strictEqual(connects(am), n, 'not taken back');
    await statuses(a, player('paused'), 2);
    await statuses(a, player('playing'), 3);                          // e.g. resumed from elsewhere: still not ours to take
    assert.strictEqual(connects(am), n, 'not taken back without our play');
    a.userPlay();                                                     // the driver presses play in our app
    await statuses(a, player('playing'), 3);
    assert.strictEqual(connects(am), n + 1, 'taken back after our play');
    assert.strictEqual(a.state().connected, true);
});

test('another app claims the speakers later: ours lets go and pauses', async () => {
    const am = fakeAm();
    const claims = dir();
    const { a, sent } = ours(am, { claimDir: claims });
    await statuses(a, player('playing'), 2);
    assert.strictEqual(a.state().connected, true);
    await settle(10);
    const other = createCarAudio(am, log, { file: path.join(dir(), 'x.json'), app: 'Music Assistant', claimDir: claims, bootId: () => 'boot-1' });
    other.want(true);
    for (let i = 0; i < 30 && !other.state().connected; i++) { a.update(player('playing')); other.want(true); await settle(150); }
    assert.strictEqual(other.state().connected, true, 'the newer app has them');
    assert.strictEqual(a.state().connected, false);
    assert.deepStrictEqual(sent, ['pause']);
    assert.strictEqual(am.list.length, 1);
});

test('the car\'s volume: a popup over the page while it changes, Mute while muted', () => {
    const t = themes.theme('m_tricolour');
    const s = M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { login: 'logged-in' }) });
    let cv = spyCanvas();
    S.draw(cv, t, s, { volume: { volume: 23, muted: false, max: 62 } });
    assert.ok(cv.has('23'), cv.all());
    cv = spyCanvas();
    S.draw(cv, t, s, { volume: { volume: 23, muted: true, max: 62 } });
    assert.ok(cv.has('Mute'), cv.all());
    cv = spyCanvas();
    S.draw(cv, t, s, { volume: null });
    assert.ok(!cv.has('Mute') && !cv.has('23'));
});

run();
