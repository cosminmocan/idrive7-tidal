// SPDX-License-Identifier: GPL-3.0-or-later
/* tidal-player - plays one TIDAL track on the head unit: the track's bytes on stdin, the sound into SmartXbar's
 * CarLife input. Adapted from aurelmarius' tvh-player (bmw-apps native/tvh-player/src/player.cpp, 0976d16).
 */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
}

namespace {

const char *kAlsaLib = "libasound.so.2";

/* --version: what is inside, and whether this unit has libasound (opened at run time, never linked) */
int print_version() {
    std::string dec;
    if (avcodec_find_decoder(AV_CODEC_ID_FLAC)) dec += " flac";
    if (avcodec_find_decoder(AV_CODEC_ID_AAC)) dec += " aac";
    void *h = dlopen(kAlsaLib, RTLD_NOW);
    printf("tidal-player %s (FFmpeg %s, swresample %u; decoders:%s; %s %s)\n", TIDAL_PLAYER_VERSION, av_version_info(),
           swresample_version(), dec.c_str(), kAlsaLib, h ? "found" : "not found");
    if (h) dlclose(h);
    return 0;
}

}  // namespace

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--version")) return print_version();
    return 0;
}
