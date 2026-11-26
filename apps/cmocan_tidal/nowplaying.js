'use strict';
/**
 * nowplaying.js - which command each now-playing control sends (docs/PROTOCOL.md: pause, resume, next, prev).
 *
 *   playPause(player)   'pause' while playing or on its way (loading, buffering), 'resume' when paused or stopped
 *                       on an error, null when there is nothing to play
 *   skipCmd(dir)        the steering wheel's skip: +1 'next', -1 'prev'
 * Node 8.9.4 syntax.
 */
function playPause(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.state === 'playing' || p.state === 'buffering' || p.state === 'loading') return 'pause';
    if (p.state === 'paused' || p.state === 'error') return 'resume';
    return p.track ? 'resume' : null;
}
function skipCmd(dir) { return dir > 0 ? 'next' : 'prev'; }

module.exports = { playPause: playPause, skipCmd: skipCmd };
