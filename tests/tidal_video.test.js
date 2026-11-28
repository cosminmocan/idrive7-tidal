'use strict';
/**
 * V1b, the TIDAL module's part: videos (contract 4). Favourite videos (users/<id>/favorites/videos), the videos in a
 * playlist (playlists/<uuid>/items, tidalapi playlist.py items()) and in a mix page, as `kind: 'video'` items; one
 * video by id; the video's stream address (videos/<id>/urlpostpaywall, videoquality HIGH: an HLS master playlist,
 * docs/live-check-results.md "Video"); and the HLS helpers (lib/tidal/hls.js, pure): the master's variants, the
 * variant closest to prefs.videoHeight, a variant's segments with their durations and absolute addresses.
 * The fixtures in tests/fixtures/hls are written by hand in the shape of TIDAL's real playlists, with made-up hosts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');
const P = require('./fakes/protocol');
const H = require('../native/cmocan-tidal/lib/tidal/hls');

function withEnv(opts, fn) {
    return F.startTidal(Object.assign({ loggedIn: true }, opts)).then((env) => Promise.resolve().then(() => fn(env)).then(
        (v) => env.close().then(() => v),
        (e) => env.close().then(() => { throw e; })));
}
function rejects(p, code) {
    return p.then((v) => { throw new Error('expected ' + code + ', got ' + JSON.stringify(v)); }, (e) => { assert.strictEqual(e.code, code, e.code + ': ' + e.message); return e; });
}
function valid(cmd, r) {
    assert.deepStrictEqual(P.validateAnswer(cmd, Object.assign({ id: 1, ok: true }, r)), []);
    return r;
}
const calls = (env, p) => env.fake.requests('/api/v1/' + p);
const UID = 192837465;
const PLAYLIST = '36ea71a8-445e-41a4-82ab-6628c581535d';
const MIX = '0123456789abcdef0123456789abcd';
const AROUND = { kind: 'video', id: 143792065, title: 'Around the World', artists: ['Daft Punk'], album: null,
    coverId: 'a1b2c3d4-0000-4000-8000-000000000001', duration: 175, streamReady: true, explicit: false };
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'hls', n), 'utf8');

/* ---------- lists ---------- */

test('favorites videos: users/<id>/favorites/videos, newest first, as video items', () => withEnv({}, (env) =>
    env.tidal.favorites('videos', 0, 50).then((r) => {
        valid('favorites', r);
        const c = calls(env, 'users/' + UID + '/favorites/videos');
        assert.strictEqual(c.length, 1);
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50', order: 'DATE', orderDirection: 'DESC' });
        assert.strictEqual(r.total, 2);
        assert.deepStrictEqual(r.items[0], AROUND);
        assert.deepStrictEqual(r.items[1], { kind: 'video', id: 143792066, title: 'Live at the Club', artists: ['Guest', 'Daft Punk'], album: null,
            coverId: null, duration: 242, streamReady: false, explicit: true });
    })));

test('favorites: a bad kind is bad-request', () => withEnv({}, (env) => rejects(env.tidal.favorites('artists', 0, 50), 'bad-request')));

test('a playlist keeps its videos: playlists/<uuid>/items, tracks and videos in their order', () => withEnv({}, (env) => {
    env.fake.data.playlistItems = { [PLAYLIST]: [{ type: 'track', id: 17927864 }, { type: 'video', id: 143792065 }, { type: 'track', id: 17927865 }] };
    return env.tidal.playlist(PLAYLIST, 0, 50).then((r) => {
        valid('playlist', r);
        const c = calls(env, 'playlists/' + PLAYLIST + '/items');
        assert.strictEqual(c.length, 1);
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', offset: '0', limit: '50' });
        assert.deepStrictEqual(r.items.map((x) => [x.kind || 'track', x.id]), [['track', 17927864], ['video', 143792065], ['track', 17927865]]);
        assert.deepStrictEqual(r.items[1], AROUND);
        assert.strictEqual(r.items[0].kind, undefined, 'a track stays as before (kind absent)');
        assert.strictEqual(r.total, 3);
    });
}));

test('a playlist item of a type it does not know is dropped, not shown as a track', () => withEnv({}, (env) => {
    env.fake.fault({ path: '/api/v1/playlists/' + PLAYLIST + '/items', status: 200, body: { limit: 50, offset: 0, totalNumberOfItems: 3, items: [
        { item: env.fake.data.tracks[0], type: 'track', cut: null },
        { item: { id: 5, title: 'An episode', duration: 10 }, type: 'episode', cut: null },
        { item: env.fake.data.videos[0], type: 'video', cut: null }] } });
    return env.tidal.playlist(PLAYLIST, 0, 50).then((r) => {
        valid('playlist', r);
        assert.deepStrictEqual(r.items.map((x) => x.kind || 'track'), ['track', 'video']);
    });
}));

test('a mix page keeps its videos (in its track list, and a video list module)', () => withEnv({}, (env) => {
    env.fake.data.mixItems = { [MIX]: [{ type: 'track', id: 17927864 }, { type: 'video', id: 143792065 }] };
    return env.tidal.mix(MIX, 0, 50).then((r) => {
        valid('mix', r);
        assert.deepStrictEqual(r.items.map((x) => [x.kind || 'track', x.id]), [['track', 17927864], ['video', 143792065]]);
        assert.deepStrictEqual(r.items[1], AROUND);
        // a video mix (tidalapi mix.py VIDEO_DAILY_MIX): its page holds a VIDEO_LIST
        env.fake.fault({ path: '/api/v1/pages/mix', status: 200, body: { rows: [{ modules: [{ type: 'MIX_HEADER', mix: env.fake.data.mixes[0] }] },
            { modules: [{ type: 'VIDEO_LIST', pagedList: { limit: 2, offset: 0, totalNumberOfItems: 2, items: env.fake.data.videos } }] }] } });
        return env.tidal.mix(MIX, 0, 50);
    }).then((r) => {
        valid('mix', r);
        assert.deepStrictEqual(r.items.map((x) => [x.kind, x.id]), [['video', 143792065], ['video', 143792066]]);
    });
}));

test('video: one video by id (GET videos/<id>); a track id or a broken answer is not-found', () => withEnv({}, (env) =>
    env.tidal.video(143792065).then((v) => {
        assert.deepStrictEqual(v, AROUND);
        assert.deepStrictEqual(calls(env, 'videos/143792065')[0].query, { countryCode: 'RO' });
        return Promise.all([rejects(env.tidal.video(1), 'not-found'), rejects(env.tidal.video('143792065'), 'bad-request')]);
    })));

/* ---------- the stream address ---------- */

test('videoUrl: videos/<id>/urlpostpaywall with STREAM, HIGH, FULL; the HLS master address and the quality', () => withEnv({}, (env) =>
    env.tidal.videoUrl(143792065, 720).then((r) => {
        assert.deepStrictEqual(r, { url: env.fake.fileUrl('143792065/master.m3u8'), quality: 'HIGH' });
        const c = calls(env, 'videos/143792065/urlpostpaywall');
        assert.strictEqual(c.length, 1);
        assert.deepStrictEqual(c[0].query, { countryCode: 'RO', urlusagemode: 'STREAM', videoquality: 'HIGH', assetpresentation: 'FULL' });
    })));

test('videoUrl: a video TIDAL will not stream is not-available; bad arguments are bad-request; logged out is not-logged-in', () => withEnv({}, (env) => {
    env.fake.videoStreams[143792066] = { HIGH: { status: 401, body: { status: 401, subStatus: 4005, userMessage: 'Asset is not ready for playback' } } };
    return rejects(env.tidal.videoUrl(143792066, 720), 'not-available')
        .then(() => { env.fake.videoStreams[5] = { HIGH: { videoId: 5, urls: [] } }; return rejects(env.tidal.videoUrl(5, 720), 'not-available'); })
        .then(() => Promise.all([rejects(env.tidal.videoUrl(0, 720), 'bad-request'), rejects(env.tidal.videoUrl(143792065, 360), 'bad-request')]))
        .then(() => withEnv({ loggedIn: false }, (e2) => rejects(e2.tidal.videoUrl(143792065, 720), 'not-logged-in')));
}));

/* ---------- HLS ---------- */

const MASTER_AT = 'https://manifest.example.test/v1/143792065/master.m3u8?token=not-a-real-one';

test('hls: the master playlist\'s variants, with sizes, bandwidth and absolute addresses', () => {
    const v = H.parseMaster(fixture('master.m3u8'), MASTER_AT);
    assert.deepStrictEqual(v.map((x) => [x.width, x.height, x.bandwidth]), [[320, 180, 463000], [640, 360, 718000], [854, 480, 1498000], [1280, 720, 3112000], [1920, 1080, 6403000]]);
    assert.strictEqual(v[0].url, 'https://hls.example.test/v1/143792065/180/playlist.m3u8?sig=not-a-real-signature', 'an absolute address as it is');
    assert.strictEqual(v[3].url, 'https://manifest.example.test/v1/143792065/720/playlist.m3u8', 'a relative one against the master\'s');
    assert.strictEqual(v[3].codecs, 'avc1.640020,mp4a.40.2', 'a quoted attribute with a comma');
});

test('hls: the variant closest to the wanted height, not above it when a lower one exists', () => {
    const v = H.parseMaster(fixture('master.m3u8'), MASTER_AT);
    assert.strictEqual(H.chooseVariant(v, 720).height, 720);
    assert.strictEqual(H.chooseVariant(v, 1080).height, 1080);
    assert.strictEqual(H.chooseVariant(v, 480).height, 480);
    assert.strictEqual(H.chooseVariant(v, 600).height, 480, 'below, not above');
    const high = v.filter((x) => x.height >= 720);
    assert.strictEqual(H.chooseVariant(high, 480).height, 720, 'only higher ones: the lowest of them');
    const low = v.filter((x) => x.height <= 480);
    assert.strictEqual(H.chooseVariant(low, 1080).height, 480, 'only lower ones: the highest');
    // in any order; two of the same height: the higher bandwidth
    const shuffled = [v[4], v[1], v[3], v[0], Object.assign({}, v[3], { bandwidth: 2000000, url: 'x' }), v[2]];
    assert.strictEqual(H.chooseVariant(shuffled, 720), v[3]);
    // no RESOLUTION at all: by bandwidth, the middle of the list is not guessed: the highest
    assert.strictEqual(H.chooseVariant([{ url: 'a', bandwidth: 1 }, { url: 'b', bandwidth: 3 }, { url: 'c', bandwidth: 2 }], 720).url, 'b');
    assert.strictEqual(H.chooseVariant([], 720), null);
});

test('hls: a variant playlist\'s segments, with durations, starts and absolute addresses; its length', () => {
    const at = 'https://manifest.example.test/v1/143792065/720/playlist.m3u8?token=not-a-real-one';
    const m = H.parseMedia(fixture('variant.m3u8'), at);
    assert.strictEqual(m.vod, true);
    assert.strictEqual(m.targetDuration, 6);
    assert.strictEqual(m.encrypted, false);
    assert.deepStrictEqual(m.segments.map((s) => s.duration), [6, 6, 6, 6, 5.52]);
    assert.deepStrictEqual(m.segments.map((s) => s.start), [0, 6, 12, 18, 24]);
    assert.ok(Math.abs(m.duration - 29.52) < 1e-9, String(m.duration));
    assert.deepStrictEqual(m.segments.map((s) => s.url), [
        'https://manifest.example.test/v1/143792065/720/segment-0.ts',
        'https://manifest.example.test/v1/143792065/720/segment-1.ts',
        'https://seg.example.test/v1/143792065/720/segment-2.ts?sig=not-a-real-signature',
        'https://manifest.example.test/v1/143792065/720/segment-3.ts',
        'https://manifest.example.test/v1/143792065/720/segment-4.ts']);
});

test('hls: the segment holding a position (by the sum of the durations)', () => {
    const m = H.parseMedia(fixture('variant.m3u8'), 'https://manifest.example.test/a/b.m3u8');
    assert.strictEqual(H.segmentAt(m.segments, 0), 0);
    assert.strictEqual(H.segmentAt(m.segments, 5.99), 0);
    assert.strictEqual(H.segmentAt(m.segments, 6), 1);
    assert.strictEqual(H.segmentAt(m.segments, 13), 2);
    assert.strictEqual(H.segmentAt(m.segments, 29), 4);
    assert.strictEqual(H.segmentAt(m.segments, 400), 4, 'past the end: the last one');
});

test('hls: an encrypted playlist is marked; text that is not a playlist is a tidal-error', () => {
    const enc = fixture('variant.m3u8').replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    assert.strictEqual(H.parseMedia(enc, 'https://a.example.test/x.m3u8').encrypted, true);
    const none = fixture('variant.m3u8').replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-KEY:METHOD=NONE');
    assert.strictEqual(H.parseMedia(none, 'https://a.example.test/x.m3u8').encrypted, false);
    // not a playlist, empty, or one with nothing in it
    ['<html>nope</html>', '', '#EXTM3U\n'].forEach((t) => {
        assert.throws(() => H.parseMaster(t, 'https://a.example.test/x.m3u8'), (e) => e.code === 'tidal-error');
        assert.throws(() => H.parseMedia(t, 'https://a.example.test/x.m3u8'), (e) => e.code === 'tidal-error');
    });
});

test('hls: a master that is itself a media playlist is seen as one', () => {
    assert.strictEqual(H.isMaster(fixture('master.m3u8')), true);
    assert.strictEqual(H.isMaster(fixture('variant.m3u8')), false);
});

test('the HLS fixtures hold no real address or token', () => {
    ['master.m3u8', 'variant.m3u8'].forEach((n) => {
        const t = fixture(n);
        assert.ok(!/tidal\.com/.test(t), n + ': no TIDAL host');
        assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(t), n + ': no JWT');
    });
});

run();
