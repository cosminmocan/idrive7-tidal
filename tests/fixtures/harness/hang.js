'use strict';
// a test file whose second test never finishes: the harness must fail it after T_TIMEOUT_MS and still run the third
const { test, run } = require('../../lib/t');
test('quick', () => {});
test('never ends', () => new Promise(() => {}));
test('after the hang', () => {});
run();
