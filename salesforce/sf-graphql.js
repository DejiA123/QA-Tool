/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// Runs named LDS GraphQL queries in a Lightning tab of the org, for every Salesforce read in the panel. Loaded by
// background.js with importScripts (install) and by the panel (run). Classic script. Exposes globalThis.SfGraphql.
// Read-only: it never clicks, scrolls or opens anything. What it carries is case text, so nothing here logs it.
globalThis.SfGraphql ??= (() => {
  const READ = 'SOTI_SF_GRAPHQL';
  const TIMEOUT_MS = 15000;
  const TAB_PATTERNS = ['https://*.lightning.force.com/*'];

  // Runs inside the tab, through executeScript in the MAIN world, where $A lives. So it stays self-contained: no
  // outer names. queries: { <name>: { text, variables? } }. Resolves { origin, uid, results: { <name>: data | null } },
  // where null is that query failed or was late. Null when $A or the API is missing or nothing at all came, so that
  // the next tab can try. A query that declares $uid gets the signed-in user. `refused` (only when one was) names the
  // queries Salesforce answered with errors, so a caller can tell "this question was refused" from "it was late".
  function pageRun({ queries, timeoutMs }) {
    return new Promise((resolve) => {
      let api;
      let uid;
      try {
        api = Object.values(window.$A.componentService.getDef('markup://interop:uiGraphQLApi')).find(
          (v) => v && typeof v === 'object' && 'unstable_graphql_imperative' in v
        );
        uid = window.$A.get('$SObjectType.CurrentUser.Id');
      } catch {}
      if (!api) return resolve(null);
      const names = Object.keys(queries);
      const results = Object.fromEntries(names.map((name) => [name, null]));
      const refused = {};
      let waiting = names.length;
      let timer;
      const finish = () => {
        clearTimeout(timer);
        const out = Object.values(results).some((r) => r !== null) ? { origin: window.location.origin, uid, results } : null;
        if (out && Object.keys(refused).length) out.refused = refused;
        resolve(out);
      };
      timer = setTimeout(finish, timeoutMs);
      const landed = () => {
        if (--waiting === 0) finish();
      };
      for (const name of names) {
        const { text, variables = {} } = queries[name];
        const strings = [text];
        strings.raw = [text];
        try {
          // `no-cache`: from the LDS cache a record the page holds comes back with only the fields it cached.
          api.unstable_graphql_imperative.invoke(
            { query: api.gql(strings), variables: text.includes('$uid') ? { ...variables, uid } : variables, operationName: 'q' },
            { cachePolicy: { type: 'no-cache' } },
            (result) => {
              if (result?.data && !result.errors?.length) results[name] = result.data;
              else if (result?.errors?.length) refused[name] = true;
              landed();
            }
          );
        } catch {
          landed();
        }
      }
    });
  }

  // The worker's half. Tries the tab in front first, which Chrome does not throttle, then each other Lightning tab:
  // one that cannot read passes to the next. The page's own timeout may fire late in a hidden tab, so the worker
  // bounds the search at twice the time of one read, and gives each tab its share of that: one that stalls does not
  // cost the next its turn.
  async function readInTabs({ queries, timeoutMs }) {
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), 2 * timeoutMs);
    });
    let expired = false;
    deadline.then(() => {
      expired = true;
    });
    const search = async () => {
      const tabs = await chrome.tabs.query({ url: TAB_PATTERNS, discarded: false });
      tabs.sort((a, b) => Number(!!b.active) - Number(!!a.active));
      const share = (2 * timeoutMs) / Math.max(1, tabs.length);
      for (const { id } of tabs) {
        if (expired) break;
        let shareTimer;
        const stalled = new Promise((resolve) => {
          shareTimer = setTimeout(() => resolve([]), share);
        });
        const attempt = chrome.scripting.executeScript({ target: { tabId: id }, world: 'MAIN', func: pageRun, args: [{ queries, timeoutMs }] }).catch(() => []);
        const [{ result } = {}] = await Promise.race([attempt, stalled]);
        clearTimeout(shareTimer);
        if (result) return result;
      }
      return null;
    };
    try {
      return await Promise.race([search().catch(() => null), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Registers the worker's listener. Called synchronously when the worker starts, as Chrome requires.
  function install() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type !== READ) return false;
      readInTabs(msg).then(sendResponse);
      return true;
    });
  }

  // The panel's half. Never throws: null when there is no Lightning tab that can read.
  async function run(queries, { timeoutMs = TIMEOUT_MS } = {}) {
    try {
      return (await chrome.runtime.sendMessage({ type: READ, queries, timeoutMs })) ?? null;
    } catch {
      return null;
    }
  }

  return { pageRun, install, run };
})();
