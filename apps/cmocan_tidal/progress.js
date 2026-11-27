'use strict';
/**
 * progress.js - where the track is, for the progress bar: the position each `status` answer gives, moved on by the
 * clock while it plays, and never backwards on the screen.
 *
 *   const pr = createProgress();
 *   pr.update(player, requestId, now)   each status answer's player (requestId: its request id; older ones ignored)
 *   pr.at(now)  -> { pos, dur }         seconds; dur null while not known
 *   pr.jump(pos, now, requestId)        the service took a seek to pos (requestId: the seek's request id): the bar
 *                                       carries on from there, back or forth, and a status asked for before the seek
 *                                       (an older id) no longer counts
 *
 * A position a little behind what is shown (the clock ran ahead of the player) holds the bar where it is until the
 * real one passes it; one more than 3 s behind is a real jump (prev restarting the track) and is shown. A new
 * track starts from its own position. Node 8.9.4 syntax.
 */
const isNum = (v) => typeof v === 'number' && isFinite(v);
const BACK_JUMP = 3;

function createProgress() {
    let lastId = -Infinity, key = null, base = 0, t = 0, floor = 0, dur = null, moving = false;

    function at(now) {
        let p = base + (moving ? Math.max(0, (now - t) / 1000) : 0);
        if (p < floor) p = floor;
        if (dur != null && p > dur) p = dur;
        return { pos: Math.max(0, p), dur: dur };
    }

    function update(player, id, now) {
        if (isNum(id)) { if (id < lastId) return; lastId = id; }
        const p = player && typeof player === 'object' ? player : null;
        const track = p && p.track && typeof p.track === 'object' ? p.track : null;
        if (!track) { key = null; base = 0; floor = 0; dur = null; moving = false; t = now; return; }
        const k = String(track.id) + '/' + String(p.queueIndex);
        const pos = isNum(p.position) && p.position >= 0 ? p.position : 0;
        const shown = at(now).pos;
        if (k !== key || pos < shown - BACK_JUMP) floor = 0;     // another track, or a real jump back
        else floor = shown;                                       // never back on the screen
        key = k;
        base = pos; t = now;
        dur = isNum(p.duration) && p.duration > 0 ? p.duration : (isNum(track.duration) && track.duration > 0 ? track.duration : null);
        moving = p.state === 'playing';
    }

    function jump(pos, now, id) {
        if (key === null || !isNum(pos) || pos < 0) return;
        base = pos; floor = 0; t = now;
        if (isNum(id) && id > lastId) lastId = id;
    }

    return { update: update, at: at, jump: jump };
}

module.exports = { createProgress: createProgress };
