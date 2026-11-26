'use strict';
/**
 * api.js - authenticated GETs to api.tidal.com/v1 (tidalapi 0.9.0 request.py basic_request and
 * _refresh_access_token, session.py token_refresh):
 *
 * - the access token is refreshed when less than a minute is left (TOKEN_EXPIRY_MARGIN);
 * - a 401 causes one refresh and one retry; any number of requests that need a refresh at once share one;
 * - a refresh TIDAL refuses (400/401) deletes the session: 'login-expired';
 * - after a 429 (or TIDAL's abuse 403) nothing is sent until TIDAL's wait is over (tidalapi's backoff).
 *
 *   get(path, params) -> Promise<JSON>
 */
const C = require('./config');
const E = require('./errors');
const H = require('./http');

const EXPIRY_MARGIN_MS = 60 * 1000;

function createApi(ctx) {
    let refreshing = null;
    let backoffUntil = 0;

    /** a new access token, once for every caller that sent staleToken */
    function refresh(staleToken) {
        if (refreshing) return refreshing;
        const s = ctx.session;
        if (!s) return Promise.reject(E.tidalError('login-expired', 'the session was removed'));
        if (s.accessToken !== staleToken) return Promise.resolve();
        refreshing = H.postForm(ctx, ctx.baseUrls.auth + 'token', {
            grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: C.CLIENT_ID, client_secret: C.CLIENT_SECRET,
        }).then((res) => {
            const j = res.json;
            if (res.status === 200 && j && typeof j.access_token === 'string' && j.access_token) {
                if (ctx.session !== s) throw E.tidalError('not-logged-in', 'logged out during the refresh');
                // TIDAL may rotate the refresh token; without a new one the old one stays valid
                ctx.setSession({
                    accessToken: j.access_token,
                    refreshToken: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : s.refreshToken,
                    expiresAt: ctx.now() + Math.max(0, Number(j.expires_in) || 0) * 1000,
                    userId: s.userId, countryCode: s.countryCode,
                });
                return undefined;
            }
            if (res.status === 400 || res.status === 401) {
                if (ctx.session === s) ctx.dropSession();
                throw E.tidalError('login-expired', 'TIDAL refused the saved login: ' + res.status + ' ' + ((j && (j.error_description || j.error)) || ''), { status: res.status });
            }
            throw E.fromAnswer(res, 'the token refresh');
        }).then((v) => { refreshing = null; return v; }, (e) => { refreshing = null; throw e; });
        return refreshing;
    }

    function holdBack(err) {
        if (err.code === 'rate-limited') backoffUntil = Math.max(backoffUntil, ctx.now() + err.retryAfter * 1000);
        return err;
    }

    function send(path, params, retried) {
        const s = ctx.session;
        if (!s) return Promise.reject(E.tidalError('not-logged-in', 'not logged in'));
        const token = { tokenType: s.tokenType || 'Bearer', accessToken: s.accessToken };
        const q = { countryCode: s.countryCode };
        Object.keys(params || {}).forEach((k) => { if (params[k] !== undefined && params[k] !== null) q[k] = params[k]; });
        return H.apiGet(ctx, path, q, token).then((res) => {
            if (res.status >= 200 && res.status < 300) {
                if (res.json === null) throw E.tidalError('tidal-error', 'not JSON from ' + path, { status: res.status });
                return res.json;
            }
            if (res.status === 401 && !retried && !E.isAssetRefusal(res.status, res.json)) {
                return refresh(token.accessToken).then(() => send(path, params, true));
            }
            throw holdBack(E.fromAnswer(res, path));
        });
    }

    function get(path, params) {
        const s = ctx.session;
        if (!s) return Promise.reject(E.tidalError('not-logged-in', 'not logged in'));
        const wait = backoffUntil - ctx.now();
        if (wait > 0) return Promise.reject(E.tidalError('rate-limited', 'waiting as TIDAL asked', { retryAfter: Math.ceil(wait / 1000) }));
        let first = Promise.resolve();
        if (s.expiresAt - ctx.now() <= EXPIRY_MARGIN_MS) {
            first = refresh(s.accessToken).catch((e) => {
                if (e.code === 'login-expired' || e.code === 'not-logged-in') throw e;
                ctx.log('tidal: early refresh failed, trying the old token: ' + e.message);
            });
        }
        return first.then(() => send(path, params, false));
    }

    return { get: get };
}

module.exports = { createApi: createApi };
