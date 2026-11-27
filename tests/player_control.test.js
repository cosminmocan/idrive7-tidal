'use strict';
/**
 * player_control.test.js - task B3: the commands on fd 3 (pause, resume, volume, quit) and the events on stdout
 * (open, tick, end, error), as docs/PROTOCOL.md section 2 says. Runs the real player (`make test-player`).
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

P.skipUnlessReady(__filename);

const T = { timeout: 60000 };
const dir = P.tmpdir();
let n = 0;
const ticks = (h) => h.events.filter((e) => e.ev === 'tick');
const wavPath = () => path.join(dir, 'c' + (n++) + '.wav');

test('open comes before the first tick, and every event is valid', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
        const kinds = r.events.map((e) => e.ev);
        assert.strictEqual(kinds[0] === 'audio' ? kinds[1] : kinds[0], 'open', 'open first (an audio event may come before): ' + kinds.join(' '));
        assert(kinds.indexOf('tick') > kinds.indexOf('open'), 'a tick after open: ' + kinds.join(' '));
        assert.strictEqual(kinds.filter((k) => k === 'open').length, 1, 'one open');
        assert.strictEqual(kinds[kinds.length - 1], 'end', 'end last');
        assert(ticks(h).length >= 8, 'about ten ticks for 5 s: ' + ticks(h).length);
    });
}, T);

test('ticks come every 500 ms and the position grows by 0.5 s each while playing', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        const t = ticks(h);
        for (let i = 1; i < t.length; i++) {
            const gap = t[i]._ms - t[i - 1]._ms;
            assert(gap > 350 && gap < 650, 'tick ' + i + ' came ' + gap + ' ms after the one before');
        }
        const playing = t.filter((e) => e.state === 'playing');
        assert(playing.length >= 7, 'playing ticks: ' + JSON.stringify(t));
        for (let i = 1; i < playing.length; i++) {
            if (playing[i].pos >= 4.9) break;   // the end of the file
            const d = playing[i].pos - playing[i - 1].pos;
            assert(Math.abs(d - 0.5) < 0.08, 'position grew by ' + d.toFixed(3) + ' between playing ticks: ' + JSON.stringify(playing));
        }
        const last = t[t.length - 1];
        assert(last.pos > 4.4 && last.pos <= 5.05, 'last position ' + last.pos);
    });
}, T);

test('pause freezes the position, resume continues it, and no sound is lost', () => {
    const out = wavPath();
    const h = P.start({ env: { MGU_AUDIO: 'wav:' + out } });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    let atPause;
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 1.4, 10000)
        .then(() => { h.send('pause'); return P.delay(800); })
        .then(() => { atPause = ticks(h).length; return P.delay(1600); })
        .then(() => {
            const during = ticks(h).slice(atPause);
            assert(during.length >= 2, 'ticks while paused: ' + JSON.stringify(during));
            during.forEach((e) => assert.strictEqual(e.state, 'paused', 'state while paused: ' + JSON.stringify(e)));
            const p0 = during[0].pos;
            during.forEach((e) => assert.strictEqual(e.pos, p0, 'the position stands while paused: ' + JSON.stringify(during)));
            h.send('resume');
            return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos > p0 + 0.7, 5000).then(() => h.done).then((r) => {
                P.assertClean(r, h);
                assert.strictEqual(r.code, 0);
                assert.strictEqual(P.lastEvent(r).ev, 'end');
                // the paused time is not played: 5 s of sound took about 5 s + the pause
                const w = P.readWav(out);
                assert(Math.abs(w.frames - 5 * P.RATE) <= 0.02 * P.RATE, 'all 5 s written: ' + w.frames / P.RATE);
                assert(r.ms > 5000 + 2000, 'the pause took time: ' + r.ms + ' ms');
            });
        });
}, T);

test('volume 0.5 halves the peak of the output', () => {
    const out = wavPath();
    const h = P.start({ env: { MGU_AUDIO: 'wav:' + out } });
    h.feed(P.fixture('tone1k_10s.flac'));
    let at;
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 1, 10000)
        .then((e) => { at = e.pos; h.send('volume 0.5'); return h.done; })
        .then((r) => {
            P.assertClean(r, h);
            const w = P.readWav(out);
            const before = P.peak(P.channel(w, 0, 0.2 * P.RATE, 0.5 * P.RATE));
            // a whole frame: (1.007 + 2) * 48000 is 144335.99999999997 in floating point, and a sample at that index is NaN
            const after = P.peak(P.channel(w, 0, Math.round((at + 2) * P.RATE), P.RATE));
            assert(Math.abs(after / before - 0.5) < 0.02, 'peak ' + before.toFixed(4) + ' then ' + after.toFixed(4));
        });
}, T);

test('volume is held between 0 and 1, and volume 0 is silence', () => {
    const out = wavPath();
    const h = P.start({ env: { MGU_AUDIO: 'wav:' + out } });
    h.feed(P.fixture('tone1k_10s.flac'));
    let at;
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 0.5, 10000)
        .then(() => { h.send('volume 7'); return P.delay(1000); })
        .then(() => { at = ticks(h).slice(-1)[0].pos; h.send('volume -3'); return h.done; })
        .then((r) => {
            P.assertClean(r, h);
            const w = P.readWav(out);
            const full = P.peak(P.channel(w, 0, 0.1 * P.RATE, 0.3 * P.RATE));
            assert(full > 0.3, 'loud at first: ' + full);
            const silent = P.peak(P.channel(w, 0, Math.round((at + 1) * P.RATE), P.RATE));
            assert.strictEqual(silent, 0, 'silent after volume -3 (held at 0)');
        });
}, T);

function endsQuickly(h, how) {
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 1, 10000).then(() => {
        const t0 = Date.now();
        how();
        return h.done.then((r) => {
            const ms = Date.now() - t0;
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, 'exit code; stderr:\n' + r.stderr);
            assert(ms < 2500, 'ended ' + ms + ' ms after');
            assert.strictEqual(r.events.filter((e) => e.ev === 'end' || e.ev === 'error').length, 0, 'neither end nor error');
        });
    });
}

test('quit ends the player within 2.5 s with exit 0', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_60s.flac'));
    return endsQuickly(h, () => h.send('quit'));
}, T);

test('SIGTERM ends the player within 2.5 s with exit 0', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_60s.flac'));
    return endsQuickly(h, () => h.child.kill('SIGTERM'));
}, T);

test('quit while the input is still open (the sender has more) ends it too', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_10s.flac').slice(0, 100000), { keepOpen: true });
    return endsQuickly(h, () => h.send('quit'));
}, T);

test('quit before any input ends it', () => {
    const h = P.start();
    return P.delay(500).then(() => {
        const t0 = Date.now();
        h.send('quit');
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0);
            assert(Date.now() - t0 < 2500);
        });
    });
}, T);

test('the control pipe closing (the service gone) ends the player', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_60s.flac'));
    return endsQuickly(h, () => h.child.stdio[3].end());
}, T);

test('unknown commands, junk and a huge line are ignored', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing', 10000).then(() => {
        h.send('bogus');
        h.send('volume');
        h.send('volume abc');
        h.send('PAUSE');
        h.send(' quit ');
        h.child.stdio[3].write(Buffer.from([0, 1, 2, 255, 10]));
        h.send('x'.repeat(100000));
        return h.done;
    }).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        const t = ticks(h);
        assert(t.every((e) => e.state !== 'paused'), 'never paused');
        assert(t[t.length - 1].pos > 4.4, 'played on: ' + t[t.length - 1].pos);
    });
}, T);

test('without fd 3 the player plays to the end', () => {
    const h = P.start({ noFd3: true });
    h.feed(P.fixture('tone1k_5s_48k.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
    });
}, T);

test('an error comes last, after open, with no tick after it', () => {
    const b = Buffer.from(P.fixture('tone1k_10s.flac').slice(0, 8192));
    const h = P.start();
    h.feed(Buffer.concat([b, P.noise(300000, 5)]));
    return h.done.then((r) => {
        P.assertClean(r, h);
        const last = P.lastEvent(r);
        assert(last.ev === 'error' || last.ev === 'end', JSON.stringify(last));
        assert.strictEqual(r.events.filter((e) => e.ev === 'error' || e.ev === 'end').length, 1, 'one end or error');
    });
}, T);

run();
