'use strict';
/**
 * D0: the car app is staged as kit/tools/build.py --preview-only stages it (no BMW SDK), started on the kit's
 * stubbed head unit (kit/tools/hu-stub.js) and asked for a frame: one frame must come and nothing may be logged as
 * an error. The test images have no Python, so the staging is done here the way build.py does it for an English
 * preview (`make app-preview` runs the real build.py). The service socket points at nothing: the app must still draw.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'cmocan_tidal');
const KIT = path.join(ROOT, 'kit');

function copyDir(from, to) {
    fs.mkdirSync(to);
    fs.readdirSync(from).forEach((n) => {
        const a = path.join(from, n), b = path.join(to, n);
        if (fs.statSync(a).isDirectory()) copyDir(a, b);
        else fs.writeFileSync(b, fs.readFileSync(a));
    });
}

/** dist/<id> as build.py --preview-only makes it (English): source/javascript/{app.js, *.js, kit/} */
function stage(into) {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    const js = path.join(into, 'source', 'javascript');
    fs.mkdirSync(path.join(into, 'source'));
    fs.mkdirSync(js);
    fs.readdirSync(APP).filter((f) => /\.js$/.test(f)).forEach((f) => {
        fs.writeFileSync(path.join(js, f === 'main.js' ? 'app.js' : f), fs.readFileSync(path.join(APP, f)));
    });
    copyDir(path.join(KIT, 'runtime'), path.join(js, 'kit'));
    const rt = {};
    ['id', 'title', 'version', 'screens', 'settings', 'config', 'startWidget'].forEach((k) => { rt[k] = spec[k] === undefined ? null : spec[k]; });
    rt.stateIds = {};
    fs.writeFileSync(path.join(js, 'kit', 'app-spec.json'), JSON.stringify(rt));
    fs.writeFileSync(path.join(js, 'kit', 'locale.json'), JSON.stringify({ language: 'en', strings: {} }));
    return spec;
}

// the child: the stubbed head unit, one frame asked for, what was drawn and logged printed as JSON
const CHILD = `
const path = require('path');
const [stageDir, dataDir, hustub] = process.argv.slice(1);
const errors = [], frames = [];
const keep = (l) => (...a) => { if (l === 'error') errors.push(a.map(String).join(' ')); };
console.error = keep('error'); console.warn = keep('warn'); console.log = () => {}; console.info = () => {};
process.on('uncaughtException', (e) => errors.push('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => errors.push('unhandled: ' + (e && e.stack || e)));
const { headUnit } = require(hustub);
const hu = headUnit(stageDir, { dataDir, fresh: true, image: (name, cv) => { frames.push({ name, w: cv.w, h: cv.h }); } });
hu.start();
setTimeout(async () => {
    try { await hu.loopFn(); } catch (e) { errors.push('loop: ' + (e && e.stack || e)); }
    setTimeout(() => { process.stdout.write(JSON.stringify({ frames, errors, loops: Object.keys(hu.loops) }) + '\\n'); process.exit(0); }, 300);
}, 800);
`;

test('the staged app starts on the stubbed head unit, draws a frame and logs no error', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-smoke-'));
    const stageDir = path.join(tmp, 'cmocan_tidal');
    fs.mkdirSync(stageDir);
    const spec = stage(stageDir);
    assert.strictEqual(spec.id, 'cmocan_tidal');
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);
    const r = childProcess.spawnSync(process.execPath, ['-e', CHILD, stageDir, dataDir, path.join(KIT, 'tools', 'hu-stub.js')], {
        encoding: 'utf8', timeout: 15000,
        env: Object.assign({}, process.env, { CMOCAN_TIDAL_SOCK: path.join(tmp, 'no-service.sock') }),
    });
    assert.strictEqual(r.status, 0, 'child exit ' + r.status + '\n' + r.stderr + r.stdout);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(out.errors, [], 'errors logged');
    assert.ok(out.loops.indexOf('MAIN') >= 0, 'the app runs a loop on MAIN: ' + JSON.stringify(out.loops));
    assert.ok(out.frames.length >= 1, 'at least one frame drawn');
    assert.strictEqual(out.frames[0].name, 'MAIN_GFX');
    assert.strictEqual(out.frames[0].w, 1600);
}, { timeout: 30000 });

run();
