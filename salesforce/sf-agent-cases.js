/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// A region's Agent Cases ("EMEA Agent Cases"), over GraphQL, as rows of the Cases queue (Beta 9.8.2, the maintainer: "it
// is possible to graphql the EMEA Agent Cases, like the other filters?", then "i just want to ensure that the EMEA Agent
// Cases is always up to date on the tool perfectly 100% automatically instantly without interferring with user
// experience"). Loaded by the panel after sf-my-cases.js. Classic script. Exposes globalThis.SfAgentCases. Read-only.
//
// GraphQL cannot run a report. It can ask for the same cases, by the report's own rule — the filters its Filters panel
// shows — which the panel hands in as `rule`:
//   { recordTypes: ['Support Case', 'Interim Case'],      Case Record Type equals …
//     managers:    ['Ronan Coakley', …],                  Case Owner's Manager equals …
//     notStatus:   ['Closed', 'Close 3x Process'] }       Status not equal to …
// Two reads:
//   · read(rule)            every case the rule holds, 200 a page, as rows (SfMyCases.toRow: the same fields as your own
//                           cases). The rule is asked of Salesforce AND checked again here on every row, so a filter
//                           Salesforce applies differently can never let a wrong case in. If Salesforce will not filter
//                           on the manager field, the read is made without that filter and the managers are kept here.
//   · changes(rule, since)  the cases of those record types modified since `since` (a time Salesforce itself gave), a
//                           handful: the ones the rule holds now, and the ones it no longer holds (closed, or moved to a
//                           manager outside the rule), so the queue can follow the report minute by minute.
// Null whenever the answer could be partial: half a list must never replace a whole one.
globalThis.SfAgentCases ??= (() => {
  const PAGE = 200;
  const MAX_PAGES = 60;       // 12,000 cases: far above any region's open cases
  const LIVE_PAGES = 3;       // more changes than this since the last look: a full read is the right answer
  /* WHICH CASE FIELD IS "CASE OWNER'S MANAGER". Team_Lead__c by its name, checked once a session against Salesforce's own
   * list of Case fields: the field labelled "Case Owner's Manager" is the one used. Until that list answers, the name stands. */
  const MGR = { api: 'Team_Lead__c', checked: false };
  const NAMES = 'query q { uiapi { objectInfos(apiNames: ["Case"]) { fields { ApiName label dataType } } } }';
  async function settleManagerField() {
    if (MGR.checked) return MGR;
    try {
      const reply = await globalThis.SfGraphql.run({ names: { text: NAMES } });
      const fields = reply?.results?.names?.uiapi?.objectInfos?.[0]?.fields;
      if (!Array.isArray(fields)) return MGR;
      const labelled = fields.filter((f) => /^\s*case owner['’]s manager\s*$/i.test(String(f?.label ?? '')) && /^[A-Za-z][A-Za-z0-9_]*$/.test(String(f?.ApiName ?? '')));
      const pick = labelled.find((f) => f.ApiName === MGR.api) || (labelled.length === 1 ? labelled[0] : null);
      if (pick) MGR.api = pick.ApiName;
      MGR.checked = true;
    } catch { /* the name stands; asked again next time */ }
    return MGR;
  }

  // A name compared with its apostrophes made one: "D'Souza" typed in the rule is the same person as "D’Souza" in Salesforce.
  const APOS = /[\u2018\u2019\u02BC\u0060\u00B4]/g;
  const low = (s) => String(s ?? '').replace(APOS, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const strings = (a) => JSON.stringify(a.map((x) => String(x)));
  // Asked of Salesforce in every spelling of its apostrophe (straight and curly), since its filter matches exactly and a
  // case under a manager spelled the other way would never come back to be checked here (2026-11-11, Americas: "Lionel
  // D'Souza").
  const spellings = (a) => [...new Set(a.flatMap((x) => {
    const t = String(x);
    const straight = t.replace(APOS, "'");
    return straight.includes("'") ? [t, straight, straight.replace(/'/g, '\u2019')] : [t];
  }))];
  const names = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.trim());
  const usable = (rule) => !!rule && names(rule.recordTypes) && names(rule.managers) && Array.isArray(rule.notStatus);

  function where(rule, { managers = true, open = true, since = '' } = {}) {
    const parts = [`{ RecordType: { Name: { in: ${strings(rule.recordTypes)} } } }`];
    if (open && rule.notStatus.length) parts.push(`{ Status: { nin: ${strings(rule.notStatus)} } }`);
    if (managers) parts.push(`{ ${MGR.api}: { in: ${strings(spellings(rule.managers))} } }`);
    if (since) parts.push(`{ LastModifiedDate: { gte: { value: ${JSON.stringify(since)} } } }`);
    return `{ and: [${parts.join(', ')}] }`;
  }
  // The queue's own fields, and what the rule is checked on.
  const fields = () => `${globalThis.SfMyCases.fields()} RecordType { Name { value } }${MGR.api === 'Team_Lead__c' ? '' : ` ${MGR.api} { value }`}`;
  const queryFor = (rule, opts, cursor) =>
    `query q { uiapi { query { Case(where: ${where(rule, opts)}, orderBy: { ${opts && opts.since ? 'LastModifiedDate' : 'CaseNumber'}: { order: ASC } }, first: ${PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { pageInfo { hasNextPage endCursor } edges { node { ${fields()} } } } } } }`;
  // Answers whenever Salesforce can be asked at all: tells "this query was refused" from "no Salesforce tab".
  const CANARY = 'query q { uiapi { query { Case(first: 1) { edges { node { Id } } } } } }';

  // Does the rule hold this case, as Salesforce returned it? Pure.
  function holds(rule, node) {
    const type = low(node?.RecordType?.Name?.value);
    // A status by its value or by the words Salesforce shows for it: the report's filter is written in the words.
    const status = [low(node?.Status?.value), low(node?.Status?.displayValue)].filter(Boolean);
    const manager = low(node?.[MGR.api]?.value);
    // A case in the Development queue is not the agent's to work (Beta 9.8.4): the rule no longer holds it, so the queue drops it.
    const devQueue = typeof globalThis.SfMyCases?.inDevQueue === 'function' && globalThis.SfMyCases.inDevQueue(node);
    return !devQueue && rule.recordTypes.some((t) => low(t) === type) && !rule.notStatus.some((s) => status.includes(low(s))) && rule.managers.some((m) => low(m) === manager);
  }
  function toRow(node, origin) {
    const { group, ...row } = globalThis.SfMyCases.toRow(node, origin, '');
    row.ownerManager = String(node?.[MGR.api]?.value ?? row.ownerManager ?? '');
    // Salesforce's own time of the last change, exact: what the next look for changes starts from.
    row.modifiedAt = String(node?.LastModifiedDate?.value ?? '');
    return row;
  }

  /* Every page of one question. { origin, nodes, more } — `more`: pages were left unread at `maxPages`.
   * null: Salesforce could not be asked (no Lightning tab), or the page was late. false: Salesforce refused this question
   * (it answered it with errors). A late first page is NOT a refusal (2026-11-11): taking it for one dropped the manager
   * filter for the rest of the session, and every read after it asked for the whole org's cases. */
  async function pages(rule, opts, maxPages, onPage) {
    const told = (n) => { try { if (typeof onPage === 'function') onPage(n); } catch { /* a progress bar never stops a read */ } };
    const first = await globalThis.SfGraphql.run({ page: { text: queryFor(rule, opts) }, canary: { text: CANARY } });
    if (!first) return null;
    let connection = first.results?.page?.uiapi?.query?.Case;
    if (!connection || !Array.isArray(connection.edges)) return first.refused?.page ? false : null;
    const nodes = [];
    for (let n = 1; ; n++) {
      nodes.push(...connection.edges.map((e) => e.node).filter(Boolean));
      told(nodes.length);
      if (!connection.pageInfo?.hasNextPage) return { origin: first.origin, nodes, more: false };
      if (n >= maxPages) return { origin: first.origin, nodes, more: true };
      const reply = await globalThis.SfGraphql.run({ page: { text: queryFor(rule, opts, connection.pageInfo.endCursor) } });
      connection = reply?.results?.page?.uiapi?.query?.Case;
      if (!connection || !Array.isArray(connection.edges)) return null;   // a later page failed: the list is cut
    }
  }
  const latestOf = (nodes, from = '') => nodes.reduce((max, n) => { const t = String(n?.LastModifiedDate?.value ?? ''); return t > max ? t : max; }, from);

  let managersAtServer = true;   // false once Salesforce has refused to filter on the manager field, for this session

  /* Every case the rule holds: { origin, rows, latest, filteredHere }. `latest`: the newest LastModifiedDate among them,
   * Salesforce's own clock. Null when Salesforce could not be asked, refused, or the list would be cut. Never throws.
   * `opts.onPage(n)`: told after each page how many cases have been read so far (for the panel's loading bar). */
  async function read(rule, opts = {}) {
    try {
      if (!usable(rule)) return null;
      await globalThis.SfMyCases.settle();
      await settleManagerField();
      let got = managersAtServer ? await pages(rule, { managers: true }, MAX_PAGES, opts.onPage) : false;
      let here = false;
      if (got === false) {
        got = await pages(rule, { managers: false }, MAX_PAGES, opts.onPage);
        if (got) { managersAtServer = false; here = true; }
      }
      if (!got || got.more) return null;
      const kept = got.nodes.filter((n) => holds(rule, n));
      const seen = new Set();
      const rows = [];
      for (const n of kept) { if (!n.Id || seen.has(n.Id)) continue; seen.add(n.Id); rows.push(toRow(n, got.origin)); }
      return { origin: got.origin, rows, latest: latestOf(got.nodes), filteredHere: here };
    } catch { return null; }
  }

  /* What changed since `since` (an exact time from `latest`): { origin, rows, gone: [{ id, caseNum }], latest }, or
   * { tooMany: true } when it is more than a few pages (read the whole list instead). Null when it could not be asked. */
  async function changes(rule, since) {
    try {
      if (!usable(rule) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(since || ''))) return null;
      await globalThis.SfMyCases.settle();
      await settleManagerField();
      const got = await pages(rule, { managers: false, open: false, since }, LIVE_PAGES);
      if (!got) return null;
      if (got.more) return { tooMany: true };
      const rows = [], gone = [], seen = new Set();
      for (const n of got.nodes) {
        if (!n?.Id || seen.has(n.Id)) continue;
        seen.add(n.Id);
        if (holds(rule, n)) rows.push(toRow(n, got.origin));
        else gone.push({ id: n.Id, caseNum: String(n.CaseNumber?.value ?? '') });
      }
      return { origin: got.origin, rows, gone, latest: latestOf(got.nodes, String(since)) };
    } catch { return null; }
  }

  return { read, changes, holds, where, queryFor, managerField: () => ({ ...MGR }) };
})();
