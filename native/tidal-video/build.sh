#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# build.sh target|asan|ffmpeg|image - builds tidal-video in ubuntu:18.04 linux/amd64 (glibc 2.27, as the head unit).
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
# FFmpeg's build is cached in build/ffmpeg (rebuilt only when FF_FLAGS_ID below changes). Needs Docker and curl; the
# FFmpeg archive is taken from native/tidal-player/build when it is there.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
what=${1:-target}
work="$here/build"
mkdir -p "$work"

BUILD_IMAGE=tidal-video-build:1
TEST_IMAGE=tidal-video-test:1
ff_rev=b1a4534186ca51b0457579fc05a5739eb2cc45cd     # n6.1.2, as tidal-player, tvh-player, emby-player
ff_sha256=ba1ecdb61b542ac3a1285c5cf3543b7f76d77c1f513070d6a4c7b3c977a77f18
FF_FLAGS_ID=video-1    # change when the configure line changes: FFmpeg is rebuilt

image() {
    docker build -q --platform linux/amd64 --target build -t "$BUILD_IMAGE" "$here" >/dev/null
    docker build -q --platform linux/amd64 --target test -t "$TEST_IMAGE" "$here" >/dev/null
}

case "$what" in
    image) image; exit 0 ;;
    target|asan|ffmpeg) ;;
    *) echo "usage: $0 target|asan|ffmpeg|image" >&2; exit 2 ;;
esac

docker image inspect "$BUILD_IMAGE" >/dev/null 2>&1 || image
tarball="$work/ffmpeg-$ff_rev.tar.gz"
if [ ! -f "$tarball" ] && [ -f "$here/../tidal-player/build/ffmpeg-$ff_rev.tar.gz" ]; then
    cp "$here/../tidal-player/build/ffmpeg-$ff_rev.tar.gz" "$tarball"
fi
if [ ! -f "$tarball" ]; then
    curl -fsSL -o "$tarball.part" "https://github.com/FFmpeg/FFmpeg/archive/$ff_rev.tar.gz"
    mv "$tarball.part" "$tarball"
fi

# only this folder is mounted: the build needs nothing outside it
docker run --rm --platform linux/amd64 -v "$here:/n/tidal-video" -w /n/tidal-video \
    -e WHAT="$what" -e FF_REV="$ff_rev" -e FF_SHA256="$ff_sha256" -e FF_FLAGS_ID="$FF_FLAGS_ID" \
    -e OWNER="$(id -u):$(id -g)" "$BUILD_IMAGE" sh -c '
    set -e
    trap "chown -R $OWNER build" EXIT
    if [ ! -f build/ffmpeg/lib/libavformat.a ] || [ "$(cat build/ffmpeg/.flags 2>/dev/null)" != "$FF_FLAGS_ID" ]; then
        echo "$FF_SHA256  build/ffmpeg-$FF_REV.tar.gz" | sha256sum -c --quiet - \
            || { echo "build.sh: the FFmpeg archive is not the pinned one" >&2; exit 1; }
        rm -rf build/ffmpeg-bld build/ffmpeg
        mkdir -p build/ffmpeg-bld
        tar xzf "build/ffmpeg-$FF_REV.tar.gz" -C build/ffmpeg-bld --strip-components 1
        echo "build.sh: building FFmpeg (slow under emulation; cached in build/ffmpeg)"
        (cd build/ffmpeg-bld && ./configure --prefix=/n/tidal-video/build/ffmpeg \
            --disable-everything --disable-programs --disable-doc --disable-avdevice --disable-avfilter \
            --disable-swscale --disable-postproc --disable-network --disable-autodetect \
            --disable-iconv --enable-avformat --enable-avcodec --enable-swresample \
            --enable-demuxer=mpegts --enable-parser=h264 --enable-parser=aac \
            --enable-decoder=h264 --enable-decoder=aac \
            --enable-static --disable-shared --enable-pic >/dev/null \
            && grep -q "^#define HAVE_X86ASM 1" config.h && grep -q "^#define HAVE_PTHREADS 1" config.h \
            && make -s -j"$(nproc)" >/dev/null 2>&1 && make -s install >/dev/null)
        cp build/ffmpeg-bld/COPYING.LGPLv2.1 build/FFMPEG-LICENSE
        rm -rf build/ffmpeg-bld
        echo "$FF_FLAGS_ID" > build/ffmpeg/.flags
    fi
    [ "$WHAT" = ffmpeg ] || make -s -f build.mk "$WHAT" FFMPEG=/n/tidal-video/build/ffmpeg OUT=build/out
'
case "$what" in
    target) ls -l "$work/out/tidal-video" ;;
    asan) ls -l "$work/out/tidal-video-asan" ;;
esac
