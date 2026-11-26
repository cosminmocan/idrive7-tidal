# Live check results (task A7)

Run 2026-11-27 on the Mac in Docker (node:8.9.4-slim, x86-64) with stream A's code (`stream-a-tidal-client`
@ 06c4b15), against the real TIDAL, with the owner's account. The login came from tuidal's saved device-login
session (one refresh). Recorded answers, scrubbed: `reference/live-check/fixtures/` (git ignores `reference/`).

| Question | Answer |
|---|---|
| The bundled `cacert.pem` trusts TIDAL | yes: `auth.tidal.com`, `api.tidal.com` and the stream servers |
| Refresh with tidalapi's device client | works (HTTP 200); access token valid 14 400 s (4 h); **no new refresh token returned** (not rotated) |
| `GET sessions` | works with the access token alone; gives `userId` and `countryCode` (NG from this network: TIDAL takes it from the IP) |
| Favourites | 933 tracks, listed correctly |
| Account | `PREMIUM`, `ACTIVE`, `highestSoundQuality: HI_RES` |
| **LOSSLESS with the device login** | **granted HIGH (AAC) on both `urlpostpaywall` and `playbackinfopostpaywall`**, for a track tagged `LOSSLESS` and `HIRES_LOSSLESS` |
| HIGH | AAC-LC (`mp4a.40.2`) in MP4, not encrypted (`encryptionType: NONE`), ~9.7 MB for 4 min |
| AAC file layout | top-level boxes `ftyp moov free mdat`: **index before audio, not fragmented: readable from a pipe** (risk 1 closed) |
| `Range` on the stream servers | **yes**: HTTP 206 with `Content-Range` (a broken download can continue) |
| `playbackinfopostpaywall` | answers a BTS manifest (`application/vnd.tidal.bts`) with one plain URL, the same AAC file |

## What it means

- **The device login (the QR login) gets AAC 320 at most**, whatever the subscription. tidalapi's history:
  "Add PKCE login for HiRes"; its PKCE example is the one that lists FLAC. Lossless needs TIDAL's **PKCE** login
  (a browser login that ends on a `https://tidal.com/android/login/auth?code=...` address which must be handed
  back to the program). Not tried yet.
- tuidal had the same limit (its session is a device login, `is_pkce: false`); its fallback to HIGH is silent.
- **Version 1 can be AAC 320 with the QR login**, with nothing else changed: the player (stream B) decodes AAC,
  the file can be piped, and a break can be continued with `Range`.
- Lossless is a separate step: try a PKCE login once (on the Mac), and see which stream format TIDAL gives it
  (a plain FLAC, or an MPEG-DASH manifest of FLAC segments, which the player would also have to read).
