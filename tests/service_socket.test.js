'use strict';
/**
 * C1: the control socket (docs/PROTOCOL.md section 1). Every command answers with its own id; anything that is not
 * a request gets bad-request and the connection stays usable (rule R2); two clients get their own answers; a client
 * that goes away mid-request does no harm.
 */
const assert = require('assert');
const net = require('net');
const { test, run } = require('./lib/t');
const P = require('./fakes/protocol');
const { startService } = require('./fakes/service_harness');

process.on('uncaughtException', (e) => { console.log('uncaught: ' + (e && e.stack)); process.exit(1); });

test('every command in the contract gets a valid answer with the same id', async () => {
    const h = await startService();
    try {
        const reqs = P.COMMANDS.filter((c) => c !== 'exit').map((cmd, i) => Object.assign({ id: 100 + i, cmd: cmd }, P.sampleParams(cmd)));
        const got = await h.ask(reqs);
        assert.strictEqual(got.length, reqs.length);
        reqs.forEach((r) => {
            const a = got.filter((x) => x.id === r.id)[0];
            assert.ok(a, 'an answer for ' + r.cmd);
            assert.deepStrictEqual(P.validateAnswer(r.cmd, a), [], r.cmd + ': ' + JSON.stringify(a));
        });
        const [e] = await h.ask([{ id: 7, cmd: 'exit' }]);
        assert.deepStrictEqual(P.validateAnswer('exit', e), []);
        assert.strictEqual(e.id, 7); assert.strictEqual(e.ok, true);
        await h.until(() => h.exits.length === 1, 3000, 'exit');
        assert.deepStrictEqual(h.exits, [0]);
    } finally { await h.close(); }
});

test('status answers with the contract\'s state', async () => {
    const h = await startService();
    try {
        const a = await h.req({ id: 3, cmd: 'status' });
        assert.deepStrictEqual(P.validateAnswer('status', a), []);
        assert.strictEqual(a.state.login, 'logged-out');
        assert.strictEqual(a.state.online, true);
        assert.strictEqual(a.state.player.state, 'idle');
        assert.strictEqual(a.state.player.queueIndex, -1);
        assert.strictEqual(a.state.prefs.quality, 'HIGH', 'the default with no prefs.json');
        assert.strictEqual(a.state.loginPending, null); assert.strictEqual(a.state.loginError, null);
        assert.deepStrictEqual(a.state.player.skipped, []);
    } finally { await h.close(); }
});

test('half a line, garbage, a 1 MiB line and unknown commands get bad-request; the connection stays usable', async () => {
    const h = await startService();
    try {
        const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x0a].slice(0, 5));
        const lines = [
            '{"id":1,"cm',                              // half a line
            garbage,                                    // binary garbage
            'x'.repeat(1024 * 1024),                    // a 1 MiB line
            { id: 4, cmd: 'reboot' },                   // an unknown command
            { id: 5, cmd: 'favorites', kind: 'videos' },   // bad parameters
            '[1,2,3]', 'null', '42', '{"cmd":"status"}', // JSON, but not a request
            { id: 9, cmd: 'status' },
        ];
        const got = await h.ask(lines);
        assert.strictEqual(got.length, lines.length, JSON.stringify(got));
        got.slice(0, -1).forEach((a, i) => {
            assert.strictEqual(a.ok, false, 'line ' + i + ': ' + JSON.stringify(a));
            assert.strictEqual(a.error, 'bad-request', 'line ' + i);
            assert.deepStrictEqual(P.validateAnswer('status', a), [], 'line ' + i);
        });
        assert.strictEqual(got.filter((a) => a.id === 4).length, 1, 'the unknown command keeps its id');
        assert.strictEqual(got.filter((a) => a.id === 5).length, 1, 'bad parameters keep the id');
        const last = got[got.length - 1];
        assert.strictEqual(last.id, 9); assert.strictEqual(last.ok, true);
        assert.deepStrictEqual(P.validateAnswer('status', last), []);
    } finally { await h.close(); }
});

test('a line longer than 64 KiB without an end gets one bad-request and is dropped', async () => {
    const h = await startService();
    try {
        const c = net.connect(h.sock);
        const got = [];
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
        await new Promise((r) => c.on('connect', r));
        for (let i = 0; i < 4; i++) c.write('y'.repeat(64 * 1024));
        await h.until(() => got.length >= 1, 3000, 'the bad-request');
        c.write('tail\n' + JSON.stringify({ id: 2, cmd: 'status' }) + '\n');
        await h.until(() => got.some((a) => a.id === 2), 3000, 'status');
        assert.strictEqual(got[0].error, 'bad-request'); assert.strictEqual(got[0].id, null);
        assert.strictEqual(got.length, 2, JSON.stringify(got));
        c.destroy();
    } finally { await h.close(); }
});

test('two clients at once each get their own answers', async () => {
    const h = await startService();
    try {
        const a = [], b = [];
        for (let i = 1; i <= 20; i++) { a.push({ id: i, cmd: 'status' }); b.push({ id: 1000 + i, cmd: i % 2 ? 'prefs' : 'status' }); }
        const res = await Promise.all([h.ask(a), h.ask(b)]);
        assert.deepStrictEqual(res[0].map((x) => x.id).sort((x, y) => x - y), a.map((x) => x.id));
        assert.deepStrictEqual(res[1].map((x) => x.id).sort((x, y) => x - y), b.map((x) => x.id));
        res[0].concat(res[1]).forEach((x) => assert.strictEqual(x.ok, true));
    } finally { await h.close(); }
});

test('a client that disconnects mid-request causes no exception', async () => {
    const h = await startService({ tidal: { library: { search: [] } } });
    try {
        for (let i = 0; i < 20; i++) {
            const c = net.connect(h.sock);
            await new Promise((r) => c.on('connect', r));
            c.write(JSON.stringify({ id: 1, cmd: i % 2 ? 'search' : 'status', query: 'x' }) + '\n' + '{"id":2,"cmd":"sta');
            c.destroy();
        }
        await h.sleep(200);
        const s = await h.status();
        assert.strictEqual(s.player.state, 'idle');
    } finally { await h.close(); }
});

run();
