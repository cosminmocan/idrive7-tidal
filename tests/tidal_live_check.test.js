'use strict';
/**
 * A7: the parts of tools/live-check.js that can be tested without the real TIDAL: what the first bytes of a
 * download say (FLAC, or MP4 with its index before or after the audio), the QR code in the terminal, the
 * scrubbing of recorded fixtures, and the whole flow against the fake TIDAL.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const F = require('./fakes/fake_tidal');
const L = require('../tools/live-check');

function box(type, payload) {
    const p = payload || Buffer.alloc(0);
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + p.length, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, p]);
}
/** a box whose header says it is bigger than what we have (the download was cut at 256 KiB) */
function bigBoxHead(type, size) {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(size, 0);
    h.write(type, 4, 'latin1');
    return Buffer.concat([h, Buffer.alloc(100)]);
}

test('containerOf: FLAC, MP4, or unknown', () => {
    assert.strictEqual(L.containerOf(Buffer.from('fLaC\u0000\u0000\u0000"')), 'flac');
    assert.strictEqual(L.containerOf(box('ftyp', Buffer.from('M4A isom'))), 'mp4');
    assert.strictEqual(L.containerOf(Buffer.from('<html>')), 'unknown');
    assert.strictEqual(L.containerOf(Buffer.alloc(0)), 'unknown');
});

test('mp4Layout: the index (moov) before the audio (mdat)', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.from('M4A isom')), box('moov', box('trak')), bigBoxHead('mdat', 5000000)]);
    const l = L.mp4Layout(buf);
    assert.deepStrictEqual(l.boxes, ['ftyp', 'moov', 'mdat']);
    assert.strictEqual(l.moovBeforeMdat, true);
    assert.strictEqual(l.fragmented, false);
});

test('mp4Layout: the audio first and the index at the end', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.from('M4A isom')), box('free'), bigBoxHead('mdat', 9000000)]);
    const l = L.mp4Layout(buf);
    assert.deepStrictEqual(l.boxes, ['ftyp', 'free', 'mdat']);
    assert.strictEqual(l.moovBeforeMdat, false);
});

test('mp4Layout: fragmented MP4 (moov with mvex, then moof/mdat pairs)', () => {
    const buf = Buffer.concat([box('ftyp', Buffer.from('iso6')), box('moov', Buffer.concat([box('trak'), box('mvex')])), box('sidx'), box('moof'), box('mdat', Buffer.alloc(10)), box('moof')]);
    const l = L.mp4Layout(buf);
    assert.strictEqual(l.moovBeforeMdat, true);
    assert.strictEqual(l.fragmented, true);
    assert.deepStrictEqual(l.boxes, ['ftyp', 'moov', 'sidx', 'moof', 'mdat', 'moof']);
});

test('mp4Layout: neither box within the bytes we have is unknown (null); garbage does not throw', () => {
    assert.strictEqual(L.mp4Layout(Buffer.concat([box('ftyp'), bigBoxHead('free', 9000000)])).moovBeforeMdat, null);
    const junk = Buffer.alloc(300);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256;
    assert.doesNotThrow(() => L.mp4Layout(junk));
    const sixtyFour = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('mdat'), Buffer.from([0, 0, 0, 0, 0, 0, 0, 16])]);
    assert.deepStrictEqual(L.mp4Layout(Buffer.concat([box('ftyp'), sixtyFour])).boxes, ['ftyp', 'mdat']);
});

test('qrLines draws two module rows per line with a quiet zone, from qrcode.js\'s interface', () => {
    const fakeQr = () => ({ addData() {}, make() {}, getModuleCount: () => 2, isDark: (r, c) => r === c });
    const lines = L.qrLines('https://link.tidal.com/ABCDE', fakeQr, 1);
    // 2 modules + 1 quiet module each side = 4 rows -> 2 lines, 4 columns
    // light is a full block, dark is blank; the upper half block is light above dark
    assert.deepStrictEqual(lines, ['█▀██', '██▄█']);
    assert.strictEqual(L.qrLines('x', null), null);
});

test('qrLines: all dark is blank, all light is full blocks (works on a dark terminal)', () => {
    const allDark = () => ({ addData() {}, make() {}, getModuleCount: () => 2, isDark: () => true });
    const lines = L.qrLines('x', allDark, 0);
    assert.deepStrictEqual(lines, ['  ']);
    const allLight = () => ({ addData() {}, make() {}, getModuleCount: () => 2, isDark: () => false });
    assert.deepStrictEqual(L.qrLines('x', allLight, 0), ['██']);
});

test('scrub removes tokens, account fields, emails and stream addresses from recordings', () => {
    const raw = {
        access_token: 'eyJabc', refresh_token: 'r', user: { userId: 987654321, email: 'someone@example.com', username: 'me', countryCode: 'RO' },
        sessionId: 's-1', items: [{ item: { id: 5, title: 'Song by a@b.co', url: 'http://www.tidal.com/track/5' } }],
        urls: ['https://sp-pr-fa.audio.tidal.com/mediatracks/abc/0.flac?token=xyz'], securityToken: null, deviceCode: 'dc',
    };
    const s = L.scrub(raw);
    const text = JSON.stringify(s);
    assert.ok(!/eyJabc|someone@|"me"|s-1|xyz|987654321|"dc"/.test(text), text);
    assert.strictEqual(s.user.countryCode, 'RO');
    assert.strictEqual(s.items[0].item.id, 5);
    assert.strictEqual(s.items[0].item.url, 'http://www.tidal.com/track/5');
    assert.strictEqual(s.urls[0], 'https://stream.example.invalid/track');
    assert.strictEqual(s.securityToken, null);
    assert.strictEqual(raw.access_token, 'eyJabc', 'the original is not changed');
});

test('dnsFromResolvConf takes the IPv4 name servers, with a fallback', () => {
    assert.deepStrictEqual(L.dnsFromResolvConf('# x\nnameserver 192.168.65.7\nnameserver fe80::1\nnameserver 10.0.0.1\nsearch lan\n'), ['192.168.65.7', '10.0.0.1']);
    assert.deepStrictEqual(L.dnsFromResolvConf(''), ['1.1.1.1']);
});

test('the whole check against the fake TIDAL: login, ten favourites, both stream addresses, 256 KiB of each, fixtures', () =>
    F.createFakeTidal({ loginInterval: 1 }).then((fake) => {
        const dir = F.tmpDir('live-check');
        fake.files['77777703.flac'] = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(300 * 1024, 7)]);
        fake.files['77777703.m4a'] = Buffer.concat([box('ftyp', Buffer.from('M4A isom')), box('moov', box('trak')), bigBoxHead('mdat', 400 * 1024), Buffer.alloc(300 * 1024)]);
        const out = [];
        const approveSoon = setTimeout(() => fake.approve(), 300);
        return L.main({
            state: dir, record: true, baseUrls: fake.baseUrls, dns: ['192.0.2.53'], quiet: true,
            print: (s) => out.push(String(s)), qrcode: null, pollMs: 100,
        }).then((report) => {
            clearTimeout(approveSoon);
            const text = out.join('\n');
            assert.ok(/https:\/\/link\.tidal\.com\//.test(text), 'the link is printed');
            assert.strictEqual(report.loggedIn, true);
            assert.strictEqual(report.favorites.length, 7, 'up to ten: all seven of the fake');
            assert.strictEqual(report.streams.LOSSLESS.container, 'flac');
            assert.strictEqual(report.streams.LOSSLESS.bytes, 256 * 1024);
            assert.strictEqual(report.streams.LOSSLESS.startsWithFlac, true);
            assert.strictEqual(report.streams.HIGH.container, 'mp4');
            assert.strictEqual(report.streams.HIGH.moovBeforeMdat, true);
            assert.ok(/moov.*before.*mdat/i.test(text), text);
            const fx = fs.readdirSync(path.join(dir, 'fixtures')).sort();
            ['favorites_tracks.json', 'urlpostpaywall_HIGH.json', 'urlpostpaywall_LOSSLESS.json'].forEach((f) => assert.ok(fx.indexOf(f) >= 0, fx.join(',')));
            const all = fx.map((f) => fs.readFileSync(path.join(dir, 'fixtures', f), 'utf8')).join('\n');
            assert.ok(!/fake-access|fake-refresh|192837465/.test(all), 'scrubbed');
            assert.ok(fs.existsSync(path.join(dir, 'session.json')));
            const ranges = fake.log.filter((e) => /^\/files\//.test(e.path)).map((e) => e.headers.range);
            assert.deepStrictEqual(ranges, ['bytes=0-262143', 'bytes=0-262143']);
            return fake.close();
        }, (e) => { clearTimeout(approveSoon); return fake.close().then(() => { throw e; }); });
    }), { timeout: 30000 });

run();
