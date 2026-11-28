#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# build.sh target|asan|image - builds tidal-player in ubuntu:18.04 linux/amd64 (glibc 2.27, as the head unit), or,
# with ARCH=arm64, natively on an Apple-silicon Mac for the tests (task T1; never for the car).
# Adapted from aurelmarius/bmw-apps native/tvh-player/build.sh (0976d16): FFmpeg n6.1.2 at the same pinned commit,
# configured with only what TIDAL's tracks need: the flac, mov and aac demuxers, the flac and aac parsers and
# decoders, and libswresample (the player always plays 48 kHz stereo S16). FFmpeg is linked statically, as are
# libstdc++ and libgcc; libasound is opened at run time.
#
#   target  build/out/tidal-player       stripped, for the unit (check it with `make check-target`)
#   asan    build/out/tidal-player-asan  -O1 -g, AddressSanitizer + UndefinedBehaviorSanitizer, for the tests
#   image   the Docker images tidal-player-build:1 and tidal-player-test:1 (Dockerfile)
#
# ARCH (amd64 when unset; tools/arch.sh): amd64 is the above, as before T1. ARCH=arm64 builds the same two binaries
# for arm64 into build/arm64/out (FFmpeg in build/arm64/ffmpeg) with the images tidal-player-build:1-arm64 and
# tidal-player-test:1-arm64: the same code and FFmpeg configuration, only for the tests on the Mac.
#
# FFmpeg's build is cached in build/ffmpeg (rebuilt only when FF_FLAGS_ID below changes). Needs Docker and curl.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
what=${1:-target}
ARCH=${ARCH:-amd64}
. "$here/../../tools/arch.sh"
dl="$here/build"           # the FFmpeg archive, shared by both architectures
B=$ARCH_BUILD              # build (amd64) or build/arm64, relative to $here
work="$here/$B"
mkdir -p "$dl" "$work"

BUILD_IMAGE=tidal-player-build:1$ARCH_SUFFIX
TEST_IMAGE=tidal-player-test:1$ARCH_SUFFIX
ff_rev=b1a4534186ca51b0457579fc05a5739eb2cc45cd     # n6.1.2, as tvh-player, emby-player
ff_sha256=ba1ecdb61b542ac3a1285c5cf3543b7f76d77c1f513070d6a4c7b3c977a77f18
FF_FLAGS_ID=music-1    # change when the configure line changes: FFmpeg is rebuilt

image() {
    docker build -q --platform "$PLATFORM" --target build -t "$BUILD_IMAGE" "$here" >/dev/null
    docker build -q --platform "$PLATFORM" --target test -t "$TEST_IMAGE" "$here" >/dev/null
}

case "$what" in
    image) image; exit 0 ;;
    target|asan) ;;
    *) echo "usage: $0 target|asan|image" >&2; exit 2 ;;
esac

docker image inspect "$BUILD_IMAGE" >/dev/null 2>&1 || image
tarball="$dl/ffmpeg-$ff_rev.tar.gz"
if [ ! -f "$tarball" ]; then
    curl -fsSL -o "$tarball.part" "https://github.com/FFmpeg/FFmpeg/archive/$ff_rev.tar.gz"
    mv "$tarball.part" "$tarball"
fi

# only this folder is mounted: the build needs nothing outside it
docker run --rm --platform "$PLATFORM" -v "$here:/n/tidal-player" -w /n/tidal-player -e B="$B" \
    -e WHAT="$what" -e FF_REV="$ff_rev" -e FF_SHA256="$ff_sha256" -e FF_FLAGS_ID="$FF_FLAGS_ID" \
    -e OWNER="$(id -u):$(id -g)" "$BUILD_IMAGE" sh -c '
    set -e
    trap "chown -R $OWNER build" EXIT
    if [ ! -f $B/ffmpeg/lib/libavformat.a ] || [ "$(cat $B/ffmpeg/.flags 2>/dev/null)" != "$FF_FLAGS_ID" ]; then
        echo "$FF_SHA256  build/ffmpeg-$FF_REV.tar.gz" | sha256sum -c --quiet - \
            || { echo "build.sh: the FFmpeg archive is not the pinned one" >&2; exit 1; }
        rm -rf $B/ffmpeg-bld $B/ffmpeg
        mkdir -p $B/ffmpeg-bld
        tar xzf "build/ffmpeg-$FF_REV.tar.gz" -C $B/ffmpeg-bld --strip-components 1
        echo "build.sh: building FFmpeg for $(uname -m) (slow under emulation; cached in $B/ffmpeg)"
        (cd $B/ffmpeg-bld && ./configure --prefix=/n/tidal-player/$B/ffmpeg \
            --disable-everything --disable-programs --disable-doc --disable-avdevice --disable-avfilter \
            --disable-swscale --disable-postproc --disable-network --disable-x86asm --disable-autodetect \
            --disable-iconv --enable-avformat --enable-avcodec --enable-swresample \
            --enable-demuxer=flac --enable-demuxer=mov --enable-demuxer=aac \
            --enable-parser=flac --enable-parser=aac --enable-decoder=flac --enable-decoder=aac \
            --enable-static --disable-shared --enable-pic >/dev/null \
            && make -s -j"$(nproc)" >/dev/null 2>&1 && make -s install >/dev/null)
        cp $B/ffmpeg-bld/COPYING.LGPLv2.1 $B/FFMPEG-LICENSE
        rm -rf $B/ffmpeg-bld
        echo "$FF_FLAGS_ID" > $B/ffmpeg/.flags
    fi
    make -s -f build.mk "$WHAT" FFMPEG=/n/tidal-player/$B/ffmpeg OUT=$B/out
'
ls -l "$work/out/tidal-player$( [ "$what" = asan ] && echo -asan || true)"
