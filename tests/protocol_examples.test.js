'use strict';
/**
 * S3: docs/PROTOCOL.md is the contract between the parts. Every JSON example in it must pass the validator that
 * every fake and every real part is tested with, and the validator must refuse what the contract forbids.
 *
 * Examples are fenced blocks whose info string names what they are:
 *   ```json request             a control-socket request
 *   ```json answer <cmd>        the answer to <cmd> (ok or error)
 *   ```json player-event        one player event (the JSON after "MGU ")
 *   ```json state <file>        a state file (session, prefs, queue)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');

const DOC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PROTOCOL.md'), 'utf8');

function examples() {
    const out = [];
    const re = /```json ([^\n]+)\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(DOC))) out.push({ tag: m[1].trim().split(/\s+/), text: m[2], line: DOC.slice(0, m.index).split('\n').length });
    return out;
}

function check(ex) {
    let obj;
    try { obj = JSON.parse(ex.text); } catch (e) { return ['not JSON: ' + e.message]; }
    const kind = ex.tag[0];
    if (kind === 'request') return P.validateRequest(obj);
    if (kind === 'answer') return P.validateAnswer(ex.tag[1], obj);
    if (kind === 'player-event') return P.validatePlayerEvent(obj);
    if (kind === 'state') return P.validateState(ex.tag[1], obj);
    return ['unknown example kind "' + kind + '"'];
}

test('the document has examples of every kind', () => {
    const kinds = {};
    examples().forEach((e) => { kinds[e.tag[0]] = true; });
    assert.deepStrictEqual(Object.keys(kinds).sort(), ['answer', 'player-event', 'request', 'state']);
});

test('every command in the contract has a request example and an ok answer example', () => {
    const ex = examples();
    P.COMMANDS.forEach((cmd) => {
        assert.ok(ex.some((e) => e.tag[0] === 'request' && JSON.parse(e.text).cmd === cmd), 'no request example for ' + cmd);
        assert.ok(ex.some((e) => e.tag[0] === 'answer' && e.tag[1] === cmd && JSON.parse(e.text).ok === true), 'no ok answer example for ' + cmd);
    });
});

test('every player event and every state file has an example', () => {
    const ex = examples();
    P.PLAYER_EVENTS.forEach((ev) => assert.ok(ex.some((e) => e.tag[0] === 'player-event' && JSON.parse(e.text).ev === ev), 'no example for event ' + ev));
    P.STATE_FILES.forEach((f) => assert.ok(ex.some((e) => e.tag[0] === 'state' && e.tag[1] === f), 'no example for state ' + f));
});

test('every example in docs/PROTOCOL.md validates', () => {
    const bad = [];
    examples().forEach((e) => { const errs = check(e); if (errs.length) bad.push('line ' + e.line + ' (' + e.tag.join(' ') + '): ' + errs.join('; ')); });
    assert.deepStrictEqual(bad, []);
});

test('every error code in the contract is listed in the document', () => {
    P.ERROR_CODES.forEach((c) => assert.ok(DOC.indexOf('`' + c + '`') >= 0, 'error code ' + c + ' not documented'));
});

// what the validator must refuse
test('requests: id must be a positive integer, cmd must be known, params typed', () => {
    assert.ok(P.validateRequest({ cmd: 'status' }).length > 0, 'missing id');
    assert.ok(P.validateRequest({ id: 0, cmd: 'status' }).length > 0, 'id 0');
    assert.ok(P.validateRequest({ id: 1.5, cmd: 'status' }).length > 0, 'id not integer');
    assert.ok(P.validateRequest({ id: 1, cmd: 'reboot' }).length > 0, 'unknown cmd');
    assert.ok(P.validateRequest({ id: 1, cmd: 'search' }).length > 0, 'search without query');
    assert.ok(P.validateRequest({ id: 1, cmd: 'play', tracks: [], index: 0 }).length > 0, 'play with no tracks');
    assert.ok(P.validateRequest({ id: 1, cmd: 'play', tracks: [5], index: 1 }).length > 0, 'play index out of range');
    assert.ok(P.validateRequest({ id: 1, cmd: 'prefs', quality: 'HI_RES_LOSSLESS' }).length > 0, 'no hi-res');
    assert.ok(P.validateRequest({ id: 1, cmd: 'favorites', kind: 'tracks', limit: 1000 }).length > 0, 'limit too large');
    assert.deepStrictEqual(P.validateRequest({ id: 7, cmd: 'search', query: 'daft punk', offset: 0, limit: 50 }), []);
});

test('answers: error answers carry a known code, ok answers carry their fields', () => {
    assert.ok(P.validateAnswer('status', { id: 1, ok: false, error: 'oops' }).length > 0, 'unknown error code');
    assert.ok(P.validateAnswer('status', { id: 1, ok: true }).length > 0, 'status without state');
    assert.ok(P.validateAnswer('login-start', { id: 1, ok: true, url: 'http://x', userCode: 'A', expiresIn: 300 }).length > 0, 'login url must be https');
    assert.deepStrictEqual(P.validateAnswer('search', { id: 3, ok: false, error: 'offline' }), []);
    assert.deepStrictEqual(P.validateAnswer('search', { id: 3, ok: false, error: 'rate-limited', retryAfter: 30 }), []);
});

// contract 2 (2026-11-27): what the streams needed, now required
const fakeService = require('./fakes/fake_service');
function statusWith(change) {
    const s = JSON.parse(JSON.stringify(fakeService.defaultState()));
    change(s);
    return { id: 1, ok: true, state: s };
}

test('status: a pending login carries its link, code and end, so the app can show it again after a restart', () => {
    assert.deepStrictEqual(P.validateAnswer('status', statusWith((s) => { s.login = 'login-pending'; s.loginPending = { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresAt: 1795000000000 }; })), []);
    assert.ok(P.validateAnswer('status', statusWith((s) => { s.login = 'login-pending'; s.loginPending = null; })).length > 0, 'pending without its details');
    assert.ok(P.validateAnswer('status', statusWith((s) => { s.login = 'logged-in'; s.loginPending = { url: 'https://x', userCode: 'A', expiresAt: 1 }; })).length > 0, 'details while not pending');
    assert.ok(P.validateAnswer('status', statusWith((s) => { delete s.loginPending; })).length > 0, 'loginPending is required (null when none)');
});

test('status: loginError says why the last login ended without one: login-expired or login-denied', () => {
    ['login-expired', 'login-denied', null].forEach((e) => assert.deepStrictEqual(P.validateAnswer('status', statusWith((s) => { s.loginError = e; })), [], String(e)));
    assert.ok(P.validateAnswer('status', statusWith((s) => { s.loginError = 'offline'; })).length > 0);
    assert.ok(P.validateAnswer('status', statusWith((s) => { delete s.loginError; })).length > 0, 'loginError is required (null when none)');
});

test('status: player.skipped lists the tracks passed over, with the reason', () => {
    assert.deepStrictEqual(P.validateAnswer('status', statusWith((s) => { s.player.skipped = [{ id: 5, error: 'not-available' }]; })), []);
    assert.ok(P.validateAnswer('status', statusWith((s) => { s.player.skipped = [{ id: 5 }]; })).length > 0, 'reason missing');
    assert.ok(P.validateAnswer('status', statusWith((s) => { delete s.player.skipped; })).length > 0, 'skipped is required ([] when none)');
});

test('status: children is optional; when there it is an object', () => {
    assert.deepStrictEqual(P.validateAnswer('status', statusWith((s) => { s.children = { client: { running: true }, player: { running: false } }; })), []);
    assert.ok(P.validateAnswer('status', statusWith((s) => { s.children = 'fine'; })).length > 0);
});

test('album, mix and mixes are paged like the other lists', () => {
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'album', albumId: 3, offset: 50, limit: 50 }), []);
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'mix', mixId: 'abc', offset: 0, limit: 100 }), []);
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'mixes', offset: 0, limit: 20 }), []);
    assert.ok(P.validateRequest({ id: 1, cmd: 'mix', mixId: 'abc', limit: 500 }).length > 0, 'limit too large');
});

test('the default quality is HIGH (version 1: the QR login gets AAC 320 at most)', () => {
    assert.strictEqual(fakeService.defaultState().prefs.quality, 'HIGH');
});

// contract 3 (2026-11-27): seek, and the service's log
test('seek: a position in seconds, 0 or more', () => {
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'seek', position: 92.5 }), []);
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'seek', position: 0 }), []);
    assert.ok(P.validateRequest({ id: 1, cmd: 'seek' }).length > 0, 'no position');
    assert.ok(P.validateRequest({ id: 1, cmd: 'seek', position: -1 }).length > 0, 'negative');
    assert.ok(P.validateRequest({ id: 1, cmd: 'seek', position: '10' }).length > 0, 'not a number');
});

test('log: at most 200 lines asked for; the answer is a list of at most 200 strings', () => {
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'log' }), []);
    assert.deepStrictEqual(P.validateRequest({ id: 1, cmd: 'log', lines: 200 }), []);
    assert.ok(P.validateRequest({ id: 1, cmd: 'log', lines: 201 }).length > 0);
    assert.deepStrictEqual(P.validateAnswer('log', { id: 1, ok: true, lines: ['12:00:01 track 5: not available, skipped'] }), []);
    assert.ok(P.validateAnswer('log', { id: 1, ok: true }).length > 0, 'no lines');
    assert.ok(P.validateAnswer('log', { id: 1, ok: true, lines: [5] }).length > 0, 'not strings');
    const many = []; for (let i = 0; i < 201; i++) many.push('x');
    assert.ok(P.validateAnswer('log', { id: 1, ok: true, lines: many }).length > 0, 'more than 200');
});

test('the document names the player\'s start position (MGU_START_MS)', () => {
    assert.ok(DOC.indexOf('`MGU_START_MS`') >= 0);
});

test('player events: unknown events and bad fields are refused', () => {
    assert.ok(P.validatePlayerEvent({ ev: 'boom' }).length > 0);
    assert.ok(P.validatePlayerEvent({ ev: 'tick', pos: -1, state: 'playing', buffered: 0, dropped: 0 }).length > 0, 'negative position');
    assert.ok(P.validatePlayerEvent({ ev: 'tick', pos: 1, state: 'stopped', buffered: 0, dropped: 0 }).length > 0, 'unknown state');
    assert.ok(P.validatePlayerEvent({ ev: 'error', code: 'nope', message: 'x' }).length > 0, 'unknown error code');
});

test('parsePlayerLine reads "MGU {json}" lines and ignores anything else', () => {
    assert.deepStrictEqual(P.parsePlayerLine('MGU {"ev":"end"}'), { ev: 'end' });
    assert.strictEqual(P.parsePlayerLine('some log line'), null);
    assert.strictEqual(P.parsePlayerLine('MGU {not json'), null);
});

test('state files: version 1 only, session needs its tokens', () => {
    assert.ok(P.validateState('session', { version: 2 }).length > 0);
    assert.ok(P.validateState('session', { version: 1, accessToken: 'a' }).length > 0, 'no refresh token');
    assert.ok(P.validateState('prefs', { version: 1, quality: 'MAX' }).length > 0);
    assert.ok(P.validateState('nope', { version: 1 }).length > 0);
});

run();
