'use strict';
/**
 * stream.js - a track's stream address (tidalapi 0.9.0 media.py Track.get_url: tracks/<id>/urlpostpaywall with
 * urlusagemode=STREAM, audioquality, assetpresentation=FULL; the answer's urls[0]).
 *
 *   streamUrl(trackId, 'LOSSLESS' | 'HIGH') -> { url, codec: 'flac' | 'aac', quality }   // quality: what TIDAL granted
 *
 * LOSSLESS falls back to HIGH. A refusal (401 about the asset, 403, 404, or an answer the player cannot use)
 * moves to the next quality; a rate limit, a network or server failure ends the call at once.
 */
const E = require('./errors');

const ORDER = { LOSSLESS: ['LOSSLESS', 'HIGH'], HIGH: ['HIGH'] };

/** TIDAL's audioQuality -> ours; LOW (96 kbit/s) is not offered */
function grantedQuality(q) {
    const s = String(q || '').toUpperCase();
    if (s === 'LOSSLESS' || s === 'HI_RES' || s === 'HI_RES_LOSSLESS') return 'LOSSLESS';
    if (s === 'HIGH') return 'HIGH';
    return null;
}

/** TIDAL's codec -> what the player reads (FLAC, and AAC in MP4); MQA is a FLAC stream */
function codecOf(codec, quality) {
    const c = String(codec || '').toLowerCase();
    if (!c) return quality === 'LOSSLESS' ? 'flac' : 'aac';
    if (c === 'flac' || c === 'mqa') return 'flac';
    if (c === 'aac' || c.indexOf('mp4a') === 0 || c === 'heaac') return 'aac';
    return null;
}

function createStream(ctx, api) {
    function ask(trackId, q) {
        return api.get('tracks/' + trackId + '/urlpostpaywall', { urlusagemode: 'STREAM', audioquality: q, assetpresentation: 'FULL' }).then((j) => {
            const url = j && Array.isArray(j.urls) ? j.urls[0] : null;
            const quality = grantedQuality(j && j.audioQuality ? j.audioQuality : q);
            const codec = quality ? codecOf(j && j.codec, quality) : null;
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { refused: 'no address' };
            if (j.securityToken || (j.securityType && String(j.securityType).toUpperCase() !== 'NONE')) return { refused: 'encrypted' };
            if (!quality) return { refused: 'quality ' + j.audioQuality };
            if (!codec) return { refused: 'codec ' + j.codec };
            return { url: url, codec: codec, quality: quality };
        }, (e) => {
            if (e.code === 'not-available' || e.code === 'not-found' || (e.code === 'tidal-error' && (e.status === 401 || e.status === 403))) return { refused: e.message };
            throw e;
        });
    }

    function streamUrl(trackId, quality) {
        if (!(typeof trackId === 'number' && Math.floor(trackId) === trackId && trackId >= 1)) return Promise.reject(E.tidalError('bad-request', 'bad track id'));
        if (!ORDER[quality]) return Promise.reject(E.tidalError('bad-request', 'quality must be LOSSLESS or HIGH'));
        if (!ctx.session) return Promise.reject(E.tidalError('not-logged-in', 'not logged in'));
        const order = ORDER[quality];
        const why = [];
        function next(i) {
            if (i >= order.length) return Promise.reject(E.tidalError('not-available', 'track ' + trackId + ' cannot be streamed: ' + why.join('; ')));
            return ask(trackId, order[i]).then((r) => {
                if (r.url) return r;
                why.push(order[i] + ': ' + r.refused);
                return next(i + 1);
            });
        }
        return next(0);
    }

    return { streamUrl: streamUrl };
}

module.exports = { createStream: createStream };
