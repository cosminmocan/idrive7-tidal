'use strict';
/**
 * library.js - favourites, playlists, albums, mixes and search (tidalapi 0.9.0 user.py Favorites, playlist.py,
 * album.py, mix.py, session.py search and mixes), mapped to the objects of docs/PROTOCOL.md ("Objects").
 *
 * Videos (contract 4): favourite videos (users/<id>/favorites/videos), and the videos among a playlist's items
 * (playlists/<uuid>/items, tidalapi playlist.py items(): each { item, type: 'track' | 'video' }) and a mix page's
 * lists are `kind: 'video'` items: album null, coverId the video's picture (imageId). A track stays as it was (no
 * kind). An item of a type that is neither is dropped.
 *
 * A list is fetched in pages of at most pageSize until `limit` items, the end of the list, or MAX_PAGES requests.
 * The mixes and a mix's tracks come whole in one page (TIDAL's /pages): the module pages them itself, with total.
 * An item that cannot be read is dropped; a track that cannot be streamed is kept with streamReady false.
 */
const E = require('./errors');

const MAX_PAGES = 10;
const MAX_LIMIT = 100;
const PLAYLISTS_PAGE = 50; // tidalapi: playlistsAndFavoritePlaylists "is limited to 50 by TIDAL"
const UUID = /^[0-9A-Za-z-]{1,64}$/;
const MIX_ID = /^[0-9A-Za-z_-]{1,64}$/;
const RESOURCE_IMAGE = /resources\.tidal\.com\/images\/([0-9a-f]{8})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{12})\//i;

/* ---------- mapping ---------- */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => (typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 1 ? v : null);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const titleOf = (o) => text(o.title) || 'Untitled';
const countOf = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function artistsOf(o) {
    const names = (Array.isArray(o.artists) ? o.artists : []).filter((a) => isObj(a) && text(a.name)).map((a) => text(a.name));
    if (!names.length && isObj(o.artist) && text(o.artist.name)) names.push(text(o.artist.name));
    return names;
}

function track(t) {
    if (!isObj(t)) return null;
    if (typeof t.type === 'string' && !/track/i.test(t.type)) return null; // a video in a mixed list
    const id = posInt(t.id);
    if (!id) return null;
    let title = titleOf(t);
    const version = text(t.version);
    if (version && title.indexOf(version) < 0) title += ' (' + version + ')';
    const album = isObj(t.album) && posInt(t.album.id) ? { id: t.album.id, title: text(t.album.title) } : null;
    return {
        id: id, title: title, artists: artistsOf(t), album: album,
        coverId: isObj(t.album) && text(t.album.cover) ? text(t.album.cover) : null,
        duration: Math.max(0, Math.round(Number(t.duration) || 0)),
        streamReady: t.streamReady === true && t.allowStreaming !== false,
        explicit: t.explicit === true,
    };
}

/** a video (tidalapi media.py Video.parse_video): type "Music Video" in mixed lists */
function video(v) {
    if (!isObj(v)) return null;
    const id = posInt(v.id);
    if (!id) return null;
    return {
        kind: 'video', id: id, title: titleOf(v), artists: artistsOf(v), album: null,
        coverId: text(v.imageId) || null,
        duration: Math.max(0, Math.round(Number(v.duration) || 0)),
        streamReady: v.streamReady === true && v.allowStreaming !== false,
        explicit: v.explicit === true,
    };
}

/**
 * an item of a list that holds both (tidalapi media.py parse_media): `hint` is the wrapper's type ('track', 'video'),
 * else the object's own type (none or Track: a track; one naming video: a video); anything else is dropped
 */
function media(x, hint) {
    if (!isObj(x)) return null;
    const h = String(hint || '').toLowerCase();
    if (h === 'video') return video(x);
    if (h === 'track') return track(x);
    if (h) return null;
    if (x.type === undefined || x.type === null || /track/i.test(String(x.type))) return track(x);
    if (/video/i.test(String(x.type))) return video(x);
    return null;
}
/** a wrapped item ({ item, type }), as playlists/<uuid>/items gives them */
function wrapped(w) { return isObj(w) ? media(w.item, w.type) : null; }

function album(a) {
    if (!isObj(a) || !posInt(a.id)) return null;
    return { id: a.id, title: titleOf(a), artists: artistsOf(a), coverId: text(a.cover) || null, numberOfTracks: countOf(a.numberOfTracks) };
}

function playlist(p) {
    if (!isObj(p) || typeof p.uuid !== 'string' || !UUID.test(p.uuid)) return null;
    // only the square picture is 320 x 320; the wide one is not a cover
    return { uuid: p.uuid, title: titleOf(p), numberOfTracks: countOf(p.numberOfTracks), coverId: text(p.squareImage) || null };
}

/** a mix's pictures are addresses; when one is a resources.tidal.com image, its id is a cover id */
function mixCover(m) {
    const imgs = isObj(m.images) ? m.images : {};
    const urls = ['SMALL', 'MEDIUM', 'LARGE'].map((k) => (isObj(imgs[k]) ? imgs[k].url : null)).filter((u) => typeof u === 'string');
    for (let i = 0; i < urls.length; i++) {
        const r = RESOURCE_IMAGE.exec(urls[i]);
        if (r) return r.slice(1, 6).join('-').toLowerCase();
    }
    return null;
}

function mix(m) {
    if (!isObj(m)) return null;
    const id = typeof m.id === 'number' ? String(m.id) : text(m.id);
    if (!id) return null;
    const out = { id: id, title: titleOf(m) };
    if (text(m.subTitle)) out.subTitle = text(m.subTitle);
    out.coverId = mixCover(m);
    return out;
}

/** the modules of a /pages answer */
function modules(json) {
    const rows = isObj(json) && Array.isArray(json.rows) ? json.rows : [];
    const out = [];
    rows.forEach((r) => { if (isObj(r) && Array.isArray(r.modules)) r.modules.forEach((m) => { if (isObj(m)) out.push(m); }); });
    return out;
}

/* ---------- arguments ---------- */

const bad = (msg) => Promise.reject(E.tidalError('bad-request', msg));
function paging(offset, limit) {
    const o = offset === undefined || offset === null ? 0 : offset;
    const l = limit === undefined || limit === null ? 50 : limit;
    if (!(typeof o === 'number' && Math.floor(o) === o && o >= 0 && o < 1e7)) return null;
    if (!(typeof l === 'number' && Math.floor(l) === l && l >= 1 && l <= MAX_LIMIT)) return null;
    return { offset: o, limit: l };
}

function createLibrary(ctx, api, o) {
    const pageSize = Math.max(1, (o && o.pageSize) || 50);

    /** one list from as many pages as needed; pick(json) -> { items: raw[], total } */
    function paged(path, params, pg, pick, map, maxPage) {
        const size = Math.min(pageSize, maxPage || pageSize);
        const out = [];
        let total;
        let pages = 0;
        function step(off) {
            const want = Math.min(size, pg.limit - (off - pg.offset));
            pages++;
            return api.get(path, Object.assign({}, params, { offset: off, limit: want })).then((json) => {
                const p = pick(isObj(json) ? json : {}) || {};
                const raw = Array.isArray(p.items) ? p.items.slice(0, want) : [];
                if (typeof p.total === 'number' && isFinite(p.total) && p.total >= 0) total = Math.floor(p.total);
                raw.forEach((x) => { const m = map(x); if (m) out.push(m); });
                const got = raw.length;
                const end = got === 0 || off + got - pg.offset >= pg.limit || (total !== undefined ? off + got >= total : got < want) || pages >= MAX_PAGES;
                return end ? undefined : step(off + got);
            });
        }
        return step(pg.offset).then(() => (total === undefined ? { items: out } : { items: out, total: total }));
    }
    const unwrap = (key) => (json) => ({ items: (Array.isArray(json.items) ? json.items : []).map((i) => (isObj(i) ? i[key] : null)), total: json.totalNumberOfItems });
    const plain = (json) => ({ items: json.items, total: json.totalNumberOfItems });
    const me = () => 'users/' + ctx.session.userId + '/';
    const needLogin = () => (ctx.session ? null : Promise.reject(E.tidalError('not-logged-in', 'not logged in')));

    const FAVORITES = { tracks: track, albums: album, videos: video };
    function favorites(kind, offset, limit) {
        if (!FAVORITES.hasOwnProperty(kind)) return bad('kind must be tracks, albums or videos');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged(me() + 'favorites/' + kind, { order: 'DATE', orderDirection: 'DESC' }, pg, unwrap('item'), FAVORITES[kind]);
    }

    function playlists(offset, limit) {
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged(me() + 'playlistsAndFavoritePlaylists', {}, pg, unwrap('playlist'), playlist, PLAYLISTS_PAGE);
    }

    function playlistTracks(uuid, offset, limit) {
        if (typeof uuid !== 'string' || !UUID.test(uuid)) return bad('bad playlist uuid');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        // items, not tracks: the playlist's videos too (tidalapi playlist.py items())
        return needLogin() || paged('playlists/' + uuid + '/items', {}, pg, plain, wrapped);
    }

    function albumTracks(albumId, offset, limit) {
        if (!posInt(albumId)) return bad('bad album id');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged('albums/' + albumId + '/tracks', {}, pg, plain, track);
    }

    /** a list TIDAL sends whole (a page's module): the module pages it; total is what it can give */
    function slice(items, pg) {
        return { items: items.slice(pg.offset, pg.offset + pg.limit), total: items.length };
    }

    function mixes(offset, limit) {
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || api.get('pages/my_collection_my_mixes', { deviceType: 'BROWSER' }).then((json) => {
            const items = [];
            modules(json).filter((m) => m.type === 'MIX_LIST' && isObj(m.pagedList)).forEach((m) => {
                (Array.isArray(m.pagedList.items) ? m.pagedList.items : []).forEach((x) => { const v = mix(x); if (v) items.push(v); });
            });
            return slice(items, pg);
        });
    }

    function mixTracks(mixId, offset, limit) {
        if (typeof mixId !== 'string' || !MIX_ID.test(mixId)) return bad('bad mix id');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || api.get('pages/mix', { mixId: mixId, deviceType: 'BROWSER' }).then((json) => {
            // a mix's list: TRACK_LIST (tracks, and videos by their type), VIDEO_LIST (a video mix), MIXED_TYPES_LIST
            const LISTS = { TRACK_LIST: null, VIDEO_LIST: 'video', MIXED_TYPES_LIST: null };
            const list = modules(json).filter((m) => LISTS.hasOwnProperty(m.type) && isObj(m.pagedList))[0];
            // tidalapi: a page without its track list means the mix is not there
            if (!list) throw E.tidalError('not-found', 'no such mix: ' + mixId);
            const hint = LISTS[list.type];
            const items = Array.isArray(list.pagedList.items) ? list.pagedList.items : [];
            // a mixed list wraps its items as { item, type: 'TRACK' | 'VIDEO' }
            return slice(items.map((x) => (isObj(x) && isObj(x.item) && typeof x.type === 'string' ? wrapped(x) : media(x, hint))).filter(Boolean), pg);
        });
    }

    /** one track by id (tidalapi media.py Track._get: GET tracks/<id>), for "now playing" after a restart */
    function oneTrack(trackId) {
        if (!posInt(trackId)) return bad('bad track id');
        return needLogin() || api.get('tracks/' + trackId, {}).then((json) => {
            const t = track(json);
            if (!t || t.id !== trackId) throw E.tidalError('not-found', 'no such track: ' + trackId);
            return t;
        });
    }

    /** one video by id (tidalapi media.py Video._get: GET videos/<id>), for "now playing" after a restart */
    function oneVideo(videoId) {
        if (!posInt(videoId)) return bad('bad video id');
        return needLogin() || api.get('videos/' + videoId, {}).then((json) => {
            const v = isObj(json) && (json.type === undefined || /video/i.test(String(json.type))) ? video(json) : null;
            if (!v || v.id !== videoId) throw E.tidalError('not-found', 'no such video: ' + videoId);
            return v;
        });
    }

    function search(query, offset, limit) {
        if (typeof query !== 'string' || !query.trim() || query.length > 200) return bad('query must be 1 to 200 characters');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged('search', { query: query, types: 'TRACKS' }, pg,
            (json) => (isObj(json.tracks) ? plain(json.tracks) : { items: [] }), track);
    }

    return { favorites: favorites, playlists: playlists, playlist: playlistTracks, album: albumTracks, mixes: mixes, mix: mixTracks, track: oneTrack,
        video: oneVideo, search: search };
}

module.exports = { createLibrary: createLibrary, mapTrack: track, mapVideo: video, mapMedia: media, mapAlbum: album, mapPlaylist: playlist, mapMix: mix };
