# tidal-player

The player of the cmocan-tidal service: one TIDAL track on the iDrive 7 head unit (MGU). The track's bytes come
in on stdin (FLAC, or AAC in MP4, as TIDAL serves them), the sound goes out as 48 kHz stereo 16-bit into
SmartXbar's CarLife input (`plug:smartx:CarLifeMedia_CF_48_STEREO`). The service starts one player per track.
The contract is `docs/PROTOCOL.md`, section 2; this README says how it is met.

| Part | Does |
|---|---|
| input | stdin, read with `poll` (a quit is seen while waiting). It can seek back within what it holds: FLAC and an MP4 with its index (`moov`) first are read straight through and only 1 MiB is kept behind; an MP4 whose index comes after its audio is held in memory (64 MiB at most, some 25 minutes of AAC 320) until the demuxer comes back from the index. Nothing is ever seeked on the pipe itself. |
| demux, decode | FFmpeg's `flac`, `mov` and `aac` (ADTS) demuxers, `flac` and `aac` decoders. A broken packet is counted and skipped. |
| sound | each frame mixed to stereo float (mono on both channels at full level; more than two channels mixed down as tvh-player does), then libswresample to 48 kHz S16, always: the car's input is fixed at 48 kHz and ALSA's `plug` is not relied on. A queue of 6 s at most: when it is full the decoder waits, and so does the sender, in the pipe. |
| clock | monotonic, from the first sound; it stands while paused, while buffering and while the device cannot be opened. Sound is written when it is due (40 ms ahead), and to ALSA no faster than the device plays it. |
| start position | `MGU_START_MS=<ms>` (a seek; the service starts a new player for it): the input still comes from its first byte and is decoded and resampled as ever, and the first `ms` x 48 frames at 48 kHz are thrown away before the queue, as fast as the input arrives (nothing of it is queued, played or paced). So what plays is, sample for sample, what a player started at 0 plays from that position. The clock and the ticks' `pos` start at the position (`buffering` until the prebuffer is there). A position at the end or past it (24 hours at most are counted): `end` at once. A value that is not a whole number of 0 or more is logged and taken as 0. |
| prebuffer | the clock starts once `MGU_PREBUFFER_MS` (1500) of sound is queued, and after the input ran dry (`buffering`) it plays again once that much is queued again (or the input has ended). |
| device | `MGU_AUDIO=alsa:<device>`: libasound.so.2 opened at run time (`dlopen`; never linked), the device non-blocking, 48 kHz stereo S16, `MGU_ALSA_US` (64000) of buffer. A device that cannot be opened (busy: another app's player has it; or missing) is told in `audio` and tried again each second, the decoding going on into the queue; after 30 s it is an `audio` error. Sound the device does not take for 250 ms (nobody reads it: source 287 not connected yet) is dropped and counted in the ticks' `dropped`, the clock going on. The device is closed first when the player ends. |
| runs as | started as root, it becomes `MGU_RUN_AS` (a name or a number) with the groups in `MGU_GROUPS` (default `mgu_alsa,audio`; a group the system does not have is skipped and logged) before it opens anything or reads a byte, and refuses to stay root (exit 3). Already a user, it plays as that user. |
| control | fd 3, one per line: `pause`, `resume`, `volume <0..1>` (held to 0..1, applied at the output), `quit`. Anything else is ignored; a line over 4 KiB is skipped. fd 3 closing (the service gone) is `quit`. Without fd 3 it plays to the end. |
| ending | `quit`, SIGTERM or fd 3 closed: the sound device closed, gone within 2.5 s, exit 0, neither `end` nor `error`. |
| events | stdout, `MGU {json}`: `open`, `audio`, `tick` (every 500 ms from `open`), `end`, `error`. Log lines go to stderr. |

| Exit | |
|---|---|
| 0 | played to the end (`end`), or told to end |
| 2 | bad environment: `MGU_AUDIO` not understood, `MGU_RUN_AS` not a user |
| 3 | refused: root without `MGU_RUN_AS`, or still root after it |
| 4 | input: empty, or cut off before any sound |
| 5 | decode: not FLAC or AAC, or nothing in it decodes |
| 6 | audio: the WAV cannot be made, libasound missing, or the device not opened within 30 s |

`tidal-player --version` prints the version, FFmpeg's, the decoders inside and whether libasound.so.2 is there.

## Build and test

Everything runs in Docker (`ubuntu:18.04`, `linux/amd64`, glibc 2.27 as the unit; on an Apple-silicon Mac it is
emulated). Nothing is needed on the host but Docker and curl.

```sh
make -C native/tidal-player target check-target   # build/out/tidal-player for the unit, and check it (task B1)
make -C native/tidal-player asan                  # build/out/tidal-player-asan: ASan + UBSan, for the tests
make test-player                                  # (repository root) both, then tests/player_*.test.js against each
make player                                       # (repository root) target + check-target
```

- `build.sh` downloads FFmpeg n6.1.2 at the commit tvh-player pins (`b1a4534`, checked by sha256), configures it
  with `--disable-everything` and only the flac, mov and aac demuxers, the flac and aac parsers and decoders and
  libswresample, and builds it once into `build/ffmpeg` (kept: it is rebuilt only when the configuration's id in
  `build.sh` changes). The player is linked with FFmpeg, libstdc++ and libgcc statically, and asks for the unit's
  loader `/lib/ld-linux-x86-64.so.2`.
- `tools/check-target.sh` (`make check-target`): an x86-64 ELF, the loader `/lib/ld-linux-x86-64.so.2`, no glibc
  symbol newer than 2.27, only libc, libm, libdl, libpthread and librt (and the loader itself), libasound left to
  `dlopen`, and that it starts in ubuntu:18.04 with the loader only at that path and names its decoders.
- `tools/test-player.sh` (`make test-player`): the test image (`Dockerfile`, target `test`: bionic's Node 8.10,
  ffmpeg 3.4 for the fixtures, libasound) makes the tone fixtures (`tests/fixtures/player/make-tones.sh`,
  generated tones only) and runs every `tests/player_*.test.js` once against the unit's binary and once against
  the sanitizer build, as root (the privilege tests need it; the others start the player as nobody). In `make
  test` (node:8.9.4, whose glibc is too old for the binary) these files print one skip line and pass.
  `TIDAL_PLAYER_VARIANTS=release` runs the unit's binary only; `TIDAL_PLAYER_VERBOSE=1` shows each test and the
  player's log.
- LeakSanitizer cannot run under the Mac's x86-64 emulation (it cannot stop the threads), so the sanitizer build
  runs with `detect_leaks=0`: address errors and undefined behaviour fail the tests, leaks are not looked for.

## Origin

| File | From |
|---|---|
| `src/player.cpp` | aurelmarius/bmw-apps `native/tvh-player/src/player.cpp` @ `0976d16dda9be301d98b0253586d4c095160ac2b` (GPL-3.0-or-later): the event format, the control thread, the clock, the stereo mix-down, the WAV/null outputs, the ALSA loader, the root drop, the watchdog. The ALSA handling also follows `native/uxplay-mgu/audio/mgu_audio.cpp` (same commit). Video, MPEG-TS, subtitles, MSDK/VA-API, gain and compressor removed; FLAC/MP4 input, resampling, the seekable input, error codes and exit codes added. |
| `build.sh`, `build.mk` | the same repository's `native/tvh-player/build.sh` and `Makefile` (FFmpeg pin, static linking, the loader), changed for the music configuration and a sanitizer build |
| everything else | new |

`glibc_compat.c` (tvh-player binds `powf`/`log2f` to old versions for glibc 2.25) is not needed: the unit has
glibc 2.27, which is what the binary is checked against.

## Licence

GPL-3.0-or-later. FFmpeg is LGPL-2.1-or-later; `build.sh` puts its licence beside the binary as
`build/FFMPEG-LICENSE`, to ship with the tool.

## Checked only in the car (task K1)

The sound on the speakers through smartx at 48 kHz; that `plug:smartx:CarLifeMedia_CF_48_STEREO` takes the
non-blocking writes in time (no `dropped` in the ticks over 60 s); that `mgu_alsa` exists and is enough for the
device as nobody; the busy device while another app's player holds it; `pause`, `resume`, `quit` with nothing
left running.
