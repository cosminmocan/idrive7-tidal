'use strict';
/**
 * S1: the test runner itself. Runs on both images: Node 8.9.4 (what the car runs) and the current LTS.
 * The syntax checker must reject code the car's Node cannot parse, so nothing that ships uses newer syntax.
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./lib/t');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'syntax');
const CAR_NODE = 'v8.9.4';
const CURRENT_MAJOR = 22;
const onCarNode = process.version === CAR_NODE;

const checker = require(path.join(ROOT, 'tools', 'check-node8-syntax'));

test('runs on one of the two expected Node versions', () => {
    const major = Number(process.version.slice(1).split('.')[0]);
    assert.ok(onCarNode || major === CURRENT_MAJOR, 'unexpected Node ' + process.version);
});

test('a file in plain Node 8 syntax passes', () => {
    assert.deepStrictEqual(checker.checkFiles([path.join(FIX, 'good.js')]), []);
});

test('a file that no Node can parse is reported, with its name', () => {
    const errs = checker.checkFiles([path.join(FIX, 'broken.js')]);
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].file, path.join(FIX, 'broken.js'));
    assert.ok(/SyntaxError/.test(errs[0].error), errs[0].error);
});

test('optional chaining (a?.b) is rejected on the car\'s Node', () => {
    if (!onCarNode) { console.log('       (only meaningful on ' + CAR_NODE + ', skipped here)'); return; }
    const errs = checker.checkFiles([path.join(FIX, 'optional_chaining.js')]);
    assert.strictEqual(errs.length, 1, 'a?.b must not parse on Node 8');
});

test('nullish coalescing (a ?? b) is rejected on the car\'s Node', () => {
    if (!onCarNode) { console.log('       (only meaningful on ' + CAR_NODE + ', skipped here)'); return; }
    assert.strictEqual(checker.checkFiles([path.join(FIX, 'nullish.js')]).length, 1);
});

test('shippedFiles finds .js under apps/ and native/ and skips build output and node_modules', () => {
    const files = checker.shippedFiles(path.join(FIX, 'tree'));
    const rel = files.map((f) => path.relative(path.join(FIX, 'tree'), f).split(path.sep).join('/')).sort();
    assert.deepStrictEqual(rel, ['apps/a/main.js', 'native/s/service.js']);
});

test('every shipped file in this repository parses on this Node', () => {
    const errs = checker.checkFiles(checker.shippedFiles(ROOT));
    assert.deepStrictEqual(errs, []);
});

test('a test that never finishes fails after its time limit, and the next test still runs', () => {
    const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures', 'harness', 'hang.js')],
        { encoding: 'utf8', timeout: 10000, env: Object.assign({}, process.env, { T_TIMEOUT_MS: '300' }) });
    assert.notStrictEqual(r.signal, 'SIGTERM', 'the harness itself hung');
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(/FAIL never ends[\s\S]*timed out after 300 ms/.test(r.stdout), r.stdout);
    assert.ok(/ok   after the hang/.test(r.stdout), r.stdout);
});

run();
