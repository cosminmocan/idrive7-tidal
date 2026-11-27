'use strict';
/**
 * screens.js - every screen of the car app (apps/cmocan_tidal) in every state, drawn from fixed data the way the
 * car's software path draws it (the kit's recorder, played into the kit's canvas), as PNGs of the whole centre
 * display (1920 x 720): the app's page placed and scaled as the kit's full-screen layout places it, in the frame
 * tools/ui-mock.js draws the approved pictures in (BMW's strip sketched; the kit's header with the app's tabs, the
 * kit's bar with the app's words; the controller's place lit there when it is on a tab or a bar button), so each
 * can be held against docs/ui-mock/a-*.png.
 *
 *   node tools/screens.js [outDir]     every picture as <outDir>/screen-<name>.png (default preview/screens)
 *   node tools/screens.js --golden     the same into tests/golden/ (after the owner approved them), and the
 *                                      .new.png files left by tests/app_screens.test.js removed
 *   require('./tools/screens').cases() -> [{ name, state, ui }];  render(case) -> kit Canvas (1600 x 520)
 * Node 8.9.4 syntax (the tests run it on the car's Node too).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Recorder, play, setImage } = require(path.join(ROOT, 'kit', 'runtime', 'record'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));
const themes = require(path.join(ROOT, 'kit', 'runtime', 'themes'));
const APP = path.join(ROOT, 'apps', 'cmocan_tidal');
const M = require(path.join(APP, 'model'));
const S = require(path.join(APP, 'screens'));
const P = require(path.join(APP, 'pages'));
const MOCK = require(path.join(ROOT, 'tools', 'ui-mock'));

const W = 1600, H = 520, NOW = 100000;
const COVER_ID = '24f52ab0-e7d6-414d-a650-20a4c686aa57', COVER_IMAGE = 900, COVER_SIZE = 400;

/** a cover for the pictures: a fixed pattern (no JPEG needed) */
function coverPixels() {
    const n = COVER_SIZE, px = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = (y * n + x) * 4, d = Math.abs(x - n / 2) + Math.abs(y - n / 2);
            px[i] = 30 + Math.round(180 * x / n); px[i + 1] = 40 + Math.round(60 * y / n); px[i + 2] = d < n / 4 ? 230 : 120; px[i + 3] = 255;
        }
    }
    return px;
}

/* ---------- fixed data ---------- */
const track = (i, o) => Object.assign({ id: 5000 + i, title: 'Track number ' + (i + 1), artists: ['Artist ' + (i % 7 + 1)], album: { id: 77, title: 'Album' }, coverId: null, duration: 150 + (i * 37) % 200, streamReady: true, explicit: false }, o || {});
const TRACKS = [
    track(0, { title: 'One More Time', artists: ['Daft Punk'], album: { id: 17927863, title: 'Discovery' }, coverId: COVER_ID, duration: 320 }),
    track(1, { title: 'Știrile de azi (ediția de seară)', artists: ['Ana Blandiană', 'Grigore Vieru'], duration: 241 }),
    track(2, { title: 'Ein sehr, sehr langer Titel, der niemals in eine Zeile passt, weil er immer weiter und weiter geht und nicht aufhört', artists: ['Die Ärzte'], duration: 199 }),
    track(3, { title: 'Not streamable here', artists: ['Somebody'], streamReady: false, duration: 180 }),
    track(4, { title: '東京 Nights', artists: ['Unknown 🎵'], duration: 222 }),
    track(5, { title: 'Harder, Better, Faster, Stronger', artists: ['Daft Punk'], duration: 224 }),
    track(6, { title: 'Digital Love', artists: ['Daft Punk'], duration: 301 }),
    track(7, { title: 'Aerodynamic', artists: ['Daft Punk'], duration: 212 }),
];
const ALBUMS = [
    { id: 1, title: 'Discovery', artists: ['Daft Punk'], coverId: COVER_ID, numberOfTracks: 14 },
    { id: 2, title: 'Random Access Memories', artists: ['Daft Punk'], coverId: null, numberOfTracks: 13 },
    { id: 3, title: 'Cântece de drum', artists: ['Phoenix'], coverId: null, numberOfTracks: 11 },
];
const PLAYLISTS = [
    { uuid: 'p1', title: 'Road trip', numberOfTracks: 42, coverId: null },
    { uuid: 'p2', title: 'Morning drive', numberOfTracks: 18, coverId: null },
    { uuid: 'p3', title: 'Liniște', numberOfTracks: 7, coverId: null },
];
const MIXES = [
    { id: 'm1', title: 'My Mix 1', subTitle: 'Daft Punk, Justice, Air', coverId: null },
    { id: 'm2', title: 'My Mix 2', subTitle: 'Massive Attack, Portishead', coverId: null },
    { id: 'm3', title: 'Discovery Mix', subTitle: 'New to you', coverId: null },
];

function status(o) {
    return {
        type: 'status',
        state: Object.assign({ login: 'logged-in', loginPending: null, loginError: null, online: true, version: '0.1.0', prefs: { quality: 'HIGH' },
            player: { state: 'idle', track: null, position: 0, duration: null, queueIndex: -1, queueLength: 0, quality: null, error: null, skipped: [] } }, o || {}),
    };
}
const player = (state, o) => Object.assign({ state: state, track: TRACKS[0], position: 98, duration: 320, queueIndex: 2, queueLength: 14, quality: 'HIGH', error: null, skipped: [] }, o || {});
function from(events) { return events.reduce((s, e) => M.reduce(s, e), M.initial()); }
function list(kind, items, extra) {
    return [status(), { type: 'open-list', key: 'k', title: extra && extra.title || 'Favourite tracks', kind: kind, source: { cmd: extra && extra.cmd || 'favorites', params: { kind: 'tracks' } } },
        { type: 'list-loaded', key: 'k', offset: 0, total: extra && extra.total != null ? extra.total : items.length, items: items, stale: !!(extra && extra.stale) }];
}
const knob = (n) => { const out = []; for (let i = 0; i < n; i++) out.push({ type: 'cursor', sel: i + 1, top: Math.max(0, i + 1 - 5) }); return out; };
const played = (items, title) => ({ type: 'played', queue: { key: 'k', title: title || 'Favourite tracks', tracks: items } });
const login = [status({ login: 'logged-out' }), { type: 'login-requested' }, { type: 'login-started', url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresIn: 300, now: NOW - 60000 },
    status({ login: 'login-pending', loginPending: { url: 'https://link.tidal.com/ABCDE', userCode: 'ABCDE', expiresAt: NOW + 240000 } })];

function cases() {
    const big = [];
    for (let i = 0; i < 500; i++) big.push(track(i));
    const c = [
        ['no-service-starting', [], {}],
        ['no-service', [{ type: 'no-service' }], {}],
        ['offline', [status({ online: false })], {}],
        ['offline-logged-out', [status({ online: false, login: 'logged-out' })], {}],
        ['login-waiting', [status({ login: 'logged-out' }), { type: 'login-requested' }], {}],
        ['login-code', login, {}],
        ['login-again', login.concat([{ type: 'error', code: 'login-expired' }, { type: 'login-requested' },
            { type: 'login-started', url: 'https://link.tidal.com/FGHIJ', userCode: 'FGHIJ', expiresIn: 300, now: NOW }]), {}],
        ['login-expired', login.concat([{ type: 'tick', now: NOW + 600000 }]), {}],
        ['login-denied', [status({ login: 'logged-out', loginError: 'login-denied' })], {}],
        ['login-pending-restart', [status({ login: 'login-pending', loginPending: { url: 'https://link.tidal.com/KLMNO', userCode: 'KLMNO', expiresAt: NOW + 150000 } })], {}],
        ['login-failed', [status({ login: 'logged-out' }), { type: 'login-requested' }, { type: 'login-failed', code: 'tidal-error' }], {}],
        ['library', [status()], {}],
        ['library-playing', [status({ player: player('playing') }), { type: 'cursor', sel: 5, top: 0 }], {}],
        ['library-offline', [status({ online: false }), { type: 'open-library' }], {}],
        ['list-loading', [status(), { type: 'open-list', key: 'k', title: 'Playlists', kind: 'playlists', source: { cmd: 'playlists', params: {} } }], {}],
        ['list-empty', list('tracks', [], { title: 'Favourite tracks' }), {}],
        ['list-failed', [status(), { type: 'open-list', key: 'k', title: 'Mixes', kind: 'mixes', source: { cmd: 'mixes', params: {} } }, { type: 'list-failed', key: 'k', code: 'timeout' }], {}],
        ['list-tracks', list('tracks', TRACKS, { total: 120 }).concat(knob(2)), { thumb: true }],
        ['list-tracks-playing', list('tracks', TRACKS, { total: 120 }).concat([status({ player: player('playing') }), played(TRACKS)], knob(2)), { thumb: true }],
        ['list-tracks-unavailable', list('tracks', TRACKS).concat([status({ player: player('playing') })], knob(4), [{ type: 'error', code: 'not-available', trackId: TRACKS[3].id }]), { now: NOW, thumb: true }],
        ['list-tracks-bar-focus', list('tracks', TRACKS).concat(knob(2), [{ type: 'focus', area: 'bar' }]), {}],
        ['list-tracks-tabs-focus', list('tracks', TRACKS).concat(knob(2), [{ type: 'focus', area: 'tabs', tab: 1 }]), {}],
        ['list-tracks-stale', list('tracks', TRACKS, { stale: true }), {}],
        ['list-albums', list('albums', ALBUMS, { title: 'Favourite albums' }).concat(knob(1)), { thumb: true }],
        ['list-playlists', list('playlists', PLAYLISTS, { title: 'Playlists', cmd: 'playlists' }).concat(knob(1)), {}],
        ['list-mixes', list('mixes', MIXES, { title: 'Mixes', cmd: 'mixes' }), {}],
        ['list-500-scrolled', list('tracks', big).concat([{ type: 'cursor', sel: 300, top: 297 }]), {}],
        ['search-keyboard', [status(), { type: 'open-search' }, { type: 'key', key: 'D' }, { type: 'key', key: 'A' }, { type: 'key', key: 'F' }, { type: 'key', key: 'T' }, { type: 'focus', key: 19 }], {}],
        ['search-keyboard-results', [status(), { type: 'open-search' }, { type: 'key', key: 'D' }, { type: 'key', key: 'A' }, { type: 'key', key: 'F' }, { type: 'key', key: 'T' }, { type: 'key', key: 'SEARCH' },
            { type: 'list-loaded', key: 'search:DAFT', offset: 0, total: 4, items: [TRACKS[0], TRACKS[5], TRACKS[6], TRACKS[7]] }, { type: 'open-keyboard' }, { type: 'focus', key: 19 }], { thumb: true }],
        ['search-results', [status(), { type: 'open-search' }, { type: 'key', key: 'A' }, { type: 'key', key: 'SEARCH' },
            { type: 'list-loaded', key: 'search:A', offset: 0, total: 3, items: TRACKS.slice(0, 3) }, { type: 'cursor', sel: 1, top: 0 }], {}],
        ['search-blocked-moving', [status(), { type: 'open-search' }, { type: 'key', key: 'A' }, { type: 'driving', moving: true }], { now: NOW }],
        ['now-playing', [status({ player: player('playing') }), { type: 'open-now-playing' }], { cover: true, position: 98.4 }],
        ['now-playing-from-list', list('tracks', TRACKS, { total: 8 }).concat([status({ player: player('playing', { queueIndex: 0, queueLength: 8 }) }), played(TRACKS), { type: 'open-now-playing' }]), { cover: true, position: 98.4 }],
        ['now-playing-no-cover', [status({ player: player('playing', { track: TRACKS[1], duration: 241, position: 12 }) }), { type: 'open-now-playing' }], { position: 12 }],
        ['now-playing-paused', [status({ player: player('paused') }), { type: 'open-now-playing' }, { type: 'focus', area: 'bar', bar: 2 }], { cover: true }],
        ['now-playing-buffering', [status({ player: player('buffering', { position: 3 }) }), { type: 'open-now-playing' }], { cover: true }],
        ['now-playing-loading', [status({ player: player('loading', { position: 0, duration: null }) }), { type: 'open-now-playing' }], {}],
        ['now-playing-error', [status({ player: player('error', { error: 'decode' }) }), { type: 'open-now-playing' }], { cover: true }],
        ['now-playing-skipped', list('tracks', TRACKS).concat([status({ player: player('playing', { queueIndex: 0, queueLength: 8 }) }), played(TRACKS), { type: 'open-now-playing' },
            status({ player: player('playing', { queueIndex: 0, queueLength: 8, skipped: [{ id: TRACKS[5].id, error: 'not-available' }] }) })]), { cover: true, position: 98.4 }],
        // phase 2 (S2), seek: the bar under a finger (or wound with the wheel), and with the controller on it
        ['now-playing-seeking', [status({ player: player('playing') }), { type: 'open-now-playing' }], { cover: true, position: 200, seeking: true }],
        ['now-playing-seeking-paused', [status({ player: player('paused') }), { type: 'open-now-playing' }], { cover: true, position: 12, seeking: true }],
        ['now-playing-bar-focus', [status({ player: player('playing') }), { type: 'open-now-playing' }, { type: 'focus', area: 'progress' }], { cover: true, position: 98.4 }],
        ['now-playing-bar-focus-seeking', [status({ player: player('playing') }), { type: 'open-now-playing' }, { type: 'focus', area: 'progress' }], { cover: true, position: 128.4, seeking: true }],
        ['now-playing-idle', [status(), { type: 'open-now-playing' }], {}],
        ['now-playing-volume', [status({ player: player('playing') }), { type: 'open-now-playing' }], { cover: true, volume: { volume: 23, muted: false, max: 62 } }],
        ['now-playing-muted', [status({ player: player('playing') }), { type: 'open-now-playing' }], { cover: true, volume: { volume: 23, muted: true, max: 62 } }],
        ['error-not-found', [status(), { type: 'error', code: 'not-found', cmd: 'mix' }], {}],
        ['error-rate-limited', [status(), { type: 'error', code: 'rate-limited', cmd: 'search' }], {}],
        ['error-tidal', [status(), { type: 'error', code: 'tidal-error', cmd: 'favorites' }], {}],
    ];
    return c.map((x) => ({ name: x[0], state: from(x[1]), ui: x[2] }));
}

let coverReady = false;
/** the app's page (1600 x 520) as the car's software path draws it */
function page(c) {
    if (!coverReady) { setImage(COVER_IMAGE, COVER_SIZE, COVER_SIZE, coverPixels()); coverReady = true; }
    const t = themes.theme('m_tricolour');
    const r = new Recorder(W, H, { textScale: 1 });
    r.clear(t.bg);
    const u = c.ui || {};
    S.draw(r, t, c.state, {
        now: u.now || NOW, position: u.position, volume: u.volume, seeking: u.seeking,
        cover: (id) => (u.cover && id === COVER_ID ? { id: COVER_IMAGE, w: COVER_SIZE, h: COVER_SIZE } : null),
        thumb: (id) => (u.thumb && id === COVER_ID ? { id: COVER_IMAGE, w: COVER_SIZE, h: COVER_SIZE } : null),
    });
    const cv = new Canvas(W, H);
    play(r.words(), cv);
    return cv;
}
/** the whole centre display: the page where the kit's full-screen layout puts it, the header's tabs and the bar */
function render(c) {
    const s = c.state, pg = page(c), cv = MOCK.newScreen();
    cv.drawImage(pg.d, W, H, MOCK.OX, MOCK.OY, W * MOCK.K, H * MOCK.K);
    const tb = P.tabs(s), area = P.area(s);
    MOCK.chrome(cv, {
        tabs: tb.tabs.concat(['Settings']), tab: tb.sel, bar: P.bar(s),
        tabFocus: area === 'tabs' ? Math.min(s.focus.tab, tb.tabs.length) : null,
        barFocus: area === 'bar' ? s.focus.bar : null,
    });
    return cv;
}

module.exports = { cases: cases, render: render };

if (require.main === module) {
    const golden = process.argv.indexOf('--golden') >= 0;
    const out = golden ? path.join(ROOT, 'tests', 'golden') : path.resolve(process.argv[2] || path.join(ROOT, 'preview', 'screens'));
    try { fs.mkdirSync(path.dirname(out)); } catch (e) { /* there */ }
    try { fs.mkdirSync(out); } catch (e) { /* there */ }
    cases().forEach((c) => {
        const f = path.join(out, 'screen-' + c.name + '.png');
        fs.writeFileSync(f, render(c).png(9));
        if (golden) { try { fs.unlinkSync(path.join(out, 'screen-' + c.name + '.new.png')); } catch (e) { /* none */ } }
        console.log(path.relative(process.cwd(), f));
    });
}
