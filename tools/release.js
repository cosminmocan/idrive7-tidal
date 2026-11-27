'use strict';
/**
 * release.js - the automatic patch bump for `make release` (tools/release.sh). Node 8.9.4 syntax, no npm packages.
 *
 * Builds are byte-identical, so a component is bumped exactly when its new package differs from the published one
 * at the same version (same sha256 = unchanged = no bump: the car is never asked to reinstall an unchanged part).
 * A version raised by hand, or a component not published yet, is kept as it is.
 *
 *   plan(localCatalog, publishedCatalog|null) -> [{ id, from, to }]
 *   apply(root, { id, from, to })   writes the new version into the files that hold it
 *   versions(root) -> { tool, service, app, appRequiresTool }
 *
 *   node tools/release.js plan <dist catalog.json> <published catalog.json | none>   prints the plan as JSON
 *   node tools/release.js apply '<json plan>'                                        applies it to this checkout
 *   node tools/release.js versions                                                   prints the versions
 */
const fs = require('fs');
const path = require('path');

const TOOL = 'cmocan-tidal';
const APP = 'cmocan_tidal';
const FILES = {
    component: 'native/cmocan-tidal/component.json',
    service: 'native/cmocan-tidal/service.js',
    app: 'apps/cmocan_tidal/app.json',
};

function parse(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
    if (!m) throw new Error('version ' + v + ' is not x.y.z');
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a, b) {
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

function nextPatch(v) { const p = parse(v); return p[0] + '.' + p[1] + '.' + (p[2] + 1); }

function plan(local, published) {
    const pub = {};
    ((published && published.components) || []).forEach((c) => { pub[c.id] = c; });
    const out = [];
    (local.components || []).forEach((c) => {
        const p = pub[c.id];
        if (!p) return;                                   // not published yet: kept
        const cmp = compare(c.version, p.version);
        if (cmp < 0) throw new Error(c.id + ' ' + c.version + ' is lower than the published ' + p.version + ': the car would never take it');
        if (cmp > 0) return;                              // raised by hand: kept
        if (c.artifact.sha256 === p.artifact.sha256) return;   // unchanged
        out.push({ id: c.id, from: c.version, to: nextPatch(c.version) });
    });
    return out;
}

/** the same catalog as the published one? Every field of every component counts, except the artifact's address
 *  (the published one is GitHub's asset address by design) */
function unchanged(local, published) {
    if (!published) return false;
    const norm = (cat) => JSON.stringify((cat.components || []).map((c) => {
        const o = JSON.parse(JSON.stringify(c));
        if (o.artifact) delete o.artifact.url;
        const sorted = {};
        Object.keys(o).sort().forEach((k) => { sorted[k] = o[k]; });
        return sorted;
    }).sort((x, y) => (x.id < y.id ? -1 : 1)));
    return norm(local) === norm(published);
}

/* ---------- the files that hold the versions: each edit changes only the version text ---------- */

function read(root, f) { return fs.readFileSync(path.join(root, FILES[f]), 'utf8'); }

function versions(root) {
    const app = JSON.parse(read(root, 'app'));
    const svc = /const VERSION = '([^']+)';/.exec(read(root, 'service'));
    return {
        tool: JSON.parse(read(root, 'component')).version,
        service: svc ? svc[1] : null,
        app: app.version,
        appRequiresTool: app.requires && app.requires[TOOL],
    };
}

/** replace exactly one occurrence of `re` in a file's text, or throw */
function replaceOnce(text, re, by, what) {
    let n = 0;
    const out = text.replace(re, function () { n++; return by.apply(null, arguments); });
    if (n !== 1) throw new Error(what + ': expected one version to change, found ' + n);
    return out;
}

function apply(root, b) {
    parse(b.to);
    const v = versions(root);
    const writes = [];
    if (b.id === TOOL) {
        if (v.tool !== b.from || v.service !== b.from) throw new Error(TOOL + ': the files say ' + v.tool + ' (service.js ' + v.service + '), not ' + b.from);
        writes.push(['component', replaceOnce(read(root, 'component'), /("version"\s*:\s*")([^"]+)(")/, (m, a, x, c) => a + b.to + c, FILES.component)]);
        writes.push(['service', replaceOnce(read(root, 'service'), /(const VERSION = ')([^']+)(';)/, (m, a, x, c) => a + b.to + c, FILES.service)]);
        // the app needs the service it was built and tested with
        writes.push(['app', replaceOnce(read(root, 'app'), /("cmocan-tidal"\s*:\s*")([^"]+)(")/, (m, a, x, c) => a + b.to + c, FILES.app + ' requires')]);
    } else if (b.id === APP) {
        if (v.app !== b.from) throw new Error(APP + ': the files say ' + v.app + ', not ' + b.from);
        writes.push(['app', replaceOnce(read(root, 'app'), /("version"\s*:\s*")([^"]+)(")/, (m, a, x, c) => a + b.to + c, FILES.app)]);
    } else {
        throw new Error('unknown component ' + b.id);
    }
    // every edit was checked first; only then is anything written
    writes.forEach((w) => fs.writeFileSync(path.join(root, FILES[w[0]]), w[1]));
}

module.exports = { unchanged: unchanged, plan: plan, apply: apply, versions: versions, compare: compare, nextPatch: nextPatch };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const root = path.join(__dirname, '..');
    const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
    try {
        if (argv[0] === 'plan' && argv.length === 3) {
            console.log(JSON.stringify(plan(readJson(argv[1]), argv[2] === 'none' ? null : readJson(argv[2]))));
        } else if (argv[0] === 'apply' && argv.length === 2) {
            // the tool first: its bump also changes the app's requirement
            JSON.parse(argv[1]).sort((a, b) => (a.id === TOOL ? -1 : b.id === TOOL ? 1 : 0)).forEach((b) => {
                apply(root, b); console.log(b.id + ': ' + b.from + ' -> ' + b.to);
            });
        } else if (argv[0] === 'unchanged' && argv.length === 3) {
            console.log(unchanged(readJson(argv[1]), argv[2] === 'none' ? null : readJson(argv[2])) ? 'yes' : 'no');
        } else if (argv[0] === 'versions' && argv.length === 1) {
            console.log(JSON.stringify(versions(root)));
        } else {
            console.error('usage: release.js plan <catalog.json> <published.json|none> | apply \'<plan json>\' | versions');
            process.exitCode = 2;
        }
    } catch (e) {
        console.error('release: ' + e.message);
        process.exitCode = 1;
    }
}
