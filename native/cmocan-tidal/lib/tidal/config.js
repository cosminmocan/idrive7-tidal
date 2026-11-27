'use strict';
/**
 * config.js - TIDAL's addresses and the client this tool presents, ported from python tidalapi 0.9.0
 * (session.py Config, request.py Requests). The client is tidalapi's device client, decoded as tidalapi does.
 */
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');

module.exports = {
    CLIENT_ID: b64(b64('WmxneVNuaGtiVzUw') + b64('V2xkTE1HbDRWQT09')),
    CLIENT_SECRET: b64(b64('TVU1dU9VRm1SRUZxZUhKblNrWktZa3RPVjB4bFFY') + b64('bExSMVpIYlVsT2RWaFFVRXhJVmxoQmRuaEJaejA9')),
    SCOPE: 'r_usr w_usr w_sub',
    GRANT_DEVICE: 'urn:ietf:params:oauth:grant-type:device_code',
    BASE_URLS: {
        auth: 'https://auth.tidal.com/v1/oauth2/',
        api: 'https://api.tidal.com/v1/',
        images: 'https://resources.tidal.com/images/',
    },
    USER_AGENT: 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36',
    CLIENT_VERSION: '2025.7.16',
    TIMEOUT_MS: 15000,
};
