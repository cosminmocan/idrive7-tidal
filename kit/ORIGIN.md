# kit/: origin

Copied from **github.com/cauliflowermossgrape/idrive7-apps** at commit
`f54fc279d309ca12eba129b676d755c6f02f5a06` (branch `main`), MIT licence (`kit/LICENSE`, the repository's
root `LICENSE`).

| Folder | What | Licence |
|---|---|---|
| `runtime/` | the app runtime the build copies into every app (`kit/mgu`, `canvas`, `display`, `parked`, fonts, ...) | MIT |
| `tools/` | `build.py`, `preview.js`, `emu.js`, `hu-stub.js`, `check_signals.py`, `make_icon.js`, ... | MIT |
| `platform/` | `permissions.json`, the template `build.py` puts in each package | MIT |
| `emu/` | the emulator's web page and the draw engine as WebAssembly (`emu.js` serves it) | page MIT; `emu/wasm`, `emu/web/gfx` GPL-3.0-or-later (built from mgu-render) |

Copied unchanged but for what "Our changes" below lists. One file is ours, not the kit's: `tools/emu_forward.js` (runs `emu.js` inside Docker for
`make emu`: `emu.js` listens on 127.0.0.1 only, so it passes the container's published port on to it; and `emu.js`
builds with `build.py`, which wants BMW's SDK, so a `python3` first on its PATH adds `--preview-only`: the
emulator runs the staged app, no SDK and no stand-in for it are needed). Not copied (not needed by this app): `kit/renderd` (the GPU renderer's C source and
prebuilt binary: it comes with the MGU Store on the car), `kit/localization` (non-English fonts and
catalogues: this app is built in English only), `kit/icons` (the kit's own apps' icons).

BMW's SDK (`oap-sdk/`) is not part of the kit and is never in this repository. `build.py --preview-only`
stages an app without it (the preview, the emulator and the tests use that); an installable `.mgu` needs the
SDK extracted from your own head unit (`kit/tools/extract_sdk.js`, see the kit's README, section 3.1).

The kit's own `tools/test_*.js` are its tests for its own apps (they need those apps): they are kept as
they came and are not run by `make test`.

## Our changes

Kept as small as they can be, so a newer kit can be copied over them and the change made again (or dropped once
the kit has it). Each has its tests in `tests/`.

| File | Change | Why | Tests |
|---|---|---|---|
| `runtime/renderd.js` | On a connection in mgu-render's own dialect (`mgu-render/1`), pixel images (`record.js` `setImage`, op 18) are uploaded as that dialect's pictures (message 10: `id, w, h`, RGBA, sent opaque; a side of 1024 at most, a bigger one is not sent and a warning says so once), and the frame's words are sent as a copy with each op 18 in that dialect's form, `x y w h r id` (r 0). The recording itself keeps the kit's `id ver x y w h`, so the software path (`record.js` `play`) and `display.js` are untouched; the upstream dialect is sent as before. Before, the kit uploaded nothing there and logged `renderd: pixel images need the upstream dialect`: no album art in the car (docs/car-log.md, 2026-11-27, row 7). The kit at `f54fc27` (still its newest on 2026-11-27) has no such change. | The app needs `mgu-render/1` for touch and the controller on one connection, and draws covers | `tests/app_covers_gpu.test.js`; `make test-render` (`tests/render_covers.test.js`: the real mgu-render replays the app's stream) |
