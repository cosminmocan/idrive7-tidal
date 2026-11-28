'use strict';
/**
 * video_player.test.js - task V1a: the video player `tidal-video` (docs/PROTOCOL.md section 2, "The video player").
 * MPEG-TS (H.264 + AAC) on stdin; the pictures into mgu-render's frame file (/dev/shm/mgu-video-<name>: the MGVF
 * header, 3 slots), each when the sound's clock reaches it; the sound exactly as tidal-player's (48 kHz stereo S16,
 * the WAV output for tests). The clips are made from FFmpeg's testsrc and a tone in the test image
 * (tests/fixtures/video/make-clips.sh); the reference sound is the music player tidal-player decoding the clip's own
 * AAC (copied out as ADTS): the same FFmpeg decoder and resampler, so the WAVs must be equal sample for sample.
 * The reference pictures are the ffmpeg command line's decode of the clip (H.264 decoding is exact).
 *
 * Runs in `make test-video-player` (native/tidal-video/tools/test-video.sh); in `make test` it prints one skip line.
 *   TIDAL_VIDEO             the binary (tidal-video or tidal-video-asan)
 *   TIDAL_VIDEO_FIXTURES    the folder make-clips.sh filled
 *   TIDAL_PLAYER            the music player (the reference sound)
 *   TIDAL_PLAYER_SANITIZER  1: the binary is the ASan/UBSan build (tests/fixtures/player/lib.js)
 */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

const VIDEO = process.env.TIDAL_VIDEO || '';
const CLIPS = process.env.TIDAL_VIDEO_FIXTURES || '';
(function skipUnlessReady() {
    let why = null;
    if (!VIDEO) why = 'TIDAL_VIDEO is not set';
    else if (!fs.existsSync(VIDEO)) why = VIDEO + ' does not exist';
    else if (!CLIPS || !fs.existsSync(path.join(CLIPS, 'clip720.ts'))) why = 'no test clips (TIDAL_VIDEO_FIXTURES)';
    else if (!P.BIN || !fs.existsSync(P.BIN)) why = 'no reference player (TIDAL_PLAYER)';
    if (!why) return;
    console.log('  skip ' + path.basename(__filename) + ': ' + why + ' (the video player tests run in `make test-video-player`)');
    process.exit(0);
})();

const T = { timeout: 120000 };
const FPS = 25;
const dir = P.tmpdir();
let n = 0;
const wavPath = () => path.join(dir, 'v' + (n++) + '.wav');
const shmName = () => 'tidal-video-test-' + process.pid + '-' + (n++);
const shmFile = (name) => '/dev/shm/mgu-video-' + name;
const clip = (name) => fs.readFileSync(path.join(CLIPS, name));
const ticks = (h) => h.events.filter((e) => e.ev === 'tick');
const evOf = (r, ev) => r.events.filter((e) => e.ev === ev);

/** starts the video player (tests/fixtures/player/lib.js's start with this binary); env added to the defaults */
function startVideo(env, opts) {
    const e = Object.assign({ MGU_AUDIO: 'null', MGU_VIDEO: 'null', MGU_VIDEO_DECODER: 'sw', MGU_PREBUFFER_MS: '500' }, env || {});
    return P.start(Object.assign({}, opts || {}, { bin: VIDEO, env: e }));
}
/** p, and a player a failed check left running is ended */
function ended(h, p) { return p.then((v) => v, (e) => { h.kill(); throw e; }); }

/* ---------- the reference sound: the music player on the clip's own AAC ---------- */
const refs = {};
function referenceSound(adts) {
    if (!refs[adts]) {
        const out = wavPath();
        refs[adts] = P.play(clip(adts), { env: { MGU_AUDIO: 'wav:' + out, MGU_PREBUFFER_MS: '200' } }).then((r) => {
            assert.strictEqual(r.code, 0, 'the reference player: ' + r.stderr);
            return P.readWav(out);
        });
    }
    return refs[adts];
}
function assertSameSound(got, ref, from, what) {
    assert.strictEqual(got.rate, 48000, what + ': 48 kHz');
    assert.strictEqual(got.channels, 2, what + ': stereo');
    assert.strictEqual(got.frames, ref.frames - from, what + ': ' + got.frames + ' frames, the reference has ' + (ref.frames - from) + ' from ' + from);
    const a = got.data, b = ref.data, off = from * 2;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[off + i]) assert.fail(what + ': the sound differs from the reference at ' + ((from + Math.floor(i / 2)) / P.RATE).toFixed(4) + ' s');
    }
}
/** the sound started later: where in the reference it begins (got is the reference's tail) */
function tailOffset(got, ref) { return ref.frames - got.frames; }

/* ---------- the reference pictures: the ffmpeg command line's decode ---------- */
const probes = {};
/** {t0, vstart}: the stream's first timestamp and the picture's (seconds) */
function probe(name) {
    if (!probes[name]) {
        const j = JSON.parse(cp.execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time:stream=codec_type,start_time', '-of', 'json', path.join(CLIPS, name)]).toString());
        const v = j.streams.filter((s) => s.codec_type === 'video')[0];
        probes[name] = { t0: Number(j.format.start_time), vstart: v ? Number(v.start_time) : NaN };
    }
    return probes[name];
}
/** decoded pictures [a, b] of the clip, I420, display order */
function refFrames(name, a, b, w, h) {
    const raw = cp.execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(CLIPS, name), '-map', '0:v', '-vf', 'select=between(n\\,' + a + '\\,' + b + ')',
        '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 256 << 20 });
    const size = w * h * 3 / 2, out = [];
    for (let i = 0; i * size < raw.length; i++) out.push({ n: a + i, data: raw.slice(i * size, (i + 1) * size) });
    return out;
}
/** the frame file: its header and its newest picture (as I420) */
function readFrameFile(file) {
    const b = fs.readFileSync(file);
    assert(b.length >= 64, file + ' has no MGVF header (' + b.length + ' bytes)');
    const u = (i) => b.readUInt32LE(4 * i);
    const hd = { magic: u(0), version: u(1), w: u(2), h: u(3), seq: u(4), slot: u(5), nslot: u(6), matrix: u(7), range: u(8), format: u(9), size: b.length };
    for (let i = 10; i < 16; i++) assert.strictEqual(u(i), 0, 'header word ' + i + ' is zero');
    const fsz = hd.w * hd.h * 3 / 2;
    let pic = b.slice(64 + hd.slot * fsz, 64 + (hd.slot + 1) * fsz);
    if (hd.format === 1) {   // NV12 -> I420
        const y = hd.w * hd.h, q = y / 4, o = Buffer.alloc(fsz);
        pic.copy(o, 0, 0, y);
        for (let i = 0; i < q; i++) { o[y + i] = pic[y + 2 * i]; o[y + q + i] = pic[y + 2 * i + 1]; }
        pic = o;
    }
    hd.picture = pic;
    return hd;
}
function assertHeader(hd, w, h) {
    assert.strictEqual(hd.magic, 0x4656474d, 'magic MGVF');
    assert.strictEqual(hd.version, 1, 'version 1');
    assert.strictEqual(hd.w, w, 'width');
    assert.strictEqual(hd.h, h, 'height');
    assert.strictEqual(hd.nslot, 3, '3 slots');
    assert(hd.slot < 3, 'slot ' + hd.slot);
    assert(hd.format === 0 || hd.format === 1, 'format I420 or NV12: ' + hd.format);
    assert.strictEqual(hd.matrix, 1, 'BT.709');
    assert.strictEqual(hd.range, 0, 'limited range');
    assert.strictEqual(hd.size, 64 + 3 * w * h * 3 / 2, 'the file holds the header and 3 slots');
}
/** mean absolute difference of two pictures */
function mad(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
/** which of the reference pictures the picture is: {n, diff} of the closest */
function whichFrame(pic, frames) {
    let best = null;
    frames.forEach((f) => { const d = mad(pic, f.data); if (!best || d < best.diff) best = { n: f.n, diff: d }; });
    return best;
}
/** the source picture shown at position p (seconds from the stream's start) */
function frameAt(name, p) { const pr = probe(name); return Math.floor((p - (pr.vstart - pr.t0) + 0.004) * FPS + 1e-9); }

function assertVideoOpen(r, decoder, w, h, file) {
    const open = evOf(r, 'open')[0];
    assert(open, 'an open event');
    assert.strictEqual(open.codec, 'aac');
    assert.strictEqual(open.rate, 44100);
    assert.strictEqual(open.channels, 2);
    assert.deepStrictEqual(open.video, { codec: 'h264', width: w, height: h }, 'open.video: ' + JSON.stringify(open));
    const v = evOf(r, 'video');
    assert.strictEqual(v.length, 1, 'one video event: ' + JSON.stringify(v));
    assert.strictEqual(v[0].state, 'open', JSON.stringify(v[0]));
    assert.strictEqual(v[0].decoder, decoder);
    assert.strictEqual(v[0].width, w);
    assert.strictEqual(v[0].height, h);
    if (file) assert.strictEqual(v[0].file, file);
    assert(r.events.indexOf(open) < r.events.indexOf(v[0]), 'open before video');
}

test('720p H.264 + AAC, software decoder: the frame file (MGVF 1280x720, 3 slots) fills on time, the last picture is the clip\'s last; the sound is the reference sample for sample', () => {
    const name = shmName(), file = shmFile(name), out = wavPath();
    const h = startVideo({ MGU_AUDIO: 'wav:' + out, MGU_VIDEO: 'shm:' + name });
    h.feed(clip('clip720.ts'));
    const seqs = [];
    const poll = setInterval(() => { try { const b = fs.readFileSync(file); if (b.length >= 64) seqs.push(b.readUInt32LE(16)); } catch (e) { /* not yet */ } }, 200);
    return ended(h, h.done).then((r) => {
        clearInterval(poll);
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        assertVideoOpen(r, 'sw', 1280, 720, file);
        const t = ticks(h);
        assert(t.length >= 6, 'ticks: ' + t.length);
        t.forEach((e, i) => {
            assert(typeof e.vframes === 'number' && typeof e.vdropped === 'number', 'ticks count pictures: ' + JSON.stringify(e));
            if (i) assert(e.vframes >= t[i - 1].vframes && e.pos >= t[i - 1].pos, 'counts and position never go back');
        });
        // the pictures came over the playing time, not at once
        const grew = seqs.filter((s, i) => i && s > seqs[i - 1]).length;
        assert(grew >= 8, 'seq grew in ' + grew + ' of ' + seqs.length + ' looks: ' + seqs.join(','));
        const hd = readFrameFile(file);
        assertHeader(hd, 1280, 720);
        const last = t[t.length - 1];
        // 4 s at 25 fps: 100 pictures, each shown or left out late
        assert(hd.seq + last.vdropped >= 97 && hd.seq <= 100, 'pictures written: ' + hd.seq + ', late ' + last.vdropped);
        assert(last.vdropped <= 10, 'late pictures: ' + last.vdropped);
        assert(last.vframes <= hd.seq && last.vframes >= 80, 'the last tick counts ' + last.vframes + ' of ' + hd.seq);
        const m = whichFrame(hd.picture, refFrames('clip720.ts', 97, 99, 1280, 720));
        assert.strictEqual(m.n, 99, 'the last picture shown is the clip\'s last (99): ' + JSON.stringify(m));
        assert(m.diff < 1, 'and equal to the reference decode: mean difference ' + m.diff);
        return referenceSound('clip720.adts').then((ref) => assertSameSound(P.readWav(out), ref, 0, 'the whole clip'));
    });
}, T);

test('paused at about 2 s: the frame file holds the source picture of that time and stays; resume goes on; quit ends it within 2.5 s', () => {
    const name = shmName(), file = shmFile(name);
    const h = startVideo({ MGU_VIDEO: 'shm:' + name });
    h.feed(clip('clip720.ts'));
    let paused, hd1;
    return ended(h, h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos >= 1.8, 20000).then(() => {
        h.send('pause');
        return h.waitEvent((e) => e.ev === 'tick' && e.state === 'paused', 3000);
    }).then(() => P.delay(700)).then(() => {
        paused = ticks(h).filter((e) => e.state === 'paused').pop();
        hd1 = readFrameFile(file);
        return P.delay(600);
    }).then(() => {
        const hd2 = readFrameFile(file);
        assert.strictEqual(hd2.seq, hd1.seq, 'no picture while paused');
        const later = ticks(h).filter((e) => e.state === 'paused').pop();
        assert(Math.abs(later.pos - paused.pos) < 0.001, 'the position stands: ' + paused.pos + ' then ' + later.pos);
        const k = frameAt('clip720.ts', paused.pos);
        const m = whichFrame(hd1.picture, refFrames('clip720.ts', Math.max(0, k - 3), k + 3, 1280, 720));
        assert(Math.abs(m.n - k) <= 1 && m.diff < 1, 'paused at ' + paused.pos + ' s the picture is source frame ' + k + ' (+-1): ' + JSON.stringify(m));
        h.send('resume');
        return h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing' && e.pos > paused.pos + 0.4, 5000);
    }).then(() => {
        assert(readFrameFile(file).seq > hd1.seq, 'pictures again after resume');
        h.send('quit');
        const t = Date.now();
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, r.stderr);
            assert(Date.now() - t < 2500, 'quit took ' + (Date.now() - t) + ' ms');
            assert.strictEqual(evOf(r, 'end').length + evOf(r, 'error').length, 0, 'neither end nor error after quit');
        });
    }));
}, T);

test('MGU_START_MS=2000: decoded and thrown away to 2 s (not paced); the first picture is the one at 2 s; the sound is the reference from 2 s', () => {
    const name = shmName(), file = shmFile(name), out = wavPath();
    // paused from the start: what the frame file holds is the first picture at the position, and only it
    const h = startVideo({ MGU_AUDIO: 'wav:' + out, MGU_VIDEO: 'shm:' + name, MGU_START_MS: '2000' });
    h.send('pause');
    h.feed(clip('clip720.ts'));
    return ended(h, h.waitEvent((e) => e.ev === 'tick' && e.state === 'paused', 20000).then((first) => {
        assert(first.pos >= 2 && first.pos < 2.05, 'paused at the position: ' + JSON.stringify(first));
        return P.delay(1000);
    }).then(() => {
        const hd = readFrameFile(file);
        assertHeader(hd, 1280, 720);
        assert.strictEqual(hd.seq, 1, 'one picture written while paused at the start: ' + hd.seq);
        const k = frameAt('clip720.ts', 2.0);
        const m = whichFrame(hd.picture, refFrames('clip720.ts', k - 3, k + 3, 1280, 720));
        assert(Math.abs(m.n - k) <= 1 && m.diff < 1, 'the picture at 2 s is source frame ' + k + ' (+-1): ' + JSON.stringify(m));
        h.send('resume');
        return h.done;
    }).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        ticks(h).forEach((e) => assert(e.pos >= 2, 'a tick before the position: ' + JSON.stringify(e)));
        const last = ticks(h).pop();
        assert(readFrameFile(file).seq >= 45 && last.vdropped <= 5, 'the 2 s after it shown: ' + readFrameFile(file).seq + ', late ' + last.vdropped);
        return referenceSound('clip720.adts').then((ref) => {
            const got = P.readWav(out), off = tailOffset(got, ref);
            assert(Math.abs(off - 2 * P.RATE) <= 0.03 * P.RATE, 'the sound starts at ' + (off / P.RATE) + ' s');
            assertSameSound(got, ref, off, 'from 2 s');
        });
    }));
}, T);

test('MGU_START_MS is not paced: started at 3 s, playing within 2.5 s, done within 5 s', () => {
    const h = startVideo({ MGU_START_MS: '3000' });
    h.feed(clip('clip720.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        const playing = ticks(h).filter((e) => e.state === 'playing')[0];
        assert(playing && playing._ms < 2500, 'playing after ' + (playing && playing._ms) + ' ms');
        assert(r.ms < 5000, 'took ' + r.ms + ' ms');
        assert(playing.pos >= 3 && playing.pos < 3.6, JSON.stringify(playing));
    });
}, T);

test('MGU_BASE_MS=60000: positions count from 60 s; with MGU_START_MS=62000 it starts 2 s in; a start before the base plays from the base', () => {
    const one = (env) => {
        const out = wavPath();
        const h = startVideo(Object.assign({ MGU_AUDIO: 'wav:' + out }, env));
        h.feed(clip('clip720.ts'));
        return ended(h, h.done).then((r) => { P.assertClean(r, h); assert.strictEqual(r.code, 0, r.stderr); return { r: r, t: ticks(h), wav: P.readWav(out) }; });
    };
    return Promise.all([referenceSound('clip720.adts'), one({ MGU_BASE_MS: '60000' })]).then((a) => {
        const ref = a[0], x = a[1];
        assert(x.t[0].pos >= 60 && x.t[0].pos < 60.6, 'the first tick: ' + JSON.stringify(x.t[0]));
        assert(x.t[x.t.length - 1].pos > 63 && x.t[x.t.length - 1].pos <= 64.1, 'the last tick: ' + JSON.stringify(x.t[x.t.length - 1]));
        assertSameSound(x.wav, ref, 0, 'base 60 s');
        return one({ MGU_BASE_MS: '60000', MGU_START_MS: '62000' }).then((y) => {
            assert(y.t[0].pos >= 62 && y.t[0].pos < 62.6, 'the first tick: ' + JSON.stringify(y.t[0]));
            const off = tailOffset(y.wav, ref);
            assert(Math.abs(off - 2 * P.RATE) <= 0.03 * P.RATE, 'the sound starts at ' + (off / P.RATE) + ' s');
            assertSameSound(y.wav, ref, off, 'base 60 s, start 62 s');
            return one({ MGU_BASE_MS: '60000', MGU_START_MS: '30000' });
        }).then((z) => {
            assert(z.t[0].pos >= 60 && z.t[0].pos < 60.6, 'the first tick: ' + JSON.stringify(z.t[0]));
            assertSameSound(z.wav, ref, 0, 'start before the base');
        });
    });
}, T);

test('1080p H.264 High: the frame file is 1920x1080', () => {
    const name = shmName(), file = shmFile(name);
    const h = startVideo({ MGU_VIDEO: 'shm:' + name });
    h.feed(clip('clip1080.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        assertVideoOpen(r, 'sw', 1920, 1080, file);
        const hd = readFrameFile(file);
        assertHeader(hd, 1920, 1080);
        assert(hd.seq >= 40, 'pictures written: ' + hd.seq);
        const m = whichFrame(hd.picture, refFrames('clip1080.ts', 47, 49, 1920, 1080));
        assert(m.n === 49 && m.diff < 1, 'the last picture: ' + JSON.stringify(m));
    });
}, T);

test('MGU_VIDEO=null: decoded and counted, no frame file', () => {
    const h = startVideo({ MGU_VIDEO: 'null' });
    h.feed(clip('clip720.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        const v = evOf(r, 'video')[0];
        assert(v && v.state === 'open' && v.decoder === 'sw' && v.file === undefined, JSON.stringify(v));
        assert(ticks(h).pop().vframes >= 80, JSON.stringify(ticks(h).pop()));
    });
}, T);

test('sound alone in MPEG-TS: a video error event, the sound plays to the end, equal to the reference', () => {
    const name = shmName(), out = wavPath();
    const h = startVideo({ MGU_AUDIO: 'wav:' + out, MGU_VIDEO: 'shm:' + name });
    h.feed(clip('audio_only.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        const open = evOf(r, 'open')[0];
        assert(open && open.codec === 'aac' && open.video === undefined, 'open without a picture: ' + JSON.stringify(open));
        const v = evOf(r, 'video');
        assert(v.length === 1 && v[0].state === 'error' && /picture/.test(v[0].message), 'video error: ' + JSON.stringify(v));
        ticks(h).forEach((e) => assert.strictEqual(e.vframes, 0));
        return referenceSound('audio_only.adts').then((ref) => assertSameSound(P.readWav(out), ref, 0, 'sound alone'));
    });
}, T);

test('a picture that is not H.264 (MPEG-2): a video error event, the sound plays, equal to the reference', () => {
    const out = wavPath();
    const h = startVideo({ MGU_AUDIO: 'wav:' + out, MGU_VIDEO: 'shm:' + shmName() });
    h.feed(clip('mpeg2.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        const v = evOf(r, 'video');
        assert(v.length === 1 && v[0].state === 'error' && /H\.264/.test(v[0].message), 'video error: ' + JSON.stringify(v));
        return referenceSound('mpeg2.adts').then((ref) => assertSameSound(P.readWav(out), ref, 0, 'MPEG-2 clip'));
    });
}, T);

/** the clip with every video packet's payload scrambled (PID 0x100; the sound's packets untouched) */
function scrambledVideo(buf) {
    const b = Buffer.from(buf);
    let x = 12345;
    let hit = 0;
    for (let off = 0; off + 188 <= b.length; off += 188) {
        if (b[off] !== 0x47) continue;
        const pid = ((b[off + 1] & 0x1f) << 8) | b[off + 2];
        if (pid !== 0x100) continue;
        hit++;
        if (hit % 3) continue;   // one packet in three: the pictures break, the stream goes on
        for (let i = off + 4; i < off + 188; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
    }
    assert(hit > 100, 'video packets found: ' + hit);
    return b;
}

test('broken pictures never stop the sound: the clip with its video packets scrambled plays its whole sound, equal to the reference', () => {
    const out = wavPath();
    const h = startVideo({ MGU_AUDIO: 'wav:' + out, MGU_VIDEO: 'shm:' + shmName() });
    h.feed(scrambledVideo(clip('clip720.ts')));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        assert.strictEqual(P.lastEvent(r).ev, 'end');
        return referenceSound('clip720.adts').then((ref) => assertSameSound(P.readWav(out), ref, 0, 'scrambled pictures'));
    });
}, T);

test('garbage: random bytes are a decode error, nothing is an input error, a cut-off or spliced clip ends cleanly; never a crash', () => {
    const cases = [
        { what: 'random bytes', buf: P.noise(1 << 20, 7), codes: [5], error: 'decode' },
        { what: 'nothing', buf: Buffer.alloc(0), codes: [4], error: 'input' },
        { what: 'MPEG-TS sync bytes and noise', buf: (() => { const b = P.noise(188 * 2000, 9); for (let i = 0; i < b.length; i += 188) b[i] = 0x47; return b; })(), codes: [4, 5] },
        { what: 'the first 20 KB', buf: clip('clip720.ts').slice(0, 20000), codes: [0, 4, 5] },
        { what: 'the first half', buf: clip('clip720.ts').slice(0, clip('clip720.ts').length >> 1), codes: [0] },
        { what: 'noise in the middle', buf: Buffer.concat([clip('clip720.ts').slice(0, 300000), P.noise(100000, 3), clip('clip720.ts').slice(300000)]), codes: [0] },
        { what: 'every byte after 64 KB flipped', buf: (() => { const b = Buffer.from(clip('clip720.ts')); for (let i = 65536; i < b.length; i++) b[i] ^= 0x5a; return b; })(), codes: [0, 4, 5] },
    ];
    return cases.reduce((p, c) => p.then(() => {
        const h = startVideo({ MGU_VIDEO: 'shm:' + shmName() });
        h.feed(c.buf);
        return ended(h, h.done).then((r) => {
            P.assertClean(r, h);
            assert(c.codes.indexOf(r.code) >= 0, c.what + ': exit ' + r.code + '\n' + r.stderr);
            const last = P.lastEvent(r);
            assert(last && (last.ev === 'end' || last.ev === 'error'), c.what + ': the last event is ' + JSON.stringify(last));
            if (c.error) assert.strictEqual(last.code, c.error, c.what + ': ' + JSON.stringify(last));
            if (r.code) assert.strictEqual(last.ev, 'error', c.what);
        });
    }), Promise.resolve());
}, { timeout: 240000 });

test('MGU_VIDEO_DECODER=auto without the Intel Media SDK decodes in software; =msdk without it: a video error, the sound plays', () => {
    const a = startVideo({ MGU_VIDEO: 'shm:' + shmName(), MGU_VIDEO_DECODER: 'auto' });
    a.feed(clip('clip1080.ts'));
    return ended(a, a.done).then((r) => {
        P.assertClean(r, a);
        assert.strictEqual(r.code, 0, r.stderr);
        const v = evOf(r, 'video')[0];
        assert(v && v.state === 'open' && v.decoder === 'sw', JSON.stringify(v));
        assert(/libmfxhw64/.test(r.stderr), 'the log says why not msdk:\n' + r.stderr);
        const b = startVideo({ MGU_VIDEO: 'shm:' + shmName(), MGU_VIDEO_DECODER: 'msdk' });
        b.feed(clip('clip1080.ts'));
        return ended(b, b.done).then((r2) => {
            P.assertClean(r2, b);
            assert.strictEqual(r2.code, 0, r2.stderr);
            assert.strictEqual(P.lastEvent(r2).ev, 'end');
            const v2 = evOf(r2, 'video');
            assert(v2.length === 1 && v2[0].state === 'error' && v2[0].decoder === 'msdk', JSON.stringify(v2));
        });
    });
}, T);

test('auto with the Media SDK libraries there but no GPU (fake libraries, no render node): falls back to software', () => {
    // every function the player looks up, failing; LD_LIBRARY_PATH points the player's dlopen at them
    const libdir = path.join(dir, 'fakemfx');
    fs.mkdirSync(libdir);
    const mfx = ['MFXInit', 'MFXInitEx', 'MFXClose', 'MFXVideoCORE_SetHandle', 'MFXVideoCORE_SyncOperation', 'MFXVideoDECODE_DecodeHeader',
        'MFXVideoDECODE_QueryIOSurf', 'MFXVideoDECODE_Init', 'MFXVideoDECODE_Close', 'MFXVideoDECODE_DecodeFrameAsync', 'MFXVideoVPP_QueryIOSurf',
        'MFXVideoVPP_Init', 'MFXVideoVPP_Close', 'MFXVideoVPP_RunFrameVPPAsync'];
    const src = (names, extra) => names.map((s) => 'int ' + s + '(void) { return -1; }').join('\n') + '\n' + (extra || '') + '\n';
    fs.writeFileSync(path.join(libdir, 'mfx.c'), src(mfx));
    fs.writeFileSync(path.join(libdir, 'va.c'), src(['vaInitialize', 'vaTerminate'], 'const char *vaErrorStr(int s) { return "fake"; }'));
    fs.writeFileSync(path.join(libdir, 'vadrm.c'), 'void *vaGetDisplayDRM(int fd) { return 0; }\n');
    const cc = (out, file, soname) => cp.execFileSync('gcc', ['-shared', '-fPIC', '-Wl,-soname,' + soname, '-o', path.join(libdir, out), path.join(libdir, file)]);
    cc('libmfxhw64.so', 'mfx.c', 'libmfxhw64.so'); cc('libva.so.1', 'va.c', 'libva.so.1'); cc('libva-drm.so.1', 'vadrm.c', 'libva-drm.so.1');
    fs.chmodSync(libdir, 0o755);
    const h = startVideo({ MGU_VIDEO: 'shm:' + shmName(), MGU_VIDEO_DECODER: 'auto', LD_LIBRARY_PATH: libdir });
    h.feed(clip('clip1080.ts'));
    return ended(h, h.done).then((r) => {
        P.assertClean(r, h);
        assert.strictEqual(r.code, 0, r.stderr);
        const v = evOf(r, 'video');
        assert(v.length === 1 && v[0].state === 'open' && v[0].decoder === 'sw', JSON.stringify(v));
        assert(/msdk/.test(r.stderr) && /renderD128|vaGetDisplayDRM|MFXInit/.test(r.stderr), 'the log says what failed:\n' + r.stderr);
    });
}, T);

test('environment: MGU_VIDEO and MGU_VIDEO_DECODER not understood are exit 2 with an internal error', () => {
    const bad = [{ MGU_VIDEO: 'file:/tmp/x' }, { MGU_VIDEO: 'shm:../etc' }, { MGU_VIDEO: 'shm:' }, { MGU_VIDEO: 'shm:.hidden' }, { MGU_VIDEO_DECODER: 'gpu' }];
    return bad.reduce((p, env) => p.then(() => {
        const h = startVideo(env);
        h.feed(clip('audio_only.ts'));
        return ended(h, h.done).then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 2, JSON.stringify(env) + ': exit ' + r.code + '\n' + r.stderr);
            assert.strictEqual(P.lastEvent(r).code, 'internal', JSON.stringify(env));
        });
    }), Promise.resolve());
}, T);

test('as root: refused without MGU_RUN_AS (no frame file made); with MGU_RUN_AS=nobody the frame file is made first and given to nobody', function () {
    if (!P.isRoot()) { console.log('       (not root: skipped)'); return Promise.resolve(); }
    const n1 = shmName();
    const a = startVideo({ MGU_VIDEO: 'shm:' + n1 }, { asRoot: true });
    a.feed(clip('audio_only.ts'));
    return ended(a, a.done).then((r) => {
        P.assertClean(r, a);
        assert.strictEqual(r.code, 3, r.stderr);
        assert(!fs.existsSync(shmFile(n1)), 'no frame file made when refused');
        const n2 = shmName();
        const b = startVideo({ MGU_VIDEO: 'shm:' + n2, MGU_RUN_AS: 'nobody', MGU_GROUPS: 'video,audio' }, { asRoot: true });
        b.feed(clip('clip1080.ts'));
        return ended(b, b.done).then((r2) => {
            P.assertClean(r2, b);
            assert.strictEqual(r2.code, 0, r2.stderr);
            const st = fs.statSync(shmFile(n2));
            assert.strictEqual(st.uid, P.NOBODY, 'the frame file is nobody\'s');
            assert.strictEqual(st.mode & 0o777, 0o600, 'mode 0600');
            assert(/running as uid 65534/.test(r2.stderr), r2.stderr);
            assertHeader(readFrameFile(shmFile(n2)), 1920, 1080);
        });
    });
}, T);

test('fd 3 closing is quit', () => {
    const h = startVideo({ MGU_VIDEO: 'shm:' + shmName() });
    h.feed(clip('clip720.ts'));
    return ended(h, h.waitEvent((e) => e.ev === 'tick' && e.state === 'playing', 20000).then(() => {
        h.child.stdio[3].end();
        const t = Date.now();
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, r.stderr);
            assert(Date.now() - t < 2500, 'took ' + (Date.now() - t) + ' ms');
        });
    }));
}, T);

process.on('exit', () => {
    try { fs.readdirSync('/dev/shm').filter((f) => f.indexOf('mgu-video-tidal-video-test-' + process.pid + '-') === 0).forEach((f) => fs.unlinkSync('/dev/shm/' + f)); } catch (e) { /* gone */ }
});

run();
