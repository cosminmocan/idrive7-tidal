'use strict';
/**
 * check.js - the deploy tool's check after an install: the service answers `status` on its control socket (exit 0),
 * else exit 1 after 10 tries a second apart. Adapted from aurelm-tvhplayer's check.js (aurelmarius, GPL-3.0-or-later).
 * The connection starts the service (socket activation); it ends again 10 minutes later by itself.
 *
 *   node check.js [socket]       CMOCAN_CHECK_TRIES, CMOCAN_CHECK_WAIT_MS (tests)
 * Node 8.9.4.
 */
const net = require('net');

const sockPath = process.argv[2] || '/run/cmocan-tidal.sock';
const TRIES = Number(process.env.CMOCAN_CHECK_TRIES) || 10;
const WAIT_MS = Number(process.env.CMOCAN_CHECK_WAIT_MS) || 1000;
let tries = 0;

function attempt() {
    const c = net.connect(sockPath);
    let buf = '';
    let over = false;
    const t = setTimeout(() => { c.destroy(); retry('no answer'); }, 3000);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ id: 1, cmd: 'status' }) + '\n'));
    c.on('data', (d) => {
        buf += d;
        const i = buf.indexOf('\n');
        if (i < 0 || over) return;
        over = true;
        clearTimeout(t);
        c.destroy();
        let a = null;
        try { a = JSON.parse(buf.slice(0, i)); } catch (e) { a = null; }
        if (a && a.id === 1 && a.ok === true && a.state) {
            console.log('cmocan-tidal ' + a.state.version + ' answers: ' + a.state.login + ', ' + (a.state.online ? 'online' : 'offline'));
            process.exit(0);
        }
        retry('bad answer');
    });
    c.on('error', (e) => { if (over) return; over = true; clearTimeout(t); retry(e.code || e.message); });
}
function retry(why) {
    if (++tries >= TRIES) { console.error('cmocan-tidal: ' + why); process.exit(1); }
    setTimeout(attempt, WAIT_MS);
}
attempt();
