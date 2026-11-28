# The tests on the Mac's own CPU (task T1)

The Mac is Apple silicon (arm64); the car is x86-64. Since T1 every test target runs natively on the computer it is
started on, and as x86-64 when asked, and `make release` runs the tests as x86-64 once before it publishes.

| | default (the Mac: arm64, native) | `ARCH=amd64 make <target>` (x86-64, emulated on the Mac) |
|---|---|---|
| `make test` | node:8.9.4-slim and node:22-slim, linux/arm64 (Node is still 8.9.4: the car's syntax) | both images as linux/amd64 |
| `make test-player` | tidal-player built for arm64 into `native/tidal-player/build/arm64/out`, image `tidal-player-test:1-arm64` | the unit's binary `build/out/tidal-player` and its ASan build, image `tidal-player-test:1` (as before T1) |
| `make test-video-player` | both players built for arm64 (`build/arm64/out`), image `tidal-video-test:1-arm64`; software decoding | `build/out`, image `tidal-video-test:1` (as before T1) |
| `make e2e`, `make soak` | the arm64 players, `tidal-player-test:1-arm64` | the x86-64 players in `build/out`, `tidal-player-test:1` |
| `make test-render` | mgu-render-test (arm64), `build/host` in the mgu-store clone (as before T1) | `mgu-render-test:amd64`, `build/host-amd64` |

`tools/arch.sh` decides: `ARCH` from the environment (arm64 or amd64; anything else is refused), else `uname -m`.
`tests/arch.test.js` checks the choice.

## What is never arm64

The car's binaries. `make player`, `make video-player`, `make dist` and the two `check-target.sh` are x86-64 whatever
`ARCH` says (`native/*/Makefile`: `target` and `asan` set `ARCH=amd64`); built with `ARCH=arm64` set they are
byte-identical to the binaries built before T1. The arm64 builds live only in `native/*/build/arm64/` and are never
packaged (`tools/dist.sh` and `tests/tool_package.test.js` take `build/out`). The amd64 FFmpeg builds stay in
`native/*/build/ffmpeg` (unchanged configuration ids `music-1`, `video-1`), so the caches from before T1 are used.

## The sound, sample for sample

tidal-video's sound must equal tidal-player's decode of the same AAC sample for sample (`tests/video_player.test.js`).
FFmpeg's SIMD routines give slightly different sums than its C ones; tidal-video opens its sound decoder and resampler
with the C ones (`av_force_cpu_flags(0)`), and tidal-player's FFmpeg has no x86 SIMD at all. On arm64 tidal-player's
FFmpeg has NEON, and 7 of the 17 video tests failed, in the release and the sanitizer build (the sound
differed from the first sample). So tidal-player now
also opens everything with `av_force_cpu_flags(0)`:

- x86-64: no change. All 10 tone fixtures decoded by the old and the new binary, side by side in `tidal-player-test:1`,
  give byte-identical WAVs (the binary is the same size, 1 661 648 bytes).
- arm64: the comparisons hold exactly. **No tolerance was added.**

## The Intel Media SDK

It exists only on x86-64, and only in the car. The arm64 build still looks for `libmfxhw64.so`, finds none and decodes
in software; `MGU_VIDEO_DECODER=auto` works (the tests for auto without the SDK and with fake SDK libraries pass on
arm64 too).

## The release gate

`make release` (`tools/release.sh`), right after its git checks and before anything is asked of GitHub, built,
committed or published, runs `tools/release-gate.sh`: `ARCH=amd64 make test`, `make test-player`,
`make test-video-player`, `make e2e`, stopping at the first failure, and refuses ("release: refused") if one fails.
`make test-release-gate` checks it with stubs in a scratch repository (a failure of each of the four refuses; gh is
never called; nothing is built, committed or pushed).

## Times

One run each, on the owner's Mac (Apple silicon, OrbStack, 10 CPUs), 2026-11-28, binaries and images already built,
nothing else running.

| target | arm64 (native) | amd64 (emulated) | |
|---|---|---|---|
| `make test` | 5 min 29 s (329 s) | 9 min 49 s (589 s) | 1.8x faster; most of it is the JS suite |
| `make test-player` | 9 min 37 s (577 s) | 10 min 17 s (617 s) | the player plays in real time: little to gain |
| `make test-video-player` | 2 min 30 s (150 s) | 2 min 50 s (170 s) | real time as well; the software H.264 decode is fast either way |
| `make e2e` | 4 min 37 s (277 s) | 4 min 50 s (290 s) | real time (the scenarios play) |
| all four | 22 min 13 s (1333 s) | 27 min 46 s (1666 s) | the release gate costs the amd64 column once per release |

Also green on both: `make test-render` (arm64 6 s with the image and renderer already built; amd64 71 s, the first
run, building its image and renderer under emulation; a frame 60 ms native, 180 ms emulated) and a short
`make soak SOAK_SECONDS=120` (no failures on either).

`make test` as amd64 now runs both Node images as x86-64; before T1 only node:8.9.4 was emulated and node:22 ran
natively, so the time before T1 lies between the two columns. The player tests are mostly real time (the player
plays at the speed of sound), so they gain least.
