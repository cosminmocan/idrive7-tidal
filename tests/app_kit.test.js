'use strict';
/**
 * D0: the kit's runtime ships inside the app (build.py copies kit/runtime into it), so it must parse on the car's
 * Node 8.9.4 like everything under apps/ (tools/check-node8-syntax.js scans apps/ and native/ only). The kit is a
 * copy with its origin noted, and BMW's SDK is never part of it.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');

const ROOT = path.join(__dirname, '..');
const checker = require(path.join(ROOT, 'tools', 'check-node8-syntax'));

function jsUnder(dir, out) {
    fs.readdirSync(dir).sort().forEach((n) => {
        const p = path.join(dir, n);
        if (fs.statSync(p).isDirectory()) jsUnder(p, out);
        else if (/\.js$/.test(n)) out.push(p);
    });
    return out;
}

test('every kit/runtime .js file parses on this Node (on the node:8.9.4 image: the car\'s)', () => {
    const files = jsUnder(path.join(ROOT, 'kit', 'runtime'), []);
    assert.ok(files.length > 20, 'the runtime is there: ' + files.length + ' files');
    assert.deepStrictEqual(checker.checkFiles(files), []);
});

test('kit/ORIGIN.md names the kit\'s repository and commit', () => {
    const t = fs.readFileSync(path.join(ROOT, 'kit', 'ORIGIN.md'), 'utf8');
    assert.ok(/cauliflowermossgrape\/idrive7-apps/.test(t));
    assert.ok(/\b[0-9a-f]{40}\b/.test(t), 'a full commit sha');
});

test('no BMW SDK file is in kit/ or apps/ (rule R10)', () => {
    const bad = [];
    const walk = (d) => { if (!fs.existsSync(d)) return; fs.readdirSync(d).forEach((n) => { const p = path.join(d, n); if (n === 'oap-sdk' || n === 'node_modules') bad.push(p); else if (fs.statSync(p).isDirectory()) walk(p); }); };
    walk(path.join(ROOT, 'kit')); walk(path.join(ROOT, 'apps'));
    assert.deepStrictEqual(bad, []);
});

run();
