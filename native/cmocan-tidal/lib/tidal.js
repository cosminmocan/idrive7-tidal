'use strict';
/**
 * tidal.js - the TIDAL client (docs/INTERNAL-API.md, tasks A2 to A6): a port of the parts of python tidalapi
 * 0.9.0 the car needs. Runs in client.js as the tool's internet uid. Node 8.9.4.
 *
 *   const tidal = createTidal({ netx, sessionFile, coverDir });   // tests: baseUrls, now, pageSize
 *   tidal.loggedIn() / loginStart() / loginPoll() / logout()
 *   tidal.favorites(kind, offset, limit) / playlists / playlist / album / mixes / mix / search -> { items, total }
 *   tidal.streamUrl(trackId, quality) -> { url, codec, quality }
 *   tidal._get(path, params)   // the raw API GET (diagnostics, tests)
 *
 * Every rejection is an Error with a control-socket code (lib/tidal/errors.js).
 */
const C = require('./tidal/config');
const createSessionStore = require('./tidal/session').createSessionStore;
const createLogin = require('./tidal/login').createLogin;
const createApi = require('./tidal/api').createApi;
const createLibrary = require('./tidal/library').createLibrary;
const createStream = require('./tidal/stream').createStream;
const fs = require('fs');
const path = require('path');

/** the cover cache's folder and what is in it (one level: the cache has no subfolders) */
function removeDir(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } });
    try { fs.rmdirSync(dir); } catch (e) { /* gone */ }
}

function createTidal(o) {
    const opts = o || {};
    if (!opts.netx) throw new Error('createTidal: netx is required');
    const store = createSessionStore(opts.sessionFile || '/var/opt/cmocan-tidal/state/session.json');
    const coverDir = opts.coverDir || '/var/opt/cmocan-tidal/state/covers';
    const ctx = {
        netx: opts.netx,
        baseUrls: Object.assign({}, C.BASE_URLS, opts.baseUrls || {}),
        now: opts.now || Date.now,
        log: opts.log || function () {},
        session: store.load(),
    };
    ctx.loggedIn = () => !!ctx.session;
    ctx.setSession = (s) => {
        try { ctx.session = store.save(s); } catch (e) {
            // a disk that refuses the file must not lose the login: keep it in memory for this run
            ctx.log('tidal: could not save the session: ' + e.message);
            ctx.session = Object.assign({ version: 1, tokenType: 'Bearer' }, s);
        }
    };
    ctx.dropSession = () => { ctx.session = null; store.remove(); };

    const login = createLogin(ctx);
    const api = createApi(ctx);
    const library = createLibrary(ctx, api, { pageSize: opts.pageSize });
    const stream = createStream(ctx, api);

    function logout() {
        login.cancel();
        ctx.dropSession();
        removeDir(coverDir);
        return Promise.resolve();
    }

    return {
        loggedIn: ctx.loggedIn,
        loginStart: () => login.start(),
        loginPoll: () => login.poll(),
        logout: logout,
        favorites: library.favorites,
        playlists: library.playlists,
        playlist: library.playlist,
        album: library.album,
        mixes: library.mixes,
        mix: library.mix,
        search: library.search,
        streamUrl: stream.streamUrl,
        // the raw GET the library is built on (tools/live-check.js records fixtures with it)
        _get: (p, params) => api.get(p, params),
    };
}

module.exports = { createTidal: createTidal };
