'use strict';
/**
 * player_decode.test.js - task B2: the track's bytes on stdin come out as 48 kHz stereo 16-bit (MGU_AUDIO=wav:),
 * whatever the input; bad input gives `error` and a clean exit, never a crash (rule R4). Runs the real player
 * (`make test-player`: once as built for the unit, once with ASan and UBSan); skipped elsewhere.
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

P.skipUnlessReady(__filename);

const T = { timeout: 60000 };
const dir = P.tmpdir();
let n = 0;

/** plays a fixture (or a buffer) into a WAV: {r, wav, open} */
function decode(input, opts) {
    const wavPath = path.join(dir, 'out' + (n++) + '.wav');
    const buf = Buffer.isBuffer(input) ? input : P.fixture(input);
    const env = Object.assign({ MGU_AUDIO: 'wav:' + wavPath }, (opts && opts.env) || {});
    return P.play(buf, { env: env }).then((r) => {
        P.assertClean(r);
        const open = r.events.filter((e) => e.ev === 'open')[0];
        let wav = null;
        try { wav = P.readWav(wavPath); } catch (e) { /* none written */ }
        return { r: r, wav: wav, open: open, path: wavPath };
    });
}

function assertEnded(x) {
    assert.strictEqual(x.r.code, 0, 'exit code; stderr:\n' + x.r.stderr);
    assert.strictEqual(P.lastEvent(x.r).ev, 'end', 'last event: ' + JSON.stringify(P.lastEvent(x.r)));
    assert.strictEqual(x.r.events.filter((e) => e.ev === 'error').length, 0, 'no error event');
}
function assertFormat(w) {
    assert(w, 'a WAV was written');
    assert.strictEqual(w.rate, 48000); assert.strictEqual(w.channels, 2); assert.strictEqual(w.bits, 16);
}
/** the length in frames at 48 kHz, within 20 ms */
function assertSeconds(w, s) {
    const want = s * P.RATE;
    assert(Math.abs(w.frames - want) <= 0.02 * P.RATE, 'length ' + (w.frames / P.RATE).toFixed(4) + ' s, want ' + s + ' s within 20 ms');
}
/** the loudest frequency of each channel in a 100 ms window at `at` seconds */
function freqs(w, at) {
    return [0, 1].map((c) => P.loudestFreq(P.channel(w, c, Math.round(at * P.RATE), 4800), P.RATE, 100, 4000, 10));
}
function assertError(x, code, exit) {
    const last = P.lastEvent(x.r);
    assert(last && last.ev === 'error', 'last event is error: ' + JSON.stringify(x.r.events) + '\nstderr:\n' + x.r.stderr);
    assert.strictEqual(last.code, code, 'error code: ' + JSON.stringify(last));
    assert.strictEqual(x.r.events.filter((e) => e.ev === 'error').length, 1, 'one error event');
    assert.strictEqual(x.r.events.filter((e) => e.ev === 'end').length, 0, 'no end after an error');
    assert.strictEqual(x.r.code, exit, 'exit code; stderr:\n' + x.r.stderr);
}

test('a 10 s 1 kHz FLAC (16-bit 44.1 kHz) gives 10 s of 48 kHz stereo at 1 kHz', () => decode('tone1k_10s.flac').then((x) => {
    assertEnded(x);
    assert.deepStrictEqual([x.open.codec, x.open.rate, x.open.channels], ['flac', 44100, 2]);
    assert(Math.abs(x.open.duration - 10) < 0.01, 'duration ' + x.open.duration);
    assertFormat(x.wav); assertSeconds(x.wav, 10);
    assert.deepStrictEqual(freqs(x.wav, 1), [1000, 1000]);
    assert.deepStrictEqual(freqs(x.wav, 9.5), [1000, 1000]);
    assert(P.peak(P.channel(x.wav, 0, 48000, 48000)) > 0.4, 'the tone is at -6 dBFS');
}), T);

test('a 10 s 1 kHz AAC in MP4 (index first) gives 10 s of 48 kHz stereo at 1 kHz', () => decode('tone1k_10s.m4a').then((x) => {
    assertEnded(x);
    assert.deepStrictEqual([x.open.codec, x.open.rate, x.open.channels], ['aac', 44100, 2]);
    assert(x.open.duration > 9.9 && x.open.duration < 10.1, 'duration ' + x.open.duration);
    assertFormat(x.wav); assertSeconds(x.wav, 10);
    assert.deepStrictEqual(freqs(x.wav, 1), [1000, 1000]);
    assert.deepStrictEqual(freqs(x.wav, 9.5), [1000, 1000]);
}), T);

test('an MP4 with its index (moov) after the audio still plays: it is held in memory', () => decode('tone1k_10s_moovlast.m4a').then((x) => {
    assertEnded(x);
    assert.strictEqual(x.open.codec, 'aac');
    assertFormat(x.wav); assertSeconds(x.wav, 10);
    assert.deepStrictEqual(freqs(x.wav, 5), [1000, 1000]);
}), T);

test('AAC in fragmented MP4 plays', () => decode('tone1k_5s_frag.m4a').then((x) => {
    assertEnded(x);
    assert.strictEqual(x.open.codec, 'aac');
    assertFormat(x.wav); assertSeconds(x.wav, 5);
    assert.deepStrictEqual(freqs(x.wav, 2.5), [1000, 1000]);
}), T);

test('AAC in ADTS plays', () => decode('tone1k_5s.aac').then((x) => {
    assertEnded(x);
    assert.strictEqual(x.open.codec, 'aac');
    assertFormat(x.wav);
    assert(Math.abs(x.wav.frames / P.RATE - 5) < 0.05, 'length ' + x.wav.frames / P.RATE);
    assert.deepStrictEqual(freqs(x.wav, 2.5), [1000, 1000]);
}), T);

test('a mono file plays on both channels', () => decode('tone440_mono_5s.flac').then((x) => {
    assertEnded(x);
    assert.strictEqual(x.open.channels, 1);
    assertFormat(x.wav); assertSeconds(x.wav, 5);
    assert.deepStrictEqual(freqs(x.wav, 2), [440, 440]);
    const l = P.channel(x.wav, 0, 48000, 48000), r = P.channel(x.wav, 1, 48000, 48000);
    for (let i = 0; i < l.length; i++) assert.strictEqual(l[i], r[i], 'left equals right at ' + i);
    assert(P.peak(l) > 0.4, 'not quieter than the input (-6 dBFS): ' + P.peak(l));
}), T);

test('left stays left and right stays right', () => decode('lr_5s.flac').then((x) => {
    assertEnded(x);
    assertFormat(x.wav);
    assert.deepStrictEqual(freqs(x.wav, 2), [1000, 1500]);
}), T);

test('a 48 kHz file comes out at the same length and pitch', () => decode('tone1k_5s_48k.flac').then((x) => {
    assertEnded(x);
    assert.strictEqual(x.open.rate, 48000);
    assertFormat(x.wav); assertSeconds(x.wav, 5);
    assert.deepStrictEqual(freqs(x.wav, 2), [1000, 1000]);
}), T);

test('a FLAC cut off in the middle plays what it has and ends with end', () => {
    const b = P.fixture('tone1k_10s.flac');
    return decode(b.slice(0, Math.floor(b.length / 2) + 333)).then((x) => {
        assertEnded(x);
        assertFormat(x.wav);
        const s = x.wav.frames / P.RATE;
        assert(s > 4.5 && s < 5.5, 'played ' + s + ' s of the 5 s it had');
        assert.deepStrictEqual(freqs(x.wav, 2), [1000, 1000]);
    });
}, T);

test('an MP4 cut off in the middle plays what it has and ends with end', () => {
    const b = P.fixture('tone1k_10s.m4a');
    return decode(b.slice(0, Math.floor(b.length / 2) + 77)).then((x) => {
        assertEnded(x);
        const s = x.wav.frames / P.RATE;
        assert(s > 4 && s < 6, 'played ' + s + ' s');
    });
}, T);

test('random bytes give error decode and exit 5', () => decode(P.noise(1 << 20, 7)).then((x) => assertError(x, 'decode', 5)), T);

test('a few random bytes give error decode and exit 5', () => decode(P.noise(10, 3)).then((x) => assertError(x, 'decode', 5)), T);

test('an empty input gives error input and exit 4', () => decode(Buffer.alloc(0)).then((x) => assertError(x, 'input', 4)), T);

test('a FLAC cut off inside its header gives error input and exit 4', () => decode(P.fixture('tone1k_10s.flac').slice(0, 30)).then((x) => assertError(x, 'input', 4)), T);

test('an MP4 cut off before its first sound gives error input and exit 4', () => decode(P.fixture('tone1k_10s.m4a').slice(0, 2000)).then((x) => assertError(x, 'input', 4)), T);

test('a FLAC whose middle is random bytes does not crash', () => {
    const b = Buffer.from(P.fixture('tone1k_10s.flac'));
    P.noise(60000, 11).copy(b, 50000);
    return decode(b).then((x) => {
        const last = P.lastEvent(x.r);
        assert(last.ev === 'end' || last.ev === 'error', 'ends with end or error: ' + JSON.stringify(last));
        assert(x.r.code === 0 || x.r.code === 5, 'exit ' + x.r.code);
    });
}, T);

test('an MP4 whose middle is random bytes does not crash', () => {
    const b = Buffer.from(P.fixture('tone1k_10s.m4a'));
    P.noise(40000, 13).copy(b, 100000);
    return decode(b).then((x) => {
        const last = P.lastEvent(x.r);
        assert(last.ev === 'end' || last.ev === 'error', 'ends with end or error: ' + JSON.stringify(last));
    });
}, T);

test('random bytes after a FLAC header do not crash', () => {
    const b = Buffer.concat([P.fixture('tone1k_10s.flac').slice(0, 8192), P.noise(200000, 17)]);
    return decode(b).then((x) => {
        const last = P.lastEvent(x.r);
        assert(last.ev === 'end' || last.ev === 'error', 'ends with end or error: ' + JSON.stringify(last));
    });
}, T);

test('random bytes after an MP4 header do not crash', () => {
    const b = Buffer.concat([P.fixture('tone1k_10s.m4a').slice(0, 4096), P.noise(200000, 19)]);
    return decode(b).then((x) => {
        const last = P.lastEvent(x.r);
        assert(last.ev === 'end' || last.ev === 'error', 'ends with end or error: ' + JSON.stringify(last));
    });
}, T);

test('MGU_AUDIO that is not understood exits 2 before reading', () => P.play(Buffer.alloc(0), { env: { MGU_AUDIO: 'speaker' } }).then((r) => {
    P.assertClean(r);
    assert.strictEqual(r.code, 2, 'exit; stderr:\n' + r.stderr);
}), T);

test('a WAV that cannot be created gives error audio and exit 6', () => decode('tone1k_5s_48k.flac', { env: { MGU_AUDIO: 'wav:/nonexistent/dir/x.wav' } }).then((x) => assertError(x, 'audio', 6)), T);

run();
