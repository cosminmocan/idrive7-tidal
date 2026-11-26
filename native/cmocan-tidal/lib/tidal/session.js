'use strict';
/**
 * session.js - session.json (docs/PROTOCOL.md section 3): read once, written whole (a temporary file, fsync,
 * rename), mode 0600. A file that is missing, half written or of another version loads as "logged out".
 */
const fs = require('fs');
const path = require('path');

const MODE = 384; // 0600

function valid(s) {
    return !!s && typeof s === 'object' && s.version === 1 && s.tokenType === 'Bearer' &&
        typeof s.accessToken === 'string' && s.accessToken.length > 0 &&
        typeof s.refreshToken === 'string' && s.refreshToken.length > 0 &&
        typeof s.expiresAt === 'number' && isFinite(s.expiresAt) && Math.floor(s.expiresAt) === s.expiresAt && s.expiresAt >= 0 &&
        typeof s.userId === 'number' && Math.floor(s.userId) === s.userId && s.userId >= 1 &&
        typeof s.countryCode === 'string' && /^[A-Z]{2}$/.test(s.countryCode);
}

function createSessionStore(file) {
    function load() {
        try {
            const s = JSON.parse(fs.readFileSync(file, 'utf8'));
            return valid(s) ? s : null;
        } catch (e) { return null; }
    }

    function save(s) {
        const data = {
            version: 1, tokenType: 'Bearer', accessToken: s.accessToken, refreshToken: s.refreshToken,
            expiresAt: Math.round(s.expiresAt), userId: s.userId, countryCode: s.countryCode,
        };
        const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '.tmp');
        try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
        const fd = fs.openSync(tmp, 'wx', MODE);
        try {
            fs.fchmodSync(fd, MODE);
            fs.writeSync(fd, JSON.stringify(data) + '\n');
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, file);
        return data;
    }

    function remove() {
        try { fs.unlinkSync(file); } catch (e) { /* none */ }
    }

    return { load: load, save: save, remove: remove };
}

module.exports = { createSessionStore: createSessionStore, valid: valid };
