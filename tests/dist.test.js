'use strict';
/**
 * I2: the install packages (`make dist`, docs/INSTALL.md). The layout is mgu-store's catalog (docs/PUBLISHING.md,
 * "2. Catalog"): dist/idrive7-tidal/ holds catalog.json, the tool kit cmocan-tidal@<v>.tgz (deploy/hu artifact),
 * the app package cmocan_tidal@<v>.tgz (an OAP package without node_modules/oap-sdk: the head unit generates that
 * module from its donor) and the app's icon. The same folder is what a USB stick gets (usb-repo) and what the
 * private repository's `catalog` release holds (with the artifacts' API addresses: tools/dist_catalog.js release).
 *
 * The manifest and catalog tests always run. The archive tests run on what `make dist` built: CMOCAN_DIST names
 * the folder (make dist sets it), CMOCAN_USB the stick folder mgu-install.js usb-repo wrote from it; without them
 * they are skipped (in `make test`, which never builds).
 *
 * Rules: R10 (no BMW SDK file in any package), and no token, account name, TIDAL session or car address in any file.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./lib/t');
const { untgz } = require('./lib/tar');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'apps', 'cmocan_tidal');
const TOOL_DIR = path.join(ROOT, 'native', 'cmocan-tidal');
const PLAYER = path.join(ROOT, 'native', 'tidal-player', 'build', 'out', 'tidal-player');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const spec = () => readJson(path.join(APP_DIR, 'app.json'));
const comp = () => readJson(path.join(TOOL_DIR, 'component.json'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SEMVER = /^\d+\.\d+\.\d+$/;
function cmpVersions(a, b) {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
}

const DIST = process.env.CMOCAN_DIST ? path.resolve(ROOT, process.env.CMOCAN_DIST) : null;
const USB = process.env.CMOCAN_USB ? path.resolve(ROOT, process.env.CMOCAN_USB) : null;
function built(name, fn, opts) {
    if (DIST) return test(name, fn, opts);
    test(name + ' (skipped: no CMOCAN_DIST, run `make dist`)', () => {});
}

// ---- the oap-sdk's public API (mgu-store docs/PUBLISHING.md, "Leave out node_modules/oap-sdk"; the module paths
// as kit/tools/extract_sdk.js names them): none of these may be in a package (R10)
const SDK_API = {
    OnlineApp: 'src/core/OnlineApp.js', NsmProxy: 'src/core/NsmProxy.js', config: 'src/config/config.js',
    logging: 'src/logging/logging.js', loggingLevel: 'src/logging/loggingLevel.js', SDKError: 'src/errors/SDKError.js',
    someipBuilders: 'src/someip/someipBuilders.js', RhmiApplication: 'src/rhmi/RhmiApplication.js',
    RhmiResourcesLocator: 'src/rhmi/RhmiResourcesLocator.js', telephony: 'src/telephony/telephony.js',
    getVin: 'src/utils/getVin.js', runtimeVariant: 'src/utils/runtimeVariant.js',
    appstart: 'src-gen/joynr-includes/telematics/appstart.js', guidance: 'src/navigation/guiding/guidance.js',
    map: 'src/navigation/map/map.js', MapKmlContentTypeConverters: 'src/navigation/map/MapKmlContentTypeConverters.js',
    poi: 'src/navigation/poi/poi.js',
};
// file names only the SDK has (config.js, logging.js, map.js are common names: those are matched by their SDK path)
const SDK_NAMES = Object.keys(SDK_API).map((k) => path.posix.basename(SDK_API[k]))
    .filter((n) => ['config.js', 'logging.js', 'map.js'].indexOf(n) < 0);
const SDK_PATHS = Object.keys(SDK_API).map((k) => SDK_API[k]);
// a browserify bundle (how BMW's app.js links the SDK; tools/oap_link.js's BROWSERIFIED)
const BROWSERIFIED = /^\s*(?:\/\*[\s\S]*?\*\/\s*)?(?:\(function\(\)\{function r\(e,n,t\)\{|!function\(\)\{return function r\(e,n,t\)\{)/;

// ---- what no shipped file may hold: a token, a login, an account, the car's addresses
const SECRET_PATTERNS = [
    ['a JSON web token', /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/],
    ['an access or refresh token with a value', /["']?(access_token|refresh_token|accessToken|refreshToken|id_token|deviceCode|device_code)["']?\s*[:=]\s*["'][A-Za-z0-9._~+\/=-]{16,}["']/],
    ['a bearer token', /Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/],
    ['a GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['an e-mail address (an account name)', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|net|org|de|ro|io|me|eu|co\.uk|uk|fr|it|es|nl|at|ch)\b/i],
    ['a BMW VIN', /\b(WBA|WBS|WBY|WBX|WMW|5UX|5YM|4US)[A-HJ-NPR-Z0-9]{14}\b/],
    ['a link-local address (the car\'s ENET)', /\b169\.254\.\d{1,3}\.\d{1,3}\b/],
    ['a MAC address', /\b[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}\b/],
    ['a TIDAL user or session id field with a value', /["'](userId|user_id|sessionId|session_id)["']\s*:\s*(["'][^"']{2,}["']|\d{3,})/],
];
// third-party texts shipped as they are, read for every pattern but the e-mail and MAC ones (their authors'
// addresses; cacert.pem's certificate fingerprints are written as aa:bb:cc:...)
const THIRD_PARTY_TEXT = ['files/FFMPEG-LICENSE', 'files/cacert.pem'];
const OWN_FILES_ONLY = ['an e-mail address (an account name)', 'a MAC address'];

function isText(buf) {
    return buf.indexOf(0) < 0;
}

/** members of a package as { name: data } (files only) */
function filesOf(members) {
    const out = {};
    members.filter((m) => m.type === 'file').forEach((m) => { out[m.name] = m.data; });
    return out;
}

function checkNoSdk(label, members) {
    members.forEach((m) => {
        assert.ok(m.name.indexOf('oap-sdk') < 0, label + ': ' + m.name + ' has oap-sdk in its path (R10)');
        assert.ok(SDK_NAMES.indexOf(path.posix.basename(m.name)) < 0, label + ': ' + m.name + ' has an oap-sdk module\'s name (R10)');
        SDK_PATHS.forEach((p) => assert.ok(m.name.slice(-p.length - 1) !== '/' + p, label + ': ' + m.name + ' is the SDK\'s ' + p + ' (R10)'));
        if (m.type !== 'file' || !/\.js$/.test(m.name)) return;
        const text = m.data.toString('utf8');
        assert.ok(!BROWSERIFIED.test(text), label + ': ' + m.name + ' is a browserify bundle (an SDK-linked app.js) (R10)');
        assert.ok(text.indexOf('oap-sdk/src') < 0 && text.indexOf('src-gen/joynr-includes') < 0,
            label + ': ' + m.name + ' carries oap-sdk module code (R10)');
    });
}

function checkNoSecrets(label, members) {
    members.forEach((m) => {
        const base = path.posix.basename(m.name);
        assert.ok(!/^reference(\/|$)/.test(m.name) && m.name.indexOf('/reference/') < 0, label + ': ' + m.name + ' is from reference/');
        assert.ok(['session.json', 'credentials.json', '.env', 'id_rsa', 'token'].indexOf(base) < 0 && !/\.(key|pem\.key)$/.test(base),
            label + ': ' + m.name + ' looks like a login or a key');
        if (m.type !== 'file' || !isText(m.data)) return;
        const text = m.data.toString('utf8');
        SECRET_PATTERNS.forEach((p) => {
            if (OWN_FILES_ONLY.indexOf(p[0]) >= 0 && THIRD_PARTY_TEXT.indexOf(m.name) >= 0) return;
            const hit = p[1].exec(text);
            assert.ok(!hit, label + ': ' + m.name + ' holds ' + p[0] + (hit ? ' near offset ' + hit.index : ''));
        });
    });
}

/** mgu-store's rules for a catalog.json (native/mgu-updater/js/catalog.js parse, deploy/mgu-install.js usb-repo) */
function checkCatalog(cat) {
    assert.ok(cat && (cat.schema === 2) && Array.isArray(cat.components), 'schema 2 with components');
    const seen = {};
    cat.components.forEach((c) => {
        assert.ok(/^[a-z0-9][a-z0-9_-]*$/.test(c.id), 'id ' + c.id);
        assert.ok(!seen[c.id], c.id + ' listed once'); seen[c.id] = true;
        assert.ok(c.kind === 'app' || c.kind === 'tool', c.id + ': kind');
        assert.ok(SEMVER.test(c.version), c.id + ': version');
        assert.ok(c.artifact && c.artifact.name === c.id + '@' + c.version + '.tgz', c.id + ': artifact name <id>@<version>.tgz');
        assert.ok(/^[0-9a-f]{64}$/.test(c.artifact.sha256), c.id + ': sha256');
        assert.ok(c.artifact.size > 0, c.id + ': size');
        assert.ok(typeof c.artifact.url === 'string' && c.artifact.url, c.id + ': url');
        assert.deepStrictEqual(c.mguHmi, ['ID7'], c.id + ': for iDrive 7');
        if (c.requires) Object.keys(c.requires).forEach((k) => assert.ok(SEMVER.test(c.requires[k]), c.id + ' requires ' + k + ' x.y.z'));
        if (c.icon) assert.ok(/^[0-9a-f]{64}$/.test(c.iconSha256 || ''), c.id + ': iconSha256');
    });
    return cat.components.reduce((o, c) => { o[c.id] = c; return o; }, {});
}

// ================================================= the checks themselves (always): they do find what they look for

const file = (name, text) => ({ name: name, type: 'file', data: Buffer.from(text) });

test('the R10 check finds an oap-sdk folder, an SDK module by name or path, and an SDK-linked app.js', () => {
    assert.throws(() => checkNoSdk('x', [file('package/node_modules/oap-sdk/index.js', '')]), /oap-sdk in its path/);
    assert.throws(() => checkNoSdk('x', [file('package/javascript/OnlineApp.js', '')]), /module's name/);
    assert.throws(() => checkNoSdk('x', [file('package/javascript/src/config/config.js', '')]), /src\/config\/config\.js/);
    assert.throws(() => checkNoSdk('x', [file('package/javascript/app.js', '(function(){function r(e,n,t){return 1}})()({},{},[1]);')]), /browserify/);
    assert.throws(() => checkNoSdk('x', [file('package/javascript/x.js', 'require("oap-sdk/src/core/OnlineApp")')]), /module code/);
    checkNoSdk('x', [file('files/lib/tidal/config.js', 'module.exports = {};'), file('package/javascript/kit/mgu.js', "require('oap-sdk')")]);
});

test('the secrets check finds a token, a login, an e-mail, a VIN and the car\'s addresses', () => {
    // (no web token here: a sample one in this file is what the commit's secret scan rightly refuses)
    [['session.json', '{}'], ['x.json', '{"access_token": "abcdefghijklmnopqrstuvwxyz"}'],
     ['x.js', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'], ['x.txt', 'ghp_' + 'a'.repeat(36)],
     ['x.txt', 'someone@example.com'], ['x.txt', 'WBA' + '12345678901234'], ['x.txt', 'host 169.254.1.2'],
     ['x.txt', '00:1a:2b:3c:4d:5e'], ['x.json', '{"userId": 123456}'], ['reference/x.txt', '']]
        .forEach((x) => assert.throws(() => checkNoSecrets('x', [file(x[0], x[1])]), Error, x[0] + ': ' + x[1]));
    checkNoSecrets('x', [file('files/lib/tidal/session.js', 'const t = { access_token: data.access_token };')]);
});

// ================================================= manifests (always)

test('app.json: for iDrive 7, requires the tool (at most its version) and a renderer', () => {
    const s = spec(), c = comp();
    assert.deepStrictEqual(s.mguHmi, ['ID7']);
    assert.ok(s.requires && SEMVER.test(s.requires['cmocan-tidal'] || ''), 'requires cmocan-tidal');
    assert.ok(cmpVersions(c.version, s.requires['cmocan-tidal']) >= 0, 'the tool\'s version meets the app\'s requirement');
    assert.ok(SEMVER.test(s.requires['mgu-render'] || ''), 'requires a renderer (mgu-render; any installed renderer counts)');
    // the deploy tool generates oap-sdk from the car's donor at install (the app ships none): it must be new enough
    assert.ok(SEMVER.test(s.requires['mgu-deploy'] || ''), 'requires mgu-deploy (it generates oap-sdk on install)');
    assert.ok(cmpVersions(s.requires['mgu-deploy'], '0.7.0') >= 0, 'mgu-deploy 0.7.0 or newer, as the tool');
});

test('the app needs no internet of its own: no internet in app.json, no http/https/tls/dgram in its code (only the service\'s socket)', () => {
    const s = spec();
    assert.ok(s.internet === undefined && s.mguInternet === undefined, 'the app declares no internet: the tool fetches everything');
    fs.readdirSync(APP_DIR).filter((f) => /\.js$/.test(f)).forEach((f) => {
        const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
        ['http', 'https', 'tls', 'dgram', 'http2'].forEach((mod) => {
            assert.ok(src.indexOf("require('" + mod + "')") < 0, f + ' requires ' + mod);
        });
    });
});

test('component.json: internet for uid 13150 only, uninstallable, requires mgu-deploy and mgu-uplink (for the catalog)', () => {
    const c = comp();
    assert.strictEqual(c.internet, true);
    assert.deepStrictEqual(c.uids, [13150]);
    assert.strictEqual(c.uninstallable, true);
    assert.deepStrictEqual(Object.keys(c.requires).sort(), ['mgu-deploy', 'mgu-uplink']);
});

test('no mgu-repo.json (the repository is read through its catalog release, docs/INSTALL.md) and no oap-sdk/ in git', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'mgu-repo.json')), 'a repo tree would need the player binary in git');
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
    ['oap-sdk/', 'reference/', 'dist/', 'build/'].forEach((p) => assert.ok(ignore.indexOf(p) >= 0, p + ' is git-ignored'));
});

// ================================================= the catalog (always)

const dc = () => require('../tools/dist_catalog');
const FAKE_SHA = 'ab'.repeat(32);
const LOCAL = {
    schema: 2, name: 'idrive7-tidal', components: [
        { id: 'cmocan-tidal', kind: 'tool', version: '0.1.0', title: 'TIDAL service', mguHmi: ['ID7'],
          artifact: { name: 'cmocan-tidal@0.1.0.tgz', size: 100, sha256: FAKE_SHA, url: 'cmocan-tidal@0.1.0.tgz' },
          requires: { 'mgu-deploy': '0.7.0', 'mgu-uplink': '0.7.0' }, uninstallable: true },
        { id: 'cmocan_tidal', kind: 'app', version: '0.1.0', title: 'TIDAL', mguHmi: ['ID7'],
          artifact: { name: 'cmocan_tidal@0.1.0.tgz', size: 200, sha256: FAKE_SHA, url: 'cmocan_tidal@0.1.0.tgz' },
          requires: { 'cmocan-tidal': '0.1.0', 'mgu-render': '0.6.26' }, uninstallable: true,
          icon: 'cmocan_tidal.png', iconSha256: FAKE_SHA },
    ],
};
// GitHub's answer for a release's assets (GET /repos/<o>/<r>/releases/tags/catalog), its "assets" array
const ASSETS = [
    { name: 'cmocan-tidal@0.1.0.tgz', size: 100, url: 'https://api.github.com/repos/o/r/releases/assets/11' },
    { name: 'cmocan_tidal@0.1.0.tgz', size: 200, url: 'https://api.github.com/repos/o/r/releases/assets/12' },
    { name: 'cmocan_tidal.png', size: 50, url: 'https://api.github.com/repos/o/r/releases/assets/13' },
];

test('release catalog: each artifact at its asset\'s API address (a private repository), the rest as the local one', () => {
    const rel = dc().releaseCatalog(LOCAL, ASSETS);
    const byId = checkCatalog(rel);
    assert.strictEqual(byId['cmocan-tidal'].artifact.url, 'https://api.github.com/repos/o/r/releases/assets/11');
    assert.strictEqual(byId.cmocan_tidal.artifact.url, 'https://api.github.com/repos/o/r/releases/assets/12');
    assert.strictEqual(byId.cmocan_tidal.icon, 'cmocan_tidal.png', 'an icon is named by its asset\'s name');
    assert.deepStrictEqual(byId.cmocan_tidal.requires, LOCAL.components[1].requires);
    assert.strictEqual(LOCAL.components[0].artifact.url, 'cmocan-tidal@0.1.0.tgz', 'the local catalog is not changed');
});

test('release catalog: refused when an artifact is not uploaded, its size differs, or the address is not GitHub\'s API', () => {
    assert.throws(() => dc().releaseCatalog(LOCAL, ASSETS.slice(1)), /cmocan-tidal@0\.1\.0\.tgz/);
    assert.throws(() => dc().releaseCatalog(LOCAL, [Object.assign({}, ASSETS[0], { size: 99 })].concat(ASSETS.slice(1))), /size/);
    assert.throws(() => dc().releaseCatalog(LOCAL, [Object.assign({}, ASSETS[0], { url: 'http://example.org/x' })].concat(ASSETS.slice(1))), /api\.github\.com/);
    assert.throws(() => dc().releaseCatalog(LOCAL, ASSETS.slice(0, 2)), /cmocan_tidal\.png/);
});

// ================================================= the built packages (make dist)

function pkgs() {
    const c = comp(), s = spec();
    const tool = path.join(DIST, 'cmocan-tidal@' + c.version + '.tgz');
    const app = path.join(DIST, 'cmocan_tidal@' + s.version + '.tgz');
    return { c: c, s: s, toolFile: tool, appFile: app, tool: untgz(fs.readFileSync(tool)), app: untgz(fs.readFileSync(app)) };
}

built('dist holds catalog.json, the tool kit, the app package and the app\'s icon, nothing else', () => {
    const c = comp(), s = spec();
    assert.deepStrictEqual(fs.readdirSync(DIST).sort(),
        ['catalog.json', 'cmocan-tidal@' + c.version + '.tgz', 'cmocan_tidal.png', 'cmocan_tidal@' + s.version + '.tgz'].sort());
});

built('the tool kit unpacks: component.json names the id and version of the file, as deploy/hu artifact packs it', () => {
    const p = pkgs();
    const files = filesOf(p.tool);
    const k = JSON.parse(files['component.json'].toString('utf8'));
    assert.strictEqual(k.id, 'cmocan-tidal'); assert.strictEqual(k.kind, 'tool'); assert.strictEqual(k.version, p.c.version);
    assert.deepStrictEqual(k.mguHmi, ['ID7']);
    assert.strictEqual(k.internet, true); assert.deepStrictEqual(k.uids, [13150]);
    assert.deepStrictEqual(k.crashNames, p.c.crashNames); assert.deepStrictEqual(k.check, p.c.check);
    assert.deepStrictEqual(k.deactivate, p.c.deactivate); assert.deepStrictEqual(k.enable, p.c.enable);
    assert.deepStrictEqual(k.files.map((f) => f.path), p.c.files.map((f) => f.path), 'every file component.json names');
    k.files.forEach((f) => {
        const data = files['files/' + f.path];
        assert.ok(data, f.path + ' is in the kit');
        assert.strictEqual(sha256(data), f.sha256, f.path + ': its sha256');
        const src = p.c.files.filter((x) => x.path === f.path)[0];
        assert.strictEqual(sha256(fs.readFileSync(path.join(TOOL_DIR, src.from))), f.sha256, f.path + ': the file in the repository');
        assert.strictEqual(p.tool.filter((m) => m.name === 'files/' + f.path)[0].mode, parseInt(f.mode, 8), f.path + ': its mode');
    });
    p.c.units.forEach((u) => assert.ok(files['units/' + u.name], u.name + ' is in the kit'));
    p.tool.forEach((m) => assert.ok(m.type === 'file' && /^(component\.json|files\/.+|units\/[^/]+)$/.test(m.name), 'only the kit\'s layout: ' + m.name));
});

built('the player inside is the one `make player` built and check-target accepted (an x86-64 ELF, 0755)', () => {
    const p = pkgs();
    const m = p.tool.filter((x) => x.name === 'files/tidal-player')[0];
    assert.ok(m, 'files/tidal-player');
    assert.strictEqual(m.mode, 0o755);
    assert.strictEqual(sha256(m.data), sha256(fs.readFileSync(PLAYER)), 'byte for byte native/tidal-player/build/out/tidal-player');
    assert.strictEqual(m.data.slice(0, 4).toString('latin1'), '\x7fELF');
    assert.strictEqual(m.data[4], 2, 'ELFCLASS64');
    assert.strictEqual(m.data.readUInt16LE(18), 62, 'EM_X86_64');
});

built('the app package unpacks: package.json names the id and version of the file, for iDrive 7, without internet', () => {
    const p = pkgs();
    const files = filesOf(p.app);
    p.app.forEach((m) => assert.ok(m.name === 'package' || m.name.indexOf('package/') === 0, 'npm format, under package/: ' + m.name));
    const pkg = JSON.parse(files['package/package.json'].toString('utf8'));
    assert.strictEqual(pkg.name, 'cmocan_tidal'); assert.strictEqual(pkg.version, p.s.version);
    assert.deepStrictEqual(pkg.mguHmi, ['ID7']);
    assert.strictEqual(pkg.mguInternet, undefined, 'the app gets no internet');
    assert.strictEqual(pkg.main, 'javascript/app.js');
    assert.ok(files['package/rhmiData/application.json'], 'its rhmiData');
    assert.ok(files['package/manifest.json'] && files['package/permissions.json'] && files['package/npm-shrinkwrap.json']);
    assert.strictEqual(files['package/javascript/app.js'].toString('utf8'), fs.readFileSync(path.join(APP_DIR, 'main.js'), 'utf8'),
        'javascript/app.js is main.js as it is, not linked with anything');
    assert.ok(/require\('oap-sdk'\)/.test(files['package/javascript/kit/mgu.js'].toString('utf8')),
        'the kit asks for oap-sdk by name: the head unit generates it from its donor');
    fs.readdirSync(APP_DIR).filter((f) => /\.js$/.test(f) && f !== 'main.js').forEach((f) => {
        assert.ok(files['package/javascript/' + f], f + ' is in the package');
    });
});

built('R10: no oap-sdk path, no file with an oap-sdk module\'s name, no app.js linked with the SDK, in either package', () => {
    const p = pkgs();
    checkNoSdk('tool kit', p.tool);
    checkNoSdk('app package', p.app);
    assert.ok(!p.app.some((m) => /^package\/node_modules(\/|$)/.test(m.name)), 'the app ships no node_modules');
});

built('no file holds a token, an account name, a TIDAL session or an address of the car', () => {
    const p = pkgs();
    checkNoSecrets('tool kit', p.tool);
    checkNoSecrets('app package', p.app);
    checkNoSecrets('catalog.json', [{ name: 'catalog.json', type: 'file', data: fs.readFileSync(path.join(DIST, 'catalog.json')) }]);
});

built('catalog.json: both components, their files\' sizes and sha256, the requirements, the icon', () => {
    const p = pkgs();
    const byId = checkCatalog(readJson(path.join(DIST, 'catalog.json')));
    assert.deepStrictEqual(Object.keys(byId).sort(), ['cmocan-tidal', 'cmocan_tidal']);
    [['cmocan-tidal', p.toolFile, 'tool', p.c.version], ['cmocan_tidal', p.appFile, 'app', p.s.version]].forEach((x) => {
        const e = byId[x[0]], data = fs.readFileSync(x[1]);
        assert.strictEqual(e.kind, x[2]); assert.strictEqual(e.version, x[3]);
        assert.strictEqual(e.artifact.size, data.length); assert.strictEqual(e.artifact.sha256, sha256(data));
        assert.strictEqual(e.artifact.url, path.basename(x[1]), 'beside catalog.json');
        assert.strictEqual(e.uninstallable, true);
    });
    assert.deepStrictEqual(byId['cmocan-tidal'].requires, p.c.requires);
    assert.deepStrictEqual(byId.cmocan_tidal.requires, p.s.requires);
    assert.strictEqual(byId.cmocan_tidal.title, p.s.title);
    assert.strictEqual(byId['cmocan-tidal'].title, p.c.title);
    const icon = fs.readFileSync(path.join(DIST, 'cmocan_tidal.png'));
    assert.strictEqual(byId.cmocan_tidal.icon, 'cmocan_tidal.png');
    assert.strictEqual(byId.cmocan_tidal.iconSha256, sha256(icon));
    assert.ok(icon.length <= 128 * 1024 && icon.slice(1, 4).toString('latin1') === 'PNG', 'a PNG of at most 128 KiB');
});

if (USB) {
    test('usb-repo took the folder: the stick\'s mgu-repo/idrive7-tidal/ lists both with their requirements', () => {
        const dir = path.join(USB, 'mgu-repo', 'idrive7-tidal');
        const byId = checkCatalog(readJson(path.join(dir, 'catalog.json')));
        assert.deepStrictEqual(Object.keys(byId).sort(), ['cmocan-tidal', 'cmocan_tidal']);
        assert.deepStrictEqual(byId.cmocan_tidal.requires, spec().requires);
        Object.keys(byId).forEach((id) => {
            const a = byId[id].artifact;
            const data = fs.readFileSync(path.join(dir, a.url));
            assert.strictEqual(sha256(data), sha256(fs.readFileSync(path.join(DIST, a.name))), id + ': the same bytes as dist');
        });
    });
    test('usb-repo took the package files: the stick\'s mgu-repo/local/ lists the tool kit and the app', () => {
        const byId = checkCatalog(readJson(path.join(USB, 'mgu-repo', 'local', 'catalog.json')));
        assert.deepStrictEqual(Object.keys(byId).sort(), ['cmocan-tidal', 'cmocan_tidal']);
        assert.strictEqual(byId['cmocan-tidal'].kind, 'tool');
        assert.strictEqual(byId.cmocan_tidal.kind, 'app');
    });
}

run();
