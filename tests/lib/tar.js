'use strict';
/**
 * tar.js - reads a .tgz into its members, for the package tests (no npm packages; Node 8.9.4 and current Node).
 *
 *   const { untgz } = require('./lib/tar');
 *   untgz(buffer) -> [{ name, type: 'file' | 'dir' | 'link' | 'other', mode, size, data }]
 *
 * ustar with its prefix field, pax extended headers (path, linkpath, size) and GNU long names ('L', 'K').
 * Throws on a truncated archive or a header whose checksum is wrong.
 */
const zlib = require('zlib');

function str(buf, off, len) {
    const s = buf.slice(off, off + len);
    const z = s.indexOf(0);
    return (z >= 0 ? s.slice(0, z) : s).toString('utf8');
}

function num(buf, off, len) {
    // base-256 (GNU) for large values: first byte 0x80
    if (buf[off] & 0x80) {
        let v = 0;
        for (let i = 1; i < len; i++) v = v * 256 + buf[off + i];
        return v;
    }
    const s = str(buf, off, len).trim();
    return s ? parseInt(s, 8) : 0;
}

function checksumOk(h) {
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    return sum === num(h, 148, 8);
}

function pax(data) {
    const out = {};
    let i = 0;
    while (i < data.length) {
        const sp = data.indexOf(32, i);
        if (sp < 0) break;
        const len = parseInt(data.slice(i, sp).toString('utf8'), 10);
        if (!(len > 0)) break;
        const rec = data.slice(sp + 1, i + len - 1).toString('utf8');
        const eq = rec.indexOf('=');
        if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
        i += len;
    }
    return out;
}

function untar(buf) {
    const members = [];
    let off = 0;
    let next = {};
    while (off + 512 <= buf.length) {
        const h = buf.slice(off, off + 512);
        if (h.every((b) => b === 0)) break;
        if (!checksumOk(h)) throw new Error('tar: bad header checksum at ' + off);
        const type = String.fromCharCode(h[156] || 48);
        let size = num(h, 124, 12);
        if (next.size !== undefined) size = next.size;
        const start = off + 512;
        if (start + size > buf.length) throw new Error('tar: truncated archive');
        const data = buf.slice(start, start + size);
        off = start + Math.ceil(size / 512) * 512;
        if (type === 'x') { next = Object.assign(next, pax(data)); if (next.size !== undefined) next.size = Number(next.size); continue; }
        if (type === 'g') continue;
        if (type === 'L') { next.path = str(data, 0, data.length); continue; }
        if (type === 'K') { next.linkpath = str(data, 0, data.length); continue; }
        const magic = str(h, 257, 6);
        const prefix = magic.indexOf('ustar') === 0 ? str(h, 345, 155) : '';
        let name = next.path || (prefix ? prefix + '/' : '') + str(h, 0, 100);
        name = name.replace(/^\.\//, '');
        const kind = type === '0' || type === '\0' || type === '7' ? 'file' : type === '5' ? 'dir' : type === '1' || type === '2' ? 'link' : 'other';
        members.push({ name: kind === 'dir' ? name.replace(/\/+$/, '') : name, type: kind, mode: num(h, 100, 8) & 0o7777,
            size: size, data: kind === 'file' ? data : null, linkname: next.linkpath || str(h, 157, 100) });
        next = {};
    }
    return members;
}

function untgz(buf) {
    return untar(zlib.gunzipSync(buf));
}

module.exports = { untgz: untgz, untar: untar };
