# cmocan-tidal: work plan

A TIDAL music player for BMW iDrive 7 (MGU head unit). Version 1 plays music.
Video comes after version 1 works in the car.

This file is the single source for the plan. It is written so that someone who
has not seen the earlier discussion can pick up any task.

## Progress

| Task | State | Notes |
|---|---|---|
| S1 | done | `make test` runs on Node 8.9.4 (x86-64) and Node 22 in Docker; a test that never ends fails after 20 s |
| S2 | done | `docs/reference-notes.md` (bmw-test-apps `511c5e0`, bmw-apps, mgu-store) |
| S3 | done | `docs/PROTOCOL.md`; validator `tests/fakes/protocol.js`; fakes `tests/fakes/fake_service.js`, `fake_player.js` |
| S4 | waiting for the owner | commands in `docs/car-facts.md` |
| K0 | assumed passed, not tested | the owner chose to proceed as if the sound path works (2026-11-27); test it before K1 |
| A1–A6 | done, reviewed | branch `stream-a-tidal-client` (06c4b15), pushed; 119 tests green on both Node versions |
| A7 | done | run 2026-11-27 with the owner's account: `docs/live-check-results.md`. Session for further live runs: `reference/live-check/session.json` (local only, 0600, git-ignored) |
| B1–B5 | done, reviewed | branch `stream-b-player` (aee35ff), pushed; `make player` (check-target) and `make test-player` green; binary 1.6 MB, glibc ≤ 2.27, libasound by dlopen |
| C1–C8 | done, reviewed | branch `stream-c-service` (778a5f1), pushed; 89 tests green |
| D0–D8 | done, reviewed | branch `stream-d-app` (5e5484a), pushed; 37 screen pictures wait for the owner's approval (D8), QR scan with a phone (D3) |
| D9 | waiting for S4 | needs the car's `someip-interfaces.json` |

### Resume here (next session)

1. **All four streams are merged into `main`** (2026-11-27, A, C, D, B, `make test` green after each;
   `make player` and `make test-player` green after B). `component.json` ships A's real modules and B's real binary
   (`build/out/tidal-player`); the package test now allows only the player's build output to be missing.
2. **Still to do from the merge:**
   - **contract updates** (`docs/PROTOCOL.md` + `tests/fakes/protocol.js` + examples together):
     `status.login` details while pending (`url`, `userCode`, `expiresAt`) so the app can show the code again after a
     restart (D); `status.loginError`, `status.children`, `status.player.skipped` (C added them); `offset`/`limit` for
     `album`, `mix`, `mixes` (D); a separate field for the player's own error codes (D); `login-denied` or say that
     a refused login is `login-expired` (C); player (B): closing fd 3 makes the player quit (the service must keep
     it open for the player's life), exits 2 and 3 send `error` with code `internal`, the device is retried for
     30 s then `audio` error and exit 6, ticks say `buffering` before playing starts, sound the device does not take
     within 250 ms is dropped and counted;
   - **`docs/INTERNAL-API.md`:** the TIDAL module runs in the root service; `client.js` (uid 13150) only does the
     network calls, over IPC with the bytes on fd 4 (C's design, agreed); add `loginCancel()`; say that
     `openStream` resolves with any HTTP status and follows up to 3 redirects (A); add a way to look up one track by
     id, so "now playing" is known after a restart (C).
3. **Quality for version 1 is HIGH (AAC 320)** (below): the app's default quality setting and the service's
   default become `HIGH`; the screen shows the quality TIDAL granted.
4. Then phase I: I1 end to end, I2 packages, I3 long run.

### Decision 2026-11-27: AAC 320 for version 1, lossless later

The live check showed TIDAL's device (QR) login is capped at HIGH (AAC 320) even on a HI_RES subscription
(`docs/live-check-results.md`). Version 1 uses the QR login and HIGH. **Lossless is a later step:** try TIDAL's
PKCE (browser) login once on the Mac, see which stream format it gets (plain FLAC, or MPEG-DASH of FLAC segments),
and if it works copy that session to the car. The player keeps its FLAC decoder.

### What S2 changed

- **Model for the player and service: Emby and TVH Player, not Music Assistant.** Music Assistant receives Opus
  over a WebSocket and decodes with libopus only; Emby and TVH fetch an HTTP stream in `client.js` and pipe it to
  the player's stdin, which works in the car.
- **No reference player decodes FLAC** and their FFmpeg reads stdin with no seeking: B1 adds the `flac` decoder
  and the `flac` and `mov` demuxers; A7 decides whether TIDAL's AAC can be read from a pipe (risk 1).
- **Sound permissions:** the car's sound plugin refused root and the tools' internet uid (Emby in the car:
  `snd_pcm_open` "Operation not permitted" as 13101). The player starts as root and drops itself to nobody with
  the groups `mgu_alsa,audio` (Music Assistant's `player.js`). This is in `docs/PROTOCOL.md` section 2.
- **Internet uid:** there is no allocation rule. Taken: 13101 Emby, 13102 myAirPlay, 13103 TVH Player, 13106
  Music Assistant. We use **13150**, to be checked at the car (S4, line 9).
- **Seek and next track:** nobody seeks by byte Range. Emby starts a new player per item; so do we (version 1 is
  not gapless).
- **CA list:** the firmware has no public CA list and Node 8.9.4's own is too old; we ship `cacert.pem` (as they
  do). Part of A1.

---

## 1. Decisions already made

| Topic | Decision |
|---|---|
| Names | repository `idrive7-tidal` (private, github.com/cosminmocan/idrive7-tidal); the car app is `cmocan_tidal`; the background service (a "tool" in Store terms) is `cmocan-tidal` |
| TIDAL side | JavaScript on the car's own Node. A port of the parts of the Python library `tidalapi` that we need. No Python on the car |
| Player | C/C++ with FFmpeg, based on aurelmarius' `tvh-player` |
| Sound | written to ALSA device `plug:smartx:CarLifeMedia_CF_48_STEREO` (car audio source 287), routed to the speakers (sink 1024) by the app through the car's audio manager |
| Quality | version 1: HIGH (AAC 320), the most TIDAL's QR (device) login allows. LOSSLESS (FLAC 16-bit 44.1 kHz) later, through TIDAL's PKCE login. No hi-res: the car input is fixed at 48 kHz stereo |
| Login | TIDAL device login; the app shows the login link as a QR code; the phone approves it over its own internet |
| Login storage | kept by the service, root only, outside the app's data folder |
| Video | parked only, after version 1 |
| Licence | GPL-3.0-or-later (we build on GPL code: `tvh-player`, `car_audio.js`) |
| Distribution | none: the app is for the owner's own car and is not published. The TIDAL client id is the one `tidalapi` ships |
| Method | test first (section 3) |
| Where tests run | in Docker (OrbStack). Node is not installed on the Mac and does not need to be |

## 2. The three parts and how they talk

```
 car app  cmocan_tidal  (JS, runs as its own app user)
   | screens, QR code, lists, now playing
   | routes source 287 to the speakers, follows the car's volume
   |
   |  JSON, one object per line, on /run/cmocan-tidal.sock
   v
 service  cmocan-tidal  (JS, started by the app's first connection, never at boot)
   |- service.js   root: the control socket, state, starts the two children
   |- client.js    its own uid with internet: every TIDAL request, the track's bytes
   |- player       nobody (+ group mgu_alsa): bytes in on stdin, sound out to ALSA
   |
   |  HTTPS through mgu-uplink (the only internet the head unit has)
   v
 TIDAL
```

Three written contracts keep the parts independent. They are defined in task
S3 before any part is built, so the parts can be built in parallel against
fakes:

1. **Control socket**: the app's commands and the service's answers.
2. **Player protocol**: track bytes on stdin, commands on fd 3, events as
   `MGU {json}` lines on stdout.
3. **State files**: session, preferences, queue.

## 3. Test-first rules

These apply to every task below.

1. **Test first.** For each behaviour: write the test, run it, see it fail for
   the expected reason, then write the code that makes it pass. A task's
   commit history shows the failing test before the code.
2. **No real network and no real car in automated tests.** Three fakes stand in:
   - a fake TIDAL server (login, library, stream URLs, a file server that can
     stall, drop the connection, answer 401, 429 and 5xx);
   - a fake player (a script that speaks the player protocol);
   - a fake audio manager (as in aurelmarius' `tests/car_audio_claims.test.js`).
3. **Two Node versions.** Every JS test runs in Docker on **Node 8.9.4** (what
   the car runs: no `?.`, no `??`, no `catch {}` without a parameter, no
   `fetch`, no `for await`) and on a current Node. A test that passes only on
   the current one is a failure.
4. **No npm packages in anything that ships.** Tests use Node's built-in
   `assert`, one file per subject, run as `node tests/<name>.test.js`, as the
   reference repos do.
5. **One command.** `make test` runs everything automated and exits non-zero
   on any failure. `make e2e` runs the end-to-end test (task I1).
6. **Car checks are separate.** What only the car can prove is a written
   checklist with an expected result per line (section 8). A checklist line is
   "passed" only when done in the car and written down with the date.
7. **Done means:** the task's tests pass on both Node versions, `make test` is
   green, and the task's "success" line below is true.
8. **No secret ever reaches git.** Every commit and every push is scanned with
   kingfisher by the hooks in `tools/git-hooks/` (`make hooks` once after
   cloning; `make test-hooks` checks them). Every finding is assessed in
   `docs/SECRETS.md` before anything is committed or pushed. Never commit or
   push with `--no-verify`.

### Safety rules that must each have a test

The head unit punishes mistakes: a crashed app loses its data and is
uninstalled the second time, and a core dump from an unknown program restarts
the whole head unit.

| # | Rule | Where it is tested |
|---|---|---|
| R1 | The app survives any answer from the service: garbage, half a line, a huge line, no answer, a closed socket | D1 |
| R2 | The service survives any input from the app and any answer from TIDAL | C1, A1 |
| R3 | The service's systemd unit has `LimitCORE=1`, memory, CPU and task limits, a start limit, and is enabled only as a socket (never at boot) | C8 |
| R4 | The player never crashes on bad input: it reports `error` and exits cleanly | B2 |
| R5 | The player refuses to run as root | B5 |
| R6 | Nothing is written outside `/var/opt/cmocan-tidal/`, `/run/cmocan-tidal.sock` and the app's own data folder | C7, C8 |
| R7 | The app disconnects only its own audio connection, and never takes the speakers back after the driver chose another source | D6 |
| R8 | Playback stops when the app has been silent for 90 s (the app closed or crashed) | C6 |
| R9 | Typing a search is blocked while the car moves (above 3 km/h); with no speed signal the car counts as parked | D7 |
| R10 | No BMW SDK file is in any package or in the repository | I2 |
| R11 | Removing the tool leaves nothing behind | C8, car check K4 |

## 4. Task overview

| Phase | Tasks | Can run in parallel with |
|---|---|---|
| S: setup | S1, S2, S3, S4 | S1, S2 and S4 are independent of each other; S3 follows S2 |
| A: TIDAL client | A1 to A7 | B, C, D |
| B: player | B1 to B5 | A, C, D |
| C: service | C1 to C8 | A, B, D |
| D: car app | D0 to D9 | A, B, C |
| I: integration | I1, I2, I3 | needs A, B, C, D |
| K: car | K0 to K4 | K0 can be done today; the rest are gates |
| L: later | seek, video | after version 1 |

After S3, the four streams A, B, C and D share no code until phase I, so four
people (or four agents in separate worktrees) can work at once.

```
S1 ─┬──────────────► A1 ► A2 ► A3 ► A4 ┐
S2 ► S3 ─┬─────────► B1 ► B2 ► B3 ► B4 ► B5 ──► K1
         ├─────────► C1 ► C2..C7 ► C8  ┤
         └─────────► D0 ► D1..D9       ┤
S4 (car facts) ─────────────────► D9   ├─► I1 ► I2 ► I3 ► K2 ► K3 ► K4
K0 (prove the car's sound path, today) ┘
```

---

## 5. Phase S: setup

### S1. Repository skeleton and test runner
- **Depends on:** nothing. **Parallel with:** S2, S4, K0.
- **Do:** `git init`. Folders: `apps/cmocan_tidal/`, `native/cmocan-tidal/`
  (service), `native/tidal-player/` (player), `tests/`, `tests/fixtures/`,
  `tests/fakes/`, `tools/`, `docs/`. A `Makefile` with `test`, `test-node8`,
  `test-node-current`, `e2e`. A `tools/run-tests.sh` that runs every
  `tests/*.test.js` in Docker images `node:8.9.4` and a current Node LTS and
  prints one line per file. `.gitignore` with `oap-sdk/`, `dist/`, `build/`,
  `reference/`. `LICENSE` (GPL-3.0-or-later).
- **Test first:** `tests/runner.test.js`, a test that asserts
  `process.version` is one of the two expected versions and that a syntax
  Node 8 lacks (`?.`) is rejected by a small syntax-check helper
  (`tools/check-node8-syntax.js`, run over every shipped `.js` file).
- **Success:** `make test` prints both Node versions green; adding a file
  with `a?.b` to `native/` makes `make test` fail.

### S2. Read the closest existing app and write reuse notes
- **Depends on:** nothing. **Parallel with:** S1, S4, K0.
- **Do:** read **Music Assistant** and **Emby** in
  https://github.com/aurelmarius/bmw-test-apps (a music player that already
  uses source 287), and `native/aurelm-tvhplayer`, `native/tvh-player`,
  `apps/aurelm_tvhplayer` in https://github.com/aurelmarius/bmw-apps. Write
  `docs/reference-notes.md`: which files we copy (with their licence and
  origin commit), which we adapt, and anything they learned in the car that
  changes this plan (for example how they seek, and how they pick a uid).
- **Success:** the notes answer: how Music Assistant feeds its player; how it
  seeks; how the tool's internet uid is chosen and declared (known so far:
  `"internet": true`, `"uids": [n]` in `component.json`; Emby 13101,
  myAirPlay 13102, TVH Player 13103; the rule is in mgu-store
  `deploy/README.md`, "Internet for selected components").

### S3. Write the three contracts
- **Depends on:** S2. **Everything in A, B, C, D depends on this.**
- **Do:** `docs/PROTOCOL.md` with:
  - **Control socket.** Requests `{"id":n,"cmd":...}`, answers
    `{"id":n,"ok":true,...}` or `{"id":n,"ok":false,"error":"<code>"}`.
    Commands: `status`, `login-start`, `login-cancel`, `logout`,
    `favorites`, `playlists`, `playlist`, `album`, `mixes`, `mix`, `search`,
    `cover`, `play`, `pause`, `resume`, `next`, `prev`, `stop`, `prefs`,
    `exit`. Fixed error codes: `offline`, `not-logged-in`, `login-expired`,
    `not-found`, `not-available`, `rate-limited`, `tidal-error`,
    `bad-request`, `busy`. The `status` answer: login state, online state,
    player state (`idle`, `loading`, `playing`, `paused`, `buffering`,
    `error`), track, position, duration, queue position.
  - **Player protocol.** stdin: the track's bytes. fd 3, one command a line:
    `pause`, `resume`, `volume <0..1>`, `quit`. stdout: `MGU {json}` with
    `open` (codec, sample rate, duration if known), `audio` (device state),
    `tick` (every 500 ms: position, state, buffered seconds, dropped), `end`,
    `error` (a code and a text). Environment: `MGU_AUDIO=alsa:<device>`,
    `null` or `wav:<path>`; `MGU_RUN_AS`, `MGU_GROUPS`. Exit codes.
  - **State files** under `/var/opt/cmocan-tidal/state/`: `session.json`
    (0600), `prefs.json`, `queue.json`, `covers/`. Each has a `version`
    field.
- **Test first:** `tests/protocol_examples.test.js` reads every JSON example
  in the document and checks it against a small validator in
  `tests/fakes/protocol.js`. The fakes used by A, B, C and D import the same
  validator, so a part that breaks the contract fails its own tests.
- **Success:** the document exists, every example in it validates, and the
  fake service and fake player (skeletons) answer `status` correctly.

### S4. Car facts (the owner does this at the car; read-only)
- **Depends on:** nothing. **Parallel with:** everything. Needed by D9, K1.
- **Do:** over SSH, run read-only commands and save the output in
  `docs/car-facts.md` (no VIN, no keys):
  - firmware version; `node --version`;
  - is the Store installed, and are `mgu-render` and `mgu-uplink` installed
    and online;
  - `getent group mgu_alsa video` (does the sound group exist, and who made
    it: this is not answered by any repository we read);
  - `aplay -L | grep -i carlife` (is the sound input there);
  - copy `/etc/oap/someip/someip-interfaces.json` to `reference/` (ignored by
    git) and confirm it has `org.genivi.am.commandinterface.CommandControl`
    and `org.genivi.am.routinginterface.RoutingControlObserver`.
- **Success:** every line of `docs/car-facts.md` is filled in. If
  `mgu_alsa` or the CarLife device is missing, stop and re-plan the sound
  path before K1.

---

## 6. The four parallel streams

### Stream A: TIDAL client (JS, pure logic, tested on the Mac in Docker)

All of A lives in `native/cmocan-tidal/` and has no dependency on the car.
Reference for every address and field: `tidalapi` 0.9.0,
https://github.com/EbbLabs/python-tidal (`session.py`, `request.py`,
`media.py`, `user.py`).

Known addresses: device login
`https://auth.tidal.com/v1/oauth2/device_authorization` (scope
`r_usr w_usr w_sub`); tokens `https://auth.tidal.com/v1/oauth2/token` (grant
types `urn:ietf:params:oauth:grant-type:device_code` and `refresh_token`);
API `https://api.tidal.com/v1/` with `countryCode` from `GET sessions`;
stream URL `GET tracks/<id>/urlpostpaywall` with `urlusagemode=STREAM`,
`audioquality=<LOSSLESS|HIGH>`, `assetpresentation=FULL`, answer
`urls[0]`; covers `https://resources.tidal.com/images/<id with / for ->/<w>x<h>.jpg`.

#### A1. HTTPS layer `netx.js`
- **Depends on:** S1, S3. **Parallel with:** B, C, D.
- **Do:** one function for requests over Node's `https`: names resolved
  through DNS servers given to it (on the car: the `dns` list in
  `/run/mgu-uplink/lease.json`; the head unit's own resolver does not reach
  the internet), certificates checked against a bundled CA file
  (`cacert.pem`), timeouts for connect, first byte and idle, a size cap on
  JSON answers, keep-alive.
- **Tests first** (`tests/netx.test.js`, with a local fake DNS server and a
  local TLS server with a test CA): the name is resolved by the given DNS
  server and not the system's; no lease file gives `offline`; a certificate
  not signed by the bundle is refused; each timeout fires; an answer over
  the size cap is cut off with an error; a connection the server closed is
  retried once on a fresh one.
- **Success:** all of the above green on Node 8.9.4.

#### A2. Device login
- **Depends on:** A1.
- **Do:** `login.start()` gives `{url, userCode, expiresIn, interval}` where
  `url` is TIDAL's `verificationUriComplete` with `https://` in front;
  `login.poll()` gives `pending`, `authorized` (with tokens), `expired` or
  `denied`, never polling faster than `interval`.
- **Tests first** (`tests/tidal_login.test.js`, fake TIDAL): each of the four
  outcomes; the interval is kept; a network error during a poll is `pending`,
  not a failure; the link starts with `https://`.
- **Success:** green; the fake server's log shows the exact form fields
  `tidalapi` sends.

#### A3. Session: save, load, refresh
- **Depends on:** A2.
- **Do:** `session.json` written whole (temp file, then rename), mode 0600;
  the access token refreshed shortly before it expires; a 401 answer causes
  one refresh and one retry; several requests that hit 401 together cause
  one refresh; a refresh the server rejects means logged out
  (`login-expired`).
- **Tests first** (`tests/tidal_session.test.js`): a half-written or empty
  file loads as "logged out", never throws; the file's mode is 0600; ten
  parallel requests with an expired token make exactly one refresh call; a
  rejected refresh deletes the session and reports `login-expired`.
- **Success:** green on both Node versions.

#### A4. Library
- **Depends on:** A3. **Parallel with:** A5, A6.
- **Do:** favourite tracks and albums, playlists and their tracks, album
  tracks, mixes and their tracks, search (tracks). Paging until the end or a
  cap. Each track mapped to a small object: id, title, artists, album, cover
  id, duration, `streamReady`, explicit.
- **Tests first** (`tests/tidal_library.test.js`, JSON fixtures recorded once
  from the real API and stripped of personal data): each call's address and
  parameters; paging across three pages; an item with missing fields does
  not break the list; a track that cannot be streamed is marked, not dropped.
- **Success:** green; fixtures contain no account name, email or token.

#### A5. Stream URL
- **Depends on:** A3. **Parallel with:** A4, A6.
- **Do:** ask for the preferred quality, fall back LOSSLESS to HIGH; report
  the codec that was actually granted.
- **Tests first** (`tests/tidal_stream.test.js`): LOSSLESS granted; LOSSLESS
  refused and HIGH granted; both refused gives `not-available`; 429 gives
  `rate-limited` with the wait TIDAL asks for.
- **Success:** green.

#### A6. Cover art
- **Depends on:** A1. **Parallel with:** A4, A5.
- **Do:** fetch a cover at one fixed size, cap its bytes, keep it in
  `state/covers/` with a total size limit, oldest removed first.
- **Tests first** (`tests/tidal_covers.test.js`): the address is built
  correctly; an oversized answer is refused; the cache never exceeds its
  limit; a cached cover is served with no request.
- **Success:** green.

#### A7. Live check against the real TIDAL (manual, on the Mac)
- **Depends on:** A2 to A5. **Not part of `make test`.**
- **Do:** `tools/live-check.js`, run in Docker by the owner with their own
  account: prints the login link as a QR code in the terminal, waits for the
  approval, lists ten favourites, asks for one stream URL in each quality and
  downloads the first 256 KiB of each.
- **Success, all of:** the login completes from the phone; favourites match
  the TIDAL app; the LOSSLESS file starts with `fLaC`; for the HIGH file the
  script reports the container and **whether its index (`moov`) comes before
  the audio (`mdat`)**. That last answer decides how B2 reads AAC (see risk
  1 in section 10). The script also records fresh fixtures for A4.

### Stream B: player (C/C++, built and tested in Docker)

Lives in `native/tidal-player/`. Start from
https://github.com/aurelmarius/bmw-apps `native/tvh-player` (GPL-3.0): keep
its sound path, its control and event format, its privilege drop and its
build; remove video, MPEG-TS and subtitles.

#### B1. Build
- **Depends on:** S1, S3. **Parallel with:** A, C, D.
- **Do:** `build.sh` builds in an Ubuntu 18.04 `linux/amd64` Docker image
  (glibc 2.27, as the head unit): FFmpeg at the commit `tvh-player` pins,
  configured with only `flac`, `aac` decoders, `flac`, `mov`, `aac` demuxers
  and parsers, and the resampler; then the player, FFmpeg linked in
  statically. A second, host build with the address sanitizer for tests.
- **Test first:** `make check-target` (as mgu-render's): the binary is
  x86-64, its loader is `/lib/ld-linux-x86-64.so.2`, it needs no glibc
  symbol newer than 2.27, and its only shared libraries are ones the head
  unit has.
- **Success:** `make -C native/tidal-player target check-target` passes on
  the Apple-silicon Mac through Docker; the binary prints its version.

#### B2. Decode to a WAV file
- **Depends on:** B1. A7's container answer is needed for the AAC path.
- **Do:** bytes on stdin, decoded, resampled to 48 kHz stereo 16-bit, written
  to `wav:<path>`.
- **Tests first** (`tests/player_decode.test.js`, fixtures made by a script
  from generated tones, no copyrighted audio): a 10 s 1 kHz FLAC (16-bit
  44.1 kHz) gives 10 s of 48 kHz output within 20 ms and its loudest
  frequency is 1 kHz; the same for AAC; a mono file plays on both channels;
  a file cut off in the middle ends with `end`, not a crash; random bytes
  give `error` and a clean exit; an empty input gives `error`; all of these
  also under the sanitizer build with no finding (rule R4).
- **Success:** green; no sanitizer report.

#### B3. Control and events
- **Depends on:** B2.
- **Do:** `pause`, `resume`, `volume`, `quit` on fd 3; `open`, `tick`, `end`,
  `error` on stdout as the contract says.
- **Tests first** (`tests/player_control.test.js`): `open` arrives before the
  first `tick`; ticks come every 500 ms and the position grows by 0.5 s;
  `pause` freezes the position and `resume` continues it; `volume 0.5`
  halves the output's peak; `quit` and SIGTERM both end the process within
  2.5 s; an unknown command is ignored.
- **Success:** green; every event validates against the S3 validator.

#### B4. Pacing and a stalling input
- **Depends on:** B3.
- **Do:** play in real time; start after a short prebuffer; when the input
  runs dry report `buffering`, and continue when bytes arrive again.
- **Tests first** (`tests/player_pacing.test.js`): a 10 s file fed at once
  still takes 10 s to play; an input paused for 3 s in the middle gives
  `buffering` then `playing`, and the output has no samples lost and none
  repeated around the gap; the input queue never grows past its limit when
  the sender is faster than playback.
- **Success:** green.

#### B5. ALSA output and privileges
- **Depends on:** B4.
- **Do:** `MGU_AUDIO=alsa:<device>`: libasound loaded at run time, opened
  non-blocking; a busy device is tried again every second and reported in
  `audio`; the device is closed first when ending. The player drops to the
  user and groups in `MGU_RUN_AS` and `MGU_GROUPS` before reading a byte and
  refuses to run as root (rule R5).
- **Tests first** (`tests/player_alsa.test.js`, in Docker with libasound and
  an ALSA `file` device that writes a WAV): the same tone test as B2 through
  ALSA; a device that does not exist gives `audio` with the error and keeps
  trying, no crash; started as root with no `MGU_RUN_AS`, it exits with the
  documented code and plays nothing; started as root with `MGU_RUN_AS=nobody`
  the process's uid is nobody's.
- **Success:** green. The binary is ready for car check K1.

### Stream C: service (JS, the root tool)

Lives in `native/cmocan-tidal/`. Model:
https://github.com/aurelmarius/bmw-apps `native/aurelm-tvhplayer`
(`service.js`, `client.js`, `player.js`, `sockgroup.js`, `cleanup.js`,
`check.js`, `component.json`, `systemd/`). C is built against the **fake
TIDAL** and the **fake player**, so it does not wait for A or B.

#### C1. Control socket
- **Depends on:** S3. **Parallel with:** A, B, D.
- **Tests first** (`tests/service_socket.test.js`): each command in the
  contract gets an answer with the same `id`; half a line, binary garbage,
  a 1 MiB line and an unknown command each get `bad-request` and the
  connection stays usable (rule R2); two clients at once each get their own
  answers; a client that disconnects mid-request causes no exception.
- **Success:** green.

#### C2. The children and their users
- **Depends on:** C1.
- **Do:** `service.js` (root) starts `client.js` as the tool's internet uid
  and the player as nobody. The spawn function is injected so tests run
  without root.
- **Tests first** (`tests/service_children.test.js`): the client is started
  with the configured uid and never as root; the player gets `MGU_RUN_AS`,
  `MGU_GROUPS` and `MGU_AUDIO`; a child that dies is reported in `status`
  and started again at most N times in M minutes; when the service ends,
  both children are ended first.
- **Success:** green.

#### C3. Login commands
- **Depends on:** C1; uses A2 and A3 (or their fakes until A is done).
- **Tests first** (`tests/service_login.test.js`): `login-start` answers with
  the link and code; `status` goes `logged-out`, `login-pending`,
  `logged-in`; an expired code returns to `logged-out` with `login-expired`;
  `login-cancel` stops the polling; `logout` deletes `session.json` and the
  cover cache; after a restart of the service a saved session is
  `logged-in` without a new login.
- **Success:** green.

#### C4. Library commands, caching, offline
- **Depends on:** C3; uses A4 and A6.
- **Tests first** (`tests/service_library.test.js`): each list command
  returns what the fake TIDAL holds; a second call inside the cache time
  makes no request; with no uplink lease the last cached list is returned
  marked `stale`, or `offline` when there is none; `status.online` follows
  the lease file appearing and disappearing.
- **Success:** green.

#### C5. Playback
- **Depends on:** C2, C3; uses A5.
- **Do:** a queue from a context (a list of track ids and a start index);
  `play`, `pause`, `resume`, `next`, `prev`, `stop`; the next track starts
  when the player reports `end`; the track's bytes go from TIDAL to the
  player's stdin with backpressure; a download that breaks is continued
  from the byte it stopped at (an HTTP `Range` request), for 2 minutes, with
  growing waits.
- **Tests first** (`tests/service_playback.test.js`, fake TIDAL file server
  and a fake player that records what it receives): the player receives the
  file byte for byte; with the connection cut three times mid-file, it
  still receives the file byte for byte, in order, nothing twice; a stream
  URL that has expired (403) is asked for again once; after the last track
  the state is `idle`; `next` at the end and `prev` at the start are
  harmless; a track that is `not-available` is skipped and the skip is
  reported; ten `next` commands in one second end with exactly one player
  running.
- **Success:** green; no player process is left over after any test.

#### C6. The app's watch and idle end
- **Depends on:** C5.
- **Tests first** (`tests/service_watch.test.js`, with an injected clock): no
  request for 90 s while playing stops playback (rule R8); a request at 89 s
  keeps it; 10 minutes with no request and nothing playing ends the service
  with exit code 0.
- **Success:** green.

#### C7. State on disk
- **Depends on:** C5.
- **Tests first** (`tests/service_state.test.js`): preferences and the queue
  survive a restart; every write is whole (kill the process during a write
  loop a hundred times: each file is either the old or the new version,
  never half); a file with an unknown `version` is ignored and replaced; all
  paths are under the state folder given at start (rule R6: the test runs
  the service in a temp folder and fails on any file created elsewhere).
- **Success:** green.

#### C8. The tool's package
- **Depends on:** C1 to C7.
- **Do:** `component.json` (`kind: tool`, `mguHmi: ["ID7"]`,
  `internet: true`, `uids`, `requires` for `mgu-deploy` and `mgu-uplink`,
  `files`, `units`, `check`, `deactivate`, `crashNames` with the player's
  name), `systemd/cmocan-tidal.socket` and `.service`, `cleanup.js`,
  `check.js`, `cacert.pem`.
- **Tests first** (`tests/tool_package.test.js`): every file `component.json`
  names exists; the service unit has `LimitCORE=1`, `MemoryLimit`,
  `CPUQuota`, `TasksMax`, `StartLimitBurst`, no `+` commands, and only the
  socket is enabled (rule R3); `cleanup.js` run twice leaves the same state
  and removes the socket and every file the service can create outside its
  folder (rule R11); no file in the package comes from `oap-sdk/`.
- **Success:** green; `deploy/hu artifact` from mgu-store packs the folder
  without an error.

### Stream D: car app (JS)

Lives in `apps/cmocan_tidal/`, built with the idrive7-apps kit
(https://github.com/cauliflowermossgrape/idrive7-apps, MIT). The kit's
`preview.js` and `emu.js` run a built app on the Mac with a stubbed head
unit, no BMW SDK and no car. D is built against the **fake service**.

#### D0. Kit bring-up
- **Depends on:** S1. **Parallel with:** A, B, C.
- **Do:** bring in the kit (`kit/runtime`, `kit/tools`, `kit/platform`), note
  its origin commit. A one-screen app that draws its name. Build and preview
  run in Docker (Python and Node).
- **Test first:** `tests/app_smoke.test.js` builds the app, runs it on
  `hu-stub.js` and asserts that one frame was drawn and no error was logged.
- **Success:** `make app-preview` writes a PNG of the screen; the emulator
  page opens at `http://localhost:8077`.

#### D1. Service client
- **Depends on:** D0, S3.
- **Tests first** (`tests/app_client.test.js`, fake service): requests and
  answers are matched by `id`; a request with no answer times out with an
  error and the next request still works; garbage, half lines, a huge line
  and a closed socket never throw (rule R1); the client reconnects with
  growing waits; a missing socket (the tool is not installed) gives one
  clear state, `no-service`.
- **Success:** green.

#### D2. The app's state machine
- **Depends on:** D1.
- **Do:** one pure function `(state, event) -> state` for the screens:
  `NO_SERVICE`, `OFFLINE`, `LOGIN`, `LIBRARY`, `LIST`, `NOW_PLAYING`,
  `ERROR`. No drawing in it.
- **Tests first** (`tests/app_model.test.js`): every transition; every error
  code from the contract leads to a named screen and message; an unknown
  event leaves the state unchanged.
- **Success:** green; the model has no `require` of the kit or the SDK.

#### D3. Login screen with the QR code
- **Depends on:** D2. **Parallel with:** D4, D5, D6, D7.
- **Do:** the login link as a QR code (a generator in plain JS, MIT: Kazuhiko
  Arase's, as TVH Player ships), with the code and the short address as text
  beside it for typing by hand.
- **Tests first** (`tests/app_qr.test.js`): the matrix for a known link
  equals a stored matrix that was checked once by scanning with a phone;
  the drawn code has a quiet border of four cells and each cell is at least
  6 px; when the code expires the screen offers a new one.
- **Success:** green; the preview PNG's code scans with a phone camera from
  the screen.

#### D4. Lists and moving through them
- **Depends on:** D2. **Parallel with:** D3, D5, D6, D7.
- **Do:** library home (favourites, playlists, albums, mixes), a track list,
  search results. Knob, press, tilt and touch. Only the visible rows are
  drawn. Text the fonts cannot draw (the kit's fonts are ASCII plus a few
  additions) is converted: `ă â î ș ț` and other accented letters to their
  plain letters; anything else to `?`.
- **Tests first** (`tests/app_lists.test.js`): a 500-row list draws at most
  the visible rows per frame; the knob moves one row per step and stops at
  both ends; a press plays from that row; a title of 200 characters is cut
  with `...` inside its column; the conversion table (`Știrile` gives
  `Stirile`); an empty list shows a message, not an empty screen.
- **Success:** green.

#### D5. Now playing
- **Depends on:** D2. **Parallel with:** D3, D4, D6, D7.
- **Do:** cover, title, artist, progress, play or pause, next, previous; the
  steering wheel's skip buttons (`SteeringWheelPushButton.statusSearchSwitch1`).
- **Tests first** (`tests/app_nowplaying.test.js`): each control sends the
  right command; the progress follows `status` and does not jump backwards
  on a late answer; `buffering` and `error` are shown; a missing cover shows
  a placeholder; the wheel's buttons skip only while a track is on.
- **Success:** green.

#### D6. Speakers and volume
- **Depends on:** D2. **Parallel with:** D3, D4, D5, D7.
- **Do:** reuse `car_audio.js` and `car_volume.js` from aurelmarius (GPL-3.0)
  unchanged, with the claims folder they share (`/tmp/aurelm-287/`), so our
  app and theirs hand the speakers to whichever started last. `app.json`
  declares `connect`, `disconnect`, `getListMainConnections`,
  `getListMainSinks`, the broadcasts `volumeChanged` and
  `sinkMuteStateChanged`, and `hookSourceAvailablityStatusChange`.
- **Tests first** (`tests/app_audio.test.js`, the fake audio manager; start
  from their `tests/car_audio_claims.test.js`): the route is asked for only
  while a track plays; pause or stop releases it; only our own connection
  id is ever disconnected; a connection left by a crash in this start of
  the head unit is cleared at start, one from an earlier start is forgotten
  and not disconnected; when our connection disappears (the driver chose
  the radio) playback pauses and the route is not taken back until the
  driver presses play in our app (rule R7); when another app claims the
  speakers later, ours lets go and pauses.
- **Success:** green.

#### D7. Rules while driving
- **Depends on:** D2. **Parallel with:** D3, D4, D5, D6.
- **Do:** `kit/parked` (`Vehicle2.statusCarSpeed2`, moving above 3 km/h).
  While moving: typing a search is closed and blocked; lists, play, pause
  and skip stay available.
- **Tests first** (`tests/app_driving.test.js`): at 0 km/h search opens; at
  10 km/h it does not, and an open keyboard closes; the speed signal going
  quiet after driving still counts as moving; no speed signal at all counts
  as parked (rule R9).
- **Success:** green.

#### D8. Picture tests of every screen
- **Depends on:** D3 to D7.
- **Do:** `tools/screens.js` draws every screen in every state from fixed
  data into PNGs.
- **Test first:** `tests/app_screens.test.js` compares each PNG with an
  approved one in `tests/golden/`; a difference fails and writes the new
  picture beside it for review.
- **Success:** green; the owner has looked at and approved every picture.

#### D9. Signals against the car's catalog
- **Depends on:** D6, **S4** (the car's `someip-interfaces.json`).
- **Do:** `python3 kit/tools/check_signals.py` over `app.json`.
- **Success:** no error; every interface, method and broadcast the app asks
  for exists in this car's catalog. If one is missing, stop: the sound route
  needs re-planning.

---

## 7. Phase I: integration (after A, B, C and D)

### I1. End to end on the Mac
- **Depends on:** A1 to A6, B1 to B5, C1 to C8, D1 to D7.
- **Do:** `make e2e`: in Docker, the fake TIDAL, the **real** service, the
  **real** player writing a WAV, and the app's client and model driven by a
  script.
- **Test first** (`tests/e2e.test.js`), one scenario per line, each must
  pass: log in; play a favourite and get the right tone in the WAV; next
  and previous; pause and resume with no lost audio; the network cut for
  20 s mid-track and playback continues with no lost audio; the uplink gone
  for 3 minutes gives `error` with `offline`, and playing again works when
  it is back; the token expires mid-session and playback continues; the app
  disappears and playback stops after 90 s; log out removes the session.
- **Success:** `make e2e` green three times in a row.

### I2. Packages
- **Depends on:** C8, D0 to D9.
- **Do:** `make dist`: the tool kit `cmocan-tidal@<v>.tgz` and the app
  package `cmocan_tidal@<v>.tgz`; `mgu-repo.json` at the root so the Store
  can read the repository; the app `requires` the tool and a renderer.
- **Test first** (`tests/dist.test.js`): both archives unpack; ids and
  versions inside match the names; `mguHmi` is `["ID7"]`; the app declares
  internet where needed; no path contains `oap-sdk` and no file matches the
  SDK's known module names (rule R10); no file holds a token, an account
  name or an address of the owner's car.
- **Success:** green; `node mgu-install.js usb-repo <folder> <packages>`
  from mgu-store accepts both.

### I3. Long run
- **Depends on:** I1.
- **Do:** 2 hours of playback in Docker with random faults (cuts, stalls,
  401, 429, a player killed).
- **Success:** no crash; the service's memory stays under 100 MiB and does
  not grow over the last hour; no leftover process or open file at the end;
  the WAV's length equals the played time within 1%.

---

## 8. Phase K: in the car

Every step: car parked, ignition on, on stable power. The owner is at the
car; results are written in `docs/car-log.md` with the date.

### K0. Prove this car's sound path with an existing app
- **Depends on:** nothing. **Can be done today.** It needs the Store and
  mgu-uplink on the car.
- **Do:** install **myAirPlay** from the Store source `aurelmarius/bmw-apps`
  (or Music Assistant from `aurelmarius/bmw-test-apps`) and play something.
- **Success:** its sound comes from the car's speakers; the volume knob
  changes it; choosing the radio takes the sound and the app does not take
  it back. **If there is no sound on this car, stop: stream B's sound output
  and D6 must be re-planned before more work is done on them.**

### K1. Our player alone
- **Depends on:** B5, S4, K0.
- **Do:** copy the player and a test tone to the head unit, run it as nobody
  with group `mgu_alsa` into the CarLife device, while myAirPlay's app (from
  K0) holds the route to the speakers.
- **Success:** the tone is heard clean for 60 s; `tick` reports no dropped
  audio; `pause`, `resume` and `quit` work; nothing is left running.

### K2. Internet from the tool
- **Depends on:** I2, K0.
- **Do:** install the tool and the app from a USB stick through the Store.
  Open the app.
- **Success:** the QR code shows; the phone logs in; favourites load; the
  service's status says `online`; with the uplink unplugged the app says
  offline within 10 s and recovers when it is back.

### K3. Version 1 in the car
- **Depends on:** K1, K2.
- **Parked, each must pass:** play a favourite in LOSSLESS; next, previous,
  pause; the wheel's skip buttons; the volume knob and mute, with our volume
  popup; switch to the radio and back (ours pauses, does not take the sound
  back, plays again on a press); a phone call pauses or mutes and returns;
  wireless CarPlay stays connected while ours plays; a navigation prompt is
  heard over the music; reverse gear's parking sounds are heard; ignition
  off and on: the app opens logged in; leave the app with HOME: the music
  plays on; close the app's tile: the music stops within 90 s.
- **Driving, a passenger operates, each must pass:** search cannot be typed;
  30 minutes of playback with no dropout on a normal route; a dead spot or
  a tunnel: the music stops and continues by itself; the head unit stays
  responsive (map, CarPlay) the whole time.
- **Success:** every line passed and logged. Any failed line becomes a test
  in `make test` or `make e2e` first, then a fix.

### K4. Removal
- **Depends on:** K3.
- **Do:** remove the app and the tool in the Store, restart the head unit.
- **Success:** no `cmocan` file, unit, socket, firewall rule or uid entry is
  left (the list in aurelm-tvhplayer's README, "Removal leaves nothing",
  applied to ours); the radio and CarPlay work as before.

---

## 9. Phase L: after version 1 (not planned in detail yet)

| Item | Note |
|---|---|
| Seek | start the download at a byte offset; FLAC needs its header first; see what Music Assistant does (S2) |
| Video | TIDAL videos are HLS: `videos/<id>/urlpostpaywall`. Hardware decoding and the frame file as in `tvh-player` and `uxplay-mgu/player/mgu_hls.cpp`; shown only while parked |
| Hi-res | not useful on a 48 kHz input |

## 10. Risks that can change the plan

1. **AAC over a pipe.** If TIDAL's HIGH files have their index at the end,
   the player cannot read them from stdin. A7 answers this. Fallbacks: the
   service downloads the whole track to a temp file first, or version 1
   plays LOSSLESS only.
2. **The sound group.** No repository we read creates the group `mgu_alsa`.
   S4 and K0 tell us whether this car has it.
3. **Uid for internet.** No rule exists (S2). We use 13150; 13101 to 13103
   and 13106 are taken by aurelmarius' tools. S4 line 9 checks the car.
4. **Node version.** The reference repos say the car runs Node 8.9.4 for
   services and 8.16.2 for builds. S4 confirms this car's version; the test
   image follows it.

## 11. What the owner needs to do

| When | What |
|---|---|
| now | K0: try myAirPlay or Music Assistant in the car, for the sound path |
| now | S4: the read-only commands at the car, into `docs/car-facts.md` |
| after A2 to A5 | A7: run the live check once with the TIDAL account |
| after D7 | D8: look at and approve the screen pictures |
| after I2 | K1 to K4 at the car |
