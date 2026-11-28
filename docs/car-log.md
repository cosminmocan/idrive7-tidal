# Car log

Results of the checks done in the car (WORKPLAN.md, phase K). A line counts as passed only when it was done in the
car.

## 2026-11-27: first install (service 0.1.1, app 0.1.0), from the Store

Installed from the private GitHub source. The app's log (Settings > QR log, three photos, decoded with
`kit/tools/qrlog_decode.py`): `docs/car-logs/2026-11-27-app-first-install.log`. The service's log was not taken.

| # | Seen in the car | Verdict |
|---|---|---|
| 1 | Music plays, AAC 320 | **passed.** Proves K0 (the CarLife sound path on this car), the service's internet (uid 13150), the SDK generated from the car's donor, the QR login |
| 2 | A video playlist only skips | expected in version 1: videos are not tracks (video is phase L). Not confirmed in a log: the service's log is needed |
| 3 | No seek (finger, long press on the wheel) | not built (phase L) |
| 4 | Previous and next on the steering wheel | **passed** |
| 5 | No source in the instrument cluster; a blue "C" (Baidu CarLife's icon, confirmed by the owner) on the media button | a consequence of the sound path: the car believes CarLife plays. A cluster card of our own is possible (cluster-render, as TVH Player); the icon is the HMI's |
| 6 | The FLAC setting changes nothing | expected: the QR login gets AAC 320 at most (docs/live-check-results.md); lossless needs the PKCE login |
| 7 | **No album art** | **a bug.** Log: `WARN renderd: pixel images need the upstream dialect`. The app talks to mgu-render in its own dialect (`mgu-render/1`, needed for touch and the controller), and the kit's renderer client (kit/runtime/renderd.js `_ensureImage`) uploads pixel images only in the other ("upstream") dialect. mgu-render's own dialect has pictures too (X_PIXMAP, PROTOCOL.md), the kit just does not use them. The service's side is fine (a real cover fetched on the Mac: 23 KB JPEG) |

Also in the log:

- **The very first start failed**, 17:01:55: `the SDK created no RHMI application, so the app has no screens and does
  not start` (the kit's text names `rhmiLoadingEnabled` off in the SDK config). MainApp stopped the app (exit 0) and
  started it again at 17:02:21, and that start, and the one after the head-unit restart (17:04:07), worked. To
  watch: an app that exits unexpectedly twice is uninstalled by MainApp.
- `openEntryState ... INVALID_UUID` once (17:05:34), when the app was opened again from its tile after a popup; the
  screen came back.
- `SDK_ERROR ... USSO ... / AnalyticsServiceImpl`: BMW's own analytics and user service, not available to a custom
  app; noise.
- The renderer: `mgu-render/1 {"touch":true,"controller":true,"frontGate":true}`, 1920x720, full-screen layout.
- Speakers: `car audio: connect {"mainConnectionID":3,"amError":"E_OK"}`; released and taken again once (17:06:15).

## 2026-11-27/28: second install (service 0.1.2, app 0.1.1)

Reported by the owner; no QR log from this visit yet.

| # | Seen in the car | Verdict |
|---|---|---|
| 1 | The FLAC setting still changes nothing | expected: lossless needs the PKCE login (L1a, L1b), not built |
| 2 | The cluster shows the cover and the title (**K5 works**, cluster-render installed), but no progress bar as BMW's own media has | a request: K6 |
| 3 | **No sound until the car's own storage music was selected once; once per car start** | **a bug** (A1). Cause not known: the log taken while silent is needed. Guess: after a start the entertainment is off or muted (the last source was ours, which the car cannot restore), and our connect is accepted without sound |
| 4 | Video does not work | not built (V1) |
| 5 | Lists do not scroll by finger; the seek bar takes touch | not built (U2, low priority); **seek by touch works** |
| 6 | **The cluster's menu cannot be changed: it switches back to the song card** | **a bug** (K6). Our card is on cluster-render's `panel` target, and "while `panel` is shown the cluster takes the stock HMI's media widget (slot 0x200) off screen" (cluster-render README): the card wins over whatever the driver selects while a track plays |

Album art (C1) shows: confirmed by the owner's point 2 for the cluster; on the centre screen not said.
