'use strict';
/**
 * cmocan_tidal - a personal TIDAL player for the BMW iDrive 7 head unit (MGU). D0: one screen with the app's name.
 */
const mgu = require('./kit/mgu');

const W = 1600, H = 520;

mgu.run({
    start(ctx) {
        function draw() {
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            cv.text('TIDAL', W / 2, H / 2, 64, t.text, { align: 'center', font: 'bold', literal: true });
            return ctx.ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, draw);
        return Promise.resolve();
    },
});
