'use strict';
/**
 * http.js - the two kinds of call the client makes through netx: a form POST to auth.tidal.com and a GET to
 * api.tidal.com with the client's headers (tidalapi request.py basic_request).
 */
const querystring = require('querystring');
const C = require('./config');
const E = require('./errors');

function postForm(ctx, url, fields) {
    return ctx.netx.request({
        method: 'POST', url: url, body: querystring.stringify(fields), timeoutMs: C.TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': C.USER_AGENT },
    }).then((res) => { res.json = E.parseJson(res.body); return res; });
}

function apiGet(ctx, path, params, token) {
    const qs = querystring.stringify(params || {});
    const headers = { 'User-Agent': C.USER_AGENT, 'x-tidal-client-version': C.CLIENT_VERSION };
    if (token) headers.authorization = token.tokenType + ' ' + token.accessToken;
    return ctx.netx.request({ method: 'GET', url: ctx.baseUrls.api + path + (qs ? '?' + qs : ''), headers: headers, timeoutMs: C.TIMEOUT_MS })
        .then((res) => { res.json = E.parseJson(res.body); return res; });
}

module.exports = { postForm: postForm, apiGet: apiGet };
