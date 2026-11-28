'use strict';
/**
 * service_harness.js - runs the real service (native/cmocan-tidal/service.js) for the service's tests (stream C):
 * in a temp folder, unprivileged, with the fake TIDAL module, the fake netx (in this process, or in the real
 * client.js child with `client: true`) and the fake player. Every child it starts is recorded, and close() fails
 * the test when one is still running; the temp folder is removed.
 *
 *   const h = await startService({ tidal: cfg, client: true, service: { ...createService options } });
 *   h.ask([req, 'raw line', ...]) -> Promise<answers in order of arrival>   (one connection)
 *   h.req({ cmd, ... }) -> Promise<answer>                                  (an id is added)
 *   h.status() -> Promise<state>
 *   h.online(bool)                     writes or removes the uplink lease
 *   h.until(fn, ms) -> Promise         waits for fn() (sync or async) to be truthy
 *   h.pids                             { client: [], player: [] }
 *   h.spawns                           every player started: { bin, args, env, pid, at, exitAt } (ms; exitAt null while it runs)
 *   h.close() -> Promise               stops the service, checks no child is left, removes the folder
 *   startService({ files: { 'session.json': text } })   files in the state folder before the service starts
 *   startService({ record: true })     each player records its input in <dir>/rec-<track id>.bin
 * Node 8.9.4 syntax.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const childProcess = require('child_process');
const { createFakeTidal, rmrf } = require('./fake_tidal_module');
const { createNetx } = require('./fake_netx');

const ROOT = path.join(__dirname, '..', '..');
const SERVICE = path.join(ROOT, 'native', 'cmocan-tidal', 'service.js');
const FAKE_PLAYER = path.join(__dirname, 'fake_player.js');
const FAKE_NETX = path.join(__dirname, 'fake_netx.js');

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function until(fn, ms, what) {
    const end = Date.now() + (ms || 5000);
    return new Promise((resolve, reject) => {
        (function again() {
            Promise.resolve().then(fn).then((v) => {
                if (v) return resolve(v);
                if (Date.now() > end) return reject(new Error('timed out waiting for ' + (what || fn.toString())));
                setTimeout(again, 20);
            }, reject);
        })();
    });
}

/** one connection; writes each line, resolves with `count` answers (default: one per line) */
function ask(sock, lines, count) {
    return new Promise((resolve, reject) => {
        const c = net.connect(sock);
        let buf = '';
        const got = [];
        const want = count === undefined ? lines.length : count;
        const t = setTimeout(() => { c.destroy(); reject(new Error('no answer: got ' + JSON.stringify(got))); }, 10000);
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
            if (got.length >= want) { clearTimeout(t); c.end(); resolve(got); }
        });
        c.on('error', (e) => { clearTimeout(t); reject(e); });
        c.on('connect', () => lines.forEach((r) => c.write(Buffer.isBuffer(r) ? Buffer.concat([r, Buffer.from('\n')]) : (typeof r === 'string' ? r : JSON.stringify(r)) + '\n')));
    });
}

function writeLease(p) { fs.writeFileSync(p, JSON.stringify({ interface: 'vethuplink', ip: '10.0.0.2', dns: ['10.0.0.1'] })); }

function startService(opts) {
    const o = opts || {};
    const { createService } = require(SERVICE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-svc-'));
    const stateDir = path.join(dir, 'state');
    const leasePath = path.join(dir, 'lease.json');
    const sock = path.join(dir, 'c.sock');
    if (o.online !== false) writeLease(leasePath);
    // files to find in the state folder at start: { 'session.json': text }
    if (o.files) { fs.mkdirSync(stateDir, 0o700); Object.keys(o.files).forEach((n) => fs.writeFileSync(path.join(stateDir, n), o.files[n], { mode: 0o600 })); }
    const cfg = o.tidal || {};
    const pids = { client: [], player: [] };
    const spawns = [];
    const exits = [];
    const logs = [];
    const so = Object.assign({
        stateDir: stateDir, leasePath: leasePath, createTidal: createFakeTidal(cfg), uid: null,
        log: (l) => { logs.push(l); if (process.env.T_LOG) console.log('    svc: ' + l); },
        exit: (code) => exits.push(code),
        forkClient: (file, args, fo) => { const c = childProcess.fork(file, args, fo); pids.client.push(c.pid); return c; },
        clientEnv: { CMOCAN_NETX: FAKE_NETX },
        spawn: (bin, args, so2) => {
            const c = childProcess.spawn(bin, args, so2);
            pids.player.push(c.pid);
            const rec = { bin: bin, args: args, env: so2 && so2.env, pid: c.pid, at: Date.now(), exitAt: null };
            spawns.push(rec);
            c.on('exit', () => { rec.exitAt = Date.now(); });
            return c;
        },
        playerBin: process.execPath, playerArgs: [FAKE_PLAYER],
        playerEnv: { FAKE_TICK_MS: '20', FAKE_SECONDS: '1' },
        retryWaits: [20, 40, 80], outageMs: 3000,
    }, o.client ? {} : { netx: createNetx({ leasePath: leasePath }) }, o.service || {});
    // record: each player writes the bytes it received to <dir>/rec-<track id>.bin (the fake player's FAKE_RECORD)
    if (o.record) { const base = so.playerEnv; so.playerEnv = (id) => Object.assign({}, base, { FAKE_RECORD: path.join(dir, 'rec-' + id + '.bin') }); }
    const svc = createService(so);
    const h = {
        svc: svc, dir: dir, stateDir: stateDir, leasePath: leasePath, sock: sock, cfg: cfg, pids: pids, spawns: spawns, exits: exits, logs: logs,
        until: until, sleep: sleep, alive: alive,
        ask: (lines, count) => ask(sock, lines, count),
        req: (r) => ask(sock, [Object.assign({ id: 1 }, r)]).then((a) => a[0]),
        status: () => ask(sock, [{ id: 1, cmd: 'status' }]).then((a) => a[0].state),
        online: (on) => { if (on) writeLease(leasePath); else { try { fs.unlinkSync(leasePath); } catch (e) { /* none */ } } },
        close: () => Promise.resolve(svc.stop(0)).then(() => until(() => pids.client.concat(pids.player).every((p) => !alive(p)), 8000, 'every child to end'))
            .then(() => { rmrf(dir); }, (e) => { pids.client.concat(pids.player).forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch (x) { /* gone */ } }); rmrf(dir); throw e; }),
    };
    return Promise.resolve(svc.listen(sock)).then(() => { svc.start(); return h; });
}

module.exports = { startService: startService, ask: ask, until: until, sleep: sleep, alive: alive, writeLease: writeLease,
    SERVICE: SERVICE, FAKE_PLAYER: FAKE_PLAYER, FAKE_NETX: FAKE_NETX, ROOT: ROOT };
