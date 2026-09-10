/* ============================================================================
 * QA Tool — THE CASE READER
 * ============================================================================
 * One background window, one tab per case, and a routine that opens a
 * Salesforce case record in it and comes back with the whole case read.
 *
 * This is the SOTI AI Analyser's reader-window machinery, carried over because
 * it is the part of that tool with the most bruises on it. Every comment below
 * that describes a failure describes one that actually happened, and the shape
 * of the code is what stopped it. It is not worth re-deriving here — a QA run
 * that reads thirty cases in a row exercises every one of those failures harder
 * than the analyser ever did.
 *
 * WHAT IT IS FOR HERE. The QA team's whole task is "go through the case list one
 * by one, open each case, read everything". Doing that by hand is thirty page
 * loads and thirty scrolls to the bottom of a feed. This does it in a window
 * that stays out of the way, and hands qa-engine.js the case as data.
 *
 * The public surface is small:
 *
 *   QaReader.readCase(url, opts) → { ok, data } | { ok: false, error }
 *   QaReader.ownsTab(tab)        → is this one of ours (never "where is this case")
 *   QaReader.createTab(opts, cb) → chrome.tabs.create, aimed away from the reader
 *   QaReader.closeIdle()         → shut the window now, whatever the idle timer says
 * ========================================================================== */
(function () {
    'use strict';

    function isChromeExtension() {
        return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    }

    /* ===========================================================================
     * THE READER WINDOW — one background window, one tab per case
     * ===========================================================================
     * Every case read could get a WINDOW of its own: created minimized, driven,
     * closed. That is one browser window per case, and over a thirty-case QA run
     * it is thirty opened and shut. Each costs a browser-process window, a
     * compositor and a taskbar entry, and each is another chance for Windows to
     * raise something in front of what the reviewer is typing into.
     *
     * So there is ONE window, and each read opens a TAB in it. What that saves is
     * the per-window overhead and the flicker — it is NOT a saving in renderers,
     * and it would be dishonest to claim otherwise: four Lightning record pages
     * are four renderer processes whether they sit in four windows or four tabs.
     * What it removes is real, though, and it is the part that was visible.
     *
     * THE ANCHOR TAB is the one non-obvious piece. Chrome closes a window when its
     * last tab goes, so a window holding only reader tabs would vanish the moment
     * one case finished before the next began — and the next case would then pay
     * for a new window anyway. A permanent about:blank tab keeps it alive between
     * cases. It is also the ACTIVE tab, which is what makes every reader tab open
     * in the background where it belongs.
     *
     * IT OUTLIVES ONE READ, deliberately, which is what makes a sequential run
     * cheap: case two does not rebuild what case one just tore down.
     * ========================================================================= */
    const READER_IDLE_MS = 8000;

    const reader = {
        winId: null,
        anchorTabId: null,
        leases: 0,           // readers currently using it; 0 starts the idle countdown
        idleTimer: null,
        minimized: true,     // false once something has had to un-minimize it to be painted
        painting: 0,         // readers currently needing a painted window (see paintTab)
        chain: Promise.resolve(),  // serialises escalation — only one tab can be active at a time
        homeWinId: null      // the window the reviewer is actually working in
    };

    /* WHICH WINDOW TO GIVE THE FOCUS BACK TO. Recorded once, the first time a read starts,
     * and never re-read: a moment later the answer would be the reader window itself. */
    async function noteHome() {
        if (reader.homeWinId != null) return;
        try {
            const cur = await new Promise((res) => {
                chrome.windows.getCurrent((w) => { void chrome.runtime.lastError; res(w || null); });
            });
            if (cur && cur.id != null && cur.id !== reader.winId) reader.homeWinId = cur.id;
        } catch (e) { /* no answer — the refocus below simply does nothing */ }
    }

    /* `focused: false` is a request, not a guarantee — on Windows a new window, and a window
     * taken out of the minimized state, are both routinely raised in front of everything else
     * whatever the flag says. The honest fix is not to ask more politely but to put the focus
     * BACK afterwards, which is what this does, at every point the reader becomes visible. */
    function refocusHome() {
        if (reader.homeWinId == null) return;
        try { chrome.windows.update(reader.homeWinId, { focused: true }, () => void chrome.runtime.lastError); } catch (e) {}
    }

    function windowExists() {
        return new Promise((res) => {
            if (reader.winId == null) return res(false);
            try {
                chrome.windows.get(reader.winId, {}, (w) => {
                    if (chrome.runtime.lastError || !w) return res(false);
                    res(true);
                });
            } catch (e) { res(false); }
        });
    }

    /* ONE WINDOW, EVEN WHEN FOUR READS ASK FOR IT IN THE SAME TICK.
     *
     * The first thing in ensureWindow is an `await windowExists()`, which YIELDS — so several
     * callers can each have their answer ("there is no window") before any of them has made
     * one, all of them call chrome.windows.create, and `reader.winId` ends up naming whichever
     * resolved last. The others are left holding an about:blank anchor tab with no lease, no id
     * anyone remembers, and nothing that will ever close them. Those are the blank windows —
     * and because a window coming out of the minimized state is routinely raised on Windows
     * whatever `focused:false` says, they are also the ones that surface in front of whatever
     * the reviewer is typing into.
     *
     * So the create is MEMOISED rather than guarded by a flag: the first caller to find no
     * window starts one, and every caller that arrives while that is in flight awaits the SAME
     * promise and is handed the same window id. */
    let _making = null;

    async function makeWindow() {
        reader.winId = null;
        reader.anchorTabId = null;
        reader.minimized = true;
        reader.painting = 0;
        await noteHome();
        try {
            const win = await new Promise((res, rej) => {
                chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' }, (w) => {
                    if (chrome.runtime.lastError || !w) return rej(new Error('could not open the reader window'));
                    res(w);
                });
            });
            refocusHome();
            reader.winId = win.id;
            reader.anchorTabId = (win.tabs && win.tabs[0] && win.tabs[0].id) != null ? win.tabs[0].id : null;
            return reader.winId;
        } catch (e) {
            reader.winId = null;
            return null;
        }
    }

    /* Make the window if there is not one — and REMAKE it if the reviewer closed it mid-run,
     * which they are entitled to do and which must not fail every case after it. */
    async function ensureWindow() {
        if (await windowExists()) return reader.winId;
        if (_making) return _making;
        _making = makeWindow();
        try {
            return await _making;
        } finally {
            // Cleared in a `finally` so a create that REJECTS cannot wedge every later read
            // onto a promise that will never produce a window.
            _making = null;
        }
    }

    /* IS THIS TAB ONE OF OURS?
     *
     * The reader window is a real Chrome window full of real Salesforce case pages, so it
     * comes back from `chrome.tabs.query({})` like anything else — and every "is this case
     * already open?" search would happily match a reader tab and then "focus" it, which means
     * sending the reviewer to a minimized background window they cannot see. A reader tab is
     * scaffolding, so it is never an answer to "where is this case". */
    function ownsTab(tab) {
        return !!(tab && reader.winId != null && tab.windowId === reader.winId);
    }

    /* WHICH WINDOW A TAB OPENED FOR THE REVIEWER BELONGS IN.
     *
     * `chrome.tabs.create` with no windowId puts the tab in the CURRENT window, and "current"
     * means the last one focused. A stalled read un-minimizes the reader to get its page
     * painted, so for as long as that lasts the reader window IS the current one — and a case
     * opened from the queue in that moment is created inside the background window, behind
     * everything. Same root as ownsTab: the reader is scaffolding and must never be an answer
     * to "where should this go". */
    async function engineerWindowId() {
        if (reader.winId == null) return null;      // no reader alive; nothing can be stolen
        if (reader.homeWinId != null) return reader.homeWinId;
        try {
            const cur = await new Promise((res) => {
                chrome.windows.getCurrent((w) => { void chrome.runtime.lastError; res(w || null); });
            });
            if (cur && cur.id != null && cur.id !== reader.winId) return cur.id;
        } catch (e) { /* fall through */ }
        return null;
    }

    /* chrome.tabs.create, aimed away from the reader window. `opts` is passed through
     * untouched. SYNCHRONOUS whenever there is nothing to avoid, which is almost always: the
     * reader window only exists while a run is going, and outside that there is no window that
     * could steal the tab and nothing to look up. */
    function createTab(opts, cb) {
        if (reader.winId == null) {
            try { chrome.tabs.create(opts, cb); } catch (e) { if (cb) cb(null); }
            return;
        }
        engineerWindowId().then((winId) => {
            const props = winId != null ? Object.assign({}, opts, { windowId: winId }) : opts;
            try {
                chrome.tabs.create(props, (tab) => {
                    // A window id can go stale between the lookup and the create (the reviewer
                    // closed it). Retry without one rather than dropping the click.
                    if (chrome.runtime.lastError && winId != null) {
                        try { chrome.tabs.create(opts, cb); } catch (e) { if (cb) cb(null); }
                        return;
                    }
                    if (cb) cb(tab);
                });
            } catch (e) { if (cb) cb(null); }
        }).catch(() => {
            try { chrome.tabs.create(opts, cb); } catch (e) { if (cb) cb(null); }
        });
    }

    /* ===========================================================================
     * KEEPING THE READER TAB AWAKE — see reader-wake.js for what Chrome is doing
     * ===========================================================================
     * The reader window is minimized, or sitting behind the reviewer's, which makes Chrome
     * OCCLUDE it: `document.visibilityState` goes 'hidden', compositing stops, and a Lightning
     * record page reads all of that as "nobody is looking" and stops mounting the parts of
     * itself that are not on screen. That is why hovering the Windows taskbar — which asks for
     * a thumbnail, and so un-occludes the window — makes a stubborn read work every time.
     *
     * reader-wake.js lies to the page about all of it. Registered rather than injected per tab
     * so it is in place at document_start, which is the only moment early enough to matter.
     *
     * REGISTERED ONLY WHILE A READ IS RUNNING. A registration applies to every Salesforce tab
     * in the browser, the reviewer's included, and a page that believes it is permanently
     * visible swallows a real pagehide — which on a tab somebody is working in could cost them
     * what they were typing. It comes off the moment the last reader lets go, and a build that
     * dies mid-read cannot leave it behind because `persistAcrossSessions` is false.
     * ========================================================================= */
    const WAKE_ID = 'soti-qa-reader-wake';
    const WAKE_MATCHES = ['https://*.salesforce.com/*', 'https://*.force.com/*'];
    let _wakeOn = false;

    async function wakeRegister() {
        if (_wakeOn) return;
        if (!isChromeExtension() || !chrome.scripting || !chrome.scripting.registerContentScripts) return;
        _wakeOn = true;
        try {
            // A registration can survive a panel reload that never reached the unregister, and
            // re-registering an existing id is an error rather than a no-op.
            try { await chrome.scripting.unregisterContentScripts({ ids: [WAKE_ID] }); } catch (e) {}
            await chrome.scripting.registerContentScripts([{
                id: WAKE_ID,
                matches: WAKE_MATCHES,
                js: ['reader-wake.js'],
                runAt: 'document_start',
                allFrames: true,
                world: 'MAIN',
                persistAcrossSessions: false
            }]);
        } catch (e) {
            // An older Chrome without MAIN-world registration, or a missing permission. The
            // per-tab injection below still runs, so the read is no worse off.
            _wakeOn = false;
            console.warn('QA Tool: could not register the reader wake script —', (e && e.message) || e);
        }
    }

    async function wakeUnregister() {
        if (!_wakeOn) return;
        _wakeOn = false;
        if (!isChromeExtension() || !chrome.scripting || !chrome.scripting.unregisterContentScripts) return;
        try { await chrome.scripting.unregisterContentScripts({ ids: [WAKE_ID] }); } catch (e) {}
    }

    /* AND WAKE THIS TAB NOW. Cheap and safe to repeat: the file guards itself on the window,
     * so a second run only re-fires the wake events at a page that has since gone quiet —
     * which is exactly what is wanted between polls. */
    async function wakeTab(tabId) {
        if (tabId == null || !isChromeExtension() || !chrome.scripting || !chrome.scripting.executeScript) return false;
        try {
            await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                files: ['reader-wake.js'],
                world: 'MAIN'
            });
            return true;
        } catch (e) { return false; }
    }

    async function acquire() {
        if (reader.idleTimer) { clearTimeout(reader.idleTimer); reader.idleTimer = null; }
        reader.leases++;
        // Before the window, so the registration is in place by the time a record is loaded.
        await wakeRegister();
        return ensureWindow();
    }

    function closeNow() {
        reader.idleTimer = null;
        if (reader.leases > 0 || reader.winId == null) return;
        const id = reader.winId;
        reader.winId = null;
        reader.anchorTabId = null;
        reader.minimized = true;
        reader.painting = 0;
        try { chrome.windows.remove(id, () => void chrome.runtime.lastError); } catch (e) {}
    }

    function release() {
        reader.leases = Math.max(0, reader.leases - 1);
        if (reader.leases > 0) return;
        wakeUnregister();
        if (reader.idleTimer) clearTimeout(reader.idleTimer);
        reader.idleTimer = setTimeout(closeNow, READER_IDLE_MS);
    }

    /* CLOSING THE PANEL MUST NOT LEAVE THE WINDOW BEHIND.
     *
     * The reader outlives a single read on purpose, so at any moment there may be a minimized
     * window with this tool's name on it and nothing left to close it. `pagehide` is the event
     * that actually fires for a side panel going away (`unload` does not, reliably), and the
     * close is best-effort: the leases are forced to zero first, because a run interrupted
     * mid-case would otherwise leave a lease nothing will ever release. */
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('pagehide', () => {
            reader.leases = 0;
            closeNow();
        });
    }

    // One case's tab, opened in the background of the reader window. Null when the window could
    // not be made — the caller reports that as a failed read rather than throwing.
    async function openTab(url, opts = {}) {
        const active = opts.active === true;
        const winId = await ensureWindow();
        if (winId == null) return null;
        const make = (id) => new Promise((res) => {
            try {
                chrome.tabs.create({ windowId: id, url, active }, (t) => {
                    if (chrome.runtime.lastError || !t) return res(null);
                    res(t.id);
                });
            } catch (e) { res(null); }
        });
        let tabId = await make(winId);
        if (tabId == null) {
            // The window went between the check and the create. Once more, on a fresh one.
            reader.winId = null;
            const again = await ensureWindow();
            if (again == null) return null;
            tabId = await make(again);
        }
        return tabId;
    }

    function closeTab(tabId) {
        if (tabId == null) return;
        try { chrome.tabs.remove(tabId, () => void chrome.runtime.lastError); } catch (e) {}
    }

    /* PAINT THIS TAB — the escalation, and the one place a shared window is harder than a
     * window per case.
     *
     * A record that has not rendered in the time allowed needs Chrome to actually paint it.
     * Two things have to be true — the tab has to be the ACTIVE one in its window, and the
     * window must not be minimized — and only one tab can be active at a time, so this is
     * serialised: several stalled reads take their turn rather than fighting over it.
     *
     * The window goes back to minimized when the last escalation lets go, so "it stays in the
     * background" survives a case that needed painting. Returns the function that releases it,
     * carrying a `.ready` promise the caller should await before it starts reading — see the
     * note on the chain below. */
    function paintTab(tabId) {
        let released = false;
        const done = () => {
            if (released) return;
            released = true;
            reader.painting = Math.max(0, reader.painting - 1);
            /* THE RE-MINIMIZE GOES ON THE SAME CHAIN AS THE ESCALATE, and that is not
             * tidiness. Escalating is queued work; releasing is called straight from a
             * `finally`. Run outright, the release therefore beats its own escalation to the
             * browser on a fast read — minimize, THEN un-minimize — and the window is left
             * sitting in the foreground for the rest of the session, which is the exact thing
             * this mechanism exists to prevent.
             *
             * `painting` is re-checked at RUN time rather than closed over: another read may
             * have escalated in between, and putting the window away underneath it would send
             * that one back to reading a page nobody is painting. */
            reader.chain = reader.chain.then(async () => {
                if (reader.painting > 0 || reader.winId == null || reader.minimized) return;
                reader.minimized = true;
                await new Promise((res) => {
                    try { chrome.windows.update(reader.winId, { state: 'minimized' }, () => { void chrome.runtime.lastError; res(); }); }
                    catch (e) { res(); }
                });
                // Hand the anchor the active slot back, so no case's record is left showing in
                // a window the reviewer may later restore for their own reasons.
                if (reader.anchorTabId != null) {
                    try { chrome.tabs.update(reader.anchorTabId, { active: true }, () => void chrome.runtime.lastError); } catch (e) {}
                }
            }).catch(() => {});
        };

        reader.painting++;
        /* AND THE CHAIN IS HANDED BACK, on `done.ready`. Fire-and-forget was the bug: the
         * caller asked for the window to be painted and then began polling IMMEDIATELY, while
         * the restore and the tab switch were still queued behind whatever else was on the
         * chain. So the first seconds of every read — the seconds in which a Lightning page
         * decides what it is going to mount — were spent in exactly the state the paint exists
         * to get out of. */
        const ready = reader.chain = reader.chain.then(async () => {
            if (reader.winId == null || tabId == null) return;
            await new Promise((res) => {
                try { chrome.tabs.update(tabId, { active: true }, () => { void chrome.runtime.lastError; res(); }); }
                catch (e) { res(); }
            });
            if (reader.minimized) {
                reader.minimized = false;
                await new Promise((res) => {
                    try {
                        chrome.windows.update(reader.winId, { state: 'normal', focused: false }, () => {
                            void chrome.runtime.lastError;
                            // From the update's own callback rather than a timer, so there is
                            // no window of time in which a keystroke could land in Salesforce.
                            refocusHome();
                            res();
                        });
                    } catch (e) { res(); }
                });
            } else {
                refocusHome();
            }
        }).catch(() => {});
        done.ready = ready;

        return done;
    }

    /* ===========================================================================
     * READ ONE CASE
     * ===========================================================================
     * Two phases, and the split matters.
     *
     * PHASE ONE asks the page a CHEAP question — "has the record rendered, and can you see
     * the Feed tab yet" — every so often until it says yes. That message touches nothing and
     * returns immediately, so polling it is free.
     *
     * PHASE TWO asks the EXPENSIVE question exactly once: open the Feed tab, scroll the feed
     * to its very end, expand every truncated post and every collapsed reply, then read the
     * lot. On a two-year-old case that is a minute of scrolling. Polling THAT — which is what
     * a single-phase read would amount to — would start a fresh scroll of the same feed every
     * few seconds, each fighting the others for the scroll position.
     *
     * 250ms for the first poll, then 700. The early attempts are cheap failures — the content
     * script is not up yet and the send returns immediately — and the record occasionally
     * renders fast enough to answer one of them. A flat 800ms before even the first look is
     * eight tenths of a second per case spent on nothing, thirty times over.
     * ========================================================================= */
    /* The tail of the queue of readers waiting to scrape. Each takes a lease, does its
     * painted scrape, and releases; the next is waiting on that release rather than on the
     * escalation that preceded it. */
    let scrapeGate = Promise.resolve();

    async function takeScrapeLease() {
        let release;
        const held = new Promise((res) => { release = res; });
        const ahead = scrapeGate;
        scrapeGate = ahead.then(() => held, () => held);
        await ahead.catch(() => {});
        return release;
    }

    async function readCase(url, opts = {}) {
        const {
            readyMs = 30000,     // how long to wait for the record itself to render
            retryMs = 20000,     // …and again, after painting the window
            scrapeMs = 180000    // the feed scroll's own ceiling — a long case is genuinely slow
        } = opts;

        if (!isChromeExtension() || !chrome.windows || !chrome.tabs) {
            return { ok: false, error: 'The QA Tool can only read cases when it is running as a Chrome extension.' };
        }
        if (!url) {
            return { ok: false, error: 'This case has no Salesforce link — sync the list again, or add it by URL.' };
        }

        let tabId = null;

        const ask = (message, timeoutMs) => new Promise((res) => {
            if (tabId == null) return res(null);
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; res(v); } };
            if (timeoutMs) setTimeout(() => finish(null), timeoutMs);
            try {
                chrome.tabs.sendMessage(tabId, message, (r) => {
                    void chrome.runtime.lastError;   // not injected yet — keep waiting
                    finish(r || null);
                });
            } catch (e) { finish(null); }
        });

        // "Ready" is three questions, and the caller needs all three answered yes: the record
        // has rendered, its DETAIL layout has arrived (not just the highlights strip, which
        // paints first and carries a Case Number of its own), and the Feed is reachable.
        const pollReady = async (deadline) => {
            let last = null;
            let step = 250;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, step));
                step = 700;
                const r = await ask({ action: 'GET_SALESFORCE_CASE_READY' }, 4000);
                if (r) last = r;
                if (r && r.ready && r.feedReady && r.detailReady) return r;
            }
            return last;
        };

        await acquire();
        let unpaint = null;
        let releaseScrape = null;

        try {
            tabId = await openTab(url);
            if (tabId == null) {
                return { ok: false, error: 'Could not read the case — the background reader window would not open.' };
            }
            await wakeTab(tabId);

            let state = await pollReady(Date.now() + readyMs);

            /* STILL NOT THERE: a hidden tab is not being painted, so give this one the active
             * slot in a window that is not minimized, and a shorter second attempt rather than
             * reporting a failure the page had no chance to avoid. The paint's own `ready` is
             * awaited so the retry polls a window that is actually up — see paintTab. */
            if (!state || !state.ready || !state.feedReady || !state.detailReady) {
                unpaint = paintTab(tabId);
                try { await unpaint.ready; } catch (e) { /* the poll below is the real test */ }
                await wakeTab(tabId);
                state = await pollReady(Date.now() + retryMs) || state;
            }

            if (!state || !state.ready) {
                return {
                    ok: false,
                    error: 'The case record did not finish loading in time'
                        + (state && state.onCaseUrl === false ? ' — that link does not open a case record.' : '.')
                };
            }

            /* PHASE TWO — once, PAINTED, and one at a time. See the notes on the paint
             * above and on takeScrapeLease: the feed cannot load in a tab the browser is
             * not rendering, and two readers painting at once take the foreground off each
             * other. The lease is released in the `finally` on every path, including the
             * scrape timing out — a lease that leaks would stop the rest of the run dead. */
            releaseScrape = await takeScrapeLease();
            if (!unpaint) {
                unpaint = paintTab(tabId);
                try { await unpaint.ready; } catch (e) { /* the scrape below is the real test */ }
                await wakeTab(tabId);
            }
            const data = await ask({ action: 'GET_SALESFORCE_QA_CASE' }, scrapeMs);
            if (!data) {
                return { ok: false, error: 'The case page did not answer the QA read — it may still have been loading its feed.' };
            }
            /* A CASE WITH NO FEED IS A RESULT, NOT A FAILURE, and saying so here rather than
             * refusing to return matters: a case genuinely handled entirely over the phone is
             * a QA finding in its own right ("nothing was written down"), and one whose feed
             * this build could not read is a different thing entirely. qaFeed.reason
             * distinguishes them and qa-engine.js reports it. */
            return { ok: true, data };
        } catch (e) {
            return { ok: false, error: 'Could not read the case — ' + ((e && e.message) || 'the reader window could not be opened') + '.' };
        } finally {
            /* THE TAB ALWAYS GOES, on every path — a leaked reader tab is a Lightning page left
             * loading in a window nobody can see. The escalation is released before the tab is
             * closed so the window can go back to minimized, and the lease last of all, which
             * starts the idle countdown. */
            // FIRST of all, in fact: every other reader in the run is waiting on this one, and
            // a lease still held while the tab is closed is a run that has stopped.
            if (releaseScrape) { try { releaseScrape(); } catch (e) {} }
            if (unpaint) unpaint();
            closeTab(tabId);
            release();
        }
    }

    window.QaReader = {
        readCase,
        ownsTab,
        createTab,
        closeIdle() { reader.leases = 0; closeNow(); },
        get windowId() { return reader.winId; }
    };
})();
