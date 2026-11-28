// SPDX-License-Identifier: GPL-3.0-or-later
// From JustAnotherPU/moonride (GPL-3.0-or-later), native/mgu-moonlight/src/mgvf.h, commit a834a14, as copied into
// aurelmarius/bmw-apps native/tvh-player/src/mgvf.h (0976d16).
// Modified 2026-11 for tidal-video (GPL-3.0 section 5(a)): the file is made in two steps, create() before the player
// drops root (given to the user it becomes) and size() once the picture's size is known, through the descriptor
// kept open; the header carries the colour matrix, range and layout (word 9, mgu-render PROTOCOL.md "Video").
/* MGVF writer: mgu-render's video frame file (mgu-render PROTOCOL.md, "Video";
 * src/proto.h struct mgu_video_head). A 64-byte header, then nslot frames of
 * w*h*3/2 bytes (I420, or NV12). The writer fills slot (slot + 1) % nslot,
 * then stores slot, then seq + 1 (release), so the renderer never reads a
 * frame being written. The file is 0600 and owned by the user the player runs
 * as (the renderer accepts root, the app's uid or nobody). */
#ifndef YTDEC_MGVF_H
#define YTDEC_MGVF_H

#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#include <string>

namespace ytdec {

struct MgvfHead {
    uint32_t magic, version, w, h, seq, slot, nslot, matrix, full, format, pad[6];
};
static_assert(sizeof(MgvfHead) == 64, "MGVF header is 64 bytes");

const uint32_t kMgvfMagic = 0x4656474du;   /* "MGVF" */
const size_t kMgvfAppLimit = 12u << 20;   /* renderer: w*h*3 bytes per video, 12 MiB per app */
enum { kMgvfI420 = 0, kMgvfNV12 = 1 };

class Mgvf {
public:
    ~Mgvf() { close(); }
    /* Opens (or makes) path, empty, 0600, never through a link. give: the
     * caller is root and the file goes to uid:gid (a file of anybody else
     * there is replaced, not taken over). The descriptor stays open: size()
     * works after the player is no longer root. */
    bool create(const char *path, bool give, uid_t uid, gid_t gid, std::string *err);
    /* The file for w x h frames (even, 16..2048), all slots black, seq 0.
     * matrix 0 BT.601, 1 BT.709; full 0 limited, 1 full range. Again with
     * another size: the file is made anew at that size. */
    bool size(uint32_t w, uint32_t h, int nslot, uint32_t matrix, uint32_t full, uint32_t format, std::string *err);
    /* the next slot (Y plane; I420: U = Y + w*h, V = U + w*h/4) */
    uint8_t *begin();
    void commit();
    void close();
    bool made() const { return fd_ >= 0; }
    bool sized() const { return head_ != nullptr; }
    uint32_t seq() const { return head_ ? head_->seq : 0; }
    uint32_t w() const { return w_; }
    uint32_t h() const { return h_; }
    size_t frame_size() const { return (size_t)w_ * h_ * 3 / 2; }

private:
    void unmap();
    int fd_ = -1;
    MgvfHead *head_ = nullptr;
    size_t len_ = 0;
    uint32_t w_ = 0, h_ = 0;
};

/* w x h NV12 (Y, then UV interleaved; both planes `pitch` bytes a row) to
 * dense I420 at dst. */
void nv12_to_i420(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst);
/* w x h planar 4:2:0 with its own line sizes to dense I420 at dst */
void i420_copy(const uint8_t *y, int ys, const uint8_t *u, int us, const uint8_t *v, int vs, uint32_t w, uint32_t h, uint8_t *dst);

}  // namespace ytdec

#endif
