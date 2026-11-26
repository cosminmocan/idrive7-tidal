'use strict';
/**
 * A6: cover art (tidal.cover): resources.tidal.com/images/<id with / for ->/320x320.jpg, at most 128 KiB,
 * cached in coverDir as <coverId>.jpg within a total size limit, oldest (least recently used) removed first.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');

const COVER = '24f52ab0-e7d6-414d-a650-20a4c686aa57';
const id = (n) => 'aaaaaaaa-bbbb-cccc-dddd-' + ('000000000000' + n).slice(-12);

function withEnv(opts, fn) {
    return F.startTidal(Object.assign({ loggedIn: true }, opts)).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
function rejects(p, code) {
    return p.then((v) => { throw new Error('expected ' + code + ', got ' + (Buffer.isBuffer(v) ? v.length + ' bytes' : JSON.stringify(v))); }, (e) => { assert.strictEqual(e.code, code, e.code + ': ' + e.message); return e; });
}
const imageCalls = (env) => env.fake.log.filter((e) => /^\/images\//.test(e.path));
const cached = (env) => { try { return fs.readdirSync(env.coverDir).filter((f) => /\.jpg$/.test(f)).sort(); } catch (e) { return []; } };
const dirBytes = (env) => cached(env).reduce((n, f) => n + fs.statSync(path.join(env.coverDir, f)).size, 0);

test('the address is built from the cover id, 320x320; the JPEG is returned and kept', () => withEnv({}, (env) =>
    env.tidal.cover(COVER).then((buf) => {
        const c = imageCalls(env);
        assert.strictEqual(c.length, 1);
        assert.strictEqual(c[0].path, '/images/24f52ab0/e7d6/414d/a650/20a4c686aa57/320x320.jpg');
        assert.strictEqual(c[0].method, 'GET');
        assert.ok(Buffer.isBuffer(buf));
        assert.strictEqual(buf[0], 0xff);
        assert.strictEqual(buf[1], 0xd8);
        assert.deepStrictEqual(cached(env), [COVER + '.jpg']);
        assert.ok(fs.readFileSync(path.join(env.coverDir, COVER + '.jpg')).equals(buf));
    })));

test('a cached cover is served with no request, even offline', () => withEnv({}, (env) =>
    env.tidal.cover(COVER).then((first) => {
        fs.unlinkSync(env.leasePath);
        return env.tidal.cover(COVER).then((again) => {
            assert.ok(again.equals(first));
            assert.strictEqual(imageCalls(env).length, 1);
        });
    })));

test('a cover needs no login (the images are public)', () => withEnv({ loggedIn: false }, (env) =>
    env.tidal.cover(COVER).then((buf) => assert.ok(buf.length > 0))));

test('an oversized answer is refused and not kept; 128 KiB exactly is fine', () => withEnv({}, (env) => {
    env.fake.covers[id(1)] = F.jpeg(id(1), 128 * 1024 + 1);
    env.fake.covers[id(2)] = F.jpeg(id(2), 128 * 1024);
    return rejects(env.tidal.cover(id(1)), 'tidal-error').then(() => {
        assert.deepStrictEqual(cached(env), []);
        return env.tidal.cover(id(2));
    }).then((buf) => { assert.strictEqual(buf.length, 128 * 1024); assert.deepStrictEqual(cached(env), [id(2) + '.jpg']); });
}));

test('an answer that is not a JPEG is refused', () => withEnv({}, (env) => {
    env.fake.covers[id(3)] = Buffer.from('<html>login page</html>');
    return rejects(env.tidal.cover(id(3)), 'tidal-error').then(() => assert.deepStrictEqual(cached(env), []));
}));

test('an unknown cover is not-found; 429 is rate-limited; no uplink is offline', () => withEnv({}, (env) =>
    rejects(env.tidal.cover(id(4)), 'not-found').then(() => {
        env.fake.fault({ path: /^\/images\//, status: 429, headers: { 'Retry-After': '9' }, body: '' });
        return rejects(env.tidal.cover(COVER), 'rate-limited');
    }).then((e) => {
        assert.strictEqual(e.retryAfter, 9);
        fs.unlinkSync(env.leasePath);
        return rejects(env.tidal.cover(COVER), 'offline');
    })));

test('a bad cover id is bad-request and sends nothing', () => withEnv({}, (env) =>
    Promise.all(['../../etc/passwd', '', 'x', '24f52ab0/e7d6', COVER + '.jpg', 5, null].map((c) => rejects(env.tidal.cover(c), 'bad-request')))
        .then(() => assert.strictEqual(env.fake.log.length, 0))));

test('the cache never exceeds its limit; the least recently used go first', () => withEnv({ tidal: { coverCacheBytes: 10000 } }, (env) => {
    for (let i = 1; i <= 6; i++) env.fake.covers[id(i)] = F.jpeg(id(i), 3000);
    let chain = Promise.resolve();
    [1, 2, 3].forEach((i) => { chain = chain.then(() => { env.clock.t += 1000; return env.tidal.cover(id(i)); }); });
    return chain.then(() => {
        assert.deepStrictEqual(cached(env), [id(1), id(2), id(3)].map((x) => x + '.jpg'));
        env.clock.t += 1000;
        return env.tidal.cover(id(1)); // used again: now the newest
    }).then(() => {
        env.clock.t += 1000;
        return env.tidal.cover(id(4));
    }).then(() => {
        assert.ok(dirBytes(env) <= 10000, dirBytes(env) + ' bytes');
        assert.deepStrictEqual(cached(env), [id(1), id(3), id(4)].map((x) => x + '.jpg'), 'cover 2 was the oldest');
        env.clock.t += 1000;
        return env.tidal.cover(id(5));
    }).then(() => {
        env.clock.t += 1000;
        return env.tidal.cover(id(6));
    }).then(() => {
        assert.ok(dirBytes(env) <= 10000);
        assert.deepStrictEqual(cached(env), [id(4), id(5), id(6)].map((x) => x + '.jpg'));
        assert.strictEqual(imageCalls(env).length, 6, 'the second cover 1 came from the cache');
    });
}));

test('files left by an earlier run count toward the limit', () => withEnv({ tidal: { coverCacheBytes: 10000 } }, (env) => {
    fs.mkdirSync(env.coverDir);
    for (let i = 10; i < 14; i++) {
        const f = path.join(env.coverDir, id(i) + '.jpg');
        fs.writeFileSync(f, F.jpeg(id(i), 3000));
        fs.utimesSync(f, (env.clock.t - 100000 + i * 1000) / 1000, (env.clock.t - 100000 + i * 1000) / 1000);
    }
    return env.tidal.cover(COVER).then(() => {
        assert.ok(dirBytes(env) <= 10000, dirBytes(env) + ' bytes');
        assert.ok(cached(env).indexOf(COVER + '.jpg') >= 0);
        assert.ok(cached(env).indexOf(id(10) + '.jpg') < 0, 'the oldest went first');
    });
}));

test('a damaged cached file is fetched again', () => withEnv({}, (env) => {
    fs.mkdirSync(env.coverDir);
    fs.writeFileSync(path.join(env.coverDir, COVER + '.jpg'), '');
    return env.tidal.cover(COVER).then((buf) => {
        assert.ok(buf.length > 0);
        assert.strictEqual(imageCalls(env).length, 1);
        assert.ok(fs.readFileSync(path.join(env.coverDir, COVER + '.jpg')).equals(buf));
    });
}));

test('the same cover asked for twice at once makes one request', () => withEnv({}, (env) =>
    Promise.all([env.tidal.cover(COVER), env.tidal.cover(COVER)]).then((rs) => {
        assert.ok(rs[0].equals(rs[1]));
        assert.strictEqual(imageCalls(env).length, 1);
    })));

test('the default limits are 128 KiB a cover and 20 MiB in all', () => {
    const covers = require('../native/cmocan-tidal/lib/tidal/covers');
    assert.strictEqual(covers.MAX_COVER_BYTES, 128 * 1024);
    assert.strictEqual(covers.CACHE_BYTES, 20 * 1024 * 1024);
});

run();
