'use strict';
/**
 * live-check.js - task A7: the TIDAL client against the real TIDAL, run by the owner with their own account.
 * Not part of `make test`. Node 8.9.4 syntax, no npm packages.
 *
 *   docker run --rm -it -v "$PWD:/w" -w /w node:8.9.4-slim node tools/live-check.js [--record] [--state DIR] [--dns IP,IP]
 *
 * 1. log in with TIDAL's device login: the link is printed, as a QR code when apps/cmocan_tidal/qrcode.js (or the
 *    file in $QRCODE_JS) is there; open it on the phone and approve;
 * 2. list ten favourite tracks (compare them with the TIDAL app);
 * 3. ask for the first playable one's stream address in LOSSLESS and in HIGH, download the first 256 KiB of each
 *    and say what they are: FLAC starts with "fLaC"; for MP4, whether its index (moov) comes before the audio (mdat);
 * 4. with --record, save TIDAL's raw answers, scrubbed of tokens and account data, in DIR/fixtures/ to compare
 *    with tests/fixtures/tidal/.
 *
 * DIR (default reference/live-check, which git ignores) keeps the session between runs, the samples and the
 * fixtures. Name servers come from /etc/resolv.conf (the car uses mgu-uplink's lease instead).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'native', 'cmocan-tidal', 'lib');
const SAMPLE_BYTES = 256 * 1024;

/* ---------- what the first bytes say ---------- */

function containerOf(buf) {
    if (!buf || buf.length < 8) return buf && buf.length >= 4 && buf.slice(0, 4).toString('latin1') === 'fLaC' ? 'flac' : 'unknown';
    if (buf.slice(0, 4).toString('latin1') === 'fLaC') return 'flac';
    if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'mp4';
    return 'unknown';
}

/** the boxes from `start` to `end` (a box may run past what we have; its header is enough) */
function boxesIn(buf, start, end) {
    const out = [];
    let off = start;
    while (off + 8 <= end && out.length < 1000) {
        let size = buf.readUInt32BE(off);
        const type = buf.slice(off + 4, off + 8).toString('latin1');
        let head = 8;
        if (!/^[a-zA-Z0-9 ©]{4}$/.test(type)) break;
        if (size === 1) {
            if (off + 16 > end) { out.push({ type: type, offset: off, size: null }); break; }
            size = buf.readUInt32BE(off + 8) * 4294967296 + buf.readUInt32BE(off + 12);
            head = 16;
        } else if (size === 0) {
            size = end - off;
        }
        if (size < head) break;
        out.push({ type: type, offset: off, size: size, head: head });
        off += size;
    }
    return out;
}

function mp4Layout(buf) {
    const top = boxesIn(buf, 0, buf.length);
    const types = top.map((b) => b.type);
    const moov = types.indexOf('moov');
    const mdat = types.indexOf('mdat');
    let fragmented = types.indexOf('moof') >= 0;
    if (moov >= 0) {
        const b = top[moov];
        const end = Math.min(buf.length, b.offset + b.size);
        if (boxesIn(buf, b.offset + b.head, end).some((x) => x.type === 'mvex')) fragmented = true;
    }
    let moovBeforeMdat = null;
    if (moov >= 0 && (mdat < 0 || moov < mdat)) moovBeforeMdat = true;
    else if (mdat >= 0) moovBeforeMdat = false;
    return { boxes: types, moovBeforeMdat: moovBeforeMdat, fragmented: fragmented };
}

/* ---------- the QR code ---------- */

/**
 * The link as terminal lines, two module rows per line. Light modules are full blocks and dark ones blank, so the
 * code reads on a dark terminal. qrcode: Kazuhiko Arase's qrcode.js (the app's copy), or null.
 */
function qrLines(text, qrcode, quiet) {
    if (!qrcode) return null;
    const q = quiet === undefined ? 2 : quiet;
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
    const lines = [];
    for (let r = -q; r < n + q; r += 2) {
        let line = '';
        for (let c = -q; c < n + q; c++) {
            const top = !dark(r, c);
            const bottom = r + 1 < n + q ? !dark(r + 1, c) : true;
            line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
        }
        lines.push(line);
    }
    return lines;
}

function findQrcode() {
    const tries = [process.env.QRCODE_JS, path.join(ROOT, 'apps', 'cmocan_tidal', 'qrcode.js')].filter(Boolean);
    for (let i = 0; i < tries.length; i++) {
        try { return require(tries[i]); } catch (e) { /* next */ }
    }
    return null;
}

/* ---------- recordings ---------- */

const SECRET_KEY = /token|password|secret|^devicecode$|^device_code$|sessionid$|^email$|^username$|^firstname$|^lastname$|^fullname$|^nickname$|^facebookuid$|^appleuid$|^googleuid$/i;
const USER_KEY = /^(userid|user_id|uid)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** a deep copy without tokens, account fields, emails, the user's id or stream addresses */
function scrub(v, key) {
    if (Array.isArray(v)) {
        if (key === 'urls') return v.map((u) => (typeof u === 'string' ? 'https://stream.example.invalid/track' : u));
        return v.map((x) => scrub(x));
    }
    if (v && typeof v === 'object') {
        const out = {};
        Object.keys(v).forEach((k) => {
            const x = v[k];
            if (SECRET_KEY.test(k) && x !== null && x !== undefined) out[k] = 'redacted';
            else if (USER_KEY.test(k) && x !== null && x !== undefined) out[k] = typeof x === 'number' ? 123456789 : 'redacted';
            else if (k === 'creator' && x && typeof x === 'object') out[k] = Object.assign(scrub(x), { id: 0 });
            else out[k] = scrub(x, k);
        });
        return out;
    }
    if (typeof v === 'string') return v.replace(EMAIL, 'redacted@example.invalid');
    return v;
}

function dnsFromResolvConf(text) {
    const out = [];
    String(text || '').split('\n').forEach((l) => {
        const m = /^\s*nameserver\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(l);
        if (m) out.push(m[1]);
    });
    return out.length ? out : ['1.1.1.1'];
}

/* ---------- the check ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function download(netx, url) {
    return netx.openStream({ url: url, headers: { Range: 'bytes=0-' + (SAMPLE_BYTES - 1) }, timeoutMs: 20000 }).then((r) => new Promise((resolve, reject) => {
        const chunks = [];
        let n = 0;
        let done = false;
        const finish = () => { if (done) return; done = true; resolve({ status: r.status, headers: r.headers, body: Buffer.concat(chunks).slice(0, SAMPLE_BYTES) }); };
        r.stream.on('data', (d) => {
            chunks.push(d);
            n += d.length;
            if (n >= SAMPLE_BYTES) { finish(); r.stream.destroy(); }
        });
        r.stream.on('end', finish);
        r.stream.on('error', (e) => { if (!done) { done = true; reject(e); } });
    }));
}

function main(o) {
    const opts = o || {};
    const print = opts.print || ((s) => process.stdout.write(s + '\n'));
    const state = opts.state || path.join(ROOT, 'reference', 'live-check');
    try { fs.mkdirSync(path.dirname(state)); } catch (e) { /* there */ }
    try { fs.mkdirSync(state, 448); } catch (e) { /* there */ }
    const leasePath = path.join(state, 'lease.json');
    let dns = opts.dns;
    if (!dns) { try { dns = dnsFromResolvConf(fs.readFileSync('/etc/resolv.conf', 'utf8')); } catch (e) { dns = ['1.1.1.1']; } }
    fs.writeFileSync(leasePath, JSON.stringify({ ip: '0.0.0.0', dns: dns }));
    const netx = require(path.join(LIB, 'netx')).createNetx({ leasePath: leasePath, caFile: path.join(ROOT, 'native', 'cmocan-tidal', 'cacert.pem') });
    const tidal = require(path.join(LIB, 'tidal')).createTidal({
        netx: netx, sessionFile: path.join(state, 'session.json'), coverDir: path.join(state, 'covers'),
        baseUrls: opts.baseUrls, log: opts.quiet ? undefined : (s) => print('  (log) ' + s),
    });
    const qrcode = opts.qrcode === undefined ? findQrcode() : opts.qrcode;
    const report = { loggedIn: false, favorites: [], streams: {}, fixtures: [] };
    const record = (name, json) => {
        if (!opts.record) return;
        const dir = path.join(state, 'fixtures');
        try { fs.mkdirSync(dir); } catch (e) { /* there */ }
        fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(scrub(json), null, 2) + '\n');
        report.fixtures.push(name);
    };
    const tryRecord = (name, p, params) => tidal._get(p, params).then((j) => record(name, j), (e) => print('  could not record ' + name + ': ' + e.code + ' ' + e.message));

    function login() {
        if (tidal.loggedIn()) { print('Logged in already (session in ' + state + ').'); return Promise.resolve(); }
        return tidal.loginStart().then((l) => {
            print('');
            print('Open this link on your phone and approve the login (code ' + l.userCode + ', valid ' + l.expiresIn + ' s):');
            print('  ' + l.url);
            const lines = qrLines(l.url, qrcode);
            if (lines) { print(''); lines.forEach((x) => print('  ' + x)); print(''); } else print('  (no qrcode.js found: QR code not drawn)');
            const wait = opts.pollMs || l.interval * 1000;
            const poll = () => sleep(wait).then(() => tidal.loginPoll()).then((r) => {
                if (r.state === 'pending') return poll();
                if (r.state !== 'authorized') throw new Error('login ' + r.state);
                print('Login approved.');
                return undefined;
            });
            return poll();
        });
    }

    function sample(trackId, quality) {
        return tidal.streamUrl(trackId, quality).then((s) => {
            const raw = opts.record
                ? tidal._get('tracks/' + trackId + '/urlpostpaywall', { urlusagemode: 'STREAM', audioquality: quality, assetpresentation: 'FULL' })
                    .then((j) => record('urlpostpaywall_' + quality, j), (e) => print('  could not record urlpostpaywall_' + quality + ': ' + e.code))
                : Promise.resolve();
            return raw.then(() => download(netx, s.url)).then((d) => {
                    const container = containerOf(d.body);
                    const r = { asked: quality, granted: s.quality, codec: s.codec, status: d.status, contentType: d.headers['content-type'],
                        contentRange: d.headers['content-range'] || null, bytes: d.body.length, container: container,
                        startsWithFlac: d.body.slice(0, 4).toString('latin1') === 'fLaC' };
                    if (container === 'mp4') Object.assign(r, mp4Layout(d.body));
                    fs.writeFileSync(path.join(state, 'sample_' + quality + (container === 'flac' ? '.flac' : container === 'mp4' ? '.m4a' : '.bin')), d.body);
                    report.streams[quality] = r;
                    print(quality + ': granted ' + s.quality + ' (' + s.codec + '), HTTP ' + d.status + ', ' + r.contentType + ', ' + r.bytes + ' bytes, ' + container +
                        (r.contentRange ? ', range ' + r.contentRange : ', no Content-Range (Range ignored?)'));
                    if (container === 'flac') print('  starts with fLaC: ' + r.startsWithFlac);
                    if (container === 'mp4') {
                        print('  top-level boxes: ' + r.boxes.join(' ') + (r.fragmented ? ' (fragmented MP4)' : ''));
                        print('  ' + (r.moovBeforeMdat === true ? 'moov comes BEFORE mdat: readable from a pipe' : r.moovBeforeMdat === false
                            ? 'moov comes AFTER mdat: NOT readable from a pipe (risk 1)' : 'moov/mdat not seen in the first 256 KiB'));
                    }
                });
        }, (e) => { report.streams[quality] = { asked: quality, error: e.code, message: e.message }; print(quality + ': ' + e.code + ' ' + e.message); });
    }

    return login().then(() => {
        report.loggedIn = true;
        return tidal.favorites('tracks', 0, 10);
    }).then((fav) => {
        report.favorites = fav.items;
        print('');
        print('Favourite tracks (' + fav.items.length + ' of ' + fav.total + '):');
        fav.items.forEach((t, i) => print('  ' + (i + 1) + '. ' + t.artists.join(', ') + ' - ' + t.title + (t.streamReady ? '' : '  [not streamable]')));
        print('');
        const first = fav.items.filter((t) => t.streamReady)[0];
        if (!first) { print('No playable favourite: add one in the TIDAL app.'); return undefined; }
        print('Stream addresses for: ' + first.title + ' (' + first.id + ')');
        return sample(first.id, 'LOSSLESS').then(() => sample(first.id, 'HIGH')).then(() => first);
    }).then((first) => {
        if (!opts.record) return undefined;
        let uid = null;
        try { uid = JSON.parse(fs.readFileSync(path.join(state, 'session.json'), 'utf8')).userId; } catch (e) { /* none */ }
        const me = 'users/' + uid + '/';
        return tryRecord('favorites_tracks', me + 'favorites/tracks', { offset: 0, limit: 10, order: 'DATE', orderDirection: 'DESC' })
            .then(() => tryRecord('favorites_albums', me + 'favorites/albums', { offset: 0, limit: 5, order: 'DATE', orderDirection: 'DESC' }))
            .then(() => tidal._get(me + 'playlistsAndFavoritePlaylists', { offset: 0, limit: 5 }).then((j) => {
                record('playlists', j);
                const p = j && j.items && j.items[0] && j.items[0].playlist;
                return p ? tryRecord('playlist_tracks', 'playlists/' + p.uuid + '/tracks', { offset: 0, limit: 5 }) : undefined;
            }, (e) => print('  could not record playlists: ' + e.code)))
            .then(() => (first && first.album ? tryRecord('album_tracks', 'albums/' + first.album.id + '/tracks', { offset: 0, limit: 5 }) : undefined))
            .then(() => tidal._get('pages/my_collection_my_mixes', { deviceType: 'BROWSER' }).then((j) => {
                record('page_my_mixes', j);
                let mixId = null;
                ((j && j.rows) || []).forEach((r) => ((r && r.modules) || []).forEach((m) => {
                    if (!mixId && m && m.type === 'MIX_LIST' && m.pagedList && m.pagedList.items && m.pagedList.items[0]) mixId = m.pagedList.items[0].id;
                }));
                return mixId ? tryRecord('page_mix', 'pages/mix', { mixId: mixId, deviceType: 'BROWSER' }) : undefined;
            }, (e) => print('  could not record mixes: ' + e.code)))
            .then(() => tryRecord('search', 'search', { query: 'daft punk', types: 'TRACKS', offset: 0, limit: 5 }))
            .then(() => print('Recorded (scrubbed) in ' + path.join(state, 'fixtures') + ': ' + report.fixtures.join(', ')));
    }).then(() => { netx.close(); return report; }, (e) => { netx.close(); throw e; });
}

function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--record') o.record = true;
        else if (argv[i] === '--state') o.state = path.resolve(argv[++i]);
        else if (argv[i] === '--dns') o.dns = String(argv[++i]).split(',');
        else if (argv[i] === '--verbose') o.quiet = false;
        else throw new Error('unknown argument ' + argv[i]);
    }
    if (o.quiet === undefined) o.quiet = true;
    return o;
}

if (require.main === module) {
    let o;
    try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(e.message + '\n'); process.exit(2); }
    main(o).then((report) => {
        process.stdout.write('\nReport:\n' + JSON.stringify({ streams: report.streams, favorites: report.favorites.length, fixtures: report.fixtures }, null, 2) + '\n');
        process.exit(0);
    }, (e) => { process.stderr.write('live check failed: ' + (e.code ? e.code + ': ' : '') + e.message + '\n'); process.exit(1); });
}

module.exports = { main: main, containerOf: containerOf, mp4Layout: mp4Layout, qrLines: qrLines, scrub: scrub, dnsFromResolvConf: dnsFromResolvConf, parseArgs: parseArgs };
