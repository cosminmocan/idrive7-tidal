'use strict';
/**
 * nowplaying.js - which command each now-playing control sends (docs/PROTOCOL.md: pause, resume, next, prev), and
 * the texts now playing shows for the player's error.
 *
 *   playPause(player)   'pause' while playing or on its way (loading, buffering), 'resume' when paused or stopped
 *                       on an error, null when there is nothing to play
 *   skipCmd(dir)        the steering wheel's skip: +1 'next', -1 'prev'
 *   errorText(code)     status.player.error as a message: a control-socket code or a player code (input, decode,
 *                       audio, internal); anything else a plain "Playback error"
 * Node 8.9.4 syntax.
 */
function playPause(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.state === 'playing' || p.state === 'buffering' || p.state === 'loading') return 'pause';
    if (p.state === 'paused' || p.state === 'error') return 'resume';
    return p.track ? 'resume' : null;
}
function skipCmd(dir) { return dir > 0 ? 'next' : 'prev'; }

const ERROR_TEXT = {
    // the player's own (docs/PROTOCOL.md section 2)
    'input': 'The track did not arrive in full',
    'decode': 'The track\'s format cannot be played',
    'audio': 'The car\'s sound output cannot be opened',
    'internal': 'The player failed, try again',
    // the control socket's (section 1)
    'offline': 'No internet, playback stopped',
    'not-logged-in': 'Not logged in to TIDAL',
    'login-expired': 'The TIDAL login expired, log in again',
    'not-found': 'TIDAL does not have this track',
    'not-available': 'This track cannot be played',
    'rate-limited': 'TIDAL asked to wait, try again shortly',
    'tidal-error': 'TIDAL could not send this track',
    'bad-request': 'The service refused the request',
    'busy': 'The service is still starting, try again',
};
const PLAYBACK_ERROR = 'Playback error';
function errorText(code) { return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : PLAYBACK_ERROR; }

module.exports = { playPause: playPause, skipCmd: skipCmd, errorText: errorText };
