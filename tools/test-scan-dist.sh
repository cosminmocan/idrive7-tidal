#!/bin/sh
# test-scan-dist.sh - checks tools/scan-dist.sh, the secret scan of what is about to be uploaded to a GitHub release
# (an upload is not a git push, so the hooks never see it). Runs on the Mac (kingfisher is local).
#   1. a folder of clean packages passes;  2. a package with a private key inside is blocked;
#   3. a catalog.json holding a secret is blocked;  4. an empty folder is refused (nothing to scan is not "clean").
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
S=$(mktemp -d "${TMPDIR:-/tmp}/kf-dist.XXXXXX")
trap 'rm -rf "${S:?}/clean" "${S:?}/leak" "${S:?}/cat" "${S:?}/empty" "${S:?}/src"; rmdir "${S:?}"' EXIT
failed=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 (expected $3, got $2)"; failed=$((failed + 1)); fi; }
mkdir -p "$S/src/package" "$S/clean" "$S/leak" "$S/cat" "$S/empty"
echo '{"name":"x","version":"0.1.0"}' > "$S/src/package/package.json"
tar -czf "$S/clean/x@0.1.0.tgz" -C "$S/src" package && echo '{"schema":2,"components":[]}' > "$S/clean/catalog.json"
sh "$ROOT/tools/scan-dist.sh" "$S/clean" >/dev/null 2>&1; check "clean packages pass" $? 0
cp "$S/clean/catalog.json" "$S/leak/"; openssl genpkey -algorithm RSA -out "$S/src/package/id.key" 2>/dev/null
tar -czf "$S/leak/x@0.1.0.tgz" -C "$S/src" package; rm -f "$S/src/package/id.key"
sh "$ROOT/tools/scan-dist.sh" "$S/leak" >/dev/null 2>&1; check "a package with a private key inside is blocked" $? 1
cp "$S/clean/x@0.1.0.tgz" "$S/cat/"; openssl genpkey -algorithm RSA 2>/dev/null > "$S/cat/catalog.json"
sh "$ROOT/tools/scan-dist.sh" "$S/cat" >/dev/null 2>&1; check "a catalog holding a secret is blocked" $? 1
sh "$ROOT/tools/scan-dist.sh" "$S/empty" >/dev/null 2>&1; check "an empty folder is refused" $? 1
[ "$failed" -eq 0 ] && echo "passed" || echo "FAILED: $failed"
[ "$failed" -eq 0 ]
