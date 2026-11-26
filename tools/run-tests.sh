#!/bin/sh
# run-tests.sh <node8|current> - every tests/*.test.js in Docker on one Node version, one line per file.
# node8: node:8.9.4-slim as x86-64 (the car's Node and CPU); current: node:22-slim on this machine's CPU.
# Exits non-zero when any file fails. Nothing is installed: the repository is mounted read-only.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "${1:-}" in
    node8)   IMAGE=node:8.9.4-slim; PLATFORM=--platform=linux/amd64 ;;
    current) IMAGE=node:22-slim;    PLATFORM= ;;
    *) echo "usage: $0 node8|current" >&2; exit 2 ;;
esac
# shellcheck disable=SC2086
docker run --rm $PLATFORM -v "$ROOT:/w:ro" -w /w "$IMAGE" sh -c '
    echo "== $(node --version)"
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
