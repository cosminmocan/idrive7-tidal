'use strict';
/**
 * listview.js - the rows of the library home and of a list, where they go on the screen, and moving through them.
 * Pure (no drawing, no I/O): screens.js draws from it, nav.js moves with it.
 *
 *   rows(state)            the rows of the screen shown: [{ label, sub, right, kind, item, index, icon, off, playing,
 *                          coverId, video }] (off: a track that cannot be played, greyed and skipped by the knob;
 *                          playing: the track that is on; video: a music video, contract 4, drawn with a film mark)
 *   cursor(state)          { sel, top } of the screen shown
 *   visible(state)         how many rows the screen shows (6; search's results under its letters: 4)
 *   move(cur, d, count, visible, skip)   one row per knob step, over the rows skip(i) says no to, stopping at both
 *                          ends; the selected row kept in view
 *   needMore(frame)        the next page to ask for ({ key, cmd, params }) when the selection nears the end of what
 *                          is loaded (every list command is paged: favorites, playlists, playlist, album, mixes, mix, search), else null
 * Rows are 70 high from y 92 (docs/ui-redesign.md, section 3: six on a screen); search's results start at 196.
 * Node 8.9.4 syntax.
 */

const Y0 = 92, ROW_H = 70, VISIBLE = 6;
const SEARCH_Y0 = 196, SEARCH_VISIBLE = 4;
const PAGED = { favorites: true, playlists: true, playlist: true, album: true, mixes: true, mix: true, search: true };
const PAGE = 50, MAX_PLAY = 1000;
const ON = ['playing', 'paused', 'buffering', 'loading'];

function mmss(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '';
    const s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}
const joinArtists = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const LIBRARY = [
    { label: 'Favourite tracks', icon: 'heart', act: { type: 'open-list', key: 'fav-tracks', title: 'Favourite tracks', kind: 'tracks', source: { cmd: 'favorites', params: { kind: 'tracks' } } } },
    { label: 'Favourite albums', icon: 'disc', act: { type: 'open-list', key: 'fav-albums', title: 'Favourite albums', kind: 'albums', source: { cmd: 'favorites', params: { kind: 'albums' } } } },
    { label: 'Playlists', icon: 'list', act: { type: 'open-list', key: 'playlists', title: 'Playlists', kind: 'playlists', source: { cmd: 'playlists', params: {} } } },
    { label: 'Mixes', icon: 'mix', act: { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } } },
    // the favourite videos (contract 4): a list that plays as a track list does
    { label: 'Videos', icon: 'film', act: { type: 'open-list', key: 'fav-videos', title: 'Videos', kind: 'tracks', source: { cmd: 'favorites', params: { kind: 'videos' } } } },
    { label: 'Search', icon: 'search', act: { type: 'open-search' } },
];

function frameOf(s) { return s.stack.length ? s.stack[s.stack.length - 1] : null; }
const isTracks = (f) => f.kind === 'tracks' || f.kind === 'search';
const isVideo = (it) => isObj(it) && it.kind === 'video';
/** a track of frame f the service cannot play */
function offItem(s, f, it) { return isTracks(f) && isObj(it) && (it.streamReady === false || !!(s.unavailable && s.unavailable[it.id])); }
/** the track that is on (its id), or null */
function playingId(s) { const p = s.player; return p && p.track && ON.indexOf(p.state) >= 0 ? p.track.id : null; }

/** what a press on row i of frame f does */
function itemActs(s, f, i) {
    const it = f.items[i];
    if (!it || typeof it !== 'object') return [];
    if (isTracks(f)) {
        if (offItem(s, f, it)) return [{ type: 'error', code: 'not-available', trackId: it.id }];
        let start = 0;
        if (f.items.length > MAX_PLAY) start = Math.max(0, Math.min(f.items.length - MAX_PLAY, i - Math.floor(MAX_PLAY / 2)));
        // ids the service could not take (not numbers) are left out; the index follows
        const win = f.items.slice(start, start + MAX_PLAY);
        const keep = win.filter((t) => t && typeof t.id === 'number');
        const index = win.slice(0, i - start).filter((t) => t && typeof t.id === 'number').length;
        // queue: the list it comes from (now playing's caption and next track, push right back to it); not sent.
        // kinds (contract 4): which ids are videos, whenever the list holds any; watch: a video goes to now playing
        const a = { type: 'play', tracks: keep.map((t) => t.id), index: index, queue: { key: f.key, title: f.title, tracks: keep } };
        if (keep.some(isVideo)) a.kinds = keep.map((t) => (isVideo(t) ? 'video' : 'track'));
        if (isVideo(it)) a.watch = true;
        return [a];
    }
    if (f.kind === 'albums') return [{ type: 'open-list', key: 'album:' + it.id, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'album', params: { albumId: it.id } } }];
    if (f.kind === 'playlists') return [{ type: 'open-list', key: 'playlist:' + it.uuid, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'playlist', params: { uuid: it.uuid } } }];
    if (f.kind === 'mixes') return [{ type: 'open-list', key: 'mix:' + it.id, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'mix', params: { mixId: it.id } } }];
    return [];
}

/** My music: six rows, and "Now playing" as the last while a track is loaded (the others never move) */
function libraryRows(s) {
    const r = LIBRARY.slice();
    const p = s.player;
    if (playingId(s) != null) {
        const by = joinArtists(p.track.artists);
        r.push({ label: 'Now playing', icon: 'playing', value: p.track.title + (by ? '  ·  ' + by : ''), act: { type: 'open-now-playing' } });
    }
    return r;
}

function count(n, one, many) { return typeof n === 'number' && isFinite(n) && n >= 0 ? n + ' ' + (n === 1 ? one : many) : ''; }

function rows(s) {
    if (s.screen === 'LIBRARY') return libraryRows(s).map((r, i) => ({ label: r.label, sub: '', right: r.value || '', icon: r.icon, kind: 'menu', index: i, acts: [r.act] }));
    const f = frameOf(s);
    if (s.screen !== 'LIST' || !f) return [];
    const on = playingId(s);
    return f.items.map((it, i) => {
        const o = isObj(it) ? it : {};
        const base = { label: String(o.title || ''), sub: '', right: '', kind: f.kind, item: o, index: i, coverId: typeof o.coverId === 'string' ? o.coverId : null };
        if (isTracks(f)) {
            const album = isObj(o.album) && typeof o.album.title === 'string' ? o.album.title : '';
            base.sub = [joinArtists(o.artists), album].filter(Boolean).join('  ·  ');
            base.off = offItem(s, f, o);
            base.right = base.off ? 'Not available' : mmss(o.duration);
            base.video = isVideo(o);
            // (videos and tracks have separate ids at TIDAL: the kind must match too)
            base.playing = on != null && o.id === on && base.video === (s.player.track.kind === 'video');
        } else if (f.kind === 'albums') {
            base.sub = joinArtists(o.artists);
            base.right = count(o.numberOfTracks, 'track', 'tracks');
        } else if (f.kind === 'playlists') base.right = count(o.numberOfTracks, 'track', 'tracks');
        else if (f.kind === 'mixes') base.sub = typeof o.subTitle === 'string' ? o.subTitle : '';
        return base;
    });
}

/** what a press on row i of the screen shown does (model events and acts for main.js) */
function rowActs(s, i) {
    if (s.screen === 'LIBRARY') { const r = libraryRows(s)[i]; return r ? [r.act] : []; }
    const f = frameOf(s);
    if (s.screen !== 'LIST' || !f) return [];
    return itemActs(s, f, i);
}

/** row i of the screen shown is passed over by the knob (a track that cannot be played) */
function skips(s) {
    const f = frameOf(s);
    if (s.screen !== 'LIST' || !f) return () => false;
    return (i) => offItem(s, f, f.items[i]);
}

function cursor(s) {
    if (s.screen === 'LIBRARY') return s.library;
    const f = frameOf(s);
    return f ? { sel: f.sel, top: f.top } : { sel: 0, top: 0 };
}
function visible(s) { const f = frameOf(s); return s.screen === 'LIST' && f && f.kind === 'search' ? SEARCH_VISIBLE : VISIBLE; }

function keepVisible(sel, top, count, vis) {
    const v = vis || VISIBLE;
    let t = top;
    if (sel < t) t = sel;
    if (sel >= t + v) t = sel - v + 1;
    return Math.max(0, Math.min(t, Math.max(0, count - v)));
}
function move(cur, d, count, vis, skip) {
    if (!count) return { sel: 0, top: 0 };
    let sel = Math.max(0, Math.min(count - 1, cur.sel || 0));
    const dir = d > 0 ? 1 : -1, n = Math.abs(Math.round(d || 0));
    for (let k = 0; k < n; k++) {
        let j = sel + dir;
        while (j >= 0 && j < count && skip && skip(j)) j += dir;
        if (j < 0 || j >= count) break;
        sel = j;
    }
    return { sel: sel, top: keepVisible(sel, cur.top || 0, count, vis) };
}
/** the rows to draw: [first, last) */
function range(cur, count, vis) {
    const v = vis || VISIBLE;
    const top = keepVisible(Math.min(cur.sel || 0, Math.max(0, count - 1)), cur.top || 0, count, v);
    return { first: top, last: Math.min(count, top + v) };
}

function needMore(f) {
    if (!f || !PAGED[f.source.cmd] || f.loading || f.error || typeof f.total !== 'number' || f.items.length >= f.total) return null;
    if (f.sel + VISIBLE < f.items.length) return null;
    const params = {};
    Object.keys(f.source.params || {}).forEach((k) => { params[k] = f.source.params[k]; });
    params.offset = f.items.length;
    params.limit = PAGE;
    return { key: f.key, cmd: f.source.cmd, params: params };
}

module.exports = { rows: rows, rowActs: rowActs, skips: skips, cursor: cursor, visible: visible, move: move, range: range, needMore: needMore, mmss: mmss,
    playingId: playingId, joinArtists: joinArtists, Y0: Y0, ROW_H: ROW_H, VISIBLE: VISIBLE, SEARCH_Y0: SEARCH_Y0, SEARCH_VISIBLE: SEARCH_VISIBLE, PAGE: PAGE, PAGED: PAGED };
