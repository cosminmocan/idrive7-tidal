#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# test-player.sh [test files...] - runs tests/player_*.test.js against the real player, in the test image
# (ubuntu:18.04 linux/amd64 with Node 8.10, ffmpeg for the tone fixtures, libasound), twice: the binary built for
# the unit (build/out/tidal-player) and the ASan + UBSan build (build/out/tidal-player-asan). The tests run as
# root in the container (the privilege tests need it); they start the player as nobody unless a test is about root.
# The repository is mounted read-only. One line per file, as tools/run-tests.sh; exits non-zero on any failure.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/../.." && pwd)
IMAGE=${TIDAL_PLAYER_TEST_IMAGE:-tidal-player-test:1}
files=${*:-}
docker run --rm --platform linux/amd64 -v "$root:/w:ro" -w /w -e FILES="$files" -e TIDAL_PLAYER_VERBOSE="${TIDAL_PLAYER_VERBOSE:-}" \
    -e VARIANTS="${TIDAL_PLAYER_VARIANTS:-release asan}" "$IMAGE" sh -c '
    set -u
    sh tests/fixtures/player/make-tones.sh /tmp/fixtures >/dev/null
    export TIDAL_PLAYER_FIXTURES=/tmp/fixtures
    echo "== $(node --version), $(/w/native/tidal-player/build/out/tidal-player --version)"
    failed=0
    for variant in $VARIANTS; do
        case $variant in
            release) export TIDAL_PLAYER=/w/native/tidal-player/build/out/tidal-player TIDAL_PLAYER_SANITIZER=0 ;;
            asan)    export TIDAL_PLAYER=/w/native/tidal-player/build/out/tidal-player-asan TIDAL_PLAYER_SANITIZER=1 ;;
        esac
        for f in ${FILES:-tests/player_*.test.js}; do
            if out=$(timeout 600 node "$f" 2>&1); then
                echo "ok    $variant $f"
                [ -n "$TIDAL_PLAYER_VERBOSE" ] && echo "$out" | sed "s/^/      /"
            else
                failed=$((failed + 1))
                echo "FAIL  $variant $f"
                echo "$out" | sed "s/^/      /"
            fi
        done
    done
    echo "== player tests: $failed file(s) failed"
    [ "$failed" -eq 0 ]
'
