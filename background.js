/* ============================================================================
 * QA Tool — Background Service Worker
 * ============================================================================
 * Chrome runs this in the background for the extension. It has no user
 * interface and Chrome may stop and restart it at any time, so it stays small
 * and holds no state worth losing.
 *
 * It does three things, and none of them can be done anywhere else:
 *
 *   1. Opens the side panel when the toolbar icon is clicked.
 *   2. Keeps a CLOCK running for the Copilot relay — see THE RELAY'S CLOCK
 *      below.
 *   3. Looks for a NEW RELEASE in the shared folder this copy was loaded from,
 *      once a minute — see UPDATES FROM THE SHARED FOLDER at the end. That is
 *      the one thing the alarms permission is for.
 *
 * The sticky-note reminders that live in the analyser's worker are deliberately
 * absent: this tool has no notes, so it does not ask for the notifications
 * permission. It holds no network permissions and issues no requests of its
 * own — the update check reads the extension's own folder and nothing else.
 * ========================================================================== */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('QA Tool installed');
});

/* ============================================================================
 * THE GRAPHQL READ — the SOTI AI Analyser's (Beta 9.8.6), see salesforce/sf-graphql.js
 * ============================================================================
 * Every Salesforce read the panel makes over GraphQL runs through here: the panel asks, this worker finds an open
 * Lightning tab (the one in front first) and runs the query in its page, where Salesforce's own GraphQL API lives.
 * Read-only. Registered synchronously as the worker starts, as Chrome requires. */
try { importScripts('salesforce/sf-graphql.js'); globalThis.SfGraphql.install(); } catch (e) { console.error('QA Tool: sf-graphql.js could not be loaded', e); }
/* HOW LIGHTNING ASKS FOR A FEED (salesforce/sf-feed-capture.js), noted in the page's own world on every Lightning page
 * from the start, so the panel can ask Salesforce's feed service for a case's internal notes and posts as data —
 * nothing scrolled or clicked. It only watches; nothing it notes leaves the page. Registered once, kept across restarts. */
(async () => {
  try {
    const id = 'qa-feed-capture';
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (!have.length) {
      await chrome.scripting.registerContentScripts([{ id, matches: ['https://*.lightning.force.com/*'], js: ['salesforce/sf-feed-capture.js'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: true }]);
    }
  } catch (e) { console.warn('QA Tool: the feed listener could not be registered', e); }
})();

/* ============================================================================
 * THE RELAY'S CLOCK
 * ============================================================================
 * Carried over from the analyser unchanged, because the problem it solves is a
 * property of Chrome rather than of either tool.
 *
 * The relay runs in a window nobody is looking at — that is the whole point of
 * it. Chrome treats such a window as OCCLUDED, and occlusion CLAMPS EVERY TIMER
 * IN THE PAGE: setTimeout in a hidden page fires roughly once a second, and
 * after five minutes hidden, roughly once a MINUTE. Every wait in the relay is
 * built on setTimeout — waiting for the composer to mount, for the send button
 * to come alive, for the composer to empty so the send can be proved. Under a
 * one-minute clamp a fifteen-second wait gets ONE look at the page and then
 * reports there is nothing there. That is "no message box found" on a page that
 * has one, cured by hovering the taskbar — because hovering the taskbar makes
 * Chrome paint the window, and painting it un-throttles every timer in it.
 *
 * A service worker has no window, so it has no visibility, so nothing throttles
 * it. It ticks the relay tab every 200ms and the page's waits step off those
 * ticks instead of their own clamped timers. The side panel borrows the same
 * clock through SOTI_SW_SLEEP, because the panel lives in the engineer's window
 * and is hidden the moment they look at another application.
 *
 * The ticking is also what keeps this worker alive: an extension API call resets
 * Chrome's 30-second idle timer, and there is one every 200ms. It is bounded
 * three ways all the same — a hard deadline, the relay tab closing, and the
 * panel switching it off when the answer is in.
 * ========================================================================== */
const PUMP = { tabId: null, timer: null, until: 0 };
const PUMP_INTERVAL_MS = 200;
const PUMP_MAX_MS = 15 * 60 * 1000;

function pumpStop() {
  if (PUMP.timer) clearTimeout(PUMP.timer);
  PUMP.timer = null;
  PUMP.tabId = null;
  PUMP.until = 0;
}

function pumpBeat() {
  PUMP.timer = null;
  const tabId = PUMP.tabId;
  if (tabId == null) return;
  if (Date.now() > PUMP.until) return pumpStop();
  try {
    const p = chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_TICK' });
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        /* A tick that lands nowhere is NORMAL and must not stop the clock: the
         * page is mid-navigation, or the bridge has not been injected yet, and
         * the ticks are needed most in exactly those moments. Only the tab
         * itself being gone ends it. */
        if (/No tab with id/i.test((e && e.message) || '') && PUMP.tabId === tabId) pumpStop();
      });
    }
  } catch (e) { /* same reasoning — transient */ }
  if (PUMP.tabId === tabId) PUMP.timer = setTimeout(pumpBeat, PUMP_INTERVAL_MS);
}

function pumpStart(tabId) {
  if (tabId == null) return false;
  // Re-asserting extends the deadline, precisely so a worker Chrome recycled
  // mid-request starts ticking again on the panel's next survey round.
  PUMP.until = Date.now() + PUMP_MAX_MS;
  if (PUMP.tabId === tabId && PUMP.timer) return true;
  if (PUMP.timer) clearTimeout(PUMP.timer);
  PUMP.tabId = tabId;
  pumpBeat();
  return true;
}

chrome.tabs.onRemoved.addListener((id) => { if (PUMP.tabId === id) pumpStop(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'SOTI_RELAY_PUMP') {
    if (msg.on) pumpStart(msg.tabId);
    else if (msg.tabId == null || PUMP.tabId === msg.tabId) pumpStop();
    sendResponse({ ok: true, tabId: PUMP.tabId });
    return false;
  }

  /* THE PANEL'S OWN SLEEP, MEASURED SOMEWHERE THAT IS NOT THROTTLED.
   *
   * The side panel is a page in the engineer's window, so the moment they look
   * at another application its timers are clamped exactly like the relay's. A
   * QA run over thirty cases is a long sequence of waits; under intensive
   * throttling one of them can swallow a whole deadline. So the wait is
   * measured here and the answer posted back, with the panel racing its own
   * timer against it and taking whichever arrives first — a recycled worker
   * then degrades to the old behaviour rather than hanging. Capped, because
   * this holds the response channel open. */
  if (msg.type === 'SOTI_SW_SLEEP') {
    const ms = Math.max(0, Math.min(30000, Number(msg.ms) || 0));
    setTimeout(() => { try { sendResponse({ ok: true, ms }); } catch (e) { /* panel closed */ } }, ms);
    return true;
  }
});

/* ============================================================================
 * UPDATES FROM THE SHARED FOLDER — the analyser's (Global 1.3.2), see updater.js
 * ============================================================================
 * Installed with Load unpacked from a OneDrive folder shared with the team, the extension
 * finds a new release in its own folder and restarts onto it — with nothing for the reviewer
 * to do. Looked at once a minute (and at start-up). The folder's manifest.json is the only
 * thing read while nothing has changed. When a complete, signed release is there:
 *   · the side panel is closed → restart onto it now;
 *   · the side panel is open   → tell the panel, which shows "Version … is ready — Restart now"
 *     and restarts by itself once it has been out of sight and idle (see UPDATES in qa-panel.js).
 * A release that is not signed by the owner is never applied (and is logged once).
 * ========================================================================== */
try { importScripts('updater.js'); } catch (e) { console.error('QA Tool: updater.js could not be loaded', e); }

const UPDATE_ALARM = 'qa-update-check';
const UPDATE_SOON_ALARM = 'qa-update-check-soon';
const UPDATE_REFUSED_KEY = 'qa_update_refused';
// Set for this browser session when the folder did not fully match the version that loaded.
const UPDATE_REVERIFY_KEY = 'qa_update_reverify';
// Set once the first check of this browser session has looked at every file.
const UPDATE_START_KEY = 'qa_update_start_checked';
// A new version the browser downloaded by itself (installed by IT policy), waiting to be applied.
const UPDATE_CRX_KEY = 'qa_update_crx_pending';
let updateChecking = false;
let updateLastReady = null;   // { from, to, at } — a release already checked whole, while the panel is open

/* "THE PANEL" IS ANY OPEN QA TOOL PAGE, not only the side panel: the page also gets opened in a
 * window or a tab of its own, and a restart pulled from under that would stop a run as surely. */
async function updatePanelIsOpen() {
  try {
    if (chrome.runtime.getContexts) {
      const open = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL', 'TAB', 'POPUP'] });
      return open.some(c => c.contextType === 'SIDE_PANEL' || /\/QA_Tool\.html(?:[?#]|$)/.test(String(c.documentUrl || '')));
    }
  } catch (e) { /* older browser — below */ }
  return true;   // cannot tell: leave the restart to the panel (or the next browser start)
}

async function checkForUpdate() {
  if (updateChecking || !self.QaUpdater) return;
  updateChecking = true;
  try {
    let r = null;
    // A release already found whole a moment ago is not hashed again every minute while it waits.
    if (updateLastReady && Date.now() - updateLastReady.at < 30 * 60000) {
      try {
        const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
        if (String(disk.version_name || disk.version) === updateLastReady.to) r = { state: 'ready', from: updateLastReady.from, to: updateLastReady.to };
      } catch (e) { r = null; }
    }
    // A downloaded .crx update waiting to be applied (see offerCrxUpdate) — looked at first.
    try {
      const pend = ((await chrome.storage.session.get(UPDATE_CRX_KEY)) || {})[UPDATE_CRX_KEY];
      if (pend && pend.to) { await offerCrxUpdate(pend.to); return; }
    } catch (e) { /* none */ }
    /* AT BROWSER START, AND UNTIL IT MATCHES: is the folder the WHOLE of the version that loaded? A
     * browser opened while OneDrive was still part-way through a release loads whatever was there;
     * once every file of that version has arrived, one restart puts the complete set in charge.
     * Once per browser session — the worker itself stops and starts all day, and must not re-hash
     * every time. */
    let reverify = false, startChecked = true;
    try {
      const ses = (await chrome.storage.session.get([UPDATE_REVERIFY_KEY, UPDATE_START_KEY])) || {};
      reverify = !!ses[UPDATE_REVERIFY_KEY];
      startChecked = !!ses[UPDATE_START_KEY];
    } catch (e) { /* no session storage — the version check alone */ }
    if (!r) r = await self.QaUpdater.check({ full: reverify || !startChecked });
    if (!startChecked) { try { await chrome.storage.session.set({ [UPDATE_START_KEY]: true }); } catch (e) { /* asked again */ } }
    if (r.same) {
      if (r.state === 'waiting') {
        try { await chrome.storage.session.set({ [UPDATE_REVERIFY_KEY]: true }); } catch (e) { /* checked again next start */ }
        chrome.alarms.create(UPDATE_SOON_ALARM, { delayInMinutes: 0.5 });
        return;
      }
      // Complete now: one restart onto the whole set — when the panel is not open (the flag stays until then).
      if (r.state === 'current' && reverify && !(await updatePanelIsOpen())) {
        try { await chrome.storage.session.remove(UPDATE_REVERIFY_KEY); } catch (e) { /* cleared by the restart anyway */ }
        await self.QaUpdater.apply(r);
      }
      // 'unsigned' at the same version is this copy itself being changed — the panel's red strip says so.
      return;
    }
    if (r.state === 'waiting') {
      // OneDrive is still bringing files down — look again in half a minute.
      chrome.alarms.create(UPDATE_SOON_ALARM, { delayInMinutes: 0.5 });
      return;
    }
    if (r.state === 'unsigned') {
      const got = await chrome.storage.local.get(UPDATE_REFUSED_KEY);
      if (!got || !got[UPDATE_REFUSED_KEY] || got[UPDATE_REFUSED_KEY].to !== r.to) {
        console.warn(`QA Tool: update to ${r.to} NOT applied — ${r.why}. Only releases signed by the owner are applied.`);
        await chrome.storage.local.set({ [UPDATE_REFUSED_KEY]: { to: r.to, at: Date.now() } });
      }
      return;
    }
    if (r.state !== 'ready') { updateLastReady = null; return; }
    if (await updatePanelIsOpen()) {
      updateLastReady = { from: r.from, to: r.to, at: (updateLastReady && updateLastReady.to === r.to) ? updateLastReady.at : Date.now() };
      try { await chrome.runtime.sendMessage({ type: 'QA_UPDATE_READY', from: r.from, to: r.to }); } catch (e) { /* closed meanwhile — the next check applies it */ }
      return;
    }
    await self.QaUpdater.apply(r);
  } catch (e) {
    console.warn('QA Tool: update check failed', e);
  } finally {
    updateChecking = false;
  }
}

async function armUpdateCheck() {
  try {
    const have = await chrome.alarms.get(UPDATE_ALARM);
    if (!have) await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  } catch (e) { /* alarms unavailable — the browser's next start still loads the new release */ }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && (alarm.name === UPDATE_ALARM || alarm.name === UPDATE_SOON_ALARM)) checkForUpdate();
});

/* INSTALLED BY IT POLICY (a .crx from IT's server): the browser downloads a new version by itself,
 * then waits — because this extension listens — for it to be applied. Same rule as a release in the
 * shared folder: panel closed → restart onto it now; panel open → the panel's bar (and the browser's
 * next start applies it regardless). Remembered for the session, so a recycled worker still knows. */
async function offerCrxUpdate(version) {
  const running = chrome.runtime.getManifest();
  const info = { from: String(running.version_name || running.version), to: String(version), crx: true };
  try { await chrome.storage.session.set({ [UPDATE_CRX_KEY]: info }); } catch (e) { /* the browser applies it at its next start anyway */ }
  if (await updatePanelIsOpen()) {
    try { await chrome.runtime.sendMessage(Object.assign({ type: 'QA_UPDATE_READY' }, info)); } catch (e) { /* closed meanwhile — the next check applies it */ }
    return;
  }
  await self.QaUpdater.apply(info);
}
chrome.runtime.onUpdateAvailable.addListener((details) => { offerCrxUpdate(details && details.version).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { armUpdateCheck(); checkForUpdate(); });
chrome.runtime.onInstalled.addListener(() => { armUpdateCheck(); });
armUpdateCheck();
