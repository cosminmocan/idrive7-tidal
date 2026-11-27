#!/usr/bin/env node
'use strict';
/**
 * dist_catalog.js - the Store's catalog.json for the two components (mgu-store docs/PUBLISHING.md, "2. Catalog").
 *
 *   node tools/dist_catalog.js local <dir>
 *       <dir>/catalog.json for the tool kit and the app package in <dir> (what `make dist` writes): each artifact
 *       beside it, with its size and sha256; the requirements and titles from native/cmocan-tidal/component.json
 *       and apps/cmocan_tidal/app.json (deploy/hu artifact leaves requires and uninstallable to the catalog).
 *       A USB stick takes this folder as it is (mgu-install.js usb-repo <stick> <dir>).
 *
 *   node tools/dist_catalog.js release <catalog.json> <release.json> <out>
 *       the `catalog` release's catalog.json: the same, each artifact at its asset's API address
 *       (https://api.github.com/repos/<owner>/<repo>/releases/assets/<n>), which the head unit downloads with its
 *       token from a private repository. <release.json>: GitHub's answer for the release (or its "assets" array).
 *       tools/publish-catalog.sh runs it.
 *
 * Runs on Node 8.9.4 and current Node; no npm packages.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NAME = 'idrive7-tidal';
const API_ASSET = /^https:\/\/api\.github\.com\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/releases\/assets\/\d+$/;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function artifact(dir, name) {
    const data = fs.readFileSync(path.join(dir, name));
    return { name: name, size: data.length, sha256: sha256(data), url: name };
}

/** the catalog of the packages in dir (each named <id>@<version>.tgz, as the manifests in the repository say) */
function localCatalog(dir, root) {
    const r = root || ROOT;
    const c = readJson(path.join(r, 'native', 'cmocan-tidal', 'component.json'));
    const s = readJson(path.join(r, 'apps', 'cmocan_tidal', 'app.json'));
    const appId = s.id || 'cmocan_tidal';
    const tool = {
        id: c.id, kind: 'tool', version: c.version, title: c.title, description: c.description, mguHmi: c.mguHmi,
        artifact: artifact(dir, c.id + '@' + c.version + '.tgz'), requires: c.requires, uninstallable: c.uninstallable === true,
    };
    const app = {
        id: appId, kind: 'app', version: s.version, title: s.title, description: s.description, mguHmi: s.mguHmi,
        artifact: artifact(dir, appId + '@' + s.version + '.tgz'), requires: s.requires, uninstallable: true,
    };
    const icon = appId + '.png';
    if (fs.existsSync(path.join(dir, icon))) {
        app.icon = icon;
        app.iconSha256 = sha256(fs.readFileSync(path.join(dir, icon)));
    }
    return { schema: 2, name: NAME, components: [tool, app] };
}

/** the release's catalog: every artifact at its asset's API address; refused when one is missing or differs */
function releaseCatalog(catalog, assets) {
    const list = Array.isArray(assets) ? assets : (assets && assets.assets) || [];
    const byName = {};
    list.forEach((a) => { if (a && typeof a.name === 'string') byName[a.name] = a; });
    const out = JSON.parse(JSON.stringify(catalog));
    out.components.forEach((c) => {
        const a = byName[c.artifact.name];
        if (!a) throw new Error(c.artifact.name + ' is not an asset of the release: upload it first');
        if (a.size !== c.artifact.size) throw new Error(c.artifact.name + ': the asset\'s size ' + a.size + ' is not the package\'s ' + c.artifact.size);
        if (!API_ASSET.test(a.url || '')) throw new Error(c.artifact.name + ': ' + a.url + ' is not an asset address on api.github.com');
        c.artifact.url = a.url;
        if (c.icon && !byName[c.icon]) throw new Error(c.icon + ' (the icon of ' + c.id + ') is not an asset of the release');
    });
    return out;
}

function write(file, catalog) {
    fs.writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n');
}

function main(argv) {
    if (argv[0] === 'local' && argv.length === 2) {
        const cat = localCatalog(argv[1]);
        write(path.join(argv[1], 'catalog.json'), cat);
        cat.components.forEach((c) => console.log('catalog.json: ' + c.id + ' ' + c.version + ' (' + c.artifact.size + ' bytes)'));
        return 0;
    }
    if (argv[0] === 'release' && argv.length === 4) {
        const cat = releaseCatalog(readJson(argv[1]), readJson(argv[2]));
        write(argv[3], cat);
        cat.components.forEach((c) => console.log(argv[3] + ': ' + c.id + ' ' + c.version + ' at ' + c.artifact.url));
        return 0;
    }
    console.error('usage: dist_catalog.js local <dir> | release <catalog.json> <release.json> <out>');
    return 2;
}

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error('dist_catalog.js: ' + e.message);
        process.exitCode = 1;
    }
}

module.exports = { localCatalog: localCatalog, releaseCatalog: releaseCatalog };
