'use strict';
/**
 * login.js - TIDAL's device login (RFC 8628), ported from tidalapi 0.9.0 session.py get_link_login and
 * _check_link_login. One poll per call; never faster than TIDAL's interval; a network error is "pending".
 *
 *   start() -> { url, userCode, expiresIn, interval }
 *   poll()  -> { state: 'pending' | 'authorized' | 'expired' | 'denied' }
 */
const C = require('./config');
const E = require('./errors');
const H = require('./http');

const SLOW_DOWN_MS = 5000;

function createLogin(ctx) {
    let pending = null;
    let polling = null;

    function start() {
        return H.postForm(ctx, ctx.baseUrls.auth + 'device_authorization', { client_id: C.CLIENT_ID, scope: C.SCOPE }).then((res) => {
            const j = res.json;
            if (res.status !== 200) throw E.fromAnswer(res, 'device_authorization');
            if (!j || typeof j.deviceCode !== 'string' || typeof j.userCode !== 'string' || typeof j.verificationUriComplete !== 'string') {
                throw E.tidalError('tidal-error', 'device_authorization: unexpected answer', { status: res.status });
            }
            const expiresIn = Math.max(1, Math.round(Number(j.expiresIn) || 300));
            const interval = Math.max(1, Math.round(Number(j.interval) || 5));
            const link = j.verificationUriComplete;
            const now = ctx.now();
            pending = {
                deviceCode: j.deviceCode, expiresAt: now + expiresIn * 1000, intervalMs: interval * 1000,
                nextPollAt: now + interval * 1000, tokens: null,
            };
            return { url: /^https:\/\//.test(link) ? link : 'https://' + link.replace(/^http:\/\//, ''), userCode: j.userCode, expiresIn: expiresIn, interval: interval };
        });
    }

    /** the token came: GET sessions for the user and country, then save */
    function finish(p) {
        const t = p.tokens;
        return H.apiGet(ctx, 'sessions', {}, t).then((res) => {
            const j = res.json;
            const userId = j && Number(j.userId);
            const country = j && j.countryCode;
            if (res.status !== 200 || !(userId >= 1) || !/^[A-Z]{2}$/.test(String(country))) {
                ctx.log('login: GET sessions answered ' + res.status);
                return { state: 'pending' };
            }
            ctx.setSession({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, userId: userId, countryCode: country });
            if (pending === p) pending = null;
            return { state: 'authorized' };
        }, (e) => { ctx.log('login: GET sessions failed: ' + e.message); return { state: 'pending' }; });
    }

    function pollOnce(p) {
        if (p.tokens) return finish(p);
        return H.postForm(ctx, ctx.baseUrls.auth + 'token', {
            client_id: C.CLIENT_ID, client_secret: C.CLIENT_SECRET, device_code: p.deviceCode, grant_type: C.GRANT_DEVICE, scope: C.SCOPE,
        }).then((res) => {
            const j = res.json || {};
            if (res.status === 200 && typeof j.access_token === 'string' && typeof j.refresh_token === 'string') {
                p.tokens = {
                    tokenType: 'Bearer', accessToken: j.access_token, refreshToken: j.refresh_token,
                    expiresAt: ctx.now() + Math.max(0, Number(j.expires_in) || 0) * 1000,
                };
                return finish(p);
            }
            const err = String(j.error || '');
            if (err === 'authorization_pending') return { state: 'pending' };
            if (err === 'slow_down') { p.intervalMs += SLOW_DOWN_MS; p.nextPollAt = ctx.now() + p.intervalMs; return { state: 'pending' }; }
            if (err === 'expired_token' || err === 'invalid_grant') { if (pending === p) pending = null; return { state: 'expired' }; }
            if (err === 'access_denied') { if (pending === p) pending = null; return { state: 'denied' }; }
            if (res.status === 429) p.nextPollAt = ctx.now() + E.retryAfter(res.headers, 60) * 1000;
            ctx.log('login: token poll answered ' + res.status + ' ' + err);
            return { state: 'pending' };
        }, (e) => { ctx.log('login: token poll failed: ' + e.message); return { state: 'pending' }; });
    }

    function poll() {
        const p = pending;
        if (!p) return Promise.resolve({ state: ctx.loggedIn() ? 'authorized' : 'expired' });
        const now = ctx.now();
        if (now >= p.expiresAt) { pending = null; return Promise.resolve({ state: 'expired' }); }
        if (polling || now < p.nextPollAt) return Promise.resolve({ state: 'pending' });
        p.nextPollAt = now + p.intervalMs;
        polling = pollOnce(p).then((r) => { polling = null; return r; }, (e) => { polling = null; throw e; });
        return polling;
    }

    function cancel() { pending = null; }

    return { start: start, poll: poll, cancel: cancel };
}

module.exports = { createLogin: createLogin };
