#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# make-fixtures.sh <dir> - the end-to-end test's tracks (tests/e2e.test.js), made from generated tones (no recorded
# audio) with the test image's ffmpeg (tidal-player-test, ubuntu:18.04's ffmpeg 3.4), as TIDAL serves HIGH:
# AAC-LC 320 kbit/s, 44.1 kHz stereo, in MP4 with the index (moov) before the audio (-movflags +faststart), not
# fragmented (docs/live-check-results.md). Skips files already made.
#
#   tone<Hz>_<s>s.m4a     a sine of <Hz> for <s> seconds, amplitude 0.5
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
ls -l "$out"
