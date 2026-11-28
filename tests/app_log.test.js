'use strict';
/**
 * Phase 2, D1 (the app's part): the service's log in the app's QR log. When the QR log page is opened (Settings >
 * QR log, the kit's sheet) and on each of its buttons (Refresh among them), the app asks the service for
 * `log {lines: 200}` and writes the lines it has not written before into its own log, marked "svc: ", so the QR
 * pages show them. A service that does not answer gets one line saying so. Rule R1 for the answer.
 * The kit's own sheets (kit/runtime/sheet.js, qrlog.js) are used as they are, opened the way kit/runtime/mgu.js does.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { test, run } = require('./lib/t');
const { spyCanvas } = require('./app_canvas_spy');
const themes = require('../kit/runtime/themes');
const { listSheet } = require('../kit/runtime/sheet');
const { qrLogSheet } = require('../kit/runtime/qrlog');
const { Recorder } = require('../kit/runtime/record');
const { createFakeService } = require('./fakes/fake_service');
const P = require('./fakes/protocol');
const decodeJpeg = require('../apps/cmocan_tidal/jpeg');
const { createSvcLog } = require('../apps/cmocan_tidal/svclog');
const { createApp } = require('../apps/cmocan_tidal/tidal');

const theme = themes.theme('m_tricolour');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apps', 'cmocan_tidal', 'app.json'), 'utf8'));
const DICT = fs.readFileSync(path.join(__dirname, '..', 'kit', 'runtime', 'qrlog-dict-1.txt'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-log-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + (what || fn.toString()));
}

/* ---------- the lines: which are written ---------- */

function logger(answers) {
    const asked = [], lines = [];
    const sl = createSvcLog({
        ask: (cmd, params, ms) => { asked.push({ cmd: cmd, params: params, ms: ms }); const a = answers.shift(); return typeof a === 'function' ? a() : Promise.resolve(a); },
        log: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push('ERROR ' + m) },
    });
    return { sl: sl, asked: asked, lines: lines };
}
const ok = (lines) => ({ id: 1, ok: true, lines: lines });

test('the lines are asked for (200) and written marked "svc: "; asked again, only the newer ones are written', async () => {
    const k = logger([ok(['17:05:07 service 0.1.2 started', '17:05:09 playing track 17927864 (HIGH, aac)']),
        ok(['17:05:07 service 0.1.2 started', '17:05:09 playing track 17927864 (HIGH, aac)', '17:08:41 track 17927870: not available, skipped']),
        ok(['17:05:07 service 0.1.2 started', '17:05:09 playing track 17927864 (HIGH, aac)', '17:08:41 track 17927870: not available, skipped'])]);
    await k.sl.fetch();
    assert.deepStrictEqual(k.asked[0].cmd, 'log');
    assert.deepStrictEqual(k.asked[0].params, { lines: 200 });
    assert.deepStrictEqual(P.validateRequest(Object.assign({ id: 1, cmd: 'log' }, k.asked[0].params)), []);
    assert.deepStrictEqual(k.lines, ['svc: 17:05:07 service 0.1.2 started', 'svc: 17:05:09 playing track 17927864 (HIGH, aac)']);
    await k.sl.fetch();
    assert.deepStrictEqual(k.lines.slice(2), ['svc: 17:08:41 track 17927870: not available, skipped'], 'not twice');
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 3, 'nothing new: nothing written');
});

test('the service\'s 200 lines moved on (its oldest fell out): only what came after the last written line', async () => {
    const all = [];
    for (let i = 0; i < 260; i++) all.push('12:' + String(10 + Math.floor(i / 60)) + ':' + String(100 + i % 60).slice(1) + ' line ' + i);
    const k = logger([ok(all.slice(0, 200)), ok(all.slice(60, 260)), ok(['09:00:00 service started again', '09:00:01 ready'])]);
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 200);
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 260);
    assert.deepStrictEqual(k.lines.slice(200, 202), ['svc: ' + all[200], 'svc: ' + all[201]]);
    assert.strictEqual(k.lines[259], 'svc: ' + all[259]);
    await k.sl.fetch();
    assert.deepStrictEqual(k.lines.slice(260), ['svc: 09:00:00 service started again', 'svc: 09:00:01 ready'], 'a restarted service: all of its lines');
});

test('no answer: one line says so, once until the service answers again', async () => {
    const k = logger([{ ok: false, error: 'timeout', local: true }, { ok: false, error: 'timeout', local: true }, { ok: false, error: 'no-service', local: true },
        ok(['10:00:00 back']), { ok: false, error: 'tidal-error' }]);
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 1);
    assert.ok(/^svc: /.test(k.lines[0]) && /did not answer|could not be read/.test(k.lines[0]) && /timeout/.test(k.lines[0]), k.lines[0]);
    await k.sl.fetch();
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 1, 'said once');
    await k.sl.fetch();
    assert.deepStrictEqual(k.lines.slice(1), ['svc: 10:00:00 back']);
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 3, 'and said again when it fails again');
    assert.ok(/tidal-error/.test(k.lines[2]), k.lines[2]);
});

test('any answer is survived (R1): no array, things that are no text, control characters, huge lines, a throw, a rejection', async () => {
    const huge = 'x'.repeat(100000);
    const k = logger([null, undefined, 'garbage', 42, [], { ok: true }, { ok: true, lines: 'text' }, { ok: true, lines: { 0: 'a' } },
        ok([1, null, {}, ['a'], '', '11:00:00 good\nline\tone\u0000\u001b[31m', huge]),
        () => { throw new Error('boom'); }, () => Promise.reject(new Error('boom')),
        ok(new Array(5000).join('.').split('.').map((x, i) => '13:00:00 many ' + i))]);
    for (let i = 0; i < 8; i++) await k.sl.fetch();
    assert.ok(k.lines.length <= 2, 'answers that are no log: at most a line saying so: ' + JSON.stringify(k.lines));
    k.lines.length = 0;
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 2, JSON.stringify(k.lines).slice(0, 300));
    assert.strictEqual(k.lines[0], 'svc: 11:00:00 good line one [31m', 'one line each, no control characters');
    assert.ok(k.lines[1].length <= 300 && /^svc: x+/.test(k.lines[1]), 'a huge line is cut: ' + k.lines[1].length);
    await k.sl.fetch();
    await k.sl.fetch();
    k.lines.length = 0;
    await k.sl.fetch();
    assert.strictEqual(k.lines.length, 200, 'never more than the 200 newest');
    assert.strictEqual(k.lines[199], 'svc: 13:00:00 many 4999');
    k.lines.forEach((l) => assert.ok(!/^ERROR/.test(l)));
});

test('two fetches at once ask once', async () => {
    let n = 0;
    const lines = [];
    const sl = createSvcLog({ ask: () => { n++; return sleep(50).then(() => ok(['10:00:00 a'])); }, log: { info: (m) => lines.push(m), warn() {}, error() {} } });
    await Promise.all([sl.fetch(), sl.fetch(), sl.fetch()]);
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(lines, ['svc: 10:00:00 a']);
});

/* ---------- the app, the kit's settings and QR log sheets, the fake service ---------- */

/** a page of the QR log as text: its header line, then its lines (the times after the first as "+seconds") */
function pageText(buf) {
    const i = buf.indexOf(10);
    return buf.slice(0, i).toString() + '\n' + zlib.inflateRawSync(buf.slice(i + 1), { dictionary: DICT }).toString();
}
const allPages = (sheet) => sheet.contents().map(pageText).join('\n');

/** the kit's ctx as far as the app needs it, with a log file as mgu.js writes it and Settings opened as it opens them */
function fakeCtx() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-data-'));
    const file = path.join(dataDir, 'cmocan_tidal.log');
    const handlers = {}, loops = {}, errors = [];
    const values = { quality: 'HIGH', wheel: true };
    const write = (lvl, m) => fs.appendFileSync(file, new Date().toISOString() + ' ' + lvl + ' ' + m + '\n');
    const settings = { schema: SPEC.settings, get: (k) => values[k], set(k, v) { values[k] = v; }, display: (k) => String(values[k]), onChange() {}, cycle() {} };
    const display = { sheet: null, openSheet(sh) { this.sheet = sh; return true; }, closeSheet() { this.sheet = null; } };
    const ctx = {
        dataDir, file, handlers, loops, errors, display,
        log: { info: (m) => write('INFO', m), debug() {}, warn: (m) => write('WARN', m), error: (m, e) => { errors.push(m + (e ? ' ' + (e.stack || e) : '')); write('ERROR', m); } },
        ui: { onClick: (n, fn) => { handlers[n] = fn; }, image: () => Promise.resolve(), isVisible: () => true, onVisible() {}, close() {} },
        settings: settings,
        theme: () => theme,
        canvas: (w, h) => spyCanvas(w, h),
        loop: (name, fps, fn) => { loops[name] = fn; return { stop() {}, kick() {} }; },
        signals: { watch: () => Promise.resolve({ available: true }), proxy: () => Promise.reject(new Error('none')), call: () => Promise.reject(new Error('none')), on: () => Promise.reject(new Error('none')), onAvailable() {} },
        controller: { grab() {}, onInput() {} },
        onTap() {},
        /** kit/runtime/mgu.js, BTN_SETTINGS: the settings sheet with the QR log as its last row */
        openSettings() {
            const qrRow = { label: 'QR log', value: 'The app\'s log as codes to photograph', open: () => qrLogSheet({ file: file, app: SPEC.id, version: SPEC.version }) };
            const sh = listSheet(settings, null, { version: SPEC.version, extra: () => [qrRow] });
            sh.settings = true;
            assert.ok(ctx.display.openSheet(sh));
            return sh;
        },
    };
    return ctx;
}
/** what the kit's display does with a sheet: a frame (its targets), the controller's press, a tap on a target */
const drawSheet = (sh) => sh.draw(new Recorder(1600, 520, { textScale: 1 }), theme);
const press = (sh) => Promise.resolve(sh.press());
/** the controller onto button i of the open QR log: Previous, Next, Size, Refresh, Back (a turn moves one button) */
function toButton(sh, i) { for (let n = 0; n < 5; n++) sh.move(-1); for (let n = 0; n < i; n++) sh.move(1); }
const REFRESH = 3, BACK = 4;
function toQrRow(sh) { sh.move(100); assert.strictEqual(sh.rows()[sh.focus].label, 'QR log'); }

test('app: Settings > QR log shows the service\'s lines; Refresh shows the newer ones, each line once', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    svc.logLines = ['17:05:07 playing track 17927864 (HIGH, aac)', '17:08:41 track 17927870: not available, skipped'];
    const ctx = fakeCtx();
    const app = createApp(ctx, { socketPath: sock, pollMs: 150, setImage() {}, decodeJpeg: decodeJpeg });
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        ctx.log.info('car audio: connect {"mainConnectionID":3}');
        const sh = ctx.openSettings();
        drawSheet(sh);
        assert.strictEqual(svc.requests.filter((r) => r.cmd === 'log').length, 0, 'the settings alone do not ask');
        toQrRow(sh);
        await press(sh);
        assert.ok(sh.child, 'the QR log is open');
        const asked = svc.requests.filter((r) => r.cmd === 'log');
        assert.strictEqual(asked.length, 1);
        assert.strictEqual(asked[0].lines, 200);
        assert.deepStrictEqual(P.validateRequest(asked[0]), []);
        let text = allPages(sh.child);
        assert.ok(/svc: 17:05:07 playing track 17927864 \(HIGH, aac\)/.test(text), text);
        assert.ok(/svc: 17:08:41 track 17927870: not available, skipped/.test(text), text);
        assert.ok(/car audio: connect/.test(text), 'with the app\'s own lines');
        // Refresh, with the controller
        svc.logLines.push('17:09:02 playing track 17927871 (HIGH, aac)');
        toButton(sh, REFRESH);
        await press(sh);
        assert.ok(sh.child, 'still the QR log (that was Refresh, not Back)');
        text = allPages(sh.child);
        assert.ok(/svc: 17:09:02 playing track 17927871/.test(text), text);
        // Refresh by touch (its target), nothing new
        const targets = drawSheet(sh);
        await Promise.resolve(targets[3].act());
        const file = fs.readFileSync(ctx.file, 'utf8');
        ['17:05:07 playing', '17:08:41 track', '17:09:02 playing'].forEach((l) => assert.strictEqual(file.split('svc: ' + l).length - 1, 1, l + ': once in the log'));
        // Back: the settings again; the QR log opened again writes nothing twice
        toButton(sh, BACK);
        await press(sh);
        assert.strictEqual(sh.child, null, 'Back closes the QR log');
        toQrRow(sh);
        // (the kit's list glides to the focused row frame by frame: with the app's settings longer than a page it
        // needs a few frames to reach the last row, as on the screen)
        for (let n = 0; n < 30; n++) drawSheet(sh);
        const tap = drawSheet(sh);
        await Promise.resolve(tap[tap.length - 1].act());               // the last row, by touch
        assert.ok(sh.child, 'opened again by touch');
        assert.strictEqual(fs.readFileSync(ctx.file, 'utf8').split('svc: 17:05:07').length - 1, 1);
        assert.ok(/svc: 17:05:07/.test(allPages(sh.child)));
        // the other rows of the settings work as before
        sh.child = null;
        sh.focus = 1;
        assert.strictEqual(await press(sh), null);
        assert.strictEqual(ctx.settings.get('wheel'), false, 'a switch still switches');
        assert.deepStrictEqual(ctx.errors, []);
    } finally { app.stop(); await svc.close(); }
});

test('app: no service: the QR log opens all the same, with one line saying the service did not answer', async () => {
    const ctx = fakeCtx();
    const app = createApp(ctx, { socketPath: tmpSock(), pollMs: 150, setImage() {}, decodeJpeg: decodeJpeg });
    try {
        await waitFor(() => app.state().screen === 'NO_SERVICE' && !app.state().starting, 3000, 'NO_SERVICE');
        const sh = ctx.openSettings();
        toQrRow(sh);
        const t0 = Date.now();
        await press(sh);
        assert.ok(Date.now() - t0 < 2500, 'the page does not wait long for a service that is not there');
        assert.ok(sh.child, 'open');
        toButton(sh, REFRESH);
        await press(sh);
        await press(sh);
        const text = allPages(sh.child);
        assert.strictEqual(text.split('svc: ').length - 1, 1, text);
        assert.ok(/svc: the service's log could not be read \(no-service\)/.test(text), text);
        assert.deepStrictEqual(ctx.errors, []);
    } finally { app.stop(); }
});

test('app: a service that answers `log` with garbage or not at all: the QR log opens, nothing throws (R1)', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: 'logged-in' } });
    const ctx = fakeCtx();
    const app = createApp(ctx, { socketPath: sock, pollMs: 150, setImage() {}, decodeJpeg: decodeJpeg });
    try {
        await waitFor(() => app.state().screen === 'LIBRARY', 3000, 'LIBRARY');
        const sh = ctx.openSettings();
        toQrRow(sh);
        svc.answer = (r) => (r.cmd === 'log' ? { id: r.id, ok: true, lines: [{ a: 1 }, 7, 'ok line', null] } : undefined);
        await press(sh);
        assert.ok(/svc: ok line/.test(allPages(sh.child)));
        // no answer at all (an answer nobody waits for): the page turns after a short wait, one line says so
        svc.answer = (r) => (r.cmd === 'log' ? { id: 0x7ffffff0, ok: true } : undefined);
        toButton(sh, REFRESH);
        const t0 = Date.now();
        await press(sh);
        assert.ok(Date.now() - t0 < 2500, 'a button of the page waits at most a moment: ' + (Date.now() - t0));
        assert.ok(sh.child);
        await waitFor(() => /svc: the service's log could not be read \(timeout\)/.test(fs.readFileSync(ctx.file, 'utf8')), 8000, 'the line about the timeout');
        assert.deepStrictEqual(ctx.errors, []);
    } finally { app.stop(); await svc.close(); }
}, { timeout: 30000 });

run();
