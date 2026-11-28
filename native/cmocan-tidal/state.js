'use strict';
/**
 * state.js - the service's files in its state folder (docs/PROTOCOL.md section 3): prefs.json, queue.json (and the
 * folder itself, 0700). session.json and covers/ are the TIDAL module's (lib/tidal.js); this module only removes
 * them at logout when that module left them.
 *
 *   const st = createState(dir);
 *   st.read(name)          -> the object, or null when missing, not JSON, or not version 1 / not valid
 *   st.load(name, fallback) -> read(name), or fallback; a file that is there but not valid is replaced by fallback
 *   st.write(name, obj)    written whole: a temporary file in the folder, then a rename (0600)
 *   st.remove(name)
 *   st.file(name)          the file's path, always inside dir
 *
 * Node 8.9.4.
 */
const fs = require('fs');
const path = require('path');

const NAMES = { prefs: 'prefs.json', queue: 'queue.json', session: 'session.json' };
const QUALITIES = ['LOSSLESS', 'HIGH'];
const isInt = (v) => typeof v === 'number' && isFinite(v) && Math.floor(v) === v;

const VIDEO_HEIGHTS = [480, 720, 1080];
const VALID = {
    prefs: (s) => QUALITIES.indexOf(s.quality) >= 0 && (s.videoHeight === undefined || VIDEO_HEIGHTS.indexOf(s.videoHeight) >= 0),
    // kinds (a queue with videos): 'track' or 'video' for each id
    queue: (s) => Array.isArray(s.tracks) && s.tracks.length <= 1000 && s.tracks.every((t) => isInt(t) && t > 0) &&
        isInt(s.index) && s.index >= -1 && s.index < s.tracks.length && (s.tracks.length > 0 || s.index === -1) &&
        typeof s.position === 'number' && isFinite(s.position) && s.position >= 0 &&
        (s.kinds === undefined || (Array.isArray(s.kinds) && s.kinds.length === s.tracks.length && s.kinds.every((k) => k === 'track' || k === 'video'))),
    session: (s) => typeof s.accessToken === 'string' && s.accessToken.length > 0,
};

function createState(dir) {
    try { fs.mkdirSync(dir, 0o700); } catch (e) { /* there */ }
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* not ours */ }

    function file(name) {
        if (!NAMES[name]) throw new Error('unknown state file ' + name);
        return path.join(dir, NAMES[name]);
    }
    function read(name) {
        let s;
        try { s = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return null; }
        if (!s || typeof s !== 'object' || Array.isArray(s) || s.version !== 1) return null;
        return VALID[name](s) ? s : null;
    }
    function write(name, obj) {
        const f = file(name);
        const tmp = f + '.tmp';
        const data = JSON.stringify(Object.assign({ version: 1 }, obj, { version: 1 })) + '\n';
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeSync(fd, data);
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, f);
    }
    /** the file, or `fallback` when it is missing; one that is there but unreadable, or of another version, is replaced by it */
    function load(name, fallback) {
        const v = read(name);
        if (v) return v;
        if (fs.existsSync(file(name))) { try { write(name, fallback); } catch (e) { /* read-only: the next write replaces it */ } }
        return fallback;
    }
    function remove(name) { try { fs.unlinkSync(file(name)); } catch (e) { /* none */ } }
    return { dir: dir, file: file, read: read, load: load, write: write, remove: remove };
}

/** removes a folder and what is in it (Node 8: no recursive rmdir) */
function rmrf(p) {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) {
        fs.readdirSync(p).forEach((n) => rmrf(path.join(p, n)));
        try { fs.rmdirSync(p); } catch (e) { /* busy */ }
    } else { try { fs.unlinkSync(p); } catch (e) { /* gone */ } }
}

module.exports = { createState: createState, rmrf: rmrf, NAMES: NAMES };
