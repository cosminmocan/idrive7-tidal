'use strict';
/**
 * cleanup.js - what the service can leave behind, removed. Adapted from aurelm-tvhplayer's cleanup.js (aurelmarius,
 * GPL-3.0-or-later); ours has no firewall rule and no frame file.
 *
 *   node cleanup.js            the service's ExecStopPost (also after a crash or a kill): half-written state files
 *                              (*.tmp). The socket stays: it belongs to the socket unit, which keeps listening.
 *   node cleanup.js --remove   the tool's deactivate (an uninstall, before anything else goes): the same, and the
 *                              control socket /run/cmocan-tidal.sock (the socket unit's RemoveOnStop removes it too).
 *
 * The service writes nothing else outside /var/opt/cmocan-tidal (rule R6); that folder, the units, the sockets.target
 * link, the recmgr name and the uplink's uids.d entry are the deploy tool's to remove. Running it twice is the same as
 * once. It never fails: a failing deactivate would refuse the removal. Paths: CMOCAN_SOCK, CMOCAN_STATE (tests).
 * Node 8.9.4.
 */
const fs = require('fs');
const path = require('path');

const SOCK = process.env.CMOCAN_SOCK || '/run/cmocan-tidal.sock';
const STATE = process.env.CMOCAN_STATE || '/var/opt/cmocan-tidal/state';
const remove = process.argv.indexOf('--remove') >= 0;

function say(s) { console.log('cmocan-tidal cleanup: ' + s); }

try {
    let names = [];
    try { names = fs.readdirSync(STATE); } catch (e) { /* no state folder */ }
    names.filter((n) => /\.tmp$/.test(n)).forEach((n) => {
        try { fs.unlinkSync(path.join(STATE, n)); say('removed ' + n); } catch (e) { /* gone */ }
    });
} catch (e) { say(e && e.message); }

if (remove) {
    try {
        const st = fs.lstatSync(SOCK);
        if (!st.isDirectory()) { fs.unlinkSync(SOCK); say('removed ' + SOCK); }
    } catch (e) { /* none */ }
}
process.exit(0);
