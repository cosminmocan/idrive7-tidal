'use strict';
/**
 * video.js - a music video's picture on now playing (contract 4, docs/PROTOCOL.md): status.player.video names the
 * frame file the service's video player writes (/dev/shm/mgu-video-cmocan-tidal, mgu-render's "Video"); mgu-render
 * draws its newest frame where the app's frame has op 19 (kit/runtime/renderd.js videoOp). Pure (no I/O).
 *
 * (status.player.video is cleaned by model.js cleanVideo: { file, width, height } or null)
 *   fit(w, h, box)            the picture's rect inside box { x, y, w, h }: aspect kept, centred (the bars around it)
 *   decide({ video, renderer, parkedOnly, moving })   { show, note }: show the picture, or the cover view with note
 *                             (null: no line). renderer: 'video' (mgu-render/1 that shows video), 'old' (mgu-render/1
 *                             without video), 'none' (the software path)
 *   OVERLAY_MS                how long title and seek bar stay over the picture after a tap or a controller step
 *
 * Where the picture shows is the app's matter (the owner, 2026-11-28): also while driving; the setting "Picture only
 * while parked" (off by default) hides it while the car moves, the sound plays on. Node 8.9.4 syntax.
 */
const OVERLAY_MS = 4000;
const NOTES = {
    none: 'Video picture needs the GPU renderer',
    old: 'Video picture needs a newer mgu-render',
    parked: 'The picture shows while the car is parked',
};

function fit(w, h, box) {
    const k = Math.min(box.w / w, box.h / h), fw = w * k, fh = h * k;
    return { x: box.x + (box.w - fw) / 2, y: box.y + (box.h - fh) / 2, w: fw, h: fh };
}

function decide(o) {
    if (!o || !o.video) return { show: false, note: null };
    if (o.parkedOnly && o.moving) return { show: false, note: NOTES.parked };
    if (o.renderer !== 'video') return { show: false, note: o.renderer === 'old' ? NOTES.old : NOTES.none };
    return { show: true, note: null };
}

module.exports = { fit: fit, decide: decide, NOTES: NOTES, OVERLAY_MS: OVERLAY_MS };
