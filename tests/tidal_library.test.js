'use strict';
/**
 * A4: the library (favourites, playlists, albums, mixes, search) against the fake TIDAL and its catalogue
 * tests/fixtures/tidal/library.json. Each call's address and parameters are those tidalapi 0.9.0 uses; the items
 * are the objects of docs/PROTOCOL.md, checked with the contract's validator.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');
const P = require('./fakes/protocol');

function withEnv(opts, fn) {
    return F.startTidal(Object.assign({ loggedIn: true }, opts)).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
function rejects(p, code) {
    return p.then((v) => { throw new Error('expected ' + code + ', got ' + JSON.stringify(v)); }, (e) => { assert.strictEqual(e.code, code, e.code + ': ' + e.message); return e; });
}
/** the answer the service would send must follow the contract */
function valid(cmd, r) {
    assert.deepStrictEqual(P.validateAnswer(cmd, Object.assign({ id: 1, ok: true }, r)), []);
    return r;
}
const calls = (env, p) => env.fake.requests('/api/v1/' + p);
const UID = 192837465;
const COVER = '24f52ab0-e7d6-414d-a650-20a4c686aa57';
const ONE_MORE_TIME = { id: 17927864, title: 'One More Time', artists: ['Daft Punk'], album: { id: 17927863, title: 'Discovery' },
    coverId: COVER, duration: 320, streamReady: true, explicit: false };

test('the fixtures hold no account name, email or token', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'tidal', 'library.json'), 'utf8');
    assert.ok(!/@[a-z0-9-]+\.[a-z]/i.test(text), 'no email');
    assert.ok(!/"(username|email|firstName|lastName|accessToken|refreshToken|access_token|refresh_token)"/.test(text), 'no account fields');
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text), 'no JWT');
});

/* ---------- favourites ---------- */

test('favorites tracks: address, parameters, and the contract\'s track objects, newest first', () => withEnv({}, (env) =>
    env.tidal.favorites('tracks', 0, 50).then((r) => {
        valid('favorites', r);
        const c = calls(env, 'users/' + UID + '/favorites/tracks');
        assert.strictEqual(c.length, 1);
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50', order: 'DATE', orderDirection: 'DESC' });
        assert.strictEqual(r.total, 7);
        assert.deepStrictEqual(r.items.map((t) => t.id), [77777703, 17927864, 17927865, 58990486, 77777701, 77777702, 17927866]);
        assert.deepStrictEqual(r.items[1], ONE_MORE_TIME);
        assert.deepStrictEqual(r.items[0], { id: 77777703, title: 'Recently added', artists: ['Solo'], album: { id: 77777700, title: 'Singles' },
            coverId: null, duration: 199, streamReady: true, explicit: false });
    })));

test('a track: version in the title, every artist, duration in whole seconds', () => withEnv({}, (env) =>
    env.tidal.favorites('tracks', 0, 50).then((r) => {
        const digital = r.items.filter((t) => t.id === 17927866)[0];
        assert.strictEqual(digital.title, 'Digital Love (Remastered)');
        assert.deepStrictEqual(digital.artists, ['Daft Punk', 'Guest']);
        const live = r.items.filter((t) => t.id === 58990486)[0];
        assert.strictEqual(live.duration, 345);
    })));

test('a track that cannot be streamed is marked, not dropped', () => withEnv({}, (env) =>
    env.tidal.favorites('tracks', 0, 50).then((r) => {
        const live = r.items.filter((t) => t.id === 58990486)[0];
        assert.ok(live, 'kept');
        assert.strictEqual(live.streamReady, false);
        assert.strictEqual(live.explicit, true);
        assert.strictEqual(live.coverId, 'a8c3e0f2-9c1e-4b8a-8f0e-2d7c1b6e5a40');
    })));

test('an item with missing fields does not break the list', () => withEnv({}, (env) => {
    env.fake.data.favoriteTracksItems = [env.fake.data.tracks[0]].concat(env.fake.data.brokenItems, [{ id: 'x' }, { id: -3 }, env.fake.data.tracks[1]]);
    return env.tidal.favorites('tracks', 0, 50).then((r) => {
        valid('favorites', r);
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927864, 17927865]);
        return env.tidal.favorites('tracks', 0, 50);
    }).then(() => {
        delete env.fake.data.favoriteTracksItems;
        return env.tidal.favorites('tracks', 0, 50);
    }).then((r) => {
        const bare = r.items.filter((t) => t.id === 77777701)[0];
        assert.deepStrictEqual(bare, { id: 77777701, title: 'Untitled', artists: [], album: null, coverId: null, duration: 180, streamReady: true, explicit: false });
        const solo = r.items.filter((t) => t.id === 77777702)[0];
        assert.deepStrictEqual(solo.artists, ['Solo']);
        assert.strictEqual(solo.album, null);
        assert.strictEqual(solo.explicit, false);
    });
}));

test('favorites albums: address and the contract\'s album objects', () => withEnv({}, (env) =>
    env.tidal.favorites('albums', 0, 20).then((r) => {
        valid('favorites', r);
        const c = calls(env, 'users/' + UID + '/favorites/albums');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '20', order: 'DATE', orderDirection: 'DESC' });
        assert.strictEqual(r.total, 3);
        assert.deepStrictEqual(r.items[0], { id: 17927863, title: 'Discovery', artists: ['Daft Punk'], coverId: COVER, numberOfTracks: 14 });
        assert.deepStrictEqual(r.items[2], { id: 77777700, title: 'Singles', artists: [], coverId: null, numberOfTracks: 0 });
    })));

test('bad arguments are bad-request and send nothing', () => withEnv({}, (env) => {
    const t = env.tidal;
    return Promise.all([
        rejects(t.favorites('artists', 0, 10), 'bad-request'), rejects(t.favorites('tracks', -1, 10), 'bad-request'),
        rejects(t.favorites('tracks', 0, 0), 'bad-request'), rejects(t.favorites('tracks', 0, 101), 'bad-request'),
        rejects(t.favorites('tracks', 1.5, 10), 'bad-request'), rejects(t.playlist('../../users/1', 0, 10), 'bad-request'),
        rejects(t.album('17927863', 0, 10), 'bad-request'), rejects(t.album(0, 0, 10), 'bad-request'),
        rejects(t.mix('a/b'), 'bad-request'), rejects(t.search('', 0, 10), 'bad-request'),
        rejects(t.search(new Array(202).join('x'), 0, 10), 'bad-request'), rejects(t.search(5, 0, 10), 'bad-request'),
    ]).then(() => assert.strictEqual(env.fake.log.length, 0));
}));

test('offset and limit have defaults (0 and 50)', () => withEnv({}, (env) =>
    env.tidal.favorites('tracks').then(() => {
        const q = calls(env, 'users/' + UID + '/favorites/tracks')[0].query;
        assert.strictEqual(q.offset, '0');
        assert.strictEqual(q.limit, '50');
    })));

test('not logged in: not-logged-in', () => withEnv({ loggedIn: false }, (env) => rejects(env.tidal.favorites('tracks', 0, 10), 'not-logged-in')));

/* ---------- paging ---------- */

test('paging across three pages: one list from three requests', () => withEnv({ tidal: { pageSize: 2 } }, (env) =>
    env.tidal.favorites('tracks', 0, 6).then((r) => {
        const c = calls(env, 'users/' + UID + '/favorites/tracks');
        assert.deepStrictEqual(c.map((x) => [x.query.offset, x.query.limit]), [['0', '2'], ['2', '2'], ['4', '2']]);
        assert.deepStrictEqual(r.items.map((t) => t.id), [77777703, 17927864, 17927865, 58990486, 77777701, 77777702]);
        assert.strictEqual(r.total, 7);
    })));

test('paging stops at the end of the list', () => withEnv({ tidal: { pageSize: 2 } }, (env) =>
    env.tidal.favorites('tracks', 4, 10).then((r) => {
        const c = calls(env, 'users/' + UID + '/favorites/tracks');
        assert.deepStrictEqual(c.map((x) => x.query.offset), ['4', '6']);
        assert.deepStrictEqual(r.items.map((t) => t.id), [77777701, 77777702, 17927866]);
    })));

test('paging goes on when TIDAL gives smaller pages than asked', () => withEnv({ fake: { pageMax: 3 } }, (env) =>
    env.tidal.favorites('tracks', 0, 7).then((r) => {
        assert.deepStrictEqual(calls(env, 'users/' + UID + '/favorites/tracks').map((x) => x.query.offset), ['0', '3', '6']);
        assert.strictEqual(r.items.length, 7);
    })));

test('paging stops at a cap of pages even if TIDAL keeps answering one item at a time', () => withEnv({ fake: { pageMax: 1 } }, (env) => {
    const many = [];
    for (let i = 0; i < 40; i++) many.push(Object.assign({}, env.fake.data.tracks[0], { id: 1000 + i }));
    env.fake.data.favoriteTracksItems = many;
    return env.tidal.favorites('tracks', 0, 40).then((r) => {
        const n = calls(env, 'users/' + UID + '/favorites/tracks').length;
        assert.ok(n <= 10, n + ' requests');
        assert.strictEqual(r.items.length, n);
    });
}));

test('an error on a later page fails the call', () => withEnv({ tidal: { pageSize: 2 } }, (env) => {
    env.fake.fault({ path: '/api/v1/users/' + UID + '/favorites/tracks', status: 500, body: 'x' });
    return rejects(env.tidal.favorites('tracks', 0, 6), 'tidal-error');
}));

/* ---------- playlists ---------- */

test('playlists: the user\'s own and favourite ones, as contract playlist objects', () => withEnv({}, (env) =>
    env.tidal.playlists(0, 50).then((r) => {
        valid('playlists', r);
        const c = calls(env, 'users/' + UID + '/playlistsAndFavoritePlaylists');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50' });
        assert.strictEqual(r.total, 2);
        assert.deepStrictEqual(r.items, [
            { uuid: '36ea71a8-445e-41a4-82ab-6628c581535d', title: 'Road trip', numberOfTracks: 3, coverId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' },
            { uuid: '4b1c2d3e-0f9a-4b8c-9d7e-6f5a4b3c2d1e', title: 'Favourited editorial', numberOfTracks: 50, coverId: null },
        ]);
    })));

test('playlists asks TIDAL for at most 50 at a time (its limit for this list)', () => withEnv({}, (env) =>
    env.tidal.playlists(0, 100).then(() => {
        const c = calls(env, 'users/' + UID + '/playlistsAndFavoritePlaylists');
        assert.ok(c.every((x) => Number(x.query.limit) <= 50), JSON.stringify(c.map((x) => x.query)));
    })));

test('playlist: its tracks; an unknown one is not-found', () => withEnv({}, (env) =>
    env.tidal.playlist('36ea71a8-445e-41a4-82ab-6628c581535d', 0, 50).then((r) => {
        valid('playlist', r);
        const c = calls(env, 'playlists/36ea71a8-445e-41a4-82ab-6628c581535d/tracks');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50' });
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927864, 17927865, 58990486]);
        assert.deepStrictEqual(r.items[0], ONE_MORE_TIME);
        assert.strictEqual(r.total, 3);
        return rejects(env.tidal.playlist('00000000-0000-0000-0000-000000000000', 0, 50), 'not-found');
    })));

/* ---------- albums ---------- */

test('album: its tracks; an unknown one is not-found', () => withEnv({}, (env) =>
    env.tidal.album(17927863, 0, 50).then((r) => {
        valid('album', r);
        const c = calls(env, 'albums/17927863/tracks');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50' });
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927864, 17927865, 17927866]);
        assert.strictEqual(r.total, 3);
        return rejects(env.tidal.album(1, 0, 50), 'not-found');
    })));

/* ---------- mixes ---------- */

test('mixes: the "My Mixes" page, as contract mix objects', () => withEnv({}, (env) =>
    env.tidal.mixes().then((r) => {
        valid('mixes', r);
        const c = calls(env, 'pages/my_collection_my_mixes');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', deviceType: 'BROWSER' });
        assert.deepStrictEqual(r.items, [
            { id: '0123456789abcdef0123456789abcd', title: 'My Mix 1', subTitle: 'Daft Punk, Justice', coverId: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e' },
            { id: '00fedcba9876543210fedcba987654', title: 'Daily Discovery', coverId: null },
        ]);
    })));

test('mix: its tracks from the mix page; an unknown mix is not-found', () => withEnv({}, (env) =>
    env.tidal.mix('0123456789abcdef0123456789abcd').then((r) => {
        valid('mix', r);
        const c = calls(env, 'pages/mix');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', mixId: '0123456789abcdef0123456789abcd', deviceType: 'BROWSER' });
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927864, 58990486, 77777702]);
        return rejects(env.tidal.mix('ffffffffffffffffffffffffffffff'), 'not-found');
    })));

test('a page with an unexpected shape is an empty list or not-found, never a crash', () => withEnv({}, (env) => {
    env.fake.fault({ path: '/api/v1/pages/my_collection_my_mixes', status: 200, body: { rows: [{ modules: [{ type: 'MIX_LIST' }] }, { nope: 1 }, null] } });
    return env.tidal.mixes().then((r) => {
        assert.deepStrictEqual(r.items, []);
        env.fake.fault({ path: '/api/v1/pages/mix', status: 200, body: { rows: 'x' } });
        return rejects(env.tidal.mix('0123456789abcdef0123456789abcd'), 'not-found');
    });
}));

/* ---------- search ---------- */

test('search: tracks only, with tidalapi\'s parameters', () => withEnv({}, (env) =>
    env.tidal.search('daft punk', 0, 3).then((r) => {
        valid('search', r);
        const c = calls(env, 'search');
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', query: 'daft punk', types: 'TRACKS', offset: '0', limit: '3' });
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927864, 17927865, 17927866]);
        assert.strictEqual(r.total, 4);
    })));

test('search pages too', () => withEnv({ tidal: { pageSize: 2 } }, (env) =>
    env.tidal.search('daft punk', 1, 3).then((r) => {
        assert.deepStrictEqual(calls(env, 'search').map((x) => [x.query.offset, x.query.limit]), [['1', '2'], ['3', '1']]);
        assert.deepStrictEqual(r.items.map((t) => t.id), [17927865, 17927866, 58990486]);
    })));

run();
