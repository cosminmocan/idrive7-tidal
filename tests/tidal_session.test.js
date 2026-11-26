'use strict';
/**
 * A3: session.json (load, save), the access token's refresh, a 401's one refresh and one retry, and the
 * mapping of TIDAL's answers to the control-socket codes. API calls go through tidal._get(path, params), the raw
 * GET the library (A4) is built on.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');
const P = require('./fakes/protocol');

function withEnv(opts, fn) {
    return F.startTidal(opts).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
const readSession = (env) => JSON.parse(fs.readFileSync(env.sessionFile, 'utf8'));
const apiCalls = (env, p) => env.fake.requests('/api/v1/' + p);
function rejects(p, code) {
    return p.then((v) => { throw new Error('expected ' + code + ', got ' + JSON.stringify(v)); }, (e) => { assert.strictEqual(e.code, code, e.code + ': ' + e.message); assert.ok(e instanceof Error); return e; });
}
const ME = (env) => 'users/' + env.fake.data.userId + '/favorites/tracks';

/* ---------- loading ---------- */

test('a missing, empty, half-written, wrong-version or incomplete file loads as logged out and never throws', () => withEnv({}, (env) => {
    assert.strictEqual(env.tidal.loggedIn(), false);
    const good = { version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1, userId: 5, countryCode: 'RO' };
    const bad = ['', '{"version":1,"tokenType":"Bea', 'null', '[]', '"x"', JSON.stringify(Object.assign({}, good, { version: 2 })),
        JSON.stringify(Object.assign({}, good, { accessToken: '' })), JSON.stringify(Object.assign({}, good, { countryCode: 'ro' })),
        JSON.stringify({ version: 1 }), '\u0000\u0000\u0000'];
    bad.forEach((content) => {
        fs.writeFileSync(env.sessionFile, content);
        assert.strictEqual(env.make().loggedIn(), false, 'content ' + JSON.stringify(content));
    });
    fs.writeFileSync(env.sessionFile, JSON.stringify(good));
    assert.strictEqual(env.make().loggedIn(), true);
    fs.unlinkSync(env.sessionFile);
    fs.mkdirSync(env.sessionFile); // even a folder in its place
    assert.strictEqual(env.make().loggedIn(), false);
    fs.rmdirSync(env.sessionFile);
}));

test('a saved session is used: its token and its country go with every request', () => withEnv({ loggedIn: true }, (env) => {
    assert.strictEqual(env.tidal.loggedIn(), true);
    const s = readSession(env);
    return env.tidal._get(ME(env), { offset: 0, limit: 2 }).then((json) => {
        assert.strictEqual(json.items.length, 2);
        const c = apiCalls(env, ME(env))[0];
        assert.strictEqual(c.headers.authorization, 'Bearer ' + s.accessToken);
        assert.strictEqual(c.query.countryCode, 'RO');
        assert.strictEqual(c.headers['x-tidal-client-version'], '2025.7.16');
        assert.ok(/Mozilla\/5\.0/.test(c.headers['user-agent']));
        assert.strictEqual(env.fake.counts.refresh, 0);
    });
}));

test('not logged in: a request is not-logged-in and nothing is sent', () => withEnv({}, (env) =>
    rejects(env.tidal._get('sessions', {}), 'not-logged-in').then(() => assert.strictEqual(env.fake.log.length, 0))));

/* ---------- saving ---------- */

test('a refresh rewrites the file whole: 0600, contract shape, no temporary file left', () => withEnv({ loggedIn: true }, (env) => {
    fs.chmodSync(env.sessionFile, 420); // 0644 before
    const before = readSession(env);
    env.clock.t = before.expiresAt - 30 * 1000; // 30 s left: refreshed before use
    return env.tidal._get(ME(env), {}).then(() => {
        const after = readSession(env);
        assert.deepStrictEqual(P.validateState('session', after), []);
        assert.notStrictEqual(after.accessToken, before.accessToken);
        assert.strictEqual(after.refreshToken, before.refreshToken);
        assert.strictEqual(after.expiresAt, env.clock.t + 604800 * 1000);
        assert.strictEqual(fs.statSync(env.sessionFile).mode & 511, 384);
        assert.deepStrictEqual(fs.readdirSync(env.dir).filter((f) => /session/.test(f)), ['session.json']);
    });
}));

/* ---------- refresh ---------- */

test('the token is refreshed shortly before it expires, with tidalapi\'s form, and the new one is used', () => withEnv({ loggedIn: true }, (env) => {
    const before = readSession(env);
    env.clock.t = before.expiresAt - 59 * 1000;
    return env.tidal._get(ME(env), {}).then(() => {
        assert.strictEqual(env.fake.counts.refresh, 1);
        const r = env.fake.requests('/auth/v1/oauth2/token').filter((e) => e.form.grant_type === 'refresh_token')[0];
        assert.deepStrictEqual(r.form, { grant_type: 'refresh_token', refresh_token: before.refreshToken, client_id: F.CLIENT_ID, client_secret: F.CLIENT_SECRET });
        assert.strictEqual(apiCalls(env, ME(env))[0].headers.authorization, 'Bearer ' + readSession(env).accessToken);
    });
}));

test('with more than a minute left, no refresh', () => withEnv({ loggedIn: true }, (env) => {
    env.clock.t = readSession(env).expiresAt - 61 * 1000;
    return env.tidal._get(ME(env), {}).then(() => assert.strictEqual(env.fake.counts.refresh, 0));
}));

test('a 401 makes one refresh and one retry', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    return env.tidal._get(ME(env), { limit: 3 }).then((json) => {
        assert.strictEqual(json.items.length, 3);
        assert.strictEqual(env.fake.counts.refresh, 1);
        assert.strictEqual(apiCalls(env, ME(env)).length, 2);
    });
}));

test('ten parallel requests that hit 401 together make exactly one refresh', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    const all = [];
    for (let i = 0; i < 10; i++) all.push(env.tidal._get(ME(env), { offset: i, limit: 1 }));
    return Promise.all(all).then((rs) => {
        assert.strictEqual(rs.length, 10);
        rs.forEach((j, i) => assert.strictEqual(j.offset, i));
        assert.strictEqual(env.fake.counts.refresh, 1);
    });
}));

test('ten parallel requests with an expired token make exactly one refresh', () => withEnv({ loggedIn: true }, (env) => {
    env.clock.t = readSession(env).expiresAt + 1000;
    env.fake.expireAccessTokens();
    const all = [];
    for (let i = 0; i < 10; i++) all.push(env.tidal._get(ME(env), { offset: i, limit: 1 }));
    return Promise.all(all).then(() => {
        assert.strictEqual(env.fake.counts.refresh, 1);
        assert.strictEqual(apiCalls(env, ME(env)).length, 10, 'no request was sent with the old token');
    });
}));

test('TIDAL\'s new refresh token, when it sends one, is kept', () => withEnv({ loggedIn: true, fake: { rotateRefreshTokens: true } }, (env) => {
    const first = readSession(env).refreshToken;
    env.fake.expireAccessTokens();
    return env.tidal._get(ME(env), {}).then(() => {
        const second = readSession(env).refreshToken;
        assert.notStrictEqual(second, first);
        env.fake.expireAccessTokens();
        return env.tidal._get(ME(env), {});
    }).then(() => { assert.strictEqual(env.fake.counts.refresh, 2); assert.strictEqual(env.tidal.loggedIn(), true); });
}));

test('a refresh TIDAL rejects deletes the session and reports login-expired', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    env.fake.revokeRefreshTokens();
    return rejects(env.tidal._get(ME(env), {}), 'login-expired').then(() => {
        assert.strictEqual(env.tidal.loggedIn(), false);
        assert.ok(!fs.existsSync(env.sessionFile), 'the session file is gone');
        assert.strictEqual(env.make().loggedIn(), false);
        return rejects(env.tidal._get(ME(env), {}), 'not-logged-in');
    });
}));

test('ten parallel requests and a rejected refresh: one refresh, all ten login-expired', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    env.fake.revokeRefreshTokens();
    const all = [];
    for (let i = 0; i < 10; i++) all.push(rejects(env.tidal._get(ME(env), {}), 'login-expired'));
    return Promise.all(all).then(() => assert.strictEqual(env.fake.counts.refresh, 1));
}));

test('a refresh that fails on the network keeps the session: offline', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    env.fake.fault({ path: '/auth/v1/oauth2/token', drop: true, times: 5 });
    return rejects(env.tidal._get(ME(env), {}), 'offline').then(() => {
        assert.strictEqual(env.tidal.loggedIn(), true);
        assert.ok(fs.existsSync(env.sessionFile));
        env.fake.faults = [];
        return env.tidal._get(ME(env), {});
    }).then(() => assert.strictEqual(env.tidal.loggedIn(), true));
}));

test('a refresh TIDAL answers with 5xx keeps the session: tidal-error', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.expireAccessTokens();
    env.fake.fault({ path: '/auth/v1/oauth2/token', status: 502, body: 'bad gateway' });
    return rejects(env.tidal._get(ME(env), {}), 'tidal-error').then(() => assert.strictEqual(env.tidal.loggedIn(), true));
}));

test('a 401 again after the refresh is tidal-error, with one refresh only', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.fault({ path: '/api/v1/' + ME(env), status: 401, times: 2, body: { status: 401, subStatus: 11003, userMessage: 'The token has expired.' } });
    return rejects(env.tidal._get(ME(env), {}), 'tidal-error').then((e) => {
        assert.strictEqual(e.status, 401);
        assert.strictEqual(env.fake.counts.refresh, 1);
        assert.strictEqual(env.tidal.loggedIn(), true);
    });
}));

test('a 401 about the asset (subStatus 4005) is not-available and makes no refresh', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.fault({ path: '/api/v1/tracks/1/urlpostpaywall', status: 401, body: { status: 401, subStatus: 4005, userMessage: 'Asset is not ready for playback' } });
    return rejects(env.tidal._get('tracks/1/urlpostpaywall', {}), 'not-available').then(() => assert.strictEqual(env.fake.counts.refresh, 0));
}));

/* ---------- other answers ---------- */

test('404 is not-found; 5xx and a broken answer are tidal-error with the status', () => withEnv({ loggedIn: true }, (env) =>
    rejects(env.tidal._get('albums/1/tracks', {}), 'not-found').then((e) => {
        assert.strictEqual(e.status, 404);
        env.fake.fault({ path: '/api/v1/' + ME(env), status: 503, body: '<html>busy</html>' });
        return rejects(env.tidal._get(ME(env), {}), 'tidal-error');
    }).then((e) => {
        assert.strictEqual(e.status, 503);
        env.fake.fault({ path: '/api/v1/' + ME(env), status: 200, body: '{"items": [' });
        return rejects(env.tidal._get(ME(env), {}), 'tidal-error');
    })));

test('no uplink is offline', () => withEnv({ loggedIn: true }, (env) => {
    fs.unlinkSync(env.leasePath);
    return rejects(env.tidal._get(ME(env), {}), 'offline');
}));

test('429 is rate-limited with TIDAL\'s wait, and nothing is sent until the wait is over', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.fault({ path: '/api/v1/' + ME(env), status: 429, headers: { 'Retry-After': '30' }, body: '' });
    return rejects(env.tidal._get(ME(env), {}), 'rate-limited').then((e) => {
        assert.strictEqual(e.retryAfter, 30);
        assert.strictEqual(e.status, 429);
        env.clock.t += 10 * 1000;
        return rejects(env.tidal._get('pages/my_collection_my_mixes', {}), 'rate-limited');
    }).then((e) => {
        assert.strictEqual(e.retryAfter, 20);
        assert.strictEqual(apiCalls(env, 'pages/my_collection_my_mixes').length, 0, 'held back');
        env.clock.t += 20 * 1000;
        return env.tidal._get(ME(env), {});
    }).then(() => assert.strictEqual(apiCalls(env, ME(env)).length, 2));
}));

test('429 without Retry-After waits 60 s; TIDAL\'s abuse 403 waits 30 minutes', () => withEnv({ loggedIn: true }, (env) => {
    env.fake.fault({ path: '/api/v1/' + ME(env), status: 429, body: '' });
    return rejects(env.tidal._get(ME(env), {}), 'rate-limited').then((e) => {
        assert.strictEqual(e.retryAfter, 60);
        env.clock.t += 60 * 1000;
        env.fake.fault({ path: '/api/v1/' + ME(env), status: 403, body: { status: 403, subStatus: 0, userMessage: 'Abuse detected' } });
        return rejects(env.tidal._get(ME(env), {}), 'rate-limited');
    }).then((e) => assert.strictEqual(e.retryAfter, 1800));
}));

/* ---------- logout ---------- */

test('logout deletes the session file and the cover cache', () => withEnv({ loggedIn: true }, (env) => {
    fs.mkdirSync(env.coverDir);
    fs.writeFileSync(path.join(env.coverDir, '24f52ab0-e7d6-414d-a650-20a4c686aa57.jpg'), 'x');
    return env.tidal.logout().then(() => {
        assert.strictEqual(env.tidal.loggedIn(), false);
        assert.ok(!fs.existsSync(env.sessionFile));
        assert.ok(!fs.existsSync(env.coverDir) || fs.readdirSync(env.coverDir).length === 0);
        return env.tidal.logout(); // twice is harmless
    }).then(() => rejects(env.tidal._get(ME(env), {}), 'not-logged-in'));
}));

test('logout stops a pending login', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => env.tidal.logout()).then(() => {
        env.fake.approve();
        env.clock.t += 5000;
        return env.tidal.loginPoll();
    }).then((r) => { assert.strictEqual(r.state, 'expired'); assert.strictEqual(env.tidal.loggedIn(), false); })));

run();
