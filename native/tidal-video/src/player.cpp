// SPDX-License-Identifier: GPL-3.0-or-later
/* tidal-video - plays one TIDAL video on the head unit: MPEG-TS on stdin (H.264 + AAC-LC, TIDAL's HLS segments one
 * after another, as the service sends them), the pictures into mgu-render's frame file, the sound as 48 kHz stereo
 * S16 into SmartXbar's CarLife input exactly as tidal-player plays a track. The contract is docs/PROTOCOL.md,
 * section 2, "The video player (`tidal-video`)".
 *
 * The sound path is tidal-player's (native/tidal-player/src/player.cpp, itself adapted from aurelmarius' tvh-player):
 * the queue, the clock, the output thread (ALSA opened at run time, WAV, null), the prebuffer and buffering, the
 * control line on fd 3, the ticks, MGU_START_MS, the root drop, the 2.5 s end, errors and exit codes. The picture
 * path follows tvh-player's video thread (github.com/aurelmarius/bmw-apps native/tvh-player/src/player.cpp, 0976d16,
 * GPL-3.0-or-later): the Intel Media SDK decoder (decoder_msdk.cpp, NAL framing nal_reader.cpp), each picture into
 * the frame file (mgvf.cpp) when the clock reaches it, a late one left out. New here: the Media SDK and libva opened
 * at run time (msdk_dl.cpp) with libavcodec's H.264 decoder as the fallback, the frame file made before the root drop,
 * MGU_BASE_MS.
 *
 *   main thread     stdin -> libavformat's mpegts demuxer -> the sound: libavcodec aac -> stereo float ->
 *                   libswresample 48 kHz S16 -> the sound queue; the picture's packets -> the picture queue
 *   output thread   the sound queue -> the volume -> the sound device (ALSA, a WAV file, or nothing), on the clock
 *   video thread    the picture queue -> the decoder (msdk or sw) -> each picture into the frame file when the clock
 *                   reaches its time; one later than 120 ms is left out (vdropped)
 *   control thread  fd 3, one command a line: pause | resume | volume <0..1> | quit; fd 3 closed is quit
 *   tick thread     every 500 ms after open: MGU {"ev":"tick",...,"vframes":n,"vdropped":n}
 *   the clock       the sound's (tidal-player's): monotonic, starts at the first sound played once MGU_PREBUFFER_MS is
 *                   queued, stands while paused and while buffering. The pictures follow it.
 *
 * Positions: a timestamp t of the stream is at MGU_BASE_MS + (t - the stream's first timestamp). MGU_START_MS is a
 * position: the sound before it is decoded and thrown away (not paced), the pictures before it decoded and not shown
 * (the last one before it is shown when playing starts, as the picture of that moment).
 *
 * MGU_AUDIO          alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | null | wav:<path> (tests)
 * MGU_VIDEO          shm:<name> (default shm:cmocan-tidal): /dev/shm/mgu-video-<name> | null (decoded, not shown)
 * MGU_VIDEO_DECODER  auto (default: msdk when it loads and starts, else sw) | msdk | sw
 * MGU_PREBUFFER_MS   sound queued before playing starts, and again after the input ran dry (default 1500)
 * MGU_START_MS       where playing starts, a position in ms (default 0)
 * MGU_BASE_MS        the position of the first byte on stdin, in ms (default 0)
 * MGU_ALSA_US        the ALSA buffer in us (default 64000)
 * MGU_RUN_AS         the user to become (a name or a number); as root without it the player refuses to run
 * MGU_GROUPS         its groups (default mgu_alsa,audio,video); a group the system does not have is skipped and logged
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <pwd.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/cpu.h>
#include <libavutil/pixdesc.h>
#include <libswresample/swresample.h>
}

#include "decoder_msdk.h"
#include "mgvf.h"
#include "msdk_dl.h"

namespace {

const char *kAlsaLib = "libasound.so.2";
const char *kDefaultAudio = "alsa:plug:smartx:CarLifeMedia_CF_48_STEREO";
const char *kDefaultVideo = "shm:cmocan-tidal";
const char *kRenderNode = "/dev/dri/renderD128";
const int kRate = 48000;   /* the output, always: 48 kHz, stereo, S16 */

/* exit codes (docs/PROTOCOL.md) */
enum { kExitOk = 0, kExitEnv = 2, kExitRoot = 3, kExitInput = 4, kExitDecode = 5, kExitAudio = 6 };

/* ---------- log and events ---------- */
void logf(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    fprintf(stderr, "tidal-video: %s\n", buf);
}

std::mutex g_out_mu;
void event(const std::string &json) {
    std::lock_guard<std::mutex> l(g_out_mu);
    fprintf(stdout, "MGU %s\n", json.c_str());
    fflush(stdout);
}
/* s as the body of a JSON string: ASCII only (what FFmpeg and libc say is ASCII; anything else becomes ?) */
std::string js(const std::string &s) {
    std::string o;
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { o += '\\'; o += (char) c; }
        else if (c < 0x20 || c >= 0x7f) o += c == '\n' || c == '\t' ? ' ' : '?';
        else o += (char) c;
    }
    return o;
}
std::string fmt(const char *f, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, f);
    vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

double mono() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}
void sleep_s(double s) {
    if (s <= 0) return;
    struct timespec ts;
    ts.tv_sec = (time_t) s;
    ts.tv_nsec = (long) ((s - ts.tv_sec) * 1e9);
    nanosleep(&ts, nullptr);
}

std::atomic<bool> g_quit(false);

/* FFmpeg's own messages: errors only, and not more than 50 (a broken picture stream says the same thing all along) */
void av_log_cb(void *, int level, const char *f, va_list ap) {
    static std::atomic<int> n(0);
    if (level > AV_LOG_ERROR) return;
    const int k = ++n;
    if (k > 50) return;
    char buf[512];
    vsnprintf(buf, sizeof buf, f, ap);
    size_t len = strlen(buf);
    while (len && (buf[len - 1] == '\n' || buf[len - 1] == '\r')) buf[--len] = 0;
    fprintf(stderr, "tidal-video: ffmpeg: %s%s\n", buf, k == 50 ? " (no more FFmpeg messages)" : "");
}

/* ---------- the clock (tidal-player's): positions in seconds; stands before the start and while paused ---------- */
class Clock {
public:
    double now() {
        std::lock_guard<std::mutex> l(mu_);
        return running_locked() ? base_ + (mono() - t0_) : base_;
    }
    bool started() { std::lock_guard<std::mutex> l(mu_); return started_; }
    bool paused() { std::lock_guard<std::mutex> l(mu_); return paused_; }
    bool stalled() { std::lock_guard<std::mutex> l(mu_); return stalled_; }
    /* where playing starts (the first sound played): before start() */
    void set_origin(double s) { std::lock_guard<std::mutex> l(mu_); if (!started_) base_ = s; }
    void start() {
        std::lock_guard<std::mutex> l(mu_);
        if (started_) return;
        started_ = true;
        t0_ = mono();
    }
    void set_paused(bool p) { set(&paused_, p); }
    void set_stalled(bool s) { set(&stalled_, s); }

private:
    bool running_locked() const { return started_ && !paused_ && !stalled_; }
    void set(bool *flag, bool v) {
        std::lock_guard<std::mutex> l(mu_);
        if (*flag == v) return;
        if (running_locked()) base_ += mono() - t0_;   /* freeze where it is */
        *flag = v;
        if (running_locked()) t0_ = mono();
    }
    std::mutex mu_;
    bool started_ = false, paused_ = false, stalled_ = false;
    double base_ = 0, t0_ = 0;
};
Clock g_clock;
double g_pre = 1.5;   /* MGU_PREBUFFER_MS */
const long long kMaxMs = 24LL * 3600 * 1000;   /* MGU_START_MS and MGU_BASE_MS are capped here */
double g_base = 0;    /* MGU_BASE_MS, seconds: the position of the first byte */
double g_start = 0;   /* MGU_START_MS (never before the base), seconds: where playing starts */
/* the stream's first timestamp (seconds), set by the demuxer before any packet is queued */
double g_t0 = NAN;
double position(double ts) { return g_base + (ts - g_t0); }
/* the sound's frame (at 48 kHz, counted from position 0) the clock starts at: the first one played */
std::atomic<unsigned long long> g_origin_frames(0);

/* FFmpeg picks its SIMD routines when a decoder or resampler opens. The sound's are opened with the plain C ones,
 * exactly as tidal-player's FFmpeg (built without x86 assembly) has them, so the sound is sample for sample
 * tidal-player's; the picture's decoder gets the SIMD ones. This lock keeps the two from overlapping. */
std::mutex g_cpu_mu;

/* the one error the player ends with: the first one set wins */
std::mutex g_err_mu;
bool g_failed = false;
std::string g_err_code, g_err_msg;
int g_err_exit = 0;
void fail(const char *code, int exit_code, const std::string &msg) {
    std::lock_guard<std::mutex> l(g_err_mu);
    if (g_failed) return;
    g_failed = true;
    g_err_code = code; g_err_msg = msg; g_err_exit = exit_code;
    logf("error %s: %s", code, msg.c_str());
}
bool failed() { std::lock_guard<std::mutex> l(g_err_mu); return g_failed; }

/* ---------- the input: stdin, read once, never seeked (MPEG-TS needs no seeking back) ---------- */
class Input {
public:
    int read(uint8_t *dst, int size) {
        if (eof_) return AVERROR_EOF;
        for (;;) {
            if (g_quit) return AVERROR_EOF;
            struct pollfd p = {0, POLLIN, 0};
            const int pr = poll(&p, 1, 200);
            if (pr < 0 && errno != EINTR) { eof_ = true; return AVERROR_EOF; }
            if (pr <= 0) continue;
            const ssize_t r = ::read(0, dst, (size_t) size);
            if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (r <= 0) {
                eof_ = true;
                logf("input: ended after %lld bytes", (long long) total_);
                return AVERROR_EOF;
            }
            if (head_n_ < sizeof head_) {
                const size_t k = std::min(sizeof head_ - head_n_, (size_t) r);
                memcpy(head_ + head_n_, dst, k);
                head_n_ += k;
            }
            total_ += r;
            return (int) r;
        }
    }
    int64_t total() const { return total_; }
    bool eof() const { return eof_; }
    /* the first bytes: MPEG-TS packets (a sync byte every 188 bytes), so a failure is a cut-off input, not a wrong one */
    bool looks_like_ts() const {
        if (head_n_ < 1 || head_[0] != 0x47) return false;
        for (size_t at = 188; at < head_n_; at += 188) if (head_[at] != 0x47) return false;
        return head_n_ >= 189;
    }

private:
    int64_t total_ = 0;
    bool eof_ = false;
    uint8_t head_[188 * 3 + 1];
    size_t head_n_ = 0;
};
Input g_in;
int read_cb(void *, uint8_t *buf, int size) { return g_in.read(buf, size); }

/* ---------- the sound queue: decoded sound, 48 kHz stereo S16 (tidal-player's) ---------- */
class PcmQueue {
public:
    explicit PcmQueue(size_t frames) : cap_(frames), ring_(frames * 2) {}
    /* waits for room; false: quit */
    bool push(const int16_t *s, size_t n) {
        while (n > 0) {
            std::unique_lock<std::mutex> l(mu_);
            if (!cv_.wait_for(l, std::chrono::milliseconds(100), [&] { return len_ < cap_ || g_quit.load(); })) continue;
            if (g_quit) return false;
            const size_t k = std::min(n, cap_ - len_);
            for (size_t i = 0; i < k; i++) {
                const size_t at = ((head_ + len_ + i) % cap_) * 2;
                ring_[at] = s[2 * i]; ring_[at + 1] = s[2 * i + 1];
            }
            len_ += k; s += 2 * k; n -= k;
            l.unlock();
            cv_.notify_all();
        }
        return true;
    }
    /* up to max frames into dst, waiting at most wait_s for any; the number taken */
    size_t pop(int16_t *dst, size_t max, double wait_s) {
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::microseconds((long long) (wait_s * 1e6)), [&] { return len_ > 0 || eof_ || g_quit.load(); });
        const size_t k = std::min(max, len_);
        for (size_t i = 0; i < k; i++) {
            const size_t at = ((head_ + i) % cap_) * 2;
            dst[2 * i] = ring_[at]; dst[2 * i + 1] = ring_[at + 1];
        }
        head_ = (head_ + k) % cap_;
        len_ -= k;
        l.unlock();
        if (k) cv_.notify_all();
        return k;
    }
    void end() { { std::lock_guard<std::mutex> l(mu_); eof_ = true; } cv_.notify_all(); }
    void wake() { cv_.notify_all(); }
    bool drained() { std::lock_guard<std::mutex> l(mu_); return eof_ && len_ == 0; }
    bool eof() { std::lock_guard<std::mutex> l(mu_); return eof_; }
    size_t frames() { std::lock_guard<std::mutex> l(mu_); return len_; }

private:
    std::mutex mu_;
    std::condition_variable cv_;
    size_t cap_, head_ = 0, len_ = 0;
    std::vector<int16_t> ring_;
    bool eof_ = false;
};
const double kQueueS = 6.0;   /* decoded ahead at most; then the demuxer waits, and so does the sender (the pipe) */
PcmQueue g_q((size_t) (kQueueS * kRate));

/* ---------- the picture queue: H.264 packets with their positions ---------- */
std::atomic<unsigned long long> g_vframes(0);    /* pictures shown */
std::atomic<unsigned long long> g_vdropped(0);   /* pictures left out: late, or the queue was full */

class PacketQueue {
public:
    /* takes pkt (freed when dropped). Never waits: a picture decoder that cannot keep up must not hold up the sound.
     * Past kMaxSpan or kMaxBytes the packet is dropped, and so is every one up to the next key frame */
    void push(AVPacket *pkt, double pos) {
        std::unique_lock<std::mutex> l(mu_);
        const bool key = (pkt->flags & AV_PKT_FLAG_KEY) != 0;
        if (need_key_ && !key) { drop(pkt); return; }
        need_key_ = false;
        const double span = q_.empty() || isnan(pos) || isnan(q_.front().pos) ? 0 : pos - q_.front().pos;
        if (bytes_ > kMaxBytes || span > kMaxSpan) {
            if (!full_logged_) { logf("video: the picture decoder is %.1f s behind: pictures left out to the next key frame", span); full_logged_ = true; }
            need_key_ = true;
            drop(pkt);
            return;
        }
        q_.push_back(Item{pkt, pos});
        bytes_ += (size_t) pkt->size;
        l.unlock();
        cv_.notify_all();
    }
    /* the next packet; false at the end (or quit) */
    bool pop(AVPacket **pkt, double *pos) {
        std::unique_lock<std::mutex> l(mu_);
        for (;;) {
            if (g_quit) return false;
            if (!q_.empty()) break;
            if (eof_) return false;
            cv_.wait_for(l, std::chrono::milliseconds(100));
        }
        *pkt = q_.front().pkt; *pos = q_.front().pos;
        bytes_ -= (size_t) (*pkt)->size;
        q_.pop_front();
        return true;
    }
    /* what is queued is not needed (a key frame before the start position came) */
    void clear() {
        std::lock_guard<std::mutex> l(mu_);
        for (auto &it : q_) av_packet_free(&it.pkt);
        q_.clear();
        bytes_ = 0;
    }
    void end() { { std::lock_guard<std::mutex> l(mu_); eof_ = true; } cv_.notify_all(); }
    ~PacketQueue() { clear(); }

private:
    struct Item { AVPacket *pkt; double pos; };
    void drop(AVPacket *pkt) { av_packet_free(&pkt); g_vdropped++; }
    static constexpr double kMaxSpan = 12.0;
    static const size_t kMaxBytes = 64u << 20;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<Item> q_;
    size_t bytes_ = 0;
    bool eof_ = false, need_key_ = false, full_logged_ = false;
};
PacketQueue g_vq;

/* ---------- the sound device (tidal-player's) ---------- */
enum Kind { NUL, WAV, ALSA };
struct Target { Kind kind = NUL; std::string where; };
bool parse_audio(const char *e, Target *t) {
    const std::string s = e && *e ? e : kDefaultAudio;
    if (s == "null") { t->kind = NUL; t->where = "null"; return true; }
    if (!s.compare(0, 4, "wav:") && s.size() > 4) { t->kind = WAV; t->where = s.substr(4); return true; }
    if (!s.compare(0, 5, "alsa:") && s.size() > 5) { t->kind = ALSA; t->where = s.substr(5); return true; }
    return false;
}
Target g_target;

/* libasound, opened at run time (tvh-player, mgu_audio.cpp): the unit has it, the binary does not link it */
typedef struct snd_pcm snd_pcm_t;
struct Alsa {
    int (*open)(snd_pcm_t **, const char *, int, int);
    int (*set_params)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned);
    long (*writei)(snd_pcm_t *, const void *, unsigned long);
    int (*recover)(snd_pcm_t *, int, int);
    int (*delay)(snd_pcm_t *, long *);
    int (*close)(snd_pcm_t *);
    const char *(*strerror)(int);
} A;
const int kPlayback = 0, kS16LE = 2, kRwInterleaved = 3, kNonblock = 1;
bool alsa_load(std::string *err) {
    static int loaded = 0;   /* 1 yes, -1 no */
    static std::string why;
    if (!loaded) {
        void *h = dlopen(kAlsaLib, RTLD_NOW);
        if (!h) { why = std::string("dlopen ") + kAlsaLib + ": " + dlerror(); loaded = -1; }
        else {
#define SYM(f, n) (*(void **) &A.f = dlsym(h, n))
            const bool ok = SYM(open, "snd_pcm_open") && SYM(set_params, "snd_pcm_set_params") && SYM(writei, "snd_pcm_writei") &&
                            SYM(recover, "snd_pcm_recover") && SYM(delay, "snd_pcm_delay") && SYM(close, "snd_pcm_close") &&
                            SYM(strerror, "snd_strerror");
#undef SYM
            loaded = ok ? 1 : -1;
            if (!ok) why = std::string(kAlsaLib) + " lacks a symbol";
        }
    }
    if (loaded < 0) *err = why;
    return loaded > 0;
}
unsigned alsa_buffer_us() {
    const char *e = getenv("MGU_ALSA_US");
    const long v = e ? atol(e) : 0;
    return v >= 10000 && v <= 2000000 ? (unsigned) v : 64000;
}

std::atomic<unsigned long long> g_xruns(0);

class Sink {
public:
    enum Open { OK, RETRY, FATAL };
    /* OK: open; RETRY: not now (busy, missing: tried again); FATAL: never. err() and busy() say why */
    Open open() {
        busy_ = false;
        if (g_target.kind == WAV) {
            wav_ = fopen(g_target.where.c_str(), "wb");
            if (!wav_) { err_ = "cannot create " + g_target.where + ": " + strerror(errno); return FATAL; }
            header(0);
        }
        if (g_target.kind == ALSA) {
            if (!alsa_load(&err_)) return FATAL;
            int rc = A.open(&pcm_, g_target.where.c_str(), kPlayback, kNonblock);
            if (rc < 0) {
                pcm_ = nullptr;
                busy_ = rc == -EBUSY;
                err_ = std::string("snd_pcm_open ") + g_target.where + ": " + A.strerror(rc);
                return RETRY;
            }
            rc = A.set_params(pcm_, kS16LE, kRwInterleaved, 2, kRate, 1, alsa_buffer_us());
            if (rc < 0) {
                err_ = std::string("snd_pcm_set_params ") + g_target.where + ": " + A.strerror(rc);
                A.close(pcm_); pcm_ = nullptr;
                return RETRY;
            }
        }
        return OK;
    }
    bool is_open() const { return g_target.kind != ALSA || pcm_; }
    /* seconds of sound the device holds */
    double delay() {
        if (!pcm_) return 0;
        long d = 0;
        if (A.delay(pcm_, &d) != 0 || d < 0) return 0;
        return (double) d / kRate;
    }
    /* writes n frames; the frames the device did not take (nobody reads it: they are dropped) */
    size_t write(const int16_t *s, size_t n) {
        if (wav_) { if (fwrite(s, 4, n, wav_) == n) bytes_ += (uint32_t) (4 * n); return 0; }
        if (!pcm_) return g_target.kind == ALSA ? n : 0;
        double waited = 0;
        while (n > 0 && !g_quit) {
            const long w = A.writei(pcm_, s, n);
            if (w == -EAGAIN) {
                if (waited > 0.25) return n;   /* not read: the speakers not connected (yet) */
                sleep_s(0.005); waited += 0.005;
                continue;
            }
            if (w < 0) {
                g_xruns++;
                if (A.recover(pcm_, (int) w, 1) < 0) {
                    err_ = std::string("snd_pcm_writei: ") + A.strerror((int) w);
                    A.close(pcm_); pcm_ = nullptr;   /* lost: opened again */
                    return n;
                }
                continue;
            }
            s += w * 2; n -= (size_t) w;
        }
        return 0;
    }
    /* what the device holds is played (0.5 s at most) */
    void drain() {
        for (int i = 0; i < 100 && pcm_ && !g_quit && delay() > 0.001; i++) sleep_s(0.005);
    }
    void close() {
        if (pcm_) { A.close(pcm_); pcm_ = nullptr; }
        if (wav_) { header(bytes_); fclose(wav_); wav_ = nullptr; }
    }
    const std::string &err() const { return err_; }
    bool busy() const { return busy_; }

private:
    void header(uint32_t data) {
        const uint32_t rate = kRate, br = rate * 4, riff = 36 + data, fmtlen = 16;
        const uint16_t pcm = 1, ch = 2, ba = 4, bits = 16;
        fseek(wav_, 0, SEEK_SET);
        fwrite("RIFF", 1, 4, wav_); fwrite(&riff, 4, 1, wav_); fwrite("WAVEfmt ", 1, 8, wav_);
        fwrite(&fmtlen, 4, 1, wav_); fwrite(&pcm, 2, 1, wav_); fwrite(&ch, 2, 1, wav_); fwrite(&rate, 4, 1, wav_);
        fwrite(&br, 4, 1, wav_); fwrite(&ba, 2, 1, wav_); fwrite(&bits, 2, 1, wav_); fwrite("data", 1, 4, wav_);
        fwrite(&data, 4, 1, wav_);
        fseek(wav_, 0, SEEK_END);
    }
    FILE *wav_ = nullptr;
    snd_pcm_t *pcm_ = nullptr;
    uint32_t bytes_ = 0;
    std::string err_;
    bool busy_ = false;
};

std::atomic<int> g_volume_milli(1000);
std::atomic<bool> g_out_done(false);
std::atomic<unsigned long long> g_written(0);   /* the sound's frame the next one written is (from position 0) */
std::atomic<unsigned long long> g_dropped(0);   /* frames lost (the device did not take them) */
const double kLead = 0.04;                      /* written this far ahead of the clock (smartx reads 21 ms periods) */
std::atomic<bool> g_dev_ok(false);              /* the device is open */
const double kDeviceGiveUpS = 30;               /* a device not opened for this long is an error */

/* audio events: when the device's state or message changes */
void audio_event(const char *state, const std::string &msg) {
    static std::string last;
    const std::string key = std::string(state) + "|" + msg;
    if (key == last) return;
    last = key;
    if (msg.empty()) event(fmt("{\"ev\":\"audio\",\"state\":\"%s\",\"device\":\"%s\"}", state, js(g_target.where).c_str()));
    else event(fmt("{\"ev\":\"audio\",\"state\":\"%s\",\"device\":\"%s\",\"message\":\"%s\"}", state, js(g_target.where).c_str(), js(msg).c_str()));
}

void output_thread() {
    Sink sink;
    double retry_at = 0, failing_since = -1;
    /* opens the device, or says why not; false: not open (yet) */
    auto device = [&]() -> bool {
        if (sink.is_open() && g_dev_ok) return true;
        if (mono() < retry_at) return false;
        const Sink::Open o = sink.open();
        if (o == Sink::OK) {
            g_dev_ok = true;
            failing_since = -1;
            logf("audio: %s open", g_target.where.c_str());
            audio_event("open", "");
            return true;
        }
        g_dev_ok = false;
        if (o == Sink::FATAL) {
            fail("audio", kExitAudio, sink.err());
            g_quit = true;
            g_q.wake();
            return false;
        }
        const double t = mono();
        if (failing_since < 0) failing_since = t;
        logf("audio: %s: trying again in 1 s", sink.err().c_str());
        audio_event(sink.busy() ? "busy" : "error", sink.err());
        if (t - failing_since > kDeviceGiveUpS) {
            fail("audio", kExitAudio, fmt("%s (for %.0f s)", sink.err().c_str(), kDeviceGiveUpS));
            g_quit = true;
            g_q.wake();
            return false;
        }
        retry_at = t + 1.0;
        return false;
    };
    const size_t kChunk = 1024;
    std::vector<int16_t> buf(kChunk * 2);
    unsigned long long written = 0;   /* the sound's frame the next one written is: the clock's unit */
    while (!g_quit) {
        /* the device: before the start, and after it was lost (the clock stands meanwhile) */
        if (!device()) {
            if (g_clock.started() && !g_clock.stalled()) { logf("audio: the device is lost at %.2f s", g_clock.now()); g_clock.set_stalled(true); }
            sleep_s(0.02);
            continue;
        }
        /* the prebuffer: at the start, and after the input ran dry */
        const bool ready = g_q.frames() >= g_pre * kRate || g_q.eof();
        if (!g_clock.started()) {
            if (!ready) { sleep_s(0.005); continue; }
            written = g_origin_frames.load();   /* set by the decoder before it queued any sound */
            g_clock.set_origin((double) written / kRate);
            logf("playing at %.3f s: %.2f s queued", (double) written / kRate, (double) g_q.frames() / kRate);
            g_clock.start();
        }
        if (g_clock.stalled()) {
            if (!ready) { sleep_s(0.005); continue; }
            logf("buffered again: %.2f s queued", (double) g_q.frames() / kRate);
            g_clock.set_stalled(false);
        }
        if (g_clock.paused()) { sleep_s(0.01); continue; }
        /* on the clock: what is due, and a little more; to the device no faster than it plays: what it holds first */
        const double due = (g_clock.now() + kLead + sink.delay()) * kRate;
        if ((double) written >= due) { sleep_s(0.005); continue; }
        const size_t want = (size_t) std::min<double>(kChunk, due - (double) written + 1);
        const size_t n = g_q.pop(buf.data(), want, 0.01);
        if (!n) {
            if (g_q.drained()) break;
            if (!g_q.eof() && !g_quit) { logf("the input ran dry at %.2f s: buffering", g_clock.now()); g_clock.set_stalled(true); }
            continue;
        }
        const int v = g_volume_milli.load();
        if (v != 1000)
            for (size_t i = 0; i < n * 2; i++) buf[i] = (int16_t) ((int32_t) buf[i] * v / 1000);
        const size_t lost = sink.write(buf.data(), n);
        if (lost) g_dropped += lost;
        if (!sink.is_open()) g_dev_ok = false;
        written += n;
        g_written = written;
    }
    /* the last of it is heard before the end */
    while (!g_quit && g_clock.now() * kRate < (double) written) sleep_s(0.005);
    if (!g_quit) sink.drain();
    sink.close();   /* the device first: an input left open would stay busy for the next player */
    g_out_done = true;
}

/* ---------- the sound: decoding (tidal-player's) ---------- */
/* the mix-down weights of one input channel into left and right (tvh-player) */
void weights(AVChannel c, float *l, float *r) {
    const float k = 0.7071f;
    switch (c) {
    case AV_CHAN_FRONT_LEFT: case AV_CHAN_FRONT_LEFT_OF_CENTER: case AV_CHAN_WIDE_LEFT: *l = 1; *r = 0; break;
    case AV_CHAN_FRONT_RIGHT: case AV_CHAN_FRONT_RIGHT_OF_CENTER: case AV_CHAN_WIDE_RIGHT: *l = 0; *r = 1; break;
    case AV_CHAN_FRONT_CENTER: *l = *r = k; break;
    case AV_CHAN_LOW_FREQUENCY: case AV_CHAN_LOW_FREQUENCY_2: *l = *r = 0; break;
    case AV_CHAN_BACK_LEFT: case AV_CHAN_SIDE_LEFT: *l = k; *r = 0; break;
    case AV_CHAN_BACK_RIGHT: case AV_CHAN_SIDE_RIGHT: *l = 0; *r = k; break;
    default: *l = *r = 0.5f; break;
    }
}

/* a decoded frame -> interleaved stereo float; mono on both channels, more than two mixed down (tvh-player) */
void to_stereo(const AVFrame *f, std::vector<float> *out) {
    const int n = f->nb_samples, ch = f->ch_layout.nb_channels > 0 ? f->ch_layout.nb_channels : 1;
    std::vector<float> wl((size_t) ch), wr((size_t) ch);
    if (ch == 1) { wl[0] = wr[0] = 1; }
    else if (ch == 2) { wl[0] = 1; wr[0] = 0; wl[1] = 0; wr[1] = 1; }
    else {
        float sl = 0;
        for (int c = 0; c < ch; c++) {
            weights(av_channel_layout_channel_from_index(&f->ch_layout, (unsigned) c), &wl[(size_t) c], &wr[(size_t) c]);
            sl += wl[(size_t) c];
        }
        const float norm = sl > 1 ? 1.0f / sqrtf(sl) : 1.0f;
        for (int c = 0; c < ch; c++) { wl[(size_t) c] *= norm; wr[(size_t) c] *= norm; }
    }
    out->resize((size_t) n * 2);
    const bool planar = av_sample_fmt_is_planar((AVSampleFormat) f->format) != 0;
    for (int i = 0; i < n; i++) {
        float L = 0, R = 0;
        for (int c = 0; c < ch; c++) {
            const int plane = planar ? c : 0, at = planar ? i : i * ch + c;
            const uint8_t *d = f->extended_data[plane];
            float x;
            switch (f->format) {
            case AV_SAMPLE_FMT_FLTP: case AV_SAMPLE_FMT_FLT: x = ((const float *) d)[at]; break;
            case AV_SAMPLE_FMT_S16P: case AV_SAMPLE_FMT_S16: x = ((const int16_t *) d)[at] / 32768.0f; break;
            case AV_SAMPLE_FMT_S32P: case AV_SAMPLE_FMT_S32: x = (float) (((const int32_t *) d)[at] / 2147483648.0); break;
            default: x = 0; break;
            }
            L += x * wl[(size_t) c]; R += x * wr[(size_t) c];
        }
        (*out)[(size_t) i * 2] = L; (*out)[(size_t) i * 2 + 1] = R;
    }
}

/* stereo float at the input's rate -> 48 kHz stereo S16 -> the queue */
class Resampler {
public:
    ~Resampler() { if (swr_) swr_free(&swr_); }
    /* false: quit */
    bool put(const float *lr, int n, int rate) {
        if (rate != rate_) {
            if (swr_ && !flush()) return false;
            if (swr_) swr_free(&swr_);
            AVChannelLayout st = AV_CHANNEL_LAYOUT_STEREO;
            int rc;
            {
                std::lock_guard<std::mutex> l(g_cpu_mu);   /* the plain C routines, as tidal-player's */
                av_force_cpu_flags(0);
                rc = swr_alloc_set_opts2(&swr_, &st, AV_SAMPLE_FMT_S16, kRate, &st, AV_SAMPLE_FMT_FLT, rate, 0, nullptr);
                if (rc >= 0) rc = swr_init(swr_);
                av_force_cpu_flags(-1);
            }
            if (rc < 0) {
                logf("resampler: cannot convert %d Hz", rate);
                if (swr_) swr_free(&swr_);
                rate_ = 0;
                return true;
            }
            rate_ = rate;
        }
        if (!swr_) return true;
        return convert((const uint8_t *) lr, n);
    }
    /* what the resampler still holds */
    bool flush() { return swr_ ? convert(nullptr, 0) : true; }
    unsigned long long frames_out() const { return out_frames_; }
    /* the first n frames at 48 kHz are thrown away (a start position) */
    void skip(unsigned long long n) { skip_ = n; }
    unsigned long long to_skip() const { return skip_; }

private:
    bool convert(const uint8_t *in, int n) {
        const int max = swr_get_out_samples(swr_, n) + 16;
        if (max <= 0) return true;
        out_.resize((size_t) max * 2);
        uint8_t *o = (uint8_t *) out_.data();
        const uint8_t *i = in;
        const int got = swr_convert(swr_, &o, max, in ? &i : nullptr, n);
        if (got <= 0) return true;
        out_frames_ += (unsigned long long) got;
        const size_t drop = (size_t) std::min<unsigned long long>(skip_, (unsigned long long) got);
        skip_ -= drop;
        if (drop == (size_t) got) return !g_quit;
        return g_q.push(out_.data() + 2 * drop, (size_t) got - drop);
    }
    SwrContext *swr_ = nullptr;
    int rate_ = 0;
    std::vector<int16_t> out_;
    unsigned long long out_frames_ = 0, skip_ = 0;
};

/* ---------- the picture ---------- */
enum VideoOut { V_NULL, V_SHM };
VideoOut g_video_out = V_SHM;
std::string g_video_path;                 /* /dev/shm/mgu-video-<name> */
enum DecoderWish { D_AUTO, D_MSDK, D_SW };
DecoderWish g_decoder_wish = D_AUTO;
ytdec::Mgvf g_mgvf;
std::string g_mgvf_err;                   /* the frame file could not be made: why */
const double kLate = 0.12;                /* a picture later than this is not shown (tvh-player's) */
const double kPtsOffset = 20.0;           /* positions given to the Media SDK: never negative */
const double kEarly = 0.004;              /* a picture is shown this much before its time (tvh-player's) */

/* what the video thread is given */
struct VideoParams {
    AVCodecParameters *par = nullptr;
    AVRational tb = {1, 90000};
    double fps = 25;
};

/* bool: the decoders this binary has; the video event's decoder name */
const char *decoder_name(bool msdk) { return msdk ? "msdk" : "sw"; }

void video_error(bool msdk, const std::string &msg) {
    logf("video: %s", msg.c_str());
    event(fmt("{\"ev\":\"video\",\"state\":\"error\",\"decoder\":\"%s\",\"message\":\"%s\"}", decoder_name(msdk), js(msg).c_str()));
}

/* one decoded picture, from either decoder */
struct Pic {
    double pos = NAN;                 /* its position; NAN unknown (shown at once) */
    const AVFrame *av = nullptr;      /* sw: planar 4:2:0 */
    const woc::VideoFrame *mf = nullptr;   /* msdk: NV12, or no picture (decoded without one: it was late) */
    uint32_t w() const { return av ? (uint32_t) av->width & ~1u : mf->w & ~1u; }
    uint32_t h() const { return av ? (uint32_t) av->height & ~1u : mf->h & ~1u; }
    bool has() const { return av ? true : mf->y != nullptr; }
};

class VideoOutput {
public:
    VideoOutput(uint32_t matrix, uint32_t full) : matrix_(matrix), full_(full) {}
    /* a decoded picture: before the start position it is kept in the next slot (the last one is shown when playing
     * starts); then shown when the clock reaches it, or left out when late */
    void picture(const Pic &p) {
        if (g_quit) return;
        if (!isnan(p.pos) && p.pos < g_start - 1e-6) {   /* before the start: decoded, not shown */
            if (p.has() && write(p)) staged_ = true;
            return;
        }
        if (staged_) {
            staged_ = false;
            /* the last picture before the start is the picture at the start, unless this one is */
            if (isnan(p.pos) || p.pos > g_start + kEarly) shown();
        }
        if (!p.has()) { g_vdropped++; return; }
        if (!isnan(p.pos)) {
            for (;;) {
                if (g_quit) return;
                const double d = p.pos - kEarly - g_clock.now();
                if (d <= 0) break;
                sleep_s(d > 0.02 ? 0.02 : d);
            }
            if (g_clock.now() - p.pos > kLate) { g_vdropped++; late_ = true; return; }
        }
        late_ = false;
        if (write(p)) shown();
        else g_vdropped++;
    }
    /* the end: a picture kept from before the start is shown */
    void finish() { if (staged_ && !g_quit) shown(); staged_ = false; }
    bool late() const { return late_; }

private:
    /* p into the next slot (the frame file resized to p's size if need be); false: not written */
    bool write(const Pic &p) {
        if (g_video_out != V_SHM) return true;
        const uint32_t w = p.w(), h = p.h();
        if (!g_mgvf.sized() || g_mgvf.w() != w || g_mgvf.h() != h) {
            std::string err;
            if (!g_mgvf.size(w, h, 3, matrix_, full_, ytdec::kMgvfI420, &err)) {
                if (!size_logged_) { logf("video: frame file %ux%u: %s", w, h, err.c_str()); size_logged_ = true; }
                return false;
            }
            logf("video: frame file %s %ux%u I420", g_video_path.c_str(), w, h);
        }
        uint8_t *dst = g_mgvf.begin();
        if (p.av) {
            const AVFrame *f = p.av;
            if (f->format != AV_PIX_FMT_YUV420P && f->format != AV_PIX_FMT_YUVJ420P) {
                if (!fmt_logged_) { logf("video: pictures in %s are not shown", av_get_pix_fmt_name((AVPixelFormat) f->format)); fmt_logged_ = true; }
                return false;
            }
            ytdec::i420_copy(f->data[0], f->linesize[0], f->data[1], f->linesize[1], f->data[2], f->linesize[2], w, h, dst);
        } else ytdec::nv12_to_i420(p.mf->y, p.mf->uv, p.mf->pitch, w, h, dst);
        return true;
    }
    void shown() {
        if (g_video_out == V_SHM && g_mgvf.sized()) g_mgvf.commit();
        g_vframes++;
    }
    uint32_t matrix_, full_;
    bool staged_ = false, late_ = false, size_logged_ = false, fmt_logged_ = false;
};

/* the software decoder: libavcodec's h264, threaded; the SIMD routines are in */
AVCodecContext *open_sw(const VideoParams &vp, std::string *err) {
    std::lock_guard<std::mutex> l(g_cpu_mu);
    const AVCodec *dec = avcodec_find_decoder(AV_CODEC_ID_H264);
    AVCodecContext *c = dec ? avcodec_alloc_context3(dec) : nullptr;
    if (!c || avcodec_parameters_to_context(c, vp.par) < 0) { *err = "the H.264 decoder is not there"; avcodec_free_context(&c); return nullptr; }
    c->pkt_timebase = vp.tb;
    c->thread_count = 0;   /* as many as the CPU has */
    c->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    const int rc = avcodec_open2(c, dec, nullptr);
    if (rc < 0) { char e[128]; av_strerror(rc, e, sizeof e); *err = std::string("the H.264 decoder does not open: ") + e; avcodec_free_context(&c); return nullptr; }
    return c;
}

void video_thread(VideoParams vp) {
    const uint32_t w = (uint32_t) vp.par->width & ~1u, h = (uint32_t) vp.par->height & ~1u;
    /* BT.709 unless the stream says BT.601 (or is SD and says nothing); limited range unless it says full */
    const AVColorSpace cs = vp.par->color_space;
    const uint32_t matrix = cs == AVCOL_SPC_BT470BG || cs == AVCOL_SPC_SMPTE170M ? 0 : cs == AVCOL_SPC_BT709 ? 1 : h >= 720 ? 1 : 0;
    const uint32_t full = vp.par->color_range == AVCOL_RANGE_JPEG ? 1 : 0;
    VideoOutput out(matrix, full);
    woc::Decoder msdk;
    AVCodecContext *sw = nullptr;
    bool use_msdk = false, decoding = false;
    std::string why;
    /* the frame file */
    if (g_video_out == V_SHM && !g_mgvf_err.empty()) {
        video_error(g_decoder_wish == D_MSDK, "the frame file could not be made: " + g_mgvf_err);
    } else {
        if (g_video_out == V_SHM) {
            std::string err;
            if (w && h && !g_mgvf.size(w, h, 3, matrix, full, ytdec::kMgvfI420, &err)) g_mgvf_err = err;
        }
        if (!g_mgvf_err.empty()) video_error(g_decoder_wish == D_MSDK, "the frame file could not be made: " + g_mgvf_err);
        else {
            /* the decoder: the Media SDK (the GPU) unless sw is asked for; auto falls back to sw */
            if (g_decoder_wish != D_SW) {
                std::string err;
                if (!msdk_dl::load(&err)) why = err;
                else if (msdk.init(kRenderNode, 0, 0, false, &err)) use_msdk = true;
                else why = err;
                if (use_msdk) logf("video: msdk: the Intel Media SDK decodes on %s", kRenderNode);
                else if (g_decoder_wish == D_MSDK) video_error(true, "the Intel Media SDK does not start: " + why);
                else logf("video: msdk: %s: decoding in software", why.c_str());
            }
            if (!use_msdk && g_decoder_wish != D_MSDK) {
                std::string err;
                sw = open_sw(vp, &err);
                if (!sw) video_error(false, err);
            }
            decoding = use_msdk || sw;
            if (decoding) {
                std::string ev = fmt("{\"ev\":\"video\",\"state\":\"open\",\"decoder\":\"%s\"", decoder_name(use_msdk));
                if (w >= 16 && h >= 16) ev += fmt(",\"width\":%u,\"height\":%u", w, h);
                if (g_video_out == V_SHM) ev += fmt(",\"file\":\"%s\"", js(g_video_path).c_str());
                event(ev + "}");
                logf("video: %ux%u, %s decoder, %s", w, h, decoder_name(use_msdk), g_video_out == V_SHM ? g_video_path.c_str() : "not shown (MGU_VIDEO=null)");
            }
        }
    }
    AVFrame *fr = av_frame_alloc();
    unsigned long long errors = 0, fed = 0, msdk_frames = 0;
    double last_pos = NAN;
    const double step = vp.fps > 1 && vp.fps < 241 ? 1.0 / vp.fps : 0.04;
    bool need_key = false;
    auto sw_frames = [&]() {
        for (;;) {
            const int r = avcodec_receive_frame(sw, fr);
            if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return;
            if (r < 0) { if (++errors <= 5) logf("video: decode: %d", r); return; }
            Pic p;
            const int64_t ts = fr->best_effort_timestamp;
            p.pos = ts != AV_NOPTS_VALUE && !isnan(g_t0) ? position(ts * av_q2d(vp.tb)) : isnan(last_pos) ? NAN : last_pos + step;
            last_pos = p.pos;
            p.av = fr;
            out.picture(p);
            av_frame_unref(fr);
        }
    };
    auto msdk_frame = [&](const woc::VideoFrame &f) {
        msdk_frames++;
        Pic p;
        p.pos = f.pts_ms < 0 ? NAN : f.pts_ms / 1000.0 - kPtsOffset;
        p.mf = &f;
        out.picture(p);
    };
    AVPacket *pkt = nullptr;
    double pos = NAN;
    while (fr && g_vq.pop(&pkt, &pos)) {
        if (!decoding) { av_packet_free(&pkt); continue; }
        if (use_msdk) {
            /* a picture already late (or long before the start) is decoded without VPP and its copy */
            const bool before = !isnan(pos) && pos < g_start - 1.0;
            const bool late = g_clock.started() && !isnan(pos) && (out.late() || g_clock.now() - pos > kLate);
            const int64_t ms = isnan(pos) ? -1 : (int64_t) llround((pos + kPtsOffset) * 1000.0);
            std::string err;
            if (!msdk.feed(pkt->data, (size_t) pkt->size, msdk_frame, &err, true, !(before || late), ms)) {
                if (++errors <= 3 || errors % 100 == 0) logf("video: msdk: %s", err.c_str());
            }
            /* auto: a Media SDK that started but gives no picture is given up for the software decoder */
            if (++fed >= 60 && !msdk_frames && g_decoder_wish == D_AUTO && !g_quit) {
                logf("video: msdk: no picture from %llu packets: decoding in software", fed);
                msdk.shutdown();
                use_msdk = false;
                std::string e2;
                sw = open_sw(vp, &e2);
                decoding = sw != nullptr;
                if (sw) {
                    std::string ev = "{\"ev\":\"video\",\"state\":\"open\",\"decoder\":\"sw\"";
                    if (w >= 16 && h >= 16) ev += fmt(",\"width\":%u,\"height\":%u", w, h);
                    if (g_video_out == V_SHM) ev += fmt(",\"file\":\"%s\"", js(g_video_path).c_str());
                    event(ev + "}");
                } else video_error(false, e2);
                need_key = true;
            }
        } else {
            if (need_key && !(pkt->flags & AV_PKT_FLAG_KEY)) { av_packet_free(&pkt); continue; }
            need_key = false;
            const int r = avcodec_send_packet(sw, pkt);
            if (r < 0 && r != AVERROR(EAGAIN) && ++errors <= 5) logf("video: decode: %d", r);
            sw_frames();
        }
        av_packet_free(&pkt);
    }
    if (!g_quit && decoding) {
        if (use_msdk) msdk.flush(msdk_frame);
        else if (sw) { avcodec_send_packet(sw, nullptr); sw_frames(); }
    }
    if (!g_quit) out.finish();
    if (decoding) logf("video: %llu pictures shown, %llu left out, %llu decode errors", g_vframes.load(), g_vdropped.load(), errors);
    msdk.shutdown();
    if (sw) avcodec_free_context(&sw);
    av_frame_free(&fr);
    avcodec_parameters_free(&vp.par);
}
std::thread g_video;

/* ---------- demuxing ---------- */
void start_ticks();

/* the input is not usable: why, as an error code */
void fail_input(const std::string &what) {
    if (g_quit) return;   /* told to end: whatever the input was, it is no error */
    if (g_in.total() == 0) fail("input", kExitInput, "empty input");
    else if (g_in.looks_like_ts() && g_in.eof()) fail("input", kExitInput, "the input ended before any sound (" + what + ")");
    else fail("decode", kExitDecode, "no AAC sound found in MPEG-TS (" + what + ")");
}

std::string averr(int rc) { char e[128]; av_strerror(rc, e, sizeof e); return e; }

/* demuxes stdin: the sound decoded into its queue, the picture's packets into theirs; any failure set with fail() */
void decode() {
    av_log_set_level(AV_LOG_ERROR);
    av_log_set_callback(av_log_cb);
    AVFormatContext *fc = avformat_alloc_context();
    const int iosz = 64 * 1024;
    AVIOContext *io = avio_alloc_context((unsigned char *) av_malloc(iosz), iosz, 0, nullptr, read_cb, nullptr, nullptr);
    if (!fc || !io) { fail("internal", kExitDecode, "out of memory"); return; }
    io->seekable = 0;
    fc->pb = io;
    fc->flags |= AVFMT_FLAG_CUSTOM_IO;
    /* the stream's analysis: the sound's rate and channels and the picture's size are known from the first key
     * frame on (an HLS segment starts with one) */
    fc->probesize = 2 << 20;
    fc->max_analyze_duration = 2500000;
    int rc = avformat_open_input(&fc, nullptr, av_find_input_format("mpegts"), nullptr);   /* frees fc on failure */
    AVCodecContext *ctx = nullptr;
    AVStream *st = nullptr, *vs = nullptr;
    if (rc < 0) { fail_input(averr(rc)); goto out; }
    if ((rc = avformat_find_stream_info(fc, nullptr)) < 0) logf("stream info: %s", averr(rc).c_str());
    {
        const int si = av_find_best_stream(fc, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
        st = si >= 0 ? fc->streams[si] : nullptr;
        const int vi = av_find_best_stream(fc, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
        vs = vi >= 0 ? fc->streams[vi] : nullptr;
    }
    if (!st) { fail_input("no sound in it"); goto out; }
    if (st->codecpar->codec_id != AV_CODEC_ID_AAC) {
        fail("decode", kExitDecode, fmt("the sound is %s: only AAC plays here", avcodec_get_name(st->codecpar->codec_id)));
        goto out;
    }
    for (unsigned i = 0; i < fc->nb_streams; i++)
        if (fc->streams[i] != st && fc->streams[i] != vs) fc->streams[i]->discard = AVDISCARD_ALL;
    /* the stream's first timestamp: the earlier of the sound's and the picture's (or the first packet's) */
    {
        AVStream *both[2] = {st, vs};
        for (AVStream *s : both)
            if (s && s->start_time != AV_NOPTS_VALUE) {
                const double t = s->start_time * av_q2d(s->time_base);
                if (isnan(g_t0) || t < g_t0) g_t0 = t;
            }
    }
    {
        const AVCodecParameters *cp = st->codecpar;
        const int rate = cp->sample_rate, chans = cp->ch_layout.nb_channels;
        if (rate < 8000 || rate > 384000 || chans < 1 || chans > 8) { fail_input(fmt("%d Hz, %d channels", rate, chans)); goto out; }
        /* the picture: H.264 within mgu-render's 2048x2048 */
        std::string video, vproblem;
        if (!vs) vproblem = "no picture in the stream: the sound plays alone";
        else if (vs->codecpar->codec_id != AV_CODEC_ID_H264)
            vproblem = fmt("the picture is %s: only H.264 is shown; the sound plays alone", avcodec_get_name(vs->codecpar->codec_id));
        else if (vs->codecpar->width > 2048 || vs->codecpar->height > 2048)
            vproblem = fmt("the picture is %dx%d: larger than 2048x2048; the sound plays alone", vs->codecpar->width, vs->codecpar->height);
        else if (vs->codecpar->width >= 16 && vs->codecpar->height >= 16)
            video = fmt(",\"video\":{\"codec\":\"h264\",\"width\":%d,\"height\":%d}", vs->codecpar->width, vs->codecpar->height);
        logf("aac, %d Hz, %d channels; picture %s %dx%d; first timestamp %.3f s", rate, chans, vs ? avcodec_get_name(vs->codecpar->codec_id) : "none",
             vs ? vs->codecpar->width : 0, vs ? vs->codecpar->height : 0, g_t0);
        /* a video's length is the service's to say (the HLS playlist): MPEG-TS on a pipe does not say it */
        event(fmt("{\"ev\":\"open\",\"codec\":\"aac\",\"rate\":%d,\"channels\":%d,\"duration\":null%s}", rate, chans, video.c_str()));
        if (!vproblem.empty()) {
            video_error(g_decoder_wish == D_MSDK, vproblem);
            if (vs) vs->discard = AVDISCARD_ALL;
            vs = nullptr;
        }
        start_ticks();
        const AVCodec *dec = avcodec_find_decoder(cp->codec_id);
        ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
        bool opened = false;
        if (ctx && avcodec_parameters_to_context(ctx, cp) >= 0) {
            std::lock_guard<std::mutex> l(g_cpu_mu);   /* the plain C routines, as tidal-player's */
            av_force_cpu_flags(0);
            opened = avcodec_open2(ctx, dec, nullptr) >= 0;
            av_force_cpu_flags(-1);
        }
        if (!opened) { fail("decode", kExitDecode, "the aac decoder does not open"); goto out; }
        ctx->pkt_timebase = st->time_base;
        if (vs) {
            VideoParams vp;
            vp.par = avcodec_parameters_alloc();
            if (vp.par && avcodec_parameters_copy(vp.par, vs->codecpar) >= 0) {
                vp.tb = vs->time_base;
                const AVRational fr = vs->avg_frame_rate.num ? vs->avg_frame_rate : vs->r_frame_rate;
                if (fr.num > 0 && fr.den > 0) vp.fps = av_q2d(fr);
                g_video = std::thread(video_thread, vp);
            } else {
                avcodec_parameters_free(&vp.par);
                video_error(false, "out of memory");
                vs->discard = AVDISCARD_ALL;
                vs = nullptr;
            }
        }
    }
    {
        AVPacket *pkt = av_packet_alloc();
        AVFrame *fr = av_frame_alloc();
        Resampler rs;
        bool origin = false;
        std::vector<float> lr;
        unsigned long long frames = 0, errors = 0;
        bool more = true;
        auto drain = [&]() -> bool {
            for (;;) {
                const int r = avcodec_receive_frame(ctx, fr);
                if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
                if (r < 0) { if (++errors <= 5) logf("decode: %s", averr(r).c_str()); return true; }
                if (fr->nb_samples > 0 && fr->sample_rate >= 8000 && fr->sample_rate <= 384000) {
                    if (!origin) {
                        /* the first sound's position: what is before the start position is thrown away */
                        origin = true;
                        const int64_t ts = fr->best_effort_timestamp;
                        double p0 = ts != AV_NOPTS_VALUE && !isnan(g_t0) ? position(ts * av_q2d(st->time_base)) : g_base;
                        if (p0 < 0) p0 = 0;
                        const unsigned long long skip = g_start > p0 ? (unsigned long long) llround((g_start - p0) * kRate) : 0;
                        const unsigned long long o = (unsigned long long) llround(p0 * kRate) + skip;
                        rs.skip(skip);
                        g_origin_frames = o;
                        g_written = o;
                        g_clock.set_origin((double) o / kRate);
                        logf("the sound starts at %.3f s; %.3f s of it thrown away", p0, (double) skip / kRate);
                    }
                    to_stereo(fr, &lr);
                    frames++;
                    if (!rs.put(lr.data(), fr->nb_samples, fr->sample_rate)) { av_frame_unref(fr); return false; }
                }
                av_frame_unref(fr);
            }
        };
        while (more && !g_quit && pkt && fr) {
            rc = av_read_frame(fc, pkt);
            if (rc < 0) {
                if (rc != AVERROR_EOF) logf("read: %s", averr(rc).c_str());
                break;
            }
            if (isnan(g_t0) && pkt->pts != AV_NOPTS_VALUE) g_t0 = pkt->pts * av_q2d(fc->streams[pkt->stream_index]->time_base);
            if (pkt->stream_index == st->index && pkt->size > 0) {
                const int r = avcodec_send_packet(ctx, pkt);
                if (r < 0 && r != AVERROR(EAGAIN)) { if (++errors <= 5) logf("decode: %s", averr(r).c_str()); }
                more = drain();
                av_packet_unref(pkt);
            } else if (vs && pkt->stream_index == vs->index && pkt->size > 0) {
                const int64_t ts = pkt->pts != AV_NOPTS_VALUE ? pkt->pts : pkt->dts;
                const double pos = ts != AV_NOPTS_VALUE && !isnan(g_t0) ? position(ts * av_q2d(vs->time_base)) : NAN;
                /* a key frame before the start position: nothing queued before it is needed */
                if ((pkt->flags & AV_PKT_FLAG_KEY) && !isnan(pos) && pos <= g_start) g_vq.clear();
                AVPacket *v = av_packet_alloc();
                if (v) { av_packet_move_ref(v, pkt); g_vq.push(v, pos); }
                else av_packet_unref(pkt);
            } else av_packet_unref(pkt);
        }
        if (more && !g_quit) {
            avcodec_send_packet(ctx, nullptr);
            more = drain() && rs.flush();
        }
        logf("decoded %llu sound frames (%llu errors), %llu frames at 48 kHz", frames, errors, rs.frames_out());
        if (rs.to_skip()) logf("the start position %.3f s is past the end: nothing to play", g_start);
        if (!g_quit && frames == 0) fail_input(errors ? "nothing decoded" : "no sound frames");
        av_frame_free(&fr);
        av_packet_free(&pkt);
    }
out:
    g_vq.end();
    if (ctx) avcodec_free_context(&ctx);
    if (fc) avformat_close_input(&fc);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
}

/* ---------- control (tidal-player's) ---------- */
/* one command; anything else is ignored */
void command(const std::string &line) {
    if (line == "pause") g_clock.set_paused(true);
    else if (line == "resume") g_clock.set_paused(false);
    else if (line == "quit") { g_quit = true; g_q.wake(); }
    else if (!line.compare(0, 7, "volume ")) {
        const char *a = line.c_str() + 7;
        char *end = nullptr;
        const double v = strtod(a, &end);
        if (end == a || *end || v != v) { logf("control: %s: not a volume", line.c_str()); return; }
        g_volume_milli = (int) lrint((v < 0 ? 0 : v > 1 ? 1 : v) * 1000);
    } else { logf("control: ignored a line of %zu bytes", line.size()); return; }
    logf("control: %s", line.c_str());
}

void control_thread() {
    /* read(2), not stdio: a FILE locked in fgets would hold exit()'s flush of every stream (tvh-player) */
    std::string buf;
    bool skipping = false;   /* inside a line too long to be a command */
    char chunk[512];
    while (!g_quit) {
        struct pollfd p = {3, POLLIN, 0};
        const int pr = poll(&p, 1, 200);
        if (pr < 0 && errno != EINTR) break;
        if (pr <= 0) continue;
        const ssize_t n = read(3, chunk, sizeof chunk);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) { if (!g_quit) logf("control: fd 3 closed: quitting"); g_quit = true; g_q.wake(); return; }
        buf.append(chunk, (size_t) n);
        size_t i;
        while ((i = buf.find('\n')) != std::string::npos) {
            std::string line = buf.substr(0, i);
            buf.erase(0, i + 1);
            if (skipping) { skipping = false; continue; }
            if (!line.empty() && line[line.size() - 1] == '\r') line.erase(line.size() - 1);
            command(line);
        }
        if (buf.size() > 4096) { buf.clear(); skipping = true; }
    }
}

/* ---------- ticks ---------- */
std::atomic<bool> g_ticks_stop(false);
const char *state() {
    if (g_clock.started() && g_clock.paused()) return "paused";
    if (!g_clock.started() || g_clock.stalled() || !g_dev_ok) return "buffering";
    return "playing";
}
void tick_thread() {
    double next = mono() + 0.5;
    while (!g_ticks_stop && !g_quit) {
        const double d = next - mono();
        if (d > 0) { sleep_s(std::min(d, 0.05)); continue; }
        next += 0.5;
        if (next < mono()) next = mono() + 0.5;   /* held up for a while (a slow machine): no burst */
        const double pos = std::min(g_clock.now(), (double) g_written.load() / kRate);
        event(fmt("{\"ev\":\"tick\",\"pos\":%.3f,\"state\":\"%s\",\"buffered\":%.2f,\"dropped\":%llu,\"vframes\":%llu,\"vdropped\":%llu}",
                  pos < 0 ? 0 : pos, state(), (double) g_q.frames() / kRate, g_dropped.load(), g_vframes.load(), g_vdropped.load()));
    }
}
std::thread g_ticker;
void start_ticks() { if (!g_ticker.joinable()) g_ticker = std::thread(tick_thread); }
void stop_ticks() { g_ticks_stop = true; if (g_ticker.joinable()) g_ticker.join(); }

/* told to end: 2.5 s at most, then gone however far it got */
void watchdog() {
    while (!g_quit) sleep_s(0.05);
    for (int i = 0; i < 44; i++) { if (g_out_done) return; sleep_s(0.05); }
    logf("still closing the sound device after 2.2 s: exiting now");
    fflush(stderr);
    _exit(kExitOk);
}

void on_term(int) { g_quit = true; }

/* ---------- who it runs as (tidal-player's root drop, in two steps: the frame file is made between them) ---------- */
struct RunAs {
    bool root = false;   /* started as root: becomes uid:gid with groups */
    uid_t uid = 0;
    gid_t gid = 0;
    std::vector<gid_t> groups;
    std::string who;
};
/* 0, or the exit code to end with */
int resolve_user(RunAs *r) {
    const char *who = getenv("MGU_RUN_AS");
    if (getuid() != 0 && geteuid() != 0) {
        if (who && *who) logf("not root: running as uid %u (MGU_RUN_AS=%s not needed)", (unsigned) getuid(), who);
        return 0;
    }
    if (!who || !*who) { logf("refusing to run as root: MGU_RUN_AS is not set"); return kExitRoot; }
    r->who = who;
    char *end = nullptr;
    const unsigned long num = strtoul(who, &end, 10);
    if (*who >= '0' && *who <= '9' && end && !*end) { r->uid = (uid_t) num; r->gid = (gid_t) num; }
    else {
        struct passwd *pw = getpwnam(who);
        if (!pw) { logf("MGU_RUN_AS: no user %s", who); return kExitEnv; }
        r->uid = pw->pw_uid; r->gid = pw->pw_gid;
    }
    if (r->uid == 0) { logf("refusing to run as root: MGU_RUN_AS=%s is root", who); return kExitRoot; }
    const char *groups = getenv("MGU_GROUPS");
    std::string list = groups ? groups : "mgu_alsa,audio,video";
    size_t at = 0;
    while (at <= list.size()) {
        size_t comma = list.find(',', at);
        if (comma == std::string::npos) comma = list.size();
        const std::string g = list.substr(at, comma - at);
        at = comma + 1;
        if (g.empty()) continue;
        struct group *gr = getgrnam(g.c_str());
        if (gr) r->groups.push_back(gr->gr_gid);
        else logf("MGU_GROUPS: no group %s here: skipped", g.c_str());
    }
    r->root = true;
    return 0;
}
int become(const RunAs &r) {
    if (!r.root) return 0;
    if (setgroups(r.groups.size(), r.groups.empty() ? nullptr : r.groups.data()) != 0 || setgid(r.gid) != 0 || setuid(r.uid) != 0) {
        logf("refusing to run as root: cannot become %s: %s", r.who.c_str(), strerror(errno));
        return kExitRoot;
    }
    if (getuid() == 0 || geteuid() == 0 || getgid() == 0 || getegid() == 0 || setuid(0) == 0) {
        logf("refusing to run as root: still root after becoming %s", r.who.c_str());
        return kExitRoot;
    }
    logf("running as uid %u gid %u with %zu groups", (unsigned) r.uid, (unsigned) r.gid, r.groups.size());
    return 0;
}

/* MGU_VIDEO: shm:<name> (mgu-render's names: letters, digits, - _ ., not starting with ., at most 64) or null */
bool parse_video(const char *e) {
    const std::string s = e && *e ? e : kDefaultVideo;
    if (s == "null") { g_video_out = V_NULL; return true; }
    if (s.compare(0, 4, "shm:")) return false;
    const std::string name = s.substr(4);
    if (name.empty() || name.size() > 64 || name[0] == '.') return false;
    for (char c : name)
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.')) return false;
    g_video_out = V_SHM;
    g_video_path = "/dev/shm/mgu-video-" + name;
    return true;
}
bool parse_decoder(const char *e) {
    const std::string s = e ? e : "";
    if (s.empty() || s == "auto") g_decoder_wish = D_AUTO;
    else if (s == "msdk") g_decoder_wish = D_MSDK;
    else if (s == "sw") g_decoder_wish = D_SW;
    else return false;
    return true;
}
/* a position in ms (MGU_START_MS, MGU_BASE_MS): seconds; not a whole number of 0 or more: logged, 0 */
double parse_ms(const char *name) {
    const char *v = getenv(name);
    if (!v) return 0;
    char *end = nullptr;
    errno = 0;
    const long long ms = strtoll(v, &end, 10);
    if (*v && !*end && errno == 0 && ms >= 0) return (double) std::min(ms, kMaxMs) / 1000.0;
    logf("%s %s not understood: 0", name, v);
    return 0;
}

/* --version: what is inside, and whether this unit has libasound and the Media SDK (opened at run time) */
int print_version() {
    std::string dec;
    if (avcodec_find_decoder(AV_CODEC_ID_H264)) dec += " h264";
    if (avcodec_find_decoder(AV_CODEC_ID_AAC)) dec += " aac";
    void *h = dlopen(kAlsaLib, RTLD_NOW);
    std::string why;
    const bool mfx = msdk_dl::load(&why);
    printf("tidal-video %s (FFmpeg %s, swresample %u; decoders:%s; %s %s; msdk %s)\n", TIDAL_VIDEO_VERSION, av_version_info(),
           swresample_version(), dec.c_str(), kAlsaLib, h ? "found" : "not found", mfx ? "found" : ("not found: " + why).c_str());
    if (h) dlclose(h);
    return 0;
}

[[noreturn]] void finish(int code) {
    fflush(stdout);
    fflush(stderr);
    _exit(code);
}

}  // namespace

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--version")) return print_version();
    /* first of all: who it will run as (refused as root without MGU_RUN_AS: nothing made, nothing read) */
    RunAs ra;
    if (const int rc = resolve_user(&ra)) {
        event(fmt("{\"ev\":\"error\",\"code\":\"internal\",\"message\":\"%s\"}",
                  rc == kExitRoot ? "refusing to run as root" : "MGU_RUN_AS is not a user"));
        finish(rc);
    }
    if (!parse_video(getenv("MGU_VIDEO"))) {
        logf("MGU_VIDEO not understood: %s (shm:<name> or null)", getenv("MGU_VIDEO"));
        event(fmt("{\"ev\":\"error\",\"code\":\"internal\",\"message\":\"MGU_VIDEO not understood: %s\"}", js(getenv("MGU_VIDEO")).c_str()));
        finish(kExitEnv);
    }
    if (!parse_decoder(getenv("MGU_VIDEO_DECODER"))) {
        logf("MGU_VIDEO_DECODER not understood: %s (auto, msdk or sw)", getenv("MGU_VIDEO_DECODER"));
        event(fmt("{\"ev\":\"error\",\"code\":\"internal\",\"message\":\"MGU_VIDEO_DECODER not understood: %s\"}", js(getenv("MGU_VIDEO_DECODER")).c_str()));
        finish(kExitEnv);
    }
    /* the frame file, before root is given up, for the user the player becomes (mgu-render takes a file of the
     * app's uid, root's or nobody's); its size comes with the picture */
    if (g_video_out == V_SHM && !g_mgvf.create(g_video_path.c_str(), ra.root, ra.uid, ra.gid, &g_mgvf_err))
        logf("video: %s", g_mgvf_err.c_str());
    if (const int rc = become(ra)) {
        event("{\"ev\":\"error\",\"code\":\"internal\",\"message\":\"refusing to run as root\"}");
        finish(rc);
    }
    signal(SIGPIPE, SIG_IGN);
    /* no SA_RESTART: a wait for input returns, and the player ends */
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_term;
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);
    if (!parse_audio(getenv("MGU_AUDIO"), &g_target)) {
        logf("MGU_AUDIO not understood: %s (alsa:<device>, null or wav:<path>)", getenv("MGU_AUDIO"));
        event(fmt("{\"ev\":\"error\",\"code\":\"internal\",\"message\":\"MGU_AUDIO not understood: %s\"}", js(getenv("MGU_AUDIO")).c_str()));
        finish(kExitEnv);
    }
    if (const char *pb = getenv("MGU_PREBUFFER_MS")) {
        char *end = nullptr;
        const long ms = strtol(pb, &end, 10);
        if (*pb && !*end && ms >= 0 && ms <= 10000) g_pre = std::min(ms / 1000.0, kQueueS - 0.5);
        else logf("MGU_PREBUFFER_MS %s not understood: %.0f ms", pb, g_pre * 1000);
    }
    g_base = parse_ms("MGU_BASE_MS");
    g_start = std::max(parse_ms("MGU_START_MS"), g_base);
    g_origin_frames = (unsigned long long) llround(g_start * kRate);
    g_written = g_origin_frames.load();
    g_clock.set_origin(g_start);
    if (g_start > g_base) logf("starting at %.3f s (the input starts at %.3f s): what is before it is thrown away", g_start, g_base);
    std::thread(watchdog).detach();
    if (fcntl(3, F_GETFD) != -1) std::thread(control_thread).detach();   /* still in poll at the end: _exit ends it */
    std::thread out(output_thread);
    decode();
    g_q.end();
    if (failed()) { g_quit = true; g_q.wake(); }
    out.join();
    if (g_video.joinable()) g_video.join();
    stop_ticks();
    if (failed()) {
        std::string code, msg;
        int ex;
        { std::lock_guard<std::mutex> l(g_err_mu); code = g_err_code; msg = g_err_msg; ex = g_err_exit; }
        event(fmt("{\"ev\":\"error\",\"code\":\"%s\",\"message\":\"%s\"}", code.c_str(), js(msg).c_str()));
        finish(ex);
    }
    if (g_quit) { logf("quit"); finish(kExitOk); }   /* told to end: neither end nor error */
    event("{\"ev\":\"end\"}");
    finish(kExitOk);
}
