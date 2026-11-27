#!/bin/sh
# soak.sh [seconds] [seed] - task I3: starts the long run (tools/e2e/soak.js) in a detached container named
# cmocan-soak and returns at once. Default 7200 s (2 hours). Results in build/soak/: report.json (the verdict),
# metrics.csv (memory and open files every 30 s), soak.log.
#   docker wait cmocan-soak        waits for the end and prints its exit code (0 = passed)
#   cat build/soak/report.json     the verdict
#   docker rm -f cmocan-soak       stops it early
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=${TIDAL_PLAYER_TEST_IMAGE:-tidal-player-test:1}
SECONDS_=${1:-7200}
SEED=${2:-1}
[ -x "$root/native/tidal-player/build/out/tidal-player" ] || { echo "soak: no player binary: run make player first" >&2; exit 1; }
docker rm -f cmocan-soak >/dev/null 2>&1 || true
rm -rf "$root/build/soak" && mkdir -p "$root/build/soak"
docker run -d --name cmocan-soak --init --platform linux/amd64 --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e SOAK_SECONDS="$SECONDS_" -e SOAK_SEED="$SEED" -e SOAK_OUT=/out \
    -v "$root:/w:ro" -v "$root/build/soak:/out" -w /w "$IMAGE" sh -c '
    set -eu
    sh tools/e2e/make-fixtures.sh /tmp/e2e-fixtures >/dev/null
    export E2E_FIXTURES=/tmp/e2e-fixtures E2E_PLAYER=/w/native/tidal-player/build/out/tidal-player
    exec node tools/e2e/soak.js
' >/dev/null
echo "soak: started for $SECONDS_ s in the container cmocan-soak; the verdict will be in build/soak/report.json"
