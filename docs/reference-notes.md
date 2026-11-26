# Reference notes (task S2)

What the closest existing apps do, and what that changes for cmocan-tidal. Facts only, each with its file. "Not
confirmed" means no source shows it.

## Sources read

| Short name | Repo | Commit (`git rev-parse HEAD`) |
|---|---|---|
| TEST | github.com/aurelmarius/bmw-test-apps (Music Assistant, Emby) | `511c5e070f014484a54941b560cef11fe304528a` |
| APPS | github.com/aurelmarius/bmw-apps (TVH Player) | `0976d16dda9be301d98b0253586d4c095160ac2b` |
| STORE | github.com/robertnisipeanu/mgu-store | `37702a880f1ed5fd346f4c944127fb276920be9c` |

Paths below start with the short name, e.g. `TEST:native/ma-player/README.md`.

## 1. How audio reaches their player

**Music Assistant (MA) does not use files or HTTP streams.** The server pushes Opus packets over Sendspin, a
WebSocket protocol:
- `TEST:native/aurelm-music/README.md`: "The sound: Sendspin, Music Assistant's own protocol, through its
  authenticated proxy `/sendspin` ... roles player (Opus 48 kHz first)". "The server sends 30 s of sound at once and
  then in real time".
- `client.js` (uid 13106) receives the packets (`ma.js`). The service sends them to `ma-player`'s stdin in its own
  frames (`TEST:native/ma-player/README.md`): "Frame (u8 type, u32 BE length, payload)": `F` format
  (`opus`|`pcm`), `A` a packet, `T` "u64 BE due time (CLOCK_MONOTONIC µs), then an Opus packet or PCM", `V` volume,
  `C` "drop what ALSA still holds (a seek, a new track, a pause)", `Q` quit.
- Pacing is done in JS. `ma.js`: `const LEAD_US = 1000000; // sound handed to the player this far before it is due`
  (the README still says 0.4 s; the code says 1 s). The player writes "no earlier than due minus what the device
  still holds (`snd_pcm_delay`)".
- **Codecs: Opus (libopus 1.5.2) or s16le PCM only. No FFmpeg in ma-player** (`TEST:native/ma-player/README.md`,
  "libopus 1.5.2 (Xiph, BSD-3-Clause ...) is compiled in").
- Why MA does not use BMW's own media player (source 1046): "it plays whole files only (a file that grows, a pipe, a
  URL, a file made at its size: all refused or stopped)" (`TEST:native/aurelm-music/README.md`).

**Emby (and TVH Player): an HTTP stream that the client fetches and pipes to the player.**
- `TEST:native/aurelm-emby/README.md`: the server transcodes to "H.264 ... with AAC or AC-3 ... always as MPEG-TS
  over HTTP(S), from `StartTimeTicks`". "fetched by the client through `netx.js` ... It goes to the service on the
  client's fd 4, in frames (stream id, length), and to `emby-player`'s stdin (`player.js`), with the pipes'
  backpressure: a paused film holds the server's socket."
- Frame format: `TEST:native/aurelm-emby/client.js`: `h.writeUInt32LE(id >>> 0, 0); h.writeUInt32LE(len >>> 0, 4)`;
  end of stream = length `0xffffffff`. `player.js` "drops a stream that was left".
- The player never fetches a URL itself. It runs as nobody, and uplink does not route nobody.
- `APPS:native/tvh-player/src/player.cpp`: stdin goes through
  `avio_alloc_context(..., read_stdin, nullptr, nullptr)`. **There is no seek callback, so the input cannot be
  seeked.**
- Pacing: the player keeps the audio "on the clock: late sound is dropped, early sound waits". Bounded queues of
  "6 s or 40 MiB at most: when the player is ahead, the stream waits in the pipe and so in the server's socket"
  (`TEST:native/emby-player/README.md`).

**For us:** the planned design (client.js fetches, the service pipes bytes to the player's stdin) is Emby's/TVH's
design and has worked in the car. MA's design (Opus packets with timestamps) does not apply to us. TIDAL sends
whole tracks (AAC or FLAC in an MP4/FLAC container, not MPEG-TS), so:
- the player needs demuxers for mov/mp4 and flac;
- reading from non-seekable stdin only works if the MP4 has its `moov` box before `mdat`. Not confirmed for TIDAL
  files: task A5/B2 must check this. If it fails, the player needs a seekable input (temp file or HTTP Range).

## 2. Seeking, the next track, gapless

- **Nobody uses byte Range.** `Range` appears only in `TEST:native/aurelm-emby/emby.js:68` (metadata), not in any
  request.
- **Emby seek = new transcode from the position + a new player.** `TEST:native/aurelm-emby/playback.js`:
  "A seek, another audio or subtitle ... `StartTimeTicks=' + Math.round(startSec * TICKS)`". README: "A seek ... or
  a lost connection (3 tries from the position) is a new stream and a new player." The app hides the gap behind
  "Loading..." (0.3.5, `TEST:README.md`).
- **MA seek happens on the server.** `ma.js`: `case 'seek': return api('player_queues/seek', ...)`. The server then
  sends `stream/clear` (with `from_timestamp`) and the player gets `C` to drop what ALSA holds.
- **Next track. Emby:** "The end of a film plays the next one in the queue" (a new stream and a new player, so not
  gapless). **MA:** the server sends one continuous stream: "Music Assistant mixes the end of a track into the
  next one in the stream it sends (Sendspin always plays in flow mode), so the car needs nothing for it" (`ma.js`,
  crossfade).
- **Gapless:** neither repo implements it on the car side. A player that restarts per track gives a gap of
  roughly the ALSA buffer plus the prebuffer (not measured). If we want gapless, it is our own work (e.g. a player
  that keeps ALSA open across tracks on stdin). Not confirmed by any reference.
- Start buffering in TVH (`APPS:native/tvh-player/src/player.cpp`): "the clock starts once MGU_PREBUFFER_MS of it is
  queued ... (a film's 1 s was too little on LTE)". The default is 1500 ms.

## 3. FLAC and the FFmpeg configuration

**No reference player decodes FLAC.** emby-player and tvh-player both use FFmpeg n6.1.2 (a "pinned commit"),
configured in `TEST:native/emby-player/build.sh` and `APPS:native/tvh-player/build.sh`:
```
--disable-everything --disable-programs --disable-doc --disable-avdevice --disable-avfilter --disable-swscale
--disable-swresample --disable-postproc --disable-network --disable-x86asm --disable-autodetect --disable-iconv
--enable-avformat --enable-demuxer=mpegts --enable-parser=h264 --enable-parser=aac --enable-parser=ac3
--enable-decoder=aac --enable-decoder=ac3 --enable-decoder=eac3 [tvh: --enable-decoder=dvbsub --enable-parser=dvbsub]
--enable-static --disable-shared --enable-pic
```
- The build runs in ubuntu:18.04 (glibc 2.27). build.sh refuses a binary that "needs glibc newer than 2.25". `powf`
  and `log2f` are bound to old versions (`src/glibc_compat.c`). libstdc++ and libgcc are static. libasound is
  loaded with `dlopen` at run time.
- **We must add** at least `--enable-demuxer=mov,flac --enable-decoder=flac --enable-parser=flac` (and keep aac).
  swresample is disabled in theirs: they mix down to stereo S16 by hand.
- Sample rate: the device is opened at the stream's own rate,
  `A.set_params(pcm, kS16LE, kRwInterleaved, 2, rate, 1, buffer_us())` (soft_resample = 1). So ALSA's `plug:` layer
  would resample 44.1 kHz to the 48 kHz smartx input. **Not confirmed in the car at 44.1 kHz.** Emby's and TVH's
  AAC is usually 48 kHz and MA's Opus is always 48 kHz. Option: enable swresample and always open the device at 48 kHz.
- FFmpeg is LGPL-2.1-or-later. The tools ship `FFMPEG-LICENSE`.

## 4. The tool's internet uid

**The rule** (`STORE:deploy/README.md`, "Internet for selected components", the whole section):
> A tool whose `component.json` says `"internet": true` lists its numeric `uids`, or names in `uids` a file under
> `/var/opt/<id>/` where it keeps them, one per line; an app's `package.json` says `"mguInternet": true`.
> While `mgu-uplink` is installed, those uids and apps get internet through it.

- **There is no allocation rule or registry.** The author picks a number. The deploy tool writes it to
  `/var/opt/mgu-uplink/uids.d/<id>` (`TEST:native/aurelm-emby/README.md`). Uplink refuses 0 and never routes root
  ("a local `uids` adds to the shipped one; 0 is refused", `STORE:native/mgu-uplink/README.md`).
- **Taken by aurelmarius' tools:** 13101 aurelm-emby, 13102 aurelm-myairplay, 13103 aurelm-tvhplayer,
  13106 aurelm-music (`component.json` of each; `TEST:native/aurelm-music/service.js`: `const NET_UID = 13106;`).
  No file mentions 13104 or 13105. Treat them as possibly reserved. Others: iteriodev-tailscale uses 3910
  (`iterio_car-apps/tools/iteriodev-tailscale/component.json`).
- **Ranges to avoid** (`STORE:native/mgu-updater/js/uids.js`): MainApp gives apps uids from `usableUidsAndGids`
  (tests: 12203..12450, rear-seat screens 12453..12700, MainApp 12201/12451). mgu-updater picks "the lowest free
  number above them" (tests: 12706, 12708), and the old fixed fetch uid is 12990. So 12201–~12999 is crowded.
- **Proposal: 13150** (a 131xx number used by nobody, away from aurelmarius' sequence). Declare it in component.json
  as `"internet": true, "uids": [13150]`. S4 at the car must check that 13150 is not in `/etc/passwd`,
  `/etc/group` or `/var/opt/mgu-uplink/uids.d/*`, and is not an app uid (`oap_12201/security/uids.txt`).
  Alternative: the file form (`uids` names a file under `/var/opt/cmocan-tidal/`) if we want to pick at install time.
- DNS: "names are resolved through the uplink's DNS servers (`/run/mgu-uplink/lease.json`): the unit's own resolver
  does not resolve internet names". TLS: "checked against `cacert.pem` ... the firmware has no public CA bundle, and
  Node 8.9.4's own list predates Let's Encrypt's ISRG roots" (`TEST:native/aurelm-emby/README.md`).

## 5. The `mgu_alsa` group

- **None of the repos creates it.** grep for `groupadd|addgroup|usermod|gpasswd|/etc/group` over all clones finds
  no creation of `mgu_alsa`, and no component.json, systemd unit or shell script creates it. The only `groupadd`
  calls are in robertnisipeanu's test harnesses, for `mgu_dlt`.
- Every player looks it up by name and drops root itself.
  `TEST:native/ma-player/src/ma-player.c`: `struct group *gr = getgrnam(g); if (gr) gl[n++] = gr->gr_gid;` then
  `setgroups ... setgid ... setuid`.
  A missing group is **skipped silently**, so the player would start but fail at `snd_pcm_open`.
- MA uses `MGU_GROUPS` = `mgu_alsa,audio` (`TEST:native/aurelm-music/player.js`: `const GROUPS = 'mgu_alsa,audio';`).
  Emby and TVH use `video,mgu_alsa`.
- myAirPlay plays "as Moonride does", "as nobody in the groups video and mgu_alsa"
  (`APPS:native/aurelm-myairplay/README.md`), and MA's and TVH's sound reached the speakers in the car this way.
- **Conclusion:** it is a stock group of the head unit's firmware (inferred from the above; no `/etc/group` dump in
  any repo, so **not confirmed directly**). S4: `grep mgu_alsa /etc/group` and `ls -l /dev/snd`.
- Why the player must be nobody: "the smartx sound plugin refuses root and the tools' uids"
  (`TEST:native/ma-player/README.md`). In the car, Emby 0.2.0 as uid 13101 got "`snd_pcm_open`: Operation not
  permitted" (`TEST:native/emby-player/README.md`).
- Why the player drops root itself: "Node cannot give a child supplementary groups"
  (`APPS:native/aurelm-myairplay/README.md`). **Plan impact: the service starts the player as root with
  `MGU_RUN_AS=nobody MGU_GROUPS=mgu_alsa,audio`, and the C player calls `setgroups` itself. The player must refuse
  to run as root.**

## 6. Node on the car

- "**Node 8.9.4** (the 2019 head units' `/usr/bin/node`): plain Node 8 JavaScript; the tests run on 8.9.4 too"
  (`APPS:native/aurelm-myairplay/README.md`). The units run `ExecStart=/usr/bin/node --max-old-space-size=96 ...`
  (`TEST:native/aurelm-music/systemd/aurelm-music.service`).
- Constraints they mention:
  - no built-in WebSocket and "the tool carries no npm modules" (their own `ws.js`);
  - no `Atomics` and no `module.builtinModules` (STORE `deploy/unit/mgu-deploy.js` notes);
  - no `fs.mkdirSync(..., {recursive})`: "node 8: no recursive";
  - no `process.ppid` on 8.9.4;
  - zlib `maxOutputLength` is ignored;
  - Node 8 frees Buffers lazily;
  - the CA list is too old (ship `cacert.pem`).
- Our Docker test image should pin Node 8.9.4. mgu-store's tests use 8.16.2 with `MGU_TEST_NODE_VERSION=8.9.4`.

## 7. How the app talks to the service

- The socket is `/run/aurelm-music.sock` (`/run/aurelm-emby.sock`). It is socket-activated, and nothing runs at boot
  (`systemd/aurelm-music.socket`: `ListenStream=`, `SocketMode=0600`, `RemoveOnStop=yes`,
  `ExecStartPost=-/bin/sh -c 'ulimit -c 1; exec /usr/bin/node .../sockgroup.js'`).
- **The group trick** (`TEST:native/aurelm-music/sockgroup.js`): "Every OAP app process is in the group
  tm_oap_app, so a socket in that group is open to every app ... Each app also runs as its own uid, whose primary
  group is that uid and owns its folder /var/opt/public/oap/oap_<uid>: the socket gets that group (0660), found by
  the app's package name."
  - It scans `/var/opt/public/oap/oap_*/source/package.json` for `name === 'aurelm_music'` and takes `statSync(dir).gid`.
  - While the app is not installed, the socket stays 0600 root.
  - It never fails (`process.exit(0)`), and service.js runs `apply()` again at each start.
- **The app does not look up its own gid.** The service finds it. The app only does `net.connect(SOCK)`, with one
  connection per request, one JSON line out and one line back (`TEST:apps/aurelm_music/main.js`, `ask()`).
  While music plays, the app polls the status every 2 s in the background.

## 8. Lessons from the car that matter for a music player

From `TEST:README.md` (MA status log), the players' READMEs and the systemd units:
- **Open ALSA non-blocking.** "0.1.0 opened it blocking and stayed in `snd_pcm_writei` for ever in the car". Sound
  that nobody reads (287 not connected yet) is dropped after 250 ms, and the device is re-armed every 2 s.
- **Pace by the clock, not by the device.** MA 0.1.1 gave "a garbled, metallic noise". 0.1.5: write a chunk "once it
  is due within 40 ms (0.1.2-0.1.4: 2 ms, while smartx reads whole periods of ~21 ms)"; "a chunk late by more than
  50 ms is dropped". For a file stream (Emby/TVH style) the decoder queue plus the clock does this.
- **ALSA buffer:** `MGU_ALSA_US` default 64000 µs, "smartx's 3 periods of 1024 frames".
- **Buffer ahead over LTE:** "the server's default, 1 s, too little over a mobile network". MA keeps 5 s queued and
  sends files 30 s ahead. TVH prebuffers 1.5 s. Emby lowers the bitrate after the stream runs dry "twice in a
  minute, or 8 s at once".
- **"Device or resource busy":** another app's player held smartx. "the player tries the device again each second
  while it is busy, and the app keeps asking for the speakers meanwhile". Before that fix, one refusal left the
  player silent.
- **Sharing source 287:** "the speakers go to the app started last".
  - Each app writes a claim to `/tmp/aurelm-287/<app>.json`. The holder that sees a newer claim disconnects and
    (MA) pauses, and lets the sound device go (`apps/*/car_audio.js`, tests `car_audio_claims.test.js`).
  - Only your own mainConnectionID is ever disconnected, kept with the boot_id.
  - **We should join this claim folder so we cooperate with MA, Emby, TVH and myAirPlay.**
- **Close the device when idle:** MA's player is "ended after 30 s without any" sound
  (`TEST:native/aurelm-music/player.js`, `IDLE_MS = 30000`). When a player ends, it closes the sound device first.
- **The app must be opened once per boot** for the route ("the sound's route and the picture are the app's"), and
  you must "Restart the head unit once after installing" (recmgr is read at boot).
- **CPU and memory:**
  - MA service: `Nice=5`, `CPUQuota=100%` ("the decoding is light (Opus ...); nice 5 keeps CarPlay and the HMI
    first"), `MemoryLimit=160M`, `TasksMax=32`.
  - Emby service: `Nice=10`, `IOSchedulingClass=idle`, `CPUQuota=200%` (with 50%, "AirPlay Test's receiver
    stuttered"), 256M.
  - FLAC decoding is light. 100% is a reasonable start, but not measured.
- **Crash safety:** `LimitCORE=1` everywhere: "No core dump goes to the crash handler (which restarts the head unit
  for a program it does not list)". Also no `+` ExecStart commands, `recmgr` lists the tool, the player is in
  `crashNames`, and `StartLimitBurst=10` in 600 s.
- **CarPlay:** the iPhone stays in wireless CarPlay. Sign-in goes through a page on the car Wi-Fi (QR code), with a
  temporary nft accept rule per port, removed by `cleanup.js` (`ExecStopPost`, `deactivate`). No reference covers
  CarPlay audio, navigation prompts or ducking on source 287: **not confirmed**.
- **Loudness:** "the CarLife input adds nothing". TVH added gain plus a limiter for quiet TV. Music is mastered
  loud, so this is probably not needed; not measured.
- **Text:** the kit's fonts are ASCII only ("accents are dropped, ș is s"). This matters for track titles.

## 9. Reuse table

None of the aurelmarius repos has a LICENSE file at its root. Each tool's `component.json` says
`"license": "GPL-3.0-or-later"`, and the C/C++ sources carry `SPDX-License-Identifier: GPL-3.0-or-later`. **The JS
files and the apps have no header and `app.json` has no licence field**, so their licence is inferred from
component.json and from car_audio.js's Moonride origin (GPL-3.0-or-later). Not confirmed: ask aurelmarius if it
matters.

| File | Origin @ commit | Licence | Use |
|---|---|---|---|
| `apps/aurelm_music/car_volume.js` | TEST @511c5e0 (same file in APPS tvhplayer) | GPL-3.0+ (inferred) | copy unchanged |
| `apps/aurelm_music/qrcode.js` | TEST @511c5e0 (Kazuhiko Arase) | MIT (header) | copy unchanged |
| `apps/aurelm_music/car_audio.js` | TEST @511c5e0 (Moonride → AirPlay Test → Emby) | GPL-3.0+ | copy, change only the app name and claim name; keep the `/tmp/aurelm-287` claims |
| `native/aurelm-music/netx.js` | TEST @511c5e0 | GPL-3.0+ (component.json) | copy; header comment only |
| `native/aurelm-music/ws.js` | TEST @511c5e0 | GPL-3.0+ | not needed (TIDAL is HTTPS only); skip |
| `native/aurelm-music/cacert.pem` | TEST @511c5e0 (Mozilla via certifi `b71b898`) | MPL-2.0 | copy unchanged; refresh later |
| `native/aurelm-music/sockgroup.js` | TEST @511c5e0 | GPL-3.0+ | adapt: `APP`, `SOCK`, env var |
| `native/aurelm-music/nft.js`, `page.js`, `cleanup.js`, `check.js` | TEST @511c5e0 | GPL-3.0+ | adapt: TIDAL login needs no LAN page, so `nft.js`/`page.js` are probably not needed; cleanup/check are a template |
| `native/aurelm-music/player.js` | TEST @511c5e0 | GPL-3.0+ | adapt: spawn as root with `MGU_RUN_AS`/`MGU_GROUPS`, 30 s idle close |
| `native/aurelm-emby/player.js`, `client.js` (fd 4 framing) | TEST @511c5e0 | GPL-3.0+ | adapt: our byte pipe client to service to player stdin |
| `native/aurelm-music/systemd/*.socket`, `*.service` | TEST @511c5e0 | GPL-3.0+ (SPDX) | adapt: names, paths, limits |
| `native/aurelm-music/component.json` | TEST @511c5e0 | GPL-3.0+ | adapt: id, uid 13150, files |
| `native/tvh-player/src/player.cpp`, `Makefile`, `build.sh` | APPS @0976d16 | GPL-3.0+ (SPDX) | adapt: strip video, subtitles, DSP; add mov/flac demux and flac decoder; keep non-blocking ALSA, retry on busy, root drop, `MGU {json}` events, fd 3 control |
| `native/tvh-player/src/glibc_compat.c` (Emby's is `TEST:native/emby-player/src/glibc_compat.c`) | APPS / TEST | GPL-3.0+ | copy unchanged if FFmpeg still needs `powf`/`log2f` |
| `native/tvh-player/src/decoder_msdk.*`, `nal_reader.*`, `mgvf.*`, `abi/` | APPS @0976d16 | GPL-3.0+ / MIT (mfx headers) | not for v1 (video) |
| `native/ma-player/build.sh` (zig, glibc 2.25 target, no Docker) | TEST @511c5e0 | GPL-3.0+ (inferred) | reference only, for a lighter build than Docker |
| `tests/car_audio_claims.test.js`, `tests/fixtures/fake_player.js` | TEST / APPS | GPL-3.0+ (inferred) | adapt as test templates |
| `kit/` | via TEST/APPS from cauliflowermossgrape/idrive7-apps | MIT | as task D0 decides |
| FFmpeg n6.1.2 | upstream | LGPL-2.1+ | ship `FFMPEG-LICENSE` |

## Open points for S4 (at the car)

- `grep mgu_alsa /etc/group`; `ls -l /dev/snd`; check that 13150 is free (passwd, group, `uids.d`, app `uids.txt`).
- Whether `plug:smartx:CarLifeMedia_CF_48_STEREO` accepts 44.1 kHz cleanly through `plug` resampling.
- Whether TIDAL's MP4/FLAC files have `moov` first (they must, to be readable from non-seekable stdin).
