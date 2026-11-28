'use strict';
/**
 * fake_service.js - a stand-in for the cmocan-tidal service on the control socket (docs/PROTOCOL.md, section 1),
 * for the app's tests (stream D). Canned data, no TIDAL, no player. Node 8.9.4 syntax.
 *
 *   const svc = await createFakeService({ socketPath, state });   // state: partial status state to start from
 *   svc.state            // the status state; tests change it to drive the app
 *   svc.requests         // every request received, in order
 *   svc.answer = (req) => answerObject | undefined   // optional override per request
 *   await svc.close();   // ends connections, removes the socket
 */
const net = require('net');
const fs = require('fs');

const MAX_LINE = 64 * 1024;
const P = require('./protocol');

const TRACK = { id: 17927864, title: 'One More Time', artists: ['Daft Punk'], album: { id: 17927863, title: 'Discovery' },
    coverId: '24f52ab0-e7d6-414d-a650-20a4c686aa57', duration: 320, streamReady: true, explicit: false };
const ALBUM = { id: 17927863, title: 'Discovery', artists: ['Daft Punk'], coverId: TRACK.coverId, numberOfTracks: 14 };
const PLAYLIST = { uuid: '36ea71a8-445e-41a4-82ab-6628c581535d', title: 'Road trip', numberOfTracks: 42, coverId: null };
const VIDEO = { kind: 'video', id: 143792065, title: 'Around the World', artists: ['Daft Punk'], album: null,
    coverId: 'a1b2c3d4-0000-4000-8000-000000000001', duration: 175, streamReady: true, explicit: false };
const MIX = { id: '0123456789abcdef0123456789abcd', title: 'My Mix 1', subTitle: 'Daft Punk', coverId: null };
// the smallest valid JPEG header bytes, base64: enough for a contract test, not a real picture
const COVER = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

function defaultState() {
    return {
        login: 'logged-out', online: true, version: '0.0.0-fake', prefs: { quality: 'HIGH', videoHeight: 720 }, loginPending: null, loginError: null,
        player: { state: 'idle', track: null, position: 0, duration: null, queueIndex: -1, queueLength: 0, quality: null, error: null, skipped: [] },
    };
}

function cannedAnswer(svc, r) {
    const ok = (fields) => Object.assign({ id: r.id, ok: true }, fields || {});
    const items = (list) => ok({ total: list.length, items: list });
    switch (r.cmd) {
        case 'status': return ok({ state: svc.state });
        case 'login-start':
            svc.state.login = 'login-pending'; svc.state.loginError = null;
            svc.state.loginPending = { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresAt: Date.now() + 300000 };
            return ok({ url: svc.state.loginPending.url, userCode: 'ABCDE', expiresIn: 300 });
        case 'login-cancel': if (svc.state.login === 'login-pending') { svc.state.login = 'logged-out'; svc.state.loginPending = null; } return ok();
        case 'logout': svc.state.login = 'logged-out'; svc.state.loginPending = null; return ok();
        case 'favorites': return items(r.kind === 'albums' ? [ALBUM] : r.kind === 'videos' ? [VIDEO] : [TRACK]);
        case 'playlists': return items([PLAYLIST]);
        case 'mixes': return items([MIX]);
        case 'playlist': case 'album': case 'mix': case 'search': return items([TRACK]);
        case 'cover': return ok({ mime: 'image/jpeg', data: COVER });
        case 'seek':
            if (svc.state.player.state === 'idle' || !svc.state.player.track) return { id: r.id, ok: false, error: 'bad-request', message: 'nothing is playing' };
            svc.state.player.position = r.position; return ok();
        case 'log': return ok({ lines: (svc.logLines || ['12:00:00 fake service']).slice(-(r.lines || 200)) });
        case 'prefs': if (r.quality) svc.state.prefs.quality = r.quality; if (r.videoHeight) svc.state.prefs.videoHeight = r.videoHeight; return ok({ prefs: svc.state.prefs });
        default: return ok();   // play, pause, resume, next, prev, stop, exit
    }
}

function createFakeService(opts) {
    const o = opts || {};
    const svc = { state: Object.assign(defaultState(), o.state || {}), requests: [], answer: null, conns: [] };
    try { fs.unlinkSync(o.socketPath); } catch (e) { /* none there */ }

    function handleLine(conn, line) {
        let r;
        try { r = JSON.parse(line); } catch (e) { r = undefined; }
        const id = r && typeof r === 'object' && Number.isInteger(r.id) && r.id > 0 ? r.id : null;
        const errs = P.validateRequest(r);
        let a;
        if (errs.length) a = { id: id, ok: false, error: 'bad-request', message: errs.join('; ') };
        else { svc.requests.push(r); a = (svc.answer && svc.answer(r)) || cannedAnswer(svc, r); }
        conn.write(JSON.stringify(a) + '\n');
    }

    const server = net.createServer((conn) => {
        svc.conns.push(conn);
        let buf = '';
        let dropping = false;
        conn.setEncoding('utf8');
        conn.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                if (dropping) { dropping = false; continue; }   // the rest of an over-long line
                handleLine(conn, line);
            }
            if (buf.length > MAX_LINE) {
                buf = '';
                if (!dropping) { dropping = true; conn.write(JSON.stringify({ id: null, ok: false, error: 'bad-request', message: 'line too long' }) + '\n'); }
            }
        });
        conn.on('error', () => {});
        conn.on('close', () => { svc.conns = svc.conns.filter((c) => c !== conn); });
    });

    svc.close = () => new Promise((resolve) => {
        svc.conns.forEach((c) => c.destroy());
        server.close(() => { try { fs.unlinkSync(o.socketPath); } catch (e) { /* gone */ } resolve(); });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.socketPath, () => resolve(svc));
    });
}

module.exports = { createFakeService: createFakeService, defaultState: defaultState, TRACK: TRACK, VIDEO: VIDEO };
