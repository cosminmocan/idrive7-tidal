# cmocan-tidal

The background service (a "tool" in mgu-store's terms) for the car app `cmocan_tidal`: TIDAL's music on a BMW
iDrive 7 head unit. The app talks to it on `/run/cmocan-tidal.sock`; the contracts are in `docs/PROTOCOL.md`
(control socket, player protocol, state files) and `docs/INTERNAL-API.md` (the `netx` and `tidal` modules).

## How it runs

| Process | User | Does |
|---|---|---|
| `service.js` | root | the control socket, the state (`/var/opt/cmocan-tidal/state`, 0700), the TIDAL module (`lib/tidal.js`), the queue (`playback.js`), starts the two children |
| `client.js` | 13150 (the tool's internet uid, `component.json` `uids`) | every HTTPS request, through `lib/netx.js`; keeps no file |
| `tidal-player` | started as root with `MGU_RUN_AS=nobody MGU_GROUPS=mgu_alsa,audio MGU_AUDIO=alsa:plug:smartx:CarLifeMedia_CF_48_STEREO`; drops to nobody itself | one process per track: bytes on stdin, commands on fd 3, `MGU {json}` events on stdout |
| `tidal-video` | the same, with `MGU_GROUPS=mgu_alsa,audio,video MGU_VIDEO=shm:cmocan-tidal MGU_VIDEO_DECODER=auto` (and `MGU_BASE_MS` after a seek) | one process per video instead of `tidal-player`: MPEG-TS on stdin, the pictures to `/dev/shm/mgu-video-cmocan-tidal` (built in `native/tidal-video`) |

- **The player's fd 3** stays open for the player's whole life: its closing means quit (`docs/PROTOCOL.md` section 2),
  so a player never outlives a service that died. `player.js` closes it with `destroy()`, never `end()` (on Node
  8.9.4 `end()` on a child's pipe can throw ENOTCONN as an unhandled `'error'`): when stopping a player (after the
  `quit` line), and once the player has ended. Every stdio stream of the child has an `'error'` handler.

- **Started** by the app's first connection to the socket (`cmocan-tidal.socket`, enabled in `sockets.target`);
  the service unit has no `[Install]` and is never started at boot. It ends with exit 0 after 10 minutes with no
  request while nothing plays; while a track plays (or is paused), 90 s without a request from the app stops it
  (rule R8).
- **The TIDAL module runs in the root service**, not in the client: `createTidal({ netx })` gets a netx whose
  requests and streams go through the client child (IPC for requests and answers, fd 4 frames for a stream's bytes).
  So `session.json` and `covers/` are root's, 0600, as `docs/PROTOCOL.md` section 3 says, and only the network runs
  as uid 13150 (mgu-uplink routes that uid and never root).
- **A track's bytes**: TIDAL -> `client.js` (netx stream) -> fd 4 frames -> `service.js` -> the player's stdin. Each
  pipe's backpressure holds the next: a player that does not read pauses the HTTP download.
- **A break** (the stream errors, 5xx, 429): the download continues from the byte it stopped at with
  `Range: bytes=<n>-`, after 1, 2, 4, 8, then every 10 s, for 2 minutes from the break; then the track ends in
  `error` / `offline`. A server that answers 200 to a Range is skipped forward. A 401/403/410 asks TIDAL for a new
  stream address once.
- **Seek** (`seek {position}`, contract 3): the track's player is ended and a new one started for the same track
  with `MGU_START_MS=<position in ms>`; the download starts again at the file's first byte (with the stream address
  the track already has; one that expired meanwhile is asked for again, and a break continues with Range as ever)
  and the player throws away the sound before the position. `status.player.position` is the position at once and
  the state is `loading` until the new player plays; a paused track stays `paused` at the new position. A position
  at the track's end or past it starts the next track (after the last one playback ends); when the service does not
  know the length yet, the player says `end` at once and the same happens. With nothing playing (idle, stopped,
  `error`) seek is `bad-request`. Several seeks in a row end with one player: each new one starts only once the one
  before has ended. The cost is the download of the part skipped (3 minutes of AAC 320 are 7 MB).
- **The children**: the client is started again when it dies, at most 5 times in 10 minutes (then
  `status.children.client.gaveUp`); a new player starts only once the one before has ended (it holds the sound
  device). When the service ends, the player and the client are ended first (quit, SIGTERM, SIGKILL).
- **Limits** (`systemd/cmocan-tidal.service`): `LimitCORE=1`, `MemoryLimit=160M`, `CPUQuota=100%`, `TasksMax=32`,
  `Nice=5`, idle I/O, `StartLimitBurst=10` in 600 s, `Restart=on-failure`, no `+` commands. Node with
  `--max-old-space-size=64`. The player is in `crashNames`.

## Videos (contract 4)

- **In the lists**: `favorites {kind: "videos"}` (TIDAL's `users/<id>/favorites/videos`), and the videos among a
  playlist's items (`playlists/<uuid>/items`, which holds tracks and videos; `/tracks` would leave the videos out)
  and a mix page's lists (`TRACK_LIST` by each item's type, `VIDEO_LIST`, `MIXED_TYPES_LIST`) are items with
  `kind: "video"`, `album` null and `coverId` the video's picture (`imageId`). Tracks are as before (no `kind`). An
  item of another type is dropped. Albums and search stay tracks only.
- **`play`** takes `kinds` (`track` or `video` for each id); without it every id is a track. The queue remembers each
  item's kind (`queue.json` gets `kinds` when a video is in it), so `next`, `prev`, `resume` after a restart and the
  lookup for `status.player.track` (`tidal.video(id)`) use the right one. Videos and tracks have separate id spaces.
- **The stream**: `tidal.videoUrl(id, height)` asks `videos/<id>/urlpostpaywall` (`videoquality=HIGH`) for the HLS
  master playlist; the service fetches it, chooses the variant closest to `prefs.videoHeight` (480, 720 by default,
  1080; never above it while a lower one exists, else the lowest; `lib/tidal/hls.js`), fetches that variant's
  playlist and then each MPEG-TS segment in order, through `client.js` like a track's bytes, into the one
  `tidal-video`'s stdin with the pipes' backpressure. `status.player.duration` is the variant's total.
- **Breaks**: inside a segment the download continues with `Range` as a track's does (growing waits, for 2 minutes,
  then `offline`); a segment the server refuses (an HTTP error) is tried once more and then **skipped**, with a log
  line (the player's demuxer finds its way past the gap); a 401/403/410 asks TIDAL for a new master once and goes on
  at the same segment with the same picture size.
- **Seek**: a new `tidal-video` starts at the segment holding the position (by the sum of the segments' durations),
  with `MGU_BASE_MS` that segment's start and `MGU_START_MS` the position; the playlists are not fetched again. At
  or past the end: the next item, as for a track.
- **`status.player.video`** is `{file, width, height}` once the player's `video` event says the picture is open,
  null otherwise (a track, no picture, the player gone). The 90 s watch, `pause`, `resume`, `next`, `prev`, `stop`
  are the same as for tracks.
- `cleanup.js` removes the frame file a video player left (`/dev/shm/mgu-video-cmocan-tidal`) when the service ends.

## Status and login (contract 2)

- `loginPending` is `{ url, userCode, expiresAt }` while `login-pending` (`expiresAt` in ms since 1970), else null.
  A `login-start` while one is pending, or being started, answers that one (the same link and code, the seconds
  left); `login-cancel`, and a code past its time, also call `tidal.loginCancel()`.
- `loginError`: `login-expired` (the code ran out) or `login-denied` (refused on the phone); null once a login starts
  or succeeds.
- `player.skipped`: the tracks of this queue passed over, `[{ id, error }]` (`not-available`), newest last, at most
  10; `[]` for a new queue.
- `player.track`: from the lists the service has answered; a track no list showed (the queue from before a restart,
  ids from elsewhere) is looked up with `tidal.track(id)` in the background, once (again after 60 s if TIDAL could
  not give it). `status` never waits for it: the track is null until TIDAL answers.
- `children` (optional in the contract, for the log and the Status page): `client` (running, restarts, lastExit,
  gaveUp, error), `player` (running, exits, lastExit).
- `prefs.quality` is `HIGH` when there is no `prefs.json` (TIDAL's QR login gets AAC 320 at most).
- `album`, `mixes` and `mix` are paged like the other lists (`offset`, `limit`, `total`). TIDAL sends the mixes and a
  mix's tracks whole in one page; `lib/tidal` pages them itself, and `total` is what it can give.

## The log (contract 3, `log`)

`log.js`: every line the service logs goes to the journal and into a ring of the newest 200, each with its time of
day (`hh:mm:ss`, the unit's local time), at most 300 characters. `log {lines}` returns the newest `lines` (all 200
without it), oldest first: the app shows them in its QR log, so a problem in the car can be read without a computer.

No line holds a token, in the ring or in the journal. Before a line is kept: the session's access and refresh token
are cut out wherever they stand (`session.json` is read again when it changes; lines kept before are cleaned again
when they are returned); of an address only the scheme, host and path stay (no user, no query, no fragment: TIDAL's
stream addresses carry a token in the query); the value after a name that holds a secret (`authorization`, `*token`,
`client_secret`, `password`, ...), a `Bearer` or `Basic` value and anything that looks like a JWT become `***`.

| Line | When |
|---|---|
| `cmocan-tidal <version>`, `login: logged in` or `logged out`, `internet: online` or `offline` | at the start; `internet:` again whenever the uplink's lease comes or goes |
| `login: started (...)`, `login: done`, `login: the code expired`, `login: refused`, `login: cancelled`, `logout` | the login's changes (the code itself is never logged) |
| `play: track 17927864 (2 of 14)`, also `next:`, `prev:`, `resume:`, `queue:` | a track is started, and why (`queue`: the one before ended or was skipped) |
| `seek: track 17927864 to 92.5 s` | a seek |
| `playing track 17927864 (HIGH, aac)`, with ` from 92.5 s` after a seek | the player's sound starts |
| `pause: track ...`, `resume: track ...`, `stop: track ...`, `queue: the last track is over` | |
| `track 17927870: not available, skipped` | a track passed over |
| `track 17927864: offline (the download broke 121 s ago: ...)` | a track ended with an error: its code (`docs/PROTOCOL.md`), and why |
| `play: video 143792065 (2 of 14)`, `video 143792065: 1280x720, 30 segments, 175 s (3.1 Mbit/s)`, `playing video 143792065 (720p, msdk)` | a video: started, the variant chosen, its sound and picture started (the decoder, or `no picture`) |
| `seek: video 143792065 to 92.5 s (segment 16 of 30, from 90 s)` | a seek in a video |
| `video ...: segment 4 of 30 failed (HTTP 500); again in 1000 ms`, `video ...: segment 4 of 30 skipped (HTTP 500)`, `video ...: segment 4 of 30 broke at byte ...`, `video ...: downloaded, 30 segments, ... bytes, 1 skipped` | a video's segments |
| `track ...: download broke at byte ... (...); again in ... ms`, `track ...: downloaded, ... bytes` | the download |
| `player 1234: {"ev":"open",...}`, `player: tidal-player: ...` | the player's events (not its ticks) and its own log |
| `player 1234: exited, code 0` | each player's end: its exit code (`docs/PROTOCOL.md` section 2) or the signal |
| `the app has not asked for 91 s: stopping playback`, `idle for 10 minutes: ending` | the watch |

## Removal leaves nothing

| What | Gone by |
|---|---|
| half-written state files (`*.tmp`) | `cleanup.js` (the service's `ExecStopPost`, also after a crash or a kill) |
| `/run/cmocan-tidal.sock` | the socket's stop (`RemoveOnStop=yes`); `cleanup.js --remove` (the tool's `deactivate`) |
| `/var/opt/cmocan-tidal/` (versions, `state/`: `session.json`, `prefs.json`, `queue.json`, `covers/`) | the deploy tool's uninstall (`session.json` and `covers/` also at logout) |
| `cmocan-tidal.socket`, `.service`, the `sockets.target` link, the recmgr name, the uplink's `uids.d/cmocan-tidal` | the deploy tool's uninstall |

No firewall rule and no sign-in page: the login is TIDAL's device login, approved on the phone over its own
internet.

## Tests

In Docker, `make test` (Node 8.9.4 x86-64 and Node 22): `tests/service_socket.test.js` (C1),
`service_children.test.js` (C2), `service_login.test.js` (C3), `service_library.test.js` (C4),
`service_playback.test.js` (C5, and seek), `service_watch.test.js` (C6), `service_state.test.js` (C7),
`tool_package.test.js` (C8), `service_log.test.js` (the log), `service_video.test.js` (videos), and
`tidal_video.test.js` (the TIDAL module's videos and `lib/tidal/hls.js`). They run the real service in a temp folder, unprivileged, with
`tests/fakes/fake_tidal_module.js` (TIDAL, a file server that cuts, refuses and serves Range, and an HLS server),
`tests/fakes/fake_netx.js` (plain HTTP, in the client child) and `tests/fakes/fake_player.js`;
`tests/fakes/service_harness.js` starts them and fails a test that leaves a child running.

## Origins

Adapted, with their licence (GPL-3.0-or-later), from aurelmarius' tools (read at bmw-apps `0976d16`,
bmw-test-apps `511c5e0`; see `docs/reference-notes.md`):

| File | From |
|---|---|
| `service.js` | `aurelm-tvhplayer/service.js` (socket activation, the app's 90 s watch, the 10 minute idle end, LISTEN_FDS) |
| `client.js` | `aurelm-tvhplayer/client.js`, `aurelm-emby/client.js` (the internet-uid child; the stream in fd 4 frames with the pipe's backpressure). Ours carries netx requests, not the whole client |
| `player.js` | `aurelm-tvhplayer/player.js`, `aurelm-emby/player.js` (one process per stream; quit, SIGTERM, SIGKILL; `MGU {json}` events) |
| `playback.js` | `aurelm-tvhplayer/playback.js`, `aurelm-emby/playback.js` (a broken stream tried again for 2 minutes, growing waits); ours continues with HTTP Range |
| `sockgroup.js` | `aurelm-tvhplayer/sockgroup.js` (the socket in the app's own group), app name and paths changed |
| `cleanup.js`, `check.js` | `aurelm-tvhplayer/cleanup.js`, `check.js` (no firewall in ours) |
| `systemd/*` | `aurelm-tvhplayer.socket`, `.service` and `aurelm-music.service` (limits) |
| `component.json` | `aurelm-tvhplayer/component.json`, in mgu-store's format (`deploy/README.md`, "Artifacts") |

`state.js` and `log.js` are new. `lib/`, `cacert.pem` are stream A's; `tidal-player` and `FFMPEG-LICENSE` are stream B's
(`native/tidal-player/build/`); `tidal-video` is built in `native/tidal-video/build/out/`.
