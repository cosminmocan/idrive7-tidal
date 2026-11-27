'use strict';
/**
 * S3: the fake service and the fake player speak the contract (docs/PROTOCOL.md). Streams A, B, C and D are
 * built against these, so they must be checked with the same validator as the real parts.
 */
const assert = require('assert');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const childProcess = require('child_process');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { createFakeService } = require('./fakes/fake_service');

const FAKE_PLAYER = path.join(__dirname, 'fakes', 'fake_player.js');

function tmpSock() { return path.join(os.tmpdir(), 'cmocan-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }

/** send one request line per element, collect the same number of answer lines */
function ask(sock, requests) {
    return new Promise((resolve, reject) => {
        const c = net.connect(sock);
        let buf = '';
        const got = [];
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
            if (got.length >= requests.length) { c.end(); resolve(got); }
        });
        c.on('error', reject);
        c.on('connect', () => requests.forEach((r) => c.write((typeof r === 'string' ? r : JSON.stringify(r)) + '\n')));
    });
}

test('fake service: status answers with a valid state', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    try {
        const [a] = await ask(sock, [{ id: 1, cmd: 'status' }]);
        assert.deepStrictEqual(P.validateAnswer('status', a), []);
        assert.strictEqual(a.id, 1);
        assert.strictEqual(a.state.login, 'logged-out');
    } finally { await svc.close(); }
    assert.ok(!fs.existsSync(sock), 'socket removed on close');
});

test('fake service: answers carry the request id; bad lines get bad-request and the connection stays usable', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    try {
        const got = await ask(sock, ['{not json', { id: 9, cmd: 'reboot' }, { id: 4, cmd: 'status' }]);
        assert.strictEqual(got[0].ok, false); assert.strictEqual(got[0].error, 'bad-request');
        assert.strictEqual(got[1].id, 9); assert.strictEqual(got[1].error, 'bad-request');
        assert.strictEqual(got[2].id, 4); assert.strictEqual(got[2].ok, true);
        got.forEach((a, i) => assert.deepStrictEqual(P.validateAnswer('status', a), [], 'answer ' + i));
    } finally { await svc.close(); }
});

test('fake service: every command gets a valid answer', async () => {
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock });
    try {
        const reqs = P.COMMANDS.filter((c) => c !== 'exit').map((cmd, i) => Object.assign({ id: i + 1, cmd: cmd }, P.sampleParams(cmd)));
        reqs.forEach((r) => assert.deepStrictEqual(P.validateRequest(r), [], 'sample request ' + r.cmd));
        const got = await ask(sock, reqs);
        got.forEach((a, i) => assert.deepStrictEqual(P.validateAnswer(reqs[i].cmd, a), [], reqs[i].cmd + ': ' + JSON.stringify(a)));
    } finally { await svc.close(); }
});

function runPlayer(bytes, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
        const child = childProcess.spawn(process.execPath, [FAKE_PLAYER], {
            stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            env: Object.assign({}, process.env, { MGU_AUDIO: 'null', FAKE_SECONDS: String(o.seconds || 1), FAKE_TICK_MS: '20' }),
        });
        const events = [];
        let buf = '';
        child.stdout.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const ev = P.parsePlayerLine(buf.slice(0, i)); buf = buf.slice(i + 1);
                if (ev) { events.push(ev); if (o.onEvent) o.onEvent(ev, child); }
            }
        });
        child.on('exit', (code) => resolve({ code: code, events: events }));
        child.stdin.end(bytes);
    });
}

test('fake player: a track plays to the end with valid events in order', async () => {
    const r = await runPlayer(Buffer.from('fLaC0000'), { seconds: 0.2 });
    assert.strictEqual(r.code, 0);
    r.events.forEach((e) => assert.deepStrictEqual(P.validatePlayerEvent(e), [], JSON.stringify(e)));
    const names = r.events.map((e) => e.ev);
    assert.strictEqual(names[0], 'open');
    assert.ok(names.indexOf('tick') > 0, 'ticks after open');
    assert.strictEqual(names[names.length - 1], 'end');
});

test('fake player: quit on fd 3 ends it early with exit code 0', async () => {
    let sent = false;
    const r = await runPlayer(Buffer.from('fLaC0000'), { seconds: 30, onEvent: (ev, child) => { if (ev.ev === 'tick' && !sent) { sent = true; child.stdio[3].write('quit\n'); } } });
    assert.strictEqual(r.code, 0);
    assert.ok(r.events.length < 50, 'ended long before 30 s');
});

test('fake player: fd 3 closing means quit, as the real player (a player never outlives its service)', async () => {
    let closed = false;
    const r = await runPlayer(Buffer.from('fLaC0000'), { seconds: 30, onEvent: (ev, child) => { if (ev.ev === 'tick' && !closed) { closed = true; child.stdio[3].end(); } } });
    assert.strictEqual(r.code, 0);
    assert.ok(r.events.length < 50, 'ended long before 30 s');
    assert.notStrictEqual(r.events[r.events.length - 1].ev, 'end', 'quit, not played to the end');
});

test('fake player: empty input is an input error with exit code 4', async () => {
    const r = await runPlayer(Buffer.alloc(0));
    assert.strictEqual(r.code, 4);
    const last = r.events[r.events.length - 1];
    assert.strictEqual(last.ev, 'error'); assert.strictEqual(last.code, 'input');
});

run();
