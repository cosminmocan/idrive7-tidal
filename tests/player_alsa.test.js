'use strict';
/**
 * player_alsa.test.js - task B5: the sound through ALSA (libasound opened at run time, the device non-blocking),
 * a device that cannot be opened retried each second and told in `audio`, and the privileges: the player refuses
 * to run as root (rule R5) and becomes MGU_RUN_AS with MGU_GROUPS before it reads a byte. In the test image the
 * ALSA device is a `file` plugin over `null` that writes a WAV (~/.asoundrc). `make test-player`, as root.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

P.skipUnlessReady(__filename);

const T = { timeout: 60000 };
const dir = P.tmpdir();
let n = 0;

/** a HOME with an .asoundrc whose pcm "tonefile" writes the WAV out */
function alsaHome(out) {
    const home = path.join(dir, 'home' + (n++));
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    fs.writeFileSync(path.join(home, '.asoundrc'),
        'pcm.tonefile {\n    type file\n    slave.pcm "null"\n    file "' + out + '"\n    format "wav"\n}\n');
    return home;
}

/** a root-only test: skipped (with a line) when the tests do not run as root */
function rootTest(name, fn) {
    test(name, () => {
        if (!P.isRoot()) { console.log('  skip (not root) ' + name); return null; }
        return fn();
    }, T);
}

/** /proc/<pid>/status of the running player: {uid: [...], gid: [...], groups: [...]} */
function ids(pid) {
    const s = fs.readFileSync('/proc/' + pid + '/status', 'utf8');
    const line = (k) => (s.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [null, ''])[1].trim().split(/\s+/).filter(Boolean).map(Number);
    return { uid: line('Uid'), gid: line('Gid'), groups: line('Groups') };
}

function gidOf(name) {
    const l = fs.readFileSync('/etc/group', 'utf8').split('\n').filter((x) => x.split(':')[0] === name)[0];
    return l ? Number(l.split(':')[2]) : null;
}

test('the tone test through ALSA: 10 s of 1 kHz at 48 kHz stereo S16', () => {
    const out = path.join(dir, 'alsa' + (n++) + '.wav');
    const h = P.start({ env: { MGU_AUDIO: 'alsa:tonefile', HOME: alsaHome(out) } });
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, 'exit; stderr:\n' + r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        const audio = r.events.filter((e) => e.ev === 'audio');
        assert.deepStrictEqual(audio.map((e) => [e.state, e.device]), [['open', 'tonefile']]);
        const w = P.readWav(out);
        assert.deepStrictEqual([w.rate, w.channels, w.bits], [48000, 2, 16]);
        assert(Math.abs(w.frames - 10 * P.RATE) <= 0.02 * P.RATE, 'length ' + w.frames / P.RATE);
        [1, 5, 9.5].forEach((at) => [0, 1].forEach((c) =>
            assert.strictEqual(P.loudestFreq(P.channel(w, c, at * P.RATE, 4800), P.RATE, 100, 4000, 10), 1000, 'at ' + at + ' s')));
        // the end waits for the device: 10 s of sound took 10 s
        const open = r.events.filter((e) => e.ev === 'open')[0];
        assert(P.lastEvent(r)._ms - open._ms > 9900, 'played in real time');
    });
}, T);

test('quit closes the device first: the WAV the ALSA file plugin writes is finished', () => {
    const out = path.join(dir, 'alsa' + (n++) + '.wav');
    const h = P.start({ env: { MGU_AUDIO: 'alsa:tonefile', HOME: alsaHome(out) } });
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 2, 10000).then(() => {
        const t0 = Date.now();
        h.send('quit');
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0);
            assert(Date.now() - t0 < 2500, 'ended within 2.5 s');
            const b = fs.readFileSync(out);
            const dataSize = b.readUInt32LE(40);
            assert(dataSize > 1.5 * 4 * P.RATE && dataSize === b.length - 44, 'the file plugin wrote its header at close: ' + dataSize + ' of ' + (b.length - 44));
        });
    });
}, T);

test('a device that does not exist gives audio error, is tried again, and nothing crashes', () => {
    const h = P.start({ env: { MGU_AUDIO: 'alsa:nosuchdevice' } });
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.waitEvent((e) => e.ev === 'audio', 5000).then((e) => {
        assert.strictEqual(e.state, 'error', JSON.stringify(e));
        assert.strictEqual(e.device, 'nosuchdevice');
        assert(/nosuchdevice|No such|not found/i.test(e.message || ''), 'the message says why: ' + JSON.stringify(e));
        return P.delay(3500);
    }).then(() => {
        assert.strictEqual(h.child.exitCode, null, 'still running');
        assert(/try|retr/i.test(h.stderr()) && (h.stderr().match(/snd_pcm_open/g) || []).length >= 3, 'tried again each second:\n' + h.stderr());
        assert.strictEqual(h.events.filter((e) => e.ev === 'audio').length, 1, 'told once, not each second');
        const t = h.events.filter((e) => e.ev === 'tick');
        assert(t.length >= 4 && t.every((e) => e.state === 'buffering' && e.pos === 0), 'nothing plays meanwhile: ' + JSON.stringify(t));
        h.send('quit');
        return h.done;
    }).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
    });
}, T);

rootTest('started as root without MGU_RUN_AS it exits 3 and plays nothing', () => {
    const out = path.join(dir, 'root' + (n++) + '.wav');
    const h = P.start({ asRoot: true, env: { MGU_AUDIO: 'wav:' + out, MGU_RUN_AS: null } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 3, 'exit; stderr:\n' + r.stderr);
        assert.strictEqual(fs.existsSync(out), false, 'no sound written');
        assert.strictEqual(r.events.filter((e) => e.ev === 'open' || e.ev === 'tick').length, 0, 'nothing played');
        assert(/root/.test(r.stderr), 'it says why');
    });
}, T);

rootTest('started as root with MGU_RUN_AS=nobody it runs as nobody, with the groups that exist', () => {
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: 'nobody', MGU_GROUPS: 'audio,nosuchgroup' } });
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.waitEvent((e) => e.ev === 'tick', 10000).then(() => {
        const id = ids(h.child.pid);
        assert.deepStrictEqual(id.uid, [P.NOBODY, P.NOBODY, P.NOBODY, P.NOBODY], 'uid: ' + JSON.stringify(id));
        assert.deepStrictEqual(id.gid, [65534, 65534, 65534, 65534], 'gid (nogroup): ' + JSON.stringify(id));
        assert.deepStrictEqual(id.groups, [gidOf('audio')], 'groups: ' + JSON.stringify(id));
        assert(/nosuchgroup/.test(h.stderr()), 'the missing group is logged:\n' + h.stderr());
        h.send('quit');
        return h.done;
    }).then((r) => { P.assertClean(r, h); assert.strictEqual(r.code, 0); });
}, T);

rootTest('without MGU_GROUPS it takes mgu_alsa and audio (those the system has)', () => {
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: 'nobody', MGU_GROUPS: null } });
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.waitEvent((e) => e.ev === 'tick', 10000).then(() => {
        const id = ids(h.child.pid);
        assert.deepStrictEqual(id.uid[0], P.NOBODY);
        assert.deepStrictEqual(id.groups, [gidOf('mgu_alsa'), gidOf('audio')].filter((g) => g !== null), 'groups: ' + JSON.stringify(id));
        assert(gidOf('mgu_alsa') !== null || /mgu_alsa/.test(h.stderr()), 'a missing mgu_alsa is logged');
        h.send('quit');
        return h.done;
    }).then((r) => { P.assertClean(r, h); assert.strictEqual(r.code, 0); });
}, T);

rootTest('MGU_RUN_AS as a number works too', () => {
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: '12345', MGU_GROUPS: '' } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.waitEvent((e) => e.ev === 'tick', 10000).then(() => {
        const id = ids(h.child.pid);
        assert.deepStrictEqual(id.uid, [12345, 12345, 12345, 12345]);
        assert.deepStrictEqual(id.groups, []);
        h.send('quit');
        return h.done;
    }).then((r) => { P.assertClean(r, h); assert.strictEqual(r.code, 0); });
}, T);

rootTest('it drops root before it opens anything: a root-only folder is closed to it', () => {
    const closed = path.join(dir, 'rootonly' + (n++));
    fs.mkdirSync(closed);
    fs.chmodSync(closed, 0o700);
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: 'nobody', MGU_AUDIO: 'wav:' + closed + '/x.wav' } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(P.lastEvent(r).ev, 'error');
        assert.strictEqual(P.lastEvent(r).code, 'audio');
        assert.strictEqual(r.code, 6);
        assert.strictEqual(fs.existsSync(closed + '/x.wav'), false);
    });
}, T);

rootTest('a user that does not exist is a bad environment: exit 2', () => {
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: 'nosuchuser' } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 2, 'exit; stderr:\n' + r.stderr);
        assert.strictEqual(r.events.filter((e) => e.ev === 'open').length, 0);
    });
}, T);

rootTest('MGU_RUN_AS=root is still root: refused, exit 3', () => {
    const h = P.start({ asRoot: true, env: { MGU_RUN_AS: 'root' } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 3, 'exit; stderr:\n' + r.stderr);
    });
}, T);

test('as a user already (not root), MGU_RUN_AS is not needed and it plays', () => {
    const h = P.start({ env: { MGU_RUN_AS: null } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, 'exit; stderr:\n' + r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
    });
}, T);

run();
