#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# check-target.sh [binary] - can the head unit run the player? (task B1; as mgu-render's check-target)
#   an x86-64 ELF; loader /lib/ld-linux-x86-64.so.2 (the unit has no /lib64); no glibc symbol newer than 2.27;
#   shared libraries only libc, libm, libdl, libpthread, librt (libasound is opened with dlopen, never linked);
#   and it starts in ubuntu:18.04 with the loader only there, printing its version.
# The tools run in the build image (readelf and objdump are not on the Mac).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${1:-build/out/tidal-player}
IMAGE=${TIDAL_PLAYER_BUILD_IMAGE:-tidal-player-build:1}
[ -f "$here/$bin" ] || { echo "check-target: FAIL $bin does not exist (make target)" >&2; exit 1; }
docker run --rm --platform linux/amd64 -v "$here:/w:ro" -w /w "$IMAGE" sh -c '
    bin=$1; fail=0
    bad() { echo "check-target: FAIL $*"; fail=1; }
    good() { echo "check-target: ok   $*"; }
    f=$(file -b "$bin")
    case "$f" in *"ELF 64-bit LSB"*"x86-64"*) good "x86-64 ELF";; *) bad "not an x86-64 ELF: $f";; esac
    interp=$(readelf -l "$bin" | sed -n "s/.*Requesting program interpreter: \(.*\)]/\1/p")
    if [ "$interp" = /lib/ld-linux-x86-64.so.2 ]; then good "loader $interp"; else bad "loader is \"$interp\", not /lib/ld-linux-x86-64.so.2"; fi
    newest=$(objdump -T "$bin" | grep -o "GLIBC_[0-9.]*" | sed "s/GLIBC_//" | sort -uV | tail -1)
    if [ -z "$newest" ]; then bad "no glibc symbol versions found"
    elif [ "$(printf "%s\n2.27\n" "$newest" | sort -V | tail -1)" = 2.27 ]; then good "newest glibc symbol GLIBC_$newest"
    else bad "needs GLIBC_$newest (newer than 2.27):"; objdump -T "$bin" | grep "GLIBC_$newest" | sed "s/^/      /"; fi
    other=$(objdump -T "$bin" | grep -o "\(GLIBCXX\|CXXABI\|GCC\)_[0-9.]*" | sort -u | tr "\n" " ")
    if [ -z "$other" ]; then good "no libstdc++ or libgcc symbol versions"; else bad "needs $other"; fi
    needed=$(readelf -d "$bin" | sed -n "s/.*(NEEDED).*\[\(.*\)\]/\1/p")
    # ld-linux-x86-64.so.2 is the loader itself (__tls_get_addr), always there
    for l in $needed; do
        case "$l" in ld-linux-x86-64.so.2|libc.so.6|libm.so.6|libdl.so.2|libpthread.so.0|librt.so.1) ;; *) bad "needs $l (the unit may not have it)";; esac
    done
    good "shared libraries: $(echo $needed)"
    if grep -q "libasound.so.2" "$bin"; then good "libasound.so.2 is opened at run time"; else bad "no libasound.so.2 to dlopen"; fi
    echo "check-target: size $(wc -c < "$bin") bytes"
    # the unit has the loader at /lib/ld-linux-x86-64.so.2 only
    ln -sf /lib/x86_64-linux-gnu/ld-2.27.so /lib/ld-linux-x86-64.so.2 && rm -f /lib64/ld-linux-x86-64.so.2   # from here on, only builtins and the player
    out=$("$bin" --version 2>&1) || true
    case "$out" in "tidal-player "[0-9]*) good "starts on glibc 2.27: $out";; *) bad "does not start on glibc 2.27: $out";; esac
    case "$out" in *"decoders: flac aac"*) good "FFmpeg inside, with the flac and aac decoders";; *) bad "the flac and aac decoders are not in it";; esac
    if [ $fail -eq 0 ]; then echo "check-target: passed"; else echo "check-target: FAILED"; exit 1; fi
' check-target "$bin"
