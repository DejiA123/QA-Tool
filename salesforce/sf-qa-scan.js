/* =============================================================================
 * QA Tool — CLOSED CASES, MANY AT ONCE, OVER GRAPHQL
 * =============================================================================
 * For the Agents tab: the cases an agent closed in the last 30 days, and EMEA's closed cases over the last three
 * months, each read well enough to measure and score without opening it.
 *
 *   closedCases(opts)   the cases closed since `since` — one agent's (ownerId) or a region's (managers: the Case Owner's
 *                       Manager names, as the region's Agent Cases report filters on them) — newest closure first, as
 *                       light rows. The region's rule is asked of Salesforce and checked again here on every row.
 *   readMany(rows)      their emails, logged calls, owner changes and closure fields, 20 cases a question, and each
 *                       case's `data` in the shape the QA engine measures (as salesforce/sf-qa-case.js builds for one).
 *                       Internal notes and posts are not read here — Salesforce's feed service answers one case at a
 *                       time — so a scanned case says so, and its full review reads them.
 *
 * Loaded by the panel after sf-qa-case.js. Classic script. Exposes globalThis.SfQaScan. Read-only; never logs case text.
 * ========================================================================== */
globalThis.SfQaScan ??= (() => {
  const PAGE = 200;
  const BATCH = 20;
  const RECORD_TYPES = ['Support Case', 'Interim Case'];
  const value = (f) => (f && f.value !== undefined && f.value !== null ? f.value : '');
  const shown = (f) => (f ? (f.displayValue ?? f.value ?? '') : '');
  const when = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? null : t; };
  const strings = (a) => JSON.stringify(a.map(String));
  const low = (s) => String(s ?? '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const spellings = (a) => [...new Set(a.flatMap((x) => { const s = String(x).replace(/[‘’]/g, "'"); return s.includes("'") ? [s, s.replace(/'/g, '’')] : [s]; }))];
  const iso = (ms) => new Date(ms).toISOString();

  const ROW_FIELDS = 'Id CaseNumber { value } Subject { value } Status { value displayValue } Priority { value displayValue } CreatedDate { value } ClosedDate { value } Case_Age_in_days__c { value } Entitlement_Name__c { value } JIRA_Number__c { value } Team_Lead__c { value } OwnerId { value } Owner { ... on User { Name { value } } ... on Group { Name { value } } } Account { Name { value } } Contact { Name { value } }';
  function where({ since, ownerId, managers, withManagers = true }) {
    const parts = [`{ RecordType: { Name: { in: ${strings(RECORD_TYPES)} } } }`, '{ IsClosed: { eq: true } }', `{ ClosedDate: { gte: { value: ${JSON.stringify(iso(since))} } } }`];
    if (ownerId) parts.push(`{ OwnerId: { eq: ${JSON.stringify(ownerId)} } }`);
    if (withManagers && managers && managers.length) parts.push(`{ Team_Lead__c: { in: ${strings(spellings(managers))} } }`);
    return `{ and: [${parts.join(', ')}] }`;
  }
  const listQuery = (opts, cursor) => `query q { uiapi { query { Case(where: ${where(opts)}, orderBy: { ClosedDate: { order: DESC } }, first: ${PAGE}${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { totalCount pageInfo { hasNextPage endCursor } edges { node { ${ROW_FIELDS} } } } } } }`;

  function toRow(n, origin) {
    const age = n.Case_Age_in_days__c?.value;
    return {
      recordId: n.Id,
      url: origin ? `${origin}/lightning/r/Case/${n.Id}/view` : '',
      caseNum: value(n.CaseNumber),
      subject: value(n.Subject),
      status: shown(n.Status),
      priority: shown(n.Priority),
      createdAt: when(value(n.CreatedDate)),
      closedAt: when(value(n.ClosedDate)),
      ageDays: typeof age === 'number' ? String(Math.floor(age)) : '',
      entitlement: value(n.Entitlement_Name__c),
      jira: value(n.JIRA_Number__c),
      ownerManager: value(n.Team_Lead__c),
      ownerId: value(n.OwnerId),
      owner: value(n.Owner?.Name),
      account: value(n.Account?.Name),
      contact: value(n.Contact?.Name),
    };
  }

  /* { origin, rows, total, more } or null (no tab could answer, or a page failed). `maxPages` bounds the read; `more`
   * says pages were left. `onPage(n)` hears how many rows have come so far. */
  async function closedCases({ since, ownerId = '', managers = [], maxPages = 15, onPage = null } = {}) {
    const told = (n) => { try { onPage && onPage(n); } catch (e) { /* a progress bar never stops a read */ } };
    const run = async (opts) => {
      const first = await globalThis.SfGraphql.run({ page: { text: listQuery(opts) } });
      if (!first) return null;
      let conn = first.results?.page?.uiapi?.query?.Case;
      if (!conn) return first.refused?.page ? false : null;
      const nodes = [];
      const total = typeof conn.totalCount === 'number' ? conn.totalCount : null;
      for (let page = 1; ; page++) {
        nodes.push(...(conn.edges || []).map((e) => e.node).filter(Boolean));
        told(nodes.length);
        if (!conn.pageInfo?.hasNextPage) return { origin: first.origin, nodes, total, more: false };
        if (page >= maxPages) return { origin: first.origin, nodes, total, more: true };
        const reply = await globalThis.SfGraphql.run({ page: { text: listQuery(opts, conn.pageInfo.endCursor) } });
        conn = reply?.results?.page?.uiapi?.query?.Case;
        if (!conn) return null;
      }
    };
    try {
      let got = await run({ since, ownerId, managers, withManagers: true });
      if (got === false && managers.length) got = await run({ since, ownerId, managers, withManagers: false });
      if (!got) return null;
      const want = new Set(managers.map(low));
      const rows = [];
      const seen = new Set();
      for (const n of got.nodes) {
        if (!n.Id || seen.has(n.Id)) continue;
        seen.add(n.Id);
        // The rule, checked here on every row — and the only check when Salesforce would not filter on the field.
        if (want.size && !want.has(low(value(n.Team_Lead__c)))) continue;
        rows.push(toRow(n, got.origin));
      }
      return { origin: got.origin, rows, total: got.total, more: got.more };
    } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- the activity of many cases ----------------- */
  const after = (c) => (c ? `, after: ${JSON.stringify(c)}` : '');
  const emailsQ = (ids, c) => `query q { uiapi { query { EmailMessage(where: { ParentId: { in: ${strings(ids)} } }, orderBy: { MessageDate: { order: ASC } }, first: ${PAGE}${after(c)}) { pageInfo { hasNextPage endCursor } edges { node { Id ParentId { value } Incoming { value } MessageDate { value } FromName { value } FromAddress { value } TextBody { value } HasAttachment { value } Status { value } } } } } } }`;
  const callsQ = (ids, c) => `query q { uiapi { query { Task(where: { and: [{ WhatId: { in: ${strings(ids)} } }, { TaskSubtype: { eq: "Call" } }] }, first: ${PAGE}${after(c)}) { pageInfo { hasNextPage endCursor } edges { node { Id WhatId { value } CreatedDate { value } Description { value } Owner { ... on User { Name { value } } } } } } } } }`;
  const histQ = (ids, c, withValues) => `query q { uiapi { query { CaseHistory(where: { CaseId: { in: ${strings(ids)} } }, orderBy: { CreatedDate: { order: ASC } }, first: ${PAGE}${after(c)}) { pageInfo { hasNextPage endCursor } edges { node { Id CaseId { value } Field { value } ${withValues ? 'OldValue { value } NewValue { value } ' : ''}CreatedDate { value } CreatedBy { Name { value } } } } } } } }`;

  async function all(object, first, next) {
    let conn = first?.uiapi?.query?.[object];
    if (!conn) return null;
    const nodes = [];
    for (let page = 0; conn && page < 20; page++) {
      nodes.push(...(conn.edges || []).map((e) => e.node).filter(Boolean));
      if (!conn.pageInfo?.hasNextPage) return nodes;
      const reply = await globalThis.SfGraphql.run({ p: { text: next(conn.pageInfo.endCursor) } });
      conn = reply?.results?.p?.uiapi?.query?.[object];
    }
    return nodes;   // twenty pages is far past any batch of 20 cases; what came is kept
  }

  let historyValues = true;
  // The closure fields of many cases: one question per field, so a field this user cannot read costs only that field.
  async function closureMany(ids) {
    const fields = await globalThis.SfQaCase.closureFields();
    const qs = {};
    for (const [key, f] of Object.entries(fields)) {
      const rel = f.rel ? `${f.rel} { ${f.to === 'Case' ? 'CaseNumber' : 'Name'} { value } } ` : '';
      qs[key] = { text: `query q { uiapi { query { Case(where: { Id: { in: ${strings(ids)} } }, first: ${ids.length}) { edges { node { Id ${rel}${f.api} { value displayValue } } } } } } }` };
    }
    const reply = await globalThis.SfGraphql.run(qs);
    const out = new Map(ids.map((id) => [id, {}]));
    for (const [key, f] of Object.entries(fields)) {
      for (const e of reply?.results?.[key]?.uiapi?.query?.Case?.edges || []) {
        const n = e?.node;
        if (!n?.Id || !out.has(n.Id)) continue;
        let v;
        if (f.rel && n[f.rel]) v = String(value(n[f.rel].CaseNumber) || value(n[f.rel].Name) || '');
        else { v = n[f.api]?.displayValue ?? n[f.api]?.value; if (v == null) v = ''; if (typeof v === 'string') v = v.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
        out.get(n.Id)[key] = v;
      }
    }
    return out;
  }

  /* [{ row, data }] for each row, in the order given. `onCase(done, total)` after each batch. `stop()` true ends early
   * (what was read is returned). Never throws: a batch that fails is skipped and its cases come back without data. */
  async function readMany(rows, { origin = '', onBatch = null, stop = null } = {}) {
    const out = rows.map((row) => ({ row, data: null }));
    for (let i = 0; i < rows.length; i += BATCH) {
      if (stop && stop()) break;
      const part = rows.slice(i, i + BATCH);
      const ids = part.map((r) => r.recordId);
      try {
        const first = await globalThis.SfGraphql.run({
          emails: { text: emailsQ(ids) },
          calls: { text: callsQ(ids) },
          hist: { text: histQ(ids, null, historyValues) },
        });
        if (first) {
          let histNodes = await all('CaseHistory', first.results?.hist, (c) => histQ(ids, c, historyValues));
          if (!histNodes && historyValues) {
            const again = await globalThis.SfGraphql.run({ hist: { text: histQ(ids, null, false) } });
            const n2 = await all('CaseHistory', again?.results?.hist, (c) => histQ(ids, c, false));
            if (n2) { historyValues = false; histNodes = n2; }
          }
          const [emails, calls, closure] = await Promise.all([
            all('EmailMessage', first.results?.emails, (c) => emailsQ(ids, c)),
            all('Task', first.results?.calls, (c) => callsQ(ids, c)),
            closureMany(ids).catch(() => new Map()),
          ]);
          const by = (nodes, key) => { const m = new Map(); for (const n of nodes || []) { const k = value(n[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(n); } return m; };
          const em = by(emails, 'ParentId'), ca = by(calls, 'WhatId'), hi = by(histNodes, 'CaseId');
          part.forEach((row, k) => {
            if (!emails) return;
            out[i + k].data = toData(row, {
              emails: (em.get(row.recordId) || []).map((n) => ({ id: n.Id, incoming: !!n.Incoming?.value, date: value(n.MessageDate), from: value(n.FromName) || value(n.FromAddress), body: value(n.TextBody), hasFile: !!n.HasAttachment?.value, draft: String(value(n.Status)) === '5' })),
              calls: (ca.get(row.recordId) || []).map((n) => ({ id: n.Id, date: value(n.CreatedDate), by: value(n.Owner?.Name), body: value(n.Description) })),
              history: histNodes ? globalThis.SfQaCase.ownerChangesFrom(hi.get(row.recordId) || [], row.owner, historyValues) : null,
              closure: closure.get(row.recordId) || {},
            }, origin || (first.origin || ''));
          });
        }
      } catch (e) { /* this batch only */ }
      try { onBatch && onBatch(Math.min(rows.length, i + BATCH), rows.length); } catch (e) { /* the bar only */ }
    }
    return out;
  }

  // One scanned case as the QA engine's `data`. Pure (given SfQaCase and SfActivity).
  function toData(row, { emails, calls, history, closure }, origin) {
    const items = globalThis.SfQaCase.toItems({
      emails, calls, posts: [], ownWords: globalThis.SfActivity && globalThis.SfActivity.ownWords,
      origin, caseUrl: row.url, contact: row.contact,
    });
    const dated = items.filter((i) => i.at).length;
    return {
      caseNumber: row.caseNum, subject: row.subject, caseStatus: row.status, caseOwner: row.owner,
      accountName: row.account, contactName: row.contact, caseAge: row.ageDays, entitlement: row.entitlement,
      jiraNumber: row.jira, caseUrl: row.url, recordId: row.recordId,
      qaOpened: { raw: '', at: row.createdAt }, qaClosed: { raw: '', at: row.closedAt },
      qaClosure: { ...closure, teamLead: closure.teamLead || row.ownerManager, isClosed: true },
      qaReadAt: row.closedAt || Date.now(),
      qaFeed: {
        user: '', items,
        ownerChanges: history ? history.changes : [], changeItems: history ? history.changeItems : 0,
        changedFields: history ? history.changedFields : [], historyRead: !!history,
        seen: items.length, dated, classified: items.length, bodyless: items.filter((i) => i.bodyUnread).length,
        notesRead: false, complete: true,
        reason: !items.length ? 'no-items' : !dated ? 'no-dates' : 'ok', source: 'graphql-scan',
      },
      qaSource: 'graphql-scan',
    };
  }

  return { closedCases, readMany, toData, where, listQuery, RECORD_TYPES };
})();
