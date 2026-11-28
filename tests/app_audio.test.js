'use strict';
/**
 * D6: the speakers and the volume. car_audio.js and car_volume.js are aurelmarius' (bmw-apps @0976d16,
 * apps/aurelm_tvhplayer, GPL-3.0-or-later), sharing the claims folder /tmp/aurelm-287 with his apps: car_volume.js
 * copied unchanged, car_audio.js with one change of ours (A1, below: a 287 connection no app claims is taken over);
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
    const refuse = {};                  // ids the audio manager does not let go
    return {
        calls, list, refuse,
        proxy: (iface) => Promise.resolve({ iface }),
        onAvailable: (p, fn) => setImmediate(() => fn(true)),
        on: () => Promise.resolve(),
        call: (p, method, args) => {
            calls.push({ method, args });
            if (method === 'getListMainConnections') return Promise.resolve({ listConnections: list.slice() });
            if (method === 'disconnect') {
                if (refuse[args.mainConnectionID]) return Promise.resolve({ amError: 'E_NOT_POSSIBLE' });
                const i = list.findIndex((c) => c.mainConnectionID === args.mainConnectionID); if (i >= 0) list.splice(i, 1);
            }
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

test('car_volume.js is aurelmarius\' file, unchanged; car_audio.js is his with our change A1, and the file and NOTICE say so', () => {
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(APP, f))).digest('hex');
    assert.strictEqual(sha('car_volume.js'), '0b8bd7179c773c623566ebb3d0c9abe9b7b5d08a7ace886775454830f5c18fcf');
    // car_audio.js was his unchanged copy (sha256 1a6be46a...) until A1; a changed file must not pass as a copy
    assert.notStrictEqual(sha('car_audio.js'), '1a6be46a7623d35450c31a18ac63ec511d02048beab9754fc1d78f11697fff2f');
    const notice = fs.readFileSync(path.join(APP, 'NOTICE'), 'utf8');
    assert.ok(/car_audio\.js[\s\S]*aurelmarius[\s\S]*GPL-3\.0/.test(notice), 'origin noted in NOTICE');
    const copied = notice.slice(notice.indexOf('copied unchanged'), notice.indexOf('changed by us'));
    assert.ok(notice.indexOf('changed by us') > 0 && !/car_audio\.js/.test(copied), 'NOTICE no longer lists car_audio.js among the unchanged copies');
    assert.ok(/changed by us:[\s\S]*car_audio\.js[\s\S]*A1/.test(notice), 'NOTICE names the change');
    assert.ok(/ONE CHANGE[\s\S]*A1/.test(fs.readFileSync(path.join(APP, 'car_audio.js'), 'utf8').slice(0, 1500)), 'the file\'s header names the change');
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

/** another app's claim in the shared folder, as car_audio.js writes it */
const claimOf = (claims, app, at) => fs.writeFileSync(path.join(claims, app.replace(/[^A-Za-z0-9_-]/g, '_') + '.json'), JSON.stringify({ app: app, at: at }));

test('A1: after a start a connection on 287 is there that we did not make, and no other app claims the speakers (the log, 06:57:07, "287 is in use (2)"): the app ends it and connects by itself', async () => {
    const am = fakeAm();
    am.list.push({ mainConnectionID: 1, sourceID: 5, sinkID: 1024 });      // the car's own source: never ours to touch
    am.list.push({ mainConnectionID: 2, sourceID: 287, sinkID: 1024 });    // what the car brought back
    const lines = [];
    const { a } = ours(am, { log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) } });   // an empty claims folder, as after a start
    await statuses(a, player('playing'), 4, 120);
    assert.strictEqual(a.state().connected, true, 'connected by itself: ' + lines.join(' | '));
    assert.strictEqual(a.state().taken, false);
    assert.deepStrictEqual(disconnected(am), [2], 'the connection nobody claims is ended, and nothing else');
    assert.strictEqual(connects(am), 1, 'one connect');
    const order = am.calls.filter((c) => c.method === 'disconnect' || c.method === 'connect').map((c) => c.method);
    assert.deepStrictEqual(order, ['disconnect', 'connect'], 'first the old one goes, then ours comes');
    assert.deepStrictEqual(am.list.map((c) => c.mainConnectionID), [1, 40], 'the car\'s other source is untouched; on 287 only ours');
    assert.ok(lines.some((l) => /287 is in use \(2\)/.test(l) && /claimed by no app/.test(l)), 'the log says what was done: ' + lines.join(' | '));
    await statuses(a, player('paused'), 2);
    assert.deepStrictEqual(disconnected(am), [2, 40], 'pause releases ours as always');
});

test('A1: the same without a restart of the app (the log, 08:24:11, "287 is in use (9)"): ours was ended by the car, the car put its own on 287, the driver presses play: connected by itself', async () => {
    const am = fakeAm();
    const { a, sent } = ours(am);
    await statuses(a, player('playing'), 2);
    assert.strictEqual(a.state().connected, true);
    am.list.length = 0;                                               // the car ended ours (07:14:53)
    for (let i = 0; i < 30 && sent.indexOf('pause') < 0; i++) await statuses(a, player('playing'), 1, 150);
    assert.deepStrictEqual(sent, ['pause']);
    await statuses(a, player('paused'), 2);
    am.list.push({ mainConnectionID: 9, sourceID: 287, sinkID: 1024 });    // the car's own, an hour later
    await statuses(a, player('paused'), 2);
    assert.deepStrictEqual(disconnected(am), [], 'not touched while we do not play');
    a.userPlay();
    await statuses(a, player('playing'), 4, 120);
    assert.strictEqual(a.state().connected, true);
    assert.deepStrictEqual(disconnected(am), [9]);
    assert.strictEqual(am.list.length, 1);
});

test('A1: a live claim of another app is respected as before: its 287 connection is never disconnected, ours waits until it lets go', async () => {
    const before = Date.now() - 60000, after = Date.now() + 60000;
    for (const at of [before, after]) {                              // its claim older than ours (it will let go), or newer (it keeps them)
        const am = fakeAm();
        const claims = dir();
        claimOf(claims, 'Music Assistant', at);
        am.list.push({ mainConnectionID: 9, sourceID: 287, sinkID: 1024 });   // another app's sound
        const { a } = ours(am, { claimDir: claims });
        await statuses(a, player('playing'), 12, 120);
        assert.strictEqual(a.state().connected, false);
        assert.strictEqual(a.state().taken, true);
        await statuses(a, player('paused'), 2);
        assert.deepStrictEqual(am.list.map((c) => c.mainConnectionID), [9]);
        assert.deepStrictEqual(disconnected(am), [], 'never theirs');
        assert.strictEqual(connects(am), 0, 'and not connected over it');
        am.list.length = 0;                                           // they stop: their claim goes with it
        fs.unlinkSync(path.join(claims, 'Music_Assistant.json'));
        await statuses(a, player('playing'), 25, 120);
        assert.strictEqual(a.state().connected, true);
        const mine = am.list[0].mainConnectionID;
        await statuses(a, player('paused'), 2);
        assert.deepStrictEqual(disconnected(am), [mine], 'only our own connection id is ever disconnected');
    }
});

test('A1: a claim file that cannot be read still counts as another app\'s claim: nothing is disconnected', async () => {
    const am = fakeAm();
    const claims = dir();
    fs.writeFileSync(path.join(claims, 'Emby.json'), '{"app":"Em');   // half written
    am.list.push({ mainConnectionID: 9, sourceID: 287, sinkID: 1024 });
    const { a } = ours(am, { claimDir: claims });
    await statuses(a, player('playing'), 12, 120);
    assert.strictEqual(a.state().taken, true);
    assert.deepStrictEqual(disconnected(am), []);
});

test('A1: the audio manager does not let the unclaimed connection go: asked once, not again and again, and ours waits as before', async () => {
    const am = fakeAm();
    am.list.push({ mainConnectionID: 2, sourceID: 287, sinkID: 1024 });
    am.refuse[2] = true;
    const { a } = ours(am);
    await statuses(a, player('playing'), 30, 120);                    // 3.6 s: the module looks every second
    assert.strictEqual(a.state().connected, false);
    assert.strictEqual(a.state().taken, true);
    assert.deepStrictEqual(disconnected(am), [2], 'asked once');
    assert.strictEqual(connects(am), 0, 'never connected over it');
    am.list.length = 0;                                               // the driver picks another source, as before A1
    await statuses(a, player('playing'), 25, 120);
    assert.strictEqual(a.state().connected, true, 'the old way still works');
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
