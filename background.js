/* ============================================================================
 * QA Tool — Background Service Worker
 * ============================================================================
 * Chrome runs this in the background for the extension. It has no user
 * interface and Chrome may stop and restart it at any time, so it stays small
 * and holds no state worth losing.
 *
 * It does two things, and neither of them can be done anywhere else:
 *
 *   1. Opens the side panel when the toolbar icon is clicked.
 *   2. Keeps a CLOCK running for the Copilot relay — see THE RELAY'S CLOCK
 *      below.
 *
 * The sticky-note reminders that live in the analyser's worker are deliberately
 * absent: this tool has no notes, so it asks for neither the alarms nor the
 * notifications permission. It holds no network permissions and issues no
 * requests of its own.
 * ========================================================================== */
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
  console.log('QA Tool installed');
});

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
