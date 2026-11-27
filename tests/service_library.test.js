'use strict';
/**
 * C4: the library commands, their cache and the offline case. Each list is what (fake) TIDAL holds; a second call
 * inside the cache time asks TIDAL nothing; with no uplink lease the last list comes back marked stale, or
 * offline when there is none; status.online follows the lease file.
 */
const assert = require('assert');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService } = require('./fakes/service_harness');
const { track } = require('./fakes/fake_tidal_module');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

const SESSION = JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: 'a', refreshToken: 'r', expiresAt: 1795000000000, userId: 1, countryCode: 'RO' });
const ALBUM = { id: 17927863, title: 'Discovery', artists: ['Daft Punk'], coverId: null, numberOfTracks: 14 };
const PL = '36ea71a8-445e-41a4-82ab-6628c581535d';
const MIX = '0123456789abcdef0123456789abcd';
function library() {
    const many = [];
    for (let i = 1; i <= 120; i++) many.push(track(1000 + i));
    return {
        favorites: { tracks: many, albums: [ALBUM] },
        playlists: [{ uuid: PL, title: 'Road trip', numberOfTracks: 2, coverId: null }],
        playlist: { [PL]: [track(1), track(2)] },
        album: { 17927863: [track(3)] },
        mixes: [{ id: MIX, title: 'My Mix 1', subTitle: 'Daft Punk', coverId: null }],
        mix: { [MIX]: [track(4), track(5)] },
        search: [track(6)],
    };
}
const loggedIn = (extra) => Object.assign({ files: { 'session.json': SESSION }, tidal: { library: library() } }, extra || {});
const count = (cfg, m) => cfg.calls.filter((c) => c.method === m).length;

test('each list command returns what TIDAL holds', async () => {
    const h = await startService(loggedIn());
    try {
        const reqs = [
            { cmd: 'favorites', kind: 'tracks', offset: 100, limit: 50 }, { cmd: 'favorites', kind: 'albums' }, { cmd: 'playlists' },
            { cmd: 'playlist', uuid: PL }, { cmd: 'album', albumId: 17927863 }, { cmd: 'mixes' }, { cmd: 'mix', mixId: MIX },
            { cmd: 'search', query: 'daft punk' },
        ].map((r, i) => Object.assign({ id: i + 1 }, r));
        const got = await h.ask(reqs);
        const by = {};
        got.forEach((a) => { by[a.id] = a; });
        reqs.forEach((r) => assert.deepStrictEqual(P.validateAnswer(r.cmd, by[r.id]), [], r.cmd + ': ' + JSON.stringify(by[r.id])));
        const lib = library();
        assert.deepStrictEqual(by[1].items, lib.favorites.tracks.slice(100, 150)); assert.strictEqual(by[1].total, 120);
        assert.deepStrictEqual(by[2].items, [ALBUM]);
        assert.deepStrictEqual(by[3].items, lib.playlists);
        assert.deepStrictEqual(by[4].items, lib.playlist[PL]);
        assert.deepStrictEqual(by[5].items, lib.album[17927863]);
        assert.deepStrictEqual(by[6].items, lib.mixes);
        assert.deepStrictEqual(by[7].items, lib.mix[MIX]);
        assert.deepStrictEqual(by[8].items, lib.search);
        reqs.forEach((r) => assert.ok(!by[r.id].stale, 'not stale'));
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'favorites')[0].args, ['tracks', 100, 50]);
        assert.deepStrictEqual(h.cfg.calls.filter((c) => c.method === 'search')[0].args, ['daft punk', 0, 50], 'default paging');
    } finally { await h.close(); }
});

test('a second call inside the cache time makes no request; after it, one', async () => {
    const h = await startService(loggedIn({ service: { cacheMs: 300 } }));
    try {
        await h.req({ cmd: 'playlists' });
        const a = await h.req({ cmd: 'playlists' });
        assert.strictEqual(count(h.cfg, 'playlists'), 1);
        assert.ok(!a.stale);
        await h.req({ cmd: 'playlists', offset: 0, limit: 10 });
        assert.strictEqual(count(h.cfg, 'playlists'), 2, 'another page is another list');
        await h.sleep(400);
        await h.req({ cmd: 'playlists' });
        assert.strictEqual(count(h.cfg, 'playlists'), 3);
    } finally { await h.close(); }
});

test('two calls at once for the same list make one request', async () => {
    const h = await startService(loggedIn());
    try {
        const got = await h.ask([{ id: 1, cmd: 'mixes' }, { id: 2, cmd: 'mixes' }]);
        assert.strictEqual(count(h.cfg, 'mixes'), 1);
        got.forEach((a) => assert.strictEqual(a.ok, true));
    } finally { await h.close(); }
});

test('with no uplink lease the last list comes back stale; with none fetched before, offline', async () => {
    const h = await startService(loggedIn({ service: { cacheMs: 1 } }));
    try {
        const fresh = await h.req({ cmd: 'favorites', kind: 'albums' });
        h.online(false);
        await h.sleep(20);
        const a = await h.req({ id: 7, cmd: 'favorites', kind: 'albums' });
        assert.deepStrictEqual(P.validateAnswer('favorites', a), []);
        assert.strictEqual(a.stale, true);
        assert.deepStrictEqual(a.items, fresh.items);
        assert.strictEqual(count(h.cfg, 'favorites'), 1, 'TIDAL not asked while offline');
        const b = await h.req({ id: 8, cmd: 'playlists' });
        assert.deepStrictEqual(b, { id: 8, ok: false, error: 'offline' });
    } finally { await h.close(); }
});

test('TIDAL unreachable with a lease: the last list stale, else offline', async () => {
    const h = await startService(loggedIn({ service: { cacheMs: 1 } }));
    try {
        await h.req({ cmd: 'mixes' });
        h.cfg.fail = { mixes: 'offline', search: 'offline' };
        await h.sleep(20);
        const a = await h.req({ cmd: 'mixes' });
        assert.strictEqual(a.ok, true); assert.strictEqual(a.stale, true);
        const b = await h.req({ cmd: 'search', query: 'x' });
        assert.strictEqual(b.error, 'offline');
    } finally { await h.close(); }
});

test('TIDAL\'s errors are passed on: not-found, rate-limited with retryAfter, others as tidal-error', async () => {
    const h = await startService(loggedIn());
    try {
        const a = await h.req({ cmd: 'playlist', uuid: 'nope' });
        assert.strictEqual(a.error, 'not-found');
        h.cfg.fail = { search: 'rate-limited', retryAfter: 30 };
        const b = await h.req({ id: 15, cmd: 'search', query: 'q' });
        assert.deepStrictEqual(P.validateAnswer('search', b), []);
        assert.strictEqual(b.error, 'rate-limited'); assert.strictEqual(b.retryAfter, 30);
        h.cfg.fail = { mixes: 'EWEIRD' };
        const c = await h.req({ cmd: 'mixes' });
        assert.strictEqual(c.error, 'tidal-error');
    } finally { await h.close(); }
});

test('lists need a login', async () => {
    const h = await startService({ tidal: { library: library() } });
    try {
        const a = await h.req({ cmd: 'mixes' });
        assert.strictEqual(a.error, 'not-logged-in');
        assert.strictEqual(count(h.cfg, 'mixes'), 0);
    } finally { await h.close(); }
});

test('status.online follows the lease file appearing and disappearing', async () => {
    const h = await startService(loggedIn({ online: false }));
    try {
        assert.strictEqual((await h.status()).online, false);
        h.online(true);
        assert.strictEqual((await h.status()).online, true);
        h.online(false);
        assert.strictEqual((await h.status()).online, false);
    } finally { await h.close(); }
});

test('logout forgets the cached lists', async () => {
    const h = await startService(loggedIn());
    try {
        await h.req({ cmd: 'playlists' });
        await h.req({ cmd: 'logout' });
        h.online(false);
        const a = await h.req({ cmd: 'playlists' });
        assert.strictEqual(a.error, 'not-logged-in');
    } finally { await h.close(); }
});

run();
