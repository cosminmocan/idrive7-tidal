'use strict';
/**
 * U1 (phase 2): the app on the kit's own display as in the car (mgu-render/1, full-screen layout: the kit runs the
 * screen, holds the controller, draws the header's tabs and the slim bar; tests/lib/kit_display.js).
 *
 * docs/ui-redesign.md section 1 found: the kit kept the controller for itself (display.js _ccu, its one long chain of
 * tabs, page targets and bar: the first turn landed on SETTINGS, push left closed the app), drew a second highlight
 * (its white ring) where the app drew its own, and dropped the app's BTN_PREV from the bar (its name for "previous
 * page"). Here: the controller follows the app's one rule (tests/app_nav.test.js), the kit's focus is the app's (one
 * highlight), the bar is PREVIOUS, PAUSE or PLAY, NEXT on every screen, the header's tabs LIBRARY, NOW PLAYING,
 * SETTINGS.
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const { test, run } = require('./lib/t');
const { kitApp } = require('./lib/kit_display');
const { createFakeService, TRACK } = require('./fakes/fake_service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tmpSock() { return path.join(os.tmpdir(), 'cmocan-kf-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.sock'); }
async function waitFor(fn, ms, what) {
    const end = Date.now() + (ms || 4000);
    while (Date.now() < end) { if (fn()) return; await sleep(20); }
    throw new Error('waited in vain for ' + what);
}
const track = (i) => Object.assign({}, TRACK, { id: 5000 + i, title: 'Track ' + i, coverId: null });
const tracks = (n, from) => { const a = []; for (let i = from || 0; i < (from || 0) + n; i++) a.push(track(i)); return a; };

/** the app on the kit, logged in, a list of `total` tracks served 50 at a time; `player` playing if given */
async function start(o) {
    o = o || {};
    const sock = tmpSock();
    const svc = await createFakeService({ socketPath: sock, state: { login: o.login || 'logged-in' } });
    if (o.player) svc.state.player = Object.assign({ state: 'playing', track: TRACK, position: 10, duration: 320, queueIndex: 0, queueLength: 3, quality: 'HIGH', error: null, skipped: [] }, o.player);
    const total = o.total || 8;
    svc.answer = (r) => {
        if (r.cmd === 'favorites' || r.cmd === 'playlist') return { id: r.id, ok: true, total: total, items: tracks(Math.min(50, total - (r.offset || 0)), r.offset || 0) };
        if (r.cmd === 'playlists') return { id: r.id, ok: true, total: 3, items: [{ uuid: 'a', title: 'A', numberOfTracks: 4 }, { uuid: 'b', title: 'B', numberOfTracks: 4 }, { uuid: 'c', title: 'C', numberOfTracks: 4 }] };
        return undefined;
    };
    const h = await kitApp({ socketPath: sock });
    h.svc = svc;
    h.s = () => h.app.state();
    h.done = async () => { h.close(); await svc.close(); };
    await waitFor(() => h.s().screen === (o.screen || 'LIBRARY') && (!o.player || (h.s().player && h.s().player.track)), 3000, o.screen || 'LIBRARY');
    await h.frame();
    return h;
}
/** the kit's focus and the app's one highlight: the same place */
function agree(h, key) {
    const d = h.disp, info = h.app.info();
    assert.strictEqual(d.focusKey, key, 'the kit\'s focus');
    if (/^tgt:/.test(key)) {
        assert.ok(info.focus, 'the app drew its highlight');
        assert.strictEqual('tgt:' + info.focus.key, key, 'the app\'s highlight');
        const t = (d.pageTargets || []).filter((q) => 'tgt:' + q.key === key)[0];
        assert.ok(t, 'a target of that key on the page: ' + (d.pageTargets || []).map((q) => q.key).join(' '));
        assert.ok(t.y <= info.focus.y && t.y + t.h >= info.focus.y + info.focus.h, 'the highlight is on that target');
    } else assert.strictEqual(info.focus, null, 'no highlight on the page while the kit\'s is in the header or the bar');
}
/** the kit's own ring (display.js _drawChrome: a halo 6 px wide round the page target it is on) in the last frame */
function kitRings(h) {
    const c = h.disp.chromeRec, out = [];
    const orig = c.strokeRoundRect;
    c.strokeRoundRect = function (x, y, w, hh, r, lw, col) { out.push({ lw: lw, c: col }); return orig.apply(this, arguments); };
    h.disp._compose();
    c.strokeRoundRect = orig;
    return out.filter((q) => q.lw === 6);
}

test('the bar spans the screen: its buttons share the width right of the back arrow column equally (the owner, 2026-11-28: "about half the width")', async () => {
    const h = await start();
    try {
        assert.ok(h.disp.own(), 'the kit runs the screen');
        const b = h.disp.buttons(), HMI = require('../kit/runtime/display').HMI;
        assert.strictEqual(b.length, 3);
        assert.strictEqual(b[0].x, HMI.left, 'the first starts at the back arrow column');
        const end = b[2].x + b[2].w;
        assert.strictEqual(end, HMI.screen.w, 'the last ends at the screen\'s right edge');
        b.forEach((q, i) => {
            assert.ok(Math.abs(q.w - (HMI.screen.w - HMI.left) / 3) <= 1, 'button ' + i + ' a third wide: ' + q.w);
            if (i) assert.strictEqual(q.x, b[i - 1].x + b[i - 1].w, 'button ' + i + ' follows the one before');
        });
        // a tap in the right third presses NEXT
        const pl = h.disp.place, sy = pl.h - h.disp.barH() + 10;
        const hit = h.disp.buttons().find((q) => 1800 >= q.x - pl.x && 1800 < q.x - pl.x + q.w);
        assert.strictEqual(hit && hit.id, 'BTN_NEXT', 'x 1800 is on NEXT (y ' + sy + ')');
    } finally { await h.done(); }
});

test('the bar: PREVIOUS, PAUSE (PLAY when nothing plays), NEXT, on every screen; nothing else in it', async () => {
    const h = await start();
    try {
        assert.ok(h.disp.own(), 'the kit runs the screen');
        assert.deepStrictEqual(h.disp.buttons().map((b) => b.label.toUpperCase()), ['PREVIOUS', 'PLAY', 'NEXT']);
        h.svc.state.player = { state: 'playing', track: TRACK, position: 1, duration: 320, queueIndex: 0, queueLength: 1, quality: 'HIGH', error: null, skipped: [] };
        await waitFor(() => h.disp.buttons()[1].label === 'Pause', 3000, 'PAUSE while playing');
        h.svc.state.player = Object.assign({}, h.svc.state.player, { state: 'paused' });
        await waitFor(() => h.disp.buttons()[1].label === 'Play', 3000, 'PLAY when paused');
        h.app.act({ type: 'open-now-playing' });
        await h.frame();
        assert.deepStrictEqual(h.disp.buttons().map((b) => b.id), ['BTN_PREVIOUS', 'BTN_PLAY', 'BTN_NEXT']);
        // a press on each sends its command
        h.comps.BTN_PREVIOUS.emit('action', {});
        h.comps.BTN_NEXT.emit('action', {});
        h.comps.BTN_PLAY.emit('action', {});
        await waitFor(() => ['prev', 'next', 'resume'].every((c) => h.svc.requests.some((r) => r.cmd === c)), 2000, 'prev, next, resume');
    } finally { await h.done(); }
});

test('the header: LIBRARY, NOW PLAYING, SETTINGS (the page shown lit); before the login only SETTINGS; a tab opens its page', async () => {
    const h = await start({ player: {} });
    try {
        assert.deepStrictEqual([h.disp._tabList().tabs, h.disp._tabList().sel], [['Library', 'Now playing', 'Settings'], 0]);
        h.disp._openTab(1);
        await sleep(20);
        assert.strictEqual(h.s().screen, 'NOW_PLAYING');
        await h.frame();
        assert.strictEqual(h.disp._tabList().sel, 1);
        h.disp._openTab(0);
        await sleep(20);
        assert.strictEqual(h.s().screen, 'LIBRARY');
        h.disp._openTab(2);
        await sleep(20);
        assert.deepStrictEqual(h.clicked.slice(-1), ['BTN_SETTINGS'], 'SETTINGS: the kit\'s settings');
    } finally { await h.done(); }
    const l = await start({ login: 'logged-out', screen: 'LOGIN' });
    try {
        await l.frame();
        assert.deepStrictEqual(l.disp._tabList().tabs, ['Settings']);
    } finally { await l.done(); }
});

test('the first turn moves the list\'s highlight, never onto SETTINGS; the kit\'s focus and the app\'s highlight are one', async () => {
    const h = await start();
    try {
        assert.strictEqual(h.disp.focusKey, 'tgt:row:0', 'on the first row before any turn');
        h.ccu({ knob: 1 });
        await h.frame();
        assert.strictEqual(h.s().library.sel, 1);
        agree(h, 'tgt:row:1');
        h.ccu({ knob: -5 });
        await h.frame();
        agree(h, 'tgt:row:0');
        assert.deepStrictEqual(kitRings(h), [], 'the kit draws no ring of its own on the page');
    } finally { await h.done(); }
});

test('one highlight after opening a list, going back one level, and paging through a long one', async () => {
    const h = await start({ total: 120 });
    try {
        h.ccu({ knob: 2 }); h.ccu({ press: true });                    // Playlists
        await waitFor(() => h.s().screen === 'LIST' && h.s().stack[0].items.length === 3, 3000, 'playlists');
        await h.frame();
        agree(h, 'tgt:row:0');
        h.ccu({ knob: 1 }); h.ccu({ press: true });                    // B
        await waitFor(() => h.s().stack.length === 2 && h.s().stack[1].items.length === 50, 3000, 'the playlist');
        await h.frame();
        agree(h, 'tgt:row:0');
        for (let i = 0; i < 60; i++) { h.ccu({ knob: 1 }); if (i % 10 === 9) { await sleep(30); await h.frame(); } }
        await waitFor(() => h.s().stack[1].items.length >= 100, 3000, 'the next page');
        h.ccu({ knob: 3 });
        await h.frame();
        assert.ok(h.s().stack[1].sel >= 60, String(h.s().stack[1].sel));
        agree(h, 'tgt:row:' + h.s().stack[1].sel);
        h.ccu({ tilt: 'W' });
        await h.frame();
        assert.deepStrictEqual([h.s().screen, h.s().stack.length], ['LIST', 1]);
        agree(h, 'tgt:row:1');
        h.ccu({ tilt: 'W' });
        await h.frame();
        assert.strictEqual(h.s().screen, 'LIBRARY');
        agree(h, 'tgt:row:2');
        assert.deepStrictEqual(h.closed, [], 'push left never closed the app on the way');
        h.ccu({ tilt: 'W' });
        await sleep(20);
        assert.deepStrictEqual(h.closed, ['MAIN'], 'from My music: it leaves');
    } finally { await h.done(); }
});

test('push down: the kit\'s bar holds the focus (PLAY / PAUSE first), a press presses it; push up: the tabs, then back down to the row', async () => {
    const h = await start({ player: {} });
    try {
        h.ccu({ knob: 1 });
        h.ccu({ tilt: 'S' });
        await h.frame();
        agree(h, 'bar:BTN_PLAY');
        assert.strictEqual(h.disp.focused, 'BTN_PLAY', 'the kit lights it');
        h.ccu({ knob: 1 });
        await h.frame();
        agree(h, 'bar:BTN_NEXT');
        h.ccu({ press: true });
        await waitFor(() => h.svc.requests.some((r) => r.cmd === 'next'), 2000, 'next');
        assert.deepStrictEqual(h.clicked.slice(-1), ['BTN_NEXT'], 'pressed as the HMI presses it');
        h.ccu({ tilt: 'N' });
        await h.frame();
        agree(h, 'tgt:row:1');
        h.ccu({ tilt: 'N' });
        await h.frame();
        agree(h, 'tab:0');
        h.ccu({ knob: 9 });
        await h.frame();
        agree(h, 'tab:2');
        h.ccu({ press: true });
        await sleep(20);
        assert.deepStrictEqual(h.clicked.slice(-1), ['BTN_SETTINGS']);
    } finally { await h.done(); }
});

test('now playing: the kit\'s bar on PAUSE when it opens; a press pauses; up is the progress line (the app\'s highlight)', async () => {
    const h = await start({ player: {} });
    try {
        h.ccu({ tilt: 'E' });
        await h.frame();
        assert.strictEqual(h.s().screen, 'NOW_PLAYING');
        agree(h, 'bar:BTN_PLAY');
        h.ccu({ press: true });
        await waitFor(() => h.svc.requests.some((r) => r.cmd === 'pause'), 2000, 'pause');
        h.ccu({ tilt: 'N' });
        await h.frame();
        assert.strictEqual(h.disp.focusKey, null, 'nothing of the kit\'s lit');
        assert.strictEqual(h.app.info().focus.key, 'progress');
        assert.deepStrictEqual(kitRings(h), []);
    } finally { await h.done(); }
});

test('a sheet of the kit (the settings) keeps the controller while it is open; after it the app\'s rule again', async () => {
    const h = await start();
    try {
        const moves = [];
        assert.ok(h.disp.openSheet({ settings: true, draw: () => [], move: (d) => moves.push(d), press() {}, back: () => 'close' }));
        h.ccu({ knob: 1 });
        assert.deepStrictEqual(moves, [1], 'the sheet moved');
        assert.strictEqual(h.s().library.sel, 0, 'the list did not');
        h.ccu({ tilt: 'W' });
        await sleep(20);
        assert.strictEqual(h.disp.sheet, null, 'closed by push left');
        h.ccu({ knob: 1 });
        await h.frame();
        agree(h, 'tgt:row:1');
    } finally { await h.done(); }
});

run();
