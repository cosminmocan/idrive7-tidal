#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# make-clips.sh <dir> - the video player tests' input files (tests/video_player.test.js), made from FFmpeg's generated
# test picture (testsrc: colour bars, a scrolling gradient and a frame counter) and a generated tone, with the ffmpeg
# command line of the test image (tidal-video-test, ubuntu:18.04's ffmpeg 3.4 with libx264). Nothing recorded, and
# nothing committed: made in the container on each run (skips files already made).
#
#   clip720.ts         H.264 Main 1280x720 25 fps, a key frame each second, B frames + AAC-LC 44.1 kHz stereo
#                      1 kHz, 4 s, MPEG-TS (as TIDAL's HLS segments)
#   clip720.adts       clip720.ts's sound, copied out (not decoded): the reference player's input
#   clip1080.ts        H.264 High 1920x1080 25 fps + AAC, 2 s
#   audio_only.ts      AAC alone in MPEG-TS, 3 s (no picture stream)
#   audio_only.adts    its sound, copied out
#   mpeg2.ts           MPEG-2 video (not H.264) + AAC, 2 s
#   mpeg2.adts         its sound, copied out
#   seg/               clip720.ts as 1 s HLS segments with their playlist
set -eu
out=${1:?usage: make-clips.sh <dir>}
mkdir -p "$out"
ff() { f=$1; shift; [ -s "$out/$f" ] || { ffmpeg -nostdin -hide_banner -loglevel error -y "$@" "$out/$f.tmp" && mv "$out/$f.tmp" "$out/$f"; }; }
pic() { echo "testsrc=size=$1:rate=25:duration=$2"; }
sine() { echo "sine=frequency=1000:sample_rate=44100:duration=$1"; }
aac="-af volume=4 -ac 2 -c:a aac -b:a 128k"
ff clip720.ts -f lavfi -i "$(pic 1280x720 4)" -f lavfi -i "$(sine 4)" -map 0:v -map 1:a \
    -c:v libx264 -profile:v main -preset veryfast -g 25 -bf 2 -pix_fmt yuv420p $aac -f mpegts
ff clip720.adts -i "$out/clip720.ts" -map 0:a -c copy -f adts
ff clip1080.ts -f lavfi -i "$(pic 1920x1080 2)" -f lavfi -i "$(sine 2)" -map 0:v -map 1:a \
    -c:v libx264 -profile:v high -preset veryfast -g 25 -pix_fmt yuv420p $aac -f mpegts
ff audio_only.ts -f lavfi -i "$(sine 3)" $aac -f mpegts
ff audio_only.adts -i "$out/audio_only.ts" -map 0:a -c copy -f adts
ff mpeg2.ts -f lavfi -i "$(pic 640x360 2)" -f lavfi -i "$(sine 2)" -map 0:v -map 1:a -c:v mpeg2video -q:v 4 $aac -f mpegts
ff mpeg2.adts -i "$out/mpeg2.ts" -map 0:a -c copy -f adts
# clip720.ts cut into 1 s HLS segments (copied, not re-encoded: seg/seg000.ts .. seg003.ts and seg/v.m3u8), the
# shape the service sends: segment after segment
[ -s "$out/seg/v.m3u8" ] || { mkdir -p "$out/seg" && ffmpeg -nostdin -hide_banner -loglevel error -y -i "$out/clip720.ts" -c copy \
    -f hls -hls_time 1 -hls_list_size 0 -hls_segment_filename "$out/seg/seg%03d.ts" "$out/seg/v.m3u8"; }
ls -l "$out" "$out/seg"
