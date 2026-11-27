'use strict';
/**
 * C3: the login commands. login-start gives TIDAL's link and code; status goes logged-out, login-pending,
 * logged-in; an expired code goes back to logged-out with login-expired; login-cancel stops the polling; logout
 * removes session.json and the cover cache; a saved session is logged-in after a restart.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService } = require('./fakes/service_harness');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const polls = (cfg) => cfg.calls.filter((c) => c.method === 'loginPoll').length;
const COVER = '24f52ab0-e7d6-414d-a650-20a4c686aa57';

test('login-start answers with the link and the code; status goes logged-out, login-pending, logged-in', async () => {
    const h = await startService({ tidal: { login: ['pending', 'pending', 'authorized'], interval: 0.05 } });
    try {
        assert.strictEqual((await h.status()).login, 'logged-out');
        const a = await h.req({ id: 3, cmd: 'login-start' });
        assert.deepStrictEqual(P.validateAnswer('login-start', a), []);
        assert.strictEqual(a.url, 'https://link.tidal.com/ABCDE'); assert.strictEqual(a.userCode, 'ABCDE'); assert.strictEqual(a.expiresIn, 300);
        assert.strictEqual((await h.status()).login, 'login-pending');
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-in' && x), 3000, 'logged-in');
        assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), []);
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

test('a second login-start while one is pending answers busy', async () => {
    const h = await startService({ tidal: { login: ['pending'] } });
    try {
        await h.req({ cmd: 'login-start' });
        const a = await h.req({ cmd: 'login-start' });
        assert.strictEqual(a.ok, false); assert.strictEqual(a.error, 'busy');
    } finally { await h.close(); }
});

test('an expired code goes back to logged-out, with login-expired', async () => {
    const h = await startService({ tidal: { login: ['pending', 'expired'] } });
    try {
        await h.req({ cmd: 'login-start' });
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-out' && x), 3000, 'logged-out');
        assert.strictEqual(s.loginError, 'login-expired');
        assert.deepStrictEqual(P.validateAnswer('status', { id: 1, ok: true, state: s }), []);
        const n = polls(h.cfg);
        await h.sleep(200);
        assert.strictEqual(polls(h.cfg), n, 'polling stopped');
    } finally { await h.close(); }
});

test('a code past its expiresIn ends the login even when TIDAL still says pending', async () => {
    const h = await startService({ tidal: { login: ['pending'], expiresIn: 1 } });
    try {
        await h.req({ cmd: 'login-start' });
        const s = await h.until(() => h.status().then((x) => x.login === 'logged-out' && x), 3000, 'logged-out');
        assert.strictEqual(s.loginError, 'login-expired');
    } finally { await h.close(); }
});

test('a denied login goes back to logged-out', async () => {
    const h = await startService({ tidal: { login: ['denied'] } });
    try {
        await h.req({ cmd: 'login-start' });
        await h.until(() => h.status().then((x) => x.login === 'logged-out'), 3000, 'logged-out');
    } finally { await h.close(); }
});

test('login-cancel stops the polling', async () => {
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
        assert.strictEqual(s.login, 'logged-out');
        assert.strictEqual(s.loginError, null);
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
