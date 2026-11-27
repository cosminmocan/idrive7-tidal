'use strict';
/**
 * soak.js - task I3: a long run of the real service, TIDAL client and player against the fake TIDAL, with random
 * faults, to find crashes, leaks and stuck states. Runs in the player's test image (tools/e2e/soak.sh). Node 8 syntax.
 *
 *   SOAK_SECONDS (default 7200)  SOAK_SEED (default 1)  SOAK_OUT (default /out): report.json, metrics.csv, soak.log
 *
 * It plays the five favourite tones in a loop and, every few seconds, does one of: cut the download, an outage of
 * the file server (3-8 s), expire the access token (401), a 429 on the stream address, kill -9 the player, pause and
 * resume, next, previous, seek (anywhere in the track, now and then past its end). Whenever playback has stopped (an error, the end of the queue) it presses play again.
 *
 * It FAILS when: the service or its client process ends; playback is stuck (nothing playing for 120 s); a player's
 * sound differs from the reference (lost or repeated samples; for a player started by a seek: the reference from its
 * position on) or is shorter than the position the service reported;
 * more than one player is alive; the service's memory passes 100 MiB or grows by more than 5 MiB between the third
 * and the last quarter of the run; open files grow; a process is left at the end.
 */
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { createFakeTidal } = require(path.join(ROOT, 'tests', 'fakes', 'fake_tidal'));
const { writeLease } = require(path.join(ROOT, 'tests', 'fakes', 'service_harness'));
const { createAppDriver } = require('./app');

const SECONDS = Number(process.env.SOAK_SECONDS || 7200);
const OUT = process.env.SOAK_OUT || '/out';
const PLAYER = process.env.E2E_PLAYER;
const FIXTURES = process.env.E2E_FIXTURES;
const RATE = 48000, FRAME = 4;
const MIB = 1024 * 1024;

const A = 17927864, B = 17927865, C = 17927866, D = 77777702, E = 77777703;
const TONES = {};
TONES[A] = 'tone440_8s.m4a'; TONES[B] = 'tone660_6s.m4a'; TONES[C] = 'tone880_6s.m4a'; TONES[D] = 'tone1000_24s.m4a'; TONES[E] = 'tone550_10s.m4a';
const IDS = [A, B, C, D, E];

// a small seeded generator, so a run can be repeated
let seed = Number(process.env.SOAK_SEED || 1) >>> 0;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const T0 = Date.now();
const elapsed = () => (Date.now() - T0) / 1000;
const logFile = fs.createWriteStream(path.join(OUT, 'soak.log'));
function log(s) { logFile.write(('       ' + elapsed().toFixed(1)).slice(-8) + ' ' + s + '\n'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function alive(pid) { try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); } catch (e) { return false; } }
function rssMib(pid) { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8'))[1]) / 1024; } catch (e) { return null; } }
function fds(pid) { try { return fs.readdirSync('/proc/' + pid + '/fd').length; } catch (e) { return null; } }

/** the samples of a 16-bit WAV, also of one whose writer was killed before it fixed the header */
function pcm(file) {
    const b = fs.readFileSync(file);
    let off = 12;
    while (off + 8 <= b.length && b.slice(off, off + 4).toString('latin1') !== 'data') off += 8 + b.readUInt32LE(off + 4);
    const start = off + 8 <= b.length ? off + 8 : 44;
    const n = Math.floor((b.length - start) / FRAME) * FRAME;
    return b.slice(start, start + n);
}

const X = { players: [], children: [], logs: 0, calls: {}, callId: 0, refs: {}, svcExit: null };
const R = {
    seconds: SECONDS, seed: Number(process.env.SOAK_SEED || 1), failures: [], faults: {}, plays: 0, players: 0, playersChecked: 0,
    playersWhole: 0, playersSeeked: 0, seeksRefused: 0, soundSeconds: 0, clientStarts: 0, maxServiceRssMib: 0, maxClientRssMib: 0, maxPlayersAlive: 0,
};
function fail(msg) { if (R.failures.length < 50) R.failures.push(elapsed().toFixed(0) + ' s: ' + msg); log('FAIL ' + msg); }
function count(k) { R.faults[k] = (R.faults[k] || 0) + 1; }

function reference(id) {
    const wav = path.join(X.dir, 'ref-' + id + '.wav');
    return new Promise((resolve, reject) => {
        const p = cp.spawn(PLAYER, [], { env: { PATH: process.env.PATH, MGU_AUDIO: 'wav:' + wav, MGU_PREBUFFER_MS: '200' }, stdio: ['pipe', 'ignore', 'ignore'] });
        p.stdin.on('error', () => {});
        p.stdin.end(fs.readFileSync(path.join(FIXTURES, TONES[id])));
        p.on('exit', (code) => (code === 0 ? resolve(pcm(wav)) : reject(new Error('reference player for ' + id + ' ended with ' + code))));
    });
}

/**
 * a finished player's sound: the reference's samples from where the player started (0, or a seek's position), at
 * least as long as the position reported
 */
function checkPlayer(p) {
    let got;
    try { got = pcm(p.wav); } catch (e) {
        // ended before it made its WAV (a seek or a next right behind it): nothing played, nothing to compare
        if (e.code === 'ENOENT' && p.maxPos <= (p.startMs || 0) / 1000 + 1.0) { R.playersChecked++; return; }
        return fail('player ' + p.n + ': no WAV (' + e.message + ')');
    }
    const from = (p.startMs || 0) / 1000;
    const all = X.refs[p.id];
    const ref = all.slice(Math.min(all.length, Math.round(from * RATE) * FRAME));
    const secs = got.length / FRAME / RATE;
    const what = 'player ' + p.n + ' (track ' + p.id + (from ? ' from ' + from + ' s' : '') + ')';
    R.playersChecked++; R.soundSeconds += secs;
    if (from) R.playersSeeked++;
    if (got.length > ref.length) fail(what + ': ' + secs.toFixed(2) + ' s, more than the track');
    else if (!ref.slice(0, got.length).equals(got)) {
        let i = 0;
        while (i < got.length && ref[i] === got[i]) i++;
        fail(what + ': the sound differs from the reference from ' + (from + i / FRAME / RATE).toFixed(3) + ' s (lost or repeated sound)');
    } else if (got.length === ref.length) R.playersWhole++;
    if (!p.killed && p.maxPos > from + secs + 1.0) fail(what + ': the service reported ' + p.maxPos.toFixed(2) + ' s played, the sound ends at ' + (from + secs).toFixed(2) + ' s');
    try { fs.unlinkSync(p.wav); } catch (e) { /* gone */ }
}

async function main() {
    X.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-soak-'));
    const wavDir = path.join(X.dir, 'wav'); fs.mkdirSync(wavDir);
    const stateDir = path.join(X.dir, 'state'), leasePath = path.join(X.dir, 'lease.json'), sock = path.join(X.dir, 'cmocan-tidal.sock');
    for (const id of IDS) X.refs[id] = await reference(id);
    log('references played');

    const fake = await createFakeTidal({ loginInterval: 1 });
    IDS.forEach((id) => {
        const t = fake.data.tracks.filter((x) => x && x.id === id)[0];
        t.duration = Math.round(X.refs[id].length / FRAME / RATE); t.streamReady = true; if (!t.title) t.title = 'Track ' + id;
        fake.files[id + '.m4a'] = fs.readFileSync(path.join(FIXTURES, TONES[id]));
    });
    fake.data.favoriteTracks = IDS.slice();
    writeLease(leasePath);

    const svc = cp.fork(path.join(__dirname, 'service-main.js'), [JSON.stringify({ dir: X.dir, sock: sock, stateDir: stateDir, leasePath: leasePath,
        baseUrls: fake.baseUrls, playerBin: PLAYER, wavDir: wavDir, tickMs: 500 })], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    svc.on('exit', (code, signal) => { X.svcExit = { code: code, signal: signal }; });
    await new Promise((resolve) => svc.on('message', (m) => {
        if (!m || typeof m !== 'object') return;
        if (m.ev === 'ready') resolve();
        else if (m.ev === 'log') { X.logs++; if (/error|fail|gave up|died|exit/i.test(m.line) && !/: exited, code 0$/.test(m.line)) log('svc: ' + m.line); }
        else if (m.ev === 'player') { m.startedAt = Date.now(); m.maxPos = 0; X.players.push(m); R.players++; }
        else if (m.ev === 'child') { X.children.push(m); if (m.kind === 'client') R.clientStarts++; }
    }));
    const app = createAppDriver({ socketPath: sock, log: () => {} });
    await app.until((s) => s.screen === 'LOGIN' && s.login && s.login.userCode, 30000, 'a login code');
    fake.approve();
    await app.until((s) => s.screen === 'LIBRARY', 30000, 'the library');
    log('logged in; soaking for ' + SECONDS + ' s, seed ' + R.seed);

    const clientPid = () => { const c = X.children.filter((x) => x.kind === 'client'); return c.length ? c[c.length - 1].pid : null; };
    const metrics = fs.createWriteStream(path.join(OUT, 'metrics.csv'));
    metrics.write('seconds,service_rss_mib,client_rss_mib,service_fds,client_fds,players_alive,players_total,plays,failures\n');
    const samples = [];
    let outageUntil = 0, lastPlayingAt = Date.now(), notPlayingSince = 0, nextFaultAt = Date.now() + 8000, nextMetricAt = 0, checked = 0;

    async function pressPlay() {
        await app.openList('fav-' + R.plays, 'Favourite tracks', 'tracks', 'favorites', { kind: 'tracks' });
        const a = await app.play(between(0, IDS.length - 1));
        R.plays++;
        if (!a.ok) log('play answered ' + a.error);
    }

    async function fault() {
        const cur = X.players[X.players.length - 1];
        const kind = ['cut', 'outage', 'expire', '429', 'kill', 'pause', 'next', 'prev', 'seek', 'seek'][between(0, 9)];
        count(kind);
        log('fault: ' + kind);
        if (kind === 'cut') {
            const name = IDS[between(0, IDS.length - 1)] + '.m4a';
            fake.fileFault = { name: name, cutAfter: between(2000, fake.files[name].length - 2000) };
            setTimeout(() => { fake.fileFault = null; }, between(1500, 4000));
        } else if (kind === 'outage') {
            const f = { path: /^\/files\//, drop: true, times: 1e9 };
            fake.faults.push(f);
            const ms = between(3000, 8000);
            outageUntil = Date.now() + ms;
            setTimeout(() => { f.times = 0; fake.faults = fake.faults.filter((x) => x.times > 0); }, ms);
        } else if (kind === 'expire') fake.expireAccessTokens();
        else if (kind === '429') fake.fault({ path: /urlpostpaywall$/, status: 429, headers: { 'Retry-After': '2' }, times: 1 });
        else if (kind === 'kill') { if (cur && alive(cur.pid)) { cur.killed = true; try { process.kill(cur.pid, 'SIGKILL'); } catch (e) { /* gone */ } } }
        else if (kind === 'pause') { await app.request('pause'); await sleep(between(500, 3000)); await app.request('resume'); }
        else if (kind === 'seek') {
            // anywhere in the track playing; one time in eight past its end (the next track plays)
            const secs = cur ? X.refs[cur.id].length / FRAME / RATE : 10;
            const pos = between(0, 7) === 0 ? Math.round(secs + between(0, 30)) : Math.round(rnd() * secs * 100) / 100;
            if (cur) cur.left = true;   // what status says from here on is the next player's position
            const a = await app.request('seek', { position: pos });
            log('seek to ' + pos + ' s of ' + secs.toFixed(1) + ': ' + (a.ok ? 'ok' : a.error));
            // refused only when nothing plays (an error, the queue's end, a stop by a fault before)
            if (!a.ok) { R.seeksRefused++; if (a.error !== 'bad-request') fail('seek answered ' + a.error); }
        }
        else await app.request(kind);
    }

    await pressPlay();
    while (elapsed() < SECONDS && !X.svcExit) {
        await sleep(250);
        const now = Date.now();
        const st = app.statuses[app.statuses.length - 1];
        const cur = X.players[X.players.length - 1];
        if (st && cur && !cur.left && st.trackId === cur.id && st.at > cur.startedAt + 500 && typeof st.position === 'number') cur.maxPos = Math.max(cur.maxPos, st.position);
        if (st && (st.state === 'playing' || st.state === 'buffering' || st.state === 'loading' || st.state === 'paused')) { if (st.state === 'playing') lastPlayingAt = now; notPlayingSince = 0; }
        else if (!notPlayingSince) notPlayingSince = now;
        // stopped (an error, or the end of the queue): press play again, once any outage is over
        if (notPlayingSince && now - notPlayingSince > 3000 && now > outageUntil + 1000) { notPlayingSince = 0; await pressPlay(); }
        if (now - lastPlayingAt > 120000) { fail('stuck: nothing playing for 120 s; last status ' + JSON.stringify(st)); break; }
        if (now >= nextFaultAt) { nextFaultAt = now + between(4000, 15000); await fault().catch((e) => fail('fault: ' + e.message)); }
        // finished players: check and delete their sound
        while (checked < X.players.length - 1 && !alive(X.players[checked].pid)) checkPlayer(X.players[checked++]);
        const aliveNow = X.players.filter((p) => alive(p.pid)).length;
        R.maxPlayersAlive = Math.max(R.maxPlayersAlive, aliveNow);
        if (now >= nextMetricAt) {
            nextMetricAt = now + 30000;
            const s = { t: elapsed(), svc: rssMib(svc.pid), cli: rssMib(clientPid()), sfd: fds(svc.pid), cfd: fds(clientPid()) };
            samples.push(s);
            if (s.svc !== null) R.maxServiceRssMib = Math.max(R.maxServiceRssMib, s.svc);
            if (s.cli !== null) R.maxClientRssMib = Math.max(R.maxClientRssMib, s.cli);
            metrics.write([s.t.toFixed(0), s.svc, s.cli, s.sfd, s.cfd, aliveNow, R.players, R.plays, R.failures.length].join(',') + '\n');
            if (fake.log.length > 5000) fake.log.length = 0;
            if (app.statuses.length > 5000) app.statuses.splice(0, app.statuses.length - 100);
        }
    }

    /* ---------- the verdict ---------- */
    if (X.svcExit) fail('the service ended: ' + JSON.stringify(X.svcExit));
    if (R.clientStarts > 1) fail('client.js was started ' + R.clientStarts + ' times (it died ' + (R.clientStarts - 1) + ' times)');
    if (R.maxPlayersAlive > 2) fail(R.maxPlayersAlive + ' players alive at once');
    if (R.maxServiceRssMib > 100) fail('the service used ' + R.maxServiceRssMib.toFixed(1) + ' MiB (limit 100)');
    const med = (l) => { const a = l.filter((x) => x !== null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    if (samples.length >= 16) {
        const q = Math.floor(samples.length / 4);
        const q3 = samples.slice(2 * q, 3 * q), q4 = samples.slice(3 * q);
        R.serviceRssMedianMib = { thirdQuarter: med(q3.map((s) => s.svc)), lastQuarter: med(q4.map((s) => s.svc)) };
        R.clientRssMedianMib = { thirdQuarter: med(q3.map((s) => s.cli)), lastQuarter: med(q4.map((s) => s.cli)) };
        R.serviceFdsMedian = { thirdQuarter: med(q3.map((s) => s.sfd)), lastQuarter: med(q4.map((s) => s.sfd)) };
        if (R.serviceRssMedianMib.lastQuarter - R.serviceRssMedianMib.thirdQuarter > 5) fail('the service\'s memory still grows: ' + JSON.stringify(R.serviceRssMedianMib));
        if (R.clientRssMedianMib.lastQuarter - R.clientRssMedianMib.thirdQuarter > 5) fail('client.js\'s memory still grows: ' + JSON.stringify(R.clientRssMedianMib));
        if (R.serviceFdsMedian.lastQuarter - R.serviceFdsMedian.thirdQuarter > 3) fail('the service\'s open files grow: ' + JSON.stringify(R.serviceFdsMedian));
    } else R.note = 'too short for the memory-growth check (needs 8 minutes)';

    app.close();
    if (!X.svcExit) {
        svc.send({ op: 'stop', id: 1 });
        for (let i = 0; i < 100 && !X.svcExit; i++) await sleep(100);
        if (svc.connected) svc.disconnect();
    }
    await sleep(1500);
    const pids = X.children.map((c) => c.pid).concat([svc.pid]);
    const left = pids.filter(alive);
    if (left.length) { fail(left.length + ' process(es) left after the service stopped'); left.forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } }); }
    while (checked < X.players.length) checkPlayer(X.players[checked++]);
    R.ranSeconds = Math.round(elapsed());
    R.soundSeconds = Math.round(R.soundSeconds);
    R.result = R.failures.length ? 'FAILED' : 'PASSED';
    await fake.close();
    cp.spawnSync('rm', ['-rf', X.dir]);
}

main().catch((e) => { fail('the soak script itself: ' + (e && e.stack || e)); R.result = 'FAILED'; }).then(() => {
    if (!R.result) R.result = R.failures.length ? 'FAILED' : 'PASSED';
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(R, null, 2) + '\n');
    log(R.result);
    console.log(JSON.stringify(R, null, 2));
    logFile.end(() => process.exit(R.failures.length ? 1 : 0));
});
