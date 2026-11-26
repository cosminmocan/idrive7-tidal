# Internal module interfaces (stream A ↔ stream C)

The service (stream C) uses the TIDAL client (stream A) as JavaScript modules, inside `client.js`, which runs as
the tool's internet uid (13150). These interfaces let C build and test against fakes of A while A is being written,
and let A's modules drop in later with no change to C. Node 8.9.4 syntax; Promises; no npm packages.

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
                                  //    the caller sends "Range: bytes=<n>-" to continue after a break;
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
tidal.logout()                            // -> Promise: session file and cover cache deleted

// lists: items are the objects of docs/PROTOCOL.md ("Objects"); total when TIDAL says
tidal.favorites(kind, offset, limit)      // kind 'tracks' | 'albums' -> Promise<{ items, total }>
tidal.playlists(offset, limit)
tidal.playlist(uuid, offset, limit)
tidal.album(albumId, offset, limit)
tidal.mixes()
tidal.mix(mixId)
tidal.search(query, offset, limit)        // tracks only

tidal.streamUrl(trackId, quality)         // quality 'LOSSLESS' | 'HIGH' -> Promise<{ url, codec: 'flac' | 'aac', quality }>
                                          //    falls back LOSSLESS -> HIGH; 'quality' is what TIDAL granted
tidal.cover(coverId)                      // -> Promise<Buffer> JPEG 320x320, at most 128 KiB, cached in coverDir
```

A 401 from TIDAL is handled inside `tidal.js` (one refresh, one retry, A3); C never sees it. A refresh TIDAL
refuses rejects with `login-expired` after the session is deleted.

## Test fakes

- A provides `tests/fakes/fake_tidal.js`: a local HTTP(S) server playing TIDAL's auth, API, images and a file
  server (stall, cut, 401, 403, 429, 5xx on demand). Used by A's tests, and by I1.
- C writes its own in-process fakes of `netx` and `tidal` with exactly the shapes above (in its tests), so it
  does not wait for A.
