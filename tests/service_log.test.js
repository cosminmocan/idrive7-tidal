'use strict';
/**
 * D1 (phase 2), the service's part: the service keeps its newest 200 log lines, each starting with its time
 * (hh:mm:ss), and `log {lines}` returns them oldest first (docs/PROTOCOL.md section 1), for the app's QR log. A line
 * never holds a token: not the session's access or refresh token, no Authorization value, and of an address only
 * the host and the path (TIDAL's stream addresses carry a token in their query). What a driver needs to understand
 * a problem is in it: play, seek and skip with the track's id and the reason code, the login's changes, offline and
 * online, each player's exit code.
 *
 * The lines come from a stand-in player that writes what the test tells it to its stderr (the service logs a
 * player's lines), so the test can put a token or an address into the service's log.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService, until } = require('./fakes/service_harness');
const { createFileServer, track } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

// made up here, at run time, of parts: nothing in this file is, or looks like, a real token
const fake = (name) => ['FAKE', name, 'c2VjcmV0', 'bm90LXJlYWw', '0123456789'].join('-');
const ACCESS = fake('ACCESS'), REFRESH = fake('REFRESH'), BEARER = fake('BEARER'), BASIC = fake('BASIC'), QUERY = fake('QUERY'),
    FORM_A = fake('FORMA'), FORM_R = fake('FORMR'), JSON_A = fake('JSONA'), JSON_R = fake('JSONR'), LATER = fake('LATER'), SIG = fake('SIG');
const session = (access, refresh) => JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: access, refreshToken: refresh, expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });

// a player that says the lines of the file SAY_FILE on its stderr, then stays (as one playing) until it is ended
const SAYER = 'const fs = require("fs"); process.stdin.resume();' +
    'JSON.parse(fs.readFileSync(process.env.SAY_FILE, "utf8")).forEach((l) => console.error(l));' +
    'console.error("said it all"); setInterval(() => {}, 1000);';

function setup(files, extra) {
    const x = extra || {};
    let h = null;
    const service = x.say ? { playerArgs: ['-e', SAYER], playerEnv: () => ({ SAY_FILE: path.join(h.dir, 'say.json') }) }
        : { playerEnv: { FAKE_TICK_MS: x.tickMs || '20', FAKE_SECONDS: x.seconds || '1000' } };
    return startService({ client: true, files: x.files === undefined ? { 'session.json': session(ACCESS, REFRESH) } : x.files,
        tidal: Object.assign({ library: { search: [track(1, 'One'), track(2, 'Two'), track(3, 'Three')] },
            streamUrl: (id, quality) => ({ url: files.url('t' + id), codec: 'flac', quality: quality }) }, x.tidal || {}),
        service: Object.assign(service, x.service || {}) }).then((s) => { h = s; return h; });
}
function logLines(h, lines) {
    const r = Object.assign({ id: 7, cmd: 'log' }, lines === undefined ? {} : { lines: lines });
    assert.deepStrictEqual(P.validateRequest(r), [], JSON.stringify(r));
    return h.req(r).then((a) => {
        assert.deepStrictEqual(P.validateAnswer('log', a), [], JSON.stringify(a).slice(0, 300));
        assert.strictEqual(a.ok, true);
        a.lines.forEach((l) => assert(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d \S/.test(l), 'a line starts with its time: ' + l));
        return a.lines;
    });
}
/** the player says `lines`; resolves with the service's log once it has said them all */
function say(h, lines) {
    fs.writeFileSync(path.join(h.dir, 'say.json'), JSON.stringify(lines));
    return h.req({ cmd: 'play', tracks: [1], index: 0 })
        .then(() => until(() => logLines(h).then((l) => (has(l, /said it all/) ? l : null)), 8000, 'the player\'s lines in the log'))
        // what the service logs beside them (the download's end) is in too
        .then(() => h.sleep(300)).then(() => logLines(h));
}
const st = (h) => h.status().then((s) => s.player);
const has = (lines, re) => lines.some((l) => re.test(l));
function assertHas(lines, re) { assert(has(lines, re), 'no line like ' + re + ' in:\n  ' + lines.join('\n  ')); }

test('log answers the service\'s lines, each starting with its time, the oldest first', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { say: true });
    try {
        const first = await logLines(h);
        assert(first.length >= 1, 'the start is logged');
        assert(/^\d\d:\d\d:\d\d cmocan-tidal \d+\.\d+\.\d+/.test(first[0]), 'the first line is the start: ' + first[0]);
        // the time is the service's local time of day
        const d = new Date(), two = (n) => ('0' + n).slice(-2);
        assert.strictEqual(first[0].slice(0, 2), two(d.getHours()), first[0]);
        const l = await say(h, ['one', 'two', 'three']);
        const at = (w) => l.map((x) => / player: (.*)$/.test(x) && RegExp.$1).indexOf(w);
        assert(at('one') > 0 && at('two') === at('one') + 1 && at('three') === at('two') + 1, 'in order, oldest first: ' + l.join(' | '));
        assert.strictEqual(l[0], first[0], 'the oldest line is still the first');
    } finally { await h.close(); await files.close(); }
});

test('the newest 200 lines are kept; lines asks for fewer; a bad lines is refused', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { say: true });
    try {
        const many = [];
        for (let i = 0; i < 300; i++) many.push('n=' + i + '.');
        const l = await say(h, many);
        assert.strictEqual(l.length, 200, 'capped at 200');
        assert.strictEqual(P.MAX_LOG_LINES, 200);
        const ns = l.map((x) => /n=(\d+)\./.exec(x)).filter(Boolean).map((m) => Number(m[1]));
        assert(ns.length >= 190 && ns.length < 200, 'the player\'s lines: ' + ns.length);
        assert.strictEqual(ns[ns.length - 1], 299, 'the newest is kept');
        ns.forEach((n, i) => { if (i) assert.strictEqual(n, ns[i - 1] + 1, 'in order, none missing'); });
        assert(!has(l, /cmocan-tidal \d/), 'the oldest lines are gone');
        // lines: the newest that many, oldest first
        assert.deepStrictEqual(await logLines(h, 5), l.slice(-5));
        assert.deepStrictEqual(await logLines(h, 1), l.slice(-1));
        assert.deepStrictEqual(await logLines(h, 200), l);
        assert.deepStrictEqual(await logLines(h), l, 'nothing was logged meanwhile');
        const bad = [0, 201, -1, 1.5, '5', null, [5]];
        for (let i = 0; i < bad.length; i++) {
            const r = { id: 60 + i, cmd: 'log', lines: bad[i] };
            assert.notDeepStrictEqual(P.validateRequest(r), [], 'the contract refuses ' + JSON.stringify(r));
            assert.deepStrictEqual(await h.req(r), { id: 60 + i, ok: false, error: 'bad-request' }, JSON.stringify(r));
        }
        // the answer stays far under the answer size (1 MiB), whatever the lines were
        fs.writeFileSync(path.join(h.dir, 'say.json'), JSON.stringify(many.map((x) => x + new Array(280).join('x'))));
        await h.req({ cmd: 'play', tracks: [2], index: 0 });
        const long = await until(() => logLines(h).then((x) => (has(x, /n=299\.x/) ? x : null)), 8000, 'the long lines');
        assert.strictEqual(long.length, 200);
        long.forEach((x) => assert(x.length <= 320, 'a line of ' + x.length + ' characters'));
    } finally { await h.close(); await files.close(); }
});

test('no token in the log: the session\'s tokens, an Authorization value, a token in a form or in JSON', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { say: true });
    try {
        const l = await say(h, [
            'GET /v1/sessions with ' + ACCESS + ' failed',
            'refresh ' + REFRESH + ' refused',
            'Authorization: Bearer ' + BEARER,
            '{"authorization":"Basic ' + BASIC + '","accept":"*/*"}',
            'POST grant_type=refresh_token&refresh_token=' + FORM_R + '&client_id=abc access_token=' + FORM_A,
            '{"access_token":"' + JSON_A + '","refreshToken": "' + JSON_R + '","expires_in":3600}',
            'a harmless line about track 17927864',
        ]);
        const text = l.join('\n');
        [ACCESS, REFRESH, BEARER, BASIC, FORM_A, FORM_R, JSON_A, JSON_R].forEach((s) => {
            assert(text.indexOf(s) < 0, 'a token is in the log: ' + l.filter((x) => x.indexOf(s) >= 0)[0]);
            assert(text.indexOf(s.slice(5, 25)) < 0, 'a part of a token is in the log');
        });
        // what was around them is still there, to be understood
        assertHas(l, /GET \/v1\/sessions with \S+ failed/);
        assertHas(l, /Authorization: /);
        assertHas(l, /a harmless line about track 17927864$/);
        // and the service's own log (the journal) has none either
        const journal = h.logs.join('\n');
        [ACCESS, REFRESH, BEARER, BASIC, FORM_A, FORM_R, JSON_A, JSON_R].forEach((s) => assert(journal.indexOf(s) < 0, 'a token is in the journal'));
    } finally { await h.close(); await files.close(); }
});

test('of an address only the host and the path are logged, never its query', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { say: true });
    try {
        const l = await say(h, [
            'opening https://sp-ad-fa.audio.tidal.com/mediatracks/CAEaKwgDEidk/0.mp4?token=' + QUERY + '&Expires=1795000000&Signature=' + SIG + ' now',
            'cover http://resources.tidal.com/images/24f52ab0/320x320.jpg, then "https://user:' + BASIC + '@api.tidal.com/v1/tracks/5?countryCode=RO#frag"',
        ]);
        const text = l.join('\n');
        [QUERY, SIG, BASIC, 'token=', 'Expires=', 'Signature=', 'countryCode', '#frag', '?'].forEach((s) => assert(text.indexOf(s) < 0, s + ' is in the log: ' + l.filter((x) => x.indexOf(s) >= 0)[0]));
        assertHas(l, /opening https:\/\/sp-ad-fa\.audio\.tidal\.com\/mediatracks\/CAEaKwgDEidk\/0\.mp4 now$/);
        assertHas(l, /cover http:\/\/resources\.tidal\.com\/images\/24f52ab0\/320x320\.jpg, then "https:\/\/api\.tidal\.com\/v1\/tracks\/5"$/);
        const journal = h.logs.join('\n');
        [QUERY, SIG, BASIC].forEach((s) => assert(journal.indexOf(s) < 0, 'a token is in the journal'));
    } finally { await h.close(); await files.close(); }
});

test('a token the session got after the service started is kept out too, also from lines logged before it', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { say: true });
    try {
        // logged while it was no token yet (a login in progress), then saved as the session's
        let l = await say(h, ['got ' + LATER + ' from the login']);
        fs.writeFileSync(path.join(h.stateDir, 'session.json'), session(LATER, REFRESH), { mode: 0o600 });
        l = await logLines(h);
        assert(l.join('\n').indexOf(LATER) < 0, 'the new token is in the log');
        fs.writeFileSync(path.join(h.dir, 'say.json'), JSON.stringify(['again ' + LATER + ' here']));
        await h.req({ cmd: 'play', tracks: [2], index: 0 });
        l = await until(() => logLines(h).then((x) => (has(x, /again \S+ here/) ? x : null)), 8000, 'the second player\'s line');
        assert(l.join('\n').indexOf(LATER) < 0, 'the new token is in the log');
        assert(h.logs.filter((x) => /again/.test(x)).join('\n').indexOf(LATER) < 0, 'the new token is in the journal');
    } finally { await h.close(); await files.close(); }
});

test('what a driver needs: play, skip, seek, next, prev, pause, resume, stop and errors with the track id; each player\'s exit code', async () => {
    const files = await createFileServer({ size: 50000 });
    // 0.5 s of the track every 250 ms: prev comes within the track's first 3 s, so it goes back one
    const h = await setup(files, { tickMs: '250', tidal: { streamUrl: (id, q) => (id === 1 ? { error: 'not-available' } : id === 9 ? { error: 'tidal-error' } : { url: files.url('t' + id), codec: 'flac', quality: q }) } });
    try {
        await h.req({ cmd: 'play', tracks: [1, 2, 3, 9], index: 0 });
        await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 1), 8000, 'track 2 playing');
        await h.req({ cmd: 'seek', position: 300 });
        await until(() => st(h).then((x) => x.state === 'playing' && x.position > 300), 8000, 'playing from 300');
        await h.req({ cmd: 'pause' });
        await h.req({ cmd: 'resume' });
        await h.req({ cmd: 'next' });
        await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 2), 8000, 'track 3 playing');
        await h.req({ cmd: 'prev' });
        await until(() => st(h).then((x) => x.state === 'playing' && x.queueIndex === 1), 8000, 'track 2 again');
        await h.req({ cmd: 'stop' });
        await until(() => h.pids.player.every((p) => !h.alive(p)), 5000, 'the players ended');
        await h.req({ cmd: 'play', tracks: [1, 2, 3, 9], index: 3 });
        await until(() => st(h).then((x) => x.state === 'error'), 8000, 'error');
        const l = await until(() => logLines(h).then((x) => (x.filter((y) => /player \d+: exited/.test(y)).length >= 4 ? x : null)), 5000, 'every player\'s exit');
        assertHas(l, / play: track 1 \(1 of 4\)$/);
        assertHas(l, / track 1: not available, skipped$/);
        assertHas(l, / playing track 2 \(HIGH, flac\)$/);
        assertHas(l, / seek: track 2 to 300 s$/);
        assertHas(l, / pause: track 2$/);
        assertHas(l, / resume: track 2$/);
        assertHas(l, / next: track 3 \(3 of 4\)$/);
        assertHas(l, / prev: track 2 \(2 of 4\)$/);
        assertHas(l, / stop: track 2$/);
        assertHas(l, / play: track 9 \(4 of 4\)$/);
        assertHas(l, / track 9: tidal-error/);
        h.pids.player.forEach((pid) => assertHas(l, new RegExp(' player ' + pid + ': exited, code 0$')));
        // in the order it happened
        const at = (re) => l.map((x) => re.test(x)).indexOf(true);
        assert(at(/play: track 1 /) < at(/not available, skipped/) && at(/not available, skipped/) < at(/playing track 2/) && at(/playing track 2/) < at(/seek: track 2/) &&
            at(/seek: track 2/) < at(/next: track 3/) && at(/next: track 3/) < at(/prev: track 2/) && at(/prev: track 2/) < at(/stop: track 2/), l.join('\n'));
        // the ticks are not in it: a track's 2 ticks a second would push everything else out
        assert(!has(l, /"ev":"tick"/), 'ticks in the log');
    } finally { await h.close(); await files.close(); }
});

test('a player that ends by itself with an error: its exit code and the reason are in the log', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { service: { playerArgs: ['-e', 'process.stdin.resume(); console.log("MGU " + JSON.stringify({ ev: "error", code: "decode", message: "no FLAC or AAC stream found" })); setTimeout(() => process.exit(5), 50)'] } });
    try {
        await h.req({ cmd: 'play', tracks: [3], index: 0 });
        await until(() => st(h).then((x) => x.state === 'error'), 8000, 'error');
        const l = await logLines(h);
        assertHas(l, new RegExp(' player ' + h.pids.player[0] + ': exited, code 5$'));
        assertHas(l, / track 3: decode/);
    } finally { await h.close(); await files.close(); }
});

test('the internet going and coming back, and the login\'s changes, are in the log', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files, { files: null, tidal: { login: ['pending', 'authorized'] } });
    try {
        let l = await logLines(h);
        assertHas(l, / internet: online$/);
        assertHas(l, / login: logged out$/);
        h.online(false);
        await h.status();
        h.online(true);
        await h.status();
        await h.status();
        const a = await h.req({ cmd: 'login-start' });
        assert.strictEqual(a.ok, true);
        await until(() => h.status().then((s) => s.login === 'logged-in'), 5000, 'logged in');
        await h.req({ cmd: 'logout' });
        await h.req({ cmd: 'login-start' });
        await h.req({ cmd: 'login-cancel' });
        l = await logLines(h);
        const of = (re) => l.filter((x) => re.test(x)).length;
        assert.strictEqual(of(/ internet: offline$/), 1, l.join('\n'));
        assert.strictEqual(of(/ internet: online$/), 2, 'at the start, and when it came back; not at every status: ' + l.join('\n'));
        assert.strictEqual(of(/ login: started/), 2, l.join('\n'));
        assertHas(l, / login: done$/);
        assertHas(l, / logout$/);
        assertHas(l, / login: cancelled$/);
        // the code the driver types is no secret, but the log is shown as a QR code: it is not in it
        assert(!has(l, new RegExp(a.userCode)), 'the login code in the log');
    } finally { await h.close(); await files.close(); }
});

test('with the session there at the start the log says logged in', async () => {
    const files = await createFileServer({ size: 50000 });
    const h = await setup(files);
    try {
        assertHas(await logLines(h), / login: logged in$/);
    } finally { await h.close(); await files.close(); }
});

run();
