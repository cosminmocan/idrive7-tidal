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

## Third visit, 2026-11-28: service 0.1.3, app 0.1.2 (video)

The app's log with the service's lines (eight QR pages): `docs/car-logs/2026-11-28-video-first-run.log`.

| Check | Result |
|---|---|
| Video (V1e) | **passed.** Hardware decoded (`msdk`, /dev/dri/renderD128), 720p and 480p, 0 decode errors, 1 picture left out in 950; seek works; a start takes about 3 s; mgu-render offers video (`"video":true`) |
| Sound after a start (A1) | cause found: `car audio: 287 is in use (2): not connecting (waiting for it to let go)` at 06:57:07 and 08:24:11; it connects once the owner picks another source |
| First start after the update | failed once (16:25:37, "the SDK created no RHMI application"), the next start worked: as docs/first-start.md says |
| New | `openEntryState ... INVALID_UUID` at 16:36:23, opening the app right after a popup; the app showed anyway |

**A1, what the code and the log show (2026-11-28), and the change.** `car_audio.js` treats every connection on
source 287 that it did not make as another app's sound and waits for it to go. Twice the car had such a connection
that no app had made: id 2 at 06:57:07 (three seconds after the app's start: among the first connections the audio
manager made in that boot) and id 9 at 08:24:11 (no start of the app in between, and the ids go on from our 6: the
head unit was not restarted, so this is not only a matter of a boot). In both cases ours had been the last source
before (06:57: not in the log; 08:24: ours ended at 07:14:53 and the log's next line is an hour later). No other app had a newer claim
("waiting for it to let go"). So, most likely: the car brings its last connection back (who made it is not in the
log); with it there was no sound of ours.
The change: a 287 connection that is not ours **and that no other app claims** (no file of another app in
/tmp/aurelm-287) is disconnected, then ours is connected: the same two steps as the owner's "pick another source",
which the log shows working (07:01:01, 08:24:45). Using the car's connection as it is was not chosen: it is the one
that stayed silent. Rule R7 is narrower by this: the app still never ends a connection of an app that claims the
speakers, and never takes them back after the driver chose another source.

Not yet checked in the car (next visit):

| Check | Expected |
|---|---|
| Start the car with TIDAL as the last source, open the app, play | sound without choosing anything; the log has `287 is in use (N) and claimed by no app`, `disconnect N (not ours, unclaimed) {"amError":"E_OK"}`, `connect {... "E_OK"}` |
| The same log line | it prints the car's connection whole (`sinkID`, `connectionState`): write it down |
| Radio, then back to the app and play | sound; no radio connection is touched (only source 287 ever is) |
| With one of aurelmarius' apps playing (if installed), play in TIDAL | as before: that app lets go, then ours connects; no `unclaimed` line |

The owner asks for: the video's controls hidden until touched, scaling (best fit, fill, zoom), a search with a
QWERTY keyboard or the touchpad's handwriting. Planned as Phase 4 in WORKPLAN.md.
