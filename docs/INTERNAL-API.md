# Internal module interfaces (stream A ↔ stream C)

The service (stream C) uses the TIDAL client (stream A) as JavaScript modules. These interfaces let C build and
test against fakes of A, and A's modules drop in with no change to C. Node 8.9.4 syntax; Promises; no npm packages.

## Where each part runs

| Process | Runs as | Holds |
|---|---|---|
| `service.js` | root | the control socket, the state folder (0700, root's), **the TIDAL module (`lib/tidal.js`)**: the session and the cover cache are written only by root |
| `client.js` | the internet uid 13150 | **only the network**: `lib/netx.js`. The service gives `createTidal` a `netx` with exactly the shape below, whose `request` goes to `client.js` over IPC (JSON lines on stdin/stdout) and whose `openStream` bytes come back in frames (stream id, length) on fd 4 |
| the player | root, then nobody (+ `mgu_alsa`, `audio`) | the sound (docs/PROTOCOL.md section 2) |

Why the TIDAL module is not in `client.js`: as uid 13150 it could not write `session.json` into the root-only state
folder, and the login must stay root's (WORKPLAN.md, decisions). The mgu-uplink lets only 13150 out, so every byte
from TIDAL still goes through `client.js`.

Ownership in `native/cmocan-tidal/`:

| Owner | Files |
|---|---|
| A | `lib/netx.js`, `lib/tidal/*.js`, `lib/tidal.js` (the entry), `cacert.pem` |
| C | `service.js`, `client.js`, `player.js`, `playback.js`, `state.js`, `sockgroup.js`, `cleanup.js`, `check.js`, `component.json`, `systemd/` |

## Errors

Every rejected Promise from A's modules is an `Error` with:

- `code`: one of the control-socket error codes in `docs/PROTOCOL.md` (`offline`, `not-logged-in`,
  `login-expired`, `not-found`, `not-available`, `rate-limited`, `tidal-error`, `bad-request`), so C passes it on
  unchanged;
- `retryAfter` (seconds, optional) with `rate-limited`;
- `status` (the HTTP status, optional), for the log.

## `lib/netx.js` (A1)

```js
const netx = createNetx({
    leasePath: '/run/mgu-uplink/lease.json',   // its "dns" list resolves names; no file = offline
    caFile: '/var/opt/cmocan-tidal/current/cacert.pem',
    // tests: resolver: (host) => Promise<ip>, ca: <PEM string>, now: () => ms
});

netx.online()                     // -> boolean: the lease file is there and lists a DNS server
netx.request({ method, url, headers, body, timeoutMs, maxBytes })
                                  // -> Promise<{ status, headers, body: Buffer }>; body capped at maxBytes
                                  //    (default 4 MiB); rejects with code 'offline' or 'tidal-error'
netx.openStream({ url, headers, timeoutMs })
                                  // -> Promise<{ status, headers, stream: Readable }> for the track's bytes;
                                  //    resolves with ANY HTTP status (the caller checks it: 200, 206, or not);
                                  //    follows up to 3 redirects; `request` never rejects because of a status;
                                  //    the caller sends "Range: bytes=<n>-" to continue after a break (TIDAL's
                                  //    stream servers answer 206, docs/live-check-results.md);
                                  //    the stream errors (never just ends) when the connection breaks or
                                  //    stays idle past timeoutMs
netx.close()                      // ends kept-alive connections
```

## `lib/tidal.js` (A2 to A6)

```js
const tidal = createTidal({
    netx,
    sessionFile: '/var/opt/cmocan-tidal/state/session.json',
    coverDir: '/var/opt/cmocan-tidal/state/covers',
    // tests: baseUrls: { auth, api, images }, now: () => ms
});

tidal.loggedIn()                          // -> boolean (a session is loaded)
tidal.loginStart()                        // -> Promise<{ url, userCode, expiresIn, interval }>; url starts with https://
tidal.loginPoll()                         // -> Promise<{ state: 'pending' | 'authorized' | 'expired' | 'denied' }>
                                          //    'authorized': the session is saved; never polls faster than interval
tidal.loginCancel()                       // stops a pending login: the next loginPoll() answers 'expired'
tidal.logout()                            // -> Promise: session file and cover cache deleted; stops a pending login

// lists: items are the objects of docs/PROTOCOL.md ("Objects"); total when TIDAL says
tidal.favorites(kind, offset, limit)      // kind 'tracks' | 'albums' | 'videos' -> Promise<{ items, total }>
                                          //    (users/<id>/favorites/<kind>, newest first); 'videos': video items
                                          //    (kind: 'video'); another kind rejects with bad-request
tidal.playlists(offset, limit)
tidal.playlist(uuid, offset, limit)       // read from playlists/<uuid>/items (not /tracks): its tracks and its
                                          //    videos (kind: 'video') in the playlist's order; an item of
                                          //    another type is left out
tidal.album(albumId, offset, limit)
tidal.mixes(offset, limit)                // paged as the others (the module pages TIDAL's answer itself if
tidal.mix(mixId, offset, limit)           //    TIDAL does not), total always given; a mix's items can be videos
                                          //    too (a video mix, or a mixed list)
tidal.track(trackId)                      // -> Promise<track>: one track by id (contract object), for "now playing"
                                          //    after a restart; rejects with not-found
tidal.video(videoId)                      // -> Promise<video>: one video by id (GET videos/<id>; kind: 'video',
                                          //    album null, coverId its picture), as track() for a video in the
                                          //    queue; rejects with not-found
tidal.search(query, offset, limit)        // tracks only

tidal.streamUrl(trackId, quality)         // quality 'LOSSLESS' | 'HIGH' -> Promise<{ url, codec: 'flac' | 'aac', quality }>
                                          //    falls back LOSSLESS -> HIGH; 'quality' is what TIDAL granted
tidal.videoUrl(videoId, height)           // height 480 | 720 | 1080 -> Promise<{ url, quality: 'HIGH' | null }>
                                          //    (videos/<id>/urlpostpaywall, videoquality HIGH); url is TIDAL's HLS
                                          //    master playlist with every picture size: the service picks the
                                          //    variant itself (playback.js with lib/tidal/hls.js chooseVariant:
                                          //    the highest not above `height`, else the lowest); the module only
                                          //    checks height (else bad-request). No address, an encrypted one,
                                          //    401, 403 or 404: rejects with not-available
tidal.cover(coverId)                      // -> Promise<Buffer> JPEG 320x320, at most 128 KiB, cached in coverDir
```

A 401 from TIDAL is handled inside `tidal.js` (one refresh, one retry, A3); C never sees it. A refresh TIDAL
refuses rejects with `login-expired` after the session is deleted.

## Test fakes

- A provides `tests/fakes/fake_tidal.js`: a local HTTP(S) server playing TIDAL's auth, API, images and a file
  server (stall, cut, 401, 403, 429, 5xx on demand). Used by A's tests, and by I1.
- C writes its own in-process fakes of `netx` and `tidal` with exactly the shapes above (in its tests), so it
  does not wait for A.
