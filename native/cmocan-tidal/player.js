'use strict';
/**
 * player.js - one player process (native/tidal-player) for one track (docs/PROTOCOL.md section 2).
 * Adapted from aurelm-tvhplayer's and aurelm-emby's player.js (aurelmarius, GPL-3.0-or-later): one process per
 * stream, quit on fd 3 then SIGTERM then SIGKILL, "MGU {json}" lines as events.
 *
 * Started by the service as root, so it can take the sound groups: the player itself becomes MGU_RUN_AS (nobody)
 * with MGU_GROUPS (mgu_alsa,audio) before it reads a byte, and refuses to run as root (Node cannot give a child
 * supplementary groups; the car's sound plugin refuses root and the tools' internet uids). It runs with the
 * service's limits (its cgroup, LimitCORE=1).
 *
 *   const p = createPlayerProcess({ spawn, bin, args, env, audio, runAs, groups, log, onEvent(ev), quitMs, killMs });
 *   p.pid
 *   p.stdin               the track's bytes (write; false: wait for 'drain'); never throws, even when the player is gone
 *   p.ctl(line)           pause | resume | volume <0..1> | quit, on the player's fd 3
 *   p.kill() -> Promise<exit>   quit, then SIGTERM after quitMs, SIGKILL after killMs
 *   p.exited -> Promise<{ code, signal, error }>
 *
 * Node 8.9.4.
 */
const AUDIO = 'alsa:plug:smartx:CarLifeMedia_CF_48_STEREO';
const RUN_AS = 'nobody';
const GROUPS = 'mgu_alsa,audio';
const PREBUFFER_MS = '1500';
const ALSA_US = '64000';
const { Writable } = require('stream');

function createPlayerProcess(opts) {
    const o = opts || {};
    const log = o.log || (() => {});
    const onEvent = o.onEvent || (() => {});
    const quitMs = o.quitMs || 1000, killMs = o.killMs || 6000;
    const env = Object.assign({ PATH: '/usr/bin:/bin', HOME: '/tmp', MGU_AUDIO: o.audio || AUDIO, MGU_RUN_AS: o.runAs || RUN_AS,
        MGU_GROUPS: o.groups || GROUPS, MGU_PREBUFFER_MS: PREBUFFER_MS, MGU_ALSA_US: ALSA_US }, o.env || {});
    let child = null;
    let done = false;
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    function finish(x) {
        if (done) return;
        done = true;
        resolveExit(x);
    }

    try { child = o.spawn(o.bin, o.args || [], { env: env, cwd: '/', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }); }
    catch (e) { child = null; log('player did not start: ' + e.message); setImmediate(() => finish({ code: null, signal: null, error: e.message })); }

    // a sink that takes and drops bytes, for a player that is gone or never started
    const nowhere = new Writable({ write: (c, e, cb) => cb() });
    const p = { pid: child ? child.pid : null, exited: exited, stdin: child && child.stdin ? child.stdin : nowhere };

    if (child) {
        if (child.stdin) child.stdin.on('error', () => { /* the player went: its exit says so */ });
        if (child.stdio[3]) child.stdio[3].on('error', () => {});
        let out = '';
        if (child.stdout) {
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (d) => {
                out += d;
                let i;
                while ((i = out.indexOf('\n')) >= 0) {
                    const line = out.slice(0, i); out = out.slice(i + 1);
                    if (line.slice(0, 4) !== 'MGU ') { if (line) log('player: ' + line.slice(0, 300)); continue; }
                    let ev = null;
                    try { ev = JSON.parse(line.slice(4)); } catch (e) { ev = null; }
                    if (ev && typeof ev === 'object' && typeof ev.ev === 'string') {
                        if (ev.ev !== 'tick') log('player ' + p.pid + ': ' + line.slice(4, 300));
                        try { onEvent(ev); } catch (e) { log('player event: ' + e.message); }
                    }
                }
                if (out.length > 65536) out = '';
            });
        }
        if (child.stderr) {
            let err = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (d) => {
                err += d;
                let i;
                while ((i = err.indexOf('\n')) >= 0) { log('player: ' + err.slice(0, i).slice(0, 300)); err = err.slice(i + 1); }
                if (err.length > 65536) err = '';
            });
        }
        let exitTimer = null;
        child.on('error', (e) => { if (!p.pid) finish({ code: null, signal: null, error: e.message }); else log('player: ' + e.message); });
        // 'close' comes once its output is read to the end (every event seen); 'exit' alone, after a moment
        child.on('exit', (code, signal) => { exitTimer = setTimeout(() => finish({ code: code, signal: signal }), 1000); });
        child.on('close', (code, signal) => { clearTimeout(exitTimer); finish({ code: code, signal: signal }); });
        if (!p.pid) p.stdin = nowhere;
    }

    p.ctl = (line) => {
        if (done || !child || !child.stdio[3]) return;
        try { child.stdio[3].write(String(line).replace(/\n/g, ' ') + '\n'); } catch (e) { /* gone */ }
    };
    let killing = null;
    p.kill = () => {
        if (killing) return killing;
        if (done || !child || !p.pid) { killing = exited; return killing; }
        p.ctl('quit');
        const t1 = setTimeout(() => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }, quitMs);
        const t2 = setTimeout(() => { log('player ' + p.pid + ': not ended: SIGKILL'); try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, killMs);
        killing = exited.then((x) => { clearTimeout(t1); clearTimeout(t2); return x; });
        return killing;
    };
    /** for an exit that cannot wait */
    p.killNow = () => { if (!done && child && p.pid) { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } } };
    return p;
}

module.exports = { createPlayerProcess: createPlayerProcess, AUDIO: AUDIO, RUN_AS: RUN_AS, GROUPS: GROUPS };
