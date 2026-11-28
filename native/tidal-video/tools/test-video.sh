#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# test-video.sh [test files...] - runs tests/video_player*.test.js against the real video player, in the test image
# (tidal-video-test:1: ubuntu:18.04 linux/amd64, Node 8.10, ffmpeg 3.4 with libx264 for the clips), twice: the
# binary built for the unit (build/out/tidal-video) and the ASan + UBSan build (build/out/tidal-video-asan). The
# music player (native/tidal-player/build/out/tidal-player) decodes the reference sound. As tidal-player's
# test-player.sh: as root in the container (the privilege tests need it), the player started as nobody unless a
# test is about root; the repository mounted read-only; one line per file; non-zero on any failure.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)
IMAGE=${TIDAL_VIDEO_TEST_IMAGE:-tidal-video-test:1}
files=${*:-}
docker run --rm --platform linux/amd64 --shm-size 256m -v "$root:/w:ro" -w /w -e FILES="$files" \
    -e TIDAL_PLAYER_VERBOSE="${TIDAL_PLAYER_VERBOSE:-}" -e VARIANTS="${TIDAL_VIDEO_VARIANTS:-release asan}" "$IMAGE" sh -c '
    set -u
    sh tests/fixtures/video/make-clips.sh /tmp/clips >/dev/null
    export TIDAL_VIDEO_FIXTURES=/tmp/clips TIDAL_PLAYER=/w/native/tidal-player/build/out/tidal-player
    echo "== $(node --version), $(/w/native/tidal-video/build/out/tidal-video --version 2>&1 | head -1)"
    failed=0
    for variant in $VARIANTS; do
        case $variant in
            release) export TIDAL_VIDEO=/w/native/tidal-video/build/out/tidal-video TIDAL_PLAYER_SANITIZER=0 ;;
            asan)    export TIDAL_VIDEO=/w/native/tidal-video/build/out/tidal-video-asan TIDAL_PLAYER_SANITIZER=1 ;;
        esac
        for f in ${FILES:-tests/video_player*.test.js}; do
            if out=$(timeout 900 node "$f" 2>&1); then
                echo "ok    $variant $f"
                [ -n "$TIDAL_PLAYER_VERBOSE" ] && echo "$out" | sed "s/^/      /"
            else
                failed=$((failed + 1))
                echo "FAIL  $variant $f"
                echo "$out" | sed "s/^/      /"
            fi
        done
    done
    echo "== video player tests: $failed file(s) failed"
    [ "$failed" -eq 0 ]
'
