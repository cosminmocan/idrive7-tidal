// SPDX-License-Identifier: GPL-3.0-or-later
/* tidal-player - plays one TIDAL track on the head unit: the track's bytes on stdin (FLAC, or AAC in MP4), the sound
 * as 48 kHz stereo S16 into SmartXbar's CarLife input. The contract is docs/PROTOCOL.md, section 2.
 *
 * Adapted from aurelmarius' tvh-player (github.com/aurelmarius/bmw-apps native/tvh-player/src/player.cpp, 0976d16,
 * GPL-3.0-or-later), music only: no picture, no MPEG-TS, no subtitles, no gain or compressor. Kept: the event format
 * (MGU {json} on stdout), the control line on fd 3, the stereo mix-down, the WAV and null outputs, libasound opened at
 * run time with the device non-blocking (and uxplay-mgu's audio/mgu_audio.cpp), the root drop, the 2.5 s end.
 * Changed: FLAC and AAC (mov, flac, aac demuxers), always resampled to 48 kHz (libswresample: the car's input is
 * fixed at 48 kHz, ALSA's plug is not relied on), an input that can seek back within what it holds (an MP4 whose
 * index comes after its audio), errors with codes and exit codes.
 *
 *   main thread     stdin -> libavformat -> libavcodec -> stereo float -> libswresample 48 kHz S16 -> the queue
 *   output thread   the queue -> the volume -> the sound device (ALSA, a WAV file, or nothing), on the clock
 *   control thread  fd 3, one command a line: pause | resume | volume <0..1> | quit (anything else is ignored);
 *                   fd 3 closed (the service gone) is quit
 *   tick thread     every 500 ms after open: MGU {"ev":"tick",...}
 *   the clock       monotonic, from the first sound; stands while paused
 * Told to end (quit, SIGTERM, fd 3 closed) it closes the sound device first and is gone within 2.5 s, exit 0.
 *
 * MGU_AUDIO   alsa:<device> (default alsa:plug:smartx:CarLifeMedia_CF_48_STEREO) | null | wav:<path> (tests)
 */
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
}

namespace {

const char *kAlsaLib = "libasound.so.2";
const char *kDefaultAudio = "alsa:plug:smartx:CarLifeMedia_CF_48_STEREO";
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
    fprintf(stderr, "tidal-player: %s\n", buf);
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

/* ---------- the clock (tvh-player's): seconds of sound played; stands before the start and while paused ---------- */
class Clock {
public:
    double now() {
        std::lock_guard<std::mutex> l(mu_);
        return running_locked() ? base_ + (mono() - t0_) : base_;
    }
    bool started() { std::lock_guard<std::mutex> l(mu_); return started_; }
    bool paused() { std::lock_guard<std::mutex> l(mu_); return paused_; }
    void start() {
        std::lock_guard<std::mutex> l(mu_);
        if (started_) return;
        started_ = true;
        base_ = 0;
        t0_ = mono();
    }
    void set_paused(bool p) { set(&paused_, p); }

private:
    bool running_locked() const { return started_ && !paused_; }
    void set(bool *flag, bool v) {
        std::lock_guard<std::mutex> l(mu_);
        if (*flag == v) return;
        if (running_locked()) base_ += mono() - t0_;   /* freeze where it is */
        *flag = v;
        if (running_locked()) t0_ = mono();
    }
    std::mutex mu_;
    bool started_ = false, paused_ = false;
    double base_ = 0, t0_ = 0;
};
Clock g_clock;

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

/* ---------- the input: stdin, seekable within what is held ----------
 * TIDAL's bytes come once, from the first, through a pipe. FLAC and an MP4 with its index (moov) first read
 * straight through; the bytes behind are let go (1 MiB is kept for short seeks back). An MP4 whose index comes after
 * its audio needs a seek forward to the index and back to the audio: the bytes in between are held (64 MiB at
 * most, some 25 minutes of AAC 320) until the demuxer comes back. */
class Input {
public:
    int read(uint8_t *dst, int size) {
        if (pos_ == end() && fill(std::max(size, 65536)) <= 0) return AVERROR_EOF;
        const size_t at = (size_t) (pos_ - base_);
        const int n = (int) std::min((size_t) size, buf_.size() - at);
        memcpy(dst, buf_.data() + at, (size_t) n);
        pos_ += n;
        trim();
        return n;
    }
    int64_t seek(int64_t off, int whence) {
        whence &= ~AVSEEK_FORCE;
        if (whence == AVSEEK_SIZE) return eof_ ? end() : AVERROR(ENOSYS);
        int64_t target = whence == SEEK_SET ? off : whence == SEEK_CUR ? pos_ + off : whence == SEEK_END && eof_ ? end() + off : -1;
        if (target < 0) return AVERROR(EINVAL);
        if (target < base_) { logf("input: a seek back to %lld, %lld bytes before what is held", (long long) target, (long long) (base_ - target)); return AVERROR(EIO); }
        if (target > end()) {
            if (!hold_) logf("input: a seek forward to %lld: holding the bytes in between", (long long) target);
            hold_ = true;
            while (target > end()) {
                if (buf_.size() >= kHoldMax) { too_big_ = true; logf("input: more than %zu MiB held: giving up", kHoldMax >> 20); return AVERROR(ENOMEM); }
                if (fill((size_t) std::min<int64_t>(target - end(), 1 << 20)) <= 0) break;
            }
            pos_ = std::min(target, end());
            return pos_;
        }
        if (target < pos_ && hold_) { hold_ = false; logf("input: back to %lld; %zu KiB held", (long long) target, buf_.size() >> 10); }
        pos_ = target;
        return pos_;
    }
    int64_t total() const { return total_; }
    bool eof() const { return eof_; }
    bool too_big() const { return too_big_; }
    /* the first bytes: does it look like FLAC, MP4 or ADTS (then a failure is a cut-off input, not a wrong one) */
    bool looks_like_audio() const {
        const uint8_t *h = head_;
        const size_t n = head_n_;
        if (n >= 4 && !memcmp(h, "fLaC", 4)) return true;
        if (n >= 3 && !memcmp(h, "ID3", 3)) return true;
        if (n >= 8 && (!memcmp(h + 4, "ftyp", 4) || !memcmp(h + 4, "moov", 4) || !memcmp(h + 4, "mdat", 4) ||
                       !memcmp(h + 4, "free", 4) || !memcmp(h + 4, "skip", 4) || !memcmp(h + 4, "wide", 4) || !memcmp(h + 4, "styp", 4))) return true;
        if (n >= 2 && h[0] == 0xff && (h[1] & 0xf6) == 0xf0) return true;   /* ADTS sync, layer 0 */
        return false;
    }
    bool head_complete() const { return head_n_ >= 8; }

private:
    int64_t end() const { return base_ + (int64_t) buf_.size(); }
    /* reads up to n bytes from stdin onto the end; 0 at its end, -1 when told to quit */
    ssize_t fill(size_t n) {
        if (eof_) return 0;
        const size_t old = buf_.size();
        buf_.resize(old + n);
        for (;;) {
            if (g_quit) { buf_.resize(old); return -1; }
            struct pollfd p = {0, POLLIN, 0};
            const int pr = poll(&p, 1, 200);
            if (pr < 0 && errno != EINTR) { buf_.resize(old); eof_ = true; return 0; }
            if (pr <= 0) continue;
            const ssize_t r = ::read(0, buf_.data() + old, n);
            if (r < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            if (r <= 0) {
                buf_.resize(old);
                eof_ = true;
                logf("input: ended after %lld bytes", (long long) total_);
                return 0;
            }
            buf_.resize(old + (size_t) r);
            if (head_n_ < sizeof head_) {
                const size_t k = std::min(sizeof head_ - head_n_, (size_t) r);
                memcpy(head_ + head_n_, buf_.data() + old, k);
                head_n_ += k;
            }
            total_ += r;
            return r;
        }
    }
    void trim() {
        if (hold_ || pos_ - base_ <= (int64_t) (2 * kKeepBehind)) return;
        const size_t drop = (size_t) (pos_ - base_) - kKeepBehind;
        buf_.erase(buf_.begin(), buf_.begin() + (std::ptrdiff_t) drop);
        base_ += (int64_t) drop;
    }
    static const size_t kKeepBehind = 1u << 20, kHoldMax = 64u << 20;
    std::vector<uint8_t> buf_;   /* the bytes [base_, base_ + size) */
    int64_t base_ = 0, pos_ = 0, total_ = 0;
    bool eof_ = false, hold_ = false, too_big_ = false;
    uint8_t head_[16];
    size_t head_n_ = 0;
};
Input g_in;
int read_cb(void *, uint8_t *buf, int size) { return g_in.read(buf, size); }
int64_t seek_cb(void *, int64_t off, int whence) { return g_in.seek(off, whence); }

/* ---------- the queue: decoded sound, 48 kHz stereo S16 ---------- */
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
const double kQueueS = 6.0;   /* decoded ahead at most; then the decoder waits, and so does the sender (the pipe) */
PcmQueue g_q((size_t) (kQueueS * kRate));

/* ---------- the sound device ---------- */
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

class Sink {
public:
    /* true: open; else err() says why */
    bool open() {
        if (g_target.kind == WAV) {
            wav_ = fopen(g_target.where.c_str(), "wb");
            if (!wav_) { err_ = "cannot create " + g_target.where + ": " + strerror(errno); return false; }
            header(0);
        }
        return true;
    }
    /* writes n frames */
    void write(const int16_t *s, size_t n) {
        if (wav_) {
            if (fwrite(s, 4, n, wav_) == n) bytes_ += (uint32_t) (4 * n);
        }
    }
    void close() {
        if (wav_) { header(bytes_); fclose(wav_); wav_ = nullptr; }
    }
    const std::string &err() const { return err_; }

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
    uint32_t bytes_ = 0;
    std::string err_;
};

std::atomic<int> g_volume_milli(1000);
std::atomic<bool> g_out_done(false);
std::atomic<unsigned long long> g_written(0);   /* frames given to the device */
std::atomic<unsigned long long> g_dropped(0);   /* frames lost (the device did not take them) */
const double kLead = 0.02;                      /* written this far ahead of the clock */

void output_thread() {
    Sink sink;
    if (!sink.open()) {
        fail("audio", kExitAudio, sink.err());
        g_quit = true;
        g_q.wake();
        g_out_done = true;
        return;
    }
    const size_t kChunk = 1024;
    std::vector<int16_t> buf(kChunk * 2);
    unsigned long long written = 0;
    while (!g_quit) {
        if (!g_clock.started()) {
            if (g_q.frames() > 0 || g_q.drained()) g_clock.start();
            else { sleep_s(0.005); continue; }
        }
        if (g_clock.paused()) { sleep_s(0.01); continue; }
        /* on the clock: what is due, and a little more */
        const double due = (g_clock.now() + kLead) * kRate;
        if ((double) written >= due) { sleep_s(0.005); continue; }
        const size_t want = (size_t) std::min<double>(kChunk, due - (double) written + 1);
        const size_t n = g_q.pop(buf.data(), want, 0.01);
        if (!n) { if (g_q.drained()) break; continue; }
        const int v = g_volume_milli.load();
        if (v != 1000)
            for (size_t i = 0; i < n * 2; i++) buf[i] = (int16_t) ((int32_t) buf[i] * v / 1000);
        sink.write(buf.data(), n);
        written += n;
        g_written = written;
    }
    /* the last of it is heard before the end */
    while (!g_quit && g_clock.now() * kRate < (double) written) sleep_s(0.005);
    sink.close();   /* the device first: an input left open would stay busy for the next player */
    g_out_done = true;
}

/* ---------- decoding ---------- */
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
            if (swr_alloc_set_opts2(&swr_, &st, AV_SAMPLE_FMT_S16, kRate, &st, AV_SAMPLE_FMT_FLT, rate, 0, nullptr) < 0 || swr_init(swr_) < 0) {
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
        return g_q.push(out_.data(), (size_t) got);
    }
    SwrContext *swr_ = nullptr;
    int rate_ = 0;
    std::vector<int16_t> out_;
    unsigned long long out_frames_ = 0;
};

void start_ticks();

/* the input is not usable: why, as an error code */
void fail_input(const std::string &what) {
    if (g_quit) return;   /* told to end: whatever the input was, it is no error */
    if (g_in.total() == 0) fail("input", kExitInput, "empty input");
    else if (g_in.too_big()) fail("decode", kExitDecode, "the MP4 index (moov) is more than 64 MiB after its start");
    else if (g_in.looks_like_audio() && g_in.eof()) fail("input", kExitInput, "the input ended before any sound (" + what + ")");
    else fail("decode", kExitDecode, "no FLAC or AAC stream found (" + what + ")");
}

std::string averr(int rc) { char e[128]; av_strerror(rc, e, sizeof e); return e; }

/* demuxes and decodes stdin into the queue; any failure is set with fail() */
void decode() {
    av_log_set_level(AV_LOG_ERROR);
    AVFormatContext *fc = avformat_alloc_context();
    const int iosz = 64 * 1024;
    AVIOContext *io = avio_alloc_context((unsigned char *) av_malloc(iosz), iosz, 0, nullptr, read_cb, nullptr, seek_cb);
    if (!fc || !io) { fail("internal", kExitDecode, "out of memory"); return; }
    io->seekable = AVIO_SEEKABLE_NORMAL;   /* within what Input holds */
    fc->pb = io;
    fc->flags |= AVFMT_FLAG_CUSTOM_IO;
    fc->probesize = 1 << 20;
    int rc = avformat_open_input(&fc, nullptr, nullptr, nullptr);   /* frees fc on failure */
    AVCodecContext *ctx = nullptr;
    AVStream *st = nullptr;
    if (rc < 0) { fail_input(averr(rc)); goto out; }
    if ((rc = avformat_find_stream_info(fc, nullptr)) < 0) logf("stream info: %s", averr(rc).c_str());
    {
        const int si = av_find_best_stream(fc, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
        st = si >= 0 ? fc->streams[si] : nullptr;
    }
    if (!st) { fail_input("no sound in it"); goto out; }
    if (st->codecpar->codec_id != AV_CODEC_ID_FLAC && st->codecpar->codec_id != AV_CODEC_ID_AAC) {
        fail("decode", kExitDecode, fmt("the sound is %s: only FLAC and AAC play here", avcodec_get_name(st->codecpar->codec_id)));
        goto out;
    }
    {
        const AVCodecParameters *cp = st->codecpar;
        const int rate = cp->sample_rate, chans = cp->ch_layout.nb_channels;
        if (rate < 8000 || rate > 384000 || chans < 1 || chans > 8) { fail_input(fmt("%d Hz, %d channels", rate, chans)); goto out; }
        double dur = -1;
        if (fc->duration != AV_NOPTS_VALUE && fc->duration > 0) dur = fc->duration / (double) AV_TIME_BASE;
        else if (st->duration != AV_NOPTS_VALUE && st->duration > 0) dur = st->duration * av_q2d(st->time_base);
        const char *codec = cp->codec_id == AV_CODEC_ID_FLAC ? "flac" : "aac";
        logf("%s (%s), %d Hz, %d channels, %.3f s", codec, fc->iformat->name, rate, chans, dur);
        event(fmt("{\"ev\":\"open\",\"codec\":\"%s\",\"rate\":%d,\"channels\":%d,\"duration\":%s}", codec, rate, chans,
                  dur >= 0 ? fmt("%.3f", dur).c_str() : "null"));
        start_ticks();
        const AVCodec *dec = avcodec_find_decoder(cp->codec_id);
        ctx = dec ? avcodec_alloc_context3(dec) : nullptr;
        if (!ctx || avcodec_parameters_to_context(ctx, cp) < 0 || avcodec_open2(ctx, dec, nullptr) < 0) {
            fail("decode", kExitDecode, fmt("the %s decoder does not open", codec));
            goto out;
        }
        ctx->pkt_timebase = st->time_base;
    }
    {
        AVPacket *pkt = av_packet_alloc();
        AVFrame *fr = av_frame_alloc();
        Resampler rs;
        std::vector<float> lr;
        unsigned long long frames = 0, errors = 0;
        bool more = true;
        auto drain = [&]() -> bool {
            for (;;) {
                const int r = avcodec_receive_frame(ctx, fr);
                if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
                if (r < 0) { if (++errors <= 5) logf("decode: %s", averr(r).c_str()); return true; }
                if (fr->nb_samples > 0 && fr->sample_rate >= 8000 && fr->sample_rate <= 384000) {
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
            if (pkt->stream_index == st->index && pkt->size > 0) {
                const int r = avcodec_send_packet(ctx, pkt);
                if (r < 0 && r != AVERROR(EAGAIN)) { if (++errors <= 5) logf("decode: %s", averr(r).c_str()); }
                more = drain();
            }
            av_packet_unref(pkt);
        }
        if (more && !g_quit) {
            avcodec_send_packet(ctx, nullptr);
            more = drain() && rs.flush();
        }
        logf("decoded %llu frames (%llu errors), %llu frames at 48 kHz", frames, errors, rs.frames_out());
        if (!g_quit && frames == 0) fail_input(errors ? "nothing decoded" : "no sound frames");
        av_frame_free(&fr);
        av_packet_free(&pkt);
    }
out:
    if (ctx) avcodec_free_context(&ctx);
    if (fc) avformat_close_input(&fc);
    if (io) { av_freep(&io->buffer); avio_context_free(&io); }
}

/* ---------- control ---------- */
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
    if (!g_clock.started()) return "buffering";
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
        event(fmt("{\"ev\":\"tick\",\"pos\":%.3f,\"state\":\"%s\",\"buffered\":%.2f,\"dropped\":%llu}",
                  pos < 0 ? 0 : pos, state(), (double) g_q.frames() / kRate, g_dropped.load()));
    }
}
std::thread g_ticker;
void start_ticks() { if (!g_ticker.joinable()) g_ticker = std::thread(tick_thread); }
void stop_ticks() { g_ticks_stop = true; if (g_ticker.joinable()) g_ticker.join(); }

/* told to end: 2.5 s at most, then gone however far it got (tvh-player: a player not ended after 6 s in the car was
 * killed by the service) */
void watchdog() {
    while (!g_quit) sleep_s(0.05);
    for (int i = 0; i < 44; i++) { if (g_out_done) return; sleep_s(0.05); }
    logf("still closing the sound device after 2.2 s: exiting now");
    fflush(stderr);
    _exit(kExitOk);
}

void on_term(int) { g_quit = true; }

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

/* ends the process: the error (if any) as the last event, then its exit code */
[[noreturn]] void finish(int code) {
    fflush(stdout);
    fflush(stderr);
    _exit(code);
}

}  // namespace

int main(int argc, char **argv) {
    if (argc > 1 && !strcmp(argv[1], "--version")) return print_version();
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
    std::thread(watchdog).detach();
    if (fcntl(3, F_GETFD) != -1) std::thread(control_thread).detach();   /* still in poll at the end: _exit ends it */
    std::thread out(output_thread);
    decode();
    g_q.end();
    if (failed()) { g_quit = true; g_q.wake(); }
    out.join();
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
