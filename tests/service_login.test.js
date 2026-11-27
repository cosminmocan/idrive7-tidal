'use strict';
/**
 * C3: the login commands. login-start gives TIDAL's link and code; status goes logged-out, login-pending (with
 * loginPending: the same link and code, and when it ends), logged-in; an expired code goes back to logged-out
 * with login-expired, a refused one with login-denied; a second login-start answers the pending one; login-cancel
 * stops the polling and tells the TIDAL module; logout removes session.json and the cover cache; a saved session
 * is logged-in after a restart.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService } = require('./fakes/service_harness');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const polls = (cfg) => cfg.calls.filter((c) => c.method === 'loginPoll').length;
const calls = (cfg, m) => cfg.calls.filter((c) => c.method === m).length;
const validStatus = (s) => assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), [], JSON.stringify(s));
const COVER = '24f52ab0-e7d6-414d-a650-20a4c686aa57';

test('login-start answers with the link and the code; status goes logged-out, login-pending, logged-in', async () => {
    const h = await startService({ tidal: { login: ['pending', 'pending', 'authorized'], interval: 0.05 } });
    try {
        const s0 = await h.status();
        validStatus(s0);
        assert.strictEqual(s0.login, 'logged-out'); assert.strictEqual(s0.loginPending, null); assert.strictEqual(s0.loginError, null);
        const t0 = Date.now();
        const a = await h.req({ id: 3, cmd: 'login-start' });
        assert.deepStrictEqual(P.validateAnswer('login-start', a), []);
        assert.strictEqual(a.url, 'https://link.tidal.com/ABCDE'); assert.strictEqual(a.userCode, 'ABCDE'); assert.strictEqual(a.expiresIn, 300);
        const p = await h.status();
        validStatus(p);
        assert.strictEqual(p.login, 'login-pending');
        assert.strictEqual(p.loginPending.url, 'https://link.tidal.com/ABCDE'); assert.strictEqual(p.loginPending.userCode, 'ABCDE');
        assert.ok(p.loginPending.expiresAt >= t0 + 299000 && p.loginPending.expiresAt <= Date.now() + 300000, 'expiresAt: ' + p.loginPending.expiresAt);
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-in' && x), 3000, 'logged-in');
        validStatus(s);
        assert.strictEqual(s.loginPending, null); assert.strictEqual(s.loginError, null);
        assert.strictEqual(polls(h.cfg), 3);
        await h.sleep(200);
        assert.strictEqual(polls(h.cfg), 3, 'no polling once logged in');
        assert.ok(fs.existsSync(path.join(h.stateDir, 'session.json')));
    } finally { await h.close(); }
});

test('polling keeps the interval TIDAL gave', async () => {
    const h = await startService({ tidal: { login: ['pending'], interval: 0.2 } });
    try {
        await h.req({ cmd: 'login-start' });
        await h.sleep(1100);
        const n = polls(h.cfg);
        assert.ok(n >= 4 && n <= 6, n + ' polls in 1.1 s at 0.2 s');
    } finally { await h.close(); }
});

test('a second login-start while one is pending answers the pending one (the same link and code, the time left)', async () => {
    const h = await startService({ tidal: { login: ['pending'] } });
    try {
        const first = await h.req({ cmd: 'login-start' });
        await h.sleep(1100);
        const a = await h.req({ id: 9, cmd: 'login-start' });
        assert.deepStrictEqual(P.validateAnswer('login-start', a), []);
        assert.strictEqual(a.ok, true); assert.strictEqual(a.id, 9);
        assert.strictEqual(a.url, first.url); assert.strictEqual(a.userCode, first.userCode);
        assert.ok(a.expiresIn >= 297 && a.expiresIn <= 299, 'the time left: ' + a.expiresIn);
        assert.strictEqual(calls(h.cfg, 'loginStart'), 1, 'TIDAL asked once');
        assert.strictEqual((await h.status()).login, 'login-pending');
    } finally { await h.close(); }
});

test('two login-starts at once start one login and get the same answer', async () => {
    const h = await startService({ tidal: { login: ['pending'] } });
    try {
        const got = await h.ask([{ id: 1, cmd: 'login-start' }, { id: 2, cmd: 'login-start' }]);
        got.forEach((a) => { assert.strictEqual(a.ok, true, JSON.stringify(a)); assert.strictEqual(a.userCode, 'ABCDE'); });
        assert.strictEqual(calls(h.cfg, 'loginStart'), 1);
    } finally { await h.close(); }
});

test('an expired code goes back to logged-out, with login-expired', async () => {
    const h = await startService({ tidal: { login: ['pending', 'expired'] } });
    try {
        await h.req({ cmd: 'login-start' });
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-out' && x), 3000, 'logged-out');
        assert.strictEqual(s.loginError, 'login-expired');
        assert.strictEqual(s.loginPending, null);
        validStatus(s);
        const n = polls(h.cfg);
        await h.sleep(200);
        assert.strictEqual(polls(h.cfg), n, 'polling stopped');
        // a new login clears it
        await h.req({ cmd: 'login-start' });
        const again = await h.status();
        validStatus(again);
        assert.strictEqual(again.login, 'login-pending'); assert.strictEqual(again.loginError, null);
    } finally { await h.close(); }
});

test('a code past its expiresIn ends the login even when TIDAL still says pending', async () => {
    const h = await startService({ tidal: { login: ['pending'], expiresIn: 1 } });
    try {
        await h.req({ cmd: 'login-start' });
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-out' && x), 3000, 'logged-out');
        assert.strictEqual(s.loginError, 'login-expired');
        assert.strictEqual(s.loginPending, null);
        validStatus(s);
    } finally { await h.close(); }
});

test('a denied login goes back to logged-out, with login-denied', async () => {
    const h = await startService({ tidal: { login: ['denied'] } });
    try {
        await h.req({ cmd: 'login-start' });
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-out' && x), 3000, 'logged-out');
        assert.strictEqual(s.loginError, 'login-denied');
        assert.strictEqual(s.loginPending, null);
        validStatus(s);
    } finally { await h.close(); }
});

test('login-cancel stops the polling and tells the TIDAL module', async () => {
    const h = await startService({ tidal: { login: ['pending'] } });
    try {
        await h.req({ cmd: 'login-start' });
        await h.until(() => polls(h.cfg) >= 2, 3000, 'polling');
        const a = await h.req({ id: 4, cmd: 'login-cancel' });
        assert.deepStrictEqual(a, { id: 4, ok: true });
        const n = polls(h.cfg);
        await h.sleep(300);
        assert.ok(polls(h.cfg) <= n + 1, 'no more polls');
        const s = await h.status();
        validStatus(s);
        assert.strictEqual(s.login, 'logged-out');
        assert.strictEqual(s.loginError, null);
        assert.strictEqual(s.loginPending, null);
        assert.strictEqual(calls(h.cfg, 'loginCancel'), 1, 'tidal.loginCancel()');
    } finally { await h.close(); }
});

test('logout removes session.json and the cover cache, even when the TIDAL module left them', async () => {
    const h = await startService({ tidal: { login: ['authorized'], covers: {}, logoutLeavesFiles: true } });
    h.cfg.covers[COVER] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    try {
        await h.req({ cmd: 'login-start' });
        await h.until(() => h.status().then((x) => x.login === 'logged-in'), 3000, 'logged-in');
        const c = await h.req({ cmd: 'cover', coverId: COVER });
        assert.deepStrictEqual(P.validateAnswer('cover', c), []);
        assert.ok(fs.existsSync(path.join(h.stateDir, 'covers', COVER + '.jpg')));
        const a = await h.req({ id: 5, cmd: 'logout' });
        assert.deepStrictEqual(a, { id: 5, ok: true });
        assert.ok(!fs.existsSync(path.join(h.stateDir, 'session.json')), 'session.json gone');
        assert.ok(!fs.existsSync(path.join(h.stateDir, 'covers')), 'covers gone');
        assert.strictEqual((await h.status()).login, 'logged-out');
        const f = await h.req({ cmd: 'favorites', kind: 'tracks' });
        assert.strictEqual(f.error, 'not-logged-in');
    } finally { await h.close(); }
});

test('after a restart of the service a saved session is logged-in with no new login', async () => {
    const h1 = await startService({ tidal: { login: ['authorized'] } });
    let saved;
    try {
        await h1.req({ cmd: 'login-start' });
        await h1.until(() => h1.status().then((x) => x.login === 'logged-in'), 3000, 'logged-in');
        saved = fs.readFileSync(path.join(h1.stateDir, 'session.json'), 'utf8');
        assert.deepStrictEqual(P.validateState('session', JSON.parse(saved)), []);
    } finally { await h1.close(); }
    const h2 = await startService({ files: { 'session.json': saved } });
    try {
        assert.strictEqual((await h2.status()).login, 'logged-in');
        assert.strictEqual(h2.cfg.calls.filter((c) => /^login/.test(c.method)).length, 0);
    } finally { await h2.close(); }
});

run();
