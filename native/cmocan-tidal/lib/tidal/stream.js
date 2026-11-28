'use strict';
/**
 * stream.js - a track's stream address (tidalapi 0.9.0 media.py Track.get_url: tracks/<id>/urlpostpaywall with
 * urlusagemode=STREAM, audioquality, assetpresentation=FULL; the answer's urls[0]).
 *
 *   streamUrl(trackId, 'LOSSLESS' | 'HIGH') -> { url, codec: 'flac' | 'aac', quality }   // quality: what TIDAL granted
 *
 * LOSSLESS falls back to HIGH. A refusal (401 about the asset, 403, 404, or an answer the player cannot use)
 * moves to the next quality; a rate limit, a network or server failure ends the call at once.
 *
 *   videoUrl(videoId, height) -> { url, quality }   // a video (tidalapi media.py Video.get_url: videos/<id>/urlpostpaywall,
 *                                                   // videoquality HIGH): url is the HLS master playlist, which holds
 *                                                   // every picture size up to 1080p (docs/live-check-results.md
 *                                                   // "Video"); `height` (480, 720, 1080) is chosen from it by the
 *                                                   // service (lib/tidal/hls.js chooseVariant). A refusal: not-available
 */
const E = require('./errors');

const ORDER = { LOSSLESS: ['LOSSLESS', 'HIGH'], HIGH: ['HIGH'] };
const VIDEO_HEIGHTS = [480, 720, 1080];

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

    function videoUrl(videoId, height) {
        if (!(typeof videoId === 'number' && Math.floor(videoId) === videoId && videoId >= 1)) return Promise.reject(E.tidalError('bad-request', 'bad video id'));
        if (VIDEO_HEIGHTS.indexOf(height) < 0) return Promise.reject(E.tidalError('bad-request', 'height must be 480, 720 or 1080'));
        if (!ctx.session) return Promise.reject(E.tidalError('not-logged-in', 'not logged in'));
        return api.get('videos/' + videoId + '/urlpostpaywall', { urlusagemode: 'STREAM', videoquality: 'HIGH', assetpresentation: 'FULL' }).then((j) => {
            const url = j && Array.isArray(j.urls) ? j.urls[0] : null;
            if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw E.tidalError('not-available', 'video ' + videoId + ': no address');
            if (j.securityToken || (j.securityType && String(j.securityType).toUpperCase() !== 'NONE')) throw E.tidalError('not-available', 'video ' + videoId + ': encrypted');
            return { url: url, quality: String(j.videoQuality || 'HIGH').toUpperCase() === 'HIGH' ? 'HIGH' : null };
        }, (e) => {
            if (e.code === 'not-found' || (e.code === 'tidal-error' && (e.status === 401 || e.status === 403))) throw E.tidalError('not-available', 'video ' + videoId + ' cannot be streamed: ' + e.message, { status: e.status });
            throw e;
        });
    }

    return { streamUrl: streamUrl, videoUrl: videoUrl };
}

module.exports = { createStream: createStream };
