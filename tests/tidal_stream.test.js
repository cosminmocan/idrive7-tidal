'use strict';
/**
 * A5: the stream address (tidal.streamUrl): tidalapi 0.9.0 media.py Track.get_url (tracks/<id>/urlpostpaywall),
 * LOSSLESS falling back to HIGH, the codec TIDAL granted, and rate limits.
 */
const assert = require('assert');
const fs = require('fs');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');

function withEnv(opts, fn) {
    return F.startTidal(Object.assign({ loggedIn: true }, opts)).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
function rejects(p, code) {
    return p.then((v) => { throw new Error('expected ' + code + ', got ' + JSON.stringify(v)); }, (e) => { assert.strictEqual(e.code, code, e.code + ': ' + e.message); return e; });
}
const asked = (env, id) => env.fake.requests('/api/v1/tracks/' + id + '/urlpostpaywall').map((e) => e.query.audioquality);
const REFUSED = { status: 401, body: { status: 401, subStatus: 4005, userMessage: 'Asset is not ready for playback' } };
const answer = (env, id, q, codec, ext) => ({ trackId: id, assetPresentation: 'FULL', audioMode: 'STEREO', audioQuality: q, codec: codec,
    streamingSessionId: 's', urls: [env.fake.fileUrl(id + '.' + ext)], securityType: null, securityToken: null });

test('LOSSLESS granted: tidalapi\'s parameters, FLAC', () => withEnv({}, (env) =>
    env.tidal.streamUrl(17927864, 'LOSSLESS').then((r) => {
        assert.deepStrictEqual(r, { url: env.fake.fileUrl('17927864.flac'), codec: 'flac', quality: 'LOSSLESS' });
        const c = env.fake.requests('/api/v1/tracks/17927864/urlpostpaywall');
        assert.strictEqual(c.length, 1);
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', urlusagemode: 'STREAM', audioquality: 'LOSSLESS', assetpresentation: 'FULL' });
    })));

test('LOSSLESS refused, HIGH granted: AAC, and the quality says HIGH', () => withEnv({}, (env) => {
    env.fake.streams[17927864] = { LOSSLESS: REFUSED, HIGH: answer(env, 17927864, 'HIGH', 'AAC', 'm4a') };
    return env.tidal.streamUrl(17927864, 'LOSSLESS').then((r) => {
        assert.deepStrictEqual(r, { url: env.fake.fileUrl('17927864.m4a'), codec: 'aac', quality: 'HIGH' });
        assert.deepStrictEqual(asked(env, 17927864), ['LOSSLESS', 'HIGH']);
        assert.strictEqual(env.fake.counts.refresh, 0, 'an asset refusal is not a token problem');
    });
}));

test('LOSSLESS refused with 403 or 404 also falls back to HIGH', () => withEnv({}, (env) => {
    env.fake.streams[1] = { LOSSLESS: { status: 403, body: { status: 403, subStatus: 4032, userMessage: 'Not allowed' } }, HIGH: answer(env, 1, 'HIGH', 'AAC', 'm4a') };
    env.fake.streams[2] = { LOSSLESS: { status: 404, body: { status: 404, subStatus: 2001, userMessage: 'not found' } }, HIGH: answer(env, 2, 'HIGH', 'AAC', 'm4a') };
    return env.tidal.streamUrl(1, 'LOSSLESS').then((r) => {
        assert.strictEqual(r.quality, 'HIGH');
        return env.tidal.streamUrl(2, 'LOSSLESS');
    }).then((r) => assert.strictEqual(r.codec, 'aac'));
}));

test('asked for LOSSLESS, TIDAL grants HIGH in its answer: the granted one is reported', () => withEnv({}, (env) => {
    env.fake.streams[17927864] = { LOSSLESS: answer(env, 17927864, 'HIGH', 'AAC', 'm4a') };
    return env.tidal.streamUrl(17927864, 'LOSSLESS').then((r) => {
        assert.deepStrictEqual(r, { url: env.fake.fileUrl('17927864.m4a'), codec: 'aac', quality: 'HIGH' });
        assert.deepStrictEqual(asked(env, 17927864), ['LOSSLESS']);
    });
}));

test('both refused: not-available', () => withEnv({}, (env) => {
    env.fake.streams[17927864] = { LOSSLESS: REFUSED, HIGH: REFUSED };
    return rejects(env.tidal.streamUrl(17927864, 'LOSSLESS'), 'not-available').then(() => assert.deepStrictEqual(asked(env, 17927864), ['LOSSLESS', 'HIGH']));
}));

test('HIGH asked: only HIGH is tried', () => withEnv({}, (env) =>
    env.tidal.streamUrl(17927865, 'HIGH').then((r) => {
        assert.deepStrictEqual(r, { url: env.fake.fileUrl('17927865.m4a'), codec: 'aac', quality: 'HIGH' });
        env.fake.streams[17927866] = { LOSSLESS: answer(env, 17927866, 'LOSSLESS', 'FLAC', 'flac'), HIGH: REFUSED };
        return rejects(env.tidal.streamUrl(17927866, 'HIGH'), 'not-available');
    }).then(() => assert.deepStrictEqual(asked(env, 17927866), ['HIGH']))));

test('429 gives rate-limited with the wait TIDAL asks for, and no second try', () => withEnv({}, (env) => {
    env.fake.streams[17927864] = { LOSSLESS: { status: 429, headers: { 'Retry-After': '42' }, body: '' } };
    return rejects(env.tidal.streamUrl(17927864, 'LOSSLESS'), 'rate-limited').then((e) => {
        assert.strictEqual(e.retryAfter, 42);
        assert.deepStrictEqual(asked(env, 17927864), ['LOSSLESS']);
    });
}));

test('a 5xx is tidal-error (not a refusal: no fallback); no uplink is offline', () => withEnv({}, (env) => {
    env.fake.streams[17927864] = { LOSSLESS: { status: 500, body: 'oops' } };
    return rejects(env.tidal.streamUrl(17927864, 'LOSSLESS'), 'tidal-error').then(() => {
        assert.deepStrictEqual(asked(env, 17927864), ['LOSSLESS']);
        fs.unlinkSync(env.leasePath);
        return rejects(env.tidal.streamUrl(17927865, 'LOSSLESS'), 'offline');
    });
}));

test('an answer without an address, encrypted, or in a codec the player cannot read counts as refused', () => withEnv({}, (env) => {
    const high = answer(env, 0, 'HIGH', 'AAC', 'm4a');
    env.fake.streams[1] = { LOSSLESS: Object.assign(answer(env, 1, 'LOSSLESS', 'FLAC', 'flac'), { urls: [] }), HIGH: high };
    env.fake.streams[2] = { LOSSLESS: Object.assign(answer(env, 2, 'LOSSLESS', 'FLAC', 'flac'), { securityType: 'ENCRYPTED', securityToken: 'abc' }), HIGH: high };
    env.fake.streams[3] = { LOSSLESS: answer(env, 3, 'LOSSLESS', 'ALAC', 'm4a'), HIGH: high };
    env.fake.streams[4] = { LOSSLESS: answer(env, 4, 'LOSSLESS', 'FLAC', 'flac'), HIGH: answer(env, 4, 'LOW', 'AAC', 'm4a') };
    return Promise.all([1, 2, 3].map((id) => env.tidal.streamUrl(id, 'LOSSLESS'))).then((rs) => {
        rs.forEach((r) => assert.strictEqual(r.quality, 'HIGH'));
        return rejects(env.tidal.streamUrl(4, 'HIGH'), 'not-available');
    });
}));

test('codec names: FLAC, MQA and HI_RES are FLAC/LOSSLESS; AAC and mp4a are AAC', () => withEnv({}, (env) => {
    env.fake.streams[1] = { LOSSLESS: answer(env, 1, 'HI_RES_LOSSLESS', 'FLAC', 'flac') };
    env.fake.streams[2] = { LOSSLESS: answer(env, 2, 'LOSSLESS', 'MQA', 'flac') };
    env.fake.streams[3] = { HIGH: answer(env, 3, 'HIGH', 'mp4a.40.2', 'm4a') };
    env.fake.streams[4] = { LOSSLESS: Object.assign(answer(env, 4, 'LOSSLESS', 'FLAC', 'flac'), { codec: undefined }) };
    return Promise.all([env.tidal.streamUrl(1, 'LOSSLESS'), env.tidal.streamUrl(2, 'LOSSLESS'), env.tidal.streamUrl(3, 'HIGH'), env.tidal.streamUrl(4, 'LOSSLESS')]).then((rs) => {
        assert.deepStrictEqual(rs.map((r) => [r.codec, r.quality]), [['flac', 'LOSSLESS'], ['flac', 'LOSSLESS'], ['aac', 'HIGH'], ['flac', 'LOSSLESS']]);
    });
}));

test('bad arguments are bad-request and send nothing; not logged in is not-logged-in', () => withEnv({}, (env) =>
    Promise.all([
        rejects(env.tidal.streamUrl('17927864', 'LOSSLESS'), 'bad-request'), rejects(env.tidal.streamUrl(0, 'LOSSLESS'), 'bad-request'),
        rejects(env.tidal.streamUrl(1, 'LOW'), 'bad-request'), rejects(env.tidal.streamUrl(1), 'bad-request'),
    ]).then(() => {
        assert.strictEqual(env.fake.log.length, 0);
        return env.tidal.logout();
    }).then(() => rejects(env.tidal.streamUrl(1, 'LOSSLESS'), 'not-logged-in'))));

test('the address works: netx downloads the track\'s bytes from it', () => withEnv({}, (env) => {
    env.fake.files['17927864.flac'] = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(5000, 1)]);
    return env.tidal.streamUrl(17927864, 'LOSSLESS').then((r) => env.netx.openStream({ url: r.url, timeoutMs: 3000 })).then((s) => new Promise((resolve, reject) => {
        assert.strictEqual(s.status, 200);
        const chunks = [];
        s.stream.on('data', (d) => chunks.push(d));
        s.stream.on('error', reject);
        s.stream.on('end', () => resolve(Buffer.concat(chunks)));
    })).then((buf) => { assert.strictEqual(buf.length, 5004); assert.strictEqual(buf.slice(0, 4).toString(), 'fLaC'); });
}));

run();
