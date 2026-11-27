# The failed first start after the install (task W1)

What was seen in the car on 2026-11-27 (`docs/car-log.md`, `docs/car-logs/2026-11-27-app-first-install.log`), what
it is and is not, and what to look for next time. Anything not proven is marked **not confirmed**.

## Summary

- **The cause is not in our package.** `config/base.json` with `rhmiLoadingEnabled` and `entryPointLoadingEnabled`
  on is in the package, the same as a build with the SDK would hold. A test now keeps it there.
- **It was a start without screens, not a crash.** The kit stayed idle, MainApp asked the app to stop after 18 s,
  the app exited with code 0. Nothing was wiped or uninstalled; the kit's own safe boot did not count it.
- **Why the SDK made no screens for that one start is not confirmed.** Two candidates are left (below). The line
  that decides between them is in the app's log file on the car, but the QR log leaves it out.
- **Whether it repeats at every install or update is not confirmed** (one install seen so far).
- **`INVALID_UUID`** is the HMI refusing one "open the app's screen" call while a popup was closing. The screen came
  back in the same second. It does not matter for the install.
- **For the owner:** after an install or an update, do not open TIDAL at once. Restart the head unit first
  (`docs/INSTALL.md`, section 4, step 4, which is needed anyway), or wait half a minute. If a tap shows "Loading
  app" and nothing opens, wait until it goes away and tap again. No reinstall is needed.

## 1. What the log shows

```
17:01:54 starting cmocan_tidal 0.1.0 (node up 1372 ms)
17:01:55 registered active (1872 ms)
17:01:55 ERROR the SDK created no RHMI application, so the app has no screens and does not start. Causes: ...
17:01:55 registered active (2221 ms)
17:02:13 shutdown requested by MainApp
17:02:13 exit code 0 rss=52MB
17:02:21 starting cmocan_tidal 0.1.0 (node up 1051 ms)
...
17:02:22 initialized (start reason ENTRY_POINT, 2091 ms)
```

The error comes from the kit, `kit/runtime/mgu.js` lines 745-752: when `app.rhmiApplication` is empty after
`app.start()`, it logs the error and returns, on purpose without throwing ("Stay up (idle) rather than throw: a
crash makes CorruptAppsHandler wipe the app's data, and a second one uninstalls it (issue #39)"). The text lists
three possible causes; it does not know which one applied. The stop is `mgu.js` line 701:
`app.on('shutdown', ...)` logs `shutdown requested by MainApp` and calls `process.exit(0)`.

Two things are missing from the failed start, and both matter:

- No `initialized (start reason ...)` line. The kit logs the start reason only after its screens are up
  (`mgu.js` line 1028), so **the start reason of the failed start is not in the log**. The kit also never calls
  `app.initialized()` on this path.
- No `SDK_` line. But the QR log drops them: `kit/runtime/qrlog.js` line 61,
  `if (/^SDK_/.test(m[3]) && m[3] !== 'SDK_ERROR') return;`. The kit writes the SDK's own reason to the log file as
  an `SDK_INFO` line (`mgu.js` lines 103-111: "the SDK's info lines that say why it did not create the app's
  screens (a CONFIG_STATE start, a resource error, or a newer SDK's 'conditionalLoading rhmiLoadingEnabled skipping
  loading': issue #39)"), and an `SDK_WARN` for a resource problem. So that line is very likely in
  `<the app's data folder>/cmocan_tidal.log` on the car and was not in the three QR photos. What the log does
  prove: there was no `SDK_ERROR` in the failed start.

### Reproduced off the car

The kit's real `run()` with a stand-in SDK whose `OnlineApp` has no RHMI application (`kit/tools/kit_harness.js`,
Node 8.9.4 in Docker), then a `shutdown` event:

```
run() returned undefined (no throw)
--- exit code 0, initialized() calls: 0
INFO starting cmocan_tidal 0.1.0 (node up 267 ms)
ERROR the SDK created no RHMI application, so the app has no screens and does not start. Causes: ...
INFO registered active (279 ms)
INFO shutdown requested by MainApp
safeboot.json {"fails":0,"last":null,"starting":null}
```

The same lines in the same order as in the car. This shows what the kit does when the SDK gives it no screens (stays
up, exits 0 when asked, safe boot counts no failure). It cannot show why BMW's SDK gave none: the SDK is not in this
repository (rule R10) and is never run here.

## 2. The cause

### Ruled out: `rhmiLoadingEnabled` off in our package

- `kit/tools/build.py` lines 636-640 write the config for every app, before and apart from the SDK copy (which is
  lines 743-744): `{'rhmiLoadingEnabled': True, 'entryPointLoadingEnabled': True, 'settings': {app_id: ...}}` into
  `config/base.json`. Its comment: "the SDK merges this over its own config. Newer SDKs (27.x, extracted from a
  newer donor app) build the app's screens and entry point only with these on, and some donors ship them off ...
  Older SDKs (24.x) ignore them."
- `tools/dist_app.py` runs that same `build.build()` with a placeholder for the SDK and then removes only
  `node_modules/`. The unpacked `dist/idrive7-tidal/cmocan_tidal@0.1.0.tgz` holds `package/config/base.json`:

  ```json
  { "rhmiLoadingEnabled": true, "entryPointLoadingEnabled": true, "settings": { "cmocan_tidal": {} } }
  ```

  A build with the SDK would differ from ours only by `node_modules/oap-sdk/{index.js,package.json}` and by
  `mguHmi` in `package.json`.
- On the car, mgu-store's `tools/oap_link.js` (`preparePackage`, line 903) generates
  `node_modules/oap-sdk/index.js` and `package.json` from the donor and does not touch `config/`. The generated
  module is the donor's own SDK code, its `config` module included (`SDK_API`, line 85:
  `config: 'src/config/config.js'`). Where exactly that code reads the app's `config/base.json` from at run time is
  **not confirmed** (the SDK is not readable here); `build.py`'s comment and the kit's README say it is merged over
  the SDK's own config.
- The decisive point: the start 27 s later, with the same package, the same generated SDK and the same config, made
  the screens, and so did every start after it. A config that is off would fail every start (the kit README's
  "Troubleshooting" entry describes exactly that: "The tiles are there but no app opens").

`tests/dist.test.js` now checks the package's `config/base.json` (it passed at once: a guard, not a fix).

### Left: two candidates, not told apart by this log

**A. MainApp started the app by itself, without screens, after installing it (a `CONFIG_STATE` start).**
Evidence, all indirect:

- The kit names it as a normal cause of this very error (`mgu.js` line 750) and of starts that end by MainApp's
  stop: `kit/runtime/safeboot.js` lines 47-49, "a start the car ended (switched off or asleep again within the
  30 s, killed at power-down, MainApp's CONFIG_STATE start): on a car that is every other start, not a failure
  (#262)", and `mgu.js` line 700, "a stop MainApp asked for is no failed start for safe boot: CONFIG_STATE starts
  and quick sleeps end this way".
- MainApp has such a start reason and a per-app queue for it: `oap-sdk/src/internal/StartReason` `CONFIG_STATE`
  (named in mgu-store's `native/app-privacy/test/test_patch_mainapp.js` line 1304), and `"configStateQueueIndex"`
  in every app's registry entry (`deploy/test/fake_manager.js` line 149; idrive7-apps
  `deploy/mgu-app-install.sh` line 437).
- The Store's own app expects starts without screens: `apps/robertn_store/src/store.js` lines 385-387, "no
  RhmiApplication for this start reason; initializing without a screen".
- On iDrive 7 the install is made by MainApp itself, and the app is stopped and started by it:
  `deploy/unit/mgu-deploy.js` lines 4355-4366, "The running manager runs either one on request through the
  fallback copy's in-place hook (installInPlace), so only that app stops and starts".
- It fits the log: a start nobody may have asked for, a stop by MainApp 18 s later, exit 0, and the next start has
  the reason `ENTRY_POINT` (a tap on the tile).

**B. The first tap on the tile came right after the install, before the HMI could load the app's screens.**
The kit's third cause ("the HMI could not load the app's resources"). MainApp would then have waited for the app's
`initialized()` (which the kit does not call without screens; "MainApp shows 'Loading app' until initialized()",
`mgu.js` line 1014) and stopped the app. That the 18 s is such a timeout is **not confirmed**.

Which one it was: **not confirmed.** A is the more likely one: the Store's app and the kit both treat a start
without screens as an ordinary event, and no reference describes B after an install. The log has no `SDK_ERROR`
in that start, which speaks against a hard resource error but does not rule B out (an `SDK_WARN` would not be in
the QR log). What decides it:

- whether TIDAL's tile was tapped before 17:01:54 (if not, it is A);
- the `SDK_INFO` / `SDK_WARN` line just before the error in the log file on the car.

## 3. Does it repeat, and does it endanger the install?

**Repeats at every install or update: not confirmed.** One install was seen. If it is A, expect it after every
fresh install, and possibly after every update (MainApp's update also stops and starts the app; whether it uses a
`CONFIG_STATE` start then is not confirmed). If it is B, only when the tile is tapped in the first seconds. The
later starts, also the one after the head-unit restart (17:04:07), were all normal.

**It is not one of MainApp's crashes**, as far as the files and the log can show:

- What MainApp's crash handling reacts to: "each crash of an app (it exits on its own, is killed for memory or CPU,
  or stops answering its heartbeat for a minute)" (mgu-store `native/app-privacy/README.md`, "Crash recovery").
  Here MainApp itself asked for the stop and the app exited 0 in the same second. The idrive7-apps README says the
  same from the other side: "If an app exits unexpectedly ..." and "restart the platform ... which stops them
  cleanly" (section 4.3). This is the path the kit was written for (`mgu.js` line 746). That MainApp's
  `CorruptAppsHandler` did not count this stop is **not confirmed** from MainApp's own log (it was not taken).
- Nothing was lost: the log file lives in the app's data folder and still held the 17:01:54 lines when the QR
  photos were taken, and the tile stayed.
- The kit's safe boot did not count it: no `safe mode:` line in any later start, `safe boot: start ok` at 17:02:52
  and 17:04:40.
- Even a real crash would not cost the install on a head unit set up by mgu-store, **if app-privacy is installed**
  (it is part of `first-install`: `deploy/README.md` line 99, "the deploy tool, app-privacy, the updater ..."; on
  this car **not confirmed**, the Store's status shows it). The installer marks our package `"mguLocalOnly": true`
  (`deploy/README.md`, "Packages built elsewhere"), and for such an app: "A local-only app is restarted on every
  crash instead. Its data stays, it stays installed and its tile stays enabled. When it has been restarted 5 times
  in the last 10 minutes, the next crash leaves it stopped" (`native/app-privacy/README.md`). The stock ladder,
  which applies without app-privacy, is: restart; delete the data and restart; uninstall, reinstall and restart;
  then block (same file), a step longer than the idrive7-apps README's short version.

So an update made with `make release` is not expected to cost a "crash". **Not confirmed** until one update has been
watched in the car (section 5).

## 4. `INVALID_UUID`

```
17:05:31 state MAIN covered by an HMI popup
17:05:34 entry point CMOCAN_TIDAL_ENTRY (UNSPECIFIED)
17:05:34 entry point CMOCAN_TIDAL_ENTRY (ENTRY_POINT)
17:05:34 SDK_ERROR Error: RhmiApplication[687e3e4e-...]::openEntryState(2661afa3-...) failed due to { RemoteError: 'INVALID_UUID' }
17:05:34 ERROR open entry state Error: ...
17:05:34 renderd: on screen
```

- `2661afa3-1d8c-5c9d-8ac2-6a96f37f7f99` is the right uuid: the app's only entry point in
  `rhmiData/application.json`, mapped at the start (`mapped entry 2661afa3-... -> MAIN`).
- The app was running and its screen was hidden by an HMI popup. A tap on the tile makes MainApp send
  `entryPointExecute` (twice, `UNSPECIFIED` then `ENTRY_POINT`: so at every tap in this log; the kit answers the
  two as one, `mgu.js` line 935), and the kit calls the HMI's `openEntryState(uuid)` (`mgu.js` lines 934-952).
  The HMI answered `INVALID_UUID` this once. The same tap at 17:02:35, 17:05:50 and 17:07:07 gave no error.
- The kit knows this answer: "right after a tap started the app the HMI can still refuse the state (INVALID_UUID /
  INVALID_COMPONENTID) - then it is asked again" (`mgu.js` lines 932-933). It asks again only for the tap that
  started the app (`openEntry(lastEntry, 6)`, line 1032); for a tap on a running app it only logs the error.
- The screen was back in the same second (`renderd: on screen`, then `click BTN_LIBRARY` at 17:05:39).
- What exactly the HMI means by it (most likely: the entry state was not ready to be opened while the popup was
  closing) is **not confirmed**. No note on it was found in mgu-store, bmw-apps or bmw-test-apps.

It is a refused call, not an exit: it has nothing to do with crash handling. Worth a second look only if a tap on
the tile ever leaves the screen hidden; a retry for taps on a running app would then belong in the kit, which is
copied unchanged (`kit/ORIGIN.md`).

## 5. What to check in the car next time

After the next install or update (the first `make release` update is the test), take the QR log before and after
opening the app, and note whether the tile was tapped and when.

Harmless, the same event again (then it belongs to installs, candidate A):

```
starting cmocan_tidal <version> (node up ... ms)
registered active (... ms)
ERROR the SDK created no RHMI application, so the app has no screens and does not start. ...
shutdown requested by MainApp
exit code 0 rss=...MB
```

followed, at the first tap, by `initialized (start reason ENTRY_POINT, ... ms)`.

Not harmless, report it:

- `FATAL` anywhere, or `exit code` other than 0;
- `safe mode: 2 failed starts in a row` (the kit's safe boot);
- the log starting only at the newest start although older lines were there before (the data folder was wiped),
  or the QR login asked for again;
- the error at a start whose tap was made long after the install, or the tile gone.

To settle the cause for good (needs the log file itself, not the QR log): in
`/var/opt/public/oap/oap_<uid>/data/cmocan_tidal.log` the `SDK_INFO` or `SDK_WARN` line just before the error.
`conditionalLoading ... skipping loading` would mean the config after all; a line naming the start reason or
`CONFIG_STATE` means A; a resource warning means B.

## 6. Possible follow-ups (not done)

Both are in the kit, which this repository copies unchanged, so they are proposals for upstream
(cauliflowermossgrape/idrive7-apps) or for a decision to patch the copy:

- log `app.startReason` in the "no RHMI application" line (the kit logs it only on the good path);
- keep the `SDK_INFO` lines matching `conditionalLoading|_createRhmiApplication` in the QR log (`qrlog.js` line 61
  drops them, and they are the ones that explain this error).
