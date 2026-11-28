#!/bin/sh
# release-gate.sh - the release gate (task T1): what must pass as x86-64, the car's CPU, before `make release`
# (tools/release.sh) publishes anything. Day to day the tests run natively on the Mac (arm64); here they run once
# more as the car runs them:
#   ARCH=amd64 make test, make test-player, make test-video-player, make e2e
# in this order, stopping at the first failure. Exits 0 when all four passed, 1 (naming the one that failed)
# otherwise. RELEASE_GATE_MAKE stands in for make (tools/test-release-gate.sh, `make test-release-gate`).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MAKE_CMD=${RELEASE_GATE_MAKE:-make}
for t in test test-player test-video-player e2e; do
    echo "release gate: ARCH=amd64 make $t"
    if ! ARCH=amd64 "$MAKE_CMD" -C "$ROOT" "$t"; then
        echo "release gate: FAILED: ARCH=amd64 make $t (x86-64, the car's CPU)" >&2
        exit 1
    fi
done
echo "release gate: passed (make test, test-player, test-video-player and e2e as x86-64)"
