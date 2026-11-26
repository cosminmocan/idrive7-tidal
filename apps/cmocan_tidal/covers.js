'use strict';
/**
 * covers.js - album covers for the screens: asked for with the `cover` command (a base64 JPEG, docs/PROTOCOL.md),
 * decoded in plain JS (jpeg.js), scaled to a square and registered as a pixel image the canvas draws by id
 * (kit/record.js setImage; on the GPU it is uploaded once).
 *
 *   const covers = createCovers({ request, decode, setImage, size: 320, slots: 12, log });
 *   covers.get(coverId)   { id, w, h } once decoded, else null (the screen draws a placeholder); the first call asks
 *   covers.onChange(fn)   fn() when a cover came
 *
 * Anything wrong (no answer, an error, not base64, not a JPEG, too big, a decoder error) is a placeholder, asked for
 * again after a minute at the earliest. Only `slots` covers are kept; the least recently used makes room.
 * Node 8.9.4 syntax.
 */
const MAX_BYTES = 256 * 1024;          // the contract says at most 128 KiB; twice that is refused
const RETRY_MS = 60000;

function scale(src, sw, sh, size) {
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        const y0 = Math.floor(y * sh / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / size));
        for (let x = 0; x < size; x++) {
            const x0 = Math.floor(x * sw / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / size));
            let r = 0, g = 0, b = 0, n = 0;
            for (let yy = y0; yy < y1 && yy < sh; yy++) {
                for (let xx = x0; xx < x1 && xx < sw; xx++) {
                    const i = (yy * sw + xx) * 4;
                    r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
                }
            }
            const o = (y * size + x) * 4;
            out[o] = n ? Math.round(r / n) : 0; out[o + 1] = n ? Math.round(g / n) : 0; out[o + 2] = n ? Math.round(b / n) : 0; out[o + 3] = 255;
        }
    }
    return out;
}

function createCovers(o) {
    const size = o.size || 320, slots = o.slots || 12, baseId = o.baseId || 200;
    const log = o.log || { warn() {}, info() {} };
    const now = o.now || Date.now;
    const entries = new Map();          // coverId -> { state: 'loading' | 'ok' | 'failed', id, at, used }
    const listeners = [];
    let used = 0;

    function slotFor() {
        const ok = [];
        entries.forEach((e, k) => { if (e.state === 'ok') ok.push({ k: k, e: e }); });
        const taken = {};
        ok.forEach((x) => { taken[x.e.id] = true; });
        for (let i = 0; i < slots; i++) if (!taken[baseId + i]) return baseId + i;
        ok.sort((a, b) => a.e.used - b.e.used);
        entries.delete(ok[0].k);
        return ok[0].e.id;
    }
    function fail(coverId, why) {
        entries.set(coverId, { state: 'failed', at: now() });
        log.warn('cover ' + String(coverId).slice(0, 40) + ': ' + why);
    }
    function decodeAnswer(coverId, a) {
        if (!a || a.ok !== true || typeof a.data !== 'string') return fail(coverId, 'no cover (' + (a && a.error) + ')');
        if (a.data.length > MAX_BYTES * 4 / 3 + 4) return fail(coverId, 'too big');
        const buf = Buffer.from(a.data, 'base64');
        if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return fail(coverId, 'not a JPEG');
        let img;
        try { img = o.decode(buf, { formatAsRGBA: true, maxResolutionInMP: 4, maxMemoryUsageInMB: 64, tolerantDecoding: true }); } catch (e) { return fail(coverId, 'decode: ' + (e && e.message)); }
        if (!img || !(img.width > 0) || !(img.height > 0) || !img.data || img.data.length < img.width * img.height * 4) return fail(coverId, 'decoded to nothing');
        const id = slotFor();
        try { o.setImage(id, size, size, scale(img.data, img.width, img.height, size)); } catch (e) { return fail(coverId, 'image: ' + (e && e.message)); }
        entries.set(coverId, { state: 'ok', id: id, used: ++used });
        listeners.forEach((fn) => { try { fn(); } catch (e) { /* drawing */ } });
        return undefined;
    }

    function get(coverId) {
        if (typeof coverId !== 'string' || !coverId) return null;
        const e = entries.get(coverId);
        if (e && e.state === 'ok') { e.used = ++used; return { id: e.id, w: size, h: size }; }
        if (e && (e.state === 'loading' || now() - e.at < RETRY_MS)) return null;
        entries.set(coverId, { state: 'loading' });
        Promise.resolve()
            .then(() => o.request('cover', { coverId: coverId }))
            .then((a) => decodeAnswer(coverId, a), (err) => fail(coverId, String(err)))
            .catch((err) => fail(coverId, String(err)));
        return null;
    }

    return { get: get, onChange: (fn) => { listeners.push(fn); } };
}

module.exports = { createCovers: createCovers, scale: scale };
