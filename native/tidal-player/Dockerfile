# SPDX-License-Identifier: GPL-3.0-or-later
# Images for tidal-player, both ubuntu:18.04 linux/amd64 (glibc 2.27, as the head unit).
#   build: the compilers (FFmpeg and the player are built in it; build.sh)
#   test:  build + Node (8.10, bionic's), the ffmpeg CLI (makes the tone fixtures) and libasound with its
#          plugins (player_alsa.test.js); `make test-player` runs tests/player_*.test.js in it
FROM ubuntu:18.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends build-essential binutils file \
    && rm -rf /var/lib/apt/lists/*

FROM build AS test
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends nodejs ffmpeg libasound2 libasound2-data \
        alsa-utils procps \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /lib/x86_64-linux-gnu/ld-2.27.so /lib/ld-linux-x86-64.so.2
# (the player asks for the unit's loader path, /lib/ld-linux-x86-64.so.2; ubuntu has it in /lib64)
