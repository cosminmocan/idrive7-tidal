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
- **The children**: the client is started again when it dies, at most 5 times in 10 minutes (then
  `status.children.client.gaveUp`); a new player starts only once the one before has ended (it holds the sound
  device). When the service ends, the player and the client are ended first (quit, SIGTERM, SIGKILL).
- **Limits** (`systemd/cmocan-tidal.service`): `LimitCORE=1`, `MemoryLimit=160M`, `CPUQuota=100%`, `TasksMax=32`,
  `Nice=5`, idle I/O, `StartLimitBurst=10` in 600 s, `Restart=on-failure`, no `+` commands. Node with
  `--max-old-space-size=64`. The player is in `crashNames`.

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
`service_playback.test.js` (C5), `service_watch.test.js` (C6), `service_state.test.js` (C7),
`tool_package.test.js` (C8). They run the real service in a temp folder, unprivileged, with
`tests/fakes/fake_tidal_module.js` (TIDAL and a file server that cuts, refuses and serves Range),
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
| `cleanup.js`, `check.js` | `aurelm-tvhplayer/cleanup.js`, `check.js` (no firewall, no frame file in ours) |
| `systemd/*` | `aurelm-tvhplayer.socket`, `.service` and `aurelm-music.service` (limits) |
| `component.json` | `aurelm-tvhplayer/component.json`, in mgu-store's format (`deploy/README.md`, "Artifacts") |

`state.js` is new. `lib/`, `cacert.pem` are stream A's; `tidal-player` and `FFMPEG-LICENSE` are stream B's
(`native/tidal-player/build/`).
