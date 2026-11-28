'use strict';
/**
 * T1: which CPU the tests run on. By default the computer's own (the Mac: arm64; tools/arch.sh reads `uname -m`);
 * ARCH=amd64 runs them as x86-64, the car's CPU (the release gate, tools/release-gate.sh). tools/run-tests.sh picks
 * the Docker platform from it for both Node images; RUN_TESTS_DRY_RUN=1 prints the docker command instead of running
 * it. ARCH_HOST_UNAME stands in for `uname -m` here. Node 8.9.4 syntax.
 */
const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const { test, run } = require('./lib/t');

const ROOT = path.join(__dirname, '..');

/** runs sh with a clean environment plus env: {code, out, err} */
function sh(args, env) {
    const e = { PATH: process.env.PATH };
    Object.keys(env || {}).forEach((k) => { e[k] = env[k]; });
    const r = cp.spawnSync('sh', args, { cwd: ROOT, env: e, encoding: 'utf8' });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
/** what tools/arch.sh sets: [ARCH, PLATFORM, ARCH_SUFFIX, ARCH_BUILD] */
function arch(env) {
    const r = sh(['-c', '. tools/arch.sh && echo "$ARCH|$PLATFORM|$ARCH_SUFFIX|$ARCH_BUILD"'], env);
    assert.strictEqual(r.code, 0, 'arch.sh failed: ' + r.err);
    return r.out.trim().split('|');
}
function dryRun(which, env) {
    const r = sh(['tools/run-tests.sh', which], Object.assign({ RUN_TESTS_DRY_RUN: '1' }, env));
    assert.strictEqual(r.code, 0, 'run-tests.sh ' + which + ': ' + r.err);
    return r.out.trim();
}

test('the Mac (uname -m arm64) and an arm64 Linux (aarch64) run natively as arm64; the amd64 builds stay in build/', () => {
    assert.deepStrictEqual(arch({ ARCH_HOST_UNAME: 'arm64' }), ['arm64', 'linux/arm64', '-arm64', 'build/arm64']);
    assert.deepStrictEqual(arch({ ARCH_HOST_UNAME: 'aarch64' }), ['arm64', 'linux/arm64', '-arm64', 'build/arm64']);
    assert.deepStrictEqual(arch({ ARCH_HOST_UNAME: 'x86_64' }), ['amd64', 'linux/amd64', '', 'build']);
});

test('ARCH=amd64 on the Mac runs as x86-64, ARCH=arm64 as arm64', () => {
    assert.deepStrictEqual(arch({ ARCH_HOST_UNAME: 'arm64', ARCH: 'amd64' }), ['amd64', 'linux/amd64', '', 'build']);
    assert.deepStrictEqual(arch({ ARCH_HOST_UNAME: 'x86_64', ARCH: 'arm64' }), ['arm64', 'linux/arm64', '-arm64', 'build/arm64']);
});

test('any other ARCH, or an unknown CPU, is refused (exit 2, with the reason)', () => {
    const r = sh(['-c', '. tools/arch.sh && echo reached'], { ARCH_HOST_UNAME: 'arm64', ARCH: 'x86' });
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert(/ARCH/.test(r.err) && /arm64/.test(r.err) && /amd64/.test(r.err), r.err);
    assert(!/reached/.test(r.out));
    const u = sh(['-c', '. tools/arch.sh && echo reached'], { ARCH_HOST_UNAME: 'riscv64' });
    assert.strictEqual(u.code, 2, u.out + u.err);
    assert(/riscv64/.test(u.err), u.err);
});

test('run-tests.sh node8: node:8.9.4-slim on the Mac\'s own CPU by default, as x86-64 with ARCH=amd64', () => {
    const native = dryRun('node8', { ARCH_HOST_UNAME: 'arm64' });
    assert(/--platform=linux\/arm64 /.test(native) && / node:8\.9\.4-slim /.test(native), native);
    const x86 = dryRun('node8', { ARCH_HOST_UNAME: 'arm64', ARCH: 'amd64' });
    assert(/--platform=linux\/amd64 /.test(x86) && / node:8\.9\.4-slim /.test(x86), x86);
});

test('run-tests.sh current: node:22-slim follows ARCH as well', () => {
    assert(/--platform=linux\/arm64 .* node:22-slim /.test(dryRun('current', { ARCH_HOST_UNAME: 'arm64' })));
    assert(/--platform=linux\/amd64 .* node:22-slim /.test(dryRun('current', { ARCH_HOST_UNAME: 'arm64', ARCH: 'amd64' })));
});

test('run-tests.sh with a bad ARCH runs nothing and fails', () => {
    const r = sh(['tools/run-tests.sh', 'node8'], { RUN_TESTS_DRY_RUN: '1', ARCH: 'i386' });
    assert.strictEqual(r.code, 2, r.out + r.err);
    assert(!/docker run/.test(r.out), r.out);
});

run();
