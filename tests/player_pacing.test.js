'use strict';
/**
 * player_pacing.test.js - task B4: the player plays in real time, starts after a short prebuffer, reports
 * `buffering` when the input runs dry and goes on when bytes come again, with nothing lost or repeated; and it
 * takes the input no faster than it plays (its queue has a limit, the rest waits in the pipe). `make test-player`.
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

P.skipUnlessReady(__filename);

const T = { timeout: 90000 };
const dir = P.tmpdir();
let n = 0;
const ticks = (h) => h.events.filter((e) => e.ev === 'tick');
const wavPath = () => path.join(dir, 'p' + (n++) + '.wav');

/** the phase (radians, 0..2pi) of a 1 kHz tone at frame i, from the samples around it */
function phaseAt(x, i) {
    const w = 2 * Math.PI * 1000 / P.RATE;
    let re = 0, im = 0;
    for (let k = 0; k < 480; k++) { re += x[i + k] * Math.cos(w * k); im += x[i + k] * Math.sin(w * k); }
    return Math.atan2(-im, re);
}

/** checks that x is one unbroken 1 kHz sine: no sample lost or repeated anywhere (each 10 ms keeps the phase) */
function assertUnbroken(x, from, to) {
    const w = 2 * Math.PI * 1000 / P.RATE;
    const p0 = phaseAt(x, from);
    for (let i = from; i + 480 < to; i += 480) {
        const want = p0 + w * (i - from);
        let d = (phaseAt(x, i) - want) % (2 * Math.PI);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        // one sample lost or repeated moves the phase by 2pi/48 (0.13 rad)
        assert(Math.abs(d) < 0.03, 'the tone jumps at ' + (i / P.RATE).toFixed(3) + ' s by ' + d.toFixed(3) + ' rad');
    }
}

test('a 10 s file fed at once still takes 10 s to play', () => {
    const h = P.start();
    h.feed(P.fixture('tone1k_10s.flac'));
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
        const open = r.events.filter((e) => e.ev === 'open')[0], end = P.lastEvent(r);
        assert.strictEqual(end.ev, 'end');
        const s = (end._ms - open._ms) / 1000;
        assert(s > 9.9 && s < 11.5, 'open to end took ' + s.toFixed(2) + ' s');
    });
}, T);

test('it starts after the prebuffer, MGU_PREBUFFER_MS of sound queued', () => {
    const h = P.start({ env: { MGU_PREBUFFER_MS: '3000' } });
    const b = P.fixture('tone1k_10s.flac');
    // the first 1.4 s of sound, then nothing for 2 s: not enough to start
    const half = 30000;
    h.feed(b, { pauseAt: half, pauseMs: 2000 });
    return P.delay(1800).then(() => {
        const t = ticks(h);
        assert(t.length >= 2, 'ticks: ' + JSON.stringify(t));
        t.forEach((e) => { assert.strictEqual(e.state, 'buffering', JSON.stringify(e)); assert.strictEqual(e.pos, 0, JSON.stringify(e)); });
        return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing', 5000);
    }).then(() => h.done).then((r) => P.assertClean(r, h));
}, T);

test('an input that stops for 3 s gives buffering, then playing, with no sound lost or repeated', () => {
    const out = wavPath();
    const h = P.start({ env: { MGU_AUDIO: 'wav:' + out } });
    const b = P.fixture('tone1k_10s.flac');
    // fed a little faster than it plays (as over a mobile network), so the queue is short when the input stops
    const chunk = Math.round(b.length / 10 * 1.1 / 20);
    h.feed(b, { pauseAt: Math.floor(b.length * 0.4), pauseMs: 3000, chunk: chunk, delayMs: 50 });
    return h.done.then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        const states = ticks(h).map((e) => e.state);
        const firstPlay = states.indexOf('playing');
        const buf = states.indexOf('buffering', firstPlay);
        assert(firstPlay >= 0 && buf > firstPlay, 'buffering after playing: ' + states.join(' '));
        assert(states.indexOf('playing', buf) > buf, 'playing again after buffering: ' + states.join(' '));
        // the position stands while buffering
        const t = ticks(h).filter((e, i) => i > buf && e.state === 'buffering');
        t.forEach((e, i) => { if (i) assert(e.pos - t[i - 1].pos < 0.03, 'position stands while buffering: ' + JSON.stringify(t)); });
        const w = P.readWav(out);
        assert(Math.abs(w.frames - 10 * P.RATE) <= 0.02 * P.RATE, 'all 10 s written: ' + w.frames / P.RATE);
        assertUnbroken(P.channel(w, 0), 4800, w.frames - 4800);
        assert(r.ms > 10800, 'the stall took time: ' + r.ms);
    });
}, T);

test('the tone through the decoder is unbroken when fed at once too (the check itself is sound)', () => {
    const out = wavPath();
    return P.play(P.fixture('tone1k_10s.flac'), { env: { MGU_AUDIO: 'wav:' + out } }).then((r) => {
        P.assertClean(r);
        const x = P.channel(P.readWav(out), 0);
        assertUnbroken(x, 4800, x.length - 4800);
        // and a sample cut out is found
        const y = new Float64Array(x.length - 1);
        y.set(x.subarray(0, 100000)); y.set(x.subarray(100001), 100000);
        assert.throws(() => assertUnbroken(y, 4800, y.length - 4800), /jumps/);
    });
}, T);

test('the input queue never grows past its limit when the sender is faster than playback', () => {
    const b = P.fixture('tone1k_60s.flac');
    const bytesPerS = b.length / 60;
    const h = P.start();
    h.feed(b);
    const seen = [];
    return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 1, 10000).then(() => {
        const t0 = Date.now();
        return new Promise((resolve) => {
            const iv = setInterval(() => {
                seen.push({ pos: (ticks(h).slice(-1)[0] || {}).pos || 0, taken: h.written, buffered: (ticks(h).slice(-1)[0] || {}).buffered });
                if (Date.now() - t0 > 6000) { clearInterval(iv); resolve(); }
            }, 250);
        });
    }).then(() => {
        h.send('quit');
        return h.done;
    }).then((r) => {
        P.assertClean(r, h);
        ticks(h).forEach((e) => assert(e.buffered <= 6.5, 'queued ' + e.buffered + ' s: more than the limit'));
        // what it took from the pipe: what it played and queued, the pipe's and the reader's buffers, not the file
        seen.forEach((s) => {
            const limit = (s.pos + 6.5) * bytesPerS + 3 * 65536 + 65536 + 1048576 / 8;
            assert(s.taken <= limit, 'took ' + s.taken + ' bytes at ' + s.pos + ' s (limit ' + Math.round(limit) + '): ' + JSON.stringify(seen));
        });
        assert(seen[seen.length - 1].taken < b.length * 0.75, 'took ' + seen[seen.length - 1].taken + ' of ' + b.length);
    });
}, T);

run();
