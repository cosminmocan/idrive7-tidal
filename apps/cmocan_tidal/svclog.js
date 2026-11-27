'use strict';
/**
 * svclog.js - the service's log in the app's QR log (docs/PROTOCOL.md section 1, `log {lines}`). The QR log
 * (Settings > QR log, the kit's qrlog.js) shows the app's own log file; so that a problem in the car can be read
 * without a computer, the service's newest lines are written into that file, each marked "svc: ", just before the
 * page reads it.
 *
 *   const sl = createSvcLog({ ask(cmd, params, timeoutMs) -> Promise(answer), log });
 *   sl.fetch() -> Promise      asks `log {lines: 200}` and writes the lines not written before (log.info('svc: ' +
 *                              line)); never rejects. No usable answer: one line says so, once until one comes
 *   sl.watch(display)          the kit's display (ctx.display): from now on the QR log asks first, when it is opened
 *                              and on each of its buttons (Refresh among them)
 *
 * Which lines are new: the answer is the service's newest lines, oldest first, so the ones written last time are at
 * its start (or have fallen out of its 200); what follows them is new. No overlap (the service started again):
 * all of them.
 *
 * The kit has no hook for "the QR log opens" (the kit stays as it is), so watch() wraps what kit/runtime/mgu.js and
 * sheet.js do: display.openSheet(sheet) with sheet.settings, the settings' choose() on the row labelled "QR log",
 * and the opened page's press() and touch targets (sheet.child). The page reads the log file when it opens and on
 * Refresh, so the lines must be in the file before: the opening and the buttons wait for the answer, but never
 * longer than WAIT_MS. If the kit's sheets ever look different, nothing is wrapped and the QR log is the app's own
 * lines, as before. Node 8.9.4 syntax.
 */
const LINES = 200;
const LINE_MAX = 280;           // the kit's QR log cuts a line at 300 characters
const ASK_MS = 3000;
const WAIT_MS = 1000;
const QR_ROW = 'QR log';

function createSvcLog(o) {
    const log = o.log;
    let last = [];              // the lines of the last answer written
    let failed = false, flying = null;

    function clean(lines) {
        const out = [];
        lines.forEach((l) => {
            if (typeof l !== 'string') return;
            const s = l.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, LINE_MAX);
            if (s) out.push(s);
        });
        return out.slice(-LINES);
    }
    /** how many of `lines` (from its start) were written before: the longest end of `last` that `lines` starts with */
    function known(lines) {
        for (let i = Math.max(0, last.length - lines.length); i < last.length; i++) {
            const n = last.length - i;
            let same = true;
            for (let k = 0; k < n && same; k++) same = last[i + k] === lines[k];
            if (same) return n;
        }
        return 0;
    }
    function write(a) {
        const good = a && typeof a === 'object' && a.ok === true && Array.isArray(a.lines);
        if (!good) {
            const why = a && typeof a === 'object' && a.ok === false && typeof a.error === 'string' ? a.error.slice(0, 40) : 'bad-answer';
            if (!failed) log.info('svc: the service\'s log could not be read (' + why + ')');
            failed = true;
            return;
        }
        failed = false;
        const lines = clean(a.lines);
        lines.slice(known(lines)).forEach((l) => log.info('svc: ' + l));
        if (lines.length) last = lines;
    }
    function fetch() {
        if (flying) return flying;
        flying = Promise.resolve().then(() => o.ask('log', { lines: LINES }, ASK_MS)).catch(() => null)
            .then((a) => { flying = null; try { write(a); } catch (e) { /* the log's own */ } });
        return flying;
    }
    /** the answer, or WAIT_MS, whichever comes first (the lines of a late answer are there on the next Refresh) */
    function soon() {
        return new Promise((resolve) => {
            const t = setTimeout(resolve, WAIT_MS);
            fetch().then(() => { clearTimeout(t); resolve(); });
        });
    }

    /** the opened QR log: each button asks first */
    function wrapPage(page) {
        if (!page || page.svcLog || typeof page.press !== 'function' || typeof page.draw !== 'function') return;
        const press0 = page.press, draw0 = page.draw;
        page.svcLog = true;
        page.press = function () { return soon().then(() => press0.apply(page, arguments)); };
        page.draw = function () {
            return (draw0.apply(page, arguments) || []).map((q) => Object.assign({}, q, { act: () => soon().then(() => q.act && q.act()) }));
        };
    }
    /** the settings: choosing the QR log row asks first, then opens it */
    function wrapSettings(sh) {
        if (!sh || !sh.settings || sh.svcLog || typeof sh.choose !== 'function' || typeof sh.rows !== 'function') return;
        const choose0 = sh.choose;
        sh.svcLog = true;
        const onQrRow = () => {
            if (sh.open || sh.group || sh.child) return false;
            const row = sh.rows()[sh.focus];
            return !!row && row.label === QR_ROW;
        };
        sh.choose = function () {
            let qr = false;
            try { qr = onQrRow(); } catch (e) { qr = false; }
            if (!qr) return choose0.apply(sh, arguments);
            const at = sh.focus;
            return soon().then(() => {
                if (sh.focus !== at || sh.child) return null;       // the user went elsewhere meanwhile
                const r = choose0.apply(sh);
                wrapPage(sh.child);
                return r;
            });
        };
    }
    function watch(display) {
        if (!display || typeof display.openSheet !== 'function' || display.svcLog) return false;
        const open0 = display.openSheet;
        display.svcLog = true;
        display.openSheet = function (sh) {
            try { wrapSettings(sh); } catch (e) { /* the kit's sheet as it is */ }
            return open0.apply(display, arguments);
        };
        return true;
    }

    return { fetch: fetch, watch: watch };
}

module.exports = { createSvcLog: createSvcLog };
