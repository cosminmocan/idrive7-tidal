# SPDX-License-Identifier: GPL-3.0-or-later
# The compile step, run by build.sh inside ubuntu:18.04 (glibc 2.27). As tidal-player's build.mk (from tvh-player's
# Makefile): FFmpeg static, libstdc++ and libgcc static, the unit's loader. libasound, libmfxhw64 (Intel Media SDK),
# libva and libva-drm are opened at run time (dlopen): the binary links none of them, so it starts on any glibc
# 2.27 machine, and without the Media SDK it decodes in software.
OUT     ?= build/out
FFMPEG  ?= build/ffmpeg
CXX     = g++
VERSION = $(shell cat VERSION)
FFLIBS  = $(FFMPEG)/lib/libavformat.a $(FFMPEG)/lib/libavcodec.a $(FFMPEG)/lib/libswresample.a $(FFMPEG)/lib/libavutil.a
WARN    = -Wall -Wextra -Wno-missing-field-initializers -Wno-unused-parameter
COMMON  = -std=c++14 $(WARN) -DTIDAL_VIDEO_VERSION='"$(VERSION)"' -Isrc -Iabi/include -I$(FFMPEG)/include
SRC     = src/player.cpp src/decoder_msdk.cpp src/nal_reader.cpp src/mgvf.cpp src/msdk_dl.cpp
HDR     = src/decoder_msdk.h src/nal_reader.h src/mgvf.h src/msdk_dl.h
# the head unit's loader, on x86-64 only (an arm64 build is for the tests on the Mac: its own loader, task T1)
ifeq ($(shell uname -m),x86_64)
LOADER  = -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
endif

.PHONY: target asan
target: $(OUT)/tidal-video
asan: $(OUT)/tidal-video-asan

# the head unit's loader is /lib/ld-linux-x86-64.so.2 (no /lib64)
$(OUT)/tidal-video: $(SRC) $(HDR) VERSION $(FFLIBS)
	@mkdir -p $(@D)
	$(CXX) $(COMMON) -O2 -g0 -DNDEBUG -o $@ $(SRC) $(FFLIBS) -Wl,--as-needed -lpthread -ldl -lm \
	    -static-libstdc++ -static-libgcc $(LOADER)
	strip $@

# for the tests: every behaviour also runs under ASan and UBSan; not for the unit
$(OUT)/tidal-video-asan: $(SRC) $(HDR) VERSION $(FFLIBS)
	@mkdir -p $(@D)
	$(CXX) $(COMMON) -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined \
	    -o $@ $(SRC) $(FFLIBS) -lpthread -ldl -lm
