/* © 2026 Ayodeji Augustine. All rights reserved. Carried over from SOTI AI Analyser v9.8.6, whole, so the QA Tool's Copilot relay is the analyser's relay — with the QA Tool's own additions, each marked "(QA Tool addition)". */
/* ============================================================================
 * SOTI AI Analyser — Copilot Browser Bridge (relay content script)
 * ============================================================================
 * WHAT THIS IS
 * ----------------------------------------------------------------------------
 * The "no API key" path. Microsoft 365 Copilot has no public completions
 * endpoint — there is nowhere to POST a prompt to.
 * What it does have is a web app the engineer is already signed in to. This
 * script is injected INTO that tab, types the panel's prompt into the composer,
 * watches the answer render, and streams the text back to the side panel over
 * extension messaging. The user's existing SSO session does the authenticating,
 * so there is no key to configure and none to leak.
 *
 * Injected ON DEMAND (chrome.scripting.executeScript from ai-provider.js), never
 * declared in the manifest — so it does not run in anyone's Copilot tab unless
 * the bridge provider has been selected and the host permission granted.
 *
 * ----------------------------------------------------------------------------
 * HOW IT FINDS THE ANSWER — and why it is not a list of CSS selectors
 * ----------------------------------------------------------------------------
 * The obvious implementation is a table of selectors per site. It is also the
 * one that breaks every time a vendor ships a redesign, and it fails SILENTLY:
 * a selector that matches nothing returns empty text, which looks exactly like
 * "the model said nothing".
 *
 * So selectors are the FALLBACK here, not the mechanism. The primary strategy
 * knows nothing about any site's markup:
 *
 *   1. Before sending, start a MutationObserver over the whole document and
 *      remember every element that changes from this moment on.
 *   2. After sending, the answer is — by construction — among those elements.
 *      Narrow them by two structural facts that hold on every chat UI ever
 *      built, without naming a single class:
 *        · the answer is NOT inside the composer, and no ancestor of the
 *          composer is the answer (that excludes <body> and every page wrapper);
 *        · the answer does NOT contain the prompt we just sent (that excludes
 *          the user's own message bubble, and any wrapper holding both turns).
 *      Whatever is left with the most text IS the assistant's turn.
 *   3. Then tighten: descend into the largest child that still holds ~all of
 *      that text, which strips "Copy / Regenerate / Was this helpful" chrome
 *      off the edges without knowing those words.
 *
 * The prompt carries a distinctive "=== INSTRUCTIONS ===" header partly so step
 * 2's second test has something unambiguous to match on.
 *
 * ----------------------------------------------------------------------------
 * WHY IT IS EVENT-DRIVEN, NOT POLLED
 * ----------------------------------------------------------------------------
 * The relay tab runs in the BACKGROUND. Chrome clamps setTimeout/setInterval in
 * hidden tabs to roughly once per second and can freeze a tab that sits idle, so
 * a polling loop would crawl exactly when a long answer needs it least.
 * MutationObserver callbacks are not throttled that way, so the observer drives
 * the streaming and the timer exists only as a safety net.
 *
 * The waits that CANNOT be event-driven — "is the composer there yet", "has the
 * box emptied, so we know the message went" — take a second clock instead, ticked
 * in from a service worker that has no window and is therefore never throttled.
 * See A CLOCK THE BROWSER CANNOT SLOW DOWN below, and THE RELAY'S CLOCK in
 * background.js.
 *
 * ----------------------------------------------------------------------------
 * THE COMPOSER LIMIT IS NOT THE CONTEXT LIMIT
 * ----------------------------------------------------------------------------
 * A message box caps how much can be typed AT ONCE. A conversation caps nothing
 * — remembering what came before is the entire point of a chat UI. So a case too
 * big for the box is not too big for the model: the adapter splits it into PARTS
 * that each fit, sends them as consecutive messages, and only the last one asks a
 * question. Everything before it is reference material the model is already
 * holding. That is what turned a ~5,400-character prompt budget into an ~88,000
 * one without raising a single site's limit.
 *
 * Two rules make it safe rather than merely bigger. Every part must be ECHOED
 * back before the next is typed — a part the page silently dropped would leave a
 * hole in the case that nothing downstream could detect. And the page must go
 * IDLE between parts, because typing into a composer that is still streaming
 * loses the text without an error.
 *
 * ----------------------------------------------------------------------------
 * WHAT IT STILL CANNOT PROMISE
 * ----------------------------------------------------------------------------
 *  1. The conversation's own window is finite and invisible. Parts are counted
 *     and bounded so the total stays well inside it, but if a site compacts an
 *     early turn there is no way to see that from the DOM.
 *  2. The text is read back from RENDERED HTML. Markdown that re-renders mid
 *     stream can rewrite text already emitted — see reconcile() at the end of
 *     runRequest() for how that is handled and what it costs.
 *  3. Driving a chat UI programmatically is a different thing, contractually,
 *     from calling a documented API, and these prompts carry customer data.
 *     Check your organisation's acceptable-use terms.
 * ========================================================================== */
(function () {
    'use strict';

    /* =====================================================================
     * A CLOCK THE BROWSER CANNOT SLOW DOWN
     * =====================================================================
     * Everything below this block waits for something: for the composer to
     * mount, for the send control to come alive, for the box to empty so the
     * send can be PROVED, for the page to go idle between parts. Every one of
     * those waits is built on setTimeout, and setTimeout is the one thing about
     * a hidden page that cannot be lied to.
     *
     * Chrome clamps timers in a hidden page to roughly once a second, and after
     * the window has been hidden for five minutes it throttles them
     * INTENSIVELY — about once a minute. The liveness shim below can tell the
     * page it is visible, but the clamp is applied by the browser on the real
     * state of the window, not on what this script has persuaded the document
     * to report. So a fifteen-second wait for the composer would get one look at
     * the page and then declare there was nothing there; a four-second wait for
     * the composer to empty would time out on a message that had been sent
     * perfectly and fall through to pressing Enter at a site that ignores it.
     * Hovering the taskbar makes Chrome paint the window, which un-throttles
     * every timer at once — which is exactly the "then it all works" that was
     * reported.
     *
     * So the waits take a second clock as well as their own. The extension's
     * service worker has no window and is therefore never throttled; it ticks
     * this frame every 200ms (see THE RELAY'S CLOCK in background.js), and a
     * tick releases any wait whose time has genuinely come. Whichever clock
     * arrives first wins, so nothing changes on a page Chrome is painting
     * normally and nothing here depends on the pump being there.
     *
     * NOTHING IS EVER RELEASED EARLY. A tick only resolves a wait that has
     * already run its full duration in real time — the pump makes waits
     * accurate, it does not make them shorter.
     * =================================================================== */
    // Waits that are pending. Each is a function that resolves its own promise
    // if enough real time has passed; they remove themselves when they fire.
    const tickWaiters = new Set();
    // Animation-frame callbacks the compositor has not delivered — see the rAF
    // wrapper in installLivenessShim. Self-pruning: whichever clock runs the
    // callback first takes it out of here.
    const rafPending = new Set();

    function drainRafPending() {
        if (!rafPending.size) return 0;
        const due = [...rafPending];
        rafPending.clear();
        for (const cb of due) { try { cb(); } catch (e) { /* the page's problem */ } }
        return due.length;
    }

    /* =====================================================================
     * AND CHROME CAN DO WORSE THAN THROTTLE A PAGE — IT CAN FREEZE ONE
     * =====================================================================
     * Throttling makes a hidden page slow. FREEZING stops it altogether: no
     * timers, no observers, no message handlers, nothing until something makes
     * it visible again. A window that has been behind another one for five
     * minutes is a candidate, and a frozen relay is indistinguishable from
     * every other version of this fault — it sits there doing nothing, and the
     * moment the engineer touches the taskbar it does everything at once.
     *
     * A page holding a WEB LOCK is not frozen: Chrome tracks that as work in
     * progress and its freezing policy refuses to touch such a page. So one is
     * held for exactly as long as the extension is driving this page, and
     * dropped when the ticks stop — which is the honest signal for "there is a
     * request in flight here", and which keeps the lock off the Copilot tabs
     * the engineer opened for themselves.
     *
     * SHARED, deliberately. Web locks are per-origin, so an exclusive lock
     * would be held by whichever tab asked first and every other one would sit
     * in the queue holding nothing at all. A shared lock is held by all of them
     * at once, which is what is wanted: the flag is per-page.
     *
     * Entirely optional. An engine without navigator.locks, or a request that
     * is refused, leaves the rest of the clock working exactly as it does now.
     * =================================================================== */
    let releaseAwakeLock = null;
    let awakeLockIdle = null;

    function holdAwakeLock() {
        try {
            if (!navigator.locks || !navigator.locks.request) return;
            if (!releaseAwakeLock) {
                // The lock is held for as long as this promise is unresolved. Resolving
                // it is the release, so the resolver IS the handle.
                navigator.locks.request('soti-relay-awake', { mode: 'shared' },
                    () => new Promise(res => { releaseAwakeLock = res; })
                ).catch(() => { releaseAwakeLock = null; });
            }
            /* DROPPED WHEN THE DRIVING STOPS. The timer is clamped like every other in a
             * hidden page, so the release can be a minute late — which is the right way
             * round for it to be wrong: late means the page stays unfreezable a little
             * longer than it needed to, early would mean losing it mid-request. */
            clearTimeout(awakeLockIdle);
            awakeLockIdle = setTimeout(() => {
                try { if (releaseAwakeLock) releaseAwakeLock(); } catch (e) {}
                releaseAwakeLock = null;
            }, 30000);
        } catch (e) { /* no lock manager here; the rest of the clock is unaffected */ }
    }

    /* ONE BEAT. Runs the frames Chrome refused to deliver, releases the waits
     * that are due, re-arms the occlusion probe — whose own re-arming timer is
     * throttled just as hard as everything else, so without this it would stop
     * reporting and every quiet relay would look occluded — and renews the
     * claim that stops this page being frozen outright. */
    function onExternalTick() {
        holdAwakeLock();
        const frames = drainRafPending();
        for (const w of [...tickWaiters]) { try { w(); } catch (e) { /* its own promise */ } }
        try { if (typeof window.__sotiFrameProbe === 'function') window.__sotiFrameProbe(); } catch (e) {}
        return frames;
    }
    // Published so a later injection of this file can drive the FIRST injection's
    // waiters: the message listener is registered once, but the closure holding
    // these sets is the one that registered it.
    try { window.__sotiTick = onExternalTick; } catch (e) { /* sandboxed */ }

    /* =====================================================================
     * KEEPING THE RELAY AWAKE IN A WINDOW NOBODY IS LOOKING AT
     * =====================================================================
     * The reported symptom: the relay window sits there doing nothing, and the
     * moment you click it, everything it was supposed to have done happens at
     * once. That is not a race in this script — it is Chrome doing exactly what
     * it is designed to do to a window that is behind another one.
     *
     * A window that is minimized, or fully covered by other windows, is
     * OCCLUDED. Chrome then:
     *   · reports document.visibilityState as 'hidden', which an app shell like
     *     M365 Copilot reads as "the user has gone away" — so it stops
     *     rendering, stops mounting, and in places stops accepting input;
     *   · stops compositing, so requestAnimationFrame never fires and anything
     *     scheduled in one — which in a modern SPA is most layout work — simply
     *     does not run;
     *   · clamps timers, and after five minutes hidden clamps them hard.
     *
     * Clicking the window un-occludes it and all three reverse at once, which
     * is precisely the behaviour described.
     *
     * So the page is told it is visible and focused, and rAF is given a
     * fallback. None of this makes the window visible — it makes the page stop
     * CARING whether it is, which is the part that was breaking. The extension
     * side has its own escalation for the cases this cannot reach (see
     * reviveRelay in ai-provider.js).
     *
     * Scoped to the relay: this file is injected on demand, only into the
     * Copilot tab the bridge opened, and never declared in the manifest.
     * =================================================================== */
    function installLivenessShim() {
        if (window.__sotiRelayAwake) return false;
        window.__sotiRelayAwake = true;

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
         * Spoofing the property is not enough on its own: an app that has already been told
         * "you are hidden" has already torn things down, and one told it later tears them
         * down again regardless of what the property now says. Capture phase, so this runs
         * before any handler the page registered. 'freeze' and 'pagehide' are in the list
         * because Chrome's own lifecycle can fire them at a window left alone long enough,
         * and a frozen page is a relay that has stopped for good. */
        for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur', 'pagehide', 'freeze']) {
            const swallow = (e) => {
                // …EXCEPT THE ONES THIS SHIM FIRES ITSELF.
                //
                // The wake below re-dispatches visibilitychange precisely so an app that had
                // already torn itself down puts itself back together. Without this flag the
                // window-level capture listener eats it before it reaches the document, where
                // every app in the world listens for it — so the swallow silenced the one
                // event it exists to make room for, and the wake did nothing at all.
                if (window.__sotiWaking) return;
                // The relay's own code never listens for these; only the page does.
                e.stopImmediatePropagation();
            };
            window.addEventListener(type, swallow, true);
            document.addEventListener(type, swallow, true);
        }

        /* requestAnimationFrame DOES NOT FIRE IN AN OCCLUDED WINDOW.
         *
         * Anything the page deferred into one — mounting the composer, enabling the send
         * button after an input event, rendering a streamed token — waits for a frame that
         * is never painted. The callback is therefore ALSO scheduled on a timer, and
         * whichever arrives first wins; the loser is dropped by the `ran` guard, so a page
         * that is compositing normally sees no change in behaviour beyond one dead timer.
         *
         * 32ms rather than 16: a timer racing the real vsync at 16ms would win often enough
         * on a visible window to change when work runs, and this is a backstop, not a
         * replacement.
         *
         * AND THE 32ms TIMER IS ITSELF CLAMPED — which is why there is a third route. In a
         * hidden window that timer is a one-second timer, and in one that has been hidden
         * for five minutes it is a ONE-MINUTE timer, so the backstop was arriving far too
         * late to be one: an app that mounts its composer in an animation frame would take a
         * minute per frame to come up, which is the whole survey deadline spent on a single
         * step. The callback is therefore also queued for the extension's tick, which is not
         * throttled at all and arrives every 200ms. Whichever of the three fires first runs
         * the callback and removes it from the other two. */
        const rafNative = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
        if (rafNative) {
            window.requestAnimationFrame = function (cb) {
                let ran = false;
                let queued = null;
                const once = (t) => {
                    if (ran) return;
                    ran = true;
                    if (queued) { rafPending.delete(queued); queued = null; }
                    try { cb(t); } catch (e) { /* the page's problem */ }
                };
                const id = rafNative(once);
                queued = () => once(performance.now());
                rafPending.add(queued);
                setTimeout(() => once(performance.now()), 32);
                return id;
            };
        }

        /* WAKE WHATEVER ALREADY WENT TO SLEEP.
         *
         * The shim usually installs into a page that has been hidden since it loaded, so it
         * is not enough to stop future teardown — the app has to be told it is back. These
         * are the same events it would get from a real un-occlusion, in the same order.
         *
         * PUBLISHED ON `window` SO IT CAN BE FIRED AGAIN LATER. The install itself happens
         * once per document and returns early ever after, which used to mean the wake happened
         * once too — so every later attempt to revive a relay that had gone quiet re-ran a
         * function that did nothing. The extension side pings between injections precisely to
         * get this re-fired at an app that has since torn itself down; see the PING handler,
         * and primeRelay/injectAndConfirm in ai-provider.js. */
        const fireWakeEvents = () => {
            window.__sotiWaking = true;
            try {
                for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
                    try { document.dispatchEvent(new Event(type)); } catch (e) { /* older engine */ }
                }
                try { window.dispatchEvent(new Event('focus')); } catch (e) {}
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            } finally {
                // Cleared in a finally: a listener on the page that throws must not leave the
                // swallow permanently disabled, or the next real teardown event gets through.
                window.__sotiWaking = false;
            }
        };
        window.__sotiWake = fireWakeEvents;
        setTimeout(fireWakeEvents, 0);

        /* IS CHROME STILL NOT PAINTING THIS WINDOW?
         *
         * The spoof above makes document.visibilityState useless as an answer — which is the
         * point of it, and which leaves nothing on the page able to say whether the window is
         * genuinely occluded. The compositor can still say: a NATIVE animation frame is only
         * delivered to a window Chrome is actually painting. So one is requested every couple
         * of seconds and the arrival is stamped. A stamp that has stopped advancing means the
         * window is not being painted, whatever the page now believes.
         *
         * Requested from a TIMER rather than by chaining rAF to itself: a chained loop stops
         * dead the moment the window is occluded and has nothing left to restart it, which
         * would report "occluded" forever after the first time it ever was. */
        if (rafNative) {
            let probeTimer = null;
            let probedAt = 0;
            const probe = () => {
                probedAt = Date.now();
                try { rafNative(() => { window.__sotiLastFrameAt = Date.now(); }); } catch (e) {}
                // Cleared first so the tick below and this chain cannot accumulate two
                // pending probes, then a third, for as long as the relay is open.
                clearTimeout(probeTimer);
                probeTimer = setTimeout(probe, 2000);
            };
            /* AND RE-ARMED FROM THE EXTENSION'S TICK AS WELL. The re-arming timer above is
             * clamped like every other timer in a hidden page — to a minute, in the window
             * this measurement matters most in — so on its own it stops taking readings at
             * the exact moment the extension starts asking for them. A stale reading reads
             * as "not being painted", and the extension answers that by RAISING THE WINDOW:
             * the one escalation the engineer can feel, spent on a relay that was fine. */
            window.__sotiFrameProbe = () => { if (Date.now() - probedAt >= 2000) probe(); };
            window.__sotiLastFrameAt = Date.now();
            probe();
        }

        console.log('[SOTI Bridge] liveness shim installed — the page now believes it is visible and focused');
        return true;
    }

    // True when Chrome has not painted a frame for this window recently. 6s, against a 2s
    // probe, so a couple of missed frames on a busy machine is not reported as occlusion.
    function wasOccluded() {
        const at = window.__sotiLastFrameAt;
        if (!at) return false;                       // no probe running — nothing to claim
        return (Date.now() - at) > 6000;
    }

    // Runs on EVERY injection, before the install guard below, because a navigation or a
    // sign-in redirect gives the tab a fresh document with none of this on it — and that
    // document is the one that has to stay awake.
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        try { installLivenessShim(); } catch (e) { console.warn('[SOTI Bridge] liveness shim failed', e); }
    }

    // executeScript re-runs this file on every request. Install once; the listener
    // registered on the first pass keeps serving subsequent ones.
    if (typeof window !== 'undefined') {
        if (window.__sotiBridgeInstalled) return;
        window.__sotiBridgeInstalled = true;
        console.log('[SOTI Bridge] relay installed on', location.host);
    }

    /* ---------------------------------------------------------------------
     * Selector candidates. Used to FIND THE COMPOSER and the send/stop
     * controls (there is no structural trick for those — you have to type
     * somewhere specific). Answer extraction does not depend on them.
     * Settings can replace any list wholesale (msg.selectors).
     * ------------------------------------------------------------------- */
    const DEFAULT_SELECTORS = {
        // A CANDIDATE NET, not a priority list — see findComposer(). Deliberately wide,
        // because the attribute a rich editor uses is not predictable:
        // contenteditable="plaintext-only" is common and does NOT match
        // [contenteditable="true"], which is how a page with a perfectly visible message
        // box reports "no usable message box found".
        composer: [
            '#prompt-textarea',
            'textarea#userInput',
            'textarea[data-testid="composer-input"]',
            '[contenteditable="plaintext-only"]',
            '[contenteditable="true"]',
            '[contenteditable]:not([contenteditable="false"])',
            '[role="textbox"]',
            'textarea',
            'input[type="text"]',
            'input[type="search"]'
        ],
        // A NET, sorted by proximity to the composer at use — see submit(). Deliberately wide
        // and TAG-AGNOSTIC: M365 Copilot (copilot.cloud.microsoft) renders its composer as a
        // custom SPAN#m365-chat-editor-target-element, and its send control is not always a
        // <button> carrying "Send" in aria-label — it can be a [role="button"], or an icon
        // button identified only by id or data-testid. The id/testid matches also survive a UI
        // language change, which an aria-label match does not. When none of these hit, submit()
        // falls back to a shape-based search (heuristicSend) before giving up.
        send: [
            'button[data-testid="send-button"]',
            'button[data-testid="submit-button"]',
            '[data-testid="send-button"]',
            '[data-testid*="send" i]',
            '[id*="send-button" i]',
            'button[id*="send" i]',
            '[role="button"][id*="send" i]',
            'button[aria-label*="Send" i]',
            '[role="button"][aria-label*="Send" i]',
            '[aria-label*="Send" i]',
            'button[title*="Send" i]',
            '[title*="Send" i]',
            'button[type="submit"]'
        ],
        stop: [
            'button[data-testid="stop-button"]',
            '[data-testid="stop-button"]',
            '[data-testid*="stop" i]',
            'button[aria-label*="Stop" i]',
            '[role="button"][aria-label*="Stop" i]',
            '[aria-label*="Stop" i]',
            'button[title*="Stop" i]'
        ],
        // WHERE A FILE GOES IN. Deliberately not narrowed to a testid: the upload input is
        // the one element on a chat page that is reliably HIDDEN (the visible control is a
        // button that forwards a click to it), so it is found by type and filtered by what
        // it says it accepts — never by visible(), which rejects every one of them.
        fileInput: [
            'input[type="file"]'
        ],
        // The chip a pending upload renders, and its remove control. Clearing these before
        // attaching is not tidiness: an attachment survives "New chat" on M365 Copilot, so
        // a bundle from the previous case would silently join the next one's evidence.
        removeAttachment: [
            'button[aria-label^="Remove attachment" i]',
            'button[aria-label*="Remove attachment" i]',
            'button[title*="Remove attachment" i]',
            // Other wordings for the same control (2026-11-18): "Remove file", "Delete file", "Remove <name>.txt".
            'button[aria-label*="Remove file" i]',
            'button[aria-label*="Delete file" i]',
            'button[aria-label*="Remove uploaded" i]',
            'button[aria-label^="Remove" i][aria-label*=".txt" i]',
            'button[aria-label^="Remove" i][aria-label*=".log" i]',
            // Pictures (2026-11-20). An image chip reads "Remove Picture14.png" and matched none of the above, so an
            // image the site would not send could never be taken back out: it stayed in the composer, Send stayed
            // greyed out with "Remove attachments to send", and the text fallback was blocked by it too.
            'button[aria-label^="Remove" i][aria-label*=".png" i]',
            'button[aria-label^="Remove" i][aria-label*=".jpg" i]',
            'button[aria-label^="Remove" i][aria-label*=".jpeg" i]',
            'button[aria-label^="Remove" i][aria-label*=".gif" i]',
            'button[aria-label^="Remove" i][aria-label*=".bmp" i]',
            'button[aria-label^="Remove" i][aria-label*=".webp" i]',
            'button[aria-label^="Remove" i][aria-label*=".jfif" i]'
        ],
        // Optional. When one of these matches it is preferred over the heuristic,
        // because a selector that IS right is more precise than any inference.
        assistant: [
            '[data-message-author-role="assistant"]',
            '.font-claude-message',
            '[data-content="ai-message"]'
        ]
    };

    let SELECTORS = DEFAULT_SELECTORS;

    /* ---------------------------------------------------------------------
     * DOM helpers
     * ------------------------------------------------------------------- */
    function visible(el) {
        if (!el || !el.isConnected || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
    }

    // Can text actually be put into this element? Asked of the LIVE element, not of its
    // markup: el.isContentEditable is true for contenteditable="plaintext-only" and for a
    // child of an editable host, both of which an attribute selector misses.
    function typeable(el) {
        if (!visible(el)) return false;
        if (el.disabled || el.readOnly) return false;
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName === 'INPUT') return /^(text|search|)$/i.test(el.type || '');
        return !!el.isContentEditable;
    }

    // THE composer, chosen the same way the provider layer chooses the frame: the WIDEST
    // visible typeable element. Ordered selector lists are what let the two disagree — the
    // frame hunt would find a box by one rule and the relay would fail to find it by
    // another, in the same frame, and blame the user's sign-in. One rule, one answer.
    // Width is the discriminator because a chat composer spans its column while the search
    // and filter inputs an app shell carries do not.
    function findComposer(list) {
        let best = null;
        for (const sel of list) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
            for (const el of nodes) {
                if (!typeable(el)) continue;
                const w = el.getBoundingClientRect().width;
                if (!best || w > best.width) best = { el, selector: sel, width: Math.round(w) };
            }
        }
        return best;
    }

    function pick(list, test) {
        const check = test || visible;
        for (const sel of list) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
            // Last match wins: chat UIs keep the live composer at the end of the DOM,
            // and stale/off-screen duplicates earlier in it.
            for (let i = nodes.length - 1; i >= 0; i--) {
                if (check(nodes[i])) return { el: nodes[i], selector: sel };
            }
        }
        return null;
    }

    function pickAll(list) {
        for (const sel of list) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
            const vis = [...nodes].filter(visible);
            if (vis.length) return { els: vis, selector: sel };
        }
        return { els: [], selector: '' };
    }

    /* EVERY WAIT IN THIS FILE GOES THROUGH HERE, and it takes two clocks.
     *
     * The page's own timer is the first, and in a window Chrome is not painting it is
     * clamped to a second — a minute, once that window has been hidden for five of them.
     * The extension's tick is the second, and it is never throttled, because it comes from
     * a service worker that has no window to be hidden. See A CLOCK THE BROWSER CANNOT SLOW
     * DOWN at the top of this file.
     *
     * The tick can only ever make a wait FINISH ON TIME. It carries no duration of its own:
     * it asks "has this one's time actually passed?" and moves on if it has not. So a wait
     * for 4 seconds is at least 4 seconds whichever clock releases it, and a page with no
     * pump behind it behaves exactly as it did before. */
    const sleep = (ms) => new Promise(resolve => {
        const start = Date.now();
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            tickWaiters.delete(onTick);
            resolve();
        };
        const onTick = () => { if (Date.now() - start >= ms) finish(); };
        tickWaiters.add(onTick);
        setTimeout(finish, ms);
    });
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    async function waitFor(fn, timeoutMs, stepMs = 150) {
        const until = Date.now() + timeoutMs;
        for (;;) {
            const v = fn();
            if (v) return v;
            if (Date.now() >= until) return null;
            await sleep(stepMs);
        }
    }

    /* ---------------------------------------------------------------------
     * ATTACHING THE CASE AS A FILE INSTEAD OF TYPING IT
     * ---------------------------------------------------------------------
     * The composer limit is what forced the multi-part design above. An UPLOAD has no
     * such limit worth speaking of — a megabyte of log goes in as one file where the
     * same text would have been twelve messages, and the model still reads all of it.
     *
     * A ZIP cannot be handed over directly: M365 Copilot's upload input lists .txt,
     * .log, .json, .xml and friends and does NOT list .zip or .har. That is why the
     * panel flattens a bundle into ONE .txt carrying every inner file behind
     * "=== FILE: <path> ===" markers — the same markers the prompt already uses, and
     * the model attributes findings to the right inner file from them.
     *
     * Three things make this safe rather than merely bigger:
     *  · the input is HIDDEN, so it is found by type and by what it accepts, never by
     *    visible();
     *  · anything already attached is REMOVED first — an attachment outlives "New
     *    chat" here, so last case's bundle would otherwise join this one's evidence;
     *  · the upload must FINISH before anything is typed. Sending while a chip is
     *    still spinning submits the question without the evidence, and the answer that
     *    comes back looks like a considered one.
     * ------------------------------------------------------------------- */

    // Does this input take THIS file? An empty accept means "anything". A populated one is
    // honoured, because a page may carry a second, image-only input and pushing a .txt into
    // that one fails silently.
    //
    // Every test must be about the file in hand. An earlier version matched the bare token
    // "text/plain" wherever it appeared in the list, which made the function answer TRUE for
    // bundle.zip and net.har on a Copilot input that lists neither — it was really reporting
    // "this input takes text files at all". A check that cannot say no is not a check.
    function acceptsFile(input, filename, mime) {
        const raw = (input.getAttribute('accept') || '').trim();
        if (!raw) return true;
        const ext = '.' + String(filename || '').split('.').pop().toLowerCase();
        const type = String(mime || '').toLowerCase();
        const group = type ? type.split('/')[0] + '/*' : '';
        return raw.toLowerCase().split(',').map(s => s.trim()).filter(Boolean).some(t =>
            t === '*' || t === '*/*' || t === ext || (type && (t === type || t === group))
        );
    }

    /* HOW FIRMLY AN INPUT CLAIMS THIS FILE (2026-11-19). M365 Copilot now carries TWO file inputs: the
     * composer's own (#upload-file-button, whose accept list names .log, .txt and the rest) and, after it in
     * the DOM, a second one with NO accept list ("Upload files (PDF, Word, Excel, images)"). An empty accept
     * passes acceptsFile, and "last match wins" then picked the second one every time. Copilot takes a file
     * through it, draws the chip as "Text file", and then greys out Send with "Remove attachments to send" —
     * the attachment is there and can never be sent. Reproduced on copilot.cloud.microsoft with a 60-byte
     * .log: second input → blocked; #upload-file-button → uploads to OneDrive and sends, for .log and .txt
     * alike. So an input that NAMES the file outranks one that merely does not refuse it.
     *   3 — lists the file's extension     2 — lists its exact MIME type
     *   1 — a wildcard or a type group     0 — no accept list at all */
    function acceptRank(input, filename, mime) {
        const raw = (input.getAttribute('accept') || '').trim().toLowerCase();
        if (!raw) return 0;
        const ext = '.' + String(filename || '').split('.').pop().toLowerCase();
        const type = String(mime || '').toLowerCase();
        const list = raw.split(',').map(s => s.trim()).filter(Boolean);
        if (list.includes(ext)) return 3;
        if (type && list.includes(type)) return 2;
        return 1;
    }

    // Every usable input in this document, best first: firmest claim on the file, then multi-file, then the
    // later one (for the same reason it is in pick(): the live control sits at the end).
    function findFileInputsIn(doc, filename, mime) {
        const out = [];
        for (const sel of SELECTORS.fileInput) {
            let nodes;
            try { nodes = doc.querySelectorAll(sel); } catch (e) { continue; }
            [...nodes].forEach((el, order) => {
                if (el.disabled || !acceptsFile(el, filename, mime) || out.some(h => h.el === el)) return;
                out.push({ el, selector: sel, accept: el.getAttribute('accept') || '', rank: acceptRank(el, filename, mime), order });
            });
        }
        return out.sort((a, b) => (b.rank - a.rank) || ((b.el.multiple ? 1 : 0) - (a.el.multiple ? 1 : 0)) || (b.order - a.order));
    }

    function findFileInputIn(doc, filename, mime) {
        return findFileInputsIn(doc, filename, mime)[0] || null;
    }

    // Every document this frame can legally touch. The relay is injected into ALL frames and
    // the provider then picks the one holding the composer — which is not guaranteed to be
    // the one holding the upload control. Looking only at `document` is what reported
    // "Inputs present: none" on a page that visibly has a paperclip. Cross-origin frames
    // throw on access; that is expected, not an error.
    function reachableDocs() {
        const docs = [document];
        const add = (d) => { if (d && !docs.includes(d)) docs.push(d); };
        try { if (window.top && window.top !== window.self) add(window.top.document); } catch (e) { /* cross-origin */ }
        try {
            for (const f of document.querySelectorAll('iframe,frame')) {
                try { add(f.contentDocument); } catch (e) { /* cross-origin */ }
            }
        } catch (e) { /* no frames */ }
        return docs;
    }

    function findFileInputs(filename, mime) {
        return reachableDocs().flatMap(doc => findFileInputsIn(doc, filename, mime));
    }

    // For a diagnostic: which input this was, in words an engineer can find in DevTools.
    function describeInput(hit) {
        const el = hit && hit.el;
        if (!el) return 'an unknown input';
        if (el.id) return `#${el.id}`;
        const label = el.getAttribute('aria-label');
        if (label) return `the input labelled "${label.slice(0, 60)}"`;
        return hit.accept ? `an input accepting "${hit.accept.slice(0, 40)}…"` : 'an input with no accept list';
    }

    // The best input across every reachable document; on a tie, the first document's (this frame's own).
    function findFileInput(filename, mime) {
        const all = findFileInputs(filename, mime);
        if (!all.length) return null;
        const best = Math.max(...all.map(h => h.rank));
        return all.find(h => h.rank === best);
    }

    /* THE SITE TOOK THE FILE AND WILL NOT SEND IT (2026-11-19). A chip with a remove button proves the page
     * took the file; it does not prove the page will send it. M365 Copilot says so in words under the
     * composer — "Remove attachments to send" — while Send stays disabled. Read only to decide; never clicked. */
    const ATTACH_BLOCKED_RE = /remove (the )?attachments? to send|can['’]t send (with )?(these|this) (files?|attachments?)/i;
    function attachBlocked() {
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const t = walker.currentNode.nodeValue || '';
                if (t.length > 200 || !ATTACH_BLOCKED_RE.test(t)) continue;
                const el = walker.currentNode.parentElement;
                if (el && visible(el) && !el.closest('[contenteditable="true"],textarea,input')) return true;
            }
            for (const el of document.querySelectorAll('[aria-label],[title]')) {
                const a = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
                if (ATTACH_BLOCKED_RE.test(a) && visible(el)) return true;
            }
        } catch (e) { /* not readable — not blocked as far as we can tell */ }
        return false;
    }

    // Some chat UIs mount the upload input only once its menu has been opened. Clicking the
    // visible control is the documented way to get there, so when nothing is in the DOM yet
    // it is worth one click — and worth undoing, because a menu left hanging open swallows
    // the keystrokes the composer is about to receive.
    function revealUploadControl() {
        const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')).toLowerCase();
        const btn = [...document.querySelectorAll('button')]
            .filter(visible)
            .find(b => /(add|attach|upload|insert).*(file|source|attachment)|^\s*\+\s*$/.test(label(b)));
        if (!btn) return false;
        try { btn.click(); } catch (e) { return false; }
        return true;
    }

    function dismissRevealedMenu() {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            document.body && document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch (e) { /* nothing to close */ }
    }

    /* PROOF THAT THE PAGE TOOK THE FILE, WITHOUT DEPENDING ON ONE BUTTON'S WORDING (2026-11-18). A Global colleague on
     * copilot.cloud.microsoft, since the Microsoft outage of the Friday before: "accepted the file into its upload control but
     * never showed it as attached (waited 20s for 2 attachment chips…)" — and the case then went as 89,000 characters of text
     * the site would not send. The upload is proven by a "Remove attachment" button per file, and a site that renames that
     * button (or shows the chip without one) made every upload look failed. Also accepted now: the file's own NAME appearing
     * on the page where it was not before (a chip, its label, its title), counted against how often it was there already.
     * Only the CASE file has to be proven: an extra reference file the site would not take does not sink the case. Used only
     * to decide that the file is there, never to click anything. */
    function nameShownCount(name) {
        const base = String(name || '').trim();
        if (base.length < 5) return 0;
        const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '');
        let n = 0;
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const t = walker.currentNode.nodeValue || '';
                if (!t.includes(base) && !(stem.length >= 8 && t.includes(stem))) continue;
                const el = walker.currentNode.parentElement;
                if (el && visible(el) && !el.closest('[contenteditable="true"],textarea,input')) n++;
            }
            for (const el of document.querySelectorAll('[aria-label],[title]')) {
                const a = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
                if ((a.includes(base) || (stem.length >= 8 && a.includes(stem))) && visible(el) && !el.closest('[contenteditable="true"],textarea')) n++;
            }
        } catch (e) { /* not counted */ }
        return n;
    }

    /* EVERY CHIP, NOT THE FIRST KIND FOUND (2026-11-20). This returned the matches of the first selector that
     * matched anything, so with a .log and a .png attached it saw the two .log chips and never the picture —
     * a picture it then could not clear, count or wait on. Now the union of every selector, plus a button named
     * "Remove <file>" for each file this relay is attaching right now, whatever its extension. */
    let ATTACHING_NAMES = [];
    function attachmentRemovers() {
        const out = new Set();
        for (const sel of SELECTORS.removeAttachment) {
            try { document.querySelectorAll(sel).forEach(n => out.add(n)); } catch (e) { /* bad selector */ }
        }
        if (ATTACHING_NAMES.length) {
            for (const b of document.querySelectorAll('button[aria-label^="Remove" i]')) {
                const a = (b.getAttribute('aria-label') || '').toLowerCase();
                if (ATTACHING_NAMES.some(n => a.startsWith('remove ' + n))) out.add(b);
            }
        }
        return [...out];
    }

    // Is an upload still in flight? Scoped to the chip's own container rather than the
    // document: a chat page has other progress indicators (the answer streaming, for one)
    // and treating those as "upload busy" would wait forever.
    function attachmentsBusy() {
        const chips = attachmentRemovers();
        if (!chips.length) return false;
        return chips.some(btn => {
            const box = btn.closest('li,[class*="attach" i],[data-testid],div');
            if (!box) return false;
            if (box.querySelector('[role="progressbar"]')) return true;
            if (box.getAttribute('aria-busy') === 'true' || box.querySelector('[aria-busy="true"]')) return true;
            return /progress|spinner|uploading|loading/i.test(box.className + ' ' + box.innerHTML.slice(0, 600));
        });
    }

    async function clearAttachments(timeoutMs = 8000) {
        const until = Date.now() + timeoutMs;
        let removed = 0;
        while (Date.now() < until) {
            const chips = attachmentRemovers();
            if (!chips.length) break;
            const before = chips.length;
            try { chips[0].click(); } catch (e) { /* re-rendered under us */ }
            removed++;
            // The list re-renders on every removal, so the handles gathered a moment ago
            // are stale. Re-read rather than iterating the array we started with.
            await waitFor(() => attachmentRemovers().length < before, 2500, 120);
        }
        return { removed, left: attachmentRemovers().length };
    }

    /* Put files into the page's upload input.
     * `specs` is [{ name, text, type }]. Returns a diagnostic string; throws a plain
     * Error whose message is safe to show the engineer. */
    // What one upload may carry. Three is M365 Copilot's published limit and the lowest of
    // the sites this relay drives, so it is the safe default; a caller that knows better can
    // raise it. Overriding it does not raise the SITE's limit — it only changes where this
    // trims, and trimming here is what keeps an over-large batch from failing wholesale.
    const MAX_ATTACHMENTS = 3;

    /* THE PIECES OF AN OVERSIZED CASE FILE, held between their delivery and the request that
     * uses them. requestId → (slot → [piece, piece, …]).
     *
     * Swept on every arrival rather than on a timer: a buffer whose request never came (the
     * panel was closed, the tab reloaded mid-handover) would otherwise hold tens of megabytes
     * in the page for as long as the tab lives. Ten minutes is far longer than a handover
     * takes and far shorter than a browsing session. */
    const ATTACH_BUFFER = new Map();
    const ATTACH_BUFFER_TTL_MS = 600000;
    const ATTACH_BUFFER_SEEN = new Map();
    function sweepAttachBuffer(touchId) {
        const now = Date.now();
        if (touchId) ATTACH_BUFFER_SEEN.set(touchId, now);
        for (const [id, at] of [...ATTACH_BUFFER_SEEN]) {
            if (now - at <= ATTACH_BUFFER_TTL_MS) continue;
            ATTACH_BUFFER_SEEN.delete(id);
            ATTACH_BUFFER.delete(id);
        }
    }
    function releaseAttachBuffer(requestId) {
        ATTACH_BUFFER.delete(requestId);
        ATTACH_BUFFER_SEEN.delete(requestId);
    }

    /* A base64 payload — an image delivered as data rather than text — becomes the actual
     * bytes. The relay runs in the page's own world, where atob is available; a File wants a
     * byte view, not the base64 string, or the upload control would receive the text of the
     * encoding instead of the picture. Whitespace is stripped because a data URL occasionally
     * wraps its payload. */
    function b64ToBytes(b64) {
        const clean = String(b64 == null ? '' : b64).replace(/\s+/g, '');
        const bin = atob(clean);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    /* Put the delivered pieces back together into the attachment specs attachFiles expects.
     *
     * A descriptor that declares `chunks` MUST find that many pieces. A short reassembly is
     * a truncated log bundle, and a truncated log bundle that reads as a whole one is the
     * single worst thing this path can produce — the model would answer "that error does not
     * appear in the logs" about a file whose second half never arrived. So it throws, the
     * caller falls back to the text layout, and the reason is reported. */
    function reassembleAttachments(requestId, specs) {
        const list = Array.isArray(specs) ? specs : [];
        const slots = ATTACH_BUFFER.get(requestId);
        return list.map((a, i) => {
            if (!a || !a.chunks) return a;
            const pieces = (slots && slots.get(i)) || [];
            const have = pieces.filter(x => typeof x === 'string').length;
            if (have !== a.chunks) {
                throw new Error(`the case file "${a.name}" arrived in ${have} of ${a.chunks} parts, so it would have been uploaded incomplete`);
            }
            const text = pieces.join('');
            if (a.chars != null && text.length !== a.chars) {
                throw new Error(`the case file "${a.name}" reassembled to ${text.length.toLocaleString()} characters instead of ${Number(a.chars).toLocaleString()}`);
            }
            // `encoding` rides through reassembly: a chunked image is base64 text on the wire
            // and must still be decoded to bytes when the File is built, exactly like one that
            // was small enough to arrive whole.
            return { name: a.name, type: a.type, text, encoding: a.encoding };
        });
    }

    async function attachFiles(specs, timeoutMs = 120000, maxFiles = MAX_ATTACHMENTS) {
        const list = (specs || []).filter(s => s && s.name);
        if (!list.length) return 'nothing to attach';

        const name = list[0].name;
        const mime = list[0].type || 'text/plain';

        // WAIT FOR IT. This was a single synchronous look, and it was the only step in the
        // whole relay that did not wait for what it needed — which is exactly how it failed
        // in the field: the request is handled the moment the script is injected, the app
        // shell mounts the composer before it mounts the composer's toolbar, and the one
        // glance landed in the gap. It reported "Inputs present: none" about a page that had
        // a perfectly good paperclip a second later.
        let found = findFileInput(name, mime);
        if (!found) found = await waitFor(() => findFileInput(name, mime), 15000, 250);

        // Still nothing: the control may be behind a menu. One click, then look again, then
        // put the menu away whatever the outcome.
        let revealed = false;
        if (!found && revealUploadControl()) {
            revealed = true;
            found = await waitFor(() => findFileInput(name, mime), 5000, 200);
            if (!found) dismissRevealedMenu();
        }

        if (!found) {
            const seen = reachableDocs()
                .flatMap(d => { try { return [...d.querySelectorAll('input[type="file"]')]; } catch (e) { return []; } })
                .map(i => `accept="${(i.getAttribute('accept') || '').slice(0, 60)}"${i.disabled ? ' (disabled)' : ''}`)
                .join('; ') || 'none';
            throw new Error(
                `${location.host} has no file-upload input that accepts "${name}" (waited 15s${revealed ? ', and tried opening the attach menu' : ''}; ` +
                `searched ${reachableDocs().length} same-origin document(s)). Inputs present: ${seen}. ` +
                `The case will be sent as text instead.`);
        }
        if (revealed) dismissRevealedMenu();

        /* AN INPUT THAT DOES NOT NAME THE FILE IS A LAST RESORT, SO DO NOT SETTLE FOR ONE EARLY (2026-11-20).
         * On a fresh copilot.cloud.microsoft chat the accept-less "Upload files (PDF, Word, Excel, images)"
         * input mounts about 0.9s BEFORE the composer's own #upload-file-button (measured: 1015ms vs 1885ms
         * after load). The first look above lands in that gap whenever the request is quick to build — a
         * screenshot and a question, typically, where a log run spends seconds preparing first — and the
         * picture went into the input whose uploads Copilot will not send. Wait for one that lists the
         * file; open the attach menu once if none comes; only then fall back to what was found. */
        if (found.rank === 0) {
            let better = await waitFor(() => { const h = findFileInput(name, mime); return h && h.rank > 0 ? h : null; }, 6000, 200);
            if (!better && revealUploadControl()) {
                better = await waitFor(() => { const h = findFileInput(name, mime); return h && h.rank > 0 ? h : null; }, 3000, 200);
                dismissRevealedMenu();
            }
            if (better) found = better;
        }

        // The FIRST file chose the input; the rest are extras (product reference alongside
        // the case). An extra the input will not take is dropped rather than allowed to sink
        // the whole attach — losing a reference file costs a worse answer, losing the case
        // material costs the answer entirely.
        const dropped = [];
        let usable = list.filter((s, i) => {
            if (i === 0) return true;
            if (acceptsFile(found.el, s.name, s.type || 'text/plain')) return true;
            dropped.push(s.name);
            return false;
        });

        // A HARD CEILING ON HOW MANY FILES GO AT ONCE. M365 Copilot allows three and rejects
        // the ENTIRE batch when given more — "The number of files you are trying to add
        // exceeds the maximum limit" — so one reference file too many does not cost you the
        // reference, it costs you the case. Trimming from the END keeps the case material,
        // which is always first and is the only file findings may be cited against.
        const ceiling = Math.max(1, maxFiles || MAX_ATTACHMENTS);
        if (usable.length > ceiling) {
            for (const s of usable.slice(ceiling)) dropped.push(s.name + ' (over this site\'s file limit)');
            usable = usable.slice(0, ceiling);
        }

        // What this run is attaching, so its own chips are recognised by name whatever their extension (see
        // attachmentRemovers). Kept after the call returns: the caller's clean-up on a failed send needs it too.
        ATTACHING_NAMES = usable.map(s => String(s.name || '').toLowerCase()).filter(n => n.length >= 3);
        const cleared = await clearAttachments();

        const makeTransfer = () => {
            const t = new DataTransfer();
            for (const s of usable) {
                // A base64 spec is a picture (or any binary): decode it to bytes so the File
                // holds the image, not the text of its encoding. Everything else is text —
                // a case bundle or a reference file — and rides as a UTF-8 string as before.
                if (s && s.encoding === 'base64') {
                    t.items.add(new File([b64ToBytes(s.text)], s.name, { type: s.type || 'application/octet-stream' }));
                } else {
                    t.items.add(new File([s.text == null ? '' : String(s.text)], s.name, { type: s.type || 'text/plain' }));
                }
            }
            return t;
        };

        // How often each file's name is on the page already (an earlier chip, an earlier message), so only a NEW one counts.
        const shownBefore = usable.map(s => nameShownCount(s.name));
        const caseShown = () => nameShownCount(usable[0].name) > shownBefore[0];
        const removersBefore = attachmentRemovers().length;
        // Attached: a chip per file (as before), or the case file proven by a new chip or its name now on the page.
        const proven = () => attachmentRemovers().length >= usable.length || (attachmentRemovers().length > removersBefore) || caseShown();
        const dt = makeTransfer();
        found.el.files = dt.files;
        // Both events, in this order: some frameworks listen for one and some the other,
        // and a change the page never hears leaves an input holding a file nobody uploads.
        found.el.dispatchEvent(new Event('input', { bubbles: true }));
        found.el.dispatchEvent(new Event('change', { bubbles: true }));

        // The chip appearing proves the page took the file; the chip going quiet proves the
        // upload finished. Both are needed — the first alone is true one frame after the
        // drop, while the bytes are still going up.
        let appeared = await waitFor(proven, 20000, 200);

        // A SECOND, INDEPENDENT ROUTE. Assigning `input.files` is the direct way in, but it
        // is not the only one a chat UI understands, and it is the one most exposed to the
        // extension boundary: the relay runs in an isolated world, and a page that ignores
        // the resulting change event leaves an input holding a file nobody uploads. Dropping
        // and pasting go through the composer's own handlers instead, which are the paths a
        // human uses. Cheap to try, and it costs nothing when the first route worked.
        let via = 'input.files';
        if (!appeared) {
            const target = findComposer(SELECTORS.composer);
            const el = target ? target.el : document.body;
            const fire = (type, init) => {
                try { el.dispatchEvent(new (type === 'paste' ? ClipboardEvent : DragEvent)(type, init)); } catch (e) { /* unsupported */ }
            };
            const t1 = makeTransfer();
            fire('paste', { bubbles: true, cancelable: true, clipboardData: t1 });
            appeared = await waitFor(proven, 6000, 200);
            if (appeared) via = 'paste';
        }
        if (!appeared) {
            const target = findComposer(SELECTORS.composer);
            const el = target ? target.el : document.body;
            const t2 = makeTransfer();
            for (const type of ['dragenter', 'dragover', 'drop']) {
                try { el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: t2 })); } catch (e) { /* unsupported */ }
            }
            appeared = await waitFor(proven, 6000, 200);
            if (appeared) via = 'drop';
        }

        if (!appeared) {
            throw new Error(
                `${location.host} accepted the file into its upload control but never showed it as attached ` +
                `(waited 20s for ${usable.length} attachment chip${usable.length === 1 ? '' : 's'}, then retried by paste and by drop). ` +
                `The case will be sent as text instead.`);
        }

        const settled = await waitFor(() => !attachmentsBusy(), timeoutMs, 250);
        if (!settled) {
            throw new Error(
                `The upload of ${usable.map(s => s.name).join(', ')} did not finish within ${Math.round(timeoutMs / 1000)}s on ${location.host}. ` +
                `Sending now would ask the question without the evidence, so the case will be sent as text instead.`);
        }

        /* ATTACHED IS NOT SENDABLE (2026-11-19). If the site now says "Remove attachments to send", the input
         * that took the file is one whose uploads this composer will not send (see acceptRank). Take the file
         * back out and offer it to the next input, best first; only if every one of them ends the same way is
         * it an error — and the chips are cleared then too, or the text fallback would meet the same grey Send. */
        if (await waitFor(attachBlocked, 1500, 150)) {
            const refusedBy = [describeInput(found)];
            let rescued = false;
            // The other input may not be mounted yet (the composer's own mounts after the accept-less one), so
            // give it a few seconds to appear rather than concluding there is nothing else to try.
            const others = () => findFileInputs(name, mime).filter(h => h.el !== found.el);
            const alts = others().length ? others() : ((await waitFor(() => others().length > 0, 5000, 200)) ? others() : []);
            for (const alt of alts) {
                await clearAttachments();
                const chipsBefore = attachmentRemovers().length;
                alt.el.files = makeTransfer().files;
                alt.el.dispatchEvent(new Event('input', { bubbles: true }));
                alt.el.dispatchEvent(new Event('change', { bubbles: true }));
                const took = await waitFor(() => attachmentRemovers().length > chipsBefore || caseShown(), 20000, 200);
                if (took && await waitFor(() => !attachmentsBusy(), timeoutMs, 250) && !(await waitFor(attachBlocked, 1500, 150))) {
                    found = alt;
                    via = `input.files (${describeInput(alt)}, after ${refusedBy.join(', ')} was refused)`;
                    rescued = true;
                    break;
                }
                refusedBy.push(describeInput(alt));
            }
            if (!rescued) {
                await clearAttachments();
                throw new Error(
                    `${location.host} took the file but then would not send it ("Remove attachments to send"), through every ` +
                    `upload input it has (${refusedBy.join('; ')}). The case will be sent as text instead.`);
            }
        }

        // A base64 image is reported by its DECODED size — the picture is three quarters of
        // its encoding — while text files are reported by their character count as before.
        const bytes = usable.reduce((n, s) => n + (s && s.encoding === 'base64'
            ? Math.floor(String(s.text || '').replace(/\s+/g, '').length * 3 / 4)
            : String(s.text || '').length), 0);
        return `${usable.length} file${usable.length === 1 ? '' : 's'} (${bytes.toLocaleString()} bytes) via ${via}` +
               (cleared.removed ? `, ${cleared.removed} stale attachment(s) removed` : '') +
               (dropped.length ? `, ${dropped.length} not accepted by this site and skipped (${dropped.join(', ')})` : '');
    }

    /* ---------------------------------------------------------------------
     * Typing into the composer
     * ---------------------------------------------------------------------
     * Both shapes need care. A React-controlled <textarea> ignores a plain
     * `el.value = x` because React tracks the value on its own descriptor, so
     * the native setter has to be called explicitly before the input event. A
     * rich editor (ProseMirror / Lexical) has no value at all and rebuilds its
     * document from beforeinput events — execCommand('insertText') is the one
     * API that produces those faithfully, and it inserts newlines WITHOUT the
     * Enter keydown that would submit the prompt half-written.
     * ------------------------------------------------------------------- */
    /* TYPED ONCE, WITH ITS LINE BREAKS — the duplicate prompt (Beta 9.6.2, second fix).
     *
     * M365 Copilot's message box is a rich editor that keeps its own copy of the text. Two
     * things about it put the request in the box two, three, four times:
     *   · it reports execCommand('insertText') as not done, shows the text a moment later,
     *     and loses its line breaks;
     *   · it puts back text that is deleted from outside it, so "empty the box, then try
     *     another way" did not empty it, and every further try added another copy.
     *
     * So the rule now is ONE WAY CHANGES THE BOX, ONCE:
     *   1. A paste of the text over everything in the box. Rich editors (this one, ProseMirror,
     *      Lexical) take a paste whole, line breaks included, and a paste REPLACES what is
     *      selected, so whatever was left in the box goes with it.
     *   2. Only if the paste changed nothing: insertText (a plain editable box).
     *   3. Only if that changed nothing either: line by line, then textContent.
     * As soon as one way has changed the box, nothing is typed again on top of it. If it holds
     * every word but lost its line breaks, that is kept: one copy without breaks is still the
     * request; two copies is not. deliver() then checks the box holds the request once.
     * ------------------------------------------------------------------- */
    const composerHeld = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? (el.value || '') : (el.innerText || '');
    // Every word and every break between words: "Analyser\nI'm" read back as "AnalyserI'm" is not exact.
    const holdsExactly = (el, text) => norm(composerHeld(el)) === norm(text);
    // Every character, line breaks and curly quotes aside.
    const squash = (s) => String(s || '').replace(/[\s ​‌‍﻿]+/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    // How many times the box holds the start of the request: 2 means it is in there twice.
    const timesHeld = (el, text) => {
        const h = squash(composerHeld(el)), k = squash(text).slice(0, 60);
        if (!k) return 0;
        let n = 0, i = 0;
        while ((i = h.indexOf(k, i)) >= 0) { n++; i += k.length; }
        return n;
    };
    const selectAllIn = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    };
    const pasteInto = (el, text) => {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    };
    // Wait until the box holds the text, or has changed and then stopped changing for 300 ms.
    // An unchanged box is waited on for up to `maxMs`: the editor may still be about to draw.
    async function settleBox(el, text, before, maxMs) {
        const t0 = Date.now();
        let seen = composerHeld(el), still = Date.now();
        while (!holdsExactly(el, text) && Date.now() - t0 < maxMs) {
            await sleep(60);
            const now = composerHeld(el);
            if (now !== seen) { seen = now; still = Date.now(); }
            else if (now !== before && Date.now() - still >= 300) break;
        }
    }
    async function typeInto(el, text) {
        el.focus();
        el.click();

        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, text);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { len: (el.value || '').length, via: 'value' };
        }

        if (el.isContentEditable) {
            const ways = [
                ['paste', () => pasteInto(el, text)],
                ['insertText', () => document.execCommand('insertText', false, text)],
                ['line by line', () => String(text).split('\n').forEach((line, i) => {
                    if (i) document.execCommand('insertParagraph', false);
                    if (line) document.execCommand('insertText', false, line);
                })],
                ['textContent', () => {
                    el.textContent = text;
                    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
                }]
            ];
            for (const [via, run] of ways) {
                const before = composerHeld(el);
                el.focus();
                selectAllIn(el);
                // A rich editor takes in a new selection a moment later (on the browser's selectionchange), not at
                // once: typed or pasted straight away, the text lands beside the old text instead of replacing it.
                await sleep(60);
                try { run(); } catch (e) { /* the next way */ }
                await settleBox(el, text, before, 1500);
                if (holdsExactly(el, text)) return { len: composerHeld(el).length, via };
                if (composerHeld(el) !== before) {
                    // THIS WAY CHANGED THE BOX: never type again on top of it.
                    return { len: composerHeld(el).length, via, breaksLost: squash(composerHeld(el)) === squash(text) };
                }
            }
            return { len: composerHeld(el).length, via: 'none' };
        }
        return { len: 0, via: 'none' };
    }

    // Click the send control if it is there and enabled, otherwise press Enter.
    // The button is usually disabled until the framework has processed the input
    // event, so it gets a moment to come alive before we give up on it.
    /* SEND IT, AND PROVE IT WENT.
     *
     * This used to click whatever matched first and return the name of what it clicked, as
     * though naming an action performed it. Two separate failures came out of that:
     *
     *  · CLICKABLE IS NOT VISIBLE. The gate was visible(), which needs a non-zero bounding
     *    rect — and the relay's window is MINIMIZED by default, where layout can report 0×0
     *    for everything on the page. A 0×0 send button is still perfectly clickable, but the
     *    gate rejected it, so this fell through to the Enter key. M365 Copilot ignores Enter.
     *    The message sat in the composer, unsent, and nothing anywhere raised an error — the
     *    run just waited for an answer to a question it had never asked.
     *
     *  · ONE PAGE, SEVERAL "SEND"S. aria-label*="Send" is not unique on a page that can also
     *    carry a feedback widget, and pick() takes the LAST match. Candidates are now ordered
     *    by how close they sit to THIS composer, because the send button belonging to a
     *    composer shares a near ancestor with it and an unrelated one shares only <body>.
     *
     * The composer emptying is the proof. Nothing below reports success without it.
     *
     * `opts.busyMs` is how long a send control that is present but GREYED OUT is worth waiting
     * for — see THE SEND BUTTON IS BUSY, NOT BROKEN below. Zero (the default) keeps the old
     * behaviour exactly: one look, one click, then the fallbacks.
     */
    async function submit(composer, opts = {}) {
        const held = () => {
            const v = composer.value != null ? composer.value : (composer.innerText || '');
            return v.trim().length;
        };
        const before = held();
        // Sent, if the box has given up all but a trace of what it was holding.
        const gone = () => held() <= Math.max(0, Math.floor(before * 0.2));

        const clickable = (el) => {
            if (!el || !el.isConnected || el.disabled) return false;
            if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
            try { if (getComputedStyle(el).display === 'none') return false; } catch (e) { /* detached */ }
            return true;
        };

        // Hops from this element up to the first ancestor that also holds the composer.
        const near = (el) => {
            let a = el, n = 0;
            while (a && !(a.contains && a.contains(composer))) { a = a.parentElement; n++; if (n > 40) return 999; }
            return a ? n : 999;
        };

        const candidates = () => {
            const out = [];
            for (const sel of SELECTORS.send) {
                let nodes;
                try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
                // A tag-agnostic "Send" selector can match a WRAPPER that holds the composer
                // (a container labelled "Send a message"), which sorts nearest and clicks to no
                // effect. The send control never contains the composer, so exclude the ones that do.
                for (const el of nodes) if (clickable(el) && !(el.contains && el.contains(composer)) && !out.some(o => o.el === el)) out.push({ el, sel, near: near(el) });
            }
            return out.sort((a, b) => a.near - b.near);
        };

        /* THIS composer's send control, enabled or not — the ones candidates() drops.
         *
         * Sorted by proximity for the same reason candidates() is: `[aria-label*="Send" i]`
         * also matches a feedback widget's "Send feedback", and taking the first match in
         * selector order would report that unrelated, perfectly enabled button as the state of
         * the one being waited on — which would quietly turn the wait below back off. */
        const sendAnyState = () => {
            const out = [];
            for (const sel of SELECTORS.send) {
                let nodes;
                try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
                for (const el of nodes) {
                    if (!el || !el.isConnected) continue;
                    if (el.contains && el.contains(composer)) continue;
                    if (out.some(o => o.el === el)) continue;
                    const off = !!(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
                    out.push({ el, sel, off, near: near(el) });
                }
            }
            out.sort((a, b) => a.near - b.near);
            return out.length ? out[0] : null;
        };

        /* THE SEND BUTTON IS BUSY, NOT BROKEN — so wait for it, and press it again.
         *
         * M365 Copilot disables Send while it is still taking the attachment in. On a case
         * carrying a lot of logs that outlasts the eight seconds this used to allow: the
         * control never became clickable, the run fell through to the heuristic (which filters
         * on clickable too), then to form.requestSubmit, then to Enter — which M365 Copilot
         * ignores. The message sat in the composer with the evidence attached beside it, and
         * the failure blamed the message for being too long, because a greyed-out Send is what
         * that site does for an over-long message as well.
         *
         * So the wait is extended, but ONLY when the disabled button is the busy kind:
         *  · `busyMs` is non-zero only on a run that actually attached files (see the caller),
         *    so the over-long-message case still fails in eight seconds with its own advice;
         *  · a control that is present and ENABLED never enters this path at all;
         *  · nothing is waited on once the budget set by the panel is spent.
         *
         * AND A SWALLOWED CLICK IS RETRIED. A click that lands the instant before the page
         * re-disables the control does nothing, which is indistinguishable from not clicking.
         * Going round again is safe for the same reason the Enter fallback below is: a retry
         * is only reached while the composer STILL HOLDS the message, so a send that did land
         * has already returned and cannot be duplicated here.
         */
        const SEND_READY_MS = 8000;      // for a send control to exist and be clickable at all
        const busyMs = Math.max(0, opts.busyMs || 0);
        const busyUntil = Date.now() + busyMs;
        const onWait = typeof opts.onWait === 'function' ? opts.onWait : null;

        /* A CLICKABLE CONTROL IS NOT NECESSARILY THIS COMPOSER'S SEND CONTROL.
         *
         * candidates() ranks by proximity, but it only ever sees the ENABLED ones — so while
         * the real send button is greyed out it is not in that list at all, and a "Send
         * feedback" button at the other end of the page becomes the nearest thing left. The
         * relay then clicks the feedback widget, four times, and reports that the message
         * would not send. Requiring the winner to be no farther from the composer than the
         * nearest send control OF ANY STATE is what keeps a disabled neighbour authoritative:
         * a nearer grey one means the page is not ready yet, not that this is the button. */
        const readySend = () => {
            const c = candidates();
            if (!c.length) return null;
            const nearest = sendAnyState();
            if (nearest && nearest.near < c[0].near) return null;
            return c[0];
        };

        const waitForClickableSend = async () => {
            const quick = await waitFor(readySend, SEND_READY_MS, 150);
            if (quick) return quick;
            let announced = 0;
            for (;;) {
                const remaining = busyUntil - Date.now();
                if (remaining <= 0) return null;
                // Present and greyed out is the only shape worth more time. Gone entirely means
                // a redesign, and the shape-based search below is the answer to that, not delay.
                const present = sendAnyState();
                if (!present || !present.off) return null;
                if (onWait && Date.now() - announced >= 15000) {
                    announced = Date.now();
                    // Also keeps the panel's stall watchdog quiet: every message from this
                    // frame resets it, and a silent two-minute wait is what it exists to catch.
                    onWait(Math.round((busyMs - remaining) / 1000), present.sel);
                }
                const live = await waitFor(readySend, Math.min(5000, remaining), 250);
                if (live) return live;
            }
        };

        /* THE BUTTON IS NOT ALWAYS GREY WHILE IT IS BUSY — IT IS OFTEN JUST INERT.
         *
         * Measured on a real case: two log files, 58.7 MB, and the site needed 1m08s after the
         * upload before Send would do anything. Through all of it the control reported neither
         * `disabled` nor `aria-disabled` — it matched, it was clickable, and it ignored every
         * click. A fixed four attempts spent themselves in about twenty seconds and the run
         * then fell through to the Enter key, which M365 Copilot ignores; the failure blamed a
         * redesign, which is the one thing it was not.
         *
         * So the retry is governed by TIME, not by a count. Press, give the press a few seconds
         * to prove itself, pause, press again — for as long as the budget the caller allowed,
         * which is sized from the upload that caused the wait. Roughly one press every nine
         * seconds, so a 150-second budget is about sixteen of them rather than four.
         *
         * AND THE PRESS ITSELF ESCALATES. `el.click()` dispatches one click event and nothing
         * else, which a framework listening for pointerdown/mouseup never sees. After two
         * ignored clicks the press becomes a full synthesised pointer-and-mouse sequence, the
         * shape a real finger produces. Cheap, and it costs nothing when the plain click works.
         *
         * DOUBLE-SENDING IS WHAT THIS HAS TO NOT DO, and three things keep it from it: a press
         * is only repeated while the composer STILL HOLDS the message; the gap is re-checked
         * for proof before the next press, so a click the page processes slowly is caught
         * rather than repeated; and a stop control appearing counts as proof on its own, since
         * the site only shows one once it is answering.
         */
        const SEND_PROOF_MS = 6000;      // for a press to show it landed
        const SEND_GAP_MS = 3000;        // before pressing again, so the budget is not spent at once
        const SEND_GAP_MAX_MS = 15000;   // …widening as it becomes clear this is a long ingest
        const SEND_PLAIN_CLICKS = 2;     // plain el.click() presses before escalating

        // A stop control the page did not have before we pressed means it is answering, which
        // only happens once the message has gone. Captured first so a leftover one cannot read
        // as proof of a send that has not happened.
        let wasGenerating = false;
        try { wasGenerating = isGenerating(); } catch (e) { /* no stop selector on this site */ }
        const sent = () => {
            if (gone()) return true;
            try { return !wasGenerating && isGenerating(); } catch (e) { return false; }
        };

        const press = (el, full) => {
            if (!full) { el.click(); return; }
            try { el.focus(); } catch (e) { /* not focusable */ }
            const init = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
            /* EVERY CONSTRUCTOR IS LOOKED UP WITH typeof, AND INSIDE THE LOOP.
             *
             * A bare `MouseEvent` in the ternary is a ReferenceError where that global is not
             * defined, and being outside the try it aborted the whole sequence — the pointer
             * events went, `click` never did, and the press did nothing at all while reporting
             * that it had happened. `typeof` never throws on an undeclared name, so resolve
             * that way, skip a type this page cannot construct, and let the remaining ones
             * through. Plain Event is the last resort: a listener that does not read mouse
             * coordinates still fires on it. */
            for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'mousedown',
                                'pointerup', 'mouseup', 'click']) {
                const Ctor = (/^pointer/.test(type) && typeof PointerEvent === 'function') ? PointerEvent
                    : (typeof MouseEvent === 'function') ? MouseEvent
                    : (typeof Event === 'function') ? Event
                    : null;
                if (!Ctor) continue;
                try { el.dispatchEvent(new Ctor(type, init)); } catch (e) { /* unsupported here */ }
            }
        };

        const tried = [];
        let hit = null;
        let presses = 0;
        for (;;) {
            const c = await waitForClickableSend();
            if (!c) break;
            hit = c;
            presses++;
            const full = presses > SEND_PLAIN_CLICKS;
            tried.push(presses === 1 ? `click ${c.sel}`
                : `${full ? 'pointer press' : 'click'} ${c.sel} (attempt ${presses})`);
            try { press(c.el, full); } catch (e) { /* try the next route */ }
            if (await waitFor(sent, SEND_PROOF_MS, 150)) {
                return presses === 1 ? `click ${c.sel}`
                    : `${full ? 'pointer press' : 'click'} ${c.sel} on attempt ${presses}`;
            }
            // Still holding the message, so that press did not take. Another is worth it only
            // while the caller's budget lasts — without one this stays a single click, exactly
            // as it was before any of this.
            if (Date.now() >= busyUntil) break;
            if (onWait && presses % 3 === 0) {
                onWait(Math.round((busyMs - (busyUntil - Date.now())) / 1000), c.sel, presses);
            }
            /* THE GAP WIDENS. The first presses are close together because most waits end in
             * the first minute; once it is clear this is a long ingest, spacing them out keeps
             * the press count sane over a budget that can now run to minutes, and shrinks the
             * window in which a press could land on top of one the page is still processing. */
            const gap = Math.min(SEND_GAP_MAX_MS, SEND_GAP_MS + (presses - 1) * 1500);
            await sleep(Math.min(gap, Math.max(0, busyUntil - Date.now())));
            // The page may have processed the earlier press during that pause.
            if (sent()) return `click ${c.sel} on attempt ${presses}`;
        }

        // NO CONFIGURED SELECTOR MATCHED — find the send control by SHAPE. A redesigned M365
        // Copilot send button (icon-only, a [role="button"], or renamed) has no fixed attribute
        // to match, but it does sit near the composer and reads as "send". Scan the clickable
        // controls under the composer's toolbar, throw out anything that is clearly something
        // else (stop, attach, mic, menu…), and require a real send/submit signal before acting —
        // a wrong click is worse than falling through to the keyboard.
        if (!hit) {
            let scope = composer.parentElement || composer;
            for (let i = 0; i < 6 && scope.parentElement; i++) {
                if (scope.querySelector('button, [role="button"]')) break;
                scope = scope.parentElement;
            }
            const NO = /\b(stop|cancel|attach|upload|file|photo|image|picture|camera|mic|microphone|voice|dictate|speech|audio|record|emoji|gif|sticker|menu|more|options?|expand|collapse|plugin|gallery|clear|delete|remove|discard|history|settings?|feedback|like|dislike|thumbs|copy|share|close|scroll)\b|new\s*(chat|topic)/i;
            const YES = /\b(send|submit)\b/i;
            const nameOf = (el) => {
                const cls = el.className && el.className.baseVal != null ? el.className.baseVal
                    : (typeof el.className === 'string' ? el.className : '');
                return [el.getAttribute && el.getAttribute('aria-label'), el.title, el.id, cls,
                        el.getAttribute && el.getAttribute('data-testid'), el.getAttribute && el.getAttribute('name')]
                    .filter(Boolean).join(' ').toLowerCase();
            };
            let best = null, bestScore = 0, all = [];
            try { all = [...scope.querySelectorAll('button, [role="button"], [type="submit"], a[role="button"]')]; } catch (e) { all = []; }
            for (const b of all) {
                if (!clickable(b) || (b.contains && b.contains(composer))) continue;
                const name = nameOf(b);
                if (NO.test(name)) continue;
                let score = 0;
                if (YES.test(name)) score += 100;
                if (b.getAttribute && b.getAttribute('type') === 'submit') score += 40;
                if (b.querySelector && b.querySelector('svg, img, i')) score += 8;   // an icon control
                if (composer.compareDocumentPosition &&
                    (composer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) score += 8; // send sits after the box
                if (score > bestScore) { bestScore = score; best = b; }
            }
            // Only a confident guess acts (a real send/submit signal); anything weaker falls through.
            if (best && bestScore >= 40) {
                tried.push('nearest send-like control');
                try { best.click(); } catch (e) { /* try the next route */ }
                if (await waitFor(gone, 4000, 150)) return 'heuristic send-like control';
            }
        }

        // The form's own submit path, where there is a form.
        const form = composer.closest ? composer.closest('form') : null;
        if (form) {
            tried.push('form.requestSubmit');
            try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch (e) { /* try the keyboard */ }
            if (await waitFor(gone, 2500, 150)) return 'form.requestSubmit';
        }

        // Keyboard last, and only because some composers listen for nothing else. Reached
        // only when the box still holds the message, so this cannot duplicate a sent one.
        for (const mods of [{}, { ctrlKey: true }, { metaKey: true }]) {
            composer.focus();
            tried.push('Enter' + (mods.ctrlKey ? '+Ctrl' : mods.metaKey ? '+Meta' : ''));
            for (const type of ['keydown', 'keypress', 'keyup']) {
                composer.dispatchEvent(new KeyboardEvent(type, Object.assign({
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                }, mods)));
            }
            if (await waitFor(gone, 1500, 150)) return `Enter key${mods.ctrlKey ? ' (Ctrl)' : mods.metaKey ? ' (Meta)' : ''}`;
        }

        /* A SEND BUTTON THAT IS THERE BUT GREYED OUT IS NOT A MISSING SEND BUTTON, and saying
         * it is sends whoever reads this to the wrong place entirely.
         *
         * `candidates()` filters on `clickable()`, which drops anything disabled or
         * aria-disabled. M365 Copilot DISABLES Send while the composer holds more than its
         * input limit — so an over-long message produced "No send control could be found. If
         * the site has redesigned its send button…", and the honest answer was that the
         * message was too long and no redesign had happened. Look again without the clickable
         * filter: if the control is sitting right there disabled, say THAT, and say how much
         * was in the box, because the length is the thing to act on.
         *
         * AND THERE ARE TWO REASONS IT IS GREY, which need opposite things from the engineer.
         * Over-long is one. The other is that the site has not finished taking the attachment,
         * and on that one the advice to shorten the message is not merely useless — it points
         * away from the cause. `busyMs` says which case this was: it is non-zero only on a run
         * that attached files, and reaching here with it spent means the button stayed disabled
         * for the whole wait. */
        const stuck = sendAnyState();
        const disabledSend = stuck && stuck.off ? stuck.sel : null;
        const waitedS = Math.round(Math.min(busyMs, Math.max(0, busyMs - (busyUntil - Date.now()))) / 1000);

        const e = new Error(
            `${location.host} would not send the message: it is still sitting in the composer with ` +
            `${held().toLocaleString()} of ${before.toLocaleString()} characters after trying ${tried.join(', ') || 'no route at all'}. ` +
            /* CLICKABLE AND IGNORED IS ITS OWN DIAGNOSIS, and it is the one a big upload
             * produces: the control reports neither disabled nor aria-disabled, takes every
             * press and does nothing with it while the site finishes ingesting the files.
             * Saying "the site has redesigned its send button" here sends the engineer to
             * change a selector that is matching perfectly. */
            (busyMs && presses >= 2 && !disabledSend
                ? `Its send button (${hit ? hit.sel : 'found'}) matched and was clickable the whole time — it took `
                  + `${presses} presses over ${waitedS}s, the last of them as a full pointer sequence, and ignored `
                  + `every one. That is what this site does while it is still taking an upload in, and ${waitedS}s `
                  + `was not enough for this one. The files are attached and the question is typed: send it yourself `
                  + `in the tab, or raise "Answer timeout" under Settings (⚙) → AI Provider, which is what sizes `
                  + `this wait.`
                : disabledSend && busyMs
                ? `Its send button (${disabledSend}) was present but DISABLED for the whole ${Math.round(busyMs / 1000)}s `
                  + `it was given, which is what this site does while it is still taking an upload in. The files are `
                  + `attached; it is the sending that did not happen. Try again — a case this size may simply need `
                  + `longer than the panel allows, and "Answer timeout" under Settings (⚙) → AI Provider is what sets `
                  + `that budget.`
                : disabledSend
                ? `Its send button (${disabledSend}) is present but DISABLED, which is what this site does when the `
                  + `composer holds more than it accepts — this message is too long for it, rather than the button `
                  + `having moved. The panel is re-measuring its own limit from this and will retry shorter; if it `
                  + `keeps happening, lower "Max characters per message" under Settings (⚙) → AI Provider.`
                : (hit ? '' : 'No send control could be found. ')
                  + `If the site has redesigned its send button, set a new one under Settings (⚙) → Bridge selectors.`));
        e.__described = true;
        /* A MEASUREMENT, NOT JUST A COMPLAINT.
         *
         * The adapter already re-tunes itself when the composer TRUNCATES what was typed — it
         * reads back what the box kept and re-splits to that. This case looks nothing like it
         * from the page: the box took every character and the SITE refused to send them, so
         * "accepted" equals "attempted" and nothing was learned. The engineer was handed a
         * setting to change by hand instead, on a limit only the site knows.
         *
         * It is still a measurement. A composer holding N characters with Send greyed out
         * proves the limit is below N, which is exactly the fact the adapter needs. Flagged
         * separately because the arithmetic is different: a truncation says "this much fits",
         * this says "less than this fits", so the provider steps down rather than trimming the
         * last 5%. Only on the over-long case — while the site is still ingesting an upload the
         * button is grey for a reason that has nothing to do with length. */
        if (disabledSend && !busyMs) {
            e.capacity = { accepted: held(), attempted: before, sendDisabled: true };
        }
        throw e;
    }

    function isGenerating() {
        return !!pick(SELECTORS.stop);
    }

    /* ---------------------------------------------------------------------
     * Answer extraction (see the header for the reasoning)
     * ------------------------------------------------------------------- */

    // Everything the page has touched since we started watching.
    /* ELEMENTS WHOSE TEXT IS NOT CONTENT.
     *
     * innerText has a trap that matters enormously here. The HTML spec says an element that
     * is NOT RENDERED returns its textContent instead of its rendered text — and <style> is
     * display:none by definition. So `styleEl.innerText` hands back the entire stylesheet as
     * though it were prose.
     *
     * That is not hypothetical: Microsoft's Office Browser Feedback widget (.obf-*) injects a
     * <style> block into the page part-way through a run. Roughly 900 characters arriving in
     * ONE mutation, which comfortably outscores a reply that streams in a few characters at a
     * time — and the relay duly returned a stylesheet as the case analysis.
     *
     * Filtered at the watcher so these never become candidates, and again in bestCandidate
     * because a node can reach the set by more than one route.
     */
    const NON_CONTENT_TAGS = /^(?:STYLE|SCRIPT|NOSCRIPT|TEMPLATE|LINK|META|TITLE|HEAD|SVG|PATH|CANVAS|AUDIO|VIDEO|IFRAME|OBJECT|EMBED)$/;
    // Keyed on the TAG, deliberately — not on nodeType. The nodeType test belongs at the
    // watcher, which sees real DOM; asking for it here would reject anything constructed
    // without one and answer "non-content" about every element it was handed.
    function isNonContent(el) {
        if (!el) return true;
        const tag = el.tagName ? String(el.tagName).toUpperCase() : '';
        if (tag && NON_CONTENT_TAGS.test(tag)) return true;
        // Anything inside <head> is page plumbing whatever its tag.
        try { if (document.head && document.head.contains && document.head.contains(el)) return true; } catch (e) { /* no head */ }
        return false;
    }

    function makeWatcher() {
        const touched = new Set();
        const observer = new MutationObserver((muts) => {
            for (const m of muts) {
                const t = m.type === 'characterData' ? (m.target && m.target.parentElement) : m.target;
                if (t && t.nodeType === 1 && !isNonContent(t)) touched.add(t);
                if (m.addedNodes) {
                    for (const n of m.addedNodes) if (n.nodeType === 1 && !isNonContent(n)) touched.add(n);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return { touched, stop: () => observer.disconnect() };
    }

    // Strip wrapper chrome ("Copy", "Regenerate", an avatar initial) off the edges of
    // the answer, without a word list — those are site-specific and go stale.
    //
    // The tempting rule is "descend into any child holding ~all the text", but a ratio
    // cannot tell a button row from a short closing sentence: on [500-char paragraph,
    // 30-char paragraph] it happily throws the second paragraph away. Truncating a real
    // answer is far worse than carrying the word "Copy", so the rule is about SIZE
    // instead: descend only when everything left behind is button-sized — each discarded
    // sibling short on its own, and little text dropped in total.
    const CHROME_CHARS = 25;   // longest a single discarded sibling may be
    const CHROME_TOTAL = 50;   // most text tightening may drop at one level

    /* WHAT TIGHTENING MAY THROW AWAY (9.6.2 fix: the panel showed one paragraph of a reply).
     *
     * Size alone was the rule, and size cannot tell a button row from a short line of the
     * answer: on "Hi John, / Yes, that works. / Thanks, Ayo" every paragraph is under 25
     * characters, so tightening walked into the longest one and the greeting and sign-off
     * were gone. A sibling may now be dropped only when it is page furniture by WHAT IT IS:
     * empty, not content at all, a control (button / toolbar / menu / tooltip, whose text is
     * all control labels), or nothing but the turn label ("Copilot said:"). Any line of real
     * text keeps tightening where it is, however short. */
    const CHROME_CONTROLS = 'button,[role="button"],[role="toolbar"],[role="menu"],[role="menubar"],[role="tooltip"]';
    function chromeLike(el) {
        if (!el || isNonContent(el)) return true;
        const text = (el.innerText || '').trim();
        if (!text) return true;
        try {
            if (el.matches && el.matches(CHROME_CONTROLS)) return true;
            let ctl = 0;
            for (const b of el.querySelectorAll(CHROME_CONTROLS)) {
                // Nested controls are counted once, at the outermost one.
                const outer = b.parentElement ? b.parentElement.closest(CHROME_CONTROLS) : null;
                if (outer && el.contains(outer)) continue;
                ctl += (b.innerText || '').trim().length;
            }
            if (ctl >= text.replace(/\s+/g, '').length) return true;
        } catch (e) { /* treat as content */ }
        return !stripRelayChrome(text).trim();
    }
    // Text written directly inside the element, outside any child element.
    function ownText(el) {
        let s = '';
        for (const n of (el.childNodes || [])) if (n.nodeType === 3) s += n.nodeValue;
        return s.trim();
    }

    /* THE WHOLE TURN, NOT THE PART OF IT THAT MOVED LAST (9.6.2 fix).
     *
     * The answer is found by GROWTH: whichever changed element grew the most. That is the
     * paragraph being written, not the reply. M365 Copilot routinely swaps the streamed
     * message for a freshly rendered one when it finishes and then animates a paragraph of
     * it, so the only thing still growing was the email's longest paragraph, and that one
     * paragraph was relayed as the whole email ("As you mentioned that the PDF quality…").
     *
     * So the element found by growth is only a FOOTHOLD. From it, climb to the outermost
     * ancestor that is still this answer alone: one that does not hold the composer, does not
     * hold our own message (the echo node, or the prompt's text), and is not the page itself.
     * Everything inside that is the assistant's turn, and tighten() then trims furniture off
     * its edges. Turns before ours cannot be swept in: in document order they sit before our
     * own message, so any box holding them holds it too, and that box is refused. */
    function widenToTurn(ctx, el) {
        if (!el || !el.isConnected) return el;
        // Without a fixed point for "our own message" there is nothing to stop the climb at.
        if (!ctx.echoNode && !ctx.promptHead) return el;
        const loose = ctx.promptLoose || '';
        let best = el;
        for (let up = el.parentElement; up; up = up.parentElement) {
            if (up === document.body || up === document.documentElement) break;
            if (ctx.composer && (up === ctx.composer || up.contains(ctx.composer))) break;
            if (ctx.echoNode && ctx.echoNode.isConnected && up.contains(ctx.echoNode)) break;
            if (inChrome(up)) break;
            const text = up.innerText || '';
            if (ctx.promptHead && norm(text).includes(ctx.promptHead)) break;
            if (loose.length >= 16 && looseKey(text).includes(loose)) break;
            best = up;
        }
        return best;
    }

    function tighten(node) {
        let best = node;
        for (let depth = 0; depth < 8; depth++) {
            // Same innerText trap as bestCandidate guards against: a <style> child reports
            // its whole stylesheet as text, which would both win "biggest child" and inflate
            // the othersTooBig test below. Dropped before either measurement is taken.
            // A CODE WIDGET IS ATOMIC. Descending into it lands past the role="group" that
            // identifies it, and from inside, codeWidget() no longer recognises the thing it
            // is standing in — so the gutter stops being separable from the code and the
            // block is either mangled or lost. An answer that is MOSTLY one long code block
            // walks straight into this: the widget is the biggest child every time.
            if (codeWidget(best)) break;
            const kids = best.children ? [...best.children].filter(k => !isNonContent(k)) : [];
            if (!kids.length) break;

            const full = (best.innerText || '').trim().length;
            if (!full) break;

            let biggest = null, biggestLen = -1;
            for (const k of kids) {
                const len = (k.innerText || '').trim().length;
                if (len > biggestLen) { biggest = k; biggestLen = len; }
            }
            if (!biggest || biggestLen <= 0) break;

            // A SENTENCE FRAGMENT IS NOT AN ANSWER.
            //
            // A streaming page hands out its reply a word at a time, each word in its own
            // <span> (see MD_INLINE below). Early in an answer the paragraph is short enough
            // that the discarded siblings all fit inside the chrome allowances above — so
            // this loop happily descended into the longest WORD and returned it as the whole
            // reply. Inline markup never holds an answer, only part of a line of one, so the
            // flow of text it belongs to is where tightening stops.
            if (MD_INLINE.test(String(biggest.tagName || '').toUpperCase())) break;

            // Anything outside the biggest child that is not furniture is content: a short
            // greeting or sign-off is part of the answer (see chromeLike).
            const othersAreContent = kids.some(k => k !== biggest && !chromeLike(k));
            if (othersAreContent) break;
            // The parent's own loose text, which no child accounts for, is content too.
            if (ownText(best) && stripRelayChrome(ownText(best)).trim()) break;
            // And a furniture-only sibling is still capped, so a big control panel is never
            // mistaken for a label and a whole region thrown away on its say-so.
            const dropped = kids.filter(k => k !== biggest).reduce((n, k) => n + (k.innerText || '').trim().length, 0);
            if (dropped > CHROME_TOTAL * 4 || kids.some(k => k !== biggest && !k.matches(CHROME_CONTROLS) && (k.innerText || '').trim().length > CHROME_CHARS * 4)) break;

            best = biggest;
        }
        return best;
    }

    // Is this element part of the page's controls rather than its content? An assistant's
    // prose is never inside a button, a link, or a tooltip.
    // NOT role="status" / role="alert" / aria-live. A streaming answer is routinely wrapped
    // in a live region so screen readers announce it, so excluding those filtered out the
    // reply itself and left the page's "AI-generated content may be incorrect" disclaimer
    // as the best remaining candidate. Only genuinely interactive controls are excluded;
    // separating a label from an answer is growth's job, below.
    function inChrome(el) {
        try {
            return !!(el.closest && el.closest('button,[role="button"],a[href],[role="tooltip"]'));
        } catch (e) { return false; }
    }

    // How much of this element's text comes from buttons. A follow-up-suggestion strip
    // ("The issue is with MobiControl." / "I need help with SOTI Connect.") is three
    // buttons in a box: it is longer than a short answer and it is not an answer.
    function buttonTextLen(el) {
        let n = 0;
        let btns;
        try { btns = el.querySelectorAll('button,[role="button"],a[href]'); } catch (e) { return 0; }
        for (const b of btns) n += (b.innerText || '').trim().length;
        return n;
    }

    function comesAfter(anchor, el) {
        try {
            if (!anchor || !anchor.compareDocumentPosition) return false;
            return !!(anchor.compareDocumentPosition(el) & 4 /* DOCUMENT_POSITION_FOLLOWING */);
        } catch (e) { return false; }
    }

    // WHICH CHANGED ELEMENT IS THE ANSWER.
    //
    // "The one with the most text" was the first rule, and it is not good enough. On M365
    // Copilot the share button's label — "Sharing will be available once the response is
    // ready", 51 characters — beat the actual reply, "Hi colleague, how can I help with
    // your case today?", at 48. Length is a tiebreak, not a discriminator.
    //
    // Three structural facts do the real work, none of them naming a class:
    //   · an answer is CONTENT, not a control — not inside a button/link/tooltip, and not
    //     a box whose text is mostly button labels (that is a suggestion-chip strip);
    //   · an answer FOLLOWS the user's turn in document order — which drops the header and
    //     toolbar furniture that renders above the conversation;
    //   · an answer GROWS while it streams — chrome appears fully formed in one mutation.
    // Growth is the strongest of the three, so it sorts first; length only breaks ties.
    function bestCandidate(ctx, requireGrowth) {
        if (!ctx.growth) ctx.growth = new Map();

        const cands = [];
        for (const el of ctx.watcher.touched) {
            if (!el.isConnected) continue;
            // A stylesheet is not an answer — see isNonContent() and the innerText trap it
            // documents. This is the check that stopped the relay returning ".obf-SubmitButton
            // { background-color: #0167B0 }" as a case analysis.
            if (isNonContent(el)) continue;
            // The composer and every ancestor of it are page structure, not an answer.
            if (el === ctx.composer || el.contains(ctx.composer)) continue;
            const text = (el.innerText || '').trim();
            if (text.length < 2) continue;
            // Anything showing the prompt back is the user's own turn, or a wrapper
            // holding both turns. Compared on normalised whitespace because innerText
            // re-flows newlines.
            if (ctx.promptHead && norm(text).includes(ctx.promptHead)) continue;
            if (inChrome(el)) continue;
            if (buttonTextLen(el) > text.length * 0.6) continue;

            // HOW MUCH it grew, not merely whether it did. A boolean ranked the page
            // disclaimer — which went from empty to 37 characters in one mutation — level
            // with a reply that streamed in 48 characters over dozens of them. The size of
            // the delta is what separates text a model is writing from text a page renders.
            const first = ctx.growth.get(el);
            if (first === undefined) ctx.growth.set(el, text.length);
            const delta = first === undefined ? 0 : Math.max(0, text.length - first);

            cands.push({
                el,
                delta,
                len: text.length,
                after: comesAfter(ctx.echoNode, el) ? 1 : 0
            });
        }

        const pool = requireGrowth ? cands.filter(c => c.delta > 0) : cands;
        if (!pool.length) return null;
        pool.sort((a, b) => (b.delta - a.delta) || (b.after - a.after) || (b.len - a.len));
        return pool[0];
    }

    // Kept as the name the checks drive: the tightened element the heuristic settles on.
    function heuristicAnswerNode(ctx) {
        const c = bestCandidate(ctx, false);
        return c ? tighten(c.el) : null;
    }

    // PROOF THE MESSAGE WAS ACCEPTED.
    //
    // Without this the relay will happily return whatever text the page put on screen
    // after "submit" — and when you are not signed in, what appears is the sign-in
    // chooser. "Personal / Work or school / Sign in with Apple" then arrives in the panel
    // formatted as the model's analysis: confidently wrong, and impossible to spot in a
    // finished report. That is worse than any error.
    //
    // The test is structural rather than a hunt for login markup: a chat that accepted
    // the message ALWAYS renders it back as the user's turn. So look for our own prompt
    // somewhere outside the composer. Inside the composer does not count — that is just
    // text that was typed and never sent, which is exactly the failure being detected.
    // Also records the TIGHTEST node holding the prompt — the user's own bubble — which
    // becomes the document-order anchor the answer must follow.
    // Letters and digits only: how the opening words are matched when the chat shows them formatted (a subject
    // with * _ or ` in it can be drawn as markdown, and quotes can be drawn curly).
    const looseKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    function promptEchoed(ctx) {
        let smallest = null;
        const loose = ctx.promptLoose || '';
        for (const el of ctx.watcher.touched) {
            if (!el.isConnected) continue;
            if (el === ctx.composer || el.contains(ctx.composer)) continue;
            const text = el.innerText || '';
            if (!norm(text).includes(ctx.promptHead) && !(loose.length >= 16 && looseKey(text).includes(loose))) continue;
            // <= so a tie resolves to the DEEPER node: a bubble and the wrapper that holds
            // only that bubble have identical text, and the bubble is the tighter anchor.
            if (!smallest || text.length <= (smallest.innerText || '').length) smallest = el;
        }
        if (smallest) ctx.echoNode = smallest;
        return !!smallest;
    }

    // LOCK ON, then keep reading the same element.
    //
    // Re-deciding from scratch on every tick is what hung the last build: two candidates
    // of similar size traded places each pass, every swap looked like the text "changing",
    // the quiet timer reset forever, and the run sat there until the watchdog killed it at
    // 60s. Once an element has been identified it is pinned, and only a candidate that has
    // grown MORE can take its place — so a late-appearing label cannot steal the stream.
    // Re-tightened on each read, because the node holding the answer gains children as
    // markdown renders.
    /* ---------------------------------------------------------------------
     * READING THE ANSWER BACK AS MARKDOWN, NOT AS FLAT TEXT
     * ---------------------------------------------------------------------
     * The relay used to hand the panel `innerText`, and innerText is lossy in exactly the
     * places a support report cares about. Measured against a live M365 Copilot answer:
     *
     *   <ol> → "First item\nSecond item"          — the NUMBERS are gone. List markers are
     *                                               drawn by CSS, and CSS is not text.
     *   <table> → "Item\tValue\nProduct\tMobiControl"
     *                                             — TAB separated. Not one pipe survives.
     *
     * The panel then renders that faithfully as what it is: unnumbered lines and a run of
     * tab-separated words where a table should be. Nothing downstream can recover the
     * structure, because by then the structure is genuinely gone.
     *
     * So the DOM is walked and written back out as markdown. Copilot rendered markdown to
     * build this DOM; turning it back into markdown is simply the inverse, and it is what
     * makes the panel's rendering match what the engineer sees in the Copilot tab.
     *
     * Falls back to innerText on any error — a formatted answer is better than a flat one,
     * but a flat answer is enormously better than none.
     * ------------------------------------------------------------------- */
    const MD_SKIP = /^(?:STYLE|SCRIPT|NOSCRIPT|TEMPLATE|BUTTON|SVG|PATH|CANVAS|AUDIO|VIDEO|IFRAME|SELECT|OPTION|HEAD|META|LINK)$/;
    const MD_BLOCK = /^(?:P|DIV|SECTION|ARTICLE|MAIN|UL|OL|LI|TABLE|THEAD|TBODY|TR|TD|TH|PRE|BLOCKQUOTE|HR|H[1-6]|FIGURE)$/;
    /* TAGS THAT DO NOT START A NEW LINE.
     *
     * This list is what stands between a relayed answer and the shape the panel showed for
     * a fortnight: one word per line, the whole opening paragraph laid out as a ladder down
     * the side of the case summary.
     *
     * The cause is how a chat page STREAMS. M365 Copilot does not rewrite the paragraph's
     * text as it goes — it appends each arriving word as its own node inside the paragraph,
     * so that it can fade in. Mid-answer that paragraph really is
     *
     *   <p>"Summary: The " <span>customer,</span> <span>Oisin</span> <span>McCann,</span> …</p>
     *
     * and the walk below emitted one line per child, because a child is normally a block.
     * Those spans are not blocks; they are a sentence. Anything on this list is therefore
     * collected into the line being built rather than ending it, which is exactly what the
     * browser does with them.
     */
    const MD_INLINE = /^(?:SPAN|A|B|STRONG|I|EM|U|S|STRIKE|DEL|INS|CODE|SMALL|SUB|SUP|MARK|ABBR|TIME|CITE|Q|KBD|VAR|SAMP|BDI|BDO|DFN|FONT|LABEL|OUTPUT|RUBY|RT|RP|WBR|NOBR)$/;

    // ONE node's worth of inline markdown. Split out of mdInline() because the block walk
    // needs it too: an inline element reached from there is the node ITSELF, and calling
    // mdInline() on it would serialise its children and lose its own markup — bold text
    // came back as plain text, a link as its bare label.
    function mdInlineNode(n) {
        if (!n) return '';
        if (n.nodeType === 3) return n.nodeValue;
        if (n.nodeType !== 1) return '';
        const tag = String(n.tagName).toUpperCase();
        if (MD_SKIP.test(tag)) return '';
        if (tag === 'BR') return '\n';
        if (tag === 'STRONG' || tag === 'B') { const t = mdInline(n).trim(); return t ? `**${t}**` : ''; }
        if (tag === 'EM' || tag === 'I') { const t = mdInline(n).trim(); return t ? `*${t}*` : ''; }
        if (tag === 'CODE') { const t = mdInline(n).trim(); return t ? '`' + t + '`' : ''; }
        if (tag === 'A') {
            const t = mdInline(n).trim();
            const href = (n.getAttribute && n.getAttribute('href')) || '';
            return (t && /^https?:/i.test(href)) ? `[${t}](${href})` : t;
        }
        return mdInline(n);
    }

    function mdInline(el) {
        let s = '';
        for (const n of el.childNodes) s += mdInlineNode(n);
        return s;
    }

    /* A FENCED CODE BLOCK THAT IS NOT A <pre>.
     *
     * M365 Copilot renders fenced code as an editor widget: role="group", aria-label="Code
     * Preview", wrapping a .scriptor-component-code-block. Inside it a role="textbox" holds
     * the lines, and its children ALTERNATE — gutter digit, code line, gutter digit, code
     * line. Walked as an ordinary container it emits every gutter digit and the language
     * badge as prose, which is what turned a propagation diagram into
     * "Plain Text / 1 / Device attempts… / 2 / ↓ / 3 / java.net.UnknownHostException".
     *
     * The gutter is identified by what it MEANS rather than by its class — those are hashed
     * per build (fd03a365b9240378) and would not survive a redesign. A leaf whose entire text
     * is the next line number in sequence is a line number; anything else is code, including
     * a line that merely looks numeric but breaks the run.
     *
     * The widget is also VIRTUALISED (scriptor-codeblock-virt): a long block keeps only the
     * visible lines in the DOM behind a "Show more lines" control. What is missing cannot be
     * recovered by reading, so it is DECLARED inside the fence rather than passed off as the
     * whole block.
     */
    function codeWidget(el) {
        if (!el || !el.getAttribute) return null;
        const isWidget =
            (el.getAttribute('role') === 'group' && /code preview/i.test(el.getAttribute('aria-label') || '')) ||
            /scriptor-component-code-block/.test(String(el.className || ''));
        if (!isWidget) return null;

        const box = el.querySelector('[role="textbox"]') || el;
        const out = [];
        let expect = 1;
        for (const k of box.children) {
            const txt = String(k.textContent == null ? '' : k.textContent);
            if (!k.children.length && txt.trim() === String(expect)) { expect++; continue; }   // gutter
            out.push(txt.replace(/\s+$/, ''));
        }
        // NO TRUNCATION WARNING HERE, deliberately. "Show more lines" looks like it marks a
        // block whose tail is missing, and it does not: measured on a 30-line block where the
        // control was visible, all 60 children (30 gutter + 30 code) were present in the DOM
        // and only the widget's HEIGHT was capped — scrollHeight 1000 against clientHeight
        // 320. The control expands what is shown, not what exists.
        //
        // An earlier version warned on its presence and stamped "this block is truncated"
        // onto complete blocks. A warning that fires on every long-but-whole code block
        // teaches the engineer to ignore warnings, which costs more than it ever saves.
        return out.length ? { lines: out } : null;
    }

    function mdHasBlockChild(el) {
        for (const c of el.children) if (MD_BLOCK.test(String(c.tagName).toUpperCase())) return true;
        return false;
    }

    function mdList(list, indent, ordered) {
        const out = [''];
        let i = 0;
        for (const li of list.children) {
            if (String(li.tagName).toUpperCase() !== 'LI') continue;
            i++;
            // The item's OWN text, with any nested list taken out first — otherwise the
            // sub-items are repeated inline on the parent's line as well as under it.
            const clone = li.cloneNode(true);
            for (const c of [...clone.children]) {
                if (/^(?:UL|OL)$/.test(String(c.tagName).toUpperCase())) c.remove();
            }
            const own = mdInline(clone).replace(/\s+/g, ' ').trim();
            out.push(indent + (ordered ? `${i}. ` : '- ') + own);
            for (const sub of li.children) {
                const t = String(sub.tagName).toUpperCase();
                if (t === 'UL' || t === 'OL') mdList(sub, indent + '    ', t === 'OL').forEach(l => out.push(l));
            }
        }
        out.push('');
        return out;
    }

    function mdTable(table, indent) {
        const rows = [...table.querySelectorAll('tr')];
        if (!rows.length) return [];
        const cellsOf = (tr) => [...tr.children]
            .filter(c => /^T[HD]$/.test(String(c.tagName).toUpperCase()))
            // A literal pipe inside a cell would end the column early, so escape it.
            .map(c => mdInline(c).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim());
        const grid = rows.map(cellsOf).filter(r => r.length);
        if (!grid.length) return [];
        const width = Math.max(...grid.map(r => r.length));
        const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
        const out = [''];
        out.push(indent + '| ' + pad(grid[0]).join(' | ') + ' |');
        out.push(indent + '| ' + pad(grid[0]).map(() => '---').join(' | ') + ' |');
        for (let i = 1; i < grid.length; i++) out.push(indent + '| ' + pad(grid[i]).join(' | ') + ' |');
        out.push('');
        return out;
    }

    function domToMarkdown(root) {
        // The walk below tests root's CHILDREN, never root itself — so when the answer node
        // IS the code widget (which tighten() will hand over for a code-only reply), the
        // widget handler would never fire and the gutter would be walked as prose. Tested
        // here, once, before the walk starts.
        const rootCode = codeWidget(root);
        if (rootCode) return '```\n' + rootCode.lines.join('\n') + '\n```';

        const lines = [];
        const walk = (el, indent) => {
            // The line currently being assembled. Text nodes and inline elements ADD to it;
            // a block element ends it. Emitting each of them as its own line — which is what
            // this did — turns a streaming paragraph into one word per line, and the panel
            // renders every newline faithfully.
            let run = '';
            const flush = () => {
                const t = run.replace(/[ \t]+/g, ' ').trim();
                run = '';
                if (t) lines.push(indent + t);
            };
            for (const n of el.childNodes) {
                if (n.nodeType === 3) {
                    // NOT trimmed, and not dropped when it is only whitespace: the single
                    // space between two word spans is a real part of the sentence, and it
                    // lives in a text node of its own.
                    run += n.nodeValue.replace(/\s+/g, ' ');
                    continue;
                }
                if (n.nodeType !== 1) continue;
                const tag = String(n.tagName).toUpperCase();
                if (MD_SKIP.test(tag)) continue;
                // A toolbar, menu or role="button" box is the page's controls, not the reply.
                try { if (n.matches && n.matches(CHROME_CONTROLS)) continue; } catch (e) { /* keep it */ }

                // An inline element continues the sentence. Checked before every block
                // branch below, and before codeWidget(), because a <code> span is inline
                // markup rather than a code block.
                if (MD_INLINE.test(tag)) { run += mdInlineNode(n); continue; }

                flush();   // whatever follows is a block, so the line in hand is finished

                const h = /^H([1-6])$/.exec(tag);
                if (h) { lines.push(''); lines.push(indent + '#'.repeat(+h[1]) + ' ' + mdInline(n).replace(/\s+/g, ' ').trim()); lines.push(''); continue; }
                if (tag === 'HR') { lines.push(''); lines.push(indent + '---'); lines.push(''); continue; }
                if (tag === 'PRE') {
                    lines.push(''); lines.push(indent + '```');
                    String(n.textContent || '').replace(/\s+$/, '').split('\n').forEach(l => lines.push(indent + l));
                    lines.push(indent + '```'); lines.push('');
                    continue;
                }
                // Checked before the generic container branch, because the widget IS a
                // container and would otherwise be recursed into and flattened.
                const code = codeWidget(n);
                if (code) {
                    lines.push(''); lines.push(indent + '```');
                    code.lines.forEach(l => lines.push(indent + l));
                    lines.push(indent + '```'); lines.push('');
                    continue;
                }
                if (tag === 'TABLE') { mdTable(n, indent).forEach(l => lines.push(l)); continue; }
                if (tag === 'UL' || tag === 'OL') { mdList(n, indent, tag === 'OL').forEach(l => lines.push(l)); continue; }
                if (tag === 'BLOCKQUOTE') {
                    lines.push('');
                    mdInline(n).split('\n').forEach(l => { if (l.trim()) lines.push(indent + '> ' + l.trim()); });
                    lines.push('');
                    continue;
                }
                if (tag === 'P') { const t = mdInline(n).replace(/[ \t]+/g, ' ').trim(); if (t) { lines.push(''); lines.push(indent + t); lines.push(''); } continue; }
                if (tag === 'BR') { lines.push(''); continue; }

                // A plain container: recurse when it holds blocks, otherwise it IS a line.
                if (mdHasBlockChild(n)) walk(n, indent);
                else { const t = mdInline(n).replace(/[ \t]+/g, ' ').trim(); if (t) lines.push(indent + t); }
            }
            flush();   // the container ended on a sentence rather than on a block
        };
        walk(root, '');
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    /* ---------------------------------------------------------------------
     * THE PAGE'S OWN FURNITURE IS NOT PART OF THE ANSWER
     * ---------------------------------------------------------------------
     * The answer is read off a chat page, and the chat page writes things around it: a
     * progress ticker above the reply ("Lining things up…", "Getting started…") and a
     * turn label for screen readers ("Copilot said:"). Both land inside the element the
     * reply is read from, so both were being returned as the first words of the answer —
     * and a generated JIRA ticket came back starting
     *
     *     Lining things up…Copilot said:h3. *Description of Issue:*
     *
     * with the chat UI's furniture glued to a ticket about to be filed into JIRA. There
     * is no newline after "said:", so nothing anchored to a line start could catch it.
     *
     * ONLY AT THE FRONT, and only these phrases. An answer may legitimately CONTAIN them
     * (a ticket quoting a transcript, a log line reading "Searching…"), and editing that
     * would be corrupting the engineer's evidence to tidy up a label.
     *
     * Stripping here rather than only at the reader means it never reaches ANY answer —
     * chat replies, email drafts and summaries, not just the JIRA generator, which has a
     * second pass of its own (cleanupJiraOutput in sidepanel.js).
     * ------------------------------------------------------------------- */
    const RELAY_CHROME_RE = new RegExp(
        '^\\s*(?:'
        + '(?:copilot|claude|chatgpt|assistant|you|user)\\s+said\\s*:'
        + '|sent\\s+by\\s+copilot\\s*:'
        + '|(?:lining\\s+things\\s+up|getting\\s+started|working\\s+on\\s+it|just\\s+a\\s+moment'
        + '|let\\s+me\\s+think|one\\s+moment|almost\\s+there|hang\\s+tight'
        + '|thinking|reasoning|searching|analy[sz]ing|gathering\\s+information'
        + '|looking\\s+into\\s+(?:it|this)|reading\\s+(?:the\\s+)?(?:page|document|files?)'
        + '|generating(?:\\s+(?:a\\s+)?(?:response|answer))?)'
        + '\\s*(?:\\u2026|\\.{2,})?'
        + ')\\s*', 'i');

    // "Lining things up…Copilot said:" is two pieces, so this takes them off in turn.
    // Bounded rather than looped to exhaustion: a pattern that ever matched the empty
    // string must not be able to spin here, and six is more pieces than any page writes.
    /* THE TURN LABEL AS A HEADING, AND THE PAGE'S OWN BANNERS AT THE END (9.6.2). Since the bridge reads the whole
     * assistant turn (see widenToTurn), the turn's own furniture comes with it: M365 Copilot draws "Copilot said:" as a
     * heading — "###### Copilot said:" once it is markdown, which the pattern above did not match — and can put an
     * upsell under the reply ("Get help with all your work / Upgrade Copilot for answers relevant to all your work…").
     * Both reached the panel and the Salesforce email. Taken off the START and the END only, line by line, so an answer
     * that quotes these words in its middle keeps them. */
    const RELAY_LABEL_LINE_RE = /^\s*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:copilot|claude|chatgpt|assistant|you|user)\s+said\s*:?[ \t]*(?:\*\*|__)?[ \t]*(?:\n|$)/i;
    const RELAY_TAIL_LINE_RE = /^[ \t>*_#-]*(?:get help with all your work.*|\[?upgrade (?:to )?copilot\b.*|(?:\[)?try copilot\b.*|ai[- ]generated content may be incorrect\.?|sources?|copy|edit in pages|was this (?:response|answer) helpful\??)[ \t*_]*$/i;
    function stripRelayTail(text) {
        const lines = String(text || '').split('\n');
        let n = lines.length, cut = 0;
        while (n > 0 && cut < 6) {
            const l = lines[n - 1];
            if (!l.trim()) { n--; continue; }
            if (!RELAY_TAIL_LINE_RE.test(l)) break;
            n--; cut++;
        }
        return cut ? lines.slice(0, n).join('\n').replace(/\s+$/, '') : String(text || '');
    }
    function stripRelayChrome(text) {
        let t = String(text || '');
        for (let i = 0; i < 6; i++) {
            const cut = t.replace(RELAY_LABEL_LINE_RE, '').replace(RELAY_CHROME_RE, '');
            if (cut === t) break;
            t = cut;
        }
        return stripRelayTail(t);
    }

    // The one place the answer's text is decided. Markdown when the DOM can give it,
    // innerText when anything at all goes wrong.
    function answerText(el) {
        if (!el) return '';
        const flat = stripRelayChrome((el.innerText || '').trim()).trim();
        try {
            const md = domToMarkdown(el);
            // A SERIALISER THAT DROPPED HALF THE ANSWER IS WORSE THAN NO SERIALISER.
            //
            // Markdown is legitimately LONGER than the flat text — it adds #, |, backticks,
            // list markers — so it can never be legitimately shorter by much. Comparing the
            // two with the markers stripped catches the one failure this design can produce:
            // a filter or a widget handler that swallows real content. When that happens the
            // flat read is returned instead, which loses the formatting but keeps the answer.
            if (md && md.trim()) {
                // Stripped on the same terms as the flat read above, so the length guard
                // below compares like with like — otherwise a reply whose only chrome was
                // in the markdown read would look 30 characters "longer" than the truth.
                const cleaned = stripRelayChrome(md.trim()).trim();
                const kept = cleaned.replace(/[|`*#>\-\s]/g, '').length;
                const whole = flat.replace(/\s/g, '').length;
                if (cleaned && (!whole || kept >= whole * 0.6)) return cleaned;
            }
        } catch (e) { /* fall through to the flat read */ }
        return flat;
    }

    function readAnswer(ctx, requireGrowth) {
        // A selector that genuinely matches beats inference — but only if it has text.
        const hit = pickAll(SELECTORS.assistant);
        if (hit.els.length) {
            // Widened like the heuristic's pick: a selector that matches one block of the
            // reply must not relay that block as the whole of it.
            const text = answerText(tighten(widenToTurn(ctx, hit.els[hit.els.length - 1])));
            if (text) {
                ctx.strategy = `selector ${hit.selector}`;
                return text;
            }
        }

        const cand = bestCandidate(ctx, requireGrowth);
        const pinnedGone = !ctx.answerRoot || !ctx.answerRoot.isConnected;
        if (cand && (pinnedGone || cand.delta > (ctx.answerDelta || 0))) {
            ctx.answerRoot = cand.el;
            ctx.answerDelta = cand.delta;
            ctx.strategy = `structural heuristic (+${cand.delta} chars)`;
        }

        if (ctx.answerRoot && ctx.answerRoot.isConnected) {
            // The pinned element is where the page is WRITING; the answer is the whole turn
            // around it (see widenToTurn).
            return answerText(tighten(widenToTurn(ctx, ctx.answerRoot)));
        }
        return '';
    }

    function commonPrefixLen(a, b) {
        const n = Math.min(a.length, b.length);
        let i = 0;
        while (i < n && a[i] === b[i]) i++;
        return i;
    }

    /* ---------------------------------------------------------------------
     * WHAT IS LEFT TO SAY — the tail of an answer that has already been streamed
     * ---------------------------------------------------------------------
     * Nothing streamed can be un-said, so the final reconcile can only ever APPEND. The
     * question is where the append starts, and a raw character comparison answers it wrongly
     * whenever the page changed the SHAPE of the answer between the last streamed read and
     * the finished one — which it routinely does, because a half-rendered reply is not
     * marked up the same way as a complete one.
     *
     * That is what put a case summary on screen twice: once as a ladder of single words and
     * then again, whole, underneath. The two texts said the same thing and shared barely a
     * dozen leading characters, so "append from the common prefix" appended the entire
     * answer a second time.
     *
     * So the comparison is made on a projection with the shape taken out — no whitespace,
     * no markdown markers — carrying an index map back into the real text. Same words in the
     * same order means the finished text is a CONTINUATION of what was streamed, however
     * differently it is now laid out, and only the genuinely new characters are sent.
     * Anything else is a real divergence, where repeating a little text is still cheaper
     * than losing the end of the answer.
     * ------------------------------------------------------------------- */
    // What a LINE can start with and still be the same line: indentation, quote markers,
    // heading hashes, a bullet, a list number. List markers matter most — they are drawn by
    // CSS while the answer streams and only become text once it is rendered, so a numbered
    // list is one of the few things guaranteed to change shape at the very last moment.
    // Sticky, so it can be matched at a position without slicing the string.
    const SHAPE_LEAD = /(?:[ \t]+|[>#]+|[-*+•–][ \t]|\d+[.)][ \t])/y;
    // And what can appear anywhere in a line: whitespace, emphasis, code ticks, table pipes.
    const SHAPE_INLINE = /[\s*_`~|]/;

    function shapeFree(s) {
        const out = [];
        const idx = [];
        let i = 0;
        let lineStart = true;
        while (i < s.length) {
            if (s[i] === '\n' || s[i] === '\r') { lineStart = true; i++; continue; }
            if (lineStart) {
                SHAPE_LEAD.lastIndex = i;
                if (SHAPE_LEAD.exec(s)) { i = SHAPE_LEAD.lastIndex; continue; }
                lineStart = false;
                continue;
            }
            if (SHAPE_INLINE.test(s[i])) { i++; continue; }
            out.push(s[i]);
            idx.push(i);
            i++;
        }
        return { out: out.join(''), idx };
    }

    function reconcileTail(sent, finalText) {
        const a = String(sent == null ? '' : sent);
        const b = String(finalText == null ? '' : finalText);
        if (!b || b === a) return '';
        if (b.startsWith(a)) return b.slice(a.length);          // the ordinary case: it simply grew

        const pa = shapeFree(a);
        const pb = shapeFree(b);
        if (pb.out.startsWith(pa.out)) {
            if (pb.out.length === pa.out.length) return '';     // same answer, re-laid-out — nothing to add
            // Resume just past the last character already streamed — located in the SETTLED
            // text, which is the string being sliced — so the whitespace or punctuation that
            // separates it from the new text comes along too.
            return b.slice(pa.out.length ? pb.idx[pa.out.length - 1] + 1 : 0);
        }
        if (pa.out.startsWith(pb.out)) return '';               // the page ended up saying LESS

        if (b.length <= a.length) return '';
        return b.slice(commonPrefixLen(a, b));
    }

    // HAS THIS TURN FINISHED? Asked between CONTEXT PARTS, where there is no answer to read
    // and the only thing that matters is whether the composer is free for the next one.
    //
    // Two independent signals, because neither is universal. The stop control is
    // authoritative where a site has one; DOM churn stands in where it does not, and churn
    // is exactly what a streaming reply produces. A UI with no stop control gets twice the
    // silence before it counts as idle, since quiet is then the only evidence there is.
    async function waitForTurnIdle(ctx, quietMs, maxMs) {
        const until = Date.now() + maxMs;
        let lastSize = -1;
        let lastChange = Date.now();
        let sawGenerating = false;
        for (;;) {
            if (isGenerating()) { sawGenerating = true; lastChange = Date.now(); }
            const size = ctx.watcher ? ctx.watcher.touched.size : 0;
            if (size !== lastSize) { lastSize = size; lastChange = Date.now(); }
            if (Date.now() - lastChange > (sawGenerating ? quietMs : quietMs * 2)) return true;
            if (Date.now() >= until) return false;
            await sleep(200);
        }
    }

    // DID THE SITE CUT THE ANSWER OFF? A web chat caps its own OUTPUT as well as its input,
    // and a JIRA report or a forensic write-up is long enough to hit it. The panel already
    // knows how to resume an answer that stopped early — it does it on a done_reason of
    // "length" — but nothing ever told it the bridge had been cut, so a report
    // that stopped inside its own table was presented as the finished article.
    //
    // Deliberately conservative, because the cost is asymmetric: a false positive spends one
    // continuation round whose output the panel de-duplicates, while a false negative ships a
    // truncated report. An answer that ends on punctuation is finished. One that ends
    // mid-line, well into a long reply, is not.
    function looksTruncated(text) {
        const t = String(text || '').replace(/\s+$/, '');
        if (t.length < 800) return false;                      // short replies are rarely cut
        if (/[.!?…:;"'`)\]}»”|*_-]$/.test(t)) return false;    // a finished sentence, row or bullet
        const lastLine = t.slice(t.lastIndexOf('\n') + 1);
        return lastLine.length > 40;                           // a cut lands mid-sentence
    }

    /* ---------------------------------------------------------------------
     * One request — delivered as one composer-full, or as several
     * ---------------------------------------------------------------------
     * A composer has a length limit. A CONVERSATION does not — it is the whole point of a
     * chat UI that the model remembers what came before. So a prompt too big for the box is
     * not too big for the model: it is sent as PARTS, each within the limit, and only the
     * last one asks for an answer. Everything before it is reference material the page has
     * already accepted and the model is holding.
     *
     * Each part is a full round trip — typed, submitted, echoed back, and waited out until
     * the page is idle again — because typing into a composer that is still streaming the
     * previous reply loses the text.
     * ------------------------------------------------------------------- */
    const active = new Map(); // requestId → { cancelled }

    async function runRequest(msg) {
        const { requestId } = msg;
        const quietMs = msg.quietMs || 1500;
        // When this run started, for the send wait below: the only honest bound on how long
        // anything here may take is the deadline the panel is already counting down.
        const askedAt = Date.now();
        // A bare `prompt` is the single-message shape and still works unchanged.
        // Not const: a failed attachment swaps this for the adapter's text-only layout
        // below, which is what keeps an un-attachable site working instead of erroring.
        let parts = (Array.isArray(msg.parts) && msg.parts.length)
            ? msg.parts
            : [{ text: msg.prompt, echoKey: '', final: true }];
        const state = { cancelled: false };
        active.set(requestId, state);

        // A closed side panel means no receiver, and sendMessage REJECTS rather than
        // throwing — a bare try/catch would miss it and leave an unhandled rejection
        // on every token for the rest of the run.
        const post = (payload) => {
            try {
                const p = chrome.runtime.sendMessage(Object.assign({ requestId }, payload));
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) { /* panel closed */ }
        };
        const diag = (stage, detail) => post({ type: 'SOTI_BRIDGE_DIAG', stage, detail });
        const fail = (why) => { active.delete(requestId); post({ type: 'SOTI_BRIDGE_ERROR', error: why }); };
        // A failure raised from inside a part carries its own explanation; the catch at the
        // bottom reports it verbatim rather than wrapping it in "Bridge relay failed".
        const failure = (why) => { const e = new Error(why); e.__described = true; return e; };

        let watcher = null;

        /* HOW LONG A SEND THAT WILL NOT TAKE IS WORTH PRESSING FOR, and it is only worth
         * pressing at all on a run that put files up: see the two comments in submit().
         *
         * MEASURED AGAINST THE RUN'S OWN DEADLINE, not a flat number and not a share of one.
         * The panel already computes what this whole request may take — the answer timeout plus
         * a minute per ten megabytes of upload — and kills the run at it. That deadline is
         * therefore the only honest bound on the wait: anything shorter gives up while the run
         * still had time to spare, which is exactly what happened on the 58.7MB case at a flat
         * 150s, and anything longer is time the panel has already stopped waiting for.
         *
         * So: whatever is left of the budget when the question has been typed, less a reserve
         * for the answer to actually come back in. On that 58.7MB case the budget is ten
         * minutes, the upload spends some of it, and the send gets whatever remains — minutes,
         * not 150 seconds. A small case is unaffected, because a small case leaves the whole
         * answer timeout standing and never has a button to wait for.
         *
         * The old quarter-of-the-upload-allowance rule is kept for a panel that does not send
         * a budget (an older build talking to a newer relay), and the floor means a run that is
         * nearly out of time still gets one honest go rather than none. */
        let attached = false;
        const ANSWER_RESERVE_MS = 90000;
        const sendBusyMs = () => {
            const budget = Number(msg.budgetMs) || 0;
            if (!budget) return Math.min(180000, Math.max(30000, Math.round((msg.attachTimeoutMs || 120000) / 4)));
            return Math.max(30000, budget - (Date.now() - askedAt) - ANSWER_RESERVE_MS);
        };

        // TYPE ONE PART AND GET IT ACCEPTED. Everything up to and including the echo check is
        // identical for a context part and for the final question, so it is written once.
        // Returns the context the answer-reading steps need; throws a described failure.
        const deliver = async (part, index) => {
            const text = part.text || '';
            const many = parts.length > 1;
            const label = many ? `part ${index + 1}/${parts.length}` : 'prompt';

            // The composer is re-found for every part. Between turns a chat UI routinely
            // rebuilds it, so the element captured for part 1 is frequently detached by
            // part 2 — typing into that writes into a node no longer on the page.
            const found = await waitFor(() => findComposer(SELECTORS.composer), 15000);
            if (!found) {
                // Say what WAS on the page. "Are you signed in?" is a guess, and it was
                // wrong every time it mattered.
                const sample = [...document.querySelectorAll('textarea,[contenteditable],[role="textbox"],input')]
                    .slice(0, 8)
                    .map(el => `${el.tagName}${el.id ? '#' + el.id : ''}${el.isContentEditable ? '[editable]' : ''}`)
                    .join(', ') || 'none';
                throw failure(`No usable message box in this frame of ${location.host} ("${document.title.slice(0, 50)}") for ${label}. Candidates present: ${sample}. If the page shows a composer, add its selector under Settings (⚙) → Bridge selectors.`);
            }
            const composer = found.el;
            if (index === 0) diag('composer', `${found.selector} → ${composer.tagName}${composer.id ? '#' + composer.id : ''} ${found.width}px`);

            const ctx = {
                composer,
                // The echo test needs a string unique to THIS message. The first 40
                // characters are not: every part opens with the same case title, so part 3
                // would happily match part 1's bubble and the relay would believe a message
                // it never sent had been accepted. The adapter stamps each part with a
                // nonce for exactly this, and falls back to the old rule when there is one
                // part and no stamp.
                promptHead: norm(part.echoKey) || norm(text).slice(0, 40),
                // The request words as the key (Beta 9.8.3) are matched loosely too, as the opening words always were; a
                // ⟦SOTI …⟧ mark is too short for that (under 16 letters and digits) and stays exact.
                promptLoose: looseKey(norm(part.echoKey || text).slice(0, 60)),
                watcher: null,
                strategy: ''
            };

            // Watch BEFORE typing, so the user's own turn is in `touched` too and can be
            // excluded by name rather than by hoping it renders after some snapshot. One
            // watcher PER PART: a watcher carried across parts accumulates every earlier
            // turn, and the previous acknowledgement then competes with the real answer.
            if (watcher) watcher.stop();
            watcher = makeWatcher();
            ctx.watcher = watcher;

            const typed = await typeInto(composer, text);
            const typedLen = typed.len;
            if (!typedLen) {
                throw failure(`Could not type into the message box on ${location.host} (matched "${found.selector}"). It may be a custom editor — try a different composer selector in Settings (⚙).`);
            }
            await sleep(150);                       // let the framework's onChange settle
            if (state.cancelled) return null;

            // A composer with a maxlength accepts what fits and DROPS the rest without
            // complaining. Sending anyway would mean analysing a prompt whose evidence
            // was cut off at an arbitrary character — an answer that looks fine and is
            // built on half the case. Read the box back and refuse instead.
            // A few characters of drift is just whitespace normalisation in a rich editor.
            //
            // The measured number is reported to the panel before failing. Guessing the
            // limit is what made this a setting the user had to tune by hand; measuring it
            // once lets the adapter re-split the case to what the box demonstrably holds and
            // try again, which is the difference between an error and an answer.
            /* IN THE BOX ONCE (Beta 9.6.2). A request held twice is never sent: the box is replaced once by a
             * paste over all of it, and if it still holds the request twice the send is refused, so the
             * engineer can press again, rather than Copilot being asked the same thing twice. */
            if (timesHeld(composer, text) > 1) {
                selectAllIn(composer);
                await sleep(60);                    // let the editor take in the selection first
                pasteInto(composer, text);
                await settleBox(composer, text, '', 1200);
                if (timesHeld(composer, text) > 1) {
                    throw failure(`The message box on ${location.host} ended up holding the request twice, so it was not sent. Press the button again.`);
                }
            }
            if (index === 0) diag('typed-via', `${typed.via}${typed.breaksLost ? ' (line breaks lost)' : ''}`);

            // Measured without spaces and line breaks: a rich editor that draws "\n" as a paragraph, or
            // drops one, is not a box that cut the text short.
            const held = (composer.value != null ? composer.value : (composer.innerText || '')).length;
            if (squash(composerHeld(composer)).length < squash(text).length * 0.97) {
                post({ type: 'SOTI_BRIDGE_CAPACITY', accepted: held, attempted: text.length });
                throw failure(
                    `${location.host} accepted only ${held.toLocaleString()} of ${text.length.toLocaleString()} characters — its message box has a length limit, so the rest of the case was silently dropped. ` +
                    `Retrying with parts sized to what it actually holds; if this repeats, set "Max prompt size" in Settings (⚙) to about ${Math.max(2000, Math.floor(held / 500) * 500).toLocaleString()}.`);
            }
            if (index === 0) diag('typed', `${held.toLocaleString()} chars accepted`);

            const budgetForSend = attached ? sendBusyMs() : 0;
            const how = await submit(composer, {
                busyMs: budgetForSend,
                // Reported rather than waited out in silence: the engineer watching the relay
                // sees why nothing is happening, and the panel's stall watchdog counts any
                // message from this frame as a sign of life.
                onWait: (secs, sel, presses) => diag('send-wait',
                    `${location.host} has not taken the send button (${sel}) ${secs}s after the case was typed`
                    + (presses ? ` — ${presses} presses ignored so far` : ' — it is still greyed out')
                    + `. It is finishing the upload; pressing for up to ${Math.round(budgetForSend / 1000)}s, `
                    + `which is what is left of this run's budget.`)
            });
            if (index === 0) diag('submit', how);

            // Gate 1: was the message accepted at all? Nothing may be read off the page
            // until our own turn has rendered, or a sign-in wall becomes "the answer".
            const accepted = await waitFor(() => promptEchoed(ctx), 20000);
            if (state.cancelled) return null;
            if (!accepted) {
                throw failure(
                    `${location.host} never showed ${label} back, so it was not accepted (sent via ${how}). ` +
                    `The usual cause is that you are NOT SIGNED IN in that tab — open it, sign in, and try again. ` +
                    `It can also mean the send control did not fire, or the site refused ${text.length.toLocaleString()} characters as too long.`);
            }
            return { ctx, how };
        };

        try {
            // THE FILE GOES UP BEFORE ANYTHING IS TYPED. The upload has to be complete when
            // the question is sent, and it is the slow step, so it happens first and alone.
            //
            // A failed attach is NOT a failed run. The adapter sends `fallbackParts` — the
            // same case laid out as text — precisely so that a site that will not take a
            // file still gets analysed. Swapping to it here, rather than aborting, is why
            // this path can be the default instead of an option the engineer has to know
            // about. The reason is reported either way, because "it was slower than usual"
            // is not something to discover later.
            if (Array.isArray(msg.attachments) && msg.attachments.length) {
                try {
                    // The composer is the proof that the chat UI has actually mounted. Hunting
                    // for the upload control before it exists is how this failed the first
                    // time — the request arrives the instant the script is injected, which is
                    // routinely earlier than the app is ready to be driven.
                    await waitFor(() => findComposer(SELECTORS.composer), 15000);
                    // A case file too big to ride inside this message was delivered ahead of
                    // it in pieces; this is where it becomes one string again.
                    const specs = reassembleAttachments(requestId, msg.attachments);
                    const bytes = specs.reduce((n, a) => n + String((a && a.text) || '').length, 0);
                    diag('attach', await attachFiles(specs, msg.attachTimeoutMs || 120000, msg.maxAttachments)
                        + ` (${bytes.toLocaleString()} chars)`);
                    // Set only once the files are up and quiet, because this is what buys the
                    // send button its patience — and a grey button on a run that attached
                    // NOTHING is the over-long-message case, which must still fail fast.
                    attached = true;
                } catch (e) {
                    if (Array.isArray(msg.fallbackParts) && msg.fallbackParts.length) {
                        diag('attach-fallback', (e && e.message) || String(e));
                        parts = msg.fallbackParts;
                        attached = false;
                        await clearAttachments();
                    } else {
                        throw failure((e && e.message) || String(e));
                    }
                } finally {
                    // The pieces have become a File (or the attempt has failed and the text
                    // layout has taken over). Either way nothing needs them again, and a big
                    // bundle left in this Map is tens of megabytes held in the page for as
                    // long as the tab lives.
                    releaseAttachBuffer(requestId);
                }
            }

            // CONTEXT PARTS FIRST. Each is loaded and waited out; none of them is read for an
            // answer, because none of them asked for one. A part that the page never accepts
            // stops the run — carrying on would analyse a case with a hole in the middle of
            // it, and nothing downstream could tell.
            for (let i = 0; i < parts.length - 1; i++) {
                if (state.cancelled) { active.delete(requestId); return; }
                const sent = await deliver(parts[i], i);
                if (!sent) { active.delete(requestId); return; }   // cancelled mid-part
                // Wait for the acknowledgement to finish rendering. Typing into a composer
                // that is still streaming loses the text — silently, which is the whole
                // reason this is a wait and not a sleep.
                const idle = await waitForTurnIdle(sent.ctx, quietMs, 120000);
                if (state.cancelled) { active.delete(requestId); return; }
                if (!idle) {
                    return fail(`${location.host} never went idle after context part ${i + 1} of ${parts.length}. The conversation may have hit a rate limit — try again, or lower "Context parts" in Settings (⚙).`);
                }
                diag('context', `part ${i + 1}/${parts.length} accepted (${(parts[i].text || '').length.toLocaleString()} chars)`);
                post({ type: 'SOTI_BRIDGE_PART', index: i + 1, total: parts.length });
            }

            if (state.cancelled) { active.delete(requestId); return; }

            // THE FINAL PART is the only one that asks a question, so it is the only one
            // whose answer is read.
            const last = parts.length - 1;
            const sentFinal = await deliver(parts[last], last);
            if (!sentFinal) { active.delete(requestId); return; }
            const ctx = sentFinal.ctx;
            const how = sentFinal.how;
            diag('accepted', parts.length > 1
                ? `all ${parts.length} parts echoed into the conversation`
                : 'prompt echoed into the conversation');

            // Gate 2: has the assistant begun answering?
            const started = await waitFor(
                () => isGenerating() || !!bestCandidate(ctx, false),
                25000
            );
            if (state.cancelled) return;
            if (!started) {
                return fail(`${location.host} accepted the message (via ${how}) but produced no answer within 25s.`);
            }
            diag('reading', ctx.strategy || 'pending');

            /* ---- stream until quiet ---- */
            let sent = '';          // what has actually been streamed to the panel
            let prevFull = '';      // last text read, emitted or not
            let confirmed = false;  // has the text proved itself an answer rather than a status?
            let lastChange = Date.now();
            let sawGenerating = false;
            let finished = false;
            const hardStop = Date.now() + 10 * 60 * 1000;
            // (QA Tool addition) How long an unchanged answer outlasts a Stop control — see stuckStop.
            const STOP_STALE_MS = 30000;

            await new Promise((resolve) => {
                let mo = null, iv = null;
                const stopWatching = () => {
                    if (mo) { mo.disconnect(); mo = null; }
                    if (iv) { clearInterval(iv); iv = null; }
                };
                const finish = () => {
                    if (finished) return;
                    finished = true;
                    stopWatching();
                    resolve();
                };

                // Driven by the observer, so a throttled background tab does not slow the
                // stream; the interval is only a safety net for UIs that finish silently.
                const tick = () => {
                    if (finished) return;

                    if (state.cancelled) {
                        const stop = pick(SELECTORS.stop);
                        if (stop) stop.el.click();
                        return finish();
                    }

                    const generating = isGenerating();
                    if (generating) sawGenerating = true;

                    // While the model is still writing, only a GROWING element may be
                    // adopted — that is what stops a static page label being streamed as the
                    // answer. Once it has gone quiet, an answer that rendered in one shot
                    // (short replies do) is accepted on its own merits.
                    /* (QA Tool addition) A STOP CONTROL THAT NEVER GOES AWAY IS NOT A MODEL
                     * STILL WRITING. Something on the page that answers to a "Stop" selector and
                     * stays put after the reply — a dictation control, a hidden stop button left
                     * in the layout — held `generating` true for good: no one-shot reply could be
                     * adopted and nothing could finish before the ten-minute ceiling. Once an
                     * answer is in hand and has not changed for STOP_STALE_MS, the control is
                     * treated as stale. Never before an answer: a model thinking over a large
                     * case shows nothing at all for a minute or more, and that silence is real. */
                    const stuckStop = generating && !!prevFull && Date.now() - lastChange > STOP_STALE_MS;
                    const writing = generating && !stuckStop;
                    const settling = !writing && Date.now() - lastChange > quietMs;
                    const full = readAnswer(ctx, !settling);

                    if (full) {
                        if (full !== prevFull) lastChange = Date.now();

                        /* THE PANEL SHOWS WHAT THE PAGE SHOWS — see SOTI_BRIDGE_REPLACE.
                         *
                         * This used to be append-only, and everything awkward about it came
                         * from that one constraint. "Nothing streamed can be un-said" is true
                         * of a token stream from an API; it was never true here, because what
                         * is being watched is a RENDERED PAGE, and a rendered page rewrites
                         * itself constantly while it writes:
                         *
                         *   · a placeholder ("Gathering details…") is REPLACED by the answer;
                         *   · a paragraph re-flows into a bullet once the list marker lands;
                         *   · a numbered list renumbers itself when an item is inserted;
                         *   · a fenced code block reformats the instant its closing fence
                         *     arrives, changing the text ABOVE the insertion point;
                         *   · a table is a run of tab-separated words until its final row.
                         *
                         * Append-only could not express any of that, so on divergence it HELD:
                         * the panel froze mid-answer while Copilot carried on typing, and
                         * everything it had missed arrived in one lump at the end when the
                         * reconcile ran. That is the whole of "the typing is not identical".
                         *
                         * A replace expresses all of it exactly, so the panel now mirrors the
                         * page instead of approximating it. Deltas still carry the common case
                         * — the answer simply grew — because they are a fraction of the bytes;
                         * a replace is sent only when the page has genuinely rewritten what it
                         * already showed.
                         *
                         * THE CONFIRMATION STEP GOES WITH IT. It existed only to keep a
                         * placeholder out of a stream that could not retract one, and a
                         * placeholder is now simply corrected by the next read — which is
                         * exactly what the page does to it. Waiting for proof cost the first
                         * visible tokens of every single answer.
                         */
                        confirmed = true;

                        if (full.startsWith(sent) && full.length > sent.length) {
                            post({ type: 'SOTI_BRIDGE_DELTA', text: full.slice(sent.length) });
                            sent = full;
                        } else if (full !== sent) {
                            post({ type: 'SOTI_BRIDGE_REPLACE', text: full });
                            sent = full;
                        }
                        prevFull = full;
                    }

                    const quiet = Date.now() - lastChange > quietMs;
                    // Two ways to be finished: the stop control came and went, or a UI that
                    // never showed one has simply gone silent for twice the quiet window.
                    // Gated on prevFull rather than on what has been STREAMED — the two are
                    // the same thing now that nothing is held back, but they were not always,
                    // and a loop that ends on what was emitted is one edit away from hanging
                    // on a reply it decided not to emit.
                    const done = prevFull && quiet && !writing &&
                                 (sawGenerating || Date.now() - lastChange > quietMs * 2);
                    if (done || Date.now() > hardStop) finish();
                };

                mo = new MutationObserver(tick);
                mo.observe(document.body, { childList: true, subtree: true, characterData: true });
                /* THE OBSERVER IS THE DRIVER; THIS IS THE BACKSTOP — and it is what decides how
                 * far the panel can fall behind the page.
                 *
                 * The observer fires on every mutation, so a page that is actively writing
                 * needs nothing from this timer. Two things do: a UI that finishes SILENTLY
                 * (no final mutation to notice), and the `done` test itself, which is time-based
                 * and only runs when a tick runs. 400ms meant the end of an answer could sit
                 * unnoticed for four tenths of a second after the page had stopped — small, but
                 * it is at the one moment the engineer is watching for the answer to settle.
                 *
                 * 250ms is affordable because tick() is cheap when nothing has changed:
                 * readAnswer resolves the pinned answer root and reads its text, and an
                 * unchanged read costs one string compare. */
                iv = setInterval(tick, 250);
            });

            if (state.cancelled) { active.delete(requestId); return; }

            /* FINAL RECONCILE: whatever the page settled on is authoritative — and now it can
             * simply BE the answer.
             *
             * This used to compute an append-only tail through reconcileTail, because a stream
             * could not retract what it had said. It cost a whole mechanism (find where the
             * finished text resumes, tolerantly, across a re-render that changed the markdown)
             * to approximate a thing that is now one message: the page's final text, verbatim.
             * reconcileTail is kept for the moment — it is still the honest fallback if a
             * replace is ever refused — but the normal path no longer has to guess. */
            const finalText = readAnswer(ctx, false);
            if (finalText && finalText !== sent) {
                post({ type: 'SOTI_BRIDGE_REPLACE', text: finalText });
                sent = finalText;
            }

            if (!sent && !prevFull) {
                return fail(`${location.host} answered, but nothing could be read off the page (strategy: ${ctx.strategy || 'none matched'}). Set an "Answer container" selector in Settings (⚙) → Bridge selectors.`);
            }

            // A site caps its own output as well as its input. Say so, and the panel resumes
            // the answer through the continuation path it already has.
            const truncated = looksTruncated(sent || prevFull);
            if (truncated) diag('truncated', 'the answer ends mid-sentence — asking the panel to continue it');

            active.delete(requestId);
            post({ type: 'SOTI_BRIDGE_DONE', truncated });
        } catch (e) {
            if (e && e.__described) fail(e.message);
            else fail(`Bridge relay failed on ${location.host}: ${e && e.message ? e.message : e}`);
        } finally {
            if (watcher) watcher.stop();
        }
    }

    /* ---------------------------------------------------------------------
     * Tidying up after ourselves
     * ---------------------------------------------------------------------
     * Every relayed request leaves a conversation behind, so a day's work buries
     * the engineer's own chats under a wall of "=== INSTRUCTIONS (follow th…".
     *
     * Deleting is destructive and the list holds REAL chats, so this never picks a
     * row by position, by title, or by "the newest one". It reads the conversation
     * id out of location.pathname — the conversation this relay is sitting in,
     * which it created seconds ago — and acts only on the sidebar row whose href
     * carries that exact id. If that row cannot be found, or the menu does not
     * offer a delete, it gives up and leaves everything alone. A leftover chat is
     * untidy; a wrongly deleted one is gone.
     * ------------------------------------------------------------------- */
    // The id of the conversation this relay is sitting in, or '' if it is not in one.
    //
    // Scanned segment by segment rather than pattern-matched: a regex over the path
    // matched "/chat/" first on a real URL and captured the literal word "conversation"
    // as the id — which would have sent the delete routine hunting for a row that does
    // not exist, on a page where the rows that DO exist are the engineer's own chats.
    // Everything that is not plainly an id is rejected, and '' aborts the delete entirely.
    function currentConversationId() {
        const ROUTE = /^(new|chat|chats|conversation|conversations|history|library|search|c|thread)$/i;
        const segs = String((typeof location !== 'undefined' && location.pathname) || '').split('/').filter(Boolean);
        for (let i = segs.length - 1; i >= 0; i--) {
            const s = segs[i];
            if (ROUTE.test(s)) continue;          // a route name is not an id
            if (s.length < 8) continue;           // ids are long
            if (!/[0-9]/.test(s)) continue;       // ids carry digits; slugs usually do not
            if (!/^[A-Za-z0-9._-]+$/.test(s)) continue;
            return s;
        }
        return '';
    }

    // The Delete entry of an open row menu.
    //
    // Written against the real thing, which is Fluent UI v9:
    //   <div role="menuitem" aria-label="Delete" class="fui-MenuItem …">
    //     <span class="fui-MenuItem__icon"><svg/><svg/></span>
    //     <span class="fui-MenuItem__content">Delete</span>
    //   </div>
    //
    // Two mistakes the first version made are worth keeping named. It scoped the query to
    // `[role="menu"] [role="menuitem"]`, but Fluent PORTALS its popover to the end of the
    // body, so the menu item is nowhere near the row and frequently has no `role="menu"`
    // ancestor at all. And it matched on innerText, which here is assembled from a span
    // sitting beside two inline SVGs — aria-label carries the same word, exactly, with
    // nothing to trip over.
    function findDeleteItem() {
        let nodes;
        try {
            nodes = document.querySelectorAll('[role="menuitem"],[role="option"],[role="menuitemradio"],.fui-MenuItem');
        } catch (e) { return null; }
        for (const n of nodes) {
            if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') continue;
            const label = norm(n.getAttribute && n.getAttribute('aria-label'));
            if (/^(delete|remove)$/i.test(label)) return n;
            if (/^(delete|remove)\b/i.test(norm(n.innerText))) return n;
        }
        return null;
    }

    // A Fluent menu item is a div, and a hidden control may still be perfectly clickable.
    // click() alone is usually enough — React listens for the bubbled event — but some
    // items are wired to keyboard activation, so Enter follows if the item is still there.
    async function activate(el) {
        try { el.focus(); } catch (e) {}
        try { el.click(); } catch (e) {}
        await sleep(160);
        if (el.isConnected) {
            for (const type of ['keydown', 'keyup']) {
                try {
                    el.dispatchEvent(new KeyboardEvent(type, {
                        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                    }));
                } catch (e) {}
            }
        }
    }

    // The sidebar row for a given conversation id.
    //
    // Looking for a[href*=id] was too narrow: this list is built from buttons and divs
    // with the id in a data- attribute, not from links, so the lookup found nothing and
    // the delete quietly gave up. Any attribute will do — the id is the anchor, not the
    // element type — and the SMALLEST matching element is taken, because a container
    // higher up would carry the whole list.
    function findConversationRow(id) {
        if (!id) return null;
        const hits = [];
        let all;
        try { all = document.querySelectorAll('*'); } catch (e) { return null; }
        for (const el of all) {
            if (!el.getAttributeNames) continue;
            for (const name of el.getAttributeNames()) {
                const v = el.getAttribute(name);
                if (v && v.indexOf(id) !== -1) { hits.push(el); break; }
            }
        }
        if (!hits.length) return null;
        // Deepest / smallest wins: it is the row itself rather than an ancestor list.
        hits.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        return hits[0];
    }

    // The row's overflow ("…") control. It is frequently a sibling rather than a child,
    // and usually only rendered while the row is hovered, so this hovers and then widens
    // the search one ancestor at a time.
    // Open a row's menu, and confirm it opened by finding Delete in it.
    //
    // The row's "…" trigger is hidden until hover, and CSS :hover CANNOT be triggered by
    // synthetic events — it follows the real pointer. So the trigger is searched for
    // WITHOUT a visibility test: an element hidden by opacity or display is still in the
    // DOM and still responds to click(). Hover events are dispatched anyway, since some
    // implementations gate on JS handlers rather than CSS, and a right-click on the row is
    // kept as a last resort because Fluent trees often expose the same menu that way.
    // What the row itself says about reaching its controls, verbatim from the live page:
    //
    //   <a class="fui-NavSubItem … fui-SplitNavItem__navItem" aria-label="SOTI AI Analyser…">
    //     <span>SOTI AI Analyser — automated request.=== INSTRUCTI</span>
    //     <span>Press Tab to access the Pin and More options buttons.</span>
    //   </a>
    //
    // "Press Tab to access" is the whole answer. This is a Fluent SplitNavItem: the link is
    // one half, and the Pin / More options buttons are SIBLINGS of it, revealed by FOCUS.
    // The previous attempt searched inside the row (there are only spans in there) and
    // dispatched hover events (CSS :hover follows the real pointer and ignores synthetic
    // events). Focusing the link is what the component actually responds to.
    function triggerScore(b) {
        const s = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' +
                  (typeof b.className === 'string' ? b.className : '');
        if (/more|ellips|overflow/i.test(s)) return 3;      // "More options" — the one we want
        if (b.getAttribute('aria-haspopup')) return 2;
        if (/option|menu|action/i.test(s)) return 1;
        return 0;                                            // Pin, and anything else: leave alone
    }

    async function openRowMenu(row) {
        // The split item, not the link: the buttons live beside the anchor.
        let container = row;
        try { container = row.closest('.fui-SplitNavItem, li, [role="treeitem"], [role="listitem"]') || row.parentElement || row; }
        catch (e) { container = row.parentElement || row; }

        const tried = [];

        for (const scope of [container, container.parentElement, row.parentElement].filter(Boolean)) {
            // Focus first — that is what mounts/reveals the split-item actions — then hover
            // as well, for implementations that gate on JS handlers instead.
            try { row.focus(); } catch (e) {}
            for (const type of ['focus', 'focusin']) {
                try { row.dispatchEvent(new FocusEvent(type, { bubbles: true })); } catch (e) {}
            }
            for (const type of ['pointerover', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
                try { scope.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); } catch (e) {}
            }
            await sleep(280);

            let buttons;
            try { buttons = [...scope.querySelectorAll('button,[role="button"],[aria-haspopup]')]; } catch (e) { buttons = []; }
            const ranked = buttons
                .filter(b => b !== row && triggerScore(b) > 0)
                .sort((a, b) => triggerScore(b) - triggerScore(a));

            for (const btn of ranked) {
                tried.push(btn.getAttribute('aria-label') || btn.className.slice(0, 20) || btn.tagName);
                try { btn.click(); } catch (e) { continue; }
                const item = await waitFor(findDeleteItem, 1400, 120);
                if (item) return { item, how: `“${btn.getAttribute('aria-label') || 'options'}” button` };
            }
        }

        try { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); } catch (e) {}
        const item = await waitFor(findDeleteItem, 1200, 120);
        if (item) return { item, how: 'context menu' };

        // Name what was actually there, so a failure points at the next thing to fix.
        let near = [];
        try {
            near = [...container.querySelectorAll('button,[role="button"]')]
                .map(b => b.getAttribute('aria-label') || b.tagName).slice(0, 6);
        } catch (e) {}
        return { failed: true, tried, near };
    }

    // Describes the list when the row cannot be found, so the next fix is informed by the
    // real markup instead of another guess about it.
    function sidebarShape() {
        const rows = [...document.querySelectorAll('nav a, nav button, nav li, [role="navigation"] a, [role="navigation"] button, aside a, aside button')]
            .filter(visible).slice(0, 6);
        if (!rows.length) return 'no nav/aside rows visible in this frame';
        return rows.map(r => `${r.tagName}${r.id ? '#' + r.id : ''}[${r.getAttributeNames().slice(0, 5).join(',')}]`).join(' | ');
    }

    // Titles only this tool produces. The relay writes the first line of every prompt, so
    // the conversation names itself — which makes the TITLE a better anchor than the id.
    // An id has to be present in the markup to be usable, and in a React-built list it
    // often is not; a title is on screen by definition. It is also a strict safety filter:
    // "Summarize this email" and "How to downgrade SOTI Cloud" can never match these.
    const RELAY_TITLE_MARKERS = ['SOTI AI Analyser', '=== INSTRUCTIONS'];

    function looksLikeRelayTitle(text, titles) {
        const t = norm(text);
        if (!t) return false;
        if (RELAY_TITLE_MARKERS.some(m => t.startsWith(m))) return true;
        // Case-numbered titles: "C01720260 · SOTI AI Analyser". BOTH halves are required —
        // a case number alone is something an engineer might well name a chat, and the
        // marker alone could be a note about the tool. Together they are only ever ours.
        //
        // The marker is matched SHORT because the app clips titles: the live page showed
        // aria-label="SOTI AI Analyser — automated request.=== INSTRUCTI", cut at 50
        // characters. Requiring the full name would work today and silently stop matching
        // the moment a case number ran long.
        if (/^[A-Za-z]{0,3}\d{5,}\b/.test(t) && /\bSOTI AI\b/.test(t)) return true;
        /* SINCE BETA 9.6.2 the title is the case number and the case's subject ("C01741332 - Javascript require('ini')
         * fails…"), which a chat an engineer names by hand can look like. So only a title this tool wrote counts: the
         * relay hands over the list of them. A row matches when it IS one of them, or, when the list shows it clipped
         * with "…", when it is the start of one, 20 characters at least. Always a case number first. */
        if (!/^[A-Za-z]{1,3}\d{6,}\b/.test(t) || !Array.isArray(titles) || !titles.length) return false;
        const clipped = /(?:…|\.\.\.)$/.test(t);
        const shown = t.replace(/(?:…|\.\.\.)$/, '').trim();
        return titles.some((k) => {
            const known = norm(k);
            return shown === known || (clipped && shown.length >= 20 && known.startsWith(shown));
        });
    }

    // Rows in the chat list whose title this tool wrote. Scoped to navigation containers
    // and to row-shaped elements so the message bubble — which also opens with the title
    // line — cannot be mistaken for a list entry.
    function relayRows(titles) {
        let scope = null;
        try { scope = document.querySelector('nav, [role="navigation"], aside'); } catch (e) {}
        scope = scope || document.body;
        if (!scope) return [];

        let candidates;
        try {
            candidates = [...scope.querySelectorAll('a,button,li,[role="treeitem"],[role="option"],[role="listitem"],[role="menuitem"]')];
        } catch (e) { return []; }

        const hits = candidates.filter(el => visible(el) && looksLikeRelayTitle(el.innerText || '', titles));
        // Drop any candidate that contains another: keep the row, not its wrapper.
        return hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
    }

    // Delete one row: hover, open its menu, choose Delete, confirm.
    // The confirmation button, which on this page is a bare Fluent button carrying its word
    // as TEXT and no aria-label at all:
    //   <button type="button" aria-busy="false" class="fui-Button …">Delete</button>
    // Searched inside a dialog first; if the surface carries no dialog role, a visible
    // button whose entire label is "Delete" is accepted — by that point Delete has already
    // been chosen from the row menu, so a confirmation is the only thing being waited for.
    function findConfirmButton() {
        const exact = (b) => /^(delete|remove|yes)$/i.test(norm(b.getAttribute && b.getAttribute('aria-label')))
                          || /^(delete|remove|yes)$/i.test(norm(b.innerText));
        for (const sel of ['[role="dialog"] button, [role="alertdialog"] button, .fui-DialogActions button, .fui-DialogSurface button',
                           'button']) {
            let btns;
            try { btns = [...document.querySelectorAll(sel)]; } catch (e) { continue; }
            const hit = btns.find(b => visible(b) && exact(b));
            if (hit) return hit;
        }
        return null;
    }

    async function deleteRow(row) {
        const opened = await openRowMenu(row);
        if (!opened || opened.failed) {
            try { document.body.click(); } catch (e) {}   // close anything half-open
            const tried = opened && opened.tried && opened.tried.length ? ` (clicked: ${opened.tried.join(', ')})` : '';
            const near = opened && opened.near && opened.near.length ? ` (controls near the row: ${opened.near.join(', ')})` : ' (no controls found near the row)';
            return { ok: false, why: `no menu offering Delete opened for that row${tried}${near}` };
        }

        await activate(opened.item);

        const confirm = await waitFor(findConfirmButton, 2500, 150);
        if (confirm) await activate(confirm);

        const gone = await waitFor(() => !row.isConnected, 4000, 200);
        return gone
            ? { ok: true, how: opened.how }
            : { ok: false, why: `opened the menu via ${opened.how} and clicked Delete${confirm ? ' and confirmed' : ' (no confirmation appeared)'}, but the row is still there` };
    }

    // Remove the relay's own conversations — this run's, and any left behind by earlier
    // ones. Only ever rows whose title this tool wrote.
    async function deleteRelayConversations(explicitId, max, titles) {
        const limit = Math.max(1, max || 3);
        const notes = [];
        let removed = 0;

        // The id is still tried first where it exists: it is exact, and it identifies THIS
        // conversation specifically rather than the family of them.
        const byId = findConversationRow(explicitId || currentConversationId());
        if (byId) {
            const r = await deleteRow(byId);
            if (r.ok) removed++;
            else notes.push(`by id: ${r.why}`);
        }

        for (let i = 0; i < limit && removed < limit; i++) {
            const rows = relayRows(titles);
            if (!rows.length) break;
            const r = await deleteRow(rows[0]);
            if (r.ok) { removed++; await sleep(400); continue; }
            notes.push(`by title: ${r.why}`);
            break;                                   // the same failure will just repeat
        }

        if (removed) return { ok: true, removed, why: notes.join(' · ') };
        return {
            ok: false,
            removed: 0,
            why: notes.length
                ? notes.join(' · ')
                : `no relay conversations found in this frame (${sidebarShape()})`
        };
    }

    /* ---------------------------------------------------------------------
     * Wiring
     * ------------------------------------------------------------------- */
    // The extraction heuristic decides whether this whole path works, so it is exported
    // for tests/copilot-bridge.test.js to drive against a fake DOM. Everything else here
    // needs a live page; this part is pure enough to pin down properly.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { stripRelayChrome, heuristicAnswerNode, bestCandidate, readAnswer, tighten, commonPrefixLen, reconcileTail, norm, promptEchoed, typeable, findComposer, currentConversationId, findConversationRow, looksLikeRelayTitle, findDeleteItem, findConfirmButton, triggerScore, looksTruncated, domToMarkdown, answerText, codeWidget, acceptsFile, acceptRank, findFileInput, findFileInputIn, findFileInputs, attachBlocked, reachableDocs, revealUploadControl, attachmentRemovers, attachmentsBusy, clearAttachments, attachFiles, reassembleAttachments, releaseAttachBuffer, sweepAttachBuffer };
    }
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || !msg.type) return;

        // Lets the panel prove injection worked before blaming the selectors.
        if (msg.type === 'SOTI_BRIDGE_PING') {
            // A ping is also the moment to re-assert liveness. A document replaced by a
            // sign-in redirect loses the shim, and a window that has been sitting behind
            // another one for a while is exactly where that matters most.
            let woke = false;
            try { woke = installLivenessShim(); } catch (e) { /* reported below as awake:false */ }
            /* AND IF IT WAS ALREADY INSTALLED, WAKE THE PAGE ANYWAY.
             *
             * installLivenessShim returns early on a document that already has it, so on every
             * ping after the first it did nothing at all — which made the extension's whole
             * revival escalation a no-op against the one thing it was written for: an app
             * shell that has been sitting behind another window long enough to tear its own
             * composer down. The events are what put it back; re-fire them. */
            try { if (!woke && typeof window.__sotiWake === 'function') window.__sotiWake(); } catch (e) { /* page handler threw */ }
            const c = findComposer(DEFAULT_SELECTORS.composer);
            sendResponse({
                ok: true,
                host: location.host,
                composer: c ? `${c.selector} (${c.width}px)` : null,
                title: document.title,
                // What the extension needs to tell "the relay is thinking" from "the relay
                // is asleep": whether the shim is on, and whether Chrome still considers
                // this window occluded despite it (visible via the compositor, not the
                // spoofed property — see wasOccluded).
                awake: !!window.__sotiRelayAwake,
                woke,
                occluded: wasOccluded()
            });
            return false;
        }

        /* ONE BEAT OF THE CLOCK THE BROWSER CANNOT SLOW DOWN.
         *
         * Deliberately the cheapest handler in the file, because it runs five times a second
         * for as long as a request is in flight: it runs the animation frames Chrome refused
         * to deliver, releases any wait whose time has come, and re-takes the occlusion
         * reading. Nothing here searches the DOM.
         *
         * Sent to EVERY frame, because the composer is routinely in a child one and each
         * frame has waits of its own. Chrome keeps the first reply and discards the rest,
         * which is fine — the reply is only diagnostic. */
        if (msg.type === 'SOTI_BRIDGE_TICK') {
            let frames = 0;
            try { frames = onExternalTick(); } catch (e) { /* nothing pending */ }
            sendResponse({ ok: true, frames, awake: !!window.__sotiRelayAwake, occluded: wasOccluded() });
            return false;
        }

        if (!msg.requestId) return;

        /* A PIECE OF A BIG CASE FILE, arriving ahead of the request that will use it.
         *
         * See deliverLargeAttachments in ai-provider.js. A 37.5 MB log bundle is not something
         * to put inside one extension message, so it comes over in 4 MB pieces which are held
         * here until the ASK arrives and names them. Every piece is acknowledged — an
         * unacknowledged one is an error on the panel's side rather than a file that is
         * quietly short at this one.
         *
         * Pieces are kept per requestId and per slot (the index of the attachment they belong
         * to), so two requests in flight cannot bleed into each other. */
        if (msg.type === 'SOTI_BRIDGE_ATTACH_CHUNK') {
            try {
                let slots = ATTACH_BUFFER.get(msg.requestId);
                if (!slots) { slots = new Map(); ATTACH_BUFFER.set(msg.requestId, slots); }
                let pieces = slots.get(msg.slot || 0);
                if (!pieces) { pieces = []; slots.set(msg.slot || 0, pieces); }
                pieces[msg.index || 0] = String(msg.text == null ? '' : msg.text);
                sweepAttachBuffer(msg.requestId);
                sendResponse({ ok: true, held: pieces.filter(x => x != null).length });
            } catch (e) {
                sendResponse({ ok: false, why: (e && e.message) || String(e) });
            }
            return false;
        }

        if (msg.type === 'SOTI_BRIDGE_ASK') {
            if (msg.selectors && typeof msg.selectors === 'object') {
                // Every list the relay uses is kept: custom selectors used to drop fileInput and
                // removeAttachment, and the attach step then failed on a list that was not there.
                SELECTORS = Object.assign({}, DEFAULT_SELECTORS, {
                    composer: msg.selectors.composer || DEFAULT_SELECTORS.composer,
                    send: msg.selectors.send || DEFAULT_SELECTORS.send,
                    stop: msg.selectors.stop || DEFAULT_SELECTORS.stop,
                    assistant: msg.selectors.assistant || DEFAULT_SELECTORS.assistant
                });
            } else {
                SELECTORS = DEFAULT_SELECTORS;
            }
            // Acknowledge synchronously — the panel's sendMessage promise rejects if
            // nothing answers, and it uses that to report "the page isn't reachable".
            sendResponse({ ok: true });
            runRequest(msg);
            return false;
        }

        // Delete the conversation this relay just created. Async, so the listener must
        // return true to keep the response channel open.
        if (msg.type === 'SOTI_BRIDGE_CLEANUP') {
            deleteRelayConversations(msg.conversationId, msg.max, Array.isArray(msg.titles) ? msg.titles : [])
                .then(r => sendResponse(r))
                .catch(e => sendResponse({ ok: false, why: (e && e.message) || String(e) }));
            return true;
        }

        if (msg.type === 'SOTI_BRIDGE_CANCEL') {
            releaseAttachBuffer(msg.requestId);
            const st = active.get(msg.requestId);
            if (st) st.cancelled = true;
            const stop = pick(SELECTORS.stop);
            if (stop) stop.el.click();
            sendResponse({ ok: true });
            return false;
        }
    });
})();
