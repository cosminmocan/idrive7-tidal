#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# build.sh target|asan|ffmpeg|image - builds tidal-video in ubuntu:18.04 linux/amd64 (glibc 2.27, as the head unit),
# or, with ARCH=arm64, natively on an Apple-silicon Mac for the tests (task T1; never for the car).
# As native/tidal-player/build.sh (from aurelmarius/bmw-apps native/tvh-player/build.sh, 0976d16): FFmpeg n6.1.2 at
# the same pinned commit, configured with only what TIDAL's videos need: the mpegts demuxer, the h264 and aac
# parsers, the h264 decoder (software: the tests, and the car when its Intel Media SDK fails) and the aac decoder,
# and libswresample (the sound is always 48 kHz stereo S16). Unlike tidal-player, FFmpeg's x86 SIMD is in (nasm):
# the software H.264 decoder is several times faster with it. FFmpeg, libstdc++ and libgcc are linked statically;
# libasound, libmfxhw64, libva and libva-drm are opened at run time.
#
#   target  build/out/tidal-video       stripped, for the unit (check it with `make check-target`)
#   asan    build/out/tidal-video-asan  -O1 -g, AddressSanitizer + UndefinedBehaviorSanitizer, for the tests
#   ffmpeg  only FFmpeg (build/ffmpeg)
#   image   the Docker images tidal-video-build:1 and tidal-video-test:1 (Dockerfile)
#
# ARCH (amd64 when unset; tools/arch.sh): amd64 is the above, as before T1. ARCH=arm64 builds the same binaries for
# arm64 into build/arm64/out (FFmpeg in build/arm64/ffmpeg, with its NEON routines in place of the x86 ones) with the
# images tidal-video-build:1-arm64 and tidal-video-test:1-arm64, only for the tests on the Mac. The Intel Media SDK
# exists only on x86-64 (and only in the car): an arm64 build looks for it all the same, finds none and decodes in
# software, as the x86-64 one does everywhere but in the car.
#
# FFmpeg's build is cached in build/ffmpeg (rebuilt only when FF_FLAGS_ID below changes). Needs Docker and curl; the
# FFmpeg archive is taken from native/tidal-player/build when it is there.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
what=${1:-target}
ARCH=${ARCH:-amd64}
. "$here/../../tools/arch.sh"
dl="$here/build"           # the FFmpeg archive, shared by both architectures
B=$ARCH_BUILD              # build (amd64) or build/arm64, relative to $here
work="$here/$B"
mkdir -p "$dl" "$work"
# the SIMD routines FFmpeg must have found (configure falls back to none without saying so)
if [ "$ARCH" = amd64 ]; then SIMD=X86ASM; else SIMD=NEON; fi

BUILD_IMAGE=tidal-video-build:1$ARCH_SUFFIX
TEST_IMAGE=tidal-video-test:1$ARCH_SUFFIX
ff_rev=b1a4534186ca51b0457579fc05a5739eb2cc45cd     # n6.1.2, as tidal-player, tvh-player, emby-player
ff_sha256=ba1ecdb61b542ac3a1285c5cf3543b7f76d77c1f513070d6a4c7b3c977a77f18
FF_FLAGS_ID=video-1    # change when the configure line changes: FFmpeg is rebuilt

image() {
    docker build -q --platform "$PLATFORM" --target build -t "$BUILD_IMAGE" "$here" >/dev/null
    docker build -q --platform "$PLATFORM" --target test -t "$TEST_IMAGE" "$here" >/dev/null
}

case "$what" in
    image) image; exit 0 ;;
    target|asan|ffmpeg) ;;
    *) echo "usage: $0 target|asan|ffmpeg|image" >&2; exit 2 ;;
esac

docker image inspect "$BUILD_IMAGE" >/dev/null 2>&1 || image
tarball="$dl/ffmpeg-$ff_rev.tar.gz"
if [ ! -f "$tarball" ] && [ -f "$here/../tidal-player/build/ffmpeg-$ff_rev.tar.gz" ]; then
    cp "$here/../tidal-player/build/ffmpeg-$ff_rev.tar.gz" "$tarball"
fi
if [ ! -f "$tarball" ]; then
    curl -fsSL -o "$tarball.part" "https://github.com/FFmpeg/FFmpeg/archive/$ff_rev.tar.gz"
    mv "$tarball.part" "$tarball"
fi

# only this folder is mounted: the build needs nothing outside it
docker run --rm --platform "$PLATFORM" -v "$here:/n/tidal-video" -w /n/tidal-video -e B="$B" -e SIMD="$SIMD" \
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
        (cd $B/ffmpeg-bld && ./configure --prefix=/n/tidal-video/$B/ffmpeg \
            --disable-everything --disable-programs --disable-doc --disable-avdevice --disable-avfilter \
            --disable-swscale --disable-postproc --disable-network --disable-autodetect \
            --disable-iconv --enable-avformat --enable-avcodec --enable-swresample \
            --enable-demuxer=mpegts --enable-parser=h264 --enable-parser=aac \
            --enable-decoder=h264 --enable-decoder=aac \
            --enable-static --disable-shared --enable-pic >/dev/null \
            && grep -q "^#define HAVE_$SIMD 1" config.h && grep -q "^#define HAVE_PTHREADS 1" config.h \
            && make -s -j"$(nproc)" >/dev/null 2>&1 && make -s install >/dev/null)
        cp $B/ffmpeg-bld/COPYING.LGPLv2.1 $B/FFMPEG-LICENSE
        rm -rf $B/ffmpeg-bld
        echo "$FF_FLAGS_ID" > $B/ffmpeg/.flags
    fi
    [ "$WHAT" = ffmpeg ] || make -s -f build.mk "$WHAT" FFMPEG=/n/tidal-video/$B/ffmpeg OUT=$B/out
'
case "$what" in
    target) ls -l "$work/out/tidal-video" ;;
    asan) ls -l "$work/out/tidal-video-asan" ;;
esac
