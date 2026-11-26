'use strict';
/**
 * check-node8-syntax.js - every .js file that ships (under apps/ and native/) must parse on the Node that runs it.
 * The check is the running Node's own parser (`node --check`), so on the node:8.9.4 image it is exactly the car's.
 *
 *   node tools/check-node8-syntax.js [root]     // prints each file that does not parse, exits 1 if any
 *   checkFiles(files) -> [{ file, error }]
 *   shippedFiles(root) -> [absolute paths]
 */
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const SHIPPED = ['apps', 'native'];
const SKIP = { node_modules: true, build: true, dist: true, 'oap-sdk': true };

function walk(dir, out) {
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    names.sort().forEach((name) => {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) { if (!SKIP[name]) walk(p, out); }
        else if (st.isFile() && /\.js$/.test(name)) out.push(p);
    });
    return out;
}

function shippedFiles(root) {
    const out = [];
    SHIPPED.forEach((d) => walk(path.join(root, d), out));
    return out;
}

function checkFiles(files) {
    const errs = [];
    files.forEach((file) => {
        const r = childProcess.spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (r.status !== 0) errs.push({ file: file, error: String(r.stderr || r.error || 'exit ' + r.status).trim() });
    });
    return errs;
}

module.exports = { checkFiles: checkFiles, shippedFiles: shippedFiles };

if (require.main === module) {
    const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
    const errs = checkFiles(shippedFiles(root));
    errs.forEach((e) => console.log(e.file + '\n' + e.error + '\n'));
    console.log(errs.length ? errs.length + ' file(s) do not parse on Node ' + process.version : 'all shipped files parse on Node ' + process.version);
    process.exitCode = errs.length ? 1 : 0;
}
