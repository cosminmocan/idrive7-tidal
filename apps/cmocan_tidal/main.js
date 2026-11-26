'use strict';
/**
 * cmocan_tidal - a personal TIDAL player for the BMW iDrive 7 head unit (MGU), on the idrive7-apps kit.
 *
 * The app is a screen for the cmocan-tidal service (native/cmocan-tidal, a root tool started by the first
 * connection to its socket): the service talks to TIDAL and plays the music; the app shows the login QR code, the
 * library, lists and now playing, routes the sound (source 287) to the speakers and follows the steering wheel.
 * The wiring is in tidal.js; this file hands it the kit. CMOCAN_TIDAL_SOCK overrides the socket (tests, preview).
 */
const mgu = require('./kit/mgu');
const { setImage } = require('./kit/record');
const parked = require('./kit/parked');
const decodeJpeg = require('./jpeg');
const { createApp } = require('./tidal');

mgu.run({
    start(ctx) {
        createApp(ctx, {
            socketPath: process.env.CMOCAN_TIDAL_SOCK || '/run/cmocan-tidal.sock',
            parked: parked.watch(ctx, ctx.log),
            setImage: setImage,
            decodeJpeg: decodeJpeg,
        });
        return Promise.resolve();
    },
});
