// SPDX-License-Identifier: GPL-3.0-or-later
/* tidal-video: the Intel Media SDK and libva opened at run time (msdk_dl.h). The functions below have the names and
 * prototypes decoder_msdk.cpp calls (abi/include/mfx/mfxvideo.h; libva's from va/va.h and va/va_drm.h as
 * decoder_msdk.cpp declares them); each calls the pointer dlsym found. They are hidden: the binary exports nothing,
 * so the libraries' own calls never land here. Every name is in the unit's export lists (abi/lib*.symbols, checked by
 * tools/check-target.sh). */
#include "msdk_dl.h"

#include <dlfcn.h>

#include <mutex>

#include "mfx/mfxvideo.h"

extern "C" {
typedef void *VADisplay;
typedef int VAStatus;
}

#define HIDDEN __attribute__((visibility("hidden")))

namespace {
struct Fns {
    mfxStatus (*MFXInit)(mfxIMPL, mfxVersion *, mfxSession *);
    mfxStatus (*MFXInitEx)(mfxInitParam, mfxSession *);
    mfxStatus (*MFXClose)(mfxSession);
    mfxStatus (*MFXVideoCORE_SetHandle)(mfxSession, mfxHandleType, mfxHDL);
    mfxStatus (*MFXVideoCORE_SyncOperation)(mfxSession, mfxSyncPoint, mfxU32);
    mfxStatus (*MFXVideoDECODE_DecodeHeader)(mfxSession, mfxBitstream *, mfxVideoParam *);
    mfxStatus (*MFXVideoDECODE_QueryIOSurf)(mfxSession, mfxVideoParam *, mfxFrameAllocRequest *);
    mfxStatus (*MFXVideoDECODE_Init)(mfxSession, mfxVideoParam *);
    mfxStatus (*MFXVideoDECODE_Close)(mfxSession);
    mfxStatus (*MFXVideoDECODE_DecodeFrameAsync)(mfxSession, mfxBitstream *, mfxFrameSurface1 *, mfxFrameSurface1 **, mfxSyncPoint *);
    mfxStatus (*MFXVideoVPP_QueryIOSurf)(mfxSession, mfxVideoParam *, mfxFrameAllocRequest *);
    mfxStatus (*MFXVideoVPP_Init)(mfxSession, mfxVideoParam *);
    mfxStatus (*MFXVideoVPP_Close)(mfxSession);
    mfxStatus (*MFXVideoVPP_RunFrameVPPAsync)(mfxSession, mfxFrameSurface1 *, mfxFrameSurface1 *, mfxExtVppAuxData *, mfxSyncPoint *);
    VADisplay (*vaGetDisplayDRM)(int);
    VAStatus (*vaInitialize)(VADisplay, int *, int *);
    VAStatus (*vaTerminate)(VADisplay);
    const char *(*vaErrorStr)(VAStatus);
} F;
}  // namespace

namespace msdk_dl {

const char *const kLibs[3] = {"libmfxhw64.so", "libva.so.1", "libva-drm.so.1"};
const char *const kSymbols[] = {"MFXInit", "MFXInitEx", "MFXClose", "MFXVideoCORE_SetHandle", "MFXVideoCORE_SyncOperation",
    "MFXVideoDECODE_DecodeHeader", "MFXVideoDECODE_QueryIOSurf", "MFXVideoDECODE_Init", "MFXVideoDECODE_Close",
    "MFXVideoDECODE_DecodeFrameAsync", "MFXVideoVPP_QueryIOSurf", "MFXVideoVPP_Init", "MFXVideoVPP_Close",
    "MFXVideoVPP_RunFrameVPPAsync", "vaGetDisplayDRM", "vaInitialize", "vaTerminate", "vaErrorStr", nullptr};

bool load(std::string *why)
{
    static std::mutex mu;
    static int state = 0;   /* 1 loaded, -1 not */
    static std::string err;
    std::lock_guard<std::mutex> l(mu);
    if (!state) {
        void *h[3] = {nullptr, nullptr, nullptr};
        state = 1;
        for (int i = 0; i < 3 && state > 0; i++) {
            /* the Media SDK first (what is missing on a machine without it); libva global: the SDK finds its VA functions */
            h[i] = dlopen(kLibs[i], RTLD_NOW | (i ? RTLD_GLOBAL : RTLD_LOCAL));
            /* the unit's file is /usr/lib/libmfxhw64-p.so.1.24 (SONAME libmfxhw64.so): if no link of that name */
            if (!h[i] && i == 0) {
                const std::string first = dlerror();
                h[0] = dlopen("/usr/lib/libmfxhw64-p.so.1.24", RTLD_NOW | RTLD_LOCAL);
                if (!h[0]) { err = "dlopen " + first; state = -1; continue; }
            }
            if (!h[i]) {
                const char *e = dlerror();
                err = std::string("dlopen ") + kLibs[i] + ": " + (e ? e : "?");
                state = -1;
            }
        }
        void **slot = (void **)&F;
        for (int i = 0; state > 0 && kSymbols[i]; i++) {
            void *lib = kSymbols[i][0] == 'M' ? h[0] : kSymbols[i][2] == 'G' ? h[2] : h[1];
            slot[i] = dlsym(lib, kSymbols[i]);
            if (!slot[i]) {
                err = std::string("dlsym ") + kSymbols[i] + ": not found";
                state = -1;
            }
        }
        if (state < 0)
            for (int i = 2; i >= 0; i--)
                if (h[i]) dlclose(h[i]);
    }
    if (state < 0) *why = err;
    return state > 0;
}

}  // namespace msdk_dl

static_assert(sizeof(Fns) == 18 * sizeof(void *), "one pointer per name in kSymbols, in its order");

extern "C" {
HIDDEN mfxStatus MFXInit(mfxIMPL impl, mfxVersion *ver, mfxSession *s) { return F.MFXInit(impl, ver, s); }
HIDDEN mfxStatus MFXInitEx(mfxInitParam par, mfxSession *s) { return F.MFXInitEx(par, s); }
HIDDEN mfxStatus MFXClose(mfxSession s) { return F.MFXClose(s); }
HIDDEN mfxStatus MFXVideoCORE_SetHandle(mfxSession s, mfxHandleType t, mfxHDL h) { return F.MFXVideoCORE_SetHandle(s, t, h); }
HIDDEN mfxStatus MFXVideoCORE_SyncOperation(mfxSession s, mfxSyncPoint p, mfxU32 w) { return F.MFXVideoCORE_SyncOperation(s, p, w); }
HIDDEN mfxStatus MFXVideoDECODE_DecodeHeader(mfxSession s, mfxBitstream *b, mfxVideoParam *p) { return F.MFXVideoDECODE_DecodeHeader(s, b, p); }
HIDDEN mfxStatus MFXVideoDECODE_QueryIOSurf(mfxSession s, mfxVideoParam *p, mfxFrameAllocRequest *r) { return F.MFXVideoDECODE_QueryIOSurf(s, p, r); }
HIDDEN mfxStatus MFXVideoDECODE_Init(mfxSession s, mfxVideoParam *p) { return F.MFXVideoDECODE_Init(s, p); }
HIDDEN mfxStatus MFXVideoDECODE_Close(mfxSession s) { return F.MFXVideoDECODE_Close(s); }
HIDDEN mfxStatus MFXVideoDECODE_DecodeFrameAsync(mfxSession s, mfxBitstream *b, mfxFrameSurface1 *w, mfxFrameSurface1 **o, mfxSyncPoint *p)
{
    return F.MFXVideoDECODE_DecodeFrameAsync(s, b, w, o, p);
}
HIDDEN mfxStatus MFXVideoVPP_QueryIOSurf(mfxSession s, mfxVideoParam *p, mfxFrameAllocRequest r[2]) { return F.MFXVideoVPP_QueryIOSurf(s, p, r); }
HIDDEN mfxStatus MFXVideoVPP_Init(mfxSession s, mfxVideoParam *p) { return F.MFXVideoVPP_Init(s, p); }
HIDDEN mfxStatus MFXVideoVPP_Close(mfxSession s) { return F.MFXVideoVPP_Close(s); }
HIDDEN mfxStatus MFXVideoVPP_RunFrameVPPAsync(mfxSession s, mfxFrameSurface1 *i, mfxFrameSurface1 *o, mfxExtVppAuxData *a, mfxSyncPoint *p)
{
    return F.MFXVideoVPP_RunFrameVPPAsync(s, i, o, a, p);
}
HIDDEN VADisplay vaGetDisplayDRM(int fd) { return F.vaGetDisplayDRM(fd); }
HIDDEN VAStatus vaInitialize(VADisplay d, int *ma, int *mi) { return F.vaInitialize(d, ma, mi); }
HIDDEN VAStatus vaTerminate(VADisplay d) { return F.vaTerminate(d); }
HIDDEN const char *vaErrorStr(VAStatus s) { return F.vaErrorStr(s); }
}
