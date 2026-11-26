# cmocan-tidal: the contracts between the parts

Three contracts keep the app, the service and the player independent (WORKPLAN.md, task S3):

1. the **control socket** between the app and the service;
2. the **player protocol** between the service and the player;
3. the **state files** the service keeps.

The validator `tests/fakes/protocol.js` is this document as code. Every example below is checked by
`tests/protocol_examples.test.js`, and every fake and every real part is tested with the same validator.
A change to the contract changes this document, the validator and the test together.

---

## 1. Control socket

| | |
|---|---|
| Path | `/run/cmocan-tidal.sock` (Unix stream socket, created by systemd socket activation) |
| Who connects | the app `cmocan_tidal`, as its own app user; the socket belongs to the app's group |
| Framing | one JSON object per line (`\n`), UTF-8 |
| Request size | at most 64 KiB a line; a longer line gets `bad-request` and is dropped |
| Answer size | at most 1 MiB a line; lists are paged so they stay well under it |
| Order | answers can come in any order; the `id` matches them to requests |
| Polling | there are no pushed events. The app asks for `status` every 1 to 2 s while it runs; that is also how the service knows the app is alive (90 s without a request while playing stops playback, rule R8) |

### Requests

`{"id": <integer ≥ 1>, "cmd": "<command>", ...parameters}`. Paged commands take `offset` (≥ 0, default 0) and
`limit` (1 to 100, default 50).

### Answers

Success: `{"id": n, "ok": true, ...fields}`. Failure: `{"id": n, "ok": false, "error": "<code>"}`, optionally
with `message` (text for the log, not for the screen) and `retryAfter` (seconds). A line that is not a request
at all gets `{"id": null, "ok": false, "error": "bad-request"}`.

| Error code | Means | The app shows |
|---|---|---|
| `offline` | no internet (no uplink lease, or TIDAL unreachable) | "No internet" |
| `not-logged-in` | no session | the login screen |
| `login-expired` | TIDAL refused the saved login; the session was removed | the login screen, "Please log in again" |
| `not-found` | the album, playlist, mix or track does not exist | "Not found" |
| `not-available` | the track cannot be streamed in any allowed quality | the track greyed out; skipped when playing |
| `rate-limited` | TIDAL asked us to wait; `retryAfter` says how long | "Busy, try again shortly" |
| `tidal-error` | any other TIDAL failure | "TIDAL error" |
| `bad-request` | the request does not follow this contract | nothing (a bug: logged) |
| `busy` | the service is starting or a login is already running | retry |

### Objects

| Object | Fields |
|---|---|
| track | `id` (integer), `title`, `artists` (list of names), `album` (`{id, title}` or null), `coverId` (string or null), `duration` (whole seconds), `streamReady` (false: cannot be played), `explicit` |
| album | `id`, `title`, `artists`, `coverId`, `numberOfTracks` |
| playlist | `uuid`, `title`, `numberOfTracks`, `coverId` |
| mix | `id` (string), `title`, `subTitle` (optional), `coverId` |

Text is as TIDAL sends it (UTF-8). Converting it for the car's fonts is the app's job (task D4).

### Commands

#### `status`

```json request
{"id": 1, "cmd": "status"}
```

```json answer status
{"id": 1, "ok": true, "state": {
  "login": "logged-in", "online": true, "version": "0.1.0",
  "prefs": {"quality": "LOSSLESS"},
  "player": {
    "state": "playing",
    "track": {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"],
              "album": {"id": 17927863, "title": "Discovery"}, "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57",
              "duration": 320, "streamReady": true, "explicit": false},
    "position": 42.5, "duration": 320, "queueIndex": 0, "queueLength": 14, "quality": "LOSSLESS", "error": null}}}
```

`login` is `logged-out`, `login-pending` or `logged-in`. `player.state` is `idle`, `loading`, `playing`, `paused`,
`buffering` or `error`; with `error`, `player.error` names it (a control-socket code, or a player code from
section 2). `queueIndex` is -1 with an empty queue. `position` and `duration` are seconds; `duration` is null while
not known.

```json answer status
{"id": 2, "ok": true, "state": {
  "login": "logged-out", "online": false, "version": "0.1.0", "prefs": {"quality": "LOSSLESS"},
  "player": {"state": "idle", "track": null, "position": 0, "duration": null, "queueIndex": -1, "queueLength": 0,
             "quality": null, "error": null}}}
```

#### `login-start`

Starts TIDAL's device login. The app shows `url` as a QR code, with `userCode` beside it. The service polls TIDAL;
`status.login` becomes `logged-in`, or goes back to `logged-out` when the code expires (`expiresIn` seconds).

```json request
{"id": 3, "cmd": "login-start"}
```

```json answer login-start
{"id": 3, "ok": true, "url": "https://link.tidal.com/ABCDE", "userCode": "ABCDE", "expiresIn": 300}
```

#### `login-cancel`, `logout`

`login-cancel` stops a pending login. `logout` deletes the session and the cover cache.

```json request
{"id": 4, "cmd": "login-cancel"}
```

```json answer login-cancel
{"id": 4, "ok": true}
```

```json request
{"id": 5, "cmd": "logout"}
```

```json answer logout
{"id": 5, "ok": true}
```

#### `favorites`

`kind` is `tracks` or `albums`. Newest first.

```json request
{"id": 6, "cmd": "favorites", "kind": "tracks", "offset": 0, "limit": 50}
```

```json answer favorites
{"id": 6, "ok": true, "total": 1, "items": [
  {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"], "album": {"id": 17927863, "title": "Discovery"},
   "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57", "duration": 320, "streamReady": true, "explicit": false}]}
```

With no internet, a list the service fetched before comes back with `"stale": true`; with none fetched before, the
answer is `offline`:

```json answer favorites
{"id": 7, "ok": true, "stale": true, "total": 1, "items": [
  {"id": 17927863, "title": "Discovery", "artists": ["Daft Punk"], "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57", "numberOfTracks": 14}]}
```

```json answer favorites
{"id": 8, "ok": false, "error": "offline"}
```

#### `playlists`, `playlist`

```json request
{"id": 9, "cmd": "playlists", "offset": 0, "limit": 50}
```

```json answer playlists
{"id": 9, "ok": true, "total": 1, "items": [
  {"uuid": "36ea71a8-445e-41a4-82ab-6628c581535d", "title": "Road trip", "numberOfTracks": 42, "coverId": null}]}
```

```json request
{"id": 10, "cmd": "playlist", "uuid": "36ea71a8-445e-41a4-82ab-6628c581535d", "offset": 0, "limit": 50}
```

```json answer playlist
{"id": 10, "ok": true, "total": 1, "items": [
  {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"], "album": {"id": 17927863, "title": "Discovery"},
   "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57", "duration": 320, "streamReady": true, "explicit": false}]}
```

#### `album`

```json request
{"id": 11, "cmd": "album", "albumId": 17927863}
```

```json answer album
{"id": 11, "ok": true, "total": 1, "items": [
  {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"], "album": {"id": 17927863, "title": "Discovery"},
   "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57", "duration": 320, "streamReady": true, "explicit": false}]}
```

#### `mixes`, `mix`

```json request
{"id": 12, "cmd": "mixes"}
```

```json answer mixes
{"id": 12, "ok": true, "items": [{"id": "0123456789abcdef0123456789abcd", "title": "My Mix 1", "subTitle": "Daft Punk, Justice", "coverId": null}]}
```

```json request
{"id": 13, "cmd": "mix", "mixId": "0123456789abcdef0123456789abcd"}
```

```json answer mix
{"id": 13, "ok": true, "items": [
  {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"], "album": null,
   "coverId": null, "duration": 320, "streamReady": true, "explicit": false}]}
```

#### `search`

Tracks only. `query` is 1 to 200 characters. The app blocks typing while the car moves (rule R9); the service
does not check speed.

```json request
{"id": 14, "cmd": "search", "query": "daft punk", "offset": 0, "limit": 50}
```

```json answer search
{"id": 14, "ok": true, "total": 1, "items": [
  {"id": 17927864, "title": "One More Time", "artists": ["Daft Punk"], "album": {"id": 17927863, "title": "Discovery"},
   "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57", "duration": 320, "streamReady": false, "explicit": false}]}
```

```json answer search
{"id": 15, "ok": false, "error": "rate-limited", "retryAfter": 30, "message": "429 from api.tidal.com"}
```

#### `cover`

A cover as a JPEG, 320 x 320, base64. At most 128 KiB before base64. From the service's cache when it has it.

```json request
{"id": 16, "cmd": "cover", "coverId": "24f52ab0-e7d6-414d-a650-20a4c686aa57"}
```

```json answer cover
{"id": 16, "ok": true, "mime": "image/jpeg", "data": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA=="}
```

#### `play`, `pause`, `resume`, `next`, `prev`, `stop`

`play` replaces the queue with `tracks` (1 to 1000 track ids, in order) and starts at `index`. The app sends the
ids of the list the user is in. `prev` restarts the track when more than 3 s have played, else goes to the
previous one. `next` on the last track and `prev` on the first are harmless. `stop` ends playback and keeps the
queue. All answer at once; the effect shows in `status`.

```json request
{"id": 17, "cmd": "play", "tracks": [17927864, 17927865, 17927866], "index": 1}
```

```json answer play
{"id": 17, "ok": true}
```

```json request
{"id": 18, "cmd": "pause"}
```

```json answer pause
{"id": 18, "ok": true}
```

```json request
{"id": 19, "cmd": "resume"}
```

```json answer resume
{"id": 19, "ok": true}
```

```json request
{"id": 20, "cmd": "next"}
```

```json answer next
{"id": 20, "ok": true}
```

```json request
{"id": 21, "cmd": "prev"}
```

```json answer prev
{"id": 21, "ok": true}
```

```json request
{"id": 22, "cmd": "stop"}
```

```json answer stop
{"id": 22, "ok": true}
```

#### `prefs`

Without `quality` it only reads. `quality` is `LOSSLESS` or `HIGH`; a new quality applies from the next track.

```json request
{"id": 23, "cmd": "prefs", "quality": "HIGH"}
```

```json answer prefs
{"id": 23, "ok": true, "prefs": {"quality": "HIGH"}}
```

#### `exit`

Ends the service (playback stops). It starts again with the app's next connection.

```json request
{"id": 24, "cmd": "exit"}
```

```json answer exit
{"id": 24, "ok": true}
```

---

## 2. Player protocol

The service starts one player process **per track**. Next track = a new player (as Emby's player in
bmw-test-apps; gapless playback is not a goal of version 1).

| | |
|---|---|
| Started by | `service.js` as **root**; the player drops to `MGU_RUN_AS` with the groups `MGU_GROUPS` itself, before it reads a byte (Node cannot give a child extra groups). The car's sound plugin refuses root and the tools' internet uids (Emby in the car: `snd_pcm_open` "Operation not permitted" as uid 13101) |
| stdin | the track's bytes as TIDAL serves them (FLAC, or AAC in MP4), from the first byte, read once, never seeked. End of input = the file is complete |
| fd 3 | commands, one a line: `pause`, `resume`, `volume <0..1>`, `quit`. Unknown lines are ignored |
| stdout | events, one a line: `MGU ` and a JSON object. Any other line is a log line |
| stderr | log lines |
| Output | always **48 000 Hz, stereo, 16-bit**: the player resamples itself, and does not rely on ALSA's `plug:` |

### Environment

| Variable | Default | |
|---|---|---|
| `MGU_AUDIO` | `alsa:plug:smartx:CarLifeMedia_CF_48_STEREO` | `alsa:<device>`, `null` (decode, discard), or `wav:<path>` (tests) |
| `MGU_RUN_AS` | none | user to become; started as root without it, the player refuses to run (exit 3) |
| `MGU_GROUPS` | `mgu_alsa,audio` | extra groups to take; a group the unit does not have is skipped and logged |
| `MGU_PREBUFFER_MS` | `1500` | sound queued before playing starts, and again after the input ran dry |
| `MGU_ALSA_US` | `64000` | ALSA buffer in µs |

### Events

`open` once, when the input's format is known, before the first `tick`. `duration` is null when the input does
not say.

```json player-event
{"ev": "open", "codec": "flac", "rate": 44100, "channels": 2, "duration": 320.0}
```

`audio` when the sound device's state changes. `busy`: another player holds it; the player tries again every
second and keeps decoding into its queue meanwhile.

```json player-event
{"ev": "audio", "state": "open", "device": "plug:smartx:CarLifeMedia_CF_48_STEREO"}
```

```json player-event
{"ev": "audio", "state": "busy", "device": "plug:smartx:CarLifeMedia_CF_48_STEREO", "message": "Device or resource busy"}
```

`tick` every 500 ms: `pos` (seconds played), `state` (`playing`, `paused`, `buffering`), `buffered` (seconds
queued), `dropped` (sound frames lost, total).

```json player-event
{"ev": "tick", "pos": 42.5, "state": "playing", "buffered": 3.2, "dropped": 0}
```

`end` once, when the whole input has been played. Then exit code 0.

```json player-event
{"ev": "end"}
```

`error` once, last: `code` is `input` (empty or cut-off input before anything played), `decode` (not FLAC or AAC,
or broken), `audio` (the device cannot be opened, after retrying), `internal`.

```json player-event
{"ev": "error", "code": "decode", "message": "no FLAC or AAC stream found"}
```

### Exit codes

| Code | |
|---|---|
| 0 | played to the end, or `quit` / SIGTERM (within 2.5 s, sound device closed first) |
| 2 | bad environment |
| 3 | refused: running as root |
| 4 | input error |
| 5 | decode error |
| 6 | audio error |

---

## 3. State files

In `/var/opt/cmocan-tidal/state/` (the folder 0700, root's). Each file is written whole (a temporary file, then a
rename) and has `"version": 1`; a file that does not parse or has another version is ignored and replaced.

### `session.json` (0600)

`expiresAt` is the access token's end in milliseconds since 1970.

```json state session
{"version": 1, "tokenType": "Bearer", "accessToken": "eyJ...", "refreshToken": "eyJ...",
 "expiresAt": 1795000000000, "userId": 123456789, "countryCode": "RO"}
```

### `prefs.json`

```json state prefs
{"version": 1, "quality": "LOSSLESS"}
```

### `queue.json`

The queue, so a restart of the service (or the head unit) can continue: `index` -1 with no queue, `position` in
seconds.

```json state queue
{"version": 1, "tracks": [17927864, 17927865, 17927866], "index": 1, "position": 42.5}
```

### `covers/`

`<coverId>.jpg`, 320 x 320, at most 128 KiB each and 20 MiB in all; the oldest removed first. Removed at `logout`.

---

## Not part of the contract

How `service.js` talks to `client.js` (the TIDAL client running as the internet uid) is internal to the service
(task C2). The model is aurelm-tvhplayer: JSON lines on stdin/stdout, and the track's bytes in frames (stream id,
length) on fd 4, passed on to the player's stdin with the pipes' backpressure.
