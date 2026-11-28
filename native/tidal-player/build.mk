# SPDX-License-Identifier: GPL-3.0-or-later
# The compile step, run by build.sh inside ubuntu:18.04 (glibc 2.27). Adapted from tvh-player's Makefile:
# FFmpeg static, libstdc++ and libgcc static, the unit's loader; libasound is opened at run time (dlopen).
OUT     ?= build/out
FFMPEG  ?= build/ffmpeg
CXX     = g++
VERSION = $(shell cat VERSION)
FFLIBS  = $(FFMPEG)/lib/libavformat.a $(FFMPEG)/lib/libavcodec.a $(FFMPEG)/lib/libswresample.a $(FFMPEG)/lib/libavutil.a
WARN    = -Wall -Wextra -Wno-missing-field-initializers -Wno-unused-parameter
COMMON  = -std=c++14 $(WARN) -DTIDAL_PLAYER_VERSION='"$(VERSION)"' -I$(FFMPEG)/include
SRC     = src/player.cpp
# the head unit's loader, on x86-64 only (an arm64 build is for the tests on the Mac: its own loader, task T1)
ifeq ($(shell uname -m),x86_64)
LOADER  = -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2
endif

.PHONY: target asan
target: $(OUT)/tidal-player
asan: $(OUT)/tidal-player-asan

# the head unit's loader is /lib/ld-linux-x86-64.so.2 (no /lib64)
$(OUT)/tidal-player: $(SRC) VERSION $(FFLIBS)
	@mkdir -p $(@D)
	$(CXX) $(COMMON) -O2 -g0 -DNDEBUG -o $@ $(SRC) $(FFLIBS) -Wl,--as-needed -lpthread -ldl -lm \
	    -static-libstdc++ -static-libgcc $(LOADER)
	strip $@

# for the tests: every behaviour also runs under ASan and UBSan (rule R4); not for the unit
$(OUT)/tidal-player-asan: $(SRC) VERSION $(FFLIBS)
	@mkdir -p $(@D)
	$(CXX) $(COMMON) -O1 -g -fno-omit-frame-pointer -fsanitize=address,undefined -fno-sanitize-recover=undefined \
	    -o $@ $(SRC) $(FFLIBS) -lpthread -ldl -lm
