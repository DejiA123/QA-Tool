/* ============================================================================
 * reader-wake.js — KEEP THE BACKGROUND READER TAB AWAKE
 * ============================================================================
 * THE REPORT, VERBATIM: "when I hover my mouse over the browser on the Windows
 * taskbar to see what is going on it is very fast and consistent; if I don't do that
 * it is very slow and it does not get the TAM's name."
 *
 * That is not a coincidence and it is not a race in the panel. Hovering the taskbar
 * makes Windows ask Chrome for a thumbnail of that window, which UN-OCCLUDES it.
 * Everything the reader was waiting for then happens at once.
 *
 * A window that is minimized, or fully covered by another window, is OCCLUDED, and
 * Chrome then does three things to it:
 *
 *   · reports `document.visibilityState` as 'hidden' — which a Lightning record page
 *     reads as "nobody is looking", so it stops mounting the parts of a long record
 *     that are not on screen. That is why a fourteen-section Account comes back with
 *     its header and no aligned engineers;
 *   · stops compositing, so `requestAnimationFrame` never fires and anything
 *     scheduled inside one — which in a modern SPA is most rendering work — simply
 *     does not run;
 *   · clamps timers, hard, the longer the window stays hidden.
 *
 * So this tells the page it is visible and focused, swallows the events that would
 * tell it otherwise, and gives rAF a timer backstop. It does not make the window
 * visible. It makes the page stop CARING whether it is, which is the part that was
 * breaking the read.
 *
 * IT RUNS IN THE PAGE'S OWN WORLD, and that is not a detail. A content script lives
 * in an isolated world: it shares the DOM but not the JavaScript globals, so
 * redefining `document.visibilityState` there changes what the EXTENSION sees and
 * nothing about what the page sees. The whole point here is what the page sees, so
 * this is injected with `world: 'MAIN'`. (Its cousin copilot-bridge.js reaches its
 * app through wake EVENTS, which do cross worlds — but events alone leave the
 * property saying 'hidden', which is the one thing a lazily-mounting record layout
 * actually consults.)
 *
 * SCOPED TO THE READ. It is injected into the reader tab the panel opened, and the
 * document_start registration that goes with it is removed the moment the read
 * finishes — see ocReaderWake* in sidepanel.js. A page left believing it is visible
 * forever would swallow a real pagehide, and on a tab the engineer is working in
 * that could cost them a draft.
 * ========================================================================== */
(function () {
    'use strict';

    // Re-injected on every poll, and registered at document_start as well. Installing
    // twice would double-wrap requestAnimationFrame, so the guard is on the WINDOW —
    // shared by both routes because both run in the page's own world.
    if (window.__sotiReaderAwake) {
        // Not a no-op: a page that has been sitting behind the engineer's since the last
        // look has had every chance to tear itself down, and the wake is what puts it
        // back together. See fireWake below.
        if (typeof window.__sotiReaderWake === 'function') window.__sotiReaderWake();
        return;
    }
    window.__sotiReaderAwake = true;

    const define = (obj, prop, get) => {
        try { Object.defineProperty(obj, prop, { configurable: true, get }); } catch (e) { /* locked down */ }
    };

    // The page's own view of whether anyone is watching. Frozen at "yes".
    define(document, 'hidden', () => false);
    define(document, 'visibilityState', () => 'visible');
    define(document, 'webkitHidden', () => false);
    define(document, 'webkitVisibilityState', () => 'visible');
    try { document.hasFocus = () => true; } catch (e) { /* non-configurable */ }

    /* AND THE EVENTS THAT SAY OTHERWISE ARE SWALLOWED.
     *
     * Spoofing the property is not enough on its own. An app that has already been told
     * "you are hidden" has already torn things down, and one told it again tears them
     * down again whatever the property now says. Capture phase, so this runs before any
     * handler the page registered.
     *
     * `freeze` and `pagehide` are in the list because Chrome's own lifecycle fires them
     * at a window left alone long enough, and a frozen page is a read that will never
     * finish. */
    let waking = false;
    for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
        const swallow = (e) => {
            // …EXCEPT THE ONES FIRED BELOW, which exist precisely so an app that has
            // already gone to sleep puts itself back together. Without this the capture
            // listener eats the one event the wake depends on.
            if (waking) return;
            e.stopImmediatePropagation();
        };
        window.addEventListener(type, swallow, true);
        document.addEventListener(type, swallow, true);
    }

    /* requestAnimationFrame DOES NOT FIRE IN AN OCCLUDED WINDOW.
     *
     * Anything the page deferred into one — mounting a section that has scrolled into
     * view, laying out a field that has just been given a value — waits for a frame that
     * is never painted. So the callback is ALSO scheduled on a timer, and whichever
     * arrives first wins; the loser is dropped by the `ran` guard, so a window that is
     * compositing normally sees no change beyond one dead timer.
     *
     * 32ms rather than 16: a timer racing real vsync would win often enough on a visible
     * window to change WHEN work runs, and this is a backstop, not a replacement.
     *
     * The timer is itself clamped in a hidden window — to a second, and to a minute after
     * five minutes hidden — so a second copy is queued on a MessageChannel, which is not
     * throttled the same way and delivers on the next macrotask whatever the window is
     * doing. Whichever of the three fires first runs the callback. */
    const rafNative = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
    if (rafNative) {
        window.requestAnimationFrame = function (cb) {
            let ran = false;
            const once = (t) => {
                if (ran) return;
                ran = true;
                try { cb(t); } catch (e) { /* the page's problem, not ours */ }
            };
            const id = rafNative(once);
            setTimeout(() => once(performance.now()), 32);
            try {
                const ch = new MessageChannel();
                ch.port1.onmessage = () => once(performance.now());
                ch.port2.postMessage(0);
            } catch (e) { /* no MessageChannel — the timer is still there */ }
            return id;
        };
    }

    /* WAKE WHATEVER ALREADY WENT TO SLEEP.
     *
     * This usually installs into a page that has been hidden since it loaded, so stopping
     * FUTURE teardown is not enough — the app has to be told it is back. These are the
     * same events, in the same order, that a real un-occlusion would deliver: which is to
     * say, exactly what hovering the taskbar was doing by hand.
     *
     * Published on `window` so it can be fired again on every poll without re-installing
     * the shim. */
    const fireWake = () => {
        waking = true;
        try {
            const fire = (target, type, EventCtor) => {
                try { target.dispatchEvent(new EventCtor(type)); } catch (e) { /* ignore */ }
            };
            fire(document, 'visibilitychange', Event);
            fire(document, 'webkitvisibilitychange', Event);
            fire(window, 'focus', Event);
            fire(document, 'focus', Event);
            try { window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })); }
            catch (e) { fire(window, 'pageshow', Event); }
            // A resize is what makes a layout that measured itself while it believed it was
            // hidden measure itself again.
            fire(window, 'resize', Event);
        } finally {
            waking = false;
        }
    };
    window.__sotiReaderWake = fireWake;
    fireWake();
})();
