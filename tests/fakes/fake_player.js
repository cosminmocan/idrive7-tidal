'use strict';
/**
 * fake_player.js - a stand-in for the real player (docs/PROTOCOL.md, section 2), for the service's tests
 * (stream C). It reads the whole input, then "plays" FAKE_SECONDS of it with a tick every FAKE_TICK_MS
 * (each tick advances the position by 0.5 s, as the real player's 500 ms tick does). No sound.
 *
 *   node fake_player.js       stdin: track bytes; fd 3: commands; stdout: MGU {json} events
 *   FAKE_SECONDS (default 2), FAKE_TICK_MS (default 500), FAKE_RECORD=<path>: write the bytes received there
 */
const fs = require('fs');
const net = require('net');

const SECONDS = Number(process.env.FAKE_SECONDS || 2);
const TICK_MS = Number(process.env.FAKE_TICK_MS || 500);
const EXIT = { ok: 0, input: 4, decode: 5, audio: 6 };

function emit(ev) { process.stdout.write('MGU ' + JSON.stringify(ev) + '\n'); }

let state = 'playing';
let pos = 0;
let timer = null;

function finish(code) { if (timer) clearInterval(timer); process.stdout.write('', () => process.exit(code)); }

try {
    // fd 3 is a pipe from the service: read it as a socket (an fs stream would block a worker thread on it)
    const ctl = new net.Socket({ fd: 3, readable: true, writable: false });
    ctl.setEncoding('utf8');
    let buf = '';
    ctl.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (cmd === 'quit') finish(EXIT.ok);
            else if (cmd === 'pause') state = 'paused';
            else if (cmd === 'resume') state = 'playing';
        }
    });
    ctl.on('error', () => {});
} catch (e) { /* no fd 3: no commands */ }
process.on('SIGTERM', () => finish(EXIT.ok));

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, input);
    if (!input.length) { emit({ ev: 'error', code: 'input', message: 'empty input' }); return finish(EXIT.input); }
    const flac = input.slice(0, 4).toString('latin1') === 'fLaC';
    emit({ ev: 'open', codec: flac ? 'flac' : 'aac', rate: 44100, channels: 2, duration: SECONDS });
    emit({ ev: 'audio', state: 'open', device: process.env.MGU_AUDIO || 'null' });
    timer = setInterval(() => {
        if (state === 'playing') pos = Math.min(SECONDS, pos + 0.5);
        emit({ ev: 'tick', pos: pos, state: state, buffered: 0, dropped: 0 });
        if (pos >= SECONDS) { emit({ ev: 'end' }); finish(EXIT.ok); }
    }, TICK_MS);
});
