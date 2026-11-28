'use strict';
/**
 * C8: the tool's package (native/cmocan-tidal) in mgu-store's format (deploy/README.md, "Artifacts"): component.json,
 * the systemd socket and service, cleanup.js, check.js, sockgroup.js. Rules R3 (limits, no core dump, a start limit,
 * enabled only as a socket), R6 and R11 (removal leaves nothing).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');
const { startService, ROOT } = require('./fakes/service_harness');
const { rmrf } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const DIR = path.join(ROOT, 'native', 'cmocan-tidal');
const comp = () => JSON.parse(fs.readFileSync(path.join(DIR, 'component.json'), 'utf8'));

/** a unit file as { section: { key: [values] } } */
function unit(name) {
    const out = {};
    let sec = null;
    fs.readFileSync(path.join(DIR, 'systemd', name), 'utf8').split('\n').forEach((l) => {
        const line = l.trim();
        if (!line || line[0] === '#') return;
        const m = /^\[(\w+)\]$/.exec(line);
        if (m) { sec = m[1]; out[sec] = out[sec] || {}; return; }
        const i = line.indexOf('=');
        const k = line.slice(0, i), v = line.slice(i + 1);
        (out[sec][k] = out[sec][k] || []).push(v);
    });
    return out;
}

test('component.json: a tool for iDrive 7 with internet for uid 13150, its requirements and hooks', () => {
    const c = comp();
    const svc = require(path.join(DIR, 'service.js'));
    assert.strictEqual(c.id, 'cmocan-tidal');
    assert.strictEqual(c.kind, 'tool');
    assert.ok(/^\d+\.\d+\.\d+$/.test(c.version));
    assert.strictEqual(c.version, svc.VERSION, 'component.json and service.js have the same version');
    assert.strictEqual(c.license, 'GPL-3.0-or-later');
    assert.deepStrictEqual(c.mguHmi, ['ID7']);
    assert.strictEqual(c.internet, true);
    assert.deepStrictEqual(c.uids, [13150]); assert.strictEqual(svc.NET_UID, 13150);
    assert.ok(c.requires && c.requires['mgu-deploy'] && c.requires['mgu-uplink'], 'requires mgu-deploy and mgu-uplink');
    assert.deepStrictEqual(c.check, ['check.js']);
    assert.deepStrictEqual(c.deactivate, ['node', 'cleanup.js', '--remove']);
    assert.ok(c.crashNames.indexOf('tidal-player') >= 0, 'the player is in crashNames');
    assert.ok(c.crashNames.indexOf('tidal-video') >= 0, 'the video player is in crashNames');
    assert.deepStrictEqual(c.units.map((u) => u.name).sort(), ['cmocan-tidal.service', 'cmocan-tidal.socket']);
    assert.ok(c.units.every((u) => !u.runsInSafeMode), 'nothing of ours runs in safe mode');
    assert.deepStrictEqual(c.enable, [{ unit: 'cmocan-tidal.socket', target: 'sockets.target' }], 'only the socket is enabled');
    assert.ok(c.recmgr.indexOf('cmocan-tidal') >= 0);
    assert.ok(!c.activate && !c.postInstall && !c.dropins, 'no install step and no change to units it does not own');
});

// what `make player` builds (native/tidal-player/build.mk, build.sh), and the video player's build
// (native/tidal-video/build/out): git ignores them, so a checkout has them only after a build; every other file the
// tool ships is in the repository
const PLAYER_BUILD = { 'tidal-player': '../tidal-player/build/out/tidal-player', 'FFMPEG-LICENSE': '../tidal-player/build/FFMPEG-LICENSE',
    'tidal-video': '../tidal-video/build/out/tidal-video' };

test('the players (tidal-player, tidal-video) and the FFmpeg licence are shipped from where their builds put them', () => {
    const c = comp();
    Object.keys(PLAYER_BUILD).forEach((p) => {
        const f = c.files.filter((x) => x.path === p)[0];
        assert.ok(f, p + ' is shipped');
        assert.strictEqual(f.from, PLAYER_BUILD[p], p + ' comes from the player\'s build output');
    });
});

test('every file component.json names exists (the player\'s build output once `make player` has run)', () => {
    const c = comp();
    const pending = [];
    const buildOutputs = Object.keys(PLAYER_BUILD).map((k) => PLAYER_BUILD[k]);
    c.files.forEach((f) => {
        assert.ok(/^[0-7]{4}$/.test(f.mode), f.path + ': mode');
        assert.ok(f.path.indexOf('..') < 0 && f.path[0] !== '/', f.path + ': a path inside the version folder');
        const there = fs.existsSync(path.join(DIR, f.from)) && fs.statSync(path.join(DIR, f.from)).isFile();
        if (there) return;
        assert.ok(buildOutputs.indexOf(f.from) >= 0, f.from + ' is missing');
        pending.push(f.from);
    });
    c.units.forEach((u) => assert.ok(fs.existsSync(path.join(DIR, u.from)), u.from + ' is missing'));
    c.check.concat(c.deactivate.slice(1, 2)).forEach((s) => assert.ok(c.files.some((f) => f.path === s), s + ' is shipped'));
    const exec = c.files.filter((f) => f.mode === '0755').map((f) => f.path);
    assert.deepStrictEqual(exec, ['tidal-player', 'tidal-video'], 'the two players are the only executables');
    if (pending.length) console.log('       (not built yet, run `make player`: ' + pending.join(', ') + ')');
});

test('every module the service loads is in the package', () => {
    const c = comp();
    const shipped = c.files.map((f) => f.path);
    const own = ['service.js', 'client.js', 'player.js', 'playback.js', 'state.js', 'log.js', 'sockgroup.js', 'cleanup.js', 'check.js'];
    own.forEach((f) => assert.ok(shipped.indexOf(f) >= 0, f + ' is shipped'));
    ['lib/netx.js', 'lib/tidal.js', 'cacert.pem', 'tidal-player', 'tidal-video', 'README.md'].forEach((f) => assert.ok(shipped.indexOf(f) >= 0, f + ' is shipped'));
    // every require('./...') in our files names a shipped file
    own.forEach((f) => {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        const re = /require\('(\.\/[^']+)'\)/g;
        let m;
        while ((m = re.exec(src))) {
            const p = path.normalize(m[1]).replace(/^\.\//, '');
            assert.ok(shipped.indexOf(p) >= 0 || shipped.indexOf(p + '.js') >= 0, f + ' requires ' + m[1] + ', which is not shipped');
        }
    });
    // stream A's modules, once merged: each one under lib/ is shipped
    const lib = [];
    (function walk(d, rel) {
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.forEach((n) => { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p, rel + n + '/'); else if (/\.js$/.test(n)) lib.push(rel + n); });
    })(path.join(DIR, 'lib'), 'lib/');
    lib.forEach((f) => assert.ok(shipped.indexOf(f) >= 0, f + ' exists but component.json does not ship it'));
});

test('the service unit: LimitCORE=1, memory, CPU and task limits, a start limit, no "+" commands, never at boot (R3)', () => {
    const s = unit('cmocan-tidal.service');
    assert.deepStrictEqual(s.Service.LimitCORE, ['1']);
    assert.ok(/^\d+M$/.test(s.Service.MemoryLimit[0]), 'MemoryLimit');
    assert.ok(/^\d+%$/.test(s.Service.CPUQuota[0]), 'CPUQuota');
    assert.ok(/^\d+$/.test(s.Service.TasksMax[0]), 'TasksMax');
    assert.ok(Number(s.Unit.StartLimitBurst[0]) > 0 && Number(s.Unit.StartLimitIntervalSec[0]) > 0, 'a start limit');
    assert.deepStrictEqual(s.Unit.Requires, ['cmocan-tidal.socket']);
    assert.ok(!s.Install, 'no [Install]: the service is never enabled, it starts from its socket');
    Object.keys(s.Service).filter((k) => /^Exec/.test(k)).forEach((k) => s.Service[k].forEach((v) => {
        assert.ok(!/^[-@:]*[+!]/.test(v), k + ' runs without the limits: ' + v);
        assert.ok(/\/var\/opt\/cmocan-tidal\//.test(v) || /^-?\/bin\/sh -c 'mkdir -p \/var\/opt\/cmocan-tidal\/state/.test(v), k + ': ' + v);
    }));
    assert.ok(s.Service.ExecStart[0].indexOf('/usr/bin/node') >= 0 && /current\/service\.js$/.test(s.Service.ExecStart[0]));
    assert.deepStrictEqual(s.Service.Environment.filter((e) => /^CMOCAN_STATE=/.test(e)), ['CMOCAN_STATE=/var/opt/cmocan-tidal/state']);
    assert.ok(s.Service.ExecStopPost[0].indexOf('cleanup.js') >= 0);
    assert.ok(s.Service.ExecStopPost[0].indexOf('--remove') < 0, 'the service\'s stop keeps the socket');
    assert.deepStrictEqual(s.Service.Restart, ['on-failure'], 'an idle end (exit 0) is not restarted');
});

test('the socket unit: /run/cmocan-tidal.sock, root\'s until sockgroup.js, removed on stop, enabled in sockets.target', () => {
    const s = unit('cmocan-tidal.socket');
    assert.deepStrictEqual(s.Socket.ListenStream, ['/run/cmocan-tidal.sock']);
    assert.deepStrictEqual(s.Socket.SocketMode, ['0600']);
    assert.deepStrictEqual(s.Socket.RemoveOnStop, ['yes']);
    assert.deepStrictEqual(s.Socket.LimitCORE, ['1']);
    assert.ok(/ulimit -c 1; exec \/usr\/bin\/node \/var\/opt\/cmocan-tidal\/current\/sockgroup\.js/.test(s.Socket.ExecStartPost[0]));
    assert.ok(!/^[-@:]*[+!]/.test(s.Socket.ExecStartPost[0]));
    assert.deepStrictEqual(s.Install.WantedBy, ['sockets.target']);
});

test('no file in the package comes from oap-sdk, and nothing requires it', () => {
    const c = comp();
    c.files.concat(c.units).forEach((f) => assert.ok(f.from.indexOf('oap-sdk') < 0, f.from));
    c.files.filter((f) => /\.js$/.test(f.from) && fs.existsSync(path.join(DIR, f.from))).forEach((f) => {
        assert.ok(!/oap-sdk/.test(fs.readFileSync(path.join(DIR, f.from), 'utf8')), f.from + ' names oap-sdk');
    });
});

/* ---------- cleanup.js (rule R11) ---------- */

function listAll(d) {
    const out = {};
    (function walk(p) {
        let names = [];
        try { names = fs.readdirSync(p); } catch (e) { return; }
        names.forEach((n) => { const q = path.join(p, n); const s = fs.lstatSync(q); out[path.relative(d, q)] = s.isDirectory() ? 'dir' : s.size; if (s.isDirectory()) walk(q); });
    })(d);
    return out;
}
function cleanup(args, env) {
    return childProcess.spawnSync(process.execPath, [path.join(DIR, 'cleanup.js')].concat(args), { env: Object.assign({}, process.env, env), encoding: 'utf8' });
}

test('cleanup.js --remove (the deactivate) run twice: the same state, the socket and the service\'s leftovers gone', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-clean-'));
    try {
        const sock = path.join(d, 'run', 'cmocan-tidal.sock');
        const state = path.join(d, 'opt', 'state');
        fs.mkdirSync(path.join(d, 'run')); fs.mkdirSync(path.join(d, 'opt')); fs.mkdirSync(state);
        fs.writeFileSync(sock, '');
        fs.writeFileSync(path.join(state, 'queue.json.tmp'), '{"vers');
        fs.writeFileSync(path.join(state, 'prefs.json'), '{"version":1,"quality":"HIGH"}');
        fs.writeFileSync(path.join(d, 'run', 'other.sock'), '');
        // the video player's frame file (docs/PROTOCOL.md section 2, MGU_VIDEO=shm:cmocan-tidal), and another one
        const frame = path.join(d, 'run', 'mgu-video-cmocan-tidal');
        fs.writeFileSync(frame, 'MGVF'); fs.writeFileSync(path.join(d, 'run', 'mgu-video-other'), 'MGVF');
        const env = { CMOCAN_SOCK: sock, CMOCAN_STATE: state, CMOCAN_FRAME: frame };
        const r1 = cleanup(['--remove'], env);
        assert.strictEqual(r1.status, 0, r1.stdout + r1.stderr);
        const after1 = listAll(d);
        const r2 = cleanup(['--remove'], env);
        assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
        assert.deepStrictEqual(listAll(d), after1, 'the second run changes nothing');
        assert.ok(!fs.existsSync(sock), 'the socket is gone');
        assert.ok(!fs.existsSync(path.join(state, 'queue.json.tmp')), 'a half-written file is gone');
        assert.ok(!fs.existsSync(frame), 'the frame file is gone');
        assert.ok(fs.existsSync(path.join(d, 'run', 'other.sock')) && fs.existsSync(path.join(d, 'run', 'mgu-video-other')), 'nothing else is touched');
        // the state folder itself is the deploy tool's to remove with /var/opt/cmocan-tidal
        assert.ok(fs.existsSync(path.join(state, 'prefs.json')));
    } finally { rmrf(d); }
});

test('cleanup.js without --remove (the service\'s ExecStopPost) keeps the socket, removes the frame file a video left, and never fails', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-clean-'));
    try {
        const sock = path.join(d, 'cmocan-tidal.sock');
        const frame = path.join(d, 'mgu-video-cmocan-tidal');
        fs.writeFileSync(sock, ''); fs.writeFileSync(frame, 'MGVF');
        const r = cleanup([], { CMOCAN_SOCK: sock, CMOCAN_STATE: path.join(d, 'nothing', 'here'), CMOCAN_FRAME: frame });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert.ok(fs.existsSync(sock));
        assert.ok(!fs.existsSync(frame), 'the frame file is gone (the service ended: no video plays)');
        const again = cleanup([], { CMOCAN_SOCK: sock, CMOCAN_STATE: path.join(d, 'nothing', 'here'), CMOCAN_FRAME: frame });
        assert.strictEqual(again.status, 0, 'no frame file: still fine');
    } finally { rmrf(d); }
});

/* ---------- check.js ---------- */

test('check.js: exit 0 when the service answers status on its socket, 1 when nothing answers', async () => {
    const h = await startService();
    try {
        const r = await new Promise((resolve) => {
            const c = childProcess.spawn(process.execPath, [path.join(DIR, 'check.js'), h.sock], { stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { out += x; });
            c.on('exit', (code) => resolve({ code: code, out: out }));
        });
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(r.out.indexOf('cmocan-tidal ' + comp().version + ' answers') >= 0, r.out + ' (the service says component.json\'s version)');
    } finally { await h.close(); }
    const r = childProcess.spawnSync(process.execPath, [path.join(DIR, 'check.js'), path.join(os.tmpdir(), 'cmocan-none.sock')],
        { env: Object.assign({}, process.env, { CMOCAN_CHECK_TRIES: '2', CMOCAN_CHECK_WAIT_MS: '50' }), encoding: 'utf8' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
});

/* ---------- sockgroup.js ---------- */

test('sockgroup.js: the socket gets the app\'s own group (0660), or stays root\'s (0600) while the app is not installed', () => {
    const { apply, appGid, APP } = require(path.join(DIR, 'sockgroup.js'));
    assert.strictEqual(APP, 'cmocan_tidal');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-oap-'));
    try {
        const oap = path.join(d, 'oap');
        fs.mkdirSync(oap);
        const sock = path.join(d, 's.sock');
        fs.writeFileSync(sock, '');
        assert.strictEqual(appGid(APP, oap), null);
        const root = process.getuid && process.getuid() === 0;
        if (root) {
            assert.strictEqual(apply(sock, oap), null);
            assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o600);
            fs.mkdirSync(path.join(oap, 'oap_12345')); fs.mkdirSync(path.join(oap, 'oap_12345', 'source'));
            fs.writeFileSync(path.join(oap, 'oap_12345', 'source', 'package.json'), JSON.stringify({ name: 'other_app' }));
            fs.mkdirSync(path.join(oap, 'oap_12346')); fs.mkdirSync(path.join(oap, 'oap_12346', 'source'));
            fs.writeFileSync(path.join(oap, 'oap_12346', 'source', 'package.json'), JSON.stringify({ name: 'cmocan_tidal' }));
            fs.chownSync(path.join(oap, 'oap_12346'), 12346, 12346);
            assert.strictEqual(apply(sock, oap), 12346);
            assert.strictEqual(fs.statSync(sock).gid, 12346);
            assert.strictEqual(fs.statSync(sock).uid, 0);
            assert.strictEqual(fs.statSync(sock).mode & 0o777, 0o660);
        } else console.log('       (not root: chown not checked)');
        const r = childProcess.spawnSync(process.execPath, [path.join(DIR, 'sockgroup.js'), path.join(d, 'missing.sock')], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, 'never fails: ' + r.stdout + r.stderr);
    } finally { rmrf(d); }
});

test('the README says where the code comes from', () => {
    const t = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    assert.ok(/aurelm-tvhplayer/.test(t) && /aurelm-emby/.test(t) && /GPL-3\.0-or-later/.test(t));
});

run();
