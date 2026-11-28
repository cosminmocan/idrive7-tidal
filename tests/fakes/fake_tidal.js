'use strict';
/**
 * fake_tidal.js - a local stand-in for TIDAL (docs/INTERNAL-API.md, "Test fakes"): the device login and tokens
 * (auth.tidal.com/v1/oauth2), the API (api.tidal.com/v1), the images (resources.tidal.com/images) and a file
 * server for the tracks' bytes, with faults on demand. Shapes follow python tidalapi 0.9.0. Node 8.9.4 syntax.
 *
 *   const fake = await createFakeTidal({ tls: { key, cert } });  // tls optional (plain http otherwise)
 *   fake.baseUrls                // { auth, api, images }: give these to createTidal
 *   fake.log                     // every request: { method, path, query, headers, form, at }
 *   fake.approve() / deny() / expireLogin()          // the pending device login
 *   fake.issueTokens()           // a valid token pair, as after a login: { accessToken, refreshToken }
 *   fake.expireAccessTokens()    // every access token now gets 401 "The token has expired."
 *   fake.revokeRefreshTokens()   // every refresh token is now refused (400 invalid_grant)
 *   fake.counts.refresh          // refresh_token grants answered
 *   fake.fault({ path, method, times, status, headers, body, drop, stall, delayMs })   // the next matching requests
 *   fake.streams[trackId] = { LOSSLESS: <answer or {status, body}>, HIGH: ... }   // urlpostpaywall answers
 *   fake.videoStreams[videoId] = { HIGH: <answer or {status, body}> }   // videos/<id>/urlpostpaywall answers
 *   fake.data.playlistItems[uuid] = [{ type: 'track' | 'video', id }]  // playlists/<uuid>/items (else its tracks)
 *   fake.data.mixItems[mixId] = [{ type: 'track' | 'video', id }]      // a mix page's items (else its tracks)
 *   fake.files[name] = Buffer; fake.fileUrl(name); fake.fileFault = { name, cutAfter, stallAfter }
 *   fake.urlAt(host, name)       the file's address at a made-up host name (resolved by the fake's DNS server)
 *   fake.addVideoHls(videoId, { host, variants: [{ width, height, bandwidth, host, segments: [{ duration, data }] }] })
 *                                -> the master's address. An HLS video as TIDAL serves one (docs/live-check-results.md
 *                                "Video"): the master playlist at `host` (videos/<id>/urlpostpaywall answers it), each
 *                                variant's VOD playlist and MPEG-TS segments at the variant's host (the master lists it
 *                                by its absolute address; the segments: relative and absolute addresses in turn).
 *                                Served from files/hls/<id>/master.m3u8, <height>/index.m3u8, <height>/seg-<i>.ts
 *   createFakeTidal({ dns: true }): fake.dnsServer ('127.0.0.1:<port>', for a lease's dns list), a DNS server (UDP)
 *                                that answers the names in fake.hosts (name -> IPv4; addVideoHls adds its hosts) and
 *                                no other (NXDOMAIN); every question in fake.dnsLog: { name, type }
 *   fake.covers[coverId] = Buffer (a JPEG; one is made up for any coverId of the catalogue otherwise)
 *   fake.data                    // the catalogue (tests/fixtures/tidal/library.json), changeable
 *   fake.pageMax                 // the largest page the fake gives (TIDAL caps limit too)
 *   await fake.close();
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const urlMod = require('url');
const dgram = require('dgram');

const LIBRARY = path.join(__dirname, '..', 'fixtures', 'tidal', 'library.json');

// the device client of tidalapi 0.9.0 (session.py, Config), decoded the same way
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const CLIENT_ID = b64(b64('WmxneVNuaGtiVzUw') + b64('V2xkTE1HbDRWQT09'));
const CLIENT_SECRET = b64(b64('TVU1dU9VRm1SRUZxZUhKblNrWktZa3RPVjB4bFFY') + b64('bExSMVpIYlVsT2RWaFFVRXhJVmxoQmRuaEJaejA9'));
const SCOPE = 'r_usr w_usr w_sub';

/** a tiny valid-looking JPEG: SOI, a comment with the id, EOI */
function jpeg(id, size) {
    const n = Math.max(16, size || 64);
    const b = Buffer.alloc(n, 0x20);
    b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xfe;
    b.writeUInt16BE(Math.min(0xffff, n - 6), 4);
    Buffer.from(String(id)).copy(b, 6, 0, n - 8);
    b[n - 2] = 0xff; b[n - 1] = 0xd9;
    return b;
}

function createFakeTidal(o) {
    const opts = o || {};
    const fake = {
        log: [], faults: [], streams: {}, videoStreams: {}, hlsMasters: {}, files: {}, covers: {}, fileFault: null, hosts: {}, dnsLog: [],
        data: JSON.parse(fs.readFileSync(LIBRARY, 'utf8')),
        pageMax: opts.pageMax || 100, tokenLifetime: opts.tokenLifetime || 604800,
        rotateRefreshTokens: !!opts.rotateRefreshTokens,
        counts: { refresh: 0, deviceToken: 0, sessions: 0 },
        login: null, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
    };
    let seq = 0;
    const access = {};   // token -> 'ok' | 'expired'
    const refresh = {};  // token -> 'ok' | 'revoked'
    const sockets = [];

    function newTokens() {
        seq++;
        const a = 'fake-access-' + seq + '-' + Date.now();
        const r = 'fake-refresh-' + seq + '-' + Date.now();
        access[a] = 'ok';
        refresh[r] = 'ok';
        return { accessToken: a, refreshToken: r };
    }
    fake.issueTokens = newTokens;
    fake.expireAccessTokens = () => { Object.keys(access).forEach((k) => { access[k] = 'expired'; }); };
    fake.revokeRefreshTokens = () => { Object.keys(refresh).forEach((k) => { refresh[k] = 'revoked'; }); };
    fake.approve = () => { if (fake.login) fake.login.state = 'authorized'; };
    fake.deny = () => { if (fake.login) fake.login.state = 'denied'; };
    fake.expireLogin = () => { if (fake.login) fake.login.state = 'expired'; };
    fake.fault = (f) => { fake.faults.push(Object.assign({ times: 1 }, f)); };
    fake.requests = (re) => fake.log.filter((e) => (typeof re === 'string' ? e.path === re : re.test(e.path)));

    const trackById = (id) => fake.data.tracks.filter((t) => t && t.id === Number(id))[0];
    const albumById = (id) => fake.data.albums.filter((a) => a && a.id === Number(id))[0];
    const videoById = (id) => (fake.data.videos || []).filter((v) => v && v.id === Number(id))[0];
    /** [{ type, id }] -> the objects, each with its type as TIDAL's mixed lists give it */
    const media = (list) => (list || []).map((x) => ({ type: x.type, item: x.type === 'video' ? videoById(x.id) : trackById(x.id) })).filter((x) => x.item);

    function send(res, status, body, headers) {
        const isBuf = Buffer.isBuffer(body);
        const data = isBuf ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        res.writeHead(status, Object.assign({ 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', 'Content-Length': data.length }, headers || {}));
        res.end(data);
    }
    const apiError = (res, status, subStatus, msg) => send(res, status, { status: status, subStatus: subStatus, userMessage: msg });

    function paged(res, q, list) {
        const offset = Math.max(0, Number(q.offset) || 0);
        const limit = Math.min(fake.pageMax, q.limit === undefined ? 10 : Math.max(0, Number(q.limit) || 0));
        send(res, 200, { limit: limit, offset: offset, totalNumberOfItems: list.length, items: list.slice(offset, offset + limit) });
    }

    /* ---------- auth.tidal.com/v1/oauth2 ---------- */
    function auth(req, res, p, form) {
        if (req.method !== 'POST') return apiError(res, 405, 0, 'method');
        if (p === 'device_authorization') {
            if (form.client_id !== CLIENT_ID) return send(res, 401, { status: 401, error: 'invalid_client', sub_status: 1002, error_description: 'Client not found' });
            seq++;
            const code = 'ABC' + String.fromCharCode(65 + (seq % 26)) + 'E';
            fake.login = { deviceCode: 'fake-device-' + seq, userCode: code, state: 'pending', expiresIn: opts.loginExpiresIn || 300, interval: opts.loginInterval || 2 };
            return send(res, 200, {
                deviceCode: fake.login.deviceCode, userCode: code, verificationUri: 'link.tidal.com',
                verificationUriComplete: 'link.tidal.com/' + code, expiresIn: fake.login.expiresIn, interval: fake.login.interval,
            });
        }
        if (p !== 'token') return apiError(res, 404, 0, 'not found');
        if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) return send(res, 401, { status: 401, error: 'invalid_client', sub_status: 1002, error_description: 'Client not found' });
        if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
            fake.counts.deviceToken++;
            const l = fake.login;
            if (!l || form.device_code !== l.deviceCode) return send(res, 400, { status: 400, error: 'invalid_grant', sub_status: 1100, error_description: 'Device code not found' });
            if (l.state === 'pending') return send(res, 400, { status: 400, error: 'authorization_pending', sub_status: 1002, error_description: 'Device Authorization code is not authorized yet' });
            if (l.state === 'expired') return send(res, 400, { status: 400, error: 'expired_token', sub_status: 1003, error_description: 'Device code has expired' });
            if (l.state === 'denied') return send(res, 400, { status: 400, error: 'access_denied', sub_status: 1004, error_description: 'The user denied the request' });
            l.state = 'used';
            const t = newTokens();
            return send(res, 200, {
                scope: SCOPE, user: { userId: fake.data.userId, countryCode: fake.data.countryCode },
                clientName: 'fake', token_type: 'Bearer', access_token: t.accessToken, refresh_token: t.refreshToken,
                expires_in: fake.tokenLifetime, user_id: fake.data.userId,
            });
        }
        if (form.grant_type === 'refresh_token') {
            fake.counts.refresh++;
            if (refresh[form.refresh_token] !== 'ok') return send(res, 400, { status: 400, error: 'invalid_grant', sub_status: 1002, error_description: 'Token could not be verified' });
            seq++;
            const a = 'fake-access-' + seq + '-' + Date.now();
            access[a] = 'ok';
            const answer = { scope: SCOPE, user: { userId: fake.data.userId, countryCode: fake.data.countryCode }, token_type: 'Bearer', access_token: a, expires_in: fake.tokenLifetime, user_id: fake.data.userId };
            if (fake.rotateRefreshTokens) {
                refresh[form.refresh_token] = 'revoked';
                const r = 'fake-refresh-' + seq + '-' + Date.now();
                refresh[r] = 'ok';
                answer.refresh_token = r;
            }
            return send(res, 200, answer);
        }
        return send(res, 400, { status: 400, error: 'unsupported_grant_type', sub_status: 1002, error_description: 'grant type' });
    }

    /* ---------- api.tidal.com/v1 ---------- */
    function page(rows) { return { id: 'fake', title: 'fake page', rows: rows.map((m) => ({ modules: [m] })) }; }
    function api(req, res, p, q) {
        const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (!m || !access[m[1]]) return apiError(res, 401, 11002, 'Missing or invalid token');
        if (access[m[1]] === 'expired') return apiError(res, 401, 11003, 'The token has expired. (Expired on time)');
        if (p === 'sessions') {
            fake.counts.sessions++;
            return send(res, 200, { sessionId: 'fake-session', userId: fake.data.userId, countryCode: fake.data.countryCode, channelId: 1, partnerId: 1, client: { id: 1, name: 'fake' } });
        }
        if (q.countryCode !== fake.data.countryCode) return apiError(res, 400, 1002, 'countryCode is missing or wrong');
        const d = fake.data;
        let mm;
        const tracks = (ids) => (ids || []).map(trackById).filter(Boolean);
        if ((mm = /^users\/(\d+)\/(.*)$/.exec(p))) {
            if (Number(mm[1]) !== d.userId) return apiError(res, 403, 4005, 'You can only access your own user');
            if (mm[2] === 'favorites/tracks') return paged(res, q, (d.favoriteTracksItems || tracks(d.favoriteTracks)).map((t, i) => ({ created: '2024-01-0' + ((i % 9) + 1) + 'T00:00:00.000+0000', item: t })));
            if (mm[2] === 'favorites/videos') return paged(res, q, (d.favoriteVideos || []).map(videoById).filter(Boolean).map((v) => ({ created: '2024-01-01T00:00:00.000+0000', item: v })));
            if (mm[2] === 'favorites/albums') return paged(res, q, d.favoriteAlbums.map(albumById).filter(Boolean).map((a) => ({ created: '2024-01-01T00:00:00.000+0000', item: a })));
            if (mm[2] === 'playlistsAndFavoritePlaylists') {
                return paged(res, Object.assign({}, q, { limit: Math.min(50, Number(q.limit) || 0) }),
                    d.playlists.map((pl, i) => ({ type: i === 0 ? 'USER_CREATED' : 'USER_FAVORITE', created: '2024-01-01T00:00:00.000+0000', playlist: pl })));
            }
            return apiError(res, 404, 2001, 'not found');
        }
        if ((mm = /^playlists\/([^/]+)\/tracks$/.exec(p))) {
            if (!d.playlistTracks[mm[1]]) return apiError(res, 404, 2001, 'Playlist could not be found');
            return paged(res, q, tracks(d.playlistTracks[mm[1]]));
        }
        if ((mm = /^playlists\/([^/]+)\/items$/.exec(p))) {
            // tidalapi playlist.py items(): tracks and videos, each { item, type, cut }
            const items = (d.playlistItems || {})[mm[1]] || (d.playlistTracks[mm[1]] ? d.playlistTracks[mm[1]].map((id) => ({ type: 'track', id: id })) : null);
            if (!items) return apiError(res, 404, 2001, 'Playlist could not be found');
            return paged(res, q, media(items).map((x) => ({ item: x.item, type: x.type, cut: null })));
        }
        if ((mm = /^albums\/(\d+)\/tracks$/.exec(p))) {
            if (!d.albumTracks[mm[1]]) return apiError(res, 404, 2001, 'Album not found');
            return paged(res, q, tracks(d.albumTracks[mm[1]]));
        }
        if (p === 'pages/my_collection_my_mixes') {
            return send(res, 200, page([{ type: 'MIX_LIST', title: 'My Mixes', pagedList: { limit: 50, offset: 0, totalNumberOfItems: d.mixes.length, items: d.mixes } }]));
        }
        if (p === 'pages/mix') {
            const mix = d.mixes.filter((x) => x.id === q.mixId)[0];
            if (!mix) return send(res, 200, page([]));
            const mixed = (d.mixItems || {})[q.mixId];
            const list = mixed ? media(mixed).map((x) => x.item) : tracks(d.mixTracks[q.mixId]);
            return send(res, 200, page([{ type: 'MIX_HEADER', title: '', mix: mix },
                { type: 'TRACK_LIST', title: '', pagedList: { limit: list.length, offset: 0, totalNumberOfItems: list.length, items: list } }]));
        }
        if (p === 'search') {
            if (!q.query) return apiError(res, 400, 1002, 'query is missing');
            const list = tracks(d.searchTracks);
            const offset = Number(q.offset) || 0;
            const limit = Math.min(fake.pageMax, Number(q.limit) || 10);
            const empty = { limit: limit, offset: offset, totalNumberOfItems: 0, items: [] };
            return send(res, 200, { artists: empty, albums: empty, playlists: empty, videos: empty, topHit: null,
                tracks: { limit: limit, offset: offset, totalNumberOfItems: list.length, items: list.slice(offset, offset + limit) } });
        }
        if ((mm = /^tracks\/(\d+)$/.exec(p))) {
            // one track (tidalapi media.py Track._get): the same object as in the lists; 404 when TIDAL has none
            const t = trackById(mm[1]);
            return t ? send(res, 200, t) : apiError(res, 404, 2001, 'Track not found');
        }
        if ((mm = /^videos\/(\d+)$/.exec(p))) {
            const v = videoById(mm[1]);
            return v ? send(res, 200, v) : apiError(res, 404, 2001, 'Video not found');
        }
        if ((mm = /^videos\/(\d+)\/urlpostpaywall$/.exec(p))) {
            // docs/live-check-results.md "Video": an HLS master playlist's address in urls[0]
            const id = Number(mm[1]);
            const s = fake.videoStreams[id];
            const a = s ? s[q.videoquality] : undefined;
            if (a && a.status) return send(res, a.status, a.body || '', a.headers);
            if (a) return send(res, 200, a);
            if (s || !videoById(id)) return apiError(res, 401, 4005, 'Asset is not ready for playback');
            return send(res, 200, { videoId: id, streamType: 'ON_DEMAND', assetPresentation: 'FULL', videoQuality: q.videoquality,
                urls: [fake.hlsMasters[id] || fake.fileUrl(id + '/master.m3u8')], streamingSessionId: 'fake' });
        }
        if ((mm = /^tracks\/(\d+)\/urlpostpaywall$/.exec(p))) {
            const id = Number(mm[1]);
            const quality = q.audioquality;
            const s = fake.streams[id];
            const a = s ? s[quality] : undefined;
            if (a && a.status) return send(res, a.status, a.body || '', a.headers);
            if (a) return send(res, 200, a);
            if (s || !trackById(id)) return apiError(res, 401, 4005, 'Asset is not ready for playback');
            const ext = quality === 'LOSSLESS' ? 'flac' : 'm4a';
            return send(res, 200, { trackId: id, assetPresentation: 'FULL', audioMode: 'STEREO', audioQuality: quality,
                codec: quality === 'LOSSLESS' ? 'FLAC' : 'AAC', streamingSessionId: 'fake', urls: [fake.fileUrl(id + '.' + ext)], securityType: null, securityToken: null });
        }
        return apiError(res, 404, 2001, 'The resource could not be found');
    }

    /* ---------- resources.tidal.com/images ---------- */
    function images(req, res, p) {
        const m = /^((?:[0-9a-f]+\/){4}[0-9a-f]+)\/(\d+)x(\d+)\.jpg$/.exec(p);
        if (!m) return send(res, 404, '');
        const id = m[1].split('/').join('-');
        let buf = fake.covers[id];
        if (!buf) {
            const known = fake.data.albums.some((a) => a && a.cover === id) || fake.data.tracks.some((t) => t && t.album && t.album.cover === id) ||
                fake.data.playlists.some((pl) => pl.squareImage === id);
            if (!known) return send(res, 404, '');
            buf = jpeg(id + ' ' + m[2] + 'x' + m[3], 2048);
        }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
    }

    /* ---------- the file server ---------- */
    function files(req, res, name) {
        const buf = fake.files[name];
        if (!buf) return send(res, 404, '');
        const m = /bytes=(\d+)-/.exec(req.headers.range || '');
        const start = m ? Math.min(Number(m[1]), buf.length) : 0;
        const body = buf.slice(start);
        const type = /\.flac$/.test(name) ? 'audio/flac' : /\.m3u8$/.test(name) ? 'application/vnd.apple.mpegurl' : /\.ts$/.test(name) ? 'video/mp2t' : 'audio/mp4';
        const head = { 'Content-Type': type, 'Content-Length': body.length, 'Accept-Ranges': 'bytes' };
        if (m) head['Content-Range'] = 'bytes ' + start + '-' + (buf.length - 1) + '/' + buf.length;
        res.writeHead(m ? 206 : 200, head);
        const f = fake.fileFault && fake.fileFault.name === name ? fake.fileFault : null;
        if (f && f.cutAfter !== undefined) { res.write(body.slice(0, f.cutAfter)); setTimeout(() => req.socket.destroy(), 30); return; }
        if (f && f.stallAfter !== undefined) { res.write(body.slice(0, f.stallAfter)); return; }
        res.end(body);
    }

    function route(req, res, body) {
        const u = urlMod.parse(req.url);
        const q = Object.assign({}, querystring.parse(u.query || ''));
        const form = /x-www-form-urlencoded/.test(req.headers['content-type'] || '') ? Object.assign({}, querystring.parse(body.toString())) : null;
        const p = decodeURIComponent(u.pathname || '');
        const entry = { method: req.method, path: p, query: q, headers: req.headers, form: form, at: Date.now() };
        fake.log.push(entry);
        for (let i = 0; i < fake.faults.length; i++) {
            const f = fake.faults[i];
            const pathOk = f.path === undefined || (typeof f.path === 'string' ? p === f.path : f.path.test(p));
            if (!pathOk || (f.method && f.method !== req.method) || f.times <= 0) continue;
            f.times--;
            entry.fault = true;
            if (f.drop) { req.socket.destroy(); return; }
            if (f.stall) return;
            const go = () => send(res, f.status || 500, f.body === undefined ? { status: f.status || 500, subStatus: 0, userMessage: 'fault' } : f.body, f.headers);
            if (f.delayMs) { setTimeout(go, f.delayMs); return; }
            go();
            return;
        }
        let m;
        if ((m = /^\/auth\/v1\/oauth2\/(.*)$/.exec(p))) return auth(req, res, m[1], form || {});
        if ((m = /^\/api\/v1\/(.*)$/.exec(p))) return api(req, res, m[1], q);
        if ((m = /^\/images\/(.*)$/.exec(p))) return images(req, res, m[1]);
        if ((m = /^\/files\/(.*)$/.exec(p))) return files(req, res, m[1]);
        send(res, 404, '');
    }

    const handler = (req, res) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            try { route(req, res, Buffer.concat(chunks)); } catch (e) { send(res, 500, { status: 500, userMessage: 'fake crashed: ' + e.message }); }
        });
    };
    const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
    server.on('connection', (s) => { sockets.push(s); s.on('error', () => {}); s.on('close', () => { const i = sockets.indexOf(s); if (i >= 0) sockets.splice(i, 1); }); });

    /* ---------- an HLS video at made-up hosts ---------- */
    fake.addVideoHls = (videoId, v) => {
        const dir = 'hls/' + videoId + '/';
        fake.hosts[v.host] = '127.0.0.1';
        const master = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
        v.variants.forEach((va) => {
            fake.hosts[va.host] = '127.0.0.1';
            const at = dir + va.height + '/';
            master.push('#EXT-X-STREAM-INF:BANDWIDTH=' + va.bandwidth + ',AVERAGE-BANDWIDTH=' + Math.round(va.bandwidth * 0.9) +
                ',CODECS="avc1.640028,mp4a.40.2",RESOLUTION=' + va.width + 'x' + va.height + ',FRAME-RATE=25.000');
            master.push(fake.urlAt(va.host, at + 'index.m3u8'));
            const target = Math.ceil(va.segments.reduce((m, sg) => Math.max(m, sg.duration), 0));
            const pl = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-TARGETDURATION:' + target, '#EXT-X-MEDIA-SEQUENCE:0'];
            va.segments.forEach((sg, i) => {
                const name = 'seg-' + i + '.ts';
                fake.files[at + name] = sg.data;
                pl.push('#EXTINF:' + sg.duration.toFixed(6) + ',');
                pl.push(i % 2 ? fake.urlAt(va.host, at + name) : name);
            });
            pl.push('#EXT-X-ENDLIST');
            fake.files[at + 'index.m3u8'] = Buffer.from(pl.join('\n') + '\n');
        });
        fake.files[dir + 'master.m3u8'] = Buffer.from(master.join('\n') + '\n');
        fake.hlsMasters[videoId] = fake.urlAt(v.host, dir + 'master.m3u8');
        return fake.hlsMasters[videoId];
    };

    /* ---------- the DNS server: A records for fake.hosts ---------- */
    let dns = null;
    function dnsAnswer(q) {
        if (q.length < 17) return null;
        let off = 12;
        const labels = [];
        while (off < q.length && q[off] !== 0) {
            const n = q[off];
            if (n > 63 || off + 1 + n > q.length) return null;
            labels.push(q.toString('latin1', off + 1, off + 1 + n));
            off += 1 + n;
        }
        off++;
        if (off + 4 > q.length) return null;
        const name = labels.join('.').toLowerCase();
        const type = q.readUInt16BE(off);
        fake.dnsLog.push({ name: name, type: type });
        const ip = fake.hosts.hasOwnProperty(name) ? fake.hosts[name] : null;
        const question = q.slice(12, off + 4);
        const an = ip && type === 1 ? 1 : 0;
        const head = Buffer.alloc(12);
        head.writeUInt16BE(q.readUInt16BE(0), 0);
        head.writeUInt16BE(0x8180 | (q.readUInt16BE(2) & 0x0100) | (ip ? 0 : 3), 2);   // an answer, recursion; NXDOMAIN when unknown
        head.writeUInt16BE(1, 4);
        head.writeUInt16BE(an, 6);
        if (!an) return Buffer.concat([head, question]);
        const rr = Buffer.alloc(16);
        rr.writeUInt16BE(0xc00c, 0); rr.writeUInt16BE(1, 2); rr.writeUInt16BE(1, 4); rr.writeUInt32BE(60, 6); rr.writeUInt16BE(4, 10);
        ip.split('.').forEach((x, i) => { rr[12 + i] = Number(x); });
        return Buffer.concat([head, question, rr]);
    }
    const dnsReady = !opts.dns ? Promise.resolve() : new Promise((resolve) => {
        dns = dgram.createSocket('udp4');
        dns.on('error', () => {});
        dns.on('message', (q, rinfo) => {
            let a = null;
            try { a = dnsAnswer(q); } catch (e) { a = null; }
            if (a) dns.send(a, rinfo.port, rinfo.address);
        });
        dns.bind(0, '127.0.0.1', () => { fake.dnsServer = '127.0.0.1:' + dns.address().port; resolve(); });
    });

    return dnsReady.then(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const host = opts.host || '127.0.0.1';
        const base = (opts.tls ? 'https://' : 'http://') + host + ':' + server.address().port;
        fake.url = base;
        fake.port = server.address().port;
        fake.baseUrls = { auth: base + '/auth/v1/oauth2/', api: base + '/api/v1/', images: base + '/images/' };
        fake.fileUrl = (name) => base + '/files/' + name;
        fake.urlAt = (h, name) => (opts.tls ? 'https://' : 'http://') + h + ':' + fake.port + '/files/' + name;
        fake.close = () => new Promise((r) => {
            if (dns) { try { dns.close(); } catch (e) { /* closed */ } dns = null; }
            sockets.slice().forEach((s) => s.destroy());
            server.close(() => r());
        });
        resolve(fake);
    })));
}

/** a lease file that makes netx online (the fake is reached by its IP, or through opts.resolver) */
function writeLease(dir) {
    const p = path.join(dir, 'lease.json');
    fs.writeFileSync(p, JSON.stringify({ ip: '10.0.0.2', dns: ['192.0.2.53'] }));
    return p;
}

let tmpN = 0;
function tmpDir(tag) {
    const os = require('os');
    const d = path.join(os.tmpdir(), (tag || 'fake-tidal') + '-' + process.pid + '-' + (tmpN++) + '-' + Date.now());
    fs.mkdirSync(d);
    return d;
}

/**
 * For A's tests: a fake TIDAL, a netx made online by a lease file, and a tidal client pointed at the fake, with a
 * clock the test moves (env.clock.t, ms). opts: fake (createFakeTidal options), tidal (extra createTidal options),
 * loggedIn (start with a saved session for fresh tokens).
 */
function startTidal(o) {
    const opts = o || {};
    const root = path.join(__dirname, '..', '..', 'native', 'cmocan-tidal', 'lib');
    const createNetx = require(path.join(root, 'netx')).createNetx;
    const createTidal = require(path.join(root, 'tidal')).createTidal;
    return createFakeTidal(opts.fake).then((fake) => {
        const dir = tmpDir('tidal-test');
        const clock = { t: 1790000000000 };
        const leasePath = writeLease(dir);
        const netx = createNetx({ leasePath: leasePath, ca: '' });
        const sessionFile = path.join(dir, 'session.json');
        const coverDir = path.join(dir, 'covers');
        if (opts.loggedIn) {
            const t = fake.issueTokens();
            fs.writeFileSync(sessionFile, JSON.stringify({ version: 1, tokenType: 'Bearer', accessToken: t.accessToken, refreshToken: t.refreshToken,
                expiresAt: clock.t + 3600 * 1000, userId: fake.data.userId, countryCode: fake.data.countryCode }), { mode: 384 });
        }
        const make = (extra) => createTidal(Object.assign({ netx: netx, sessionFile: sessionFile, coverDir: coverDir, baseUrls: fake.baseUrls, now: () => clock.t },
            opts.tidal || {}, extra || {}));
        const env = { fake: fake, dir: dir, clock: clock, netx: netx, leasePath: leasePath, sessionFile: sessionFile, coverDir: coverDir, make: make, tidal: make() };
        env.close = () => { netx.close(); return fake.close(); };
        return env;
    });
}

module.exports = { createFakeTidal: createFakeTidal, startTidal: startTidal, writeLease: writeLease, tmpDir: tmpDir, jpeg: jpeg, CLIENT_ID: CLIENT_ID, CLIENT_SECRET: CLIENT_SECRET, SCOPE: SCOPE };
