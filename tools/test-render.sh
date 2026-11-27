#!/bin/sh
# test-render.sh - the app's pictures drawn by the REAL renderer (make test-render): mgu-render, the renderer the
# car's Store installs, is built from mgu-store at a fixed commit in its own test image (Ubuntu 24.04, Mesa's
# llvmpipe: its docker/test/Dockerfile and Makefile), and tests/render_*.test.js run in that image with
# MGU_RENDER=<the binary>: they record the byte stream the app sends and replay it (mgu-render --replay).
#
# mgu-store (GPL-3.0) is never part of this repository: it is cloned into build/mgu-store (git ignores build/), as
# tools/dist.sh does, at the same commit; MGU_STORE=<a checkout> uses another. The binary stays in the clone's own
# native/mgu-render/build/. The stream, the renderer's log and the drawn picture are kept in build/test-render/.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
MGU_STORE=${MGU_STORE:-build/mgu-store}
MGU_STORE_GIT=${MGU_STORE_GIT:-https://github.com/robertnisipeanu/mgu-store.git}
MGU_STORE_REV=${MGU_STORE_REV:-37702a880f1ed5fd346f4c944127fb276920be9c}
IMAGE=mgu-render-test
case "$MGU_STORE" in /*) ;; *) MGU_STORE="$ROOT/$MGU_STORE" ;; esac

if [ "$MGU_STORE" = "$ROOT/build/mgu-store" ]; then
    mkdir -p "$ROOT/build"
    if [ ! -e "$MGU_STORE/.git" ]; then
        echo "mgu-store: cloning $MGU_STORE_GIT into $MGU_STORE"
        git clone -q --no-checkout "$MGU_STORE_GIT" "$MGU_STORE"
    fi
    git -C "$MGU_STORE" cat-file -e "$MGU_STORE_REV^{commit}" 2>/dev/null || git -C "$MGU_STORE" fetch -q origin
    git -C "$MGU_STORE" -c advice.detachedHead=false checkout -q -f "$MGU_STORE_REV"
    [ "$(git -C "$MGU_STORE" rev-parse HEAD)" = "$MGU_STORE_REV" ] || { echo "mgu-store is not at $MGU_STORE_REV" >&2; exit 1; }
fi
SRC=$MGU_STORE/native/mgu-render
[ -f "$SRC/Makefile" ] && [ -f "$SRC/docker/test/Dockerfile" ] || { echo "no mgu-render in $MGU_STORE" >&2; exit 1; }
echo "mgu-render: $(git -C "$MGU_STORE" log -1 --format='mgu-store %h, %cd' --date=short 2>/dev/null || echo "$MGU_STORE")"

docker build -q -t "$IMAGE" "$SRC/docker/test" >/dev/null
# its Makefile's in-build, as its `make test` runs it (build/host/mgu-render)
docker run --rm -v "$SRC:/src" -w /src -u "$(id -u):$(id -g)" "$IMAGE" make -s in-build OUT=host
[ -x "$SRC/build/host/mgu-render" ] || { echo "mgu-render was not built" >&2; exit 1; }

OUT=$ROOT/build/test-render
# (emptied, not made anew: Docker Desktop loses a mounted folder that was removed and made again a moment before)
mkdir -p "$OUT"; rm -f "$OUT"/now-playing.* "$OUT"/mgu-render.log
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$ROOT:/w:ro" -v "$SRC/build/host:/render:ro" -v "$OUT:/out" -w /w \
    -e MGU_RENDER=/render/mgu-render -e MGU_RENDER_OUT=/out "$IMAGE" sh -c '
    echo "== mgu-render (llvmpipe), Node $(node --version)"
    failed=0
    for f in tests/render_*.test.js; do
        if out=$(timeout 300 node "$f" 2>&1); then echo "ok    $f"; echo "$out" | grep "^       " || true
        else failed=$((failed + 1)); echo "FAIL  $f"; echo "$out" | sed "s/^/      /"; fi
    done
    echo "== $failed file(s) failed"
    [ "$failed" -eq 0 ]
'
echo "kept: build/test-render/ (now-playing.bin, mgu-render.log, now-playing.png)"
