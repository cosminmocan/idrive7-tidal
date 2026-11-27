'use strict';
/**
 * A2: TIDAL's device login (tidal.loginStart / loginPoll), against the fake TIDAL (tests/fakes/fake_tidal.js).
 * The form fields must be the ones python tidalapi 0.9.0 sends (session.py get_link_login, _check_link_login).
 */
const assert = require('assert');
const fs = require('fs');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');
const P = require('./fakes/protocol');

function withEnv(opts, fn) {
    return F.startTidal(opts).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
const tokenPolls = (env) => env.fake.requests('/auth/v1/oauth2/token').filter((e) => e.form && e.form.grant_type !== 'refresh_token');

test('loginStart asks for a device code with tidalapi\'s exact form, and gives an https:// link', () => withEnv({}, (env) =>
    env.tidal.loginStart().then((r) => {
        assert.strictEqual(r.url, 'https://link.tidal.com/' + env.fake.login.userCode);
        assert.ok(/^https:\/\//.test(r.url));
        assert.strictEqual(r.userCode, env.fake.login.userCode);
        assert.strictEqual(r.expiresIn, 300);
        assert.strictEqual(r.interval, 2);
        const calls = env.fake.requests('/auth/v1/oauth2/device_authorization');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].method, 'POST');
        assert.ok(/application\/x-www-form-urlencoded/.test(calls[0].headers['content-type']));
        assert.deepStrictEqual(calls[0].form, { client_id: F.CLIENT_ID, scope: 'r_usr w_usr w_sub' });
        assert.strictEqual(env.tidal.loggedIn(), false);
    })));

test('a link TIDAL already gives with https:// is not doubled', () => withEnv({}, (env) => {
    env.fake.fault({ path: '/auth/v1/oauth2/device_authorization', status: 200,
        body: { deviceCode: 'd1', userCode: 'WXYZQ', verificationUri: 'https://link.tidal.com', verificationUriComplete: 'https://link.tidal.com/WXYZQ', expiresIn: 600, interval: 5 } });
    return env.tidal.loginStart().then((r) => {
        assert.strictEqual(r.url, 'https://link.tidal.com/WXYZQ');
        assert.strictEqual(r.expiresIn, 600);
        assert.strictEqual(r.interval, 5);
    });
}));

test('pending: the poll sends tidalapi\'s exact form fields', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => {
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'pending' });
        const polls = tokenPolls(env);
        assert.strictEqual(polls.length, 1);
        assert.strictEqual(polls[0].method, 'POST');
        assert.deepStrictEqual(polls[0].form, {
            client_id: F.CLIENT_ID, client_secret: F.CLIENT_SECRET, device_code: env.fake.login.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code', scope: 'r_usr w_usr w_sub',
        });
    })));

test('the interval is kept: polls before it has passed do not reach TIDAL', () => withEnv({}, (env) =>
    env.tidal.loginStart()
        .then(() => env.tidal.loginPoll())
        .then((r) => { assert.strictEqual(r.state, 'pending'); assert.strictEqual(tokenPolls(env).length, 0, 'no poll at once'); env.clock.t += 1999; return env.tidal.loginPoll(); })
        .then((r) => { assert.strictEqual(r.state, 'pending'); assert.strictEqual(tokenPolls(env).length, 0); env.clock.t += 1; return env.tidal.loginPoll(); })
        .then(() => { assert.strictEqual(tokenPolls(env).length, 1); return Promise.all([env.tidal.loginPoll(), env.tidal.loginPoll()]); })
        .then((rs) => { assert.deepStrictEqual(rs.map((r) => r.state), ['pending', 'pending']); assert.strictEqual(tokenPolls(env).length, 1); env.clock.t += 2000; return env.tidal.loginPoll(); })
        .then(() => assert.strictEqual(tokenPolls(env).length, 2))));

test('two polls at the same moment make one request', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => { env.clock.t += 2000; return Promise.all([env.tidal.loginPoll(), env.tidal.loginPoll(), env.tidal.loginPoll()]); })
        .then((rs) => { rs.forEach((r) => assert.strictEqual(r.state, 'pending')); assert.strictEqual(tokenPolls(env).length, 1); })));

test('authorized: the session is saved (contract shape, 0600) with the user and country from GET sessions', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => {
        env.fake.approve();
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'authorized' });
        assert.strictEqual(env.tidal.loggedIn(), true);
        const s = JSON.parse(fs.readFileSync(env.sessionFile, 'utf8'));
        assert.deepStrictEqual(P.validateState('session', s), []);
        assert.strictEqual(s.userId, env.fake.data.userId);
        assert.strictEqual(s.countryCode, 'RO');
        assert.strictEqual(s.tokenType, 'Bearer');
        assert.strictEqual(s.expiresAt, env.clock.t + 604800 * 1000);
        assert.ok(/^fake-access-/.test(s.accessToken) && /^fake-refresh-/.test(s.refreshToken));
        assert.strictEqual(fs.statSync(env.sessionFile).mode & 511, 384, 'mode 0600');
        const sessions = env.fake.requests('/api/v1/sessions');
        assert.strictEqual(sessions.length, 1);
        assert.strictEqual(sessions[0].headers.authorization, 'Bearer ' + s.accessToken);
        // and the login is over: another poll does not ask TIDAL again
        env.clock.t += 10000;
        return env.tidal.loginPoll();
    }).then((r) => { assert.strictEqual(r.state, 'authorized'); assert.strictEqual(tokenPolls(env).length, 1); })));

test('expired: TIDAL says the code expired', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => { env.fake.expireLogin(); env.clock.t += 2000; return env.tidal.loginPoll(); })
        .then((r) => { assert.deepStrictEqual(r, { state: 'expired' }); assert.strictEqual(env.tidal.loggedIn(), false); })));

test('expired: past expiresIn, without asking TIDAL', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => { env.clock.t += 300 * 1000; return env.tidal.loginPoll(); })
        .then((r) => { assert.deepStrictEqual(r, { state: 'expired' }); assert.strictEqual(tokenPolls(env).length, 0); })));

test('denied: the user refused on the phone', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => { env.fake.deny(); env.clock.t += 2000; return env.tidal.loginPoll(); })
        .then((r) => { assert.deepStrictEqual(r, { state: 'denied' }); assert.strictEqual(env.tidal.loggedIn(), false); })));

test('a network error, a 5xx or no uplink during a poll is pending, not a failure', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => {
        env.fake.approve();
        // dropped connections (netx retries a dropped kept-alive connection once, so drop a few)
        env.fake.fault({ path: '/auth/v1/oauth2/token', drop: true, times: 5 });
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'pending' });
        env.fake.faults = [];
        env.fake.fault({ path: '/auth/v1/oauth2/token', status: 503, body: 'busy' });
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'pending' });
        fs.unlinkSync(env.leasePath);
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'pending' });
        F.writeLease(env.dir);
        // the token came, but GET sessions failed: still pending, and the next poll finishes the login
        env.fake.fault({ path: '/api/v1/sessions', drop: true, times: 5 });
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.deepStrictEqual(r, { state: 'pending' });
        env.fake.faults = [];
        assert.strictEqual(env.tidal.loggedIn(), false);
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => { assert.deepStrictEqual(r, { state: 'authorized' }); assert.strictEqual(env.tidal.loggedIn(), true); })));

test('slow_down makes the interval 5 s longer', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => {
        env.fake.fault({ path: '/auth/v1/oauth2/token', status: 400, body: { status: 400, error: 'slow_down', error_description: 'slow down' } });
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.strictEqual(r.state, 'pending');
        env.clock.t += 6999;
        return env.tidal.loginPoll();
    }).then(() => {
        assert.strictEqual(tokenPolls(env).length, 1);
        env.clock.t += 1;
        return env.tidal.loginPoll();
    }).then(() => assert.strictEqual(tokenPolls(env).length, 2))));

test('loginStart with no uplink is offline; a TIDAL failure is tidal-error; 429 is rate-limited', () => withEnv({}, (env) => {
    fs.unlinkSync(env.leasePath);
    return env.tidal.loginStart().then(() => { throw new Error('should fail'); }, (e) => {
        assert.strictEqual(e.code, 'offline');
        F.writeLease(env.dir);
        env.fake.fault({ path: '/auth/v1/oauth2/device_authorization', status: 500, body: 'oops' });
        return env.tidal.loginStart();
    }).then(() => { throw new Error('should fail'); }, (e) => {
        assert.strictEqual(e.code, 'tidal-error');
        assert.strictEqual(e.status, 500);
        env.fake.fault({ path: '/auth/v1/oauth2/device_authorization', status: 429, headers: { 'Retry-After': '17' }, body: '' });
        return env.tidal.loginStart();
    }).then(() => { throw new Error('should fail'); }, (e) => {
        assert.strictEqual(e.code, 'rate-limited');
        assert.strictEqual(e.retryAfter, 17);
    });
}));

test('a poll with no login started says expired and asks nobody', () => withEnv({}, (env) =>
    env.tidal.loginPoll().then((r) => { assert.deepStrictEqual(r, { state: 'expired' }); assert.strictEqual(env.fake.log.length, 0); })));

test('a second loginStart replaces the first code', () => withEnv({}, (env) => {
    let first;
    return env.tidal.loginStart().then((r) => { first = r; return env.tidal.loginStart(); }).then((r) => {
        assert.notStrictEqual(r.userCode, first.userCode);
        env.fake.approve();
        env.clock.t += 2000;
        return env.tidal.loginPoll();
    }).then((r) => {
        assert.strictEqual(r.state, 'authorized');
        assert.strictEqual(tokenPolls(env)[0].form.device_code, env.fake.login.deviceCode);
    });
}));

test('loginCancel stops a pending login: the next poll says expired and asks nobody, even once approved', () => withEnv({}, (env) =>
    env.tidal.loginStart().then(() => {
        const before = env.fake.log.length;
        env.tidal.loginCancel();
        env.fake.approve();
        env.clock.t += 2000;
        return env.tidal.loginPoll().then((r) => {
            assert.deepStrictEqual(r, { state: 'expired' });
            assert.strictEqual(env.fake.log.length, before, 'no request after the cancel');
            assert.strictEqual(env.tidal.loggedIn(), false);
        });
    })));

test('loginCancel with no login pending does nothing', () => withEnv({}, (env) => {
    env.tidal.loginCancel();
    assert.strictEqual(env.fake.log.length, 0);
    assert.strictEqual(env.tidal.loggedIn(), false);
}));

run();
