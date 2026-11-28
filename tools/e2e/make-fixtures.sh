#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# make-fixtures.sh <dir> - the end-to-end test's tracks (tests/e2e.test.js), made from generated tones (no recorded
# audio) with the test image's ffmpeg (tidal-player-test, ubuntu:18.04's ffmpeg 3.4), as TIDAL serves HIGH:
# AAC-LC 320 kbit/s, 44.1 kHz stereo, in MP4 with the index (moov) before the audio (-movflags +faststart), not
# fragmented (docs/live-check-results.md). Skips files already made.
#
#   tone<Hz>_<s>s.m4a     a sine of <Hz> for <s> seconds, amplitude 0.5
#   video/<h>/            the video (scenarios 11 to 13), as TIDAL's HLS variants (docs/live-check-results.md
#                         "Video"): FFmpeg's testsrc (colour bars, a moving gradient, a frame counter) at <h>p
#                         (360: 640x360, 720: 1280x720), 25 fps, H.264 Main with B frames, a key frame each second,
#                         and a 523 Hz sine, AAC-LC 44.1 kHz stereo; 12 s cut by ffmpeg's hls muxer into 2 s MPEG-TS
#                         segments: index.m3u8 and seg<i>.ts; whole.ts is the segments one after another (what the
#                         player is given: the reference pictures are decoded from it)
set -eu
out=${1:?usage: make-fixtures.sh <dir>}
mkdir -p "$out"
tone() {
    f="$out/tone$1_$2s.m4a"
    [ -s "$f" ] && return 0
    ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=$1:sample_rate=44100:duration=$2" \
        -af volume=4 -ac 2 -c:a aac -profile:a aac_low -b:a 320k -movflags +faststart -f mp4 "$f.tmp"
    # what the test relies on: AAC-LC, 44.1 kHz, two channels
    ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,profile,sample_rate,channels -of csv=p=0 "$f.tmp" \
        | grep -q '^aac,LC,44100,2$' || { echo "make-fixtures.sh: $f is not AAC-LC 44.1 kHz stereo" >&2; exit 1; }
    mv "$f.tmp" "$f"
}
tone 440 8      # A: a favourite, played whole
tone 660 6      # B
tone 880 6      # C
tone 1000 24    # D: long, for the cuts and the app's watch
tone 550 10     # E: pause and resume
tone 770 190    # F: long, for a seek to 3 minutes
video() {
    d="$out/video/$1"
    [ -s "$d/whole.ts" ] && return 0
    rm -rf "$d" && mkdir -p "$d"
    ffmpeg -nostdin -hide_banner -loglevel error -y -f lavfi -i "testsrc=size=$2:rate=25:duration=12" \
        -f lavfi -i "sine=frequency=523:sample_rate=44100:duration=12" -map 0:v -map 1:a \
        -c:v libx264 -profile:v main -preset veryfast -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 -pix_fmt yuv420p \
        -af volume=4 -ac 2 -c:a aac -b:a 128k \
        -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type vod -hls_segment_filename "$d/seg%d.ts" "$d/index.m3u8"
    # shellcheck disable=SC2046
    cat $(grep '\.ts$' "$d/index.m3u8" | sed "s|^|$d/|") > "$d/whole.tmp"
    streams=$(ffprobe -v error -show_entries stream=codec_name,width,height,sample_rate,channels -of csv=p=0 "$d/whole.tmp")
    { echo "$streams" | grep -qx "h264,$(echo "$2" | tr x ,)" && echo "$streams" | grep -qx 'aac,44100,2'; } \
        || { echo "make-fixtures.sh: $d is not H.264 $2 + AAC 44.1 kHz stereo" >&2; exit 1; }
    mv "$d/whole.tmp" "$d/whole.ts"
}
video 360 640x360
video 720 1280x720
ls -l "$out" "$out"/video/*
