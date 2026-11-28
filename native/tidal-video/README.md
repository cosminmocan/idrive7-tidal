# tidal-video

The video player of the cmocan-tidal service: one TIDAL video on the iDrive 7 head unit (MGU). MPEG-TS comes in on
stdin (H.264 + AAC-LC: TIDAL's HLS segments, one after another, as the service downloads them). The pictures go into
mgu-render's frame file, the sound into SmartXbar's CarLife input exactly as the music player `tidal-player` plays a
track. The contract is `docs/PROTOCOL.md`, section 2, "The video player (`tidal-video`)"; this README says how it is
met. `tidal-player` is not touched by video.

| Part | Does |
|---|---|
| input | stdin, read once with `poll` (a quit is seen while waiting), never seeked. libavformat's `mpegts` demuxer (forced: the input is MPEG-TS), the analysis 2 MiB / 2.5 s at most (an HLS segment starts with a key frame: the picture's size is known from it). |
| sound | as tidal-player: libavcodec's `aac`, each frame mixed to stereo float, libswresample to 48 kHz S16, a 6 s queue, the clock, the prebuffer (`MGU_PREBUFFER_MS`) and buffering, ALSA opened at run time (non-blocking, retried each second, 30 s), `wav:` and `null` for tests, the volume, `dropped`. Only AAC plays; anything else is a `decode` error. |
| picture | the H.264 stream's packets go into their own queue (never waited for: a picture decoder that cannot keep up never holds up the sound; past 12 s or 64 MiB queued, packets are left out up to the next key frame and counted in `vdropped`). The video thread decodes them (below) and puts each picture into the frame file when the sound's clock reaches its time (4 ms early); a picture later than 120 ms is left out and counted in `vdropped`. Pictures shown are `vframes`. |
| decoder | `MGU_VIDEO_DECODER`: `auto` (default) tries the Intel Media SDK (`msdk`: libmfxhw64 over VA-API on `/dev/dri/renderD128`, tvh-player's decoder); if its libraries do not load or it does not start, or it gives no picture from the first 60 packets, the software decoder takes over (`sw`: libavcodec's h264 with FFmpeg's x86 SIMD, all cores). `msdk`: the Media SDK or no picture (a `video` error, the sound plays). `sw`: software only (the tests). |
| frame file | `MGU_VIDEO=shm:<name>` (default `shm:cmocan-tidal`): `/dev/shm/mgu-video-<name>`, mgu-render's MGVF (its PROTOCOL.md, "Video"): a 64-byte header (magic, version 1, w, h, seq, slot, nslot 3, matrix BT.709, or BT.601 when the stream says so, range limited unless it says full, format 0 = **I420**), then 3 slots of w x h x 3/2. The picture's own size (even; 1080p at most here is 1920x1080, 9.3 MB); the app places it. I420 is what every mgu-render reads (NV12 only where X_READY caps has 256); the Media SDK's NV12 is turned into I420 on the CPU (tvh-player's way). `MGU_VIDEO=null`: decoded, timed and counted, not shown. |
| frame file and root | the file is made (opened `O_NOFOLLOW`, 0600, emptied) **before** the player drops root, and given to the user it becomes (`fchown`; a file of anybody else there is replaced, not taken over); its descriptor stays open, so it is sized and mapped after the drop, when the picture's size is known. As a user, it is made as that user. It cannot be made: a `video` error, the sound plays alone. |
| positions | a timestamp t is at `MGU_BASE_MS` + (t - the stream's first timestamp). `MGU_START_MS` is a position (one before the base is the base): the sound before it is decoded and thrown away, not played and not paced, exactly as tidal-player's (the first sound's position, then whole 48 kHz frames); the pictures before it are decoded and not shown, and the last one before it is shown when playing starts (the picture of that moment). Nothing queued before a key frame that is before the start is decoded. |
| no picture | no video stream, not H.264, larger than 2048x2048, no frame file, or `msdk` that does not start: one `video` event with `state: "error"`, and the sound plays alone (`vframes` 0). |
| runs as | as tidal-player: started as root it refuses to run without `MGU_RUN_AS` (exit 3, nothing made), becomes `MGU_RUN_AS` with `MGU_GROUPS` (default `mgu_alsa,audio,video`: `video` for the render node) before it reads a byte; already a user, it plays as that user. |
| control, ending | as tidal-player: fd 3 `pause`, `resume`, `volume <0..1>`, `quit`; fd 3 closing is quit; quit or SIGTERM: the sound device closed, gone within 2.5 s, exit 0, neither `end` nor `error`. |
| events | `open` (`codec: "aac"`, rate, channels, `duration: null`: the length is the service's to say, from the HLS playlist; `video: {codec: "h264", width, height}` when there is a picture), `video` (`open` with `decoder`, `width`, `height`, `file`; or `error` with `decoder` and `message`), `audio`, `tick` (with `vframes`, `vdropped`), `end`, `error`. |
| errors | random bytes or no AAC: `decode` (5); nothing, or MPEG-TS cut off before any sound: `input` (4); `MGU_VIDEO`, `MGU_VIDEO_DECODER`, `MGU_AUDIO` not understood: `internal` (2). A broken picture stream is never an error: the sound plays to the end. |

**The sound is sample for sample tidal-player's.** FFmpeg here has its x86 SIMD routines (the software H.264 decoder
needs them), tidal-player's has none, and the AAC decoder's and the resampler's SIMD routines round differently
(measured: 167 bytes of the 720p clip's WAV differ). So the AAC decoder and the resampler are opened with the CPU
flags forced to none (`av_force_cpu_flags(0)`, under a lock the H.264 decoder's opening shares): their plain C
routines, as tidal-player's. The tests check the WAV against tidal-player's decode of the clip's own AAC.

**Linked and opened.** FFmpeg n6.1.2 (the `mpegts` demuxer, the `h264` and `aac` parsers and decoders,
libswresample), libstdc++ and libgcc are linked statically; the binary needs only libc, libm, libdl and libpthread,
and the unit's loader `/lib/ld-linux-x86-64.so.2`. Opened at run time with `dlopen`, never linked: `libasound.so.2`
(the sound, as tidal-player), and for `msdk` `libmfxhw64.so` (or `/usr/lib/libmfxhw64-p.so.1.24`, the unit's file),
`libva.so.1` and `libva-drm.so.1`. `src/msdk_dl.cpp` defines the 18 Media SDK and libva functions tvh-player's
decoder calls (hidden), each forwarding to the library's, found with `dlsym`; `tools/check-target.sh` checks every
name against the export lists of the unit's libraries (`abi/*.symbols`, from tvh-player). So the binary starts
anywhere glibc 2.27 is, and without the Media SDK it decodes in software. About 2.9 MB.

`tidal-video --version` prints the version, FFmpeg's, the decoders inside, and whether libasound and the Media SDK
are there.

## Build and test

Everything runs in Docker (`ubuntu:18.04`, `linux/amd64`, glibc 2.27 as the unit). Nothing is needed on the host
but Docker and curl.

```sh
make video-player                                # (repository root) build/out/tidal-video, and check it for the unit
make test-video-player                           # (repository root) tidal-player, tidal-video and its ASan build, the tests
make -C native/tidal-video target check-target   # the same as make video-player
make -C native/tidal-video asan                  # build/out/tidal-video-asan: ASan + UBSan, for the tests
```

- `build.sh`, `build.mk`, `Dockerfile`: tidal-player's, with nasm in the build image (FFmpeg's x86 assembly) and the
  video configuration (`FF_FLAGS_ID=video-1`); FFmpeg is built once into `build/ffmpeg` (the archive is taken from
  `native/tidal-player/build` when it is there, checked by sha256).
- `tools/check-target.sh` (`make video-player`): an x86-64 ELF, the loader, no glibc symbol newer than 2.27, no
  libstdc++/libgcc symbol versions, only libc/libm/libdl/libpthread/librt, the four libraries opened at run time,
  no Media SDK or libva symbol in the dynamic table, every function looked up in the unit's export lists, and that it
  starts on ubuntu:18.04 with the loader only at the unit's path, with the h264 and aac decoders.
- `tools/test-video.sh` (`make test-video-player`): the test image (`Dockerfile`, target `test`: bionic's Node 8.10
  and ffmpeg 3.4 with libx264) makes the clips (`tests/fixtures/video/make-clips.sh`: testsrc + a tone; H.264 Main
  720p25 with B frames and High 1080p, AAC, MPEG-TS; sound alone; MPEG-2) and runs `tests/video_player*.test.js`
  against the unit's binary and against the sanitizer build, as root (the player as nobody unless a test is about
  root). The reference sound is tidal-player's decode of each clip's AAC; the reference pictures the ffmpeg command
  line's decode. In `make test` the file prints one skip line. `TIDAL_VIDEO_VARIANTS=release` runs the unit's binary
  only; `TIDAL_PLAYER_VERBOSE=1` shows each test.
- LeakSanitizer cannot run under the Mac's x86-64 emulation, so the sanitizer build runs with `detect_leaks=0`.

## Origin

| File | From |
|---|---|
| `src/player.cpp` | `native/tidal-player/src/player.cpp` of this repository (itself from aurelmarius/bmw-apps `native/tvh-player/src/player.cpp` @ `0976d16dda9be301d98b0253586d4c095160ac2b`, GPL-3.0-or-later): the sound path, control, ticks, root drop, errors. The video thread follows tvh-player's (same commit): the decoder fed one access unit per packet with its timestamp, a late picture decoded without VPP, each picture into the frame file on the clock. MPEG-TS input, the software decoder, the decoder choice, the frame file before the root drop, positions with `MGU_BASE_MS` are new. |
| `src/decoder_msdk.cpp`, `.h` | aurelmarius/bmw-apps `native/tvh-player/src/` @ `0976d16` (Robert Nisipeanu's waze-on-cluster decoder via JustAnotherPU's moonride and aurelm-emby, GPL-3.0-or-later); the HEVC plugin hook removed |
| `src/nal_reader.cpp`, `.h` | the same, unchanged (moonride `a834a14`) |
| `src/mgvf.cpp`, `.h` | the same (moonride `a834a14`); changed: `create()` before the root drop and `size()` after it, the format word, `i420_copy` |
| `src/msdk_dl.cpp`, `.h` | new |
| `abi/include/mfx/` | the same tvh-player commit: Intel Media SDK headers as moonride vendors them (MIT, `abi/include/mfx/LICENSE`) |
| `abi/*.symbols` | the same tvh-player commit: the unit's libmfxhw64, libva and libva-drm export lists (Robert Nisipeanu, GPL-3.0-or-later) |
| `build.sh`, `build.mk`, `Dockerfile`, `tools/check-target.sh` | `native/tidal-player/` of this repository, changed for video |
| the frame file format | robertnisipeanu/mgu-store `native/mgu-render/PROTOCOL.md` "Video" @ `37702a880f1ed5fd346f4c944127fb276920be9c` |

aurelmarius/bmw-test-apps `native/emby-player` (@ `511c5e0`, a VOD player of the same kind) was read; nothing is
copied from it.

## Licence

GPL-3.0-or-later. FFmpeg is LGPL-2.1-or-later; `build.sh` puts its licence beside the binary as
`build/FFMPEG-LICENSE`, to ship with the tool. The Media SDK headers are MIT.

## Checked only in the car (task V1e)

- the Media SDK decode on the GPU (`decoder: "msdk"` in the `video` event; tvh-player's decoder has itself never
  run on the GPU), that `libmfxhw64.so` and `libva*.so.1` are found by those names, `/dev/dri/renderD128` open as
  the player's user with the `video` group;
- the frame file shown by the car's mgu-render (owned by the user the player runs as: nobody is accepted;
  mgu-render's own `make test-render` replay covers the drawing);
- picture and sound in step on the speakers; `vdropped` small over a whole video;
- the CPU: the NV12 to I420 copy per picture (tvh-player's way), and the software decoder if the Media SDK fails
  (720p25 should keep up on the Apollo Lake's four cores with SIMD; 1080p may drop pictures, never the sound);
  `CPUQuota` may need raising for video (tvh-player runs at 200%).
