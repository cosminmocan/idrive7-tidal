'use strict';
/**
 * emu_forward.js - (cmocan-tidal's addition to the kit, not from idrive7-apps) run kit/tools/emu.js inside Docker.
 * emu.js serves its page on 127.0.0.1 only, which a published container port cannot reach; this passes
 * 0.0.0.0:<from> to 127.0.0.1:<to> inside the container and starts emu.js with the remaining arguments.
 *
 *   node kit/tools/emu_forward.js 8078 8077 cmocan_tidal --port 8077     (docker run -p 127.0.0.1:8077:8078 ...)
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const from = Number(process.argv[2]), to = Number(process.argv[3]);
net.createServer((c) => {
    const u = net.connect(to, '127.0.0.1');
    c.on('error', () => u.destroy());
    u.on('error', () => c.destroy());
    c.pipe(u).pipe(c);
}).listen(from, '0.0.0.0');
const emu = spawn(process.execPath, [path.join(__dirname, 'emu.js')].concat(process.argv.slice(4)), { stdio: 'inherit' });
emu.on('exit', (code) => process.exit(code == null ? 1 : code));
