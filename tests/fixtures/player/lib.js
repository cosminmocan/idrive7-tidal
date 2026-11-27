'use strict';
/**
 * lib.js - what the player tests (tests/player_*.test.js) share: start the real player, feed it, collect its
 * events, read the WAV it wrote and measure it. Node 8 syntax.
 *
 * The tests need the binary and the tone fixtures, which exist only in the test image (`make test-player`):
 *   TIDAL_PLAYER            the binary (tidal-player or tidal-player-asan)
 *   TIDAL_PLAYER_FIXTURES   the folder make-tones.sh filled
 *   TIDAL_PLAYER_SANITIZER  1: the binary is the ASan/UBSan build; any report fails the test
 * Without the first two a test file prints one skip line and exits 0 (as in `make test`: node:8.9.4's glibc is
 * too old for the binary, and there is no ffmpeg to make the fixtures).
 */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const protocol = require('../../fakes/protocol');

const BIN = process.env.TIDAL_PLAYER || '';
const FIXTURES = process.env.TIDAL_PLAYER_FIXTURES || '';
const SANITIZER = process.env.TIDAL_PLAYER_SANITIZER === '1';
const NOBODY = 65534;
const RATE = 48000;

/** prints one skip line and ends the process when the player or its fixtures are not here */
function skipUnlessReady(file) {
    let why = null;
    if (!BIN) why = 'TIDAL_PLAYER is not set';
    else if (!fs.existsSync(BIN)) why = BIN + ' does not exist';
    else if (!FIXTURES || !fs.existsSync(path.join(FIXTURES, 'tone1k_10s.flac'))) why = 'no tone fixtures (TIDAL_PLAYER_FIXTURES)';
    if (!why) return;
    console.log('  skip ' + path.basename(file) + ': ' + why + ' (the player tests run in `make test-player`)');
    process.exit(0);
}

function fixture(name) { return fs.readFileSync(path.join(FIXTURES, name)); }

/** a folder anybody can write (the player runs as nobody) */
function tmpdir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tidal-player-'));
    fs.chmodSync(d, 0o777);
    return d;
}

/** deterministic bytes that are no audio format */
function noise(n, seed) {
    const b = Buffer.alloc(n);
    let x = (seed || 1) >>> 0;
    for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
    return b;
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * starts the player. opts: env (added to a clean environment), asRoot (keep root; otherwise a root test process
 * starts it as nobody), noFd3 (no control pipe). Returns a handle:
 *   events, invalid, lines, stderr()   what it said so far (invalid: events the S3 validator refused)
 *   send(line)                         one command on fd 3
 *   feed(buf, {chunk, delayMs})        writes buf to stdin (with backpressure), then ends stdin unless keepOpen
 *   waitEvent(pred, ms)                the first event (so far or to come) for which pred is true
 *   done                               a promise of {code, signal, ms, events, stderr}
 */
function start(opts) {
    opts = opts || {};
    const env = { PATH: process.env.PATH, MGU_AUDIO: 'null' };
    if (SANITIZER) env.ASAN_OPTIONS = 'detect_leaks=0:exitcode=99:abort_on_error=0';   // LSan cannot run under emulation
    if (SANITIZER) env.UBSAN_OPTIONS = 'print_stacktrace=1:halt_on_error=1:exitcode=99';
    Object.keys(opts.env || {}).forEach((k) => { if (opts.env[k] === null) delete env[k]; else env[k] = opts.env[k]; });
    const so = { env: env, stdio: ['pipe', 'pipe', 'pipe', opts.noFd3 ? 'ignore' : 'pipe'] };
    if (isRoot() && !opts.asRoot) { so.uid = NOBODY; so.gid = NOBODY; }
    const t0 = Date.now();
    const child = cp.spawn(opts.bin || BIN, opts.args || [], so);
    const h = { child: child, events: [], invalid: [], lines: [], err: '', waiters: [], t0: t0 };
    h.stderr = () => h.err;
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
        out += d;
        let i;
        while ((i = out.indexOf('\n')) >= 0) {
            const line = out.slice(0, i); out = out.slice(i + 1);
            h.lines.push(line);
            const ev = protocol.parsePlayerLine(line);
            if (!ev) continue;
            ev._ms = Date.now() - t0;
            const probs = protocol.validatePlayerEvent(ev);
            if (probs.length) h.invalid.push(line + ': ' + probs.join('; '));
            h.events.push(ev);
            h.waiters = h.waiters.filter((w) => { if (w.pred(ev)) { clearTimeout(w.timer); w.resolve(ev); return false; } return true; });
        }
    });
    child.stdout.on('end', () => { h.outEnded = true; });
    child.stderr.on('end', () => { h.errEnded = true; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { h.err += d; if (process.env.TIDAL_PLAYER_VERBOSE) process.stderr.write(d); });
    child.stdin.on('error', () => {});   // the player may end before it read everything (an error, quit)
    if (child.stdio[3]) child.stdio[3].on('error', () => {});
    h.send = (line) => { child.stdio[3].write(line + '\n'); };
    h.done = new Promise((resolve) => {
        child.on('exit', (code, signal) => {
            // stdout and stderr may still hold the last lines: wait for both to end
            const ms = Date.now() - t0;
            const fin = () => { if (h.outEnded && h.errEnded) resolve({ code: code, signal: signal, ms: ms, events: h.events, stderr: h.err }); };
            fin();
            child.stdout.on('end', fin); child.stderr.on('end', fin);
        });
    });
    h.waitEvent = (pred, ms) => {
        const seen = h.events.filter(pred)[0];
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve, reject) => {
            const w = { pred: pred, resolve: resolve };
            w.timer = setTimeout(() => { h.waiters = h.waiters.filter((x) => x !== w); reject(new Error('no such event within ' + ms + ' ms; events: ' + JSON.stringify(h.events) + '\nstderr: ' + h.err)); }, ms || 10000);
            h.waiters.push(w);
        });
    };
    h.feed = (buf, fo) => {
        fo = fo || {};
        const chunk = fo.chunk || 65536;
        let off = 0;
        h.written = 0;
        return new Promise((resolve) => {
            const next = () => {
                while (off < buf.length) {
                    if (fo.pauseAt !== undefined && off >= fo.pauseAt && !fo._paused) {
                        fo._paused = true;
                        return setTimeout(next, fo.pauseMs);
                    }
                    let end = Math.min(buf.length, off + chunk);
                    if (fo.pauseAt !== undefined && !fo._paused && off < fo.pauseAt) end = Math.min(end, fo.pauseAt);
                    const ok = child.stdin.write(buf.slice(off, end));
                    off = end; h.written = off;
                    if (!ok) return child.stdin.once('drain', next);
                    if (fo.delayMs) return setTimeout(next, fo.delayMs);
                }
                if (!fo.keepOpen) child.stdin.end();
                resolve();
            };
            next();
        });
    };
    h.kill = (sig) => { try { child.kill(sig || 'SIGKILL'); } catch (e) { /* gone */ } };
    return h;
}

/** plays buf to the end: {code, events, stderr, ms} */
function play(buf, opts) {
    const h = start(opts);
    h.feed(buf, opts && opts.feed);
    return h.done.then((r) => { r.invalid = h.invalid; return r; });
}

/** a 16-bit PCM WAV: {rate, channels, bits, frames, data (Int16Array, interleaved)} */
function readWav(file) {
    const b = fs.readFileSync(file);
    assert.strictEqual(b.toString('latin1', 0, 4), 'RIFF', file + ' is not a WAV');
    assert.strictEqual(b.toString('latin1', 8, 12), 'WAVE', file + ' is not a WAV');
    let off = 12;
    let fmt = null;
    while (off + 8 <= b.length) {
        const id = b.toString('latin1', off, off + 4);
        let size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22), format: b.readUInt16LE(off + 8) };
        if (id === 'data') {
            assert(fmt, 'no fmt chunk before data');
            // a writer that did not finish its header (an ALSA file plugin killed) leaves the size wrong: take the file
            if (size === 0 || size === 0xffffffff || off + 8 + size > b.length) size = b.length - off - 8;
            size -= size % (2 * fmt.channels);
            const data = new Int16Array(size / 2);
            for (let i = 0; i < data.length; i++) data[i] = b.readInt16LE(off + 8 + 2 * i);
            return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, format: fmt.format, frames: data.length / fmt.channels, data: data };
        }
        off += 8 + size + (size & 1);
    }
    throw new Error(file + ': no data chunk');
}

/** one channel of interleaved samples, frames [from, from + n) */
function channel(w, ch, from, n) {
    const f = Math.max(0, from || 0), m = Math.min(w.frames - f, n === undefined ? w.frames : n);
    const out = new Float64Array(Math.max(0, m));
    for (let i = 0; i < out.length; i++) out[i] = w.data[(f + i) * w.channels + ch] / 32768;
    return out;
}

/** the loudest frequency of x (rate Hz) between lo and hi, in steps of step Hz */
function loudestFreq(x, rate, lo, hi, step) {
    lo = lo || 50; hi = hi || 8000; step = step || 10;
    let best = 0, bestP = -1;
    for (let f = lo; f <= hi; f += step) {
        const w = 2 * Math.PI * f / rate;
        let re = 0, im = 0;
        for (let i = 0; i < x.length; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
        const p = re * re + im * im;
        if (p > bestP) { bestP = p; best = f; }
    }
    return best;
}

function peak(x) { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; }

/** checks that hold for every run: valid events, the last one end or error, no sanitizer report */
function assertClean(r, h) {
    const invalid = (h && h.invalid) || r.invalid || [];
    assert.deepStrictEqual(invalid, [], 'events that break the protocol');
    assert(!/AddressSanitizer|LeakSanitizer|runtime error:|UndefinedBehaviorSanitizer/.test(r.stderr), 'sanitizer report:\n' + r.stderr);
    assert.notStrictEqual(r.signal, 'SIGSEGV', 'crashed:\n' + r.stderr);
    assert.notStrictEqual(r.code, 99, 'sanitizer exit:\n' + r.stderr);
    assert(r.code !== null || r.signal === 'SIGKILL', 'ended by ' + r.signal + ':\n' + r.stderr);
}

function lastEvent(r) { return r.events[r.events.length - 1]; }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
    BIN: BIN, FIXTURES: FIXTURES, SANITIZER: SANITIZER, RATE: RATE, NOBODY: NOBODY,
    skipUnlessReady: skipUnlessReady, fixture: fixture, tmpdir: tmpdir, noise: noise, isRoot: isRoot,
    start: start, play: play, readWav: readWav, channel: channel, loudestFreq: loudestFreq, peak: peak,
    assertClean: assertClean, lastEvent: lastEvent, delay: delay,
};
