# SPDX-License-Identifier: GPL-3.0-or-later
# tidal-player: everything runs in Docker (ubuntu:18.04, linux/amd64), see README.md.
#   make target         build/out/tidal-player, the head unit's binary (FFmpeg static, cached in build/)
#   make asan           build/out/tidal-player-asan, the same with ASan + UBSan, for the tests
#   make check-target   is build/out/tidal-player one the unit can run (task B1)
#   make image          the build and test images
#   make clean          the player's objects (FFmpeg's build is kept; `make distclean` removes it too)
.PHONY: all target asan check-target image clean distclean

all: target

target:
	@sh build.sh target

asan:
	@sh build.sh asan

check-target:
	@sh tools/check-target.sh build/out/tidal-player

image:
	@sh build.sh image

clean:
	rm -rf build/out

distclean:
	rm -rf build
