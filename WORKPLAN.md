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

**Phase 2 progress:** E0 done 2026-11-27 (all 276 author/committer entries are the no-reply address, content
identical, force-pushed; an old pushed commit is still fetchable by its exact id until GitHub's cleanup: ask GitHub
Support before the repository is ever public again). Q0 done (contract 3: `seek`, `log`, `MGU_START_MS`). The
commit ids written in this file before E0 are the old ones. Done and merged: W1 (docs/first-start.md), C1 (album art; `make test-render` against the real mgu-render), U1 step 1 (the owner chose **A**, docs/ui-redesign.md), S2 + D1's app part (seek in the app; the service's log in the QR log), K5 (the cluster card). Running: S1 + D1's service part. Next: U1 step 2 (the build), then a release after S1.

**Now: phase 2 (section 9).** Version 1 is installed and plays in the car (docs/car-log.md). Start with **E0**
(the commit email, needs the owner's go), then **Q0**, then the parallel tasks C1, S1, S2, D1, K5, W1; P1 and L1a
with the owner. What follows here is the history of version 1.

1. **All four streams are merged into `main`** (2026-11-27, A, C, D, B, `make test` green after each;
   `make player` and `make test-player` green after B). `component.json` ships A's real modules and B's real binary
   (`build/out/tidal-player`); the package test now allows only the player's build output to be missing.
2. **Contract 2 is done** (2026-11-27, branch `contract-2`, merged into `main`): `status` carries a pending
   login's link and code, `loginError` (expired or refused), `player.skipped`; album, mix and mixes are paged;
   the default quality is HIGH (AAC 320); the player's rules (fd 3 closing = quit, device retried 30 s, exits 2
   and 3) are written down and the service keeps fd 3 open; the TIDAL module has `loginCancel()`, `track(id)` and
   paged mixes; `docs/INTERNAL-API.md` describes the TIDAL module in the root service. `make test` green three times
   in a row on Node 8.9.4.
3. **Secrets:** every commit and push is scanned with kingfisher (rule 8, `docs/SECRETS.md`).
   **Open points** (small, none blocks phase I):
   - mix covers are always null: TIDAL's mix images are `images.tidal.com/...?token=` addresses, not the
     `resources.tidal.com/images/<id>` ones the cover code fetches;
   - `login-start` while already logged in starts a new login: the contract should say what it does;
   - a mixes `total` is what TIDAL's one page holds (TIDAL's `dataApiPath` follow-up is not used);
   - `service_playback` "a download broken for longer than the outage time ends in offline" timed out once under
     x86 emulation (passed alone 3 of 3, and in every full run since): watch it;
   - the 40 screen pictures wait for the owner's approval (D8), with 3 new and 8 changed in contract 2.
4. **Phase I:** I1 done (2026-11-27): `make e2e`, 9 scenarios with the real service, TIDAL client, player and the
   app's client and state machine against the fake TIDAL, WAVs equal to the reference sample for sample; 11/11
   three runs in a row (~160 s each). It found one bug: `netx.js` took Node 8's `aborted` after a whole answer as a
   break (fixed test-first). Scenarios 6 and 8 use the injected clock. I2 done: `make dist`, the catalog layout,
   **published** as release 0.1.0 (`make release`, automatic patch bump); the service is now 0.1.1 (the netx fix).
   I3 done (2026-11-27, `make soak`): 2 hours, 742 random faults (cuts, outages, expired tokens, 429, killed players,
   pause, next, prev), 636 players, every one's sound equal to the reference; no crash, client.js never restarted,
   one player at a time; service memory 52.7 -> 53.3 MiB (third to last quarter, median), open files steady.
   **Phase I is done. Next: the car (phase K)**: S4 facts, K0 sound path, then K1-K4.

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
| Install | the Store's **catalog** layout: a GitHub release `catalog` in the private repo (no binary in git), or a USB stick (`docs/INSTALL.md`). **`make release`** bumps the patch of every changed component automatically, then publishes; everything uploaded is scanned for secrets first (owner, 2026-11-27) |
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
| Phase 2 | album art, private install, seek, cluster card, lossless, video (section 9) | after the first car install |

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

## 9. Phase 2: after the first car install (planned 2026-11-27)

Version 1 plays music in the car (docs/car-log.md). This phase fixes what the first install showed and adds what
the owner asked for. The rules of section 3 apply to every task: test first, both Node versions, `make e2e` where the
service or player changes, kingfisher on every commit and push, a release with `make release`, and a car check
written into docs/car-log.md.

**The owner's priorities:** album art, installing from the private repository, seek, the track on the instrument
cluster, lossless, video. Only the commit email matters for privacy.

### Overview

| Task | What | Depends on | In parallel with | Needs the owner |
|---|---|---|---|---|
| **E0** | The commit email rewritten in all history | nothing. **First and alone**: it rewrites every commit, so no other branch may exist while it runs | none | a "go" (it force-pushes) |
| **Q0** | Contract 3: `seek`, `log`, what `status` needs for them | E0 | P1, L1a, W1, C1 | no |
| **C1** | Album art on mgu-render | E0 | Q0, S1, D1, K5, W1, P1, L1a | car check |
| **S1** | Seek: service and player | Q0 | C1, K5, W1, D1 (service part after S1: same files) | no |
| **S2** | Seek: the app (bar, knob, long press on the wheel) | Q0 (built against the fake service) | C1, S1, K5, W1 | car check |
| **D1** | The service's log readable in the car | Q0; service part after S1, app part after S2 (same files) | C1, K5, W1 | car check |
| **K5** | The track on the instrument cluster | E0 | C1, S1, S2, D1, W1 | cluster-render installed; car check |
| **W1** | Why the very first start failed | E0 | everything | maybe a log |
| **P1** | Installing from the private repository | E0 (the repository private) | everything | a read-only token; what the Store showed |
| **L1a** | Lossless, step 1: what TIDAL gives a PKCE login | nothing | everything | 5 minutes at the Mac (a browser login) |
| **U1** | The interface made to look and work like BMW's own iDrive 7 apps: **pictures first, for the owner's approval**, then the build | E0 for the design; the build after S2, C1 and K5 are merged (same files) | the design runs beside everything | says what feels wrong; approves the pictures; car check |
| **L1b** | Lossless, step 2: build it | L1a (its result decides the design), S1 merged | V1 | car check |
| **V1** | Video | S1, C1, L1a's facts; planned in detail when its turn comes | L1b | car check |

```
E0 ─┬─ Q0 ─┬─ S1 ──┬─ D1 (service) ─┐
    │      └─ S2 ──┴─ D1 (app) ─────┤
    ├─ C1 ──────────────────────────┤
    ├─ K5 ──────────────────────────┼─► merge ► make test, make e2e ► make release ► car check ► L1b, V1
    ├─ W1 ──────────────────────────┤
    └─ P1 (with the owner) ─────────┘
L1a (with the owner, any time)
```

Five agents can work at once after Q0: **C1**, **S1 then D1's service part**, **S2 then D1's app part**, **K5**,
**W1**. They touch different files: C1 `kit/runtime/renderd.js` and `apps/cmocan_tidal/covers.js`; S1
`native/**`; S2 `apps/cmocan_tidal/` (nowplaying, progress, wheel, nav, tidal.js); K5 a new
`apps/cmocan_tidal/cluster.js` and one hook in `tidal.js` (merged after S2); W1 reads, and changes at most
`tools/dist_app.py`.

### E0. The commit email

- **Do:** with the repository private: rewrite author and committer of every commit on every branch from
  `cosmin_mocan@hotmail.com` to `20535086+cosminmocan@users.noreply.github.com` (git filter-branch `--env-filter`
  or git-filter-repo in Docker; nothing else changes). Remove the agents' old worktrees and their local branches
  first. Force-push every remote branch (each through the pre-push scan), move the `catalog` release's tag to the
  rewritten commit, set `git config user.email` to the no-reply address in this repository.
- **Test first:** `tests/repo.test.sh` (on the Mac, part of `make test-hooks`): fails while
  `git log --all --format='%ae%n%ce'` holds any address other than the no-reply one.
- **Success:** that test passes; `git grep` of the old address over all history finds nothing; the trees of old and
  new `main` are identical (`git diff <old> <new>` is empty); `make test` is green; the release still downloads
  (`gh release download catalog`). Then the owner turns on GitHub's "Keep my email addresses private" and "Block
  command line pushes that expose my email".
- **Known limit:** the old commits stay fetchable by their exact id on GitHub until its cleanup; a request to
  GitHub Support removes them for certain.

### Q0. Contract 3 (the coordinator, before S1, S2 and D1)

- **Do:** in `docs/PROTOCOL.md`, `tests/fakes/protocol.js`, the fake service and the fake player together:
  - `seek {position}` (seconds, 0 to the track's duration): answers at once; `status.player.position` continues
    from there; while the player catches up the state is `loading`; a seek with nothing playing is `bad-request`;
  - the player: `MGU_START_MS` (start playing at this position: what comes before is decoded and thrown away,
    not played, as fast as the input arrives; `tick.pos` starts there);
  - `log {lines}` (at most 200): the service's newest log lines, for the app's QR log;
  - the fake service and fake player follow, so S2 and D1's app part can be built against them.
- **Test first:** the new commands and events in `tests/protocol_examples.test.js` and `tests/fakes.test.js`.
- **Success:** every example validates; the service's and app's suites still pass (the new commands are additions).

### C1. Album art

- **Cause** (docs/car-log.md): the app talks to mgu-render in its own dialect (`mgu-render/1`); the kit's client
  (`kit/runtime/renderd.js`, `_ensureImage`) uploads pixel images only in the other dialect and skips them here.
- **Do:** first look whether a newer idrive7-apps kit already does it (then take that). Else: in the mgu-render
  dialect, upload the picture with mgu-render's own picture message and draw it with its form of op 18
  (mgu-store `native/mgu-render/PROTOCOL.md`: IMAGE with premultiplied RGBA up to 1024 x 1024, op 18 as
  `x y w h r id`; or X_PIXMAP). This is our first change to the kit: keep it small and list it in `kit/ORIGIN.md`.
- **Test first:** (1) `tests/app_covers_gpu.test.js`: a stand-in renderer on a socket that answers as mgu-render/1;
  the app's cover must arrive as a picture upload and be drawn in the frame (fails today: nothing is uploaded).
  (2) **The real renderer**, the check that was missing: record what the app sends and replay it through
  mgu-render itself (`mgu-render --replay`, built in Docker with Mesa's software GL, as mgu-store's own tests do);
  the cover's pixels must be in the picture it draws. `make test-render`.
- **Success:** both green; in the car, covers show on now playing (car check); nothing else on the screens changes
  (the golden pictures stay the same).

### S1. Seek: service and player

- **Design (version 1 of seek):** the service starts a new player for the same track with `MGU_START_MS`; the
  download starts at the file's beginning and the player throws away the sound before the position. Simple and
  exact, no MP4 parsing; the cost is downloading the part that is skipped (3 minutes into an AAC 320 track is about
  7 MB: a few seconds on LTE). A faster seek (jumping in the file with its index) is a later improvement, measured
  first in the car.
- **Tests first:** player: `tests/player_seek.test.js` (a 24 s tone started at 10 s: the WAV equals the reference
  from 10 s on, sample for sample; the first tick says 10; a position past the end ends with `end`; the skipped
  part is not paced: it takes far less than 10 s). Service: `tests/service_playback.test.js` (seek forward and
  back, during pause, twice quickly: one player; position continues; bad positions refused). `make e2e` scenario
  10: seek forward, then back; both WAVs equal the reference from their position.
- **Success:** all green, `make e2e` three times; `make soak SOAK_SECONDS=1200` with `seek` among its faults passes.

### S2. Seek: the app

- **Do:** the progress bar takes a touch and a drag (the position shown follows the finger, one `seek` when it
  lifts); on now playing the knob moves the position in 10 s steps (sent 500 ms after the last step); the steering
  wheel: the signal says "held" while a skip button is down (apps/cmocan_tidal/wheel.js), so a press under 0.7 s
  is skip, as now, and a longer one seeks 10 s for every 0.5 s held. Seeking is allowed while driving (as skip).
- **Tests first:** `tests/app_seek.test.js` against the fake service: each input sends the right `seek`; a drag sends
  one; a short press still skips; a long press never also skips; a late status does not pull the bar back; R1
  holds for the new answers. New golden pictures for the bar while dragging.
- **Success:** green; in the car: finger, knob and long press all seek (car check).

### D1. The service's log in the car

- **Why:** the first car log held only the app's lines; why the video playlist skipped could not be seen.
- **Do:** the service keeps its newest 200 log lines (no token, no address with a token in it: a test checks);
  `log` returns them; the app writes them into its own log when its QR log page opens, marked `svc:`.
- **Tests first:** service: the lines kept, capped, scrubbed. App: the lines appear in the QR log's pages.
- **Success:** green; in the car, the QR log shows why a track was skipped (car check), which also settles the
  video-playlist question.

### K5. The track on the instrument cluster

- **Do:** as TVH Player's `cluster_card.js` (aurelmarius/bmw-apps, GPL-3.0): a card with cover, title and artist
  over the cluster's media widget, drawn through the Store's `cluster-render` tool; shown while a track plays,
  gone on pause, stop and when the app loses the speakers; an optional requirement (without cluster-render the
  app works as today); a setting to turn it off. The CarLife "C" in the car's own menu stays: it is the car's.
- **Tests first:** `tests/app_cluster.test.js` with a stand-in cluster-render socket: the card's layers for a track,
  its removal, no cluster-render installed, garbage from the socket (R1).
- **Success:** green; in the car, the card shows and goes as described and never covers a warning (car check).
- **Needs:** cluster-render installed from the Store (source `robertnisipeanu/idrive-apps`).

### W1. The first start that failed

- **Seen:** 17:01:55, "the SDK created no RHMI application ... rhmiLoadingEnabled off"; the second start worked.
  The kit's `build.py` writes `rhmiLoadingEnabled: true` into the app's config; our package is prepared again on
  the car by the Store.
- **Do:** find out whether the first start after an install always fails (the config the Store's install leaves,
  the kit's own notes on its issue 39), and whether it can be the first of the two exits after which MainApp
  uninstalls an app. Fix it if it is ours (`tools/dist_app.py`); else write down what to expect.
- **Success:** a written cause in docs/car-log.md; a test for any fix; a reinstall in the car starts at once.

### P1. Installing from the private repository

- **Seen:** the owner had to make the repository public to install.
- **Do:** (1) the owner says what the Store showed (`auth-needed`, an error, an empty list) and how the token was
  given. (2) On the Mac, with a fine-grained read-only token of the owner's: mgu-store's own reader against the
  private repository (`make usb STICK=<folder> FROM=github:cosminmocan/idrive7-tidal`; it reads the release and
  downloads each package as the car does). (3) Fix what fails (the catalog's addresses, the token's permissions
  in docs/INSTALL.md).
- **Test first:** for any fix in `tools/dist_catalog.js`, in `tests/dist.test.js`.
- **Success:** step 2 works with the repository private; in the car the source shows `ok` and an update installs
  with the repository private (car check).

### L1a. Lossless, step 1 (research, with the owner)

- **Do:** `tools/live-check.js --pkce`: prints TIDAL's browser login link; the owner logs in and pastes back the
  address the browser ends on; the tool exchanges it, then asks for a LOSSLESS stream and reports what TIDAL gives:
  a plain FLAC address or a DASH manifest, encrypted or not, and whether `Range` works. The session stays in
  `reference/` (never in git).
- **Success:** the facts in docs/live-check-results.md. They decide L1b: how the PKCE login reaches the car (a
  page on the phone, or the session copied once from the Mac) and whether the player must read DASH.

### U1. An interface like BMW's own apps (the owner, 2026-11-27: "feels very homebrew, a bit counter intuitive")

- **Step 1, design only (no app code changes):** `docs/ui-redesign.md` and pictures in `docs/ui-mock/` of every
  screen (login, library, lists, now playing, search, errors) redrawn in iDrive 7's own manner: its list menus with
  the highlight bar and the knob's focus, its type sizes and spacing, its left-hand option column, its now-playing
  layout of the media player; what each control does with knob, touch and the wheel; and the question of using the
  HMI's **own** list widgets for the library (the kit's `"kind": "menu"` screens: drawn by BMW's HMI itself, so
  they look and behave exactly like BMW's, but without pictures in the rows) with our drawn screen only for now
  playing. Sources: the kit's `docs/rhmi-widgets.md` and the README's screen layout (idrive7-apps), the owner's
  photos of the car's screen, BMW's own media player as the model. No BMW artwork is copied.
- **The owner approves the pictures (or changes them) before step 2.**
- **Step 2, the build:** test first (the state machine's navigation, the golden pictures replaced by the approved
  ones), after S2, C1 and K5 are merged.
- **Success:** the owner's approval of the pictures; then green tests and a car check of every screen with knob,
  touch and wheel.

### L1b and V1

Planned in detail after L1a, S1 and C1. V1 (video) needs: TIDAL's video stream (HLS, `videos/<id>/urlpostpaywall`),
hardware decoding into mgu-render's frame file (as `tvh-player` and `uxplay-mgu/player/mgu_hls.cpp`), the picture
only while parked, and sound and picture in step.

### Releases and car checks in this phase

After each merged group: `make test`, `make e2e`, `make release` (the patch versions go up by themselves), then the
owner updates in the Store and checks the lines above; the results go into docs/car-log.md. A failed line becomes
an automated test first, then a fix.

---

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
