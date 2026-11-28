#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# run.sh - the end-to-end test (tests/e2e.test.js) in the player's test image (ubuntu:18.04, glibc 2.27
# as the head unit, bionic's Node 8.10, ffmpeg for the fixtures), as an unprivileged user (uid 1000): nothing in
# it needs root. The repository is mounted read-only; the fixtures and every WAV are made in the container's /tmp.
# `make e2e` builds the player first. E2E_VERBOSE=1 shows the service's log;
# E2E_ONLY=<regexp> runs only the scenarios whose names match (e.g. '^(1|5)\.').
# On this computer's own CPU (tools/arch.sh; the Mac: the arm64 builds in build/arm64/out, tidal-player-test:1-arm64);
# ARCH=amd64: the x86-64 builds in build/out (the unit's binaries), in tidal-player-test:1, as before task T1.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
. "$root/tools/arch.sh"
IMAGE=${TIDAL_PLAYER_TEST_IMAGE:-tidal-player-test:1$ARCH_SUFFIX}
docker run --rm --init --platform "$PLATFORM" --user 1000:1000 -e HOME=/tmp -e E2E_VERBOSE="${E2E_VERBOSE:-}" -e E2E_ONLY="${E2E_ONLY:-}" \
    -e E2E_PLAYER="/w/native/tidal-player/$ARCH_BUILD/out/tidal-player" -e E2E_VIDEO="/w/native/tidal-video/$ARCH_BUILD/out/tidal-video" \
    -v "$root:/w:ro" -w /w "$IMAGE" sh -c '
    set -eu
    sh tools/e2e/make-fixtures.sh /tmp/e2e-fixtures >/dev/null
    export E2E_FIXTURES=/tmp/e2e-fixtures E2E_PLAYER E2E_VIDEO
    echo "== e2e: $(node --version), $(uname -m), uid $(id -u), $($E2E_PLAYER --version | head -n 1), $($E2E_VIDEO --version 2>&1 | head -n 1)"
    timeout 900 node tests/e2e.test.js
'
