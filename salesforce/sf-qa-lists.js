/* =============================================================================
 * QA Tool — EMEA CLOSED CASES, OVER GRAPHQL, AS ROWS OF THE CASES QUEUE
 * =============================================================================
 * The blue refresh reads EMEA Agent Cases over GraphQL with the SOTI AI Analyser's own reader
 * (salesforce/sf-agent-cases.js: the report's Filters, asked of Salesforce and checked again on every row). EMEA Closed
 * Cases is the same rule for cases that have CLOSED: Support and Interim cases whose Case Owner's Manager is one of
 * EMEA's team leads, closed in the last `days` days. GraphQL cannot run the report itself, so this is that rule.
 *
 *   readClosed(rule, { days, onPage })   { origin, rows, latest } or null. Every page, newest closure first; the rows are
 *                                        the queue's own (SfMyCases.toRow) plus closedAt (ms) and closed (as shown).
 *                                        Null whenever the answer could be partial: half a list never replaces a whole one.
 *
 * Loaded by the panel after sf-agent-cases.js. Classic script. Exposes globalThis.SfQaLists. Read-only; never logs case text.
 * ========================================================================== */
globalThis.SfQaLists ??= (() => {
  const PAGE = 200;
  const MAX_PAGES = 60;   // 12,000 closed cases: far above a month of one region's
  const DAY_MS = 86400000;
  const APOS = /[‘’ʼ`´]/g;
  const strings = (a) => JSON.stringify(a.map((x) => String(x)));
  const spellings = (a) => [...new Set(a.flatMap((x) => {
    const t = String(x);
    const straight = t.replace(APOS, "'");
    return straight.includes("'") ? [t, straight, straight.replace(/'/g, '’')] : [t];
  }))];
  const names = (a) => Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string' && x.trim());
  const usable = (rule) => !!rule && names(rule.recordTypes) && names(rule.managers);
  const mgrField = () => {
    const api = globalThis.SfAgentCases?.managerField?.().api;
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(String(api || '')) ? api : 'Team_Lead__c';
  };

  function where(rule, sinceIso, managers) {
    const parts = [`{ RecordType: { Name: { in: ${strings(rule.recordTypes)} } } }`, '{ IsClosed: { eq: true } }',
      `{ ClosedDate: { gte: { value: ${JSON.stringify(sinceIso)} } } }`];
    if (managers) parts.push(`{ ${mgrField()}: { in: ${strings(spellings(rule.managers))} } }`);
    return `{ and: [${parts.join(', ')}] }`;
  }
  const fields = () => {
    const api = mgrField();
    return `${globalThis.SfMyCases.fields()} RecordType { Name { value } } ClosedDate { value displayValue }${api === 'Team_Lead__c' ? '' : ` ${api} { value }`}`;
  };
  const queryFor = (rule, sinceIso, managers, cursor) =>
    `query q { uiapi { query { Case(where: ${where(rule, sinceIso, managers)}, orderBy: { ClosedDate: { order: DESC } }, first: ${PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { pageInfo { hasNextPage endCursor } edges { node { ${fields()} } } } } } }`;

  // The rule, checked again here on every row: the record type, the manager, and never the Development queue.
  function holds(rule, node) {
    if (!globalThis.SfAgentCases?.holds) return false;
    return globalThis.SfAgentCases.holds({ recordTypes: rule.recordTypes, managers: rule.managers, notStatus: [] }, node);
  }
  function toRow(node, origin) {
    const { group, ...row } = globalThis.SfMyCases.toRow(node, origin, '');
    const api = mgrField();
    row.ownerManager = String(node?.[api]?.value ?? row.ownerManager ?? '');
    row.modifiedAt = String(node?.LastModifiedDate?.value ?? '');
    const at = Date.parse(String(node?.ClosedDate?.value ?? ''));
    if (Number.isFinite(at)) { row.closedAt = at; row.closed = String(node?.ClosedDate?.displayValue ?? node?.ClosedDate?.value ?? ''); }
    return row;
  }

  // { origin, nodes } — null: Salesforce could not be asked, a later page failed, or there were more than MAX_PAGES.
  // false: Salesforce refused this question (it answered it with errors).
  async function pages(rule, sinceIso, managers, onPage) {
    const told = (n) => { try { if (typeof onPage === 'function') onPage(n); } catch (e) { /* a progress bar never stops a read */ } };
    const first = await globalThis.SfGraphql.run({ page: { text: queryFor(rule, sinceIso, managers) } });
    if (!first) return null;
    let conn = first.results?.page?.uiapi?.query?.Case;
    if (!conn || !Array.isArray(conn.edges)) return first.refused?.page ? false : null;
    const nodes = [];
    for (let n = 1; ; n++) {
      nodes.push(...conn.edges.map((e) => e.node).filter(Boolean));
      told(nodes.length);
      if (!conn.pageInfo?.hasNextPage) return { origin: first.origin, nodes };
      if (n >= MAX_PAGES) return null;   // cut: never a partial list
      const reply = await globalThis.SfGraphql.run({ page: { text: queryFor(rule, sinceIso, managers, conn.pageInfo.endCursor) } });
      conn = reply?.results?.page?.uiapi?.query?.Case;
      if (!conn || !Array.isArray(conn.edges)) return null;
    }
  }

  let managersAtServer = true;   // false once Salesforce has refused to filter on the manager field, for this session

  async function readClosed(rule, opts = {}) {
    try {
      if (!usable(rule) || !globalThis.SfGraphql || !globalThis.SfMyCases) return null;
      const days = Math.max(1, Math.min(366, Number(opts.days) || 30));
      const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();
      await globalThis.SfMyCases.settle();
      let got = managersAtServer ? await pages(rule, sinceIso, true, opts.onPage) : false;
      if (got === false) {
        got = await pages(rule, sinceIso, false, opts.onPage);
        if (got) managersAtServer = false;
      }
      if (!got) return null;
      const seen = new Set();
      const rows = [];
      let latest = '';
      for (const n of got.nodes) {
        const t = String(n?.LastModifiedDate?.value ?? '');
        if (t > latest) latest = t;
        if (!n?.Id || seen.has(n.Id) || !holds(rule, n)) continue;
        seen.add(n.Id);
        rows.push(toRow(n, got.origin));
      }
      return { origin: got.origin, rows, latest };
    } catch (e) { return null; }
  }

  return { readClosed, holds, toRow, queryFor, where };
})();
