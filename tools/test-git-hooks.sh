#!/bin/sh
# test-git-hooks.sh - checks the kingfisher secret-scan hooks in tools/git-hooks/ (runs on the Mac: kingfisher is a
# local tool, not in the Docker images). In a scratch repository with a scratch "remote":
#   1. a clean commit passes;
#   2. a commit that adds a private key is blocked (the key is made here, now, and never kept);
#   3. a commit of the assessed test-only keys (tools/kingfisher-baseline.yaml) passes;
#   4. a push of a commit that holds a secret is blocked (committed with --no-verify, as if the commit hook was skipped);
#   5. the push of clean history passes.
# Usage: sh tools/test-git-hooks.sh     (exit 0 = all passed)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v kingfisher >/dev/null || { echo "kingfisher is not installed"; exit 1; }
T=$(mktemp -d "${TMPDIR:-/tmp}/kf-hooks.XXXXXX")
trap 'rm -rf "$T"' EXIT
failed=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 (expected $3, got $2)"; failed=$((failed + 1)); fi; }

git init -q --bare "$T/remote.git"
git init -q "$T/repo" && cd "$T/repo" || exit 1
git config user.name test && git config user.email test@example.invalid
mkdir -p tools tests/fixtures/tidal
cp -R "$ROOT/tools/git-hooks" tools/ 2>/dev/null
cp "$ROOT/tools/kingfisher-baseline.yaml" tools/ 2>/dev/null
git config core.hooksPath tools/git-hooks
git remote add origin "$T/remote.git"

echo 'hello' > clean.txt && git add -A
git commit -q -m clean >/dev/null 2>&1; check "a clean commit passes" $? 0

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out leak.key 2>/dev/null
git add leak.key
git commit -q -m leak >/dev/null 2>&1; check "a commit that adds a private key is blocked" $? 1
git reset -q leak.key && rm -f leak.key

cp "$ROOT"/tests/fixtures/tidal/TEST-ONLY-*.key tests/fixtures/tidal/ && git add tests
git commit -q -m testkeys >/dev/null 2>&1; check "the assessed test-only keys pass (baseline)" $? 0

git push -q origin HEAD:main >/dev/null 2>&1; check "pushing clean history passes" $? 0

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out leak2.key 2>/dev/null
git add leak2.key && git commit -q --no-verify -m "leak past the commit hook" >/dev/null 2>&1
git push -q origin HEAD:main >/dev/null 2>&1; check "pushing a commit that holds a secret is blocked" $? 1

[ "$failed" -eq 0 ] && echo "passed" || echo "FAILED: $failed"
[ "$failed" -eq 0 ]
