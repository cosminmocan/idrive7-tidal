'use strict';
/**
 * log.js - the service's log: every line goes to the journal (stdout) and into a ring of the newest 200, which the
 * `log` command returns for the app's QR log (docs/PROTOCOL.md section 1), so a problem in the car can be read
 * without a computer. Each kept line starts with its time of day, hh:mm:ss.
 *
 * A line never holds a token. Before a line is kept or printed:
 *   - the session's access and refresh token (session.json, read again when the file changes) are cut out wherever
 *     they stand; lines kept before the session had them are cleaned again when they are returned;
 *   - of an address only the scheme, the host and the path stay: no user, no query, no fragment (TIDAL's stream
 *     addresses carry their token in the query);
 *   - the value after a name that holds a secret (authorization, *token, client_secret, password, ...), a
 *     `Bearer` or `Basic` value, and anything that looks like a JWT become ***.
 * A line is cut at 300 characters, so 200 of them stay far under the answer size.
 *
 *   const lg = createLog({ now, out(line), sessionFile });
 *   lg.log(line)      scrubbed, kept with its time, passed to out
 *   lg.lines(n)       the newest n (at most 200), oldest first
 *   scrub(line, tokens)   the rules above, for the tests
 *
 * Node 8.9.4.
 */
const fs = require('fs');

const KEPT = 200;
const LINE_MAX = 300;
const TOKEN_MIN = 8;     // a session token shorter than this is no token (and cutting it out would cut words)
const GONE = '***';

const URL_RE = /\b(https?:\/\/)(?:[^\s\/"'<>?#@]*@)?([^\s"'<>?#]*)(?:[?#][^\s"'<>]*)?/gi;
const NAMED_RE = /((?:[a-z0-9_-]*token|client[_-]?secret|authorization|password|passwd|secret|code[_-]?verifier|device[_-]?code|api[_-]?key|cookie)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"'&,;}]+/gi;
const SCHEME_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g;

function cut(line, tokens) {
    let s = line;
    (tokens || []).forEach((t) => { if (s.indexOf(t) >= 0) s = s.split(t).join(GONE); });
    return s;
}
function scrub(line, tokens) {
    return cut(String(line), tokens).replace(URL_RE, '$1$2').replace(NAMED_RE, '$1' + GONE).replace(SCHEME_RE, '$1 ' + GONE).replace(JWT_RE, GONE);
}

function clock(ms) {
    const d = new Date(ms);
    const two = (n) => (n < 10 ? '0' : '') + n;
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

function createLog(opts) {
    const o = opts || {};
    const now = o.now || Date.now;
    const out = o.out || (() => {});
    const ring = [];
    let tokens = [], seen = '';

    /** the session's tokens, read again when session.json changed (a login, a refresh, a logout) */
    function sessionTokens() {
        if (!o.sessionFile) return tokens;
        let key = '';
        try { const st = fs.statSync(o.sessionFile); key = st.ino + ':' + st.size + ':' + st.mtime.getTime(); } catch (e) { key = ''; }
        if (key === seen) return tokens;
        seen = key;
        const found = [];
        if (key) {
            try {
                const s = JSON.parse(fs.readFileSync(o.sessionFile, 'utf8'));
                ['accessToken', 'refreshToken'].forEach((k) => { if (s && typeof s[k] === 'string' && s[k].length >= TOKEN_MIN) found.push(s[k]); });
            } catch (e) { /* half-written or not JSON: the names' and the JWT rule still hold */ }
        }
        // the ones before stay known: an old token is still not for the log
        found.forEach((t) => { if (tokens.indexOf(t) < 0) tokens.push(t); });
        if (tokens.length > 16) tokens = tokens.slice(-16);
        return tokens;
    }

    function log(line) {
        let s;
        try { s = scrub(String(line).replace(/[\r\n]+/g, ' '), sessionTokens()).slice(0, LINE_MAX); } catch (e) { s = 'a log line was lost (' + ((e && e.message) || 'error') + ')'; }
        ring.push(clock(now()) + ' ' + s);
        if (ring.length > KEPT) ring.shift();
        try { out(s); } catch (e) { /* the journal is gone: the ring still has it */ }
    }
    function lines(n) {
        const k = Math.max(1, Math.min(KEPT, n || KEPT));
        const t = sessionTokens();
        return ring.slice(-k).map((l) => cut(l, t));
    }
    return { log: log, lines: lines };
}

module.exports = { createLog: createLog, scrub: scrub, KEPT: KEPT, LINE_MAX: LINE_MAX };
