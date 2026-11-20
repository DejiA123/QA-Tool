/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// A case's emails, logged calls and files, over GraphQL, in the shapes the feed's reading gave the panel: toChain for
// the email chain, toActivity for the last message and reach-out, toAttachments for the files offered. Loaded by the
// panel after sf-graphql.js. Classic script. Exposes globalThis.SfActivity. Read-only.
//
// Chatter posts and their replies are not here: FeedItem answers only to an exact Id, which nothing readable over
// GraphQL gives, and FeedComment is not in the schema. See docs/guide/graphql-engine.md.
globalThis.SfActivity ??= (() => {
  const PAGE = 200;
  const MAX_ITEMS = 700; // the feed's reading stopped here too
  const BATCH = 50;
  const SEPARATOR = `\n\n${'='.repeat(40)}\n\n`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const IMAGE = /^(png|jpe?g|gif|bmp|webp)$/i;
  const DRAFT = '5'; // EmailMessage.Status

  const value = (field) => field?.value ?? '';
  const when = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? null : t;
  };
  const after = (cursor) => (cursor ? `, after: ${JSON.stringify(cursor)}` : '');

  // The engineer's local time, spelt so that no one can take the day for the month: parseChainTimestamp reads it with
  // confidence, as it did the feed's own label.
  function chainTime(iso) {
    const t = when(iso);
    if (t === null) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const toEmail = (node) => ({
    id: node.Id,
    incoming: !!node.Incoming?.value,
    date: value(node.MessageDate),
    from: value(node.FromName) || value(node.FromAddress),
    body: value(node.TextBody),
    hasFile: !!node.HasAttachment?.value,
    draft: String(value(node.Status)) === DRAFT,
  });
  const toCall = (node) => ({ date: value(node.CreatedDate), by: value(node.Owner?.Name), body: value(node.Description) });

  const emailsQuery = (id, withBodies, cursor) =>
    `query q { uiapi { query { EmailMessage(where: { ParentId: { eq: ${JSON.stringify(id)} } }, orderBy: { MessageDate: { order: DESC } }, first: ${PAGE}${after(cursor)}) { pageInfo { hasNextPage endCursor } edges { node { Id Incoming { value } MessageDate { value } FromName { value } FromAddress { value } ${withBodies ? 'TextBody { value } ' : ''}HasAttachment { value } Status { value } } } } } } }`;
  const callsQuery = (id, withBodies, cursor) =>
    `query q { uiapi { query { Task(where: { and: [{ WhatId: { eq: ${JSON.stringify(id)} } }, { TaskSubtype: { eq: "Call" } }] }, orderBy: { CreatedDate: { order: DESC } }, first: ${PAGE}${after(cursor)}) { pageInfo { hasNextPage endCursor } edges { node { Id TaskSubtype { value } CreatedDate { value } ${withBodies ? 'Description { value } ' : ''}Owner { ... on User { Name { value } } } } } } } } }`;
  const linksQuery = (ids, cursor) =>
    `query q { uiapi { query { ContentDocumentLink(where: { LinkedEntityId: { in: ${JSON.stringify(ids)} } }, first: ${PAGE}${after(cursor)}) { pageInfo { hasNextPage endCursor } edges { node { LinkedEntityId { value } ContentDocumentId { value } ContentDocument { Title { value } FileExtension { value } LatestPublishedVersionId { value } } } } } } } }`;
  const legacyQuery = (ids, cursor) =>
    `query q { uiapi { query { Attachment(where: { ParentId: { in: ${JSON.stringify(ids)} } }, first: ${PAGE}${after(cursor)}) { pageInfo { hasNextPage endCursor } edges { node { Id ParentId { value } Name { value } } } } } } }`;
  const USER = 'query q($uid: ID) { uiapi { query { User(where: { Id: { eq: $uid } }, first: 1) { edges { node { Name { value } } } } } } }';

  // The rows of a first page and of the pages after it, up to MAX_ITEMS. A failed page keeps the ones before: `whole`
  // says so. `first` null: that query failed.
  async function follow(object, first, textFor) {
    const out = { rows: [], read: !!first, whole: !!first };
    let connection = first?.uiapi?.query?.[object];
    while (connection) {
      out.rows.push(...connection.edges.map((e) => e.node));
      if (!connection.pageInfo?.hasNextPage || out.rows.length >= MAX_ITEMS) break;
      const reply = await globalThis.SfGraphql.run({ page: { text: textFor(connection.pageInfo.endCursor) } });
      connection = reply?.results.page?.uiapi?.query?.[object];
      if (!connection) out.whole = false;
    }
    return out;
  }

  // Never throws. Null when no tab can read. withBodies false leaves the texts out, for a read that only wants dates.
  async function read(caseId, { withFiles = false, withBodies = true } = {}) {
    const reply = await globalThis.SfGraphql.run({
      emails: { text: emailsQuery(caseId, withBodies) },
      calls: { text: callsQuery(caseId, withBodies) },
      user: { text: USER },
    });
    if (!reply) return null;
    const [emails, calls] = await Promise.all([
      follow('EmailMessage', reply.results.emails, (cursor) => emailsQuery(caseId, withBodies, cursor)),
      follow('Task', reply.results.calls, (cursor) => callsQuery(caseId, withBodies, cursor)),
    ]);
    const out = {
      origin: reply.origin,
      user: value(reply.results.user?.uiapi?.query?.User?.edges?.[0]?.node?.Name),
      emails: emails.rows.map(toEmail),
      calls: calls.rows.filter((n) => value(n.TaskSubtype) === 'Call').map(toCall),
      emailsRead: emails.read,
      callsRead: calls.read,
      complete: emails.whole && calls.whole,
    };
    if (withFiles) out.attachments = await readFiles(caseId, out.emails, reply.origin);
    return out;
  }

  async function readFiles(caseId, emails, origin) {
    const ids = [caseId, ...emails.filter((e) => e.hasFile).map((e) => e.id)];
    const links = [];
    const legacy = [];
    // Every batch in one round trip (2026-11-18); only a batch with a further page goes back for it.
    const parts = [];
    for (let i = 0; i < ids.length; i += BATCH) parts.push([i, ids.slice(i, i + BATCH)]);
    const qs = {};
    for (const [i, part] of parts) { qs[`links${i}`] = { text: linksQuery(part) }; qs[`legacy${i}`] = { text: legacyQuery(part) }; }
    const reply = await globalThis.SfGraphql.run(qs);
    const followed = await Promise.all(parts.map(([i, part]) => Promise.all([
      follow('ContentDocumentLink', reply?.results[`links${i}`], (cursor) => linksQuery(part, cursor)),
      follow('Attachment', reply?.results[`legacy${i}`], (cursor) => legacyQuery(part, cursor)),
    ])));
    for (const [l, g] of followed) { links.push(...l.rows); legacy.push(...g.rows); }
    return toAttachments(emails, links, legacy, origin);
  }

  /* EACH EMAIL'S OWN WORDS, WITHOUT THE THREAD QUOTED UNDER IT. EmailMessage.TextBody is the whole email, so every
   * reply carries every earlier email again: one 61-email case stored 1.77 M characters, which made Case Info take over
   * a second to open and every save heavier. The prompts already cut these tails before Copilot sees the chain
   * (cleanEmailBody), so cutting them here changes nothing Copilot reads.
   *
   * Only a quote that IS an earlier email of this chain is cut: where it begins (after its From/Sent/To/Subject lines)
   * must be the start of another email's own text. A forwarded thread, or history from before the case, is kept
   * whole. Reply headers in every language the panel knows, "-----Original Message-----" and "On … wrote:". Pure. */
  const FROM = 'From|От|Von|De|Da|Van|Od|Från|Fra|Lähettäjä|Nadawca|Kimden|Feladó|Odesílatel|Από';
  const SENT = 'Sent|Date|Дата|Отправлено|Gesendet|Envoyé|Envoye|Enviado|Enviada|Inviato|Verzonden|Wysłano|Wyslano|Skickat|Sendt|Elküldve|Odesláno|Gönderilen|Lähetetty';
  const REPLY_HEAD = new RegExp(
    `(?:^|\\n)[ \\t]*(?:-{3,}[ \\t]*Original Message[ \\t]*-{3,}[^\\n]*\\n|_{8,}[ \\t]*\\n)?[ \\t]*(?:${FROM})[ \\t]?:[^\\n]{0,300}(?:\\n[^\\n]{0,300}){0,3}?\\n?[ \\t]*(?:${SENT})[ \\t]?:|(?:^|\\n)[ \\t]*-{3,}[ \\t]*Original Message[ \\t]*-{3,}|(?:^|\\n)[ \\t]*On [^\\n]{6,200}wrote:[ \\t]*(?=\\n|$)`,
    'i'
  );
  // Letters and digits only: a quoted copy is often re-flowed ("Hi Viktor,I hope…"), so spacing and punctuation differ.
  const squash = (s) => String(s ?? '').replace(/^>+ ?/gm, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  function ownWords(emails) {
    const split = emails.map((e) => {
      const body = String(e.body ?? '').replace(/\r\n/g, '\n');
      const m = REPLY_HEAD.exec(body);
      if (!m || m.index < 1) return { body, own: body, quote: '' };
      const own = body.slice(0, m.index).trimEnd();
      // The quoted email starts after its header lines, at the first blank line.
      const rest = body.slice(m.index);
      const gap = rest.search(/\n[ \t]*\n/);
      return { body, own, quote: gap < 0 ? '' : rest.slice(gap).trim() };
    });
    const starts = new Set(split.map((s) => squash(s.own).slice(0, 100)).filter((k) => k.length >= 20));
    return split.map((s) => {
      if (!s.quote || squash(s.own).length < 10) return s.body;
      return starts.has(squash(s.quote).slice(0, 100)) ? s.own : s.body;
    });
  }

  // A chain stored before emails were cut to their own words: the same cut for its email entries (calls, internal notes,
  // posts and replies are left as they are). Pure.
  function trimChain(chain) {
    const entries = String(chain ?? '').split(SEPARATOR).map((p) => {
      const at = p.indexOf('\n');
      return { head: at < 0 ? p : p.slice(0, at), body: at < 0 ? '' : p.slice(at + 1) };
    });
    const isEmail = (h) => /^\[[^\]\n]*\] (?!\[[A-Z][A-Z ]{2,20}\] )[^\n]{1,120}:$/.test(h);
    const at = entries.map((e, i) => (isEmail(e.head) ? i : -1)).filter((i) => i >= 0);
    const own = ownWords(at.map((i) => ({ body: entries[i].body })));
    at.forEach((i, k) => { entries[i].body = own[k]; });
    return entries.map((e) => (e.body ? `${e.head}\n${e.body}` : e.head)).join(SEPARATOR);
  }

  // The chain as the feed's reading wrote it, newest first: parseEmailChainEntries splits on the line of `=` and reads
  // each header, so neither the prompts nor the parsing change. Pure.
  function toChain(emails, calls, posts = []) {
    const name = (text) => String(text ?? '').replace(/[:\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Unknown';
    const clean = (text) => String(text ?? '').replace(/\r\n/g, '\n').trim();
    const sent = emails.filter((e) => !e.draft);
    const own = ownWords(sent);
    const items = [
      ...sent.map((e, i) => ({ at: when(e.date) ?? 0, head: `[${chainTime(e.date)}] ${name(e.from)}:`, body: clean(own[i]) })),
      ...calls.map((c) => ({ at: when(c.date) ?? 0, head: `[${chainTime(c.date)}] [CALL LOG] ${name(c.by)}:`, body: clean(c.body) })),
      // Chatter posts and internal notes, with their replies, already shaped by SfFeed.toChainItems.
      ...(posts || []).map((p) => ({ at: p.at || 0, head: p.head, body: clean(p.body) })),
    ];
    return items
      .filter((item) => item.body.length >= 5)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_ITEMS)
      .map((item) => `${item.head}\n${item.body}`)
      .join(SEPARATOR);
  }

  // The chain a read may write. A read that did not finish gives '' when something is stored, so the whole chain stays;
  // with nothing stored, part of a chain is better than none. Pure.
  function chainFor(activity, stored) {
    if (!activity) return '';
    const whole = activity.emailsRead && activity.callsRead && activity.complete;
    if (!(whole || !String(stored ?? '').trim())) return '';
    // Notes are only ever added: a read that comes back short (a feed that would not load to its end) must not wipe
    // notes an earlier read found. Notes that could not be read this time are simply the ones already there.
    const posts = activity.notesRead === false ? keptNotes(stored) : mergeNotes(activity.postItems || [], keptNotes(stored));
    return toChain(activity.emails, activity.calls, posts);
  }

  // The notes just read, and the earlier ones that are not among them (same heading, or same opening words, is the same
  // note). Pure.
  function mergeNotes(fresh, kept) {
    const key = (b) => String(b ?? '').replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase();
    const heads = new Set(fresh.map((p) => p.head));
    const bodies = new Set(fresh.map((p) => key(p.body)));
    return fresh.concat(kept.filter((p) => !heads.has(p.head) && !bodies.has(key(p.body))));
  }

  // The internal notes and posts already in a stored chain, as chain items. Pure.
  function keptNotes(stored) {
    return String(stored ?? '')
      .split(SEPARATOR)
      .map((entry) => {
        const at = entry.indexOf('\n');
        const head = at < 0 ? entry : entry.slice(0, at);
        const body = at < 0 ? '' : entry.slice(at + 1);
        const isNote = /^\[[^\]]*\] \[(INTERNAL|POST)\] /.test(head) || body.includes('\n    ↳ [') || body.startsWith('    ↳ [');
        if (!isNote) return null;
        const t = Date.parse((/^\[([^\]]*)\]/.exec(head) || [])[1] || '');
        return { at: Number.isNaN(t) ? 0 : t, head, body };
      })
      .filter(Boolean);
  }

  // The fields of the feed's activity read. Pure. Emails say outright who wrote them. A failed read is `no-feed`, the
  // reason the panel already takes as "saw nothing".
  function toActivity(activity) {
    const read = !!activity?.emailsRead && !!activity?.callsRead;
    const emails = read ? activity.emails.filter((e) => !e.draft) : [];
    const calls = read ? activity.calls : [];
    const newest = (list) => list.reduce((best, item) => (when(item.date) !== null && (!best || when(item.date) > when(best.date)) ? item : best), null);
    const lastEmail = newest(emails);
    const lastCall = newest(calls);
    const last = lastCall && (!lastEmail || when(lastCall.date) > when(lastEmail.date)) ? lastCall : lastEmail;
    const ours = newest(emails.filter((e) => !e.incoming));
    // Emails come newest first, so a read cut short can still prove an outgoing one, but never that there is none.
    const cut = activity?.complete === false;
    const reason = !read ? 'no-feed' : ours ? 'ok' : cut ? 'no-feed' : lastCall ? 'no-outbound-email' : 'customer-only';
    return {
      lastMessageAt: last ? when(last.date) : null,
      lastMessageLabel: last ? chainTime(last.date) : '',
      lastMessageFrom: last ? (last.from ?? last.by) : '',
      lastReachOutAt: ours ? when(ours.date) : null,
      lastReachOutLabel: ours ? chainTime(ours.date) : '',
      lastReachOutFrom: ours ? ours.from : '',
      activityRead: {
        items: emails.length + calls.length,
        dated: emails.length + calls.length,
        classified: emails.length + calls.length,
        user: activity?.user ?? '',
        reason,
        nonEmailAt: lastCall ? when(lastCall.date) : null,
        nonEmailKind: lastCall ? 'call' : '',
      },
    };
  }

  // One record per file, dated by the newest email it came on (emails come newest first). Pure.
  function toAttachments(emails, links, legacy, origin) {
    const byEmail = new Map(emails.map((e) => [e.id, e]));
    const stamp = (parentId) => {
      const email = byEmail.get(parentId);
      return { whenMs: email ? when(email.date) : null, whenLabel: email ? chainTime(email.date) : '', from: email?.from ?? '' };
    };
    const found = new Map();
    const keep = (record) => {
      const held = found.get(record.id);
      if (!held || (record.whenMs ?? 0) > (held.whenMs ?? 0)) found.set(record.id, record);
    };
    for (const link of links) {
      const doc = link.ContentDocument;
      const version = value(doc?.LatestPublishedVersionId);
      if (!version) continue;
      const title = value(doc.Title);
      const ext = value(doc.FileExtension);
      const name = ext && !title.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${title}.${ext}` : title;
      keep({ id: value(link.ContentDocumentId), url: `${origin}/sfc/servlet.shepherd/version/download/${version}`, name, kind: IMAGE.test(ext) ? 'image' : 'file', ...stamp(value(link.LinkedEntityId)) });
    }
    for (const row of legacy) {
      const name = value(row.Name);
      keep({ id: row.Id, url: `${origin}/servlet/servlet.FileDownload?file=${row.Id}`, name, kind: IMAGE.test(name.split('.').pop()) ? 'image' : 'file', ...stamp(value(row.ParentId)) });
    }
    return [...found.values()].sort((a, b) => (b.whenMs ?? 0) - (a.whenMs ?? 0));
  }

  return { read, toEmail, toCall, chainTime, toChain, chainFor, keptNotes, mergeNotes, ownWords, trimChain, toActivity, toAttachments };
})();
