#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# make-tones.sh <dir> - the player tests' input files, made from generated tones (no recorded audio), with the
# ffmpeg command line of the test image (tidal-player-test, ubuntu:18.04's ffmpeg 3.4). Skips files already made.
#
#   tone1k_10s.flac            1 kHz, 10 s, stereo, 16-bit 44.1 kHz (TIDAL's LOSSLESS)
#   tone1k_10s.m4a             the same as AAC-LC 320 kbit/s in MP4, index (moov) first (TIDAL's HIGH)
#   tone1k_10s_moovlast.m4a    the same with the index at the end (cannot be read from a pipe)
#   tone1k_5s_frag.m4a         AAC in fragmented MP4
#   tone1k_5s.aac              AAC in ADTS
#   tone440_mono_5s.flac       440 Hz, mono
#   lr_5s.flac                 left 1 kHz, right 1.5 kHz
#   tone1k_5s_48k.flac         1 kHz at 48 kHz (no resampling needed)
#   tone1k_60s.flac            1 kHz, 60 s (pacing, backpressure)
#   tone1k_24s.m4a             1 kHz, 24 s, AAC in MP4, index first (seek: MGU_START_MS)
set -eu
out=${1:?usage: make-tones.sh <dir>}
mkdir -p "$out"
ff() { f=$1; shift; [ -s "$out/$f" ] || ffmpeg -nostdin -hide_banner -loglevel error -y "$@" "$out/$f.tmp" && { [ -s "$out/$f" ] || mv "$out/$f.tmp" "$out/$f"; }; }
sine() { echo "sine=frequency=$1:sample_rate=$2:duration=$3"; }
# amplitude 0.5 (-6 dBFS): sine's default 1/8 is louder after the aac encoder's own scaling anyway
vol=volume=4
ff tone1k_10s.flac -f lavfi -i "$(sine 1000 44100 10)" -af $vol -ac 2 -sample_fmt s16 -c:a flac -f flac
ff tone1k_10s.m4a -f lavfi -i "$(sine 1000 44100 10)" -af $vol -ac 2 -c:a aac -b:a 320k -movflags +faststart -f mp4
ff tone1k_10s_moovlast.m4a -f lavfi -i "$(sine 1000 44100 10)" -af $vol -ac 2 -c:a aac -b:a 320k -f mp4
ff tone1k_5s_frag.m4a -f lavfi -i "$(sine 1000 44100 5)" -af $vol -ac 2 -c:a aac -b:a 320k -movflags frag_keyframe+empty_moov -f mp4
ff tone1k_5s.aac -f lavfi -i "$(sine 1000 44100 5)" -af $vol -ac 2 -c:a aac -b:a 320k -f adts
ff tone440_mono_5s.flac -f lavfi -i "$(sine 440 44100 5)" -af $vol -ac 1 -sample_fmt s16 -c:a flac -f flac
ff lr_5s.flac -f lavfi -i "$(sine 1000 44100 5)" -f lavfi -i "$(sine 1500 44100 5)" \
    -filter_complex "[0:a][1:a]amerge=inputs=2,volume=4[a]" -map "[a]" -sample_fmt s16 -c:a flac -f flac
ff tone1k_5s_48k.flac -f lavfi -i "$(sine 1000 48000 5)" -af $vol -ac 2 -sample_fmt s16 -c:a flac -f flac
ff tone1k_60s.flac -f lavfi -i "$(sine 1000 44100 60)" -af $vol -ac 2 -sample_fmt s16 -c:a flac -f flac
ff tone1k_24s.m4a -f lavfi -i "$(sine 1000 44100 24)" -af $vol -ac 2 -c:a aac -b:a 320k -movflags +faststart -f mp4
ls -l "$out"
