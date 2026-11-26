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

Copied **unchanged**. Not copied (not needed by this app): `kit/renderd` (the GPU renderer's C source and
prebuilt binary: it comes with the MGU Store on the car), `kit/localization` (non-English fonts and
catalogues: this app is built in English only), `kit/icons` (the kit's own apps' icons).

BMW's SDK (`oap-sdk/`) is not part of the kit and is never in this repository. `build.py --preview-only`
stages an app without it (the preview, the emulator and the tests use that); an installable `.mgu` needs the
SDK extracted from your own head unit (`kit/tools/extract_sdk.js`, see the kit's README, section 3.1).

The kit's own `tools/test_*.js` are its tests for its own apps (they need those apps): they are kept as
they came and are not run by `make test`.
