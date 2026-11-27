'use strict';
/**
 * tools/release.js: the automatic patch bump (owner's decision 2026-11-27: "bump patch automatically").
 * Builds are byte-identical (make dist twice gives the same archives), so a component is bumped exactly when its new
 * package differs from the published one at the same version. Unchanged components keep their version: the car is
 * never asked to reinstall something that did not change. Node 8.9.4 syntax.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const R = require('../tools/release');

const cat = (comps) => ({ schema: 2, components: comps.map((c) => ({ id: c[0], kind: c[0] === 'cmocan-tidal' ? 'tool' : 'app', version: c[1], artifact: { name: c[0] + '@' + c[1] + '.tgz', size: 1, sha256: c[2], url: 'x' } })) });

test('nothing published yet: nothing is bumped (the first release keeps its versions)', () => {
    assert.deepStrictEqual(R.plan(cat([['cmocan-tidal', '0.1.0', 'aa'], ['cmocan_tidal', '0.1.0', 'bb']]), null), []);
});

test('same version, same bytes: unchanged, not bumped', () => {
    const c = cat([['cmocan-tidal', '0.1.0', 'aa'], ['cmocan_tidal', '0.1.0', 'bb']]);
    assert.deepStrictEqual(R.plan(c, c), []);
});

test('same version, other bytes: the patch goes up by one', () => {
    const pub = cat([['cmocan-tidal', '0.1.0', 'aa'], ['cmocan_tidal', '0.1.0', 'bb']]);
    assert.deepStrictEqual(R.plan(cat([['cmocan-tidal', '0.1.0', 'XX'], ['cmocan_tidal', '0.1.0', 'bb']]), pub),
        [{ id: 'cmocan-tidal', from: '0.1.0', to: '0.1.1' }]);
    assert.deepStrictEqual(R.plan(cat([['cmocan-tidal', '0.1.9', 'XX'], ['cmocan_tidal', '0.1.0', 'YY']]), cat([['cmocan-tidal', '0.1.9', 'aa'], ['cmocan_tidal', '0.1.0', 'bb']])),
        [{ id: 'cmocan-tidal', from: '0.1.9', to: '0.1.10' }, { id: 'cmocan_tidal', from: '0.1.0', to: '0.1.1' }]);
});

test('a version already raised by hand is kept; a new component is kept', () => {
    const pub = cat([['cmocan-tidal', '0.1.0', 'aa']]);
    assert.deepStrictEqual(R.plan(cat([['cmocan-tidal', '0.2.0', 'XX'], ['cmocan_tidal', '0.1.0', 'bb']]), pub), []);
});

test('a version lower than the published one is refused (the car would never take it)', () => {
    assert.throws(() => R.plan(cat([['cmocan-tidal', '0.1.0', 'aa']]), cat([['cmocan-tidal', '0.1.3', 'aa']])), /lower than the published 0\.1\.3/);
});

test('versions compare as numbers, not text', () => {
    assert.ok(R.compare('0.1.10', '0.1.9') > 0);
    assert.ok(R.compare('1.0.0', '0.9.99') > 0);
    assert.strictEqual(R.compare('0.1.0', '0.1.0'), 0);
    assert.throws(() => R.compare('0.1', '0.1.0'), /x\.y\.z/);
});

function tree() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
    fs.mkdirSync(path.join(d, 'native')); fs.mkdirSync(path.join(d, 'native', 'cmocan-tidal'));
    fs.mkdirSync(path.join(d, 'apps')); fs.mkdirSync(path.join(d, 'apps', 'cmocan_tidal'));
    fs.writeFileSync(path.join(d, 'native/cmocan-tidal/component.json'), '{\n  "id": "cmocan-tidal",\n  "kind": "tool",\n  "version": "0.1.0",\n  "uids": [13150]\n}\n');
    fs.writeFileSync(path.join(d, 'native/cmocan-tidal/service.js'), "'use strict';\nconst VERSION = '0.1.0';\nmodule.exports = VERSION;\n");
    fs.writeFileSync(path.join(d, 'apps/cmocan_tidal/app.json'), '{\n  "id": "cmocan_tidal",\n  "version": "0.1.0",\n  "requires": { "cmocan-tidal": "0.1.0", "mgu-render": "0.6.26" }\n}\n');
    return d;
}

test('bumping the tool writes component.json and service.js, and the app requires the new tool', () => {
    const d = tree();
    R.apply(d, { id: 'cmocan-tidal', from: '0.1.0', to: '0.1.1' });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'native/cmocan-tidal/component.json'), 'utf8')).version, '0.1.1');
    assert.ok(/const VERSION = '0\.1\.1';/.test(fs.readFileSync(path.join(d, 'native/cmocan-tidal/service.js'), 'utf8')));
    const app = JSON.parse(fs.readFileSync(path.join(d, 'apps/cmocan_tidal/app.json'), 'utf8'));
    assert.strictEqual(app.requires['cmocan-tidal'], '0.1.1', 'the app needs the service it was built with');
    assert.strictEqual(app.requires['mgu-render'], '0.6.26');
    assert.strictEqual(app.version, '0.1.0', 'the app\'s own version is its own bump');
    // nothing else in the files changes (the uid stays)
    assert.ok(/"uids": \[13150\]/.test(fs.readFileSync(path.join(d, 'native/cmocan-tidal/component.json'), 'utf8')));
});

test('bumping the app writes app.json only', () => {
    const d = tree();
    R.apply(d, { id: 'cmocan_tidal', from: '0.1.0', to: '0.1.1' });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'apps/cmocan_tidal/app.json'), 'utf8')).version, '0.1.1');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'native/cmocan-tidal/component.json'), 'utf8')).version, '0.1.0');
});

test('a bump whose "from" is not what the files say is refused (nothing is written)', () => {
    const d = tree();
    assert.throws(() => R.apply(d, { id: 'cmocan-tidal', from: '0.0.9', to: '0.1.0' }), /files say 0\.1\.0/);
    assert.ok(/const VERSION = '0\.1\.0';/.test(fs.readFileSync(path.join(d, 'native/cmocan-tidal/service.js'), 'utf8')));
});

test('the repository\'s own version files agree with each other', () => {
    const root = path.join(__dirname, '..');
    const v = R.versions(root);
    assert.strictEqual(v.tool, v.service, 'component.json and service.js');
    assert.strictEqual(v.appRequiresTool, v.tool, 'the app requires the current service');
});

run();
