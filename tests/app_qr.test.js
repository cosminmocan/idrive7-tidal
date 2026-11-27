'use strict';
/**
 * D3: the login screen's QR code (apps/cmocan_tidal/qr.js, on Kazuhiko Arase's generator, MIT) and the login screen
 * (apps/cmocan_tidal/screens.js).
 *
 * The stored matrix tests/golden/qr_link_tidal_ABCDE.txt was made by a second, independent generator
 * (python-qrcode 7.4.2, error correction M, mask 5 - the mask Arase's generator picks) and must equal ours module
 * for module. Scanning it with a phone from the preview PNG is the owner's check (WORKPLAN D3 success line).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const { Canvas } = require('../kit/runtime/canvas');
const themes = require('../kit/runtime/themes');
const QR = require('../apps/cmocan_tidal/qr');
const S = require('../apps/cmocan_tidal/screens');
const M = require('../apps/cmocan_tidal/model');
const { defaultState } = require('./fakes/fake_service');

const URL = 'https://link.tidal.com/ABCDE';
const GOLDEN = fs.readFileSync(path.join(__dirname, 'golden', 'qr_link_tidal_ABCDE.txt'), 'utf8').trim().split('\n');
const theme = themes.theme('m_tricolour');

function loginState(extra) {
    const st = defaultState();
    let s = M.reduce(M.initial(), { type: 'status', state: st });
    s = M.reduce(s, { type: 'login-requested' });
    s = M.reduce(s, { type: 'login-started', url: URL, userCode: 'ABCDE', expiresIn: 300, now: 0 });
    return extra ? M.reduce(s, extra) : s;
}
function px(cv, x, y) { const i = (Math.floor(y) * cv.w + Math.floor(x)) * 4; return [cv.d[i], cv.d[i + 1], cv.d[i + 2]]; }

test('the matrix for the TIDAL login link equals the stored one (made by an independent generator)', () => {
    const m = QR.matrix(URL);
    assert.strictEqual(m.n, 29);
    const rows = [];
    for (let r = 0; r < m.n; r++) { let s = ''; for (let c = 0; c < m.n; c++) s += m.dark(r, c) ? '1' : '0'; rows.push(s); }
    assert.deepStrictEqual(rows, GOLDEN);
});

test('layout: a quiet border of four cells and cells of at least 6 px, also when the box is small', () => {
    const l = QR.layout(29, 360);
    assert.strictEqual(l.quiet, 4);
    assert.strictEqual(l.cell, Math.floor(360 / 37));
    assert.strictEqual(l.size, l.cell * 37);
    const small = QR.layout(29, 100);
    assert.strictEqual(small.cell, 6, 'never below 6 px');
    assert.strictEqual(small.size, 6 * 37);
});

test('drawn: the border is white all round, every module is where the matrix says, each cell at least 6 px', () => {
    const cv = new Canvas(600, 520).clear('#000000');
    const m = QR.matrix(URL), l = QR.layout(m.n, 400);
    QR.draw(cv, m, 50, 40, l.cell);
    const q = l.quiet * l.cell;
    for (let i = 0; i < l.size; i++) {
        [[50 + i, 40], [50 + i, 40 + q - 1], [50 + i, 40 + l.size - 1], [50 + i, 40 + l.size - q], [50, 40 + i], [50 + q - 1, 40 + i], [50 + l.size - 1, 40 + i], [50 + l.size - q, 40 + i]]
            .forEach((p) => assert.deepStrictEqual(px(cv, p[0], p[1]), [255, 255, 255], 'border at ' + p));
    }
    for (let r = 0; r < m.n; r++) {
        for (let c = 0; c < m.n; c++) {
            const want = m.dark(r, c) ? [0, 0, 0] : [255, 255, 255];
            const x0 = 50 + q + c * l.cell, y0 = 40 + q + r * l.cell;
            assert.deepStrictEqual(px(cv, x0, y0), want, 'module ' + r + ',' + c + ' corner');
            assert.deepStrictEqual(px(cv, x0 + l.cell - 1, y0 + l.cell - 1), want, 'module ' + r + ',' + c + ' far corner');
        }
    }
    assert.ok(l.cell >= 6);
});

test('the login screen: the code as QR (border 4 cells, cells >= 6 px), the user code and the short address as text', () => {
    const s = loginState();
    assert.strictEqual(s.screen, 'LOGIN');
    const spy = spyCanvas();
    const info = S.draw(spy, theme, s, { now: 1000 });
    assert.ok(spy.has('ABCDE'), spy.all());
    assert.ok(spy.has(/link\.tidal\.com/), spy.all());
    assert.ok(info.qr, 'a QR code is drawn');
    assert.ok(info.qr.cell >= 6);
    // the same on real pixels
    const cv = new Canvas(1600, 520).clear(theme.bg);
    const i2 = S.draw(cv, theme, s, { now: 1000 });
    const q = i2.qr;
    assert.deepStrictEqual(px(cv, q.x + 1, q.y + 1), [255, 255, 255], 'quiet zone');
    assert.deepStrictEqual(px(cv, q.x + 4 * q.cell + 1, q.y + 4 * q.cell + 1), [0, 0, 0], 'the finder pattern starts after 4 cells');
    assert.ok(q.x + q.size <= 1600 && q.y + q.size <= 520, 'on the screen');
});

test('the code expired: no QR code, and the screen offers a new one (a press or tap asks for it)', () => {
    const s = loginState({ type: 'tick', now: 300000 });
    assert.strictEqual(s.login.expired, true);
    const spy = spyCanvas();
    const acts = [];
    const info = S.draw(spy, theme, s, { now: 300000, act: (a) => acts.push(a) });
    assert.strictEqual(info.qr, null);
    assert.ok(spy.has(/expired/i), spy.all());
    const hit = info.hits.filter((h) => h.act && h.act.type === 'login-new')[0];
    assert.ok(hit, 'a "new code" button');
    assert.ok(spy.targets.some((t) => t.key === hit.key), 'also a touch / controller target');
    spy.targets.filter((t) => t.key === hit.key)[0].run();
    assert.deepStrictEqual(acts, [{ type: 'login-new' }]);
    assert.strictEqual(S.defaultAct(s, info).type, 'login-new', 'the controller\'s press on the screen asks for it too');
});

test('contract 2: the login was refused on the phone: its own message, no QR code, a new code on request', () => {
    const st = Object.assign(defaultState(), { loginError: 'login-denied' });
    const s = M.reduce(M.initial(), { type: 'status', state: st });
    const spy = spyCanvas();
    const info = S.draw(spy, theme, s, { now: 0 });
    assert.strictEqual(info.qr, null);
    assert.ok(spy.has(/refused on the phone/i), spy.all());
    assert.ok(!spy.has(/expired/i), spy.all());
    assert.strictEqual(S.defaultAct(s, info).type, 'login-new');
    const ex = M.reduce(M.initial(), { type: 'status', state: Object.assign(defaultState(), { loginError: 'login-expired' }) });
    const spy2 = spyCanvas();
    assert.strictEqual(S.defaultAct(ex, S.draw(spy2, theme, ex, { now: 0 })).type, 'login-new');
    assert.ok(spy2.has(/code expired/i), spy2.all());
});

test('contract 2: a code pending after the app restarted: the QR code, the user code and the time left from expiresAt', () => {
    const now = 1795000000000;
    const st = Object.assign(defaultState(), { login: 'login-pending', loginPending: { url: URL, userCode: 'ABCDE', expiresAt: now + 150000 } });
    const s = M.reduce(M.initial(), { type: 'status', state: st });
    const spy = spyCanvas();
    const info = S.draw(spy, theme, s, { now: now });
    assert.ok(info.qr, 'a QR code is drawn');
    assert.ok(spy.has('ABCDE') && spy.has(/link\.tidal\.com/), spy.all());
    assert.ok(spy.has(/valid for 3 more minutes/), spy.all());
});

test('waiting for a code: a message, no QR code', () => {
    let s = M.reduce(M.initial(), { type: 'status', state: defaultState() });
    s = M.reduce(s, { type: 'login-requested' });
    const spy = spyCanvas();
    const info = S.draw(spy, theme, s, { now: 0 });
    assert.strictEqual(info.qr, null);
    assert.ok(spy.has(/getting a code/i), spy.all());
});

run();
