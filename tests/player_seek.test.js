'use strict';
/**
 * player_seek.test.js - task S1 (phase 2): MGU_START_MS, the contract's seek (docs/PROTOCOL.md section 2). The
 * player gets the track from its first byte, decodes and throws away the sound before the position (not paced: as
 * fast as the input arrives), then plays: what it plays is, sample for sample, what a player started at 0 plays
 * from that position on. The first tick's pos is the position. A position at or past the end: `end` at once.
 * `make test-player`.
 */
const assert = require('assert');
const path = require('path');
const { test, run } = require('./lib/t');
const P = require('./fixtures/player/lib');

P.skipUnlessReady(__filename);

const T = { timeout: 120000 };
const dir = P.tmpdir();
let n = 0;
const wavPath = () => path.join(dir, 's' + (n++) + '.wav');
const ticks = (h) => h.events.filter((e) => e.ev === 'tick');

/** the track played from its start, uninterrupted: the reference (played once for the file) */
const refs = {};
function reference(name) {
    if (!refs[name]) {
        const out = wavPath();
        refs[name] = P.play(P.fixture(name), { env: { MGU_AUDIO: 'wav:' + out, MGU_PREBUFFER_MS: '200' } }).then((r) => {
            P.assertClean(r);
            assert.strictEqual(r.code, 0, r.stderr);
            return P.readWav(out);
        });
    }
    return refs[name];
}

/** p, and a player that a failed check left waiting is ended (it would keep this test file from ending) */
function ended(h, p) { return p.then((v) => v, (e) => { h.kill(); throw e; }); }

/** got is ref from frame `from` on, sample for sample, to the reference's last sample */
function assertSameFrom(got, ref, from, what) {
    assert.strictEqual(got.frames, ref.frames - from, what + ': ' + got.frames + ' frames, the reference has ' + (ref.frames - from) + ' from there');
    const a = got.data, b = ref.data, off = from * 2;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[off + i]) assert.fail(what + ': the sound differs from the reference at ' + ((from + Math.floor(i / 2)) / P.RATE).toFixed(4) + ' s');
    }
}

test('AAC, 24 s, started at 10 s: the sound is the reference from 10 s on, sample for sample', () => {
    return reference('tone1k_24s.m4a').then((ref) => {
        assert(Math.abs(ref.frames - 24 * P.RATE) < 0.1 * P.RATE, 'the reference is 24 s: ' + ref.frames / P.RATE);
        const out = wavPath();
        const h = P.start({ env: { MGU_AUDIO: 'wav:' + out, MGU_START_MS: '10000' } });
        h.feed(P.fixture('tone1k_24s.m4a'));
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(P.lastEvent(r).ev, 'end');
            const open = r.events.filter((e) => e.ev === 'open')[0];
            assert(Math.abs(open.duration - 24) < 0.1, 'open says the whole track: ' + JSON.stringify(open));
            const t = ticks(h);
            // the first tick says the position, and no tick is ever before it
            assert(t[0].pos >= 10 && t[0].pos < 10.6, 'the first tick: ' + JSON.stringify(t[0]));
            t.forEach((e, i) => { assert(e.pos >= 10, 'a tick before the position: ' + JSON.stringify(e)); if (i) assert(e.pos >= t[i - 1].pos, 'the position goes back'); });
            assert(t[t.length - 1].pos > 23 && t[t.length - 1].pos <= 24.1, 'the last tick: ' + JSON.stringify(t[t.length - 1]));
            // the 10 s before the position are not paced: playing long before 10 s have passed
            const first = t.filter((e) => e.state === 'playing')[0];
            assert(first && first._ms < 5000, 'playing after ' + (first && first._ms) + ' ms');
            // and the 14 s that are left take 14 s
            const s = (P.lastEvent(r)._ms - first._ms) / 1000;
            assert(s > 13.3 && s < 15.5, 'playing to end took ' + s.toFixed(2) + ' s');
            assert(r.ms < 20000, 'the whole run took ' + r.ms + ' ms');
            assertSameFrom(P.readWav(out), ref, 10 * P.RATE, 'from 10 s');
        });
    });
}, T);

test('FLAC resampled from 44.1 kHz, started at 2.5 s and at 9.999 s: the reference from there on', () => {
    return reference('tone1k_10s.flac').then((ref) => {
        const one = (ms) => {
            const out = wavPath();
            return P.play(P.fixture('tone1k_10s.flac'), { env: { MGU_AUDIO: 'wav:' + out, MGU_START_MS: String(ms) } }).then((r) => {
                P.assertClean(r);
                assert.strictEqual(r.code, 0, r.stderr);
                assert.strictEqual(P.lastEvent(r).ev, 'end');
                assertSameFrom(P.readWav(out), ref, ms * P.RATE / 1000, 'from ' + ms + ' ms');
            });
        };
        return one(2500).then(() => one(9999));
    });
}, T);

test('a position at the end or past it: end at once, exit 0, nothing played', () => {
    const one = (name, ms) => {
        const out = wavPath();
        const h = P.start({ env: { MGU_AUDIO: 'wav:' + out, MGU_START_MS: String(ms) } });
        h.feed(P.fixture(name));
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, name + ' at ' + ms + ': ' + r.stderr);
            assert.strictEqual(P.lastEvent(r).ev, 'end', name + ' at ' + ms);
            assert(!r.events.some((e) => e.ev === 'error'), 'no error');
            assert(r.ms < 6000, name + ' at ' + ms + ' took ' + r.ms + ' ms');
            assert.strictEqual(P.readWav(out).frames, 0, name + ' at ' + ms + ': no sound');
        });
    };
    return one('tone1k_10s.flac', 30000).then(() => one('tone1k_10s.m4a', 3600000)).then(() => one('tone1k_10s.flac', 99999999999));
}, T);

test('while the sound before the position is thrown away: buffering at the position; quit ends it at once', () => {
    const h = P.start({ env: { MGU_START_MS: '50000' } });
    const b = P.fixture('tone1k_60s.flac');
    // a third of the file, then nothing more: the position is never reached
    h.feed(b.slice(0, Math.floor(b.length / 3)), { keepOpen: true });
    return ended(h, P.delay(1800).then(() => {
        const t = ticks(h);
        assert(t.length >= 2, 'ticks: ' + JSON.stringify(t));
        t.forEach((e) => { assert.strictEqual(e.state, 'buffering', JSON.stringify(e)); assert.strictEqual(e.pos, 50, JSON.stringify(e)); });
        const t0 = Date.now();
        h.send('quit');
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, r.stderr);
            assert(Date.now() - t0 < 2500, 'quit took ' + (Date.now() - t0) + ' ms');
            assert(!r.events.some((e) => e.ev === 'end' || e.ev === 'error'), 'neither end nor error');
        });
    }));
}, T);

test('pause while seeking: paused at the position once it is reached, nothing written; resume plays from there', () => {
    return reference('tone1k_10s.flac').then((ref) => {
        const out = wavPath();
        const h = P.start({ env: { MGU_AUDIO: 'wav:' + out, MGU_START_MS: '6000' } });
        h.send('pause');
        h.feed(P.fixture('tone1k_10s.flac'));
        return ended(h, h.waitEvent((e) => e.ev === 'tick' && e.state === 'paused', 8000).then(() => P.delay(1200)).then(() => {
            ticks(h).forEach((e) => assert.strictEqual(e.pos, 6, 'the position stands at 6: ' + JSON.stringify(e)));
            h.send('resume');
            return h.done;
        }).then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(P.lastEvent(r).ev, 'end');
            assertSameFrom(P.readWav(out), ref, 6 * P.RATE, 'from 6 s');
        }));
    });
}, T);

test('MGU_START_MS that is no position (text, negative, empty) plays from the start', () => {
    const one = (v) => {
        const h = P.start({ env: { MGU_START_MS: v } });
        h.feed(P.fixture('tone1k_5s_48k.flac'));
        return h.done.then((r) => {
            P.assertClean(r, h);
            assert.strictEqual(r.code, 0, r.stderr);
            assert.strictEqual(P.lastEvent(r).ev, 'end');
            assert(ticks(h)[0].pos < 0.6, v + ': the first tick ' + JSON.stringify(ticks(h)[0]));
            assert(r.ms > 4800, v + ': played all 5 s (' + r.ms + ' ms)');
        });
    };
    return Promise.all([one('soon'), one('-5'), one(''), one('12abc')]);
}, T);

run();
