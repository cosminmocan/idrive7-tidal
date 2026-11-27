'use strict';
/**
 * library.js - favourites, playlists, albums, mixes and search (tidalapi 0.9.0 user.py Favorites, playlist.py,
 * album.py, mix.py, session.py search and mixes), mapped to the objects of docs/PROTOCOL.md ("Objects").
 *
 * A list is fetched in pages of at most pageSize until `limit` items, the end of the list, or MAX_PAGES requests.
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

    function favorites(kind, offset, limit) {
        if (kind !== 'tracks' && kind !== 'albums') return bad('kind must be tracks or albums');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged(me() + 'favorites/' + kind, { order: 'DATE', orderDirection: 'DESC' }, pg, unwrap('item'), kind === 'tracks' ? track : album);
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
        return needLogin() || paged('playlists/' + uuid + '/tracks', {}, pg, plain, track);
    }

    function albumTracks(albumId, offset, limit) {
        if (!posInt(albumId)) return bad('bad album id');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged('albums/' + albumId + '/tracks', {}, pg, plain, track);
    }

    function mixes() {
        return needLogin() || api.get('pages/my_collection_my_mixes', { deviceType: 'BROWSER' }).then((json) => {
            const items = [];
            let total;
            modules(json).filter((m) => m.type === 'MIX_LIST' && isObj(m.pagedList)).forEach((m) => {
                (Array.isArray(m.pagedList.items) ? m.pagedList.items : []).forEach((x) => { const v = mix(x); if (v) items.push(v); });
                if (typeof m.pagedList.totalNumberOfItems === 'number') total = (total || 0) + m.pagedList.totalNumberOfItems;
            });
            return total === undefined ? { items: items } : { items: items, total: total };
        });
    }

    function mixTracks(mixId) {
        if (typeof mixId !== 'string' || !MIX_ID.test(mixId)) return bad('bad mix id');
        return needLogin() || api.get('pages/mix', { mixId: mixId, deviceType: 'BROWSER' }).then((json) => {
            const list = modules(json).filter((m) => m.type === 'TRACK_LIST' && isObj(m.pagedList))[0];
            // tidalapi: a page without its track list means the mix is not there
            if (!list) throw E.tidalError('not-found', 'no such mix: ' + mixId);
            const items = (Array.isArray(list.pagedList.items) ? list.pagedList.items : []).map(track).filter(Boolean);
            const total = list.pagedList.totalNumberOfItems;
            return typeof total === 'number' ? { items: items, total: total } : { items: items };
        });
    }

    function search(query, offset, limit) {
        if (typeof query !== 'string' || !query.trim() || query.length > 200) return bad('query must be 1 to 200 characters');
        const pg = paging(offset, limit);
        if (!pg) return bad('offset or limit out of range');
        return needLogin() || paged('search', { query: query, types: 'TRACKS' }, pg,
            (json) => (isObj(json.tracks) ? plain(json.tracks) : { items: [] }), track);
    }

    return { favorites: favorites, playlists: playlists, playlist: playlistTracks, album: albumTracks, mixes: mixes, mix: mixTracks, search: search };
}

module.exports = { createLibrary: createLibrary, mapTrack: track, mapAlbum: album, mapPlaylist: playlist, mapMix: mix };
