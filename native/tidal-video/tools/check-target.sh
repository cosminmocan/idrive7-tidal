#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# check-target.sh [binary] - can the head unit run the video player? (as native/tidal-player/tools/check-target.sh)
#   an x86-64 ELF; loader /lib/ld-linux-x86-64.so.2 (the unit has no /lib64); no glibc symbol newer than 2.27;
#   shared libraries only libc, libm, libdl, libpthread, librt; libasound.so.2, libmfxhw64.so, libva.so.1 and
#   libva-drm.so.1 opened with dlopen, never linked; every Media SDK and libva function it looks up is one the unit's
#   libraries export (abi/*.symbols: their export lists, from tvh-player); nothing of them imported or exported;
#   and it starts in ubuntu:18.04 with the loader only there, printing its version and decoders.
# The tools run in the build image (readelf and objdump are not on the Mac).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
bin=${1:-build/out/tidal-video}
IMAGE=${TIDAL_VIDEO_BUILD_IMAGE:-tidal-video-build:1}
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
    for l in libasound.so.2 libmfxhw64.so libva.so.1 libva-drm.so.1; do
        if grep -q "$l" "$bin"; then good "$l is opened at run time"; else bad "no $l to dlopen"; fi
    done
    dyn=$(objdump -T "$bin" | grep -E " (MFX|va)[A-Za-z_]+$" || true)
    if [ -z "$dyn" ]; then good "no Media SDK or libva symbol imported or exported"; else bad "Media SDK / libva symbols in the dynamic table:"; echo "$dyn" | sed "s/^/      /"; fi
    # the names msdk_dl.cpp looks up (its kSymbols list) against the unit libraries export lists
    names=$(sed -n "/kSymbols\[\] = {/,/nullptr};/p" src/msdk_dl.cpp | grep -o "\"[A-Za-z_]*\"" | tr -d "\"")
    count=0
    for s in $names; do
        count=$((count + 1))
        case $s in MFX*) list=abi/libmfx.symbols;; vaGetDisplayDRM) list=abi/libva-drm.symbols;; *) list=abi/libva.symbols;; esac
        grep -q "^$s " "$list" || bad "$s is not exported by the unit ($list)"
        grep -q "$s" "$bin" || bad "$s is not looked up by the binary"
    done
    [ "$count" -ge 18 ] && good "the $count Media SDK and libva functions looked up are all in the unit export lists" || bad "only $count names found in src/msdk_dl.cpp"
    echo "check-target: size $(wc -c < "$bin") bytes"
    # the unit has the loader at /lib/ld-linux-x86-64.so.2 only
    ln -sf /lib/x86_64-linux-gnu/ld-2.27.so /lib/ld-linux-x86-64.so.2 && rm -f /lib64/ld-linux-x86-64.so.2   # from here on, only builtins and the player
    out=$("$bin" --version 2>&1) || true
    case "$out" in "tidal-video "[0-9]*) good "starts on glibc 2.27: $out";; *) bad "does not start on glibc 2.27: $out";; esac
    case "$out" in *"decoders: h264 aac"*) good "FFmpeg inside, with the h264 and aac decoders";; *) bad "the h264 and aac decoders are not in it";; esac
    case "$out" in *"msdk not found"*) good "without the Media SDK it says so (and decodes in software)";; *) bad "the Media SDK found in ubuntu:18.04?";; esac
    if [ $fail -eq 0 ]; then echo "check-target: passed"; else echo "check-target: FAILED"; exit 1; fi
' check-target "$bin"
