/* =============================================================================
 * QA Tool — ONE CASE, READ OVER GRAPHQL, IN THE SHAPE THE QA ENGINE MEASURES
 * =============================================================================
 * The SOTI AI Analyser (Beta 9.8.6) reads cases without the page: Salesforce's own GraphQL API, asked from any open
 * Lightning tab (salesforce/sf-graphql.js). Nothing is opened, scrolled or clicked, and every timestamp is the
 * record's own, to the second. This puts that read under the QA Tool's measurement:
 *
 *   · THE CASE'S FIELDS            SfCase.read (the Analyser's module, unchanged)
 *   · EMAILS AND LOGGED CALLS      SfActivity.read: every EmailMessage with its MessageDate and Salesforce's own
 *                                  Incoming flag, so who sent each email is a FACT, never a guess from a signature
 *   · INTERNAL NOTES AND POSTS     SfFeed.read: Salesforce's feed service, as data (when it can be reached)
 *   · WHEN THE CASE CHANGED HANDS  CaseHistory, Field = Owner: the start of the first-response clock
 *   · HOW IT WAS CLOSED            Created / Closed dates, sub-status, Duplicate Case #, the Quality Audits fields
 *                                  and the Problem & Resolution Summary — found by their LABELS, so an API name the
 *                                  org spells differently is still found
 *
 * Out comes `data` in exactly the shape the page read gives (data.qaFeed.items, ownerChanges, qaOpened, qaClosed), so
 * measureCase, the prompts and the review cards need no second path. Each item also carries `url`: the record it came
 * from (the email, the post, the call), which is what a "look at this" flag links to.
 *
 * Loaded by the panel after sf-graphql.js, sf-case.js, sf-activity.js and sf-feed.js. Classic script. Exposes
 * globalThis.SfQaCase. Read-only, and it never logs case text. Every query names its fields one by one.
 * ========================================================================== */
globalThis.SfQaCase ??= (() => {
  const value = (f) => (f && f.value !== undefined && f.value !== null ? f.value : '');
  const shown = (f) => (f ? (f.displayValue ?? f.value ?? '') : '');
  const when = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? null : t; };
  const MEETING = /\b(webex|zoom call|teams (?:call|meeting|session)|remote session|screen ?share|screenshare|gotomeeting|google meet|conference call|troubleshooting session|joint session|live session|remote assistance)\b/i;
  const MEETING_NOTE = /\b(meeting notes?|call notes?|session notes?|minutes of|summary of (?:the )?(?:call|meeting|session)|during (?:the|our) (?:call|meeting|session)|on (?:the|our) call|we (?:discussed|reviewed|walked through|went through|covered|agreed)|attendees|action items?|as discussed)\b/i;
  const ID_LIKE = /^(005|00G|00E)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

  /* ---------------------------------------------------------------- the fields found by their labels ----------- */
  /* Each closure field the QA checks need, by the words of its label. Looked up once a session in the Case's own field
   * list (names, labels and types — never values); a field this user cannot see is simply not asked for. */
  const WANTED = [
    { key: 'subStatus',      label: /^\s*sub[\s-]?status\s*$/i },
    { key: 'duplicateCase',  label: /duplicate\s*case/i },
    { key: 'caseReviewed',   label: /^\s*case\s*reviewed\s*\??\s*$/i },
    { key: 'caseReviewedBy', label: /case\s*reviewed\s*by/i },
    { key: 'postReview',     label: /post[\s-]*review/i },
    { key: 'resolution',     label: /problem\s*&?\s*(?:and\s*)?resolution\s*summary/i, prefer: 'Internal_Resolution_Note__c' },
    { key: 'closing',        label: /closing\s*summary/i },
    { key: 'teamLead',       label: /^\s*case\s*owner['’]s\s*manager\s*$/i, prefer: 'Team_Lead__c' },
  ];
  const INFO = 'query q { uiapi { objectInfos(apiNames: ["Case"]) { ApiName fields { ApiName label dataType ... on ReferenceField { relationshipName referenceToInfos { ApiName } } } } } }';
  const SAFE = /^[A-Za-z][A-Za-z0-9_]{0,70}$/;
  let fieldMap = null;   // { key: { api, rel } } once found
  async function closureFields() {
    if (fieldMap) return fieldMap;
    const found = {};
    try {
      const reply = await globalThis.SfGraphql.run({ info: { text: INFO } });
      const objs = reply?.results?.info?.uiapi?.objectInfos;
      const obj = Array.isArray(objs) ? (objs.find((o) => o?.ApiName === 'Case') || objs[0]) : null;
      const fields = obj ? (Array.isArray(obj.fields) ? obj.fields : Object.values(obj.fields || {})) : [];
      for (const w of WANTED) {
        const hits = fields.filter((f) => f && SAFE.test(String(f.ApiName || '')) && w.label.test(String(f.label || '')));
        const pick = hits.find((f) => f.ApiName === w.prefer) || hits[0];
        if (!pick) continue;
        const ref = /reference/i.test(String(pick.dataType || ''));
        const to = ref && Array.isArray(pick.referenceToInfos) ? String(pick.referenceToInfos[0]?.ApiName || '') : '';
        found[w.key] = { api: pick.ApiName, rel: ref && SAFE.test(String(pick.relationshipName || '')) ? pick.relationshipName : '', to };
      }
      if (fields.length) fieldMap = found;
    } catch (e) { /* asked again next time */ }
    // The two the Analyser already reads by name, when the list could not be had.
    if (!found.resolution) found.resolution = { api: 'Internal_Resolution_Note__c', rel: '' };
    if (!found.teamLead) found.teamLead = { api: 'Team_Lead__c', rel: '' };
    return found;
  }
  const plain = (t) => String(t ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').trim();
  const fieldText = (node, f) => {
    if (!node || !f) return null;
    if (f.rel && node[f.rel]) { const r = node[f.rel]; return String(value(r.CaseNumber) || value(r.Name) || ''); }
    if (!(f.api in node)) return null;
    const v = node[f.api]?.displayValue ?? node[f.api]?.value;
    if (typeof v === 'boolean') return v;
    return v == null ? '' : plain(v);
  };
  // A lookup is read by its record's own words: a Case by its number, anything else (a User) by its Name.
  const fieldQuery = (f, idVar) => `query q($id: ID) { uiapi { query { Case(where: { Id: { eq: $${idVar} } }, first: 1) { edges { node { Id ${f.rel ? `${f.rel} { ${f.to === 'Case' ? 'CaseNumber' : 'Name'} { value } } ` : ''}${f.api} { value displayValue } } } } } } }`;

  // The dates and the closure fields of one case. Each field in a query of its own: one refusal costs one field.
  async function readClosure(id) {
    const fields = await closureFields();
    const queries = { base: { text: 'query q($id: ID) { uiapi { query { Case(where: { Id: { eq: $id } }, first: 1) { edges { node { Id CreatedDate { value } ClosedDate { value } IsClosed { value } Status { value displayValue } Origin { value displayValue } } } } } } }', variables: { id } } };
    for (const [key, f] of Object.entries(fields)) queries[key] = { text: fieldQuery(f, 'id'), variables: { id } };
    const reply = await globalThis.SfGraphql.run(queries);
    if (!reply) return null;
    const node = (name) => reply.results?.[name]?.uiapi?.query?.Case?.edges?.[0]?.node || null;
    const b = node('base');
    const out = {
      createdAt: b ? when(value(b.CreatedDate)) : null,
      createdRaw: b ? value(b.CreatedDate) : '',
      closedAt: b ? when(value(b.ClosedDate)) : null,
      closedRaw: b ? value(b.ClosedDate) : '',
      isClosed: b && typeof b.IsClosed?.value === 'boolean' ? b.IsClosed.value : null,
      origin: b ? shown(b.Origin) : '',
      fields: {},
    };
    for (const key of Object.keys(fields)) {
      const v = fieldText(node(key), fields[key]);
      if (v !== null) out.fields[key] = v;
    }
    return out;
  }

  /* ---------------------------------------------------------------- the owner changes -------------------------- */
  /* CaseHistory, Field = Owner. Asked with its values first; if Salesforce will not give OldValue / NewValue over
   * GraphQL, asked again for the moments alone, and the last change is taken as the one that landed on the owner now. */
  const histQuery = (withValues) => `query q($id: ID) { uiapi { query { CaseHistory(where: { CaseId: { eq: $id } }, orderBy: { CreatedDate: { order: ASC } }, first: 200) { edges { node { Id Field { value } ${withValues ? 'OldValue { value } NewValue { value } ' : ''}CreatedDate { value } CreatedBy { Name { value } } } } } } } }`;
  async function readOwnerChanges(id, owner) {
    for (const withValues of [true, false]) {
      const reply = await globalThis.SfGraphql.run({ h: { text: histQuery(withValues), variables: { id } } });
      const edges = reply?.results?.h?.uiapi?.query?.CaseHistory?.edges;
      if (!Array.isArray(edges)) continue;
      return { read: true, ...ownerChangesFrom(edges.map((e) => e.node), owner, withValues) };
    }
    return { read: false, changes: [], changeItems: 0, changedFields: [] };
  }
  // Pure. Rows of CaseHistory → { changes: [{ at, label, by, from, to, how }], changeItems, changedFields }.
  function ownerChangesFrom(nodes, owner, withValues) {
    const rows = (nodes || []).filter(Boolean);
    const changedFields = [...new Set(rows.map((n) => String(value(n.Field))).filter(Boolean))];
    const owners = rows.filter((n) => /^(owner|ownerassignment)$/i.test(String(value(n.Field))));
    // Salesforce writes an owner change twice: once with the ids, once with the names. The names are kept.
    const named = owners.filter((n) => !withValues || !ID_LIKE.test(String(value(n.NewValue))));
    const pick = named.length ? named : owners;
    const changes = pick.map((n) => ({
      at: when(value(n.CreatedDate)),
      label: value(n.CreatedDate),
      by: value(n.CreatedBy?.Name),
      from: withValues ? String(value(n.OldValue) || '') : '',
      to: withValues ? String(value(n.NewValue) || '') : '',
      how: withValues ? 'case history' : 'case history (no names)',
    })).filter((c) => c.at);
    // Without names, the newest change is the one that gave the case to whoever owns it now.
    if (!withValues && changes.length && owner) changes[changes.length - 1].to = owner;
    return { changes, changeItems: rows.length, changedFields };
  }

  /* ---------------------------------------------------------------- one item of the timeline ------------------- */
  const link = (origin, object, id) => (origin && id ? `${origin}/lightning/r/${object}/${id}/view` : '');
  // Pure: the emails, calls and posts of a case as the QA engine's feed items, oldest first.
  function toItems({ emails = [], calls = [], posts = [], ownWords = null, origin = '', caseUrl = '', contact = '' }) {
    const items = [];
    const sent = emails.filter((e) => !e.draft);
    const own = typeof ownWords === 'function' ? ownWords(sent) : sent.map((e) => e.body);
    sent.forEach((e, i) => {
      const body = String(own[i] ?? e.body ?? '').replace(/\r\n/g, '\n').trim();
      const at = when(e.date);
      items.push({
        at, label: e.date, sender: e.from || 'Unknown', kind: 'email', internal: false,
        fromUs: !e.incoming, body: body.slice(0, 20000), bodyUnread: !body, replies: [],
        mentionsMeeting: MEETING.test(body), readsAsMeetingNote: MEETING_NOTE.test(body),
        recordId: e.id || '', url: link(origin, 'EmailMessage', e.id) || caseUrl, source: 'email',
      });
    });
    for (const c of calls) {
      const body = String(c.body || '').trim();
      items.push({
        at: when(c.date), label: c.date, sender: c.by || 'Unknown', kind: 'call', internal: false, fromUs: true,
        body, bodyUnread: !body, replies: [], mentionsMeeting: true, readsAsMeetingNote: true,
        recordId: c.id || '', url: link(origin, 'Task', c.id) || caseUrl, source: 'call',
      });
    }
    const contactLow = String(contact || '').trim().toLowerCase();
    for (const p of posts) {
      const body = String(p.body || '').trim();
      const replies = (p.replies || []).map((r) => ({ author: r.author, label: r.at || r.timeLabel || '', at: when(r.at), body: r.body }));
      const author = String(p.author || '').trim();
      const fromContact = contactLow && author.toLowerCase().startsWith(contactLow);
      items.push({
        at: when(p.at), label: p.at || p.timeLabel || '', sender: author || 'Unknown',
        kind: p.internal ? 'internal' : 'post', internal: !!p.internal,
        // A note never leaves SOTI. A post is staff's unless the contact wrote it.
        fromUs: p.internal ? true : (fromContact ? false : true),
        body, bodyUnread: !body && !replies.length, replies,
        mentionsMeeting: MEETING.test(body), readsAsMeetingNote: MEETING_NOTE.test(body),
        recordId: p.id || '', url: (origin && p.id ? `${origin}/${p.id}` : '') || caseUrl, source: 'post',
      });
    }
    items.sort((a, b) => (a.at === b.at ? 0 : a.at === null ? 1 : b.at === null ? -1 : a.at - b.at));
    return items;
  }

  /* ---------------------------------------------------------------- the whole read ----------------------------- */
  /* { ok: true, data } or { ok: false, error, why }. `why`: 'no-tab' (no Lightning tab could be asked — the page read is
   * the fallback), 'no-case' (Salesforce has no such case for this user). Never throws. */
  async function read({ recordId = '', caseNumber = '' } = {}, { reader = null, onStep = null, withFeed = true } = {}) {
    try {
      if (!globalThis.SfGraphql || !globalThis.SfCase || !globalThis.SfActivity) return { ok: false, why: 'no-module', error: 'The GraphQL reader did not load.' };
      onStep && onStep('Reading the case over GraphQL…');
      const facts = await globalThis.SfCase.read({ recordId, caseNumber });
      if (!facts) {
        const probe = await globalThis.SfGraphql.run({ p: { text: 'query q { uiapi { query { Case(first: 1) { edges { node { Id } } } } } }' } });
        return probe
          ? { ok: false, why: 'no-case', error: 'Salesforce has no such case, or this user cannot read it.' }
          : { ok: false, why: 'no-tab', error: 'No Salesforce tab could answer — open any Salesforce Lightning tab and sign in.' };
      }
      const caseUrl = `${facts.origin}/lightning/r/Case/${facts.id}/view`;
      onStep && onStep('Reading emails, calls, notes and history…');
      const [activity, posts, closure, history] = await Promise.all([
        globalThis.SfActivity.read(facts.id, { withBodies: true }),
        withFeed && globalThis.SfFeed ? globalThis.SfFeed.read(facts.id, { reader }).catch(() => null) : Promise.resolve(null),
        readClosure(facts.id).catch(() => null),
        readOwnerChanges(facts.id, facts.owner).catch(() => ({ read: false, changes: [], changeItems: 0, changedFields: [] })),
      ]);
      if (!activity || !activity.emailsRead) return { ok: false, why: 'no-tab', error: 'The case was found, but its emails could not be read over GraphQL.' };

      const items = toItems({
        emails: activity.emails, calls: activity.calls, posts: posts && posts.ok ? posts.posts : [],
        ownWords: globalThis.SfActivity.ownWords, origin: facts.origin, caseUrl, contact: facts.contactName,
      });
      const data = globalThis.SfCase.toData(facts);
      data.recordId = facts.id;
      data.caseUrl = caseUrl;
      data.qaOpened = closure && closure.createdAt ? { raw: closure.createdRaw, at: closure.createdAt } : { raw: '', at: null };
      data.qaClosed = closure && closure.closedAt ? { raw: closure.closedRaw, at: closure.closedAt } : { raw: '', at: null };
      data.qaClosure = closure ? { ...closure.fields, isClosed: closure.isClosed, origin: closure.origin } : {};
      data.qaReadAt = Date.now();
      const dated = items.filter((i) => i.at).length;
      data.qaFeed = {
        user: activity.user || '',
        items,
        ownerChanges: history.changes,
        changeItems: history.changeItems,
        changedFields: history.changedFields,
        historyRead: history.read,
        seen: items.length,
        dated,
        classified: items.length,
        bodyless: items.filter((i) => i.bodyUnread).length,
        notesRead: !!(posts && posts.ok),
        notesComplete: !!(posts && posts.complete),
        complete: !!activity.complete,
        reason: !items.length ? 'no-items' : !dated ? 'no-dates' : 'ok',
        source: 'graphql',
      };
      data.qaSource = 'graphql';
      return { ok: true, data };
    } catch (e) {
      return { ok: false, why: 'error', error: 'The GraphQL read failed — ' + ((e && e.message) || e) };
    }
  }

  return { read, toItems, ownerChangesFrom, closureFields, readClosure, readOwnerChanges };
})();
