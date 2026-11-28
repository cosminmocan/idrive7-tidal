'use strict';
/**
 * fake_player.js - a stand-in for the real player (docs/PROTOCOL.md, section 2), for the service's tests
 * (stream C). It reads the whole input, then "plays" FAKE_SECONDS of it with a tick every FAKE_TICK_MS
 * (each tick advances the position by 0.5 s, as the real player's 500 ms tick does). No sound.
 *
 *   node fake_player.js       stdin: track bytes; fd 3: commands; stdout: MGU {json} events
 *   FAKE_SECONDS (default 2), FAKE_TICK_MS (default 500), FAKE_RECORD=<path>: write the bytes received there
 *   MGU_START_MS: the position playing starts at (the contract's seek); FAKE_ENV=<path>: write the environment there
 */
const fs = require('fs');
const net = require('net');

const SECONDS = Number(process.env.FAKE_SECONDS || 2);
const TICK_MS = Number(process.env.FAKE_TICK_MS || 500);
const EXIT = { ok: 0, input: 4, decode: 5, audio: 6 };

function emit(ev) { process.stdout.write('MGU ' + JSON.stringify(ev) + '\n'); }

let state = 'playing';
// MGU_BASE_MS: the position of the first byte it gets (a video started at a later segment); MGU_START_MS: where playing starts
const BASE = Math.max(0, Number(process.env.MGU_BASE_MS || 0) / 1000);
const END = BASE + SECONDS;
let pos = Math.max(BASE, Number(process.env.MGU_START_MS || 0) / 1000);
// MGU_VIDEO=shm:<name>: it also "shows" a picture (the video player's events; no frame file is written)
const VIDEO = /^shm:/.test(process.env.MGU_VIDEO || '') ? '/dev/shm/mgu-video-' + process.env.MGU_VIDEO.slice(4) : null;
let vframes = 0;
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
    // fd 3 closing means quit (docs/PROTOCOL.md section 2), as the real player
    ctl.on('end', () => finish(EXIT.ok));
} catch (e) { /* no fd 3: no commands */ }
process.on('SIGTERM', () => finish(EXIT.ok));

const chunks = [];
process.stdin.on('data', (d) => chunks.push(d));
process.stdin.on('end', () => {
    const input = Buffer.concat(chunks);
    if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, input);
    if (process.env.FAKE_ENV) fs.writeFileSync(process.env.FAKE_ENV, JSON.stringify(Object.assign({ MGU_START_MS: process.env.MGU_START_MS || null },
        process.env.MGU_BASE_MS ? { MGU_BASE_MS: process.env.MGU_BASE_MS } : {}, process.env.MGU_VIDEO ? { MGU_VIDEO: process.env.MGU_VIDEO } : {})));
    if (!input.length) { emit({ ev: 'error', code: 'input', message: 'empty input' }); return finish(EXIT.input); }
    const flac = input.slice(0, 4).toString('latin1') === 'fLaC';
    const open = { ev: 'open', codec: flac ? 'flac' : 'aac', rate: 44100, channels: 2, duration: SECONDS };
    if (VIDEO) open.video = { codec: 'h264', width: 1280, height: 720 };
    emit(open);
    emit({ ev: 'audio', state: 'open', device: process.env.MGU_AUDIO || 'null' });
    if (VIDEO) emit({ ev: 'video', state: 'open', decoder: 'sw', width: 1280, height: 720, file: VIDEO });
    timer = setInterval(() => {
        if (state === 'playing') { pos = Math.min(END, pos + 0.5); vframes += 12; }
        const tick = { ev: 'tick', pos: pos, state: state, buffered: 0, dropped: 0 };
        if (VIDEO) { tick.vframes = vframes; tick.vdropped = 0; }
        emit(tick);
        if (pos >= END) { emit({ ev: 'end' }); finish(EXIT.ok); }
    }, TICK_MS);
});
