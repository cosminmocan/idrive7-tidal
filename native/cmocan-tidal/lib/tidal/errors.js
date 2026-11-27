'use strict';
/**
 * errors.js - every rejection of the TIDAL client is an Error with a control-socket code (docs/PROTOCOL.md),
 * optionally retryAfter (seconds, with rate-limited) and status (the HTTP status, for the log).
 */
const DEFAULT_RATE_WAIT_S = 60;       // tidalapi request.py RATE_LIMIT_BACKOFF
const DEFAULT_ABUSE_WAIT_S = 30 * 60; // tidalapi request.py ABUSE_BACKOFF

function tidalError(code, message, extra) {
    const e = new Error(message || code);
    e.code = code;
    if (extra) Object.keys(extra).forEach((k) => { if (extra[k] !== undefined && extra[k] !== null) e[k] = extra[k]; });
    return e;
}

/** the answer's JSON, or null */
function parseJson(body) {
    try { return JSON.parse(body.toString('utf8')); } catch (e) { return null; }
}

function retryAfter(headers, fallback) {
    const v = Number(headers && headers['retry-after']);
    return isFinite(v) && v > 0 ? Math.ceil(v) : fallback;
}

/** TIDAL's anti-abuse answer: a 403 whose body speaks of abuse or a suspension (tidalapi exceptions.py) */
function isAbuse(status, body) {
    if (status !== 403) return false;
    const t = String(body || '').toLowerCase();
    return t.indexOf('abuse') >= 0 || t.indexOf('suspend') >= 0;
}

/** a 401 about the asset (subStatus 4xxx, e.g. 4005 "Asset is not ready for playback"), not about the token */
function isAssetRefusal(status, json) {
    const s = json && Number(json.subStatus);
    return status === 401 && s >= 4000 && s < 5000;
}

/** an HTTP answer that is not a success -> our error */
function fromAnswer(res, where) {
    const json = parseJson(res.body);
    const text = res.body ? res.body.toString('utf8').slice(0, 200) : '';
    const msg = res.status + ' from ' + where + (json && (json.userMessage || json.error_description || json.error) ? ': ' + (json.userMessage || json.error_description || json.error) : '');
    const extra = { status: res.status };
    if (res.status === 429) return tidalError('rate-limited', msg, Object.assign(extra, { retryAfter: retryAfter(res.headers, DEFAULT_RATE_WAIT_S) }));
    if (isAbuse(res.status, text)) return tidalError('rate-limited', msg, Object.assign(extra, { retryAfter: retryAfter(res.headers, DEFAULT_ABUSE_WAIT_S) }));
    if (res.status === 404) return tidalError('not-found', msg, extra);
    if (isAssetRefusal(res.status, json)) return tidalError('not-available', msg, extra);
    return tidalError('tidal-error', msg, extra);
}

module.exports = { tidalError: tidalError, parseJson: parseJson, fromAnswer: fromAnswer, isAbuse: isAbuse, isAssetRefusal: isAssetRefusal, retryAfter: retryAfter };
