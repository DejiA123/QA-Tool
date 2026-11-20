/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// A case's Chatter posts and internal notes, with their replies, for the email chain. Loaded by the panel after
// sf-graphql.js and sf-activity.js. Classic script. Exposes globalThis.SfFeed. Read-only.
//
// GraphQL reads a FeedItem only by its exact Id, and FeedComment is not in its schema (see the feed spike), so GraphQL
// cannot LIST a case's posts for our users. Salesforce's own feed service can: it is what the Feed tab itself asks.
//   1. THE FEED SERVICE gives the list, as data. sf-feed-capture.js notes, in a Lightning tab, how Lightning asks the
//      service for a feed; the same request is then made for this case: every post's Id, its text, who sees it, and
//      its replies, page after page. Nothing is drawn, scrolled or clicked, and no window or tab is opened.
//   2. GRAPHQL reads each post by its Id: its ParentId (a post is kept only if it belongs to this case) and its text.
//   3. Posts a page has already drawn (no click, no scroll) add any Id the service did not give.
// Emails and logged calls are left out here: they come whole from EmailMessage and Task (sf-activity.js).
globalThis.SfFeed ??= (() => {
  const PAGE_PATTERNS = ['https://*.lightning.force.com/*'];
  const SKIP_TYPES = /^(EmailMessageEvent|CallLogPost|TrackedChange|ChangeStatusPost|CreateRecordEvent)$/i;
  const ID_BATCH = 100;
  const MAX_POSTS = 400;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const value = (field) => field?.value ?? '';
  const id15 = (id) => String(id || '').slice(0, 15);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ in the page ------------------------------ */

  // Every post the page has drawn, each with its replies. Runs in a Salesforce tab through executeScript, so it is
  // self-contained: no outer names. Reads only; never clicks or scrolls.
  function pageCollect() {
    const POST = 'article.cuf-feedItem[data-id], article.cuf-feedElement[data-id]';
    const REPLY = 'article.cuf-commentItem, article.forceChatterComment, .forceChatterComment';
    const BLOCK = /^(P|DIV|LI|UL|OL|BR|H[1-6]|TR|BLOCKQUOTE|PRE|ARTICLE|SECTION)$/;
    // Through shadow roots too: some Lightning releases draw parts of the feed inside one.
    // The light DOM first: the Aura feed lives there, and walking every shadow root of a Lightning page is the slow
    // part. Only when it finds nothing are the shadow roots searched too.
    const deep = (root, sel, out = []) => {
      try { out.push(...root.querySelectorAll(sel)); } catch (e) { /* not queryable */ }
      let walker;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); } catch (e) { return out; }
      for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.shadowRoot) deep(n.shadowRoot, sel, out);
      return out;
    };
    const all = (root, sel) => {
      let light = [];
      try { light = [...root.querySelectorAll(sel)]; } catch (e) { light = []; }
      return light.length ? light : deep(root, sel);
    };
    // The text with its paragraphs, whether or not the page is painted (a hidden tab's innerText runs lines together).
    const text = (el) => {
      if (!el) return '';
      let out = '';
      const walk = (n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        if (n.classList && (n.classList.contains('slds-assistive-text') || n.classList.contains('cuf-more'))) return;
        if (tag === 'BR') { out += '\n'; return; }
        // A link keeps where it points when its words do not say it ("Read message at October 28 (https://…)").
        if (tag === 'A') {
          const href = n.getAttribute('href') || '';
          const before = out.length;
          for (const c of n.childNodes) walk(c);
          const words = out.slice(before).trim();
          if (/^https?:\/\//i.test(href) && words && words !== href && !words.includes(href)) out += ` (${href})`;
          return;
        }
        const block = BLOCK.test(tag);
        if (block && out && !out.endsWith('\n')) out += '\n';
        for (const c of n.childNodes) walk(c);
        if (block && !out.endsWith('\n')) out += '\n';
      };
      walk(el);
      return out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    };
    const firstText = (root, sels) => {
      for (const sel of sels) for (const el of root.querySelectorAll(sel)) { const t = text(el); if (t) return t; }
      return '';
    };
    const shown = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const posts = all(document, POST).filter((a) => /^0D5/.test(a.getAttribute('data-id') || ''));
    const seen = new Set();
    const list = [];
    for (const a of posts) {
      const id = a.getAttribute('data-id');
      if (seen.has(id)) continue;
      seen.add(id);
      const pre = a.querySelector('.preamble_custom-preamble');
      const bodyEl = [...a.querySelectorAll('.feedBodyInner, .forceChatterFeedBodyText, .cuf-feedBodyText')].find((el) => !el.closest(REPLY));
      const stamp = a.querySelector('.preamble_right a[title], .preamble_right .uiOutputText, a.compactTimeStamp');
      list.push({
        id,
        el: a,
        type: a.getAttribute('data-type') || '',
        visible: shown(a),
        internal: /\binternal\b/i.test(text(pre)),
        audience: text(pre),
        author: (() => {
          const who = firstText(a, ['.preamble_left .cuf-actorLink .uiOutputText', '.preamble_left .uiOutputText', '.preamble_left a[title]', '.cuf-actorLink', '.preamble_left']);
          const team = text(a.querySelector('.preamble_left .cuf-entityAdditionalLabel'));
          return team && !who.includes(team) ? `${who} ${team}` : who;
        })(),
        // The exact time is in the Comment button's hidden label ("Comment on Viktor Samsonov at 2026-11-02T06:49:10.000Z"),
        // where the visible one may only say "4h ago".
        at: (() => {
          for (const s of a.querySelectorAll('.slds-assistive-text')) {
            if (s.closest(REPLY)) continue;
            const m = /\bat (\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z)/.exec(s.textContent || '');
            if (m) return m[1];
          }
          return '';
        })(),
        timeLabel: (stamp && (stamp.getAttribute('title') || text(stamp))) || '',
        body: text(bodyEl) || text(a.querySelector('.preamble_custom-summary')),
        replies: [],
      });
    }
    // A reply belongs to the post it is inside, or else to the nearest post above it: Salesforce draws it as a sibling
    // of the post on some layouts. Nested replies belong to their reply, not to a post.
    const replies = all(document, REPLY);
    const used = new Set();
    for (const r of replies) {
      if (used.has(r)) continue;
      used.add(r);
      const outer = r.parentElement && r.parentElement.closest(REPLY);
      if (outer && outer !== r) continue;
      let owner = list.find((p) => p.el.contains(r)) || null;
      if (!owner) for (const p of list) { const pos = p.el.compareDocumentPosition(r); if (pos & 1) continue; if (pos & 4) owner = p; }
      if (!owner) continue;
      const author = firstText(r, ['.cuf-commentNameLink .uiOutputText', '.cuf-preamble .uiOutputText', '.cuf-entityLink .uiOutputText', '.cuf-commentNameLink', '.cuf-preamble'])
        || (r.querySelector('img[title]') || {}).title || 'Unknown';
      const timeEl = r.querySelector('time[datetime]');
      const ageEl = r.querySelector('feeds_timestamping-comment-creation, .cuf-commentAge');
      const body = text(r.querySelector('.slds-comment__content .feedBodyInner')) || text(r.querySelector('.slds-comment__content')) || text(r.querySelector('.feedBodyInner, .cuf-feedBodyText'));
      if (!body || body.length < 2) continue;
      owner.replies.push({ id: r.getAttribute('data-id') || '', author, at: (timeEl && timeEl.getAttribute('datetime')) || '', timeLabel: (ageEl && ageEl.getAttribute('title')) || '', body });
    }
    const feedShown = !!document.querySelector('.cuf-feedItem, .cuf-feedElement, .forceChatterFeed, .cuf-scroller, .forceChatterFeedContainer, .cuf-feedEmptyState, .forceChatterNoResults, .slds-feed, [data-aura-class*="forceChatterFeed"], [data-aura-class*="cufFeed"]');
    const feedTab = all(document, '[role="tab"], a[data-label], .slds-tabs_default__link').filter(shown)
      .find((t) => /^(feed|case feed|chatter)$/i.test(((t.getAttribute('data-label') || t.getAttribute('title') || t.textContent) || '').trim()));
    return { url: location.href, title: document.title, feedShown, feedTab: feedTab ? (feedTab.getAttribute('aria-selected') === 'true' ? 'selected' : 'not selected') : 'none', posts: list.map(({ el, ...p }) => p) };
  }

  // Open the record's Feed tab when it is not showing: in the panel's reader tab, and in a tab the panel has just opened
  // from the Cases list. Only visible tabs count, so a console's other case tabs are never touched. Self-contained.
  // 'shown' (Feed already showing, or the feed drawn without tabs), 'clicked', or 'no-tab' (not drawn yet).
  function pageOpenFeed(opts) {
    const anyTab = !!(opts && opts.anyTab); // the reader tab shows this case alone, and a hidden window may size nothing
    // The light DOM first: the Aura feed lives there, and walking every shadow root of a Lightning page is the slow
    // part. Only when it finds nothing are the shadow roots searched too.
    const deep = (root, sel, out = []) => {
      try { out.push(...root.querySelectorAll(sel)); } catch (e) { /* not queryable */ }
      let walker;
      try { walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); } catch (e) { return out; }
      for (let n = walker.currentNode; n; n = walker.nextNode()) if (n.shadowRoot) deep(n.shadowRoot, sel, out);
      return out;
    };
    const all = (root, sel) => {
      let light = [];
      try { light = [...root.querySelectorAll(sel)]; } catch (e) { light = []; }
      return light.length ? light : deep(root, sel);
    };
    const shown = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const label = (t) => ((t.getAttribute('data-label') || t.getAttribute('title') || t.textContent) || '').trim();
    const every = all(document, '[role="tab"], a[data-label], .slds-tabs_default__link');
    const isFeed = (t) => /^(feed|case feed|chatter)$/i.test(label(t));
    const feed = every.filter(shown).find(isFeed) || (anyTab ? every.find(isFeed) : null);
    if (!feed) return all(document, '.cuf-feedItem, .cuf-feedElement').some((el) => anyTab || shown(el)) ? 'shown' : 'no-tab';
    if (feed.getAttribute('aria-selected') === 'true' || feed.closest('[aria-selected="true"], .slds-is-active')) return 'shown';
    feed.click();
    return 'clicked';
  }

  async function inTab(tabId, func, args) {
    try {
      const [{ result } = {}] = await globalThis.chrome.scripting.executeScript({ target: { tabId }, func, ...(args ? { args } : {}) });
      return result ?? null;
    } catch (e) {
      return null;
    }
  }

  /* In a Lightning tab's own world: the case's whole feed from Salesforce's feed service, as data, made the way the
   * page's own Feed made its request (noted by sf-feed-capture.js), with the record swapped for this case and the
   * next pages followed. Returns the service's answers as they came. Self-contained. */
  async function pageFeedService(args) {
    const caps = window.__sotiFeedCapture || [];
    if (!caps.length) return { ok: false, why: 'no-capture' };
    const isId = (v) => typeof v === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(v);
    const findId = (o, want) => {
      if (isId(o) && want.test(o)) return o;
      if (o && typeof o === 'object') for (const k of Object.keys(o)) { const f = findId(o[k], want); if (f) return f; }
      return '';
    };
    const swap = (o, from, to) => {
      if (typeof o === 'string') return o.slice(0, 15) === from ? to : o;
      if (Array.isArray(o)) return o.map((x) => swap(x, from, to));
      if (o && typeof o === 'object') { const n = {}; for (const k of Object.keys(o)) n[k] = swap(o[k], from, to); return n; }
      return o;
    };
    const pageKeyOf = (o) => Object.keys(o || {}).find((k) => /page.?token|pageparam|nextpage|pageurl/i.test(k)) || '';
    const nextOf = (o, d = 0) => {
      if (!o || typeof o !== 'object' || d > 12) return '';
      for (const k of Object.keys(o)) {
        if (/^next(page)?(token|param|url)$/i.test(k) && typeof o[k] === 'string' && o[k]) return o[k];
      }
      for (const k of Object.keys(o)) { const f = nextOf(o[k], d + 1); if (f) return f; }
      return '';
    };
    const errors = [];
    for (const cap of caps) {
      const was = findId(cap.params, /^500/) || findId(cap.params, /^[a-zA-Z0-9]/);
      if (!was) continue;
      let params = swap(cap.params, was.slice(0, 15), args.caseId);
      for (const k of Object.keys(params)) if (/^(pagesize|count|limit|size)$/i.test(k) && typeof params[k] === 'number') params[k] = Math.max(params[k], 100);
      const pageKey = pageKeyOf(params);
      const values = [];
      try {
        window.__sotiReplaying = true;
        for (let page = 0; page < 25; page++) {
          const message = JSON.stringify({ actions: [{ id: `${900 + page};a`, descriptor: cap.descriptor, callingDescriptor: cap.callingDescriptor || 'UNKNOWN', params }] });
          const body = new URLSearchParams({ message, 'aura.context': cap.context, 'aura.pageURI': location.pathname + location.search + location.hash, 'aura.token': cap.token });
          const res = await fetch(cap.url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: body.toString() });
          const text = await res.text();
          let answer = null;
          try { answer = JSON.parse(text.slice(text.indexOf('{'))); } catch (e) { answer = null; }
          const act = answer && answer.actions && answer.actions[0];
          if (!act || act.state !== 'SUCCESS') { errors.push(`${res.status} ${act ? act.state : 'unreadable answer'}`); break; }
          values.push(act.returnValue);
          const next = nextOf(act.returnValue);
          if (!next || !pageKey || next === params[pageKey]) break;
          params = Object.assign({}, params, { [pageKey]: next });
        }
      } catch (e) {
        errors.push(String((e && e.message) || e));
      } finally {
        window.__sotiReplaying = false;
      }
      if (values.length) return { ok: true, values, descriptor: String(cap.descriptor).split('/').pop(), pages: values.length };
    }
    return { ok: false, why: errors.length ? `the feed service answered: ${errors.join('; ')}` : 'no-capture' };
  }

  // The posts in the feed service's answers: any object whose id is a FeedItem's (0D5…), with the replies inside it
  // (0D7…). Field names as Salesforce's feed API gives them (actor, body.text, createdDate, visibility, parent). Pure.
  function postsFromService(values) {
    const posts = new Map();
    const text = (b) => (typeof b === 'string' ? b : b ? (b.text || (Array.isArray(b.messageSegments) ? b.messageSegments.map((s) => s.text || '').join('') : '')) : '');
    const who = (u) => (u ? u.displayName || u.name || u.Name || '' : '');
    const walk = (o, d) => {
      if (!o || typeof o !== 'object' || d > 40) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
      if (typeof o.id === 'string' && /^0D5/.test(o.id) && !posts.has(id15(o.id))) {
        const replies = [];
        const seen = new Set();
        const comments = (c, e) => {
          if (!c || typeof c !== 'object' || e > 30) return;
          if (Array.isArray(c)) { for (const x of c) comments(x, e + 1); return; }
          if (typeof c.id === 'string' && /^0D7/.test(c.id) && !seen.has(c.id)) {
            seen.add(c.id);
            replies.push({ id: c.id, author: who(c.user) || who(c.actor) || who(c.createdBy) || 'Unknown', at: c.createdDate || '', timeLabel: '', body: htmlToText(text(c.body)) });
          }
          for (const k of Object.keys(c)) if (k !== 'parent') comments(c[k], e + 1);
        };
        comments(o.capabilities || o.comments || {}, 0);
        replies.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
        const vis = String(o.visibility || '');
        posts.set(id15(o.id), {
          id: o.id,
          type: o.type || o.feedElementType || '',
          internal: /internal/i.test(vis),
          audience: vis,
          author: who(o.actor) || who(o.createdBy) || '',
          at: o.createdDate || '',
          timeLabel: '',
          body: htmlToText(text(o.body)),
          parentId: (o.parent && o.parent.id) || o.parentId || '',
          visible: true,
          replies: replies.filter((r) => r.body),
        });
      }
      for (const k of Object.keys(o)) walk(o[k], d + 1);
    };
    for (const v of values || []) walk(v, 0);
    return [...posts.values()];
  }

  // The feed service, from the Lightning tabs (the one in front first). A tab only knows the request once Salesforce has
  // loaded a feed in it, so a case just opened from the Cases list is given a few seconds to load its Feed.
  async function fromService(caseId, trace, ownOpen) {
    const tabsNow = async () => {
      try { return (await globalThis.chrome.tabs.query({ url: PAGE_PATTERNS, discarded: false })).filter((t) => !reader_owned(t)).sort((a, b) => Number(!!b.active) - Number(!!a.active)); } catch (e) { return []; }
    };
    let why = 'no Lightning tab is open';
    for (let wait = 0; wait < (ownOpen ? 12 : 1); wait++) {
      if (wait) await sleep(1000);
      const tabs = await tabsNow();
      if (!tabs.length) break;
      why = 'no-capture';
      for (const t of tabs) {
        let got = null;
        try {
          const [{ result } = {}] = await globalThis.chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', func: pageFeedService, args: [{ caseId }] });
          got = result || null;
        } catch (e) { got = null; }
        if (got && got.ok) {
          const posts = postsFromService(got.values).filter((p) => !p.parentId || id15(p.parentId) === id15(caseId) || !/^500/.test(p.parentId));
          trace.service = `feed service: ${posts.length} items, ${posts.reduce((n, p) => n + p.replies.length, 0)} replies, ${got.pages} page${got.pages === 1 ? '' : 's'} (${got.descriptor})`;
          return { ok: true, posts };
        }
        if (got && got.why && got.why !== 'no-capture') why = got.why;
      }
      if (why !== 'no-capture') break;
    }
    // Tabs opened before this version was loaded have no listener yet: given it now, for the next feed they load.
    for (const t of await tabsNow()) {
      try { await globalThis.chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', files: ['salesforce/sf-feed-capture.js'] }); } catch (e) { /* not ours to reach */ }
    }
    trace.service = why === 'no-capture'
      ? 'feed service: not learned yet (Salesforce has not loaded a case Feed in an open tab since this version started; open any case on its Feed tab once)'
      : `feed service: ${why}`;
    return { ok: false, why: trace.service };
  }

  // Rich text as plain text, with its paragraphs. Pure.
  function htmlToText(html) {
    const s = String(html ?? '');
    if (!/[<&]/.test(s)) return s.trim();
    return s
      .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, words) => {
        const w = words.replace(/<[^>]+>/g, '').trim();
        return w && w !== href && !w.includes(href) ? `${w} (${href})` : (w || href);
      })
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // The posts' records, by Id, in batches. A query a user may not run in full is tried again with fewer fields: what
  // the record cannot give, the page already has. Returns a Map of Id → node, or null when not one query could run.
  const FIELD_SETS = [
    'Id ParentId { value } Type { value } Body { value } CreatedDate { value } CreatedBy { Name { value } }',
    'Id ParentId { value } Type { value } Body { value } CreatedDate { value }',
    'Id ParentId { value } Body { value }',
    'Id ParentId { value }',
    // Without ParentId, for a user who may not read it: the text still comes from the record, and whose post it is
    // is then told by the page (the case's own tab, the reader tab).
    'Id Type { value } Body { value } CreatedDate { value }',
    'Id Body { value }',
  ];
  async function records(ids, trace) {
    const found = new Map();
    let anyRan = false;
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      const part = ids.slice(i, i + ID_BATCH);
      for (const fields of FIELD_SETS) {
        const text = `query q { uiapi { query { FeedItem(where: { Id: { in: ${JSON.stringify(part)} } }, first: ${part.length}) { edges { node { ${fields} } } } } } }`;
        const reply = await globalThis.SfGraphql.run({ feed: { text } });
        const edges = reply?.results?.feed?.uiapi?.query?.FeedItem?.edges;
        if (!edges) { if (trace) trace.graphql.push(`no answer to "${fields.replace(/ \{ value \}/g, '').replace(/ \{ Name \}/g, '')}"`); continue; }
        anyRan = true;
        if (trace) trace.graphql.push(`answered ${edges.length} of ${part.length} with "${fields.replace(/ \{ value \}/g, '').replace(/ \{ Name \}/g, '')}"`);
        for (const { node } of edges) if (node?.Id) found.set(id15(node.Id), node);
        break;
      }
    }
    return anyRan ? found : null;
  }

  // The posts of this case from what the pages drew, confirmed by their records. A post is this case's when its record
  // says so (ParentId), or, if no record says either way, when it was drawn by a page that shows this case alone: the
  // reader tab opened for it, or the case's own tab where the post is on screen (a console's other case tabs are
  // drawn too, but hidden). A record that names another case always wins.
  async function confirm(caseId, drawn, trace) {
    const byId = new Map();
    for (const { posts, trusted, own } of drawn) {
      for (const p of posts) {
        const sure = trusted || (own && p.visible);
        const held = byId.get(id15(p.id));
        // The drawing with more replies wins: the reader tab opens "more comments", a glance at a tab does not.
        if (!held || p.replies.length > held.post.replies.length) byId.set(id15(p.id), { post: p, sure: sure || !!held?.sure });
        else if (sure) held.sure = true;
      }
    }
    const ids = [...byId.values()].map((x) => x.post.id).slice(0, MAX_POSTS);
    if (!ids.length) return { posts: [], verified: false };
    const recs = await records(ids, trace);
    const out = [];
    let otherCase = 0, unknown = 0, skipped = 0;
    for (const { post, sure } of byId.values()) {
      const rec = recs ? recs.get(id15(post.id)) : null;
      const parent = rec ? value(rec.ParentId) : '';
      // Only another CASE's post is someone else's. A post shared onto this case, or made on a related record, is
      // filed under that record, not the case, and Salesforce still shows it in this case's feed.
      const mine = !!parent && id15(parent) === id15(caseId);
      if (parent && !mine && /^500/.test(parent)) { otherCase++; continue; } // another case's feed
      if (!mine && !sure) { unknown++; continue; } // cannot say whose it is
      const type = value(rec?.Type) || post.type;
      if (SKIP_TYPES.test(type)) { skipped++; continue; }
      out.push({
        id: post.id,
        type,
        internal: post.internal,
        // The page's name carries the team ("Viktor Samsonov (Tech Solutions)"); the record's is the fallback.
        author: (post.author && (!value(rec?.CreatedBy?.Name) || post.author.includes(value(rec?.CreatedBy?.Name))) ? post.author : value(rec?.CreatedBy?.Name)) || 'Unknown',
        at: value(rec?.CreatedDate) || post.at || '',
        audience: post.audience || '',
        timeLabel: post.timeLabel,
        body: htmlToText(value(rec?.Body)) || post.body,
        replies: post.replies,
        confirmed: mine,
      });
    }
    if (trace) trace.kept = `${out.length} kept, ${otherCase} another case's, ${unknown} of unknown case, ${skipped} emails/calls/changes skipped`;
    return { posts: out, verified: !!recs };
  }

  // Every open Lightning tab, as it is: no click, no scroll. `own` marks the tabs showing this case.
  async function lookAtTabs(short, trace, label, onlyOwn = false) {
    const out = [];
    try {
      const tabs = await globalThis.chrome.tabs.query({ url: PAGE_PATTERNS, discarded: false });
      for (const t of tabs) {
        if (reader_owned(t)) continue; // the panel's own reader tab is read on its own
        if (onlyOwn && !String(t.url || '').includes(short)) continue;
        const got = await inTab(t.id, pageCollect);
        const own = String(t.url || '').includes(short);
        if (trace && (own || got?.posts?.length)) trace.tabs.push(`${label}: ${own ? "the case's tab" : 'another tab'}: ${got ? `${got.posts.length} post${got.posts.length === 1 ? '' : 's'} drawn (${got.posts.filter((p) => p.visible).length} on screen), Feed tab ${got.feedTab}` : 'could not be read'}`);
        if (got && got.posts.length) out.push({ posts: got.posts, trusted: false, own });
      }
    } catch (e) { if (trace) trace.tabs.push(`${label}: tabs could not be listed`); }
    return out;
  }
  let reader_owned = () => false;

  /* Never throws. { ok, complete, posts, where, verified, why, trace }. Nothing in any tab is clicked or scrolled, and
   * no window or tab is opened. `reader.owns` names the panel's own background tabs, which are never read. */
  async function read(caseId, { reader = null, onStep = null } = {}) {
    const short = id15(caseId);
    const trace = { tabs: [], service: '', graphql: [], kept: '' };
    if (reader && reader.owns) reader_owned = reader.owns;
    onStep?.('Reading internal notes and posts…');
    let ownOpen = false;
    try { ownOpen = (await globalThis.chrome.tabs.query({ url: PAGE_PATTERNS, discarded: false })).some((t) => String(t.url || '').includes(short) && !reader_owned(t)); } catch (e) { ownOpen = false; }
    // 1. The whole feed from Salesforce's feed service, as data (no page is drawn, scrolled or clicked).
    const service = await fromService(caseId, trace, ownOpen);
    // 2. Posts already drawn on screen, as they are: any Id the service did not give (no click, no scroll).
    const drawn = await lookAtTabs(short, trace, 'on screen');
    if (service.ok) drawn.unshift({ posts: service.posts, trusted: true, own: true });
    // 3. GraphQL reads each post by its Id: this case's or not, and its text.
    const confirmed = await confirm(caseId, drawn, trace);
    const ok = service.ok || confirmed.posts.length > 0;
    const posts = confirmed.posts.sort((a, b) => (Date.parse(b.at) || fromLabel(b.timeLabel) || 0) - (Date.parse(a.at) || fromLabel(a.timeLabel) || 0));
    const summary = [trace.service, trace.tabs.join('; '), trace.graphql.length ? `GraphQL check: ${trace.graphql.join('; ')}` : 'GraphQL check: nothing to check', trace.kept].filter(Boolean).join(' | ');
    try { console.info('[SfFeed] ' + summary); } catch (e) { /* no console */ }
    return {
      ok,
      complete: service.ok,
      posts,
      where: service.ok ? 'service' : posts.length ? 'tab' : 'none',
      verified: confirmed.verified,
      why: ok ? '' : service.why,
      trace: summary,
    };
  }

  /* ------------------------------------------------------------------ for the chain ---------------------------- */

  // "25 September 2026 at 09:31", as the feed labels a post, when its record gave no date.
  // Relative ones too ("4h ago", "Yesterday at 10:05 AM", "Just now"), counted back from now.
  const fromLabel = (label) => {
    const s = String(label || '').trim();
    const rel = /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)\s+ago$/i.exec(s);
    if (rel) {
      const n = Number(rel[1]); const u = rel[2][0].toLowerCase();
      const ms = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[u] || 0;
      return Date.now() - n * ms;
    }
    if (/^just now$/i.test(s)) return Date.now();
    const day = /^(today|yesterday)\b(?:\s+at)?\s*(.*)$/i.exec(s);
    if (day) {
      const d = new Date(); if (/yesterday/i.test(day[1])) d.setDate(d.getDate() - 1);
      const t = Date.parse(`${d.toDateString()} ${day[2] || '00:00'}`);
      return Number.isNaN(t) ? d.getTime() : t;
    }
    return Date.parse(s.replace(/\bat\b/i, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim());
  };
  function chainTime(iso, label) {
    let t = Date.parse(iso || '');
    if (Number.isNaN(t)) t = fromLabel(label);
    if (Number.isNaN(t)) return String(label || '').trim();
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // The posts as chain items, in the shape the page reading wrote them before GraphQL: "[time] [INTERNAL] Name:" and
  // the replies indented under it as "↳ [time] [REPLY] Name:". Pure.
  function toChainItems(posts) {
    const name = (s) => String(s ?? '').replace(/[:\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Unknown';
    return (posts || []).map((p) => {
      const replies = (p.replies || []).map((r) => `    ↳ [${chainTime(r.at, r.timeLabel)}] [REPLY] ${name(r.author)}:\n${String(r.body).split('\n').map((l) => '      ' + l).join('\n')}`);
      const own = String(p.body || '').replace(/\r\n/g, '\n').trim();
      const body = [own, replies.join('\n\n')].filter(Boolean).join('\n\n');
      // [INTERNAL] for a note only SOTI sees; [POST] for a Chatter post everyone with access sees, which may include
      // the customer. Neither is an email, and the tag stops either from reading like one.
      return { at: Date.parse(p.at) || fromLabel(p.timeLabel) || 0, head: `[${chainTime(p.at, p.timeLabel)}] ${p.internal ? '[INTERNAL]' : '[POST]'} ${name(p.author)}:`, body };
    });
  }

  return { read, pageCollect, pageOpenFeed, pageFeedService, postsFromService, htmlToText, toChainItems, chainTime };
})();
