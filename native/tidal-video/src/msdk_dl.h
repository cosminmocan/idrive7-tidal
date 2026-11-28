// SPDX-License-Identifier: GPL-3.0-or-later
/* tidal-video: the head unit's Intel Media SDK (libmfxhw64.so) and libva (libva.so.1, libva-drm.so.1), opened at run
 * time. tvh-player links them (against stubs of the unit's export lists); tidal-video does not, so that the binary
 * starts on any glibc 2.27 machine and decodes in software where they are missing. msdk_dl.cpp defines every MFX* and
 * va* function decoder_msdk.cpp calls, each forwarding to the library's own, found with dlsym when msdk_load() opens
 * the libraries. */
#ifndef TIDAL_VIDEO_MSDK_DL_H
#define TIDAL_VIDEO_MSDK_DL_H

#include <string>

namespace msdk_dl {

/* the libraries, in the order they are opened */
extern const char *const kLibs[3];
/* opens the three libraries and finds every function (once; later calls say the same); false: *why says what failed */
bool load(std::string *why);
/* the functions looked up, for --version and the target check: a null-terminated list */
extern const char *const kSymbols[];

}  // namespace msdk_dl

#endif
