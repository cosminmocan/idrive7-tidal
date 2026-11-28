#!/bin/sh
# test-release-gate.sh - checks the release gate (task T1; tools/release-gate.sh, called by tools/release.sh): before
# `make release` publishes anything, `make test`, `make test-player`, `make test-video-player` and `make e2e` run as
# x86-64 (ARCH=amd64, the car's CPU), and a failure of any of them refuses the release. Runs on the Mac (git and sh
# only, no Docker), in a scratch repository whose main is level with its scratch "remote", so release.sh gets past its
# own checks:
#   1. the gate alone runs the four targets in order, each with ARCH=amd64 even when ARCH=arm64 is set, and passes;
#   2. the gate alone fails (exit 1, naming the target) when one fails, and runs nothing after it;
#   3. release.sh with a failing gate refuses: non-zero, "refused", gh never called, nothing built, committed, pushed;
#   4. release.sh with a passing gate goes on to the release (the first gh call), the gate having run first.
# make is replaced by RELEASE_GATE_MAKE (a stub here that fails the target named in FAIL_AT); gh, make and docker
# are stubs that only write down that they were called: nothing is ever published. PATH is cut to the stubs and
# /usr/bin:/bin, so the real gh cannot be reached.
# Usage: sh tools/test-release-gate.sh     (exit 0 = all passed)
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")
trap 'rm -rf "$T"' EXIT
failed=0
check() { if [ "$2" = "$3" ]; then echo "ok    $1"; else echo "FAIL  $1 (expected \"$3\", got \"$2\")"; failed=$((failed + 1)); fi; }
has() { if grep -q "$3" "$2" 2>/dev/null; then echo "ok    $1"; else echo "FAIL  $1 (\"$3\" not in $2:)"; sed 's/^/      /' "$2" 2>/dev/null; failed=$((failed + 1)); fi; }
absent() { if [ ! -e "$2" ]; then echo "ok    $1"; else echo "FAIL  $1:"; sed 's/^/      /' "$2"; failed=$((failed + 1)); fi; }

# the stubs
mkdir -p "$T/bin"
cat > "$T/bin/gate-make" <<'EOF'
#!/bin/sh
# make -C <dir> <target>: writes down ARCH and the target; fails the target named in FAIL_AT
t=$3
echo "ARCH=${ARCH:-} $t" >> "$LOG/gate-make"
[ "$t" != "${FAIL_AT:-}" ] || { echo "stub: $t failed" >&2; exit 2; }
exit 0
EOF
for c in gh make docker; do printf '#!/bin/sh\necho "%s $*" >> "$LOG/%s"\nexit 1\n' "$c" "$c" > "$T/bin/$c"; done
chmod +x "$T/bin/"*
export LOG="$T/log" RELEASE_GATE_MAKE="$T/bin/gate-make"
SAFE_PATH="$T/bin:/usr/bin:/bin"
fresh() { rm -rf "$LOG"; mkdir -p "$LOG"; }

# the scratch repository: the release scripts, committed on main, level with origin/main
git init -q --bare "$T/remote.git"
git init -q -b main "$T/repo" || exit 1
mkdir -p "$T/repo/tools"
cp "$ROOT/tools/release.sh" "$ROOT/tools/release-gate.sh" "$ROOT/tools/arch.sh" "$T/repo/tools/" 2>/dev/null
(cd "$T/repo" && git add -A && git -c user.name=test -c user.email=test@example.invalid -c core.hooksPath=/dev/null commit -q -m scratch \
    && git remote add origin "$T/remote.git" && git push -q origin main) >/dev/null 2>&1 || { echo "FAIL  the scratch repository"; exit 1; }
head0=$(git -C "$T/repo" rev-parse HEAD)

echo "-- the gate alone"
fresh
(cd "$T/repo" && ARCH=arm64 PATH="$SAFE_PATH" sh tools/release-gate.sh) > "$LOG/out" 2>&1
check "1. all four pass: the gate passes" $? 0
check "1. in order, each as x86-64 (ARCH=arm64 set outside)" "$(tr '\n' ',' < "$LOG/gate-make")" \
    "ARCH=amd64 test,ARCH=amd64 test-player,ARCH=amd64 test-video-player,ARCH=amd64 e2e,"

fresh
(cd "$T/repo" && FAIL_AT=test-player PATH="$SAFE_PATH" sh tools/release-gate.sh) > "$LOG/out" 2>&1
check "2. test-player fails: the gate fails" $? 1
has "2. it names the target" "$LOG/out" "make test-player"
check "2. nothing runs after it" "$(tr '\n' ',' < "$LOG/gate-make")" "ARCH=amd64 test,ARCH=amd64 test-player,"

echo "-- make release (tools/release.sh)"
for at in test test-player test-video-player e2e; do
    fresh
    (cd "$T/repo" && FAIL_AT=$at PATH="$SAFE_PATH" sh tools/release.sh test/test) > "$LOG/out" 2>&1
    rc=$?
    check "3. $at fails as x86-64: make release exits non-zero" "$([ $rc -ne 0 ] && echo nonzero || echo 0)" nonzero
    has "3. $at: it says it refused" "$LOG/out" "release: refused"
    absent "3. $at: gh never called (nothing published)" "$LOG/gh"
    absent "3. $at: nothing built (no make dist)" "$LOG/make"
done
check "3. no commit made" "$(git -C "$T/repo" rev-parse HEAD)" "$head0"
check "3. nothing pushed" "$(git -C "$T/remote.git" rev-parse main)" "$head0"
check "3. the tree is still clean" "$(git -C "$T/repo" status --porcelain)" ""

fresh
(cd "$T/repo" && PATH="$SAFE_PATH" sh tools/release.sh test/test) > "$LOG/out" 2>&1
check "4. the gate passes: the four ran first" "$(tr '\n' ',' < "$LOG/gate-make")" \
    "ARCH=amd64 test,ARCH=amd64 test-player,ARCH=amd64 test-video-player,ARCH=amd64 e2e,"
has "4. then the release goes on (asks gh what is published)" "$LOG/gh" "release view catalog"

[ "$failed" -eq 0 ] && echo "== release gate: all passed" || echo "== release gate: $failed failed"
[ "$failed" -eq 0 ]
