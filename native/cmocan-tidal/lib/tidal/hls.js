'use strict';
/**
 * hls.js - TIDAL's video playlists (HLS, RFC 8216), as the live check found them (docs/live-check-results.md
 * "Video"): a master playlist with one variant per picture size (RESOLUTION, BANDWIDTH, CODECS avc1 + mp4a), each a
 * VOD media playlist of MPEG-TS segments (#EXTINF durations, addresses relative or absolute), not encrypted.
 * Pure functions, no network: the service fetches the playlists and the segments (playback.js).
 *
 *   isMaster(text)                     -> true for a master playlist (#EXT-X-STREAM-INF)
 *   parseMaster(text, baseUrl)         -> [{ url, bandwidth, width, height, codecs }]     (throws tidal-error)
 *   chooseVariant(variants, height)    -> the variant closest to `height` and not above it when a lower one exists
 *   parseMedia(text, baseUrl)          -> { segments: [{ url, duration, start }], duration, targetDuration, vod,
 *                                           encrypted }                                  (throws tidal-error)
 *   segmentAt(segments, position)      -> the index of the segment holding `position` (seconds; past the end: the last)
 *
 * Node 8.9.4.
 */
const urlMod = require('url');
const E = require('./errors');

function lines(text) {
    if (typeof text !== 'string') throw E.tidalError('tidal-error', 'the playlist is not text');
    const l = text.replace(/^﻿/, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length);
    if (l[0] !== '#EXTM3U') throw E.tidalError('tidal-error', 'not an HLS playlist');
    return l;
}

/** NAME=value,NAME="quoted, with commas" -> { NAME: value } */
function attributes(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[2][0] === '"' ? m[2].slice(1, -1) : m[2];
    return out;
}

function resolve(base, ref) {
    const u = urlMod.resolve(base, ref);
    if (!/^https?:\/\//i.test(u)) throw E.tidalError('tidal-error', 'a playlist address that is not http(s)');
    return u;
}

function isMaster(text) {
    try { return lines(text).some((l) => l.indexOf('#EXT-X-STREAM-INF:') === 0); } catch (e) { return false; }
}

function parseMaster(text, baseUrl) {
    const l = lines(text);
    const out = [];
    for (let i = 0; i < l.length; i++) {
        if (l[i].indexOf('#EXT-X-STREAM-INF:') !== 0) continue;
        const a = attributes(l[i].slice('#EXT-X-STREAM-INF:'.length));
        let j = i + 1;
        while (j < l.length && l[j][0] === '#') j++;
        if (j >= l.length) break;
        const r = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || '');
        const v = { url: resolve(baseUrl, l[j]), bandwidth: Number(a.BANDWIDTH) || 0, width: r ? Number(r[1]) : null, height: r ? Number(r[2]) : null,
            codecs: a.CODECS || null };
        out.push(v);
        i = j;
    }
    if (!out.length) throw E.tidalError('tidal-error', 'the master playlist has no variant');
    return out;
}

/** the highest variant not above `height`; with none that low, the lowest; equal heights: the higher bandwidth */
function chooseVariant(variants, height) {
    const v = (variants || []).filter(Boolean);
    if (!v.length) return null;
    const sized = v.filter((x) => typeof x.height === 'number' && x.height > 0);
    const better = (a, b) => (b.bandwidth || 0) > (a.bandwidth || 0) ? b : a;
    if (!sized.length) return v.reduce(better);
    const fit = sized.filter((x) => x.height <= height);
    if (fit.length) {
        const top = Math.max.apply(null, fit.map((x) => x.height));
        return fit.filter((x) => x.height === top).reduce(better);
    }
    const low = Math.min.apply(null, sized.map((x) => x.height));
    return sized.filter((x) => x.height === low).reduce(better);
}

function parseMedia(text, baseUrl) {
    const l = lines(text);
    const segments = [];
    let duration = 0, target = null, vod = false, encrypted = false, pending = null;
    l.forEach((s) => {
        if (s.indexOf('#EXTINF:') === 0) { pending = Math.max(0, parseFloat(s.slice(8)) || 0); return; }
        if (s.indexOf('#EXT-X-TARGETDURATION:') === 0) { target = Number(s.slice(22)) || null; return; }
        if (s === '#EXT-X-PLAYLIST-TYPE:VOD') { vod = true; return; }
        if (s === '#EXT-X-ENDLIST') { vod = true; return; }
        if (s.indexOf('#EXT-X-KEY:') === 0) { const a = attributes(s.slice(11)); if (a.METHOD && a.METHOD !== 'NONE') encrypted = true; return; }
        if (s[0] === '#') return;
        if (pending === null) return;   // an address without its #EXTINF: not a segment of ours
        segments.push({ url: resolve(baseUrl, s), duration: pending, start: duration });
        duration += pending;
        pending = null;
    });
    if (!segments.length) throw E.tidalError('tidal-error', 'the playlist has no segment');
    return { segments: segments, duration: duration, targetDuration: target, vod: vod, encrypted: encrypted };
}

function segmentAt(segments, position) {
    const p = Math.max(0, Number(position) || 0);
    for (let i = 0; i < segments.length; i++) if (p < segments[i].start + segments[i].duration) return i;
    return Math.max(0, segments.length - 1);
}

module.exports = { isMaster: isMaster, parseMaster: parseMaster, chooseVariant: chooseVariant, parseMedia: parseMedia, segmentAt: segmentAt };
