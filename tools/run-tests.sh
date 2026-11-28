#!/bin/sh
# run-tests.sh <node8|current> - every tests/*.test.js in Docker on one Node version, one line per file.
# node8: node:8.9.4-slim (the car's Node); current: node:22-slim. Both on this computer's own CPU (the Mac: arm64),
# or as x86-64, the car's CPU, with ARCH=amd64 (tools/arch.sh). RUN_TESTS_DRY_RUN=1 prints the docker command only.
# Exits non-zero when any file fails. Nothing is installed: the repository is mounted read-only.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
    node8)   IMAGE=node:8.9.4-slim ;;
    current) IMAGE=node:22-slim ;;
    *) echo "usage: $0 node8|current" >&2; exit 2 ;;
esac
. "$ROOT/tools/arch.sh"
if [ -n "${RUN_TESTS_DRY_RUN:-}" ]; then echo "docker run --rm --platform=$PLATFORM -v $ROOT:/w:ro -w /w $IMAGE sh -c ..."; exit 0; fi
docker run --rm --platform="$PLATFORM" -v "$ROOT:/w:ro" -w /w "$IMAGE" sh -c '
    echo "== $(node --version) ($(uname -m))"
    failed=0
    for f in tests/*.test.js; do
        # a whole file gets 5 minutes at most (each test inside also has its own limit, tests/lib/t.js)
        if out=$(timeout 300 node "$f" 2>&1); then
            echo "ok    $f"
        else
            failed=$((failed + 1))
            echo "FAIL  $f"
            echo "$out" | sed "s/^/      /"
        fi
    done
    echo "== $(node --version): $failed file(s) failed"
    [ "$failed" -eq 0 ]
'
