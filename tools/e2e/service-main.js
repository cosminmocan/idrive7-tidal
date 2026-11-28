'use strict';
/**
 * service-main.js - the real service (native/cmocan-tidal/service.js) as its own process, for the end-to-end test
 * (tests/e2e.test.js, `make e2e`). What service.js's own main does, with what the test needs injected instead of
 * the car's paths and users (as the service's tests do; nothing here needs root):
 *
 *   - the state folder, the uplink lease and the control socket in the test's folder;
 *   - the real TIDAL module (lib/tidal.js) pointed at the fake TIDAL (baseUrls), with the service's clock;
 *   - the real client.js forked as the test's own user (uid null: the container runs unprivileged);
 *   - the real player binary, each one writing its sound to <wavDir>/<n>-<track id>.wav (MGU_AUDIO=wav:...);
 *   - for a video the real video player (videoBin), its pictures into /dev/shm/mgu-video-<videoName> with the
 *     decoder videoDecoder ('sw': the software one), its sound to <wavDir>/<n>-video-<id>.wav;
 *   - a clock the test can move forward (skew), so 90 s and 3 minutes do not take that long.
 *
 *   node tools/e2e/service-main.js '<json: { dir, sock, stateDir, leasePath, baseUrls, playerBin, videoBin, videoName,
 *       videoDecoder, wavDir, tickMs }>'
 *
 * Forked with an IPC channel. To the test: { ev: 'ready' } { ev: 'log', line }
 * { ev: 'player', n, id, kind, bin, wav, pid, startMs, baseMs, at } (kind 'track' or 'video'; bin the binary started;
 * startMs, baseMs: the MGU_START_MS and MGU_BASE_MS the service gave it, 0 without; at: Date.now() when started)
 * { ev: 'player-exit', pid, code, signal, at }
 * { ev: 'child', kind, pid } { ev: 'exit', code }. From the test (each answered by { re: id, value }):
 * { op: 'skew', ms } (the clock moves on by ms), { op: 'status' } (the service's status, which is not a request on
 * the socket: the app's watch does not see it), { op: 'stop' } (the service ends, its children first).
 * When the test goes away, the service ends. Node 8 syntax.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SVC = path.join(ROOT, 'native', 'cmocan-tidal');
const createService = require(path.join(SVC, 'service.js')).createService;
const createTidal = require(path.join(SVC, 'lib', 'tidal.js')).createTidal;

const cfg = JSON.parse(process.argv[2]);
let skew = 0;
const now = () => Date.now() + skew;
const send = (m) => { try { if (process.connected) process.send(m); } catch (e) { /* the test is gone */ } };
const logFd = fs.openSync(path.join(cfg.dir, 'service.log'), 'a');
function log(line) {
    const l = String(line);
    try { fs.writeSync(logFd, new Date().toISOString() + ' ' + l + '\n'); } catch (e) { /* the disk */ }
    send({ ev: 'log', line: l });
}

let n = 0;
let pendingPlayer = null;
const svc = createService({
    stateDir: cfg.stateDir,
    leasePath: cfg.leasePath,
    uid: null,
    now: now,
    log: log,
    tickMs: cfg.tickMs,
    exit: (code) => { send({ ev: 'exit', code: code }); setTimeout(() => process.exit(code), 200); },
    createTidal: (o) => createTidal(Object.assign({}, o, { baseUrls: cfg.baseUrls, now: now, log: log })),
    forkClient: (file, args, fo) => {
        const c = cp.fork(file, args, fo);
        send({ ev: 'child', kind: 'client', pid: c.pid });
        return c;
    },
    playerBin: cfg.playerBin,
    videoBin: cfg.videoBin,
    videoName: cfg.videoName,
    videoDecoder: cfg.videoDecoder,
    playerEnv: (id, kind) => {
        n++;
        const video = kind === 'video';
        const wav = path.join(cfg.wavDir, ('000' + n).slice(-4) + '-' + (video ? 'video-' : '') + id + '.wav');
        pendingPlayer = { n: n, id: id, kind: video ? 'video' : 'track', wav: wav };
        return { MGU_AUDIO: 'wav:' + wav };
    },
    spawn: (bin, args, so) => {
        const c = cp.spawn(bin, args, so);
        const p = pendingPlayer || { n: null, id: null, kind: null, wav: null };
        pendingPlayer = null;
        const env = so.env || {};
        send({ ev: 'player', n: p.n, id: p.id, kind: p.kind, bin: bin, wav: p.wav, pid: c.pid, startMs: Number(env.MGU_START_MS || 0),
            baseMs: Number(env.MGU_BASE_MS || 0), at: Date.now() });
        send({ ev: 'child', kind: 'player', pid: c.pid });
        c.on('exit', (code, signal) => send({ ev: 'player-exit', pid: c.pid, code: code, signal: signal, at: Date.now() }));
        return c;
    },
});

process.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    let value = null;
    if (m.op === 'skew') { skew += Number(m.ms) || 0; svc.tick(); value = skew; }
    else if (m.op === 'status') value = svc.status();
    else if (m.op === 'stop') { Promise.resolve(svc.stop(0)).then(() => send({ re: m.id, value: true })); return; }
    send({ re: m.id, value: value });
});
process.on('disconnect', () => svc.stop(0));
process.on('SIGTERM', () => svc.stop(0));

svc.listen(cfg.sock).then(() => { svc.start(); send({ ev: 'ready' }); });
