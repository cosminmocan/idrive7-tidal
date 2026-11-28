# SPDX-License-Identifier: GPL-3.0-or-later
# tidal-player: everything runs in Docker (ubuntu:18.04, linux/amd64), see README.md.
#   make target         build/out/tidal-player, the head unit's binary (FFmpeg static, cached in build/)
#   make asan           build/out/tidal-player-asan, the same with ASan + UBSan, for the tests
#   make test-target    target, for the tests on ARCH (unset: amd64, the same as target; arm64: in build/arm64/out)
#   make test-bins      target and asan, for the tests on ARCH (as test-target)
#   make check-target   is build/out/tidal-player one the unit can run (task B1)
#   make image          the build and test images
#   make clean          the player's objects (FFmpeg's build is kept; `make distclean` removes it too)
.PHONY: all target asan test-target test-bins check-target image clean distclean

all: target

# the unit's binary is x86-64 whatever ARCH says (task T1)
target:
	@ARCH=amd64 sh build.sh target

asan:
	@ARCH=amd64 sh build.sh asan

test-target:
	@sh build.sh target

test-bins:
	@sh build.sh target && sh build.sh asan

check-target:
	@sh tools/check-target.sh build/out/tidal-player

image:
	@sh build.sh image

clean:
	rm -rf build/out build/arm64/out

distclean:
	rm -rf build
