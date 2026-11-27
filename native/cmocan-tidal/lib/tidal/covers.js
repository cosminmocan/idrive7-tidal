'use strict';
/**
 * covers.js - cover art (tidalapi 0.9.0 album.py image(): resources.tidal.com/images/<id, - as />/<w>x<h>.jpg) at
 * 320 x 320, at most MAX_COVER_BYTES, kept in coverDir as <coverId>.jpg (docs/PROTOCOL.md, "covers/"). The cache
 * stays under its total size; the least recently used covers go first (a cover served from the cache is touched).
 *
 *   cover(coverId) -> Promise<Buffer>     clear() removes the cache
 */
const fs = require('fs');
const path = require('path');
const C = require('./config');
const E = require('./errors');

const MAX_COVER_BYTES = 128 * 1024;
const CACHE_BYTES = 20 * 1024 * 1024;
const SIZE = '320x320';
const COVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isJpeg = (b) => b && b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function createCovers(ctx, o) {
    const dir = o.dir;
    const limit = o.cacheBytes || CACHE_BYTES;
    const inflight = {};

    const file = (id) => path.join(dir, id + '.jpg');
    const touch = (f) => { const t = ctx.now() / 1000; try { fs.utimesSync(f, t, t); } catch (e) { /* best effort */ } };

    function fromCache(id) {
        try {
            const b = fs.readFileSync(file(id));
            if (!isJpeg(b) || b.length > MAX_COVER_BYTES) return null;
            touch(file(id));
            return b;
        } catch (e) { return null; }
    }

    /** remove the least recently used covers until the cache fits, never the one just kept */
    function evict(keep) {
        let entries = [];
        try {
            entries = fs.readdirSync(dir).filter((n) => /\.jpg$/.test(n)).map((n) => {
                const st = fs.statSync(path.join(dir, n));
                return { name: n, size: st.size, mtime: st.mtime.getTime() };
            });
        } catch (e) { return; }
        let total = entries.reduce((n, x) => n + x.size, 0);
        entries.sort((a, b) => a.mtime - b.mtime);
        for (let i = 0; i < entries.length && total > limit; i++) {
            if (entries[i].name === keep) continue;
            try { fs.unlinkSync(path.join(dir, entries[i].name)); total -= entries[i].size; } catch (e) { /* gone */ }
        }
    }

    function keep(id, buf) {
        try {
            try { fs.mkdirSync(dir, 448); } catch (e) { if (e.code !== 'EEXIST') throw e; }
            const tmp = path.join(dir, '.' + id + '.' + process.pid + '.tmp');
            fs.writeFileSync(tmp, buf, { mode: 384 });
            fs.renameSync(tmp, file(id));
            touch(file(id));
            evict(id + '.jpg');
        } catch (e) { ctx.log('covers: could not keep ' + id + ': ' + e.message); }
    }

    function fetch(id) {
        const url = ctx.baseUrls.images + id.split('-').join('/') + '/' + SIZE + '.jpg';
        return ctx.netx.request({ method: 'GET', url: url, maxBytes: MAX_COVER_BYTES, timeoutMs: C.TIMEOUT_MS, headers: { 'User-Agent': C.USER_AGENT } }).then((res) => {
            if (res.status !== 200) throw E.fromAnswer(res, 'the cover ' + id);
            if (!isJpeg(res.body)) throw E.tidalError('tidal-error', 'the cover ' + id + ' is not a JPEG', { status: res.status });
            keep(id, res.body);
            return res.body;
        });
    }

    function cover(id) {
        if (typeof id !== 'string' || !COVER_ID.test(id)) return Promise.reject(E.tidalError('bad-request', 'bad cover id'));
        const key = id.toLowerCase();
        const hit = fromCache(key);
        if (hit) return Promise.resolve(hit);
        if (!inflight[key]) {
            inflight[key] = fetch(key).then((b) => { delete inflight[key]; return b; }, (e) => { delete inflight[key]; throw e; });
        }
        return inflight[key];
    }

    function clear() {
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        names.forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } });
        try { fs.rmdirSync(dir); } catch (e) { /* gone */ }
    }

    return { cover: cover, clear: clear };
}

module.exports = { createCovers: createCovers, MAX_COVER_BYTES: MAX_COVER_BYTES, CACHE_BYTES: CACHE_BYTES };
