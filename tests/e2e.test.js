'use strict';
/**
 * e2e.test.js - the whole thing, end to end (WORKPLAN.md task I1; `make e2e`): the fake TIDAL (tests/fakes/
 * fake_tidal.js) in this process; the REAL service (native/cmocan-tidal/service.js, tools/e2e/service-main.js) in
 * its own process, with the real TIDAL module (lib/tidal.js), the real client.js forked as its child (every byte
 * from the fake goes through it, lib/netx.js) and the REAL player binary, one per track, each writing its sound to
 * a WAV (MGU_AUDIO=wav:...); and the app's real service client and state machine (apps/cmocan_tidal/client.js,
 * model.js; tools/e2e/app.js) driven by this script over the control socket.
 *
 * The tracks are generated tones in AAC-LC, MP4 with the index first, as TIDAL serves HIGH (tools/e2e/
 * make-fixtures.sh). Each track is also played once by the player straight from the file, uninterrupted: that WAV
 * is the reference every WAV of the service must equal (whole) or begin with (a track left early), sample for
 * sample, so no sound is lost or repeated by pauses, cuts and retries. A player started by a seek must equal the
 * reference from its position on.
 *
 * The scenarios run in order, one session: each starts from where the one before left the service.
 * Needs E2E_PLAYER (the player binary) and E2E_FIXTURES (make-fixtures.sh's folder); without them (as in `make
 * test`, whose node:8.9.4 image cannot run the binary) it prints one skip line and passes.
 * E2E_VERBOSE=1 shows the service's log. Node 8 syntax.
 */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const t = require('./lib/t');
const run = t.run;
// E2E_ONLY=<regexp>: only the scenarios whose names match (and the start and the end)
const ONLY = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY) : null;
const test = (name, fn, o) => { if (!ONLY || /^(start|the end)/.test(name) || ONLY.test(name)) t.test(name, fn, o); };
const T0 = Date.now();
const stamp = () => ('      ' + (Date.now() - T0)).slice(-7) + ' ';

const PLAYER = process.env.E2E_PLAYER || '';
const FIXTURES = process.env.E2E_FIXTURES || '';
if (!PLAYER || !fs.existsSync(PLAYER) || !FIXTURES || !fs.existsSync(path.join(FIXTURES, 'tone440_8s.m4a'))) {
    console.log('  skip e2e.test.js: no player binary or fixtures (E2E_PLAYER, E2E_FIXTURES); it runs in `make e2e`');
    process.exit(0);
}

const { createFakeTidal } = require('./fakes/fake_tidal');
const { writeLease } = require('./fakes/service_harness');
const { createAppDriver } = require('../tools/e2e/app');

const VERBOSE = !!process.env.E2E_VERBOSE;
const RATE = 48000;
const FRAME = 4;   // 16-bit stereo

// the catalogue's tracks (tests/fixtures/tidal/library.json) and the tone each one plays here
const A = 17927864, B = 17927865, C = 17927866, D = 77777702, E = 77777703;
const F = 77777701;   // not a favourite: played by its id, for the long seek
const TONES = {};
TONES[A] = { file: 'tone440_8s.m4a', hz: 440, secs: 8 };
TONES[B] = { file: 'tone660_6s.m4a', hz: 660, secs: 6 };
TONES[C] = { file: 'tone880_6s.m4a', hz: 880, secs: 6 };
TONES[D] = { file: 'tone1000_24s.m4a', hz: 1000, secs: 24 };
TONES[E] = { file: 'tone550_10s.m4a', hz: 550, secs: 10 };
TONES[F] = { file: 'tone770_190s.m4a', hz: 770, secs: 190 };
const IDS = [A, B, C, D, E];
const ALL = IDS.concat([F]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 10000);
    return new Promise((resolve, reject) => {
        (function again() {
            Promise.resolve().then(fn).then((v) => {
                if (v) return resolve(v);
                if (Date.now() > end) return reject(new Error('timed out waiting for ' + (what || fn.toString())));
                setTimeout(again, 50);
            }, reject);
        })();
    });
}
/** a process is there and not a zombie */
function alive(pid) {
    try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch (e) { return false; }
}

/* ---------- WAVs ---------- */
/** a 16-bit PCM WAV: { rate, channels, bits, data (Buffer, whole frames) } */
function readPcm(file) {
    const b = fs.readFileSync(file);
    assert.strictEqual(b.toString('latin1', 0, 4), 'RIFF', file + ' is not a WAV');
    assert.strictEqual(b.toString('latin1', 8, 12), 'WAVE', file + ' is not a WAV');
    let off = 12, fmt = null;
    while (off + 8 <= b.length) {
        const id = b.toString('latin1', off, off + 4);
        let size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
        if (id === 'data') {
            assert(fmt, file + ': no fmt chunk');
            if (off + 8 + size > b.length) size = b.length - off - 8;
            size -= size % FRAME;
            return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, format: fmt.format, data: b.slice(off + 8, off + 8 + size) };
        }
        off += 8 + size + (size & 1);
    }
    throw new Error(file + ': no data chunk');
}
const seconds = (pcm) => pcm.data.length / FRAME / RATE;
/** the loudest frequency (Hz) of the left channel, 0.2 s from frame `from`, searched from lo to hi */
function freqOf(pcm, from, lo, hi) {
    const n = Math.min(9600, pcm.data.length / FRAME - from);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = pcm.data.readInt16LE((from + i) * FRAME) / 32768;
    let best = 0, bestP = -1;
    for (let f = lo; f <= hi; f += 0.5) {
        const w = 2 * Math.PI * f / RATE;
        let re = 0, im = 0;
        for (let i = 0; i < n; i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
        const p = re * re + im * im;
        if (p > bestP) { bestP = p; best = f; }
    }
    return best;
}
function assertFormat(pcm, what) {
    assert.strictEqual(pcm.format, 1, what + ': PCM');
    assert.strictEqual(pcm.rate, RATE, what + ': 48 kHz');
    assert.strictEqual(pcm.channels, 2, what + ': stereo');
    assert.strictEqual(pcm.bits, 16, what + ': 16-bit');
}
/** the tone of `id` is what plays, within 1 %, near the start and near the end of what is there */
function assertTone(pcm, id, what) {
    const hz = TONES[id].hz;
    const frames = pcm.data.length / FRAME;
    assert(frames >= RATE / 2, what + ': only ' + seconds(pcm).toFixed(2) + ' s of sound');
    [Math.floor(frames * 0.1), Math.max(0, frames - 9600 - RATE / 10)].forEach((at) => {
        const f = freqOf(pcm, at, hz * 0.9, hz * 1.1);
        assert(Math.abs(f - hz) / hz < 0.01, what + ': ' + f + ' Hz at ' + (at / RATE).toFixed(2) + ' s, the track is ' + hz + ' Hz');
    });
}

/* ---------- MP4 ---------- */
/** the top-level boxes of an MP4 file, in order */
function boxes(b) {
    const out = [];
    let off = 0;
    while (off + 8 <= b.length) {
        let size = b.readUInt32BE(off);
        const type = b.toString('latin1', off + 4, off + 8);
        if (size === 1) size = b.readUInt32BE(off + 12);   // 64-bit size (never this big here)
        if (size === 0) size = b.length - off;
        out.push(type);
        if (size < 8) break;
        off += size;
    }
    return out;
}
/** the audio object type in the MP4's esds (2: AAC-LC), and the object type indication (0x40: MPEG-4 audio) */
function aacObjectType(b) {
    const at = b.indexOf('esds', 0, 'latin1');
    assert(at > 0, 'no esds box');
    let off = at + 4 + 4;   // the type, version and flags
    function desc() {
        const tag = b[off++];
        let len = 0;
        for (let k = 0; k < 4; k++) { const c = b[off++]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
        return { tag: tag, len: len };
    }
    const es = desc();
    assert.strictEqual(es.tag, 3, 'ES_Descriptor');
    off += 2;
    const flags = b[off++];
    if (flags & 0x80) off += 2;
    if (flags & 0x40) off += 1 + b[off];
    if (flags & 0x20) off += 2;
    const dc = desc();
    assert.strictEqual(dc.tag, 4, 'DecoderConfigDescriptor');
    const oti = b[off];
    off += 13;
    const ds = desc();
    assert.strictEqual(ds.tag, 5, 'DecoderSpecificInfo');
    return { oti: oti, aot: b[off] >> 3 };
}

/* ---------- the parts ---------- */
const X = {
    dir: null, fake: null, svc: null, app: null, logs: [], players: [], children: [], refs: {}, refPlayers: [], exited: null,
    calls: {}, callId: 0,
};
function call(op, extra) {
    return new Promise((resolve, reject) => {
        const id = ++X.callId;
        const t = setTimeout(() => { delete X.calls[id]; reject(new Error('the service did not answer ' + op)); }, 10000);
        X.calls[id] = (v) => { clearTimeout(t); resolve(v); };
        X.svc.send(Object.assign({ op: op, id: id }, extra || {}));
    });
}
const svcStatus = () => call('status');
const skew = (ms) => call('skew', { ms: ms });
const playersSince = (k) => X.players.slice(k);
const logsSince = (k) => X.logs.slice(k);
function fileRequests(k, id) { return X.fake.log.slice(k).filter((e) => e.path === '/files/' + id + '.m4a'); }

/** the track played straight from its file by the player, uninterrupted: the reference WAV */
function reference(id) {
    const wav = path.join(X.dir, 'ref-' + id + '.wav');
    return new Promise((resolve, reject) => {
        const p = cp.spawn(PLAYER, [], { env: { PATH: process.env.PATH, MGU_AUDIO: 'wav:' + wav, MGU_PREBUFFER_MS: '200' }, stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.stdin.on('error', () => {});
        p.stdin.end(fs.readFileSync(path.join(FIXTURES, TONES[id].file)));
        X.refPlayers.push(p);
        p.on('exit', (code) => {
            if (code !== 0) return reject(new Error('the reference player for ' + id + ' ended with ' + code + ': ' + err));
            try { resolve(readPcm(wav)); } catch (e) { reject(e); }
        });
    });
}

/**
 * the WAV of a player of the service: 48 kHz stereo 16-bit; the same samples as the reference, all of them
 * (whole) or the first ones (a track left early); and the track's tone. A player started by a seek (opts.from,
 * seconds): the reference's samples from that position on, to its end (whole) or the first of them.
 */
function checkWav(p, opts) {
    const o = opts || {};
    const from = o.from || 0;
    const what = 'player ' + p.n + ' (track ' + p.id + (from ? ' from ' + from + ' s' : '') + ')';
    assert.strictEqual(p.startMs, Math.round(from * 1000), what + ': the player was started at ' + p.startMs + ' ms');
    return X.refs[p.id].then((whole) => {
        const got = readPcm(p.wav);
        assertFormat(got, what);
        const ref = { data: whole.data.slice(Math.min(whole.data.length, Math.round(from * RATE) * FRAME)) };
        if (o.whole) {
            assert(Math.abs(seconds(got) + from - TONES[p.id].secs) / TONES[p.id].secs < 0.01,
                what + ': ' + seconds(got).toFixed(3) + ' s of sound, the track is ' + TONES[p.id].secs + ' s');
        }
        const n = got.data.length;
        assert(n <= ref.data.length, what + ': ' + seconds(got).toFixed(3) + ' s, more than the reference ' + seconds(ref).toFixed(3) + ' s');
        if (!ref.data.slice(0, n).equals(got.data)) {
            let i = 0;
            while (i < n && ref.data[i] === got.data[i]) i++;
            assert.fail(what + ': the sound differs from the reference from ' + (from + Math.floor(i / FRAME) / RATE).toFixed(3) + ' s on (lost or repeated sound)');
        }
        if (o.whole) assert.strictEqual(n, ref.data.length, what + ': ' + seconds(got).toFixed(3) + ' s, the reference has ' + seconds(ref).toFixed(3) + ' s');
        if (o.tone !== false) assertTone(got, p.id, what);
        return got;
    });
}

const playing = (id, idx, minPos) => (s) => s.player && s.player.state === 'playing' && s.player.track && s.player.track.id === id &&
    s.player.queueIndex === idx && s.player.position >= minPos;

/* ================================ the scenarios ================================ */

test('start: the fake TIDAL, the real service with client.js and the player, the app', async () => {
    X.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-e2e-'));
    X.wavDir = path.join(X.dir, 'wav');
    fs.mkdirSync(X.wavDir);
    X.stateDir = path.join(X.dir, 'state');
    X.leasePath = path.join(X.dir, 'lease.json');
    X.sock = path.join(X.dir, 'cmocan-tidal.sock');
    X.sessionFile = path.join(X.stateDir, 'session.json');
    // the references play meanwhile (in real time, as the service's players do)
    ALL.forEach((id) => { X.refs[id] = reference(id); X.refs[id].catch(() => {}); });

    const fake = X.fake = await createFakeTidal({ loginInterval: 1 });
    if (VERBOSE) {
        const push = fake.log.push.bind(fake.log);
        fake.log.push = (e) => { if (/^\/files\//.test(e.path)) console.log(stamp() + 'fake: GET ' + e.path + ' ' + (e.headers.range || '')); return push(e); };
    }
    ALL.forEach((id) => {
        const t = fake.data.tracks.filter((x) => x && x.id === id)[0];
        assert(t, 'track ' + id + ' in the fake catalogue');
        t.duration = TONES[id].secs;
        t.streamReady = true;
        if (!t.title) t.title = 'Track ' + id;
        fake.files[id + '.m4a'] = fs.readFileSync(path.join(FIXTURES, TONES[id].file));
    });
    fake.data.favoriteTracks = IDS.slice();
    X.playlist = fake.data.playlists[0].uuid;
    fake.data.playlistTracks[X.playlist] = [A, B, C];
    writeLease(X.leasePath);

    X.svc = cp.fork(path.join(__dirname, '..', 'tools', 'e2e', 'service-main.js'), [JSON.stringify({
        dir: X.dir, sock: X.sock, stateDir: X.stateDir, leasePath: X.leasePath, baseUrls: fake.baseUrls, playerBin: PLAYER,
        wavDir: X.wavDir, tickMs: 500,
    })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    X.exited = new Promise((r) => X.svc.on('exit', (code, signal) => r({ code: code, signal: signal })));
    const ready = new Promise((resolve) => {
        X.svc.on('message', (m) => {
            if (!m || typeof m !== 'object') return;
            if (m.re && X.calls[m.re]) { const f = X.calls[m.re]; delete X.calls[m.re]; f(m.value); }
            else if (m.ev === 'ready') resolve();
            else if (m.ev === 'log') { X.logs.push(m.line); if (VERBOSE) console.log(stamp() + 'svc: ' + m.line); }
            else if (m.ev === 'player') X.players.push(m);
            else if (m.ev === 'child') X.children.push(m);
        });
    });
    await ready;
    X.app = createAppDriver({ socketPath: X.sock, log: (l) => { if (VERBOSE) console.log(stamp() + l); } });
    await waitFor(() => X.children.some((c) => c.kind === 'client'), 10000, 'client.js forked');
    await waitFor(() => X.logs.some((l) => /^client running as uid/.test(l)), 15000, 'client.js running');
}, { timeout: 60000 });

test('1. log in: the device login through the fake TIDAL; the app goes LOGIN -> LIBRARY', async () => {
    const app = X.app;
    await app.until((s) => s.screen === 'LOGIN' && s.login && s.login.userCode, 15000, 'a login code on the login screen');
    const lg = app.state().login;
    assert(/^https:\/\//.test(lg.url), 'the QR link is https: ' + lg.url);
    assert.strictEqual(lg.userCode, X.fake.login.userCode);
    assert(!fs.existsSync(X.sessionFile), 'no session before the login');
    X.fake.approve();
    await app.until((s) => s.screen === 'LIBRARY', 15000, 'the library');
    assert.strictEqual(app.state().service.login, 'logged-in');
    const i = app.screens.indexOf('LOGIN');
    assert(i >= 0 && app.screens.indexOf('LIBRARY') > i, 'LOGIN then LIBRARY: ' + app.screens.join(' '));
    assert.strictEqual(fs.statSync(X.sessionFile).mode & 0o777, 0o600, 'session.json is 0600');
    const sess = JSON.parse(fs.readFileSync(X.sessionFile, 'utf8'));
    assert.strictEqual(sess.version, 1);
    assert.strictEqual(sess.userId, X.fake.data.userId);
}, { timeout: 60000 });

test('2. play a favourite: AAC in MP4 (moov first) from TIDAL; the WAV is its tone, 48 kHz stereo, its length', async () => {
    const app = X.app;
    // the file as TIDAL serves HIGH: AAC-LC in MP4, the index before the audio, not fragmented
    const file = X.fake.files[A + '.m4a'];
    const bx = boxes(file);
    assert.strictEqual(bx[0], 'ftyp', 'boxes: ' + bx.join(' '));
    assert(bx.indexOf('moov') > 0 && bx.indexOf('moov') < bx.indexOf('mdat'), 'moov before mdat: ' + bx.join(' '));
    assert(bx.indexOf('moof') < 0, 'not fragmented');
    assert.deepStrictEqual(aacObjectType(file), { oti: 0x40, aot: 2 }, 'AAC-LC');

    const f = await app.openList('fav', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    assert.deepStrictEqual(f.items.map((t) => t.id), IDS, 'the favourites');
    const k = X.players.length, kl = X.logs.length, kf = X.fake.log.length;
    const a = await app.play(0);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    // the owner's choice (docs/ui-redesign.md): after choosing a track the app stays in the list
    assert.strictEqual(app.state().screen, 'LIST', 'stays in the list after play');
    await app.until(playing(A, 0, 1), 20000, 'A playing');
    assert.strictEqual(app.state().player.quality, 'HIGH');
    // A plays to its end, then the queue goes on to B: stopped there
    await app.until((s) => s.player && s.player.queueIndex === 1, 30000, 'A played, B next');
    await app.request('stop');
    await app.until((s) => s.player && s.player.state === 'idle', 10000, 'stopped');
    const ps = playersSince(k);
    assert.strictEqual(ps[0].id, A);
    const reqs = fileRequests(kf, A);
    assert.strictEqual(reqs.length, 1, 'A fetched once');
    assert(!reqs[0].headers.range, 'from the first byte');
    const open = logsSince(kl).filter((l) => l.indexOf('player ' + ps[0].pid + ': {"ev":"open"') === 0)[0];
    assert(open, 'the player said open');
    const ev = JSON.parse(open.slice(open.indexOf('{')));
    assert.strictEqual(ev.codec, 'aac');
    assert.strictEqual(ev.rate, 44100);
    assert.strictEqual(ev.channels, 2);
    await checkWav(ps[0], { whole: true });
}, { timeout: 90000 });

test('3. next and previous: the players, their WAVs and the queue positions follow the queue', async () => {
    const app = X.app;
    const f = await app.openList('pl', 'Road trip', 'tracks', 'playlist', { uuid: X.playlist });
    assert.deepStrictEqual(f.items.map((t) => t.id), [A, B, C]);
    const k = X.players.length, ks = app.statuses.length;
    await app.play(0);
    await app.until(playing(A, 0, 1), 20000, 'A playing');
    await app.request('next');
    await app.until(playing(B, 1, 1), 20000, 'B playing');
    await app.request('prev');                       // under 3 s into B: the previous track
    await app.until(playing(A, 0, 1), 20000, 'A again');
    await app.until(playing(A, 0, 3.5), 20000, 'A past 3 s');
    const before = X.players.length;
    await app.request('prev');                       // past 3 s: A again from its start
    await waitFor(() => X.players.length > before, 10000, 'a new player for A');
    await app.until((s) => s.player && s.player.queueIndex === 0 && s.player.position < 2, 10000, 'A from the start');
    await app.until(playing(A, 0, 1), 20000, 'A playing again');
    await app.request('next');
    await app.until(playing(B, 1, 1), 20000, 'B playing');
    await app.request('next');
    await app.until(playing(C, 2, 1), 20000, 'C playing');
    await app.until((s) => s.player && s.player.state === 'idle', 20000, 'C played, the queue at its end');
    assert.strictEqual(app.state().player.queueIndex, 2);
    const a = await app.request('next');             // at the end: harmless
    assert.strictEqual(a.ok, true);
    await app.poll();
    assert.strictEqual(app.state().player.state, 'idle');
    const ps = playersSince(k);
    assert.deepStrictEqual(ps.map((p) => p.id), [A, B, A, A, B, C], 'one player per step');
    const idx = [];
    app.statuses.slice(ks).forEach((st) => { if (st.queueIndex !== idx[idx.length - 1]) idx.push(st.queueIndex); });
    assert.deepStrictEqual(idx.filter((x) => x >= 0), [0, 1, 0, 1, 2], 'the queue positions in status');
    for (let i = 0; i < ps.length; i++) await checkWav(ps[i], { whole: i === ps.length - 1 });
}, { timeout: 120000 });

test('4. pause and resume: the position stands, nothing is written while paused, no sound lost or repeated', async () => {
    const app = X.app;
    await app.openList('fav-4', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    const k = X.players.length;
    await app.play(4);
    await app.until(playing(E, 4, 3), 20000, 'E past 3 s');
    await app.request('pause');
    await app.until((s) => s.player && s.player.state === 'paused', 5000, 'paused');
    await sleep(800);   // the last tick before the pause, and stdio's buffer, are out
    const p = playersSince(k)[0];
    await app.poll();
    const pos = app.state().player.position, size = fs.statSync(p.wav).size;
    await sleep(4000);
    await app.poll();
    assert.strictEqual(app.state().player.state, 'paused');
    assert(app.state().player.position <= pos + 0.01, 'the position stands: ' + pos + ' -> ' + app.state().player.position);
    assert.strictEqual(fs.statSync(p.wav).size, size, 'nothing written while paused');
    await app.request('resume');
    await app.until((s) => s.player && s.player.state === 'playing', 5000, 'playing again');
    await app.until((s) => s.player && s.player.state === 'idle', 30000, 'E played to its end');
    assert.strictEqual(playersSince(k).length, 1, 'the same player all along');
    await checkWav(p, { whole: true });
}, { timeout: 90000 });

test('5. the network cut for 20 s mid-track: the download goes on with Range, the WAV loses and repeats nothing', async () => {
    const app = X.app;
    await app.openList('fav-5', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    const name = D + '.m4a', file = X.fake.files[name];
    const cutAt = Math.floor(file.length / 3);
    const k = X.players.length, kf = X.fake.log.length, ks = app.statuses.length;
    X.fake.fileFault = { name: name, cutAfter: cutAt };   // a third of the track, then the connection is cut
    await app.play(3);
    await waitFor(() => fileRequests(kf, D).length >= 1, 15000, 'the download');
    X.fake.fileFault = null;
    const outage = { path: '/files/' + name, drop: true, times: 1e9 };   // and nothing gets through for 20 s
    X.fake.faults.push(outage);
    const t0 = Date.now();
    await waitFor(() => Date.now() - t0 >= 20000, 25000);
    outage.times = 0;
    const tried = fileRequests(kf, D);
    assert(tried.filter((e) => e.fault).length >= 2, 'tried again during the cut: ' + tried.length);
    await app.until((s) => s.player && s.player.queueIndex === 4, 60000, 'D played to its end, E next');
    await app.request('stop');
    await app.until((s) => s.player && s.player.state === 'idle', 10000, 'stopped');
    const ok = fileRequests(kf, D).filter((e) => !e.fault);
    const seen = fileRequests(kf, D).map((e) => (e.fault ? 'dropped' : (e.headers.range || 'whole')) + '@' + (e.at - t0) + 'ms').join(', ');
    assert.strictEqual(ok.length, 2, 'the first request and one continuation: ' + seen + '; the cut at byte ' + cutAt);
    assert.strictEqual(ok[1].headers.range, 'bytes=' + cutAt + '-', 'continued with Range from the byte it stopped at');
    const states = app.statuses.slice(ks).filter((s) => s.trackId === D).map((s) => s.state);
    assert(states.indexOf('buffering') >= 0, 'the player ran dry: buffering (' + states.join(' ') + ')');
    assert(states.indexOf('error') < 0, 'no error');
    const ps = playersSince(k);
    assert.deepStrictEqual(ps.slice(0, 1).map((p) => p.id), [D]);
    assert.strictEqual(ps[1].id, E, 'one player for D');
    await checkWav(ps[0], { whole: true });
}, { timeout: 150000 });

test('6. the uplink gone for 3 minutes: error offline; when it is back, play works again', async () => {
    const app = X.app;
    await app.openList('fav-6', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    const name = D + '.m4a', file = X.fake.files[name];
    const k = X.players.length, kf = X.fake.log.length, kl = X.logs.length;
    X.fake.fileFault = { name: name, cutAfter: Math.floor(file.length / 4) };
    await app.play(3);
    await waitFor(() => fileRequests(kf, D).length >= 1, 15000, 'the download');
    // the uplink goes: no lease, and the fake unreachable
    X.fake.fileFault = null;
    fs.unlinkSync(X.leasePath);
    const gone = { drop: true, times: 1e9 };
    X.fake.faults.push(gone);
    await waitFor(() => logsSince(kl).some((l) => l.indexOf('track ' + D + ': download broke') === 0), 30000, 'the download broke');
    // 3 minutes and a half pass, the app asking for status all along (its watch sees it)
    for (let i = 0; i < 7; i++) { await skew(30000); await app.poll(); }
    await app.until((s) => s.player && s.player.state === 'error' && s.player.error === 'offline', 20000, 'error offline');
    assert.strictEqual(app.state().service.online, false, 'status.online false');
    const p = playersSince(k)[0];
    await waitFor(() => !alive(p.pid), 10000, 'the player ended');
    // with no uplink: the list fetched before comes back stale, and play is offline at once
    const f = await app.openList('fav-6b', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    assert.strictEqual(f.stale, true, 'the cached list, stale');
    await app.play(4);
    await app.until((s) => s.player && s.player.state === 'error' && s.player.error === 'offline' && s.player.queueIndex === 4, 10000, 'play: error offline');
    // the uplink is back
    writeLease(X.leasePath);
    gone.times = 0;
    await app.until((s) => s.service.online === true, 5000, 'online again');
    const k2 = X.players.length;
    await app.play(4);
    await app.until(playing(E, 4, 1), 20000, 'E playing');
    await app.until((s) => s.player && s.player.state === 'idle', 30000, 'E played to its end');
    const ps = playersSince(k2);
    assert.deepStrictEqual(ps.map((x) => x.id), [E]);
    await checkWav(ps[0], { whole: true });
    await checkWav(p, { tone: false });   // what D played before the uplink went was right too
}, { timeout: 150000 });

test('7. the access token expires mid-session: one refresh, playback goes on', async () => {
    const app = X.app;
    await app.openList('pl-7', 'Road trip', 'tracks', 'playlist', { uuid: X.playlist });
    const k = X.players.length, kf = X.fake.log.length;
    const refreshes = X.fake.counts.refresh;
    await app.play(1);
    await app.until(playing(B, 1, 1), 20000, 'B playing');
    X.fake.expireAccessTokens();
    await app.until(playing(C, 2, 1), 30000, 'C playing after B');
    await app.until((s) => s.player && s.player.state === 'idle', 20000, 'C played to its end');
    assert.strictEqual(X.fake.counts.refresh, refreshes + 1, 'one refresh');
    const asked = X.fake.log.slice(kf).filter((e) => e.path === '/api/v1/tracks/' + C + '/urlpostpaywall');
    assert.strictEqual(asked.length, 2, 'refused once (401), then asked again with the new token');
    const lists = await app.openList('pls-7', 'Playlists', 'playlists', 'playlists', {});
    assert(lists.items.length >= 1 && !lists.error, 'the API works with the new token');
    assert.strictEqual(X.fake.counts.refresh, refreshes + 1, 'still one refresh');
    const ps = playersSince(k);
    assert.deepStrictEqual(ps.map((x) => x.id), [B, C]);
    await checkWav(ps[0], { whole: true });
    await checkWav(ps[1], { whole: true });
}, { timeout: 90000 });

test('8. the app goes silent: playback stops after the 90 s watch (and not at 85 s)', async () => {
    const app = X.app;
    await app.openList('fav-8', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    const k = X.players.length;
    await app.play(3);
    await app.until(playing(D, 3, 1), 20000, 'D playing');
    app.silent(true);
    await sleep(500);
    await skew(85000);
    await sleep(1500);   // three of the watch's ticks
    let st = await svcStatus();
    const p = playersSince(k)[0];
    assert.strictEqual(st.player.state, 'playing', 'still playing at 85 s');
    assert(alive(p.pid), 'the player still runs');
    await skew(6000);
    await waitFor(() => svcStatus().then((x) => x.player.state === 'idle'), 5000, 'stopped by the watch');
    await waitFor(() => !alive(p.pid), 10000, 'the player ended');
    assert(X.logs.some((l) => /has not asked for \d+ s: stopping playback/.test(l)), 'the watch said why');
    app.silent(false);
    await app.until((s) => s.player && s.player.state === 'idle', 5000, 'the app sees idle');
    st = await svcStatus();
    assert.strictEqual(st.player.queueIndex, 3, 'the queue kept');
    const got = await checkWav(p);
    assert(seconds(got) < TONES[D].secs - 5, 'stopped early: ' + seconds(got).toFixed(2) + ' s');
}, { timeout: 90000 });

// scenario 10 (phase 2, task S1) runs before 9: it needs the login that 9 ends
test('10. seek: forward, back, to the last seconds and to 3 minutes; each player\'s WAV is the reference from its position', async () => {
    const app = X.app;
    await app.openList('fav-10', 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
    const k = X.players.length, kf = X.fake.log.length;
    const between = (lo, hi) => (s) => s.player && s.player.state === 'playing' && s.player.queueIndex === 3 && s.player.position >= lo && s.player.position < hi;
    /** seek, and the position is there at once; resolves with where app.statuses was then */
    async function seek(position) {
        const a = await app.request('seek', { position: position });
        assert.deepStrictEqual({ ok: a.ok, error: a.error }, { ok: true, error: undefined }, 'seek ' + position);
        await app.poll();
        const p = app.state().player;
        assert(p.position >= position && p.position < position + 2, 'right after seek ' + position + ': position ' + p.position + ', ' + p.state);
        assert.strictEqual(p.queueIndex, 3);
        return app.statuses.length;
    }
    await app.play(3);
    await app.until(playing(D, 3, 2), 20000, 'D playing');
    // forward
    let ks = await seek(15);
    await app.until(between(16.5, 24), 20000, 'D playing past 16.5 s');
    app.statuses.slice(ks).forEach((s) => assert(s.position >= 15 && s.state !== 'error', 'after the seek to 15 s: ' + JSON.stringify(s)));
    // back
    ks = await seek(4);
    await app.until(between(5.5, 14), 20000, 'D playing past 5.5 s');
    app.statuses.slice(ks).forEach((s) => assert(s.position >= 4 && s.position < 14 && s.state !== 'error', 'after the seek to 4 s: ' + JSON.stringify(s)));
    // while paused: it stays paused at the position, and plays from there
    await app.request('pause');
    await app.until((s) => s.player && s.player.state === 'paused', 5000, 'paused');
    ks = await seek(20.25);
    await sleep(3000);
    await app.poll();
    app.statuses.slice(ks).forEach((s) => assert(s.state !== 'playing' && s.position === 20.25, 'paused after the seek to 20.25 s: ' + JSON.stringify(s)));
    assert.strictEqual(app.state().player.state, 'paused');
    const paused = playersSince(k)[3];
    assert(paused && paused.startMs === 20250, 'the paused player: ' + JSON.stringify(paused));
    let size = 0;
    try { size = fs.statSync(paused.wav).size; } catch (e) { /* not made yet */ }
    assert(size <= 44, 'nothing played while paused: a WAV of ' + size + ' bytes');
    await app.request('resume');
    // D plays its last seconds, then the queue goes on to E: stopped there
    await app.until((s) => s.player && s.player.queueIndex === 4, 30000, 'D played to its end, E next');
    await app.request('stop');
    await app.until((s) => s.player && s.player.state === 'idle', 10000, 'stopped');
    const ps = playersSince(k);
    assert.deepStrictEqual(ps.slice(0, 4).map((p) => p.id), [D, D, D, D], 'a player for each seek');
    assert.deepStrictEqual(ps.slice(0, 4).map((p) => p.startMs), [0, 15000, 4000, 20250]);
    assert.strictEqual(ps[4].id, E);
    const reqs = fileRequests(kf, D);
    assert.strictEqual(reqs.length, 4, 'D fetched once for each player');
    reqs.forEach((r) => assert(!r.headers.range, 'each from the first byte: ' + r.headers.range));
    await checkWav(ps[0]);
    await checkWav(ps[1], { from: 15 });
    await checkWav(ps[2], { from: 4 });
    await checkWav(ps[3], { from: 20.25, whole: true });

    // a seek to 3 minutes into an AAC 320 track of 190 s (7.6 MB): how long until it plays
    const k2 = X.players.length;
    const a = await app.request('play', { tracks: [F], index: 0 });
    assert.strictEqual(a.ok, true);
    const playingF = (lo) => (s) => s.player && s.player.state === 'playing' && s.player.queueLength === 1 && s.player.position >= lo;
    await app.until(playingF(1), 30000, 'F playing');
    const t0 = Date.now();
    assert.strictEqual((await app.request('seek', { position: 180 })).ok, true);
    await waitFor(() => app.poll().then(playingF(180)), 60000, 'F playing from 180 s');
    const ms = Date.now() - t0;
    console.log('       seek to 180 s (' + Math.round(X.fake.files[F + '.m4a'].length / 1024) + ' KiB AAC, 190 s): playing after ' + ms + ' ms');
    assert(ms < 30000, 'the seek to 180 s took ' + ms + ' ms');
    await app.until((s) => s.player && s.player.state === 'idle', 30000, 'F played to its end');
    const pf = playersSince(k2);
    assert.deepStrictEqual(pf.map((p) => [p.id, p.startMs]), [[F, 0], [F, 180000]]);
    await checkWav(pf[0]);
    await checkWav(pf[1], { from: 180, whole: true });
}, { timeout: 400000 });

test('9. log out removes the session file; the app is back on the login screen', async () => {
    const app = X.app;
    assert(fs.existsSync(X.sessionFile));
    const a = await app.request('logout');
    assert.strictEqual(a.ok, true);
    assert(!fs.existsSync(X.sessionFile), 'session.json removed');
    assert(!fs.existsSync(path.join(X.stateDir, 'covers')), 'the cover cache removed');
    await app.until((s) => s.screen === 'LOGIN', 10000, 'the login screen');
    const b = await app.request('favorites', { kind: 'tracks', offset: 0, limit: 50 });
    assert.strictEqual(b.error, 'not-logged-in');
}, { timeout: 30000 });

test('the end: the service ends, its children with it; no process left', async () => {
    // a reference still playing (the long one, when the scenario that waits for it did not run): not waited for
    X.refPlayers.forEach((p) => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } });
    if (X.app) X.app.close();
    if (X.svc && X.svc.connected) {
        await call('stop').catch(() => null);
        X.svc.disconnect();
    }
    if (X.exited) await Promise.race([X.exited, sleep(10000)]);
    const pids = X.children.map((c) => c.pid).concat(X.svc ? [X.svc.pid] : []);
    try {
        await waitFor(() => pids.every((p) => !alive(p)), 10000, 'every process of the service to end');
    } finally {
        pids.forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } });
        if (X.fake) await X.fake.close();
        if (X.dir && !process.env.E2E_KEEP) cp.spawnSync('rm', ['-rf', X.dir]);
    }
}, { timeout: 30000 });

process.on('exit', () => { if (X.svc) { try { X.svc.kill('SIGKILL'); } catch (e) { /* gone */ } } });
run();
