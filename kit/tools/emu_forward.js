'use strict';
/**
 * emu_forward.js - (cmocan-tidal's addition to the kit, not from idrive7-apps) run kit/tools/emu.js inside Docker.
 *
 * - emu.js serves its page on 127.0.0.1 only, which a published container port cannot reach: this passes
 *   0.0.0.0:<from> to 127.0.0.1:<to> inside the container.
 * - emu.js builds the app with `python3 kit/tools/build.py <id>`, which needs BMW's SDK (oap-sdk/, never in this
 *   repository). The emulator only runs the staged app, which `build.py --preview-only` makes without the SDK: a
 *   `python3` put first on emu.js's PATH adds --preview-only to build.py runs, so no SDK and no stand-in for it is
 *   needed, and no package is made.
 *
 *   node kit/tools/emu_forward.js 8078 8077 cmocan_tidal --port 8077     (docker run -p 127.0.0.1:8077:8078 ...)
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execSync } = require('child_process');

const from = Number(process.argv[2]), to = Number(process.argv[3]);
net.createServer((c) => {
    const u = net.connect(to, '127.0.0.1');
    c.on('error', () => u.destroy());
    u.on('error', () => c.destroy());
    c.pipe(u).pipe(c);
}).listen(from, '0.0.0.0');

const python = execSync('command -v python3', { encoding: 'utf8' }).trim();
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cmocan-emu-bin-'));
fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/sh\ncase "$1" in\n  */build.py) f="$1"; shift; exec "' + python + '" "$f" --preview-only "$@";;\nesac\nexec "' + python + '" "$@"\n');
fs.chmodSync(path.join(bin, 'python3'), 0o755);

const env = Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH });
const emu = spawn(process.execPath, [path.join(__dirname, 'emu.js')].concat(process.argv.slice(4)), { stdio: 'inherit', env: env });
emu.on('exit', (code) => process.exit(code == null ? 1 : code));
