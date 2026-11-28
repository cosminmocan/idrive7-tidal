'use strict';
/**
 * audio.js - our player's sound on the car's speakers: aurelmarius' car_audio.js (with our change A1, see its header; source 287 to the
 * main speakers, the claims shared with his apps in /tmp/aurelm-287) driven by our player's state.
 *
 *   const audio = createAudio({ signals, log, file, send(cmd) });
 *   audio.update(player)   each status: the route is wanted while a track plays or is on its way (playing,
 *                          loading, buffering); paused, stopped or failed releases it
 *   audio.userPlay()       the driver's play (play, resume, next, prev) in our app
 *   audio.state()          car_audio's state plus `held`
 *
 * When the car ends our connection (the driver chose the radio) or another app claims the speakers, our playback is
 * paused (send('pause')) and the route is not asked for again, whatever the status says, until userPlay() (rule R7).
 * Node 8.9.4 syntax.
 */
const { createCarAudio } = require('./car_audio');

const WANT = { playing: true, loading: true, buffering: true };

function createAudio(o) {
    const log = o.log || { info() {}, warn() {} };
    let held = false;
    const send = (cmd) => { try { o.send(cmd); } catch (e) { log.warn('audio: ' + e); } };
    const opts = {
        file: o.file, app: 'TIDAL', yieldStops: true,
        onYield: (by) => { held = true; log.info('audio: ' + by + ' took the speakers: pausing'); send('pause'); },
        onLost: () => { held = true; log.info('audio: the car switched to another source: pausing'); send('pause'); },
    };
    if (o.claimDir) opts.claimDir = o.claimDir;      // tests only: the car uses car_audio's shared /tmp/aurelm-287
    if (o.bootId) opts.bootId = o.bootId;
    if (o.fs) opts.fs = o.fs;
    const ca = createCarAudio(o.signals, log, opts);

    function update(p) {
        const on = !!(p && typeof p === 'object' && p.track && WANT[p.state]) && !held;
        ca.want(on);
    }
    function userPlay() { held = false; ca.resume(); }
    function state() { const s = ca.state(); s.held = held; return s; }
    return { update: update, userPlay: userPlay, state: state, stop: () => ca.want(false), WANT: WANT };
}

module.exports = { createAudio: createAudio, WANT: WANT };
