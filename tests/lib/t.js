'use strict';
/**
 * t.js - the smallest test harness: no npm packages, runs on Node 8.9.4 (the car) and current Node.
 *
 *   const { test, run } = require('./lib/t');
 *   test('adds', () => assert.strictEqual(1 + 1, 2));
 *   test('async works', async () => { ... });
 *   test('slow', fn, { timeout: 60000 });
 *   run();   // runs every test in order, prints one line each, exits 1 on any failure
 */
const tests = [];
// each test must finish within this time (T_TIMEOUT_MS, or test(name, fn, { timeout })): a test that never ends fails
const DEFAULT_TIMEOUT_MS = Number(process.env.T_TIMEOUT_MS || 20000);

function test(name, fn, opts) { tests.push({ name: name, fn: fn, timeout: (opts && opts.timeout) || DEFAULT_TIMEOUT_MS }); }

function withTimeout(t) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out after ' + t.timeout + ' ms')), t.timeout);
        Promise.resolve().then(t.fn).then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); }
        );
    });
}

function run() {
    let failed = 0;
    let chain = Promise.resolve();
    tests.forEach((t) => {
        chain = chain.then(() => withTimeout(t)).then(
            () => { console.log('  ok   ' + t.name); },
            (e) => { failed++; console.log('  FAIL ' + t.name + '\n       ' + String((e && e.stack) || e).split('\n').join('\n       ')); }
        );
    });
    return chain.then(() => {
        console.log((failed ? 'FAILED ' : 'passed ') + (tests.length - failed) + '/' + tests.length);
        process.exitCode = failed ? 1 : 0;
    });
}

module.exports = { test: test, run: run };
