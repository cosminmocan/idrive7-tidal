'use strict';
/**
 * text.js - text for the kit's fonts, which have ASCII (and a few signs) only.
 *
 *   ascii(s)                       accented Latin letters to their plain letters (Știrile -> Stirile, ă â î ș ț ->
 *                                  a a i s t, ß -> ss, Æ -> AE), typographic quotes, dashes and the ellipsis to
 *                                  ASCII, control characters to spaces, anything else to '?' (one per character)
 *   fit(cv, s, size, maxW, font)   ascii(s), cut with '...' so it is at most maxW px wide in that font and size
 *
 * A table, not String.prototype.normalize: the car's Node may be built without the Unicode data. Node 8.9.4 syntax.
 */

const GROUPS = {
    A: 'ÀÁÂÃÄÅĀĂĄǍȀȂ', a: 'àáâãäåāăąǎȁȃª', C: 'ÇĆĈĊČ', c: 'çćĉċč', D: 'ĎĐÐ', d: 'ďđð',
    E: 'ÈÉÊËĒĔĖĘĚȄȆ', e: 'èéêëēĕėęěȅȇ', G: 'ĜĞĠĢǦ', g: 'ĝğġģǧ', H: 'ĤĦ', h: 'ĥħ',
    I: 'ÌÍÎÏĨĪĬĮİǏ', i: 'ìíîïĩīĭįıǐ', J: 'Ĵ', j: 'ĵ', K: 'ĶǨ', k: 'ķĸǩ', L: 'ĹĻĽĿŁ', l: 'ĺļľŀł',
    N: 'ÑŃŅŇŊ', n: 'ñńņňŉŋ', O: 'ÒÓÔÕÖØŌŎŐǑ', o: 'òóôõöøōŏőǒº', R: 'ŔŖŘ', r: 'ŕŗř',
    S: 'ŚŜŞŠȘ', s: 'śŝşšșſ', T: 'ŢŤŦȚ', t: 'ţťŧț', U: 'ÙÚÛÜŨŪŬŮŰŲǓ', u: 'ùúûüũūŭůűųǔ',
    W: 'Ŵ', w: 'ŵ', Y: 'ÝŶŸ', y: 'ýÿŷ', Z: 'ŹŻŽ', z: 'źżž',
    AE: 'ÆǼ', ae: 'æǽ', OE: 'Œ', oe: 'œ', IJ: 'Ĳ', ij: 'ĳ', Th: 'Þ', th: 'þ', ss: 'ß',
    '\'': '‘’‚‛′´', '"': '“”„‟″«»', '-': '‐‑‒–—―−', '...': '…', '.': '·•', x: '×', ' ': '              　',
    '': '­​‌‍⁠﻿',
};
const MAP = Object.create(null);
Object.keys(GROUPS).forEach((to) => { for (const ch of GROUPS[to]) MAP[ch] = to; });

function ascii(v) {
    if (v == null) return '';
    const s = String(v);
    if (/^[\x20-\x7e]*$/.test(s)) return s;
    let out = '';
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c >= 0x20 && c <= 0x7e) out += ch;
        else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) out += ' ';
        else if (MAP[ch] !== undefined) out += MAP[ch];
        else out += '?';
    }
    return out;
}

function fit(cv, v, size, maxW, font) {
    const s = ascii(v);
    const o = { font: font || 'label', literal: true };
    const w = (x) => cv.textWidth(x, size, o);
    if (w(s) <= maxW) return s;
    // the longest start that fits with '...' after it
    let lo = 0, hi = s.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (w(s.slice(0, mid).replace(/\s+$/, '') + '...') <= maxW) lo = mid; else hi = mid - 1;
    }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}

module.exports = { ascii: ascii, fit: fit };
