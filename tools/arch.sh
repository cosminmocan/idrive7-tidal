# arch.sh - sourced by the test scripts (T1): which CPU the Docker containers run on.
#   ARCH        arm64 or amd64: from the environment (ARCH=amd64 make test), else this computer's own (`uname -m`;
#               ARCH_HOST_UNAME stands in for it in tests/arch.test.js)
#   PLATFORM    linux/$ARCH, for docker --platform
#   ARCH_SUFFIX the tag suffix of our own test images: "" for amd64 (tidal-player-test:1, as before T1), "-arm64"
#   ARCH_BUILD  where a native folder keeps that architecture's FFmpeg and test binaries: build (amd64, as before
#               T1: also the car's binaries) or build/arm64
# The car's binaries are always x86-64: `make player` and `make video-player` never look at ARCH.
# Exits 2 on anything else.
case "${ARCH:-}" in
    "")
        _arch_host=${ARCH_HOST_UNAME:-$(uname -m)}
        case "$_arch_host" in
            arm64|aarch64) ARCH=arm64 ;;
            x86_64|amd64) ARCH=amd64 ;;
            *) echo "arch.sh: this computer's CPU ($_arch_host) is neither arm64 nor amd64: set ARCH=arm64 or ARCH=amd64" >&2; exit 2 ;;
        esac ;;
    arm64|amd64) ;;
    *) echo "arch.sh: ARCH must be arm64 or amd64, not \"$ARCH\"" >&2; exit 2 ;;
esac
PLATFORM=linux/$ARCH
if [ "$ARCH" = amd64 ]; then ARCH_SUFFIX=; ARCH_BUILD=build; else ARCH_SUFFIX=-$ARCH; ARCH_BUILD=build/$ARCH; fi
export ARCH
