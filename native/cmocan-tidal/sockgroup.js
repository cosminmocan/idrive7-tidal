'use strict';
/**
 * sockgroup.js - the control socket for the app cmocan_tidal only.
 * Adapted from aurelm-tvhplayer's sockgroup.js (aurelmarius/bmw-apps, GPL-3.0-or-later): the app's name, the socket.
 *
 * Every OAP app process is in the group tm_oap_app, so a socket in that group is open to every app on the head unit.
 * Each app also runs as its own uid, whose primary group is that uid and owns its folder /var/opt/public/oap/oap_<uid>:
 * the socket gets that group (0660), found by the app's package name. While the app is not installed it is root's
 * alone (0600).
 *
 *   node sockgroup.js [socket]   the socket unit's ExecStartPost (and the service at each start)
 *
 * Node 8.9.4.
 */
const fs = require('fs');
const path = require('path');

const APP = 'cmocan_tidal';
const SOCK = '/run/cmocan-tidal.sock';
const OAP_DIR = '/var/opt/public/oap';

/** the gid of app `name`'s folder, or null while it is not installed */
function appGid(name, oapDir) {
    const dir = oapDir || process.env.CMOCAN_OAP_DIR || OAP_DIR;
    let dirs = [];
    try { dirs = fs.readdirSync(dir).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < dirs.length; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, dirs[i], 'source', 'package.json'), 'utf8'));
            if (pkg && pkg.name === name) return fs.statSync(path.join(dir, dirs[i])).gid;
        } catch (e) { /* not an app, or not readable */ }
    }
    return null;
}

/** gives the socket its group and mode; returns the gid, or null (root only) */
function apply(sockPath, oapDir) {
    const gid = appGid(APP, oapDir);
    if (gid === null || gid === 0) { fs.chownSync(sockPath, 0, 0); fs.chmodSync(sockPath, 0o600); return null; }
    fs.chownSync(sockPath, 0, gid);
    fs.chmodSync(sockPath, 0o660);
    return gid;
}

if (require.main === module) {
    // never fails: a failing ExecStartPost would fail the socket unit
    try {
        const g = apply(process.argv[2] || SOCK);
        console.log('cmocan-tidal socket: ' + (g === null ? 'root only (the app is not installed)' : 'group ' + g));
    } catch (e) { console.log('cmocan-tidal socket: ' + e.message); }
    process.exit(0);
}

module.exports = { appGid: appGid, apply: apply, APP: APP, SOCK: SOCK };
