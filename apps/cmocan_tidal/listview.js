'use strict';
/**
 * listview.js - the rows of the library home and of a list, where they go on the screen, and moving through them.
 * Pure (no drawing, no I/O): screens.js draws from it, nav.js moves with it.
 *
 *   rows(state)            the rows of the screen shown: [{ label, sub, right, act, dim, kind, item }]
 *   cursor(state)          { sel, top } of the screen shown
 *   move(cur, d, count)    one row per knob step, stopping at both ends; the selected row kept in view
 *   needMore(frame)        the next page to ask for ({ key, cmd, params }) when the selection nears the end of what
 *                          is loaded (every list command is paged: favorites, playlists, playlist, album, mixes, mix, search), else null
 * Node 8.9.4 syntax.
 */

const TOP = 44, BOTTOM = 512;
const Y0 = TOP + 78, ROW_H = 62;
const VISIBLE = Math.floor((BOTTOM - Y0) / ROW_H);
const COLS = { num: { x: 60, w: 56 }, title: { x: 130, w: 760 }, sub: { x: 920, w: 460 }, right: { x: 1540, w: 120 } };
const PAGED = { favorites: true, playlists: true, playlist: true, album: true, mixes: true, mix: true, search: true };
const PAGE = 50, MAX_PLAY = 1000;

function mmss(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return '';
    const s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
}
const joinArtists = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : '');

const LIBRARY = [
    { label: 'Favourite tracks', act: { type: 'open-list', key: 'fav-tracks', title: 'Favourite tracks', kind: 'tracks', source: { cmd: 'favorites', params: { kind: 'tracks' } } } },
    { label: 'Favourite albums', act: { type: 'open-list', key: 'fav-albums', title: 'Favourite albums', kind: 'albums', source: { cmd: 'favorites', params: { kind: 'albums' } } } },
    { label: 'Playlists', act: { type: 'open-list', key: 'playlists', title: 'Playlists', kind: 'playlists', source: { cmd: 'playlists', params: {} } } },
    { label: 'Mixes', act: { type: 'open-list', key: 'mixes', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } } },
    { label: 'Search', act: { type: 'open-search' } },
];

function frameOf(s) { return s.stack.length ? s.stack[s.stack.length - 1] : null; }

/** what a press on row i of frame f does */
function itemActs(s, f, i) {
    const it = f.items[i];
    if (!it || typeof it !== 'object') return [];
    if (f.kind === 'tracks' || f.kind === 'search') {
        if (it.streamReady === false || (s.unavailable && s.unavailable[it.id])) return [{ type: 'error', code: 'not-available', trackId: it.id }];
        const ids = f.items.map((t) => (t && typeof t.id === 'number' ? t.id : null));
        let start = 0;
        if (ids.length > MAX_PLAY) start = Math.max(0, Math.min(ids.length - MAX_PLAY, i - Math.floor(MAX_PLAY / 2)));
        const win = ids.slice(start, start + MAX_PLAY);
        // ids the service could not take (not numbers) are left out; the index follows
        const keep = win.filter((x) => x !== null);
        const index = win.slice(0, i - start).filter((x) => x !== null).length;
        return [{ type: 'play', tracks: keep, index: index }];
    }
    if (f.kind === 'albums') return [{ type: 'open-list', key: 'album:' + it.id, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'album', params: { albumId: it.id } } }];
    if (f.kind === 'playlists') return [{ type: 'open-list', key: 'playlist:' + it.uuid, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'playlist', params: { uuid: it.uuid } } }];
    if (f.kind === 'mixes') return [{ type: 'open-list', key: 'mix:' + it.id, title: String(it.title || ''), kind: 'tracks', source: { cmd: 'mix', params: { mixId: it.id } } }];
    return [];
}

function libraryRows(s) {
    const r = LIBRARY.slice();
    const p = s.player;
    if (p && p.track && ['playing', 'paused', 'buffering', 'loading'].indexOf(p.state) >= 0) r.push({ label: 'Now playing', sub: p.track.title, act: { type: 'open-now-playing' } });
    return r;
}

function rows(s) {
    if (s.screen === 'LIBRARY') return libraryRows(s).map((r) => ({ label: r.label, sub: r.sub || '', right: '', acts: [r.act], kind: 'menu' }));
    const f = frameOf(s);
    if (s.screen !== 'LIST' || !f) return [];
    const head = f.kind === 'search' ? [{ label: 'New search', sub: f.source.params.query ? 'now: ' + f.source.params.query : '', right: '', kind: 'menu', acts: [{ type: 'open-keyboard' }] }] : [];
    return head.concat(f.items.map((it, i) => {
        const o = it && typeof it === 'object' ? it : {};
        const base = { label: String(o.title || ''), sub: '', right: '', kind: f.kind, item: o, index: i };
        if (f.kind === 'tracks' || f.kind === 'search') {
            base.sub = joinArtists(o.artists);
            base.right = mmss(o.duration);
            base.dim = o.streamReady === false || !!(s.unavailable && s.unavailable[o.id]);
        } else if (f.kind === 'albums') base.sub = joinArtists(o.artists);
        else if (f.kind === 'playlists') base.right = typeof o.numberOfTracks === 'number' ? o.numberOfTracks + ' tracks' : '';
        else if (f.kind === 'mixes') base.sub = typeof o.subTitle === 'string' ? o.subTitle : '';
        return base;
    }));
}

/** what a press on row i of the screen shown does (model events and acts for main.js) */
function rowActs(s, i) {
    if (s.screen === 'LIBRARY') { const r = libraryRows(s)[i]; return r ? [r.act] : []; }
    const f = frameOf(s);
    if (s.screen !== 'LIST' || !f) return [];
    if (f.kind === 'search') return i === 0 ? [{ type: 'open-keyboard' }] : itemActs(s, f, i - 1);
    return itemActs(s, f, i);
}

function cursor(s) {
    if (s.screen === 'LIBRARY') return s.library;
    const f = frameOf(s);
    return f ? { sel: f.sel, top: f.top } : { sel: 0, top: 0 };
}

function keepVisible(sel, top, count) {
    let t = top;
    if (sel < t) t = sel;
    if (sel >= t + VISIBLE) t = sel - VISIBLE + 1;
    return Math.max(0, Math.min(t, Math.max(0, count - VISIBLE)));
}
function move(cur, d, count) {
    if (!count) return { sel: 0, top: 0 };
    const sel = Math.max(0, Math.min(count - 1, (cur.sel || 0) + d));
    return { sel: sel, top: keepVisible(sel, cur.top || 0, count) };
}
/** the rows to draw: [first, last) */
function range(cur, count) {
    const top = keepVisible(Math.min(cur.sel || 0, Math.max(0, count - 1)), cur.top || 0, count);
    return { first: top, last: Math.min(count, top + VISIBLE) };
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

module.exports = { rows: rows, rowActs: rowActs, cursor: cursor, move: move, range: range, needMore: needMore, mmss: mmss,
    Y0: Y0, ROW_H: ROW_H, VISIBLE: VISIBLE, COLS: COLS, PAGE: PAGE, PAGED: PAGED };
