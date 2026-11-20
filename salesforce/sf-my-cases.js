/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// The engineer's own, temporary and escalation open cases, over GraphQL, as rows of the Cases queue, and which of them
// are new. Reports and saved list views cannot be run this way, so the queue is these three groups. Loaded by the panel
// after sf-graphql.js. Classic script. Exposes globalThis.SfMyCases. Read-only. Every query names its fields one by one.
globalThis.SfMyCases ??= (() => {
  // The most specific first: a case in two groups shows in the first of them.
  const GROUPS = ['escalation', 'temporary', 'own'];
  const FILTER = { own: 'OwnerId', temporary: 'Temporary_Case_Owner__c', escalation: 'Escalation_Owner__c' };
  /* WHICH CASE FIELD IS "ESCALATION OWNER" (Beta 9.6.2, the maintainer: "IT MUST BE ACCURATE!!!"). Escalation_Owner__c by
   * its name, checked once a session against Salesforce's own list of Case fields: the lookup whose label is
   * "Escalation Owner" is the one used, for the escalation group and for the name shown. Until that list answers, the
   * name stands. */
  const ESC = { api: 'Escalation_Owner__c', rel: 'Escalation_Owner__r', checked: false };
  const ESC_NAMES = 'query q { uiapi { objectInfos(apiNames: ["Case"]) { fields { ApiName label dataType } } } }';
  async function settleEscalationField() {
    if (ESC.checked) return ESC;
    try {
      const reply = await globalThis.SfGraphql.run({ names: { text: ESC_NAMES } });
      const fields = reply?.results?.names?.uiapi?.objectInfos?.[0]?.fields;
      if (!Array.isArray(fields)) return ESC;
      const labelled = fields.filter((f) => /^\s*escalation\s+owner\s*$/i.test(String(f?.label ?? ''))
        && /reference/i.test(String(f?.dataType ?? '')) && /^[A-Za-z0-9_]+__c$/.test(String(f?.ApiName ?? '')));
      const pick = labelled.find((f) => f.ApiName === ESC.api) || (labelled.length === 1 ? labelled[0] : null);
      if (pick) { ESC.api = pick.ApiName; ESC.rel = pick.ApiName.replace(/__c$/, '__r'); }
      FILTER.escalation = ESC.api;
      ESC.checked = true;
    } catch { /* the name stands; asked again next time */ }
    return ESC;
  }
  const FIELDS =
    'Id CaseNumber { value } Subject { value } Status { value displayValue } Priority { value displayValue } Description { value } CreatedDate { value displayValue } LastModifiedDate { value displayValue } Case_Age_in_days__c { value } Entitlement_Name__c { value } JIRA_Number__c { value } Case_Analysis_Comments__c { value } License_Type__c { value } Product__c { value displayValue } Last_Completed_Activity_Icon__c { value } Team_Lead__c { value } LastModifiedBy { Name { value } Alias { value } } Owner { ... on User { Name { value } } ... on Group { Name { value } } } Temporary_Case_Owner__r { Name { value } } Account { Name { value } } Contact { Name { value } }';

  /* THE ESCALATION OWNER'S NAME (Beta 9.6.2, the maintainer: "ADD AN ESCALATION OWNER COLUMN"). The groups already filter
   * on Escalation_Owner__c; its name comes through the lookup, Escalation_Owner__r. Asked for with the rest, and if this
   * org's Salesforce will not take it (every group refused), the read is made again without it, for this session: the
   * name is a column, and must never cost the engineer the whole list. */
  let withEscOwner = true;
  const fieldsNow = () => FIELDS + (withEscOwner ? ` ${ESC.rel} { Name { value } }` : '');

  const MAX_PAGES = 25;
  // `who` set: the same groups for another user (an 005 id, passed as $who), for a saved filter about that person. Without
  // it, $uid: the signed-in user, filled in by SfGraphql.
  const queryFor = (group, cursor, who) =>
    `query q($${who ? 'who' : 'uid'}: ID) { uiapi { query { Case(where: { and: [{ ${FILTER[group]}: { eq: $${who ? 'who' : 'uid'} } }, { IsClosed: { eq: false } }] }, first: 200${cursor ? `, after: ${JSON.stringify(cursor)}` : ''}) { pageInfo { hasNextPage endCursor } edges { node { ${fieldsNow()} } } } } } }`;

  // The flag is the alt of the <img> the formula returns: parsed and never injected. '' for anything else.
  const flagOf = (html) => /\balt\s*=\s*["']?(red|yellow|green)\b/i.exec(String(html ?? ''))?.[1].toLowerCase() ?? '';

  // One case as a row of the queue. sfFields goes to Copilot with the case, as a report's columns did, under the same
  // headings; a report's other columns have no equivalent here.
  function toRow(node, origin, group) {
    const value = (field) => field?.value ?? '';
    const shown = (field) => field?.displayValue ?? field?.value ?? '';
    const age = node.Case_Age_in_days__c?.value;
    const row = {
      group,
      recordId: node.Id,
      url: origin ? `${origin}/lightning/r/Case/${node.Id}/view` : '',
      caseNum: value(node.CaseNumber),
      subject: value(node.Subject),
      status: shown(node.Status),
      priority: shown(node.Priority),
      account: value(node.Account?.Name),
      contact: value(node.Contact?.Name),
      jira: value(node.JIRA_Number__c),
      entitlement: value(node.Entitlement_Name__c),
      description: value(node.Description),
      analysis: value(node.Case_Analysis_Comments__c),
      ageDays: typeof age === 'number' ? String(Math.floor(age)) : '',
      opened: shown(node.CreatedDate),
      modified: shown(node.LastModifiedDate),
      owner: value(node.Owner?.Name),
      lastModifiedBy: value(node.LastModifiedBy?.Alias) || value(node.LastModifiedBy?.Name),
      ownerManager: value(node.Team_Lead__c),
      tempOwner: value(node.Temporary_Case_Owner__r?.Name),
      escOwner: value(node[ESC.rel]?.Name),
      // Read from the record itself: what the Escalation Owner column shows, over any report's column.
      escOwnerRead: withEscOwner ? Date.now() : 0,
      licenseType: value(node.License_Type__c),
      product: shown(node.Product__c),
      activityIcon: flagOf(node.Last_Completed_Activity_Icon__c?.value),
    };
    const columns = {
      'Case Number': row.caseNum,
      Subject: row.subject,
      Status: row.status,
      'Case Priority': row.priority,
      'Account Name': row.account,
      'Contact Name': row.contact,
      'JIRA Number': row.jira,
      'Entitlement Name': row.entitlement,
      'Case Analysis Comments': row.analysis,
      'Case Age (in days)': row.ageDays,
      'Date/Time Opened': row.opened,
      'Last Modified Date': row.modified,
      'Case Owner': row.owner,
      "Case Owner's Manager": row.ownerManager,
      'Temporary Case Owner': row.tempOwner,
      'Escalation Owner': row.escOwner,
      'License Type': row.licenseType,
      Product: row.product,
    };
    row.sfFields = Object.fromEntries(Object.entries(columns).filter(([, text]) => text));
    return row;
  }

  /* IN THE DEVELOPMENT QUEUE (Beta 9.8.4, the maintainer, 2026-11-16: "Cases in the development queue should not be seen in
   * the cases view since ... the agent is not working on their case that is in the development queue"). The case's Owner is
   * then the Development queue: in Salesforce the queue "EMEA development queue" (API name UK_L1_assignment_group; its list
   * view is /lightning/o/Case/list?filterName=UK_L1_assignment_group_Case, the maintainer, 2026-11-16, whatever the case's
   * Status), or another queue named for Development. No person is called that. Takes a GraphQL node or a queue row. Pure. */
  const DEV_QUEUE = /\bdevelopment\b|\bdev(?:elopment)? queue\b|\buk l1 assignment group\b/i;
  function inDevQueue(x) {
    const owner = typeof x?.owner === 'string' ? x.owner : x?.Owner?.Name?.value;
    return DEV_QUEUE.test(String(owner || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' '));
  }

  // Every row of a group: its first page and the ones after. Null when a page failed.
  async function wholeGroup(group, first, who) {
    const nodes = [];
    let connection = first?.uiapi?.query?.Case;
    for (let page = 0; connection && page < MAX_PAGES; page++) {
      nodes.push(...connection.edges.map((e) => e.node));
      if (!connection.pageInfo?.hasNextPage) return nodes;
      const reply = await globalThis.SfGraphql.run({ page: { text: queryFor(group, connection.pageInfo.endCursor, who), ...(who ? { variables: { who } } : {}) } });
      connection = reply?.results.page?.uiapi?.query?.Case;
    }
    return null;
  }

  // { origin, own, temporary, escalation }, each case in its most specific group only. Never throws. Null when no tab
  // can read or any page of any group failed: half a list must not replace a whole one.
  /* `who` (Beta 9.8.2): another user's open cases, the same three groups, for a saved filter about that person (the
   * maintainer: "if i am on a saved filter and i click the blue refresh button it should use the graphql
   * refresh"). Only an 005 user id; anything else is refused (null). Without it, the signed-in user's, as before. */
  async function read(who) {
    if (who !== undefined && !(typeof who === 'string' && /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(who))) return null;
    await settleEscalationField();
    const reply = await globalThis.SfGraphql.run(Object.fromEntries(GROUPS.map((group) => [group, { text: queryFor(group, null, who), ...(who ? { variables: { who } } : {}) }])));
    // Every group refused, with the Escalation Owner's name asked for: once more without it (see ESC_OWNER_FIELD).
    if (reply && withEscOwner && GROUPS.every((group) => !reply.results[group])) {
      withEscOwner = false;
      const again = await read(who);
      if (!again) withEscOwner = true;   // not the field, then: ask for it again next time
      return again;
    }
    if (!reply || GROUPS.some((group) => !reply.results[group])) return null;
    const taken = new Set();
    const out = { origin: reply.origin };
    for (const group of GROUPS) {
      out[group] = [];
      const nodes = await wholeGroup(group, reply.results[group], who);
      if (!nodes) return null;
      for (const node of nodes) {
        if (taken.has(node.Id)) continue;
        taken.add(node.Id);
        if (inDevQueue(node)) continue;   // with Development, not with the agent (Beta 9.8.4)
        out[group].push(toRow(node, reply.origin, group));
      }
    }
    return out;
  }

  /* THE ESCALATION OWNER OF EACH CASE, STRAIGHT FROM ITS RECORD (Beta 9.6.2), for every row of the queue, the Agent Cases
   * report's included: a report column is whatever that report says, the record is the case. 200 cases a question, the Id
   * and that one name only. Map(18-character id -> name, '' for none), or null when any part could not be read: a
   * half-read must not blank the names it did not reach. */
  async function escalationOwners(ids) {
    const list = [...new Set((ids ?? []).map(String).filter((id) => /^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id)))];
    const out = new Map();
    if (!list.length) return out;
    await settleEscalationField();
    if (!withEscOwner) return null;
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const text = `query q { uiapi { query { Case(where: { Id: { in: ${JSON.stringify(part)} } }, first: 200) { edges { node { Id ${ESC.rel} { Name { value } } } } } } } }`;
      const reply = await globalThis.SfGraphql.run({ esc: { text } });
      const edges = reply?.results?.esc?.uiapi?.query?.Case?.edges;
      if (!Array.isArray(edges)) return null;
      for (const e of edges) if (e?.node?.Id) out.set(e.node.Id, e.node[ESC.rel]?.Name?.value ?? '');
    }
    return out;
  }

  /* THE CASES A SAVED FILTER SHOWS, READ AGAIN FROM THEIR OWN RECORDS (Beta 9.8.2), by id, 200 a question: the same
   * fields as a row of the queue, whether the case has closed, and the user ids behind its Case, Temporary and Escalation
   * Owner (so the panel can read the person the filter is about). { origin, rows, closed: [{ id, caseNum }] }, or null
   * when any part could not be read: a half-read must not change the list. Ids that do not come back (deleted, or not
   * this user's to see) are in neither. */
  async function byIds(ids) {
    const list = [...new Set((ids ?? []).map(String).filter((id) => /^500[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id)))];
    const out = { origin: '', rows: [], closed: [] };
    if (!list.length) return out;
    await settleEscalationField();
    const who = ` IsClosed { value } OwnerId { value } Temporary_Case_Owner__c { value }${withEscOwner ? ` ${ESC.api} { value }` : ''}`;
    for (let i = 0; i < list.length; i += 200) {
      const part = list.slice(i, i + 200);
      const text = `query q { uiapi { query { Case(where: { Id: { in: ${JSON.stringify(part)} } }, first: 200) { edges { node { ${fieldsNow()}${who} } } } } } }`;
      const reply = await globalThis.SfGraphql.run({ ids: { text } });
      const edges = reply?.results?.ids?.uiapi?.query?.Case?.edges;
      if (!Array.isArray(edges)) return null;
      out.origin = out.origin || reply.origin || '';
      for (const e of edges) {
        const node = e?.node;
        if (!node?.Id) continue;
        if (node.IsClosed?.value === true) { out.closed.push({ id: node.Id, caseNum: node.CaseNumber?.value ?? '' }); continue; }
        const { group, ...row } = toRow(node, reply.origin, '');
        row.ownerId = node.OwnerId?.value ?? '';
        row.tempOwnerId = node.Temporary_Case_Owner__c?.value ?? '';
        row.escOwnerId = withEscOwner ? (node[ESC.api]?.value ?? '') : '';
        out.rows.push(row);
      }
    }
    return out;
  }

  const idsOf = (rows) => (rows ?? []).map((row) => row.recordId);

  // Which temporary and escalation cases a read found that were not seen before, and the ids to remember now. With
  // nothing seen yet, all are new. Pure.
  function newSince(seen, groups) {
    const known = new Set(seen ?? []);
    const fresh = (group) => idsOf(groups[group]).filter((id) => !known.has(id));
    return { temporary: fresh('temporary'), escalation: fresh('escalation'), seen: [...idsOf(groups.temporary), ...idsOf(groups.escalation)] };
  }

  // What the notice holds after a read: what it held, while still so assigned, and what the read found new. Pure.
  function noticeAfter(notice, since, groups) {
    const held = (group) => {
      const now = new Set(idsOf(groups[group]));
      return [...new Set([...(notice?.[group] ?? []), ...since[group]])].filter((id) => now.has(id));
    };
    return { temporary: held('temporary'), escalation: held('escalation') };
  }

  // Counts and the kind, never case text. Pure.
  function noticeLines(notice) {
    const lines = [];
    const temporary = notice?.temporary?.length ?? 0;
    const escalation = notice?.escalation?.length ?? 0;
    if (temporary) lines.push(`${temporary} new temporary ${temporary === 1 ? 'case' : 'cases'} assigned to you`);
    if (escalation) lines.push(`${escalation} new ${escalation === 1 ? 'escalation' : 'escalations'}`);
    return lines;
  }

  // `fields` and `settle`: the queue's field list and the Escalation Owner check, for salesforce/sf-agent-cases.js (the same rows).
  return { read, byIds, queryFor, flagOf, toRow, inDevQueue, newSince, noticeAfter, noticeLines, escalationOwners, escalationField: () => ({ ...ESC }), fields: () => fieldsNow(), settle: settleEscalationField };
})();
