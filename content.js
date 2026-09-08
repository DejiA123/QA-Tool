/* ============================================================================
 * SOTI AI Analyser — Salesforce Content Script
 * ============================================================================
 * A "content script" is JavaScript that Chrome injects INTO another web page —
 * here, Salesforce (see manifest.json "content_scripts"). Its job: read the open
 * case's fields off the Salesforce page and send them to our side panel, so the
 * engineer doesn't have to retype the case number, product, version, etc.
 *
 * Why scrape the page instead of using the Salesforce API? The API needs OAuth,
 * admin setup, and credentials; scraping the already-open page needs none of that.
 * The trade-off: if Salesforce changes its HTML, the selectors below may need
 * updating. (Full rationale in PROJECT_OVERVIEW.md §5.8.)
 *
 * The tricky parts, and the helpers that handle them:
 *   • Salesforce hides fields inside "Shadow DOM" (isolated DOM sub-trees) →
 *     findInShadows() / findElementByIdInShadows() walk into those sub-trees.
 *   • Background tabs are moved off-screen, not removed → isVisible() filters them.
 *   • Field text is jammed together with button labels
 *     (e.g. "Acme CorpOpen Preview Edit") → cleanFieldValue() strips the noise.
 *   • scrapeSalesforce() ties it together; the onMessage listener at the bottom
 *     responds when the side panel asks for a scrape.
 * ============================================================================ */
// SOTI AI Analyser - Salesforce Content Script (v2)
console.log('SOTI AI Analyser: Salesforce Content Script Loaded');

function cleanFieldValue(raw) {
    if (!raw) return '';
    
    // Salesforce often jams everything together: "CompanyNameOpen CompanyName PreviewEdit Account Name"
    // We want the text BEFORE the first action word.
    let clean = raw.trim();
    
    // Split by any of the known Salesforce "button" words
    const actionWords = ['Open', 'Preview', 'Edit', 'Close', 'Show Actions'];
    for (const word of actionWords) {
        if (clean.includes(word)) {
            const parts = clean.split(word);
            if (parts[0].trim().length > 0) {
                clean = parts[0].trim();
                break; // Found the split point
            }
        }
    }

    // Secondary cleanup for common label noise
    return clean
        .replace(/(Account Name|Contact Name|Case Number|Subject|Case Owner|Account|Contact)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

// Helper to check if an element is actually visible to the user
function isVisible(el) {
    if (!el) return false;
    
    // Basic CSS checks
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    
    // Salesforce-specific hidden classes
    if (el.classList.contains('slds-hide') || el.classList.contains('slds-is-collapsed')) return false;
    
    // Check for aria-hidden
    if (el.getAttribute('aria-hidden') === 'true') return false;

    // Check positioning (Salesforce often moves background tabs off-screen)
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.left < -500 || rect.top < -500) return false;

    return true;
}

// Helper to find elements across Shadow DOM boundaries
function findInShadows(selector, root = document, onlyVisible = false) {
    let results = Array.from(root.querySelectorAll(selector));
    if (onlyVisible) results = results.filter(isVisible);

    const walkers = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    
    let node = walkers.nextNode();
    while (node) {
        if (node.shadowRoot) {
            results.push(...findInShadows(selector, node.shadowRoot, onlyVisible));
        }
        node = walkers.nextNode();
    }
    return results;
}

// Recursive search for a specific ID across Shadow DOMs
function findElementByIdInShadows(id, root = document) {
    if (!id) return null;
    let el = root.querySelector(`[id="${id}"]`);
    if (el) return el;
    
    const walkers = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walkers.nextNode();
    while (node) {
        if (node.shadowRoot) {
            el = findElementByIdInShadows(id, node.shadowRoot);
            if (el) return el;
        }
        node = walkers.nextNode();
    }
    return null;
}

// Helper to find the main container for the currently active Salesforce tab/workspace
function getActiveWorkspaceRoot() {
    // 1. Try to find the active tab in the tab bar and follow its 'aria-controls' to the content
    const activeTabs = findInShadows('.oneConsoleTabItem.slds-is-active a, .oneConsoleTabItem.active a, a[aria-selected="true"]', document, false);
    for (const tab of activeTabs) {
        const controlsId = tab.getAttribute('aria-controls');
        const target = findElementByIdInShadows(controlsId);
        if (target) {
            console.log('SOTI AI Analyser: Found active root via aria-controls', target);
            return target;
        }
    }

    // 2. Fallback to scoring if the tab bar mapping fails
    const containers = findInShadows('.oneWorkspaceTabWrapper, .navexWorkspaceCard, .viewport, .oneConsoleTabWrapper, .forceRecordLayout', document, false);
    
    if (containers.length === 0) return document;

    // Score each container based on visibility signals
    const scored = containers.map(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        let score = 0;
        
        if (style.display !== 'none') score += 10;
        if (style.visibility !== 'hidden') score += 10;
        if (parseFloat(style.opacity) > 0.1) score += 10;
        if (el.getAttribute('aria-hidden') !== 'true') score += 15;
        if (!el.classList.contains('slds-hide')) score += 15;
        if (el.classList.contains('slds-is-active') || el.classList.contains('active')) score += 20;

        if (rect.width > 100 && rect.height > 100) score += 20;
        if (rect.left >= -50 && rect.top >= -50 && rect.left < window.innerWidth) score += 50;
        
        return { element: el, score };
    });

    scored.sort((a, b) => b.score - a.score);
    
    if (scored.length > 0 && scored[0].score > 50) {
        return scored[0].element;
    }
    
    return document;
}

/* THE WORKSPACE TAB THAT HOLDS ONE NAMED RECORD — the deterministic version of the
 * heuristic above, for the callers that already know WHICH case they want.
 *
 * getActiveWorkspaceRoot scores containers and picks a winner, which is the best that can
 * be done when nothing has said which case is meant. But the console keeps EVERY open case
 * in the DOM at once — a background workspace tab is hidden, not unmounted, and it keeps
 * all its fields, its sub-tab bar and its feed — so a guess that lands one tab to the left
 * reads a different case's record and answers with perfect confidence. That is exactly what
 * "Add Case → From the Salesforce tab" was doing: with four cases open it added the first
 * one in the tab row rather than the one on screen.
 *
 * The address bar already names the active record (in the console the PATH is the record
 * and `?ws=` is the workspace), so the panel can simply say which id it means, and the
 * console's own tab bar maps that id to its panel: the tab anchor's href carries the record
 * and its aria-controls names the container the record is rendered into. No scoring, no
 * visibility guesswork — the markup states the answer.
 *
 * Returns null when the id is not in a console tab bar at all, which is the ordinary case
 * for a record opened on its own page: the caller falls back to the heuristic and then to
 * the whole document, and both are right there.
 */
function workspaceRootForRecordId(recordId) {
    const id = String(recordId || '').trim();
    if (!/^[A-Za-z0-9]{15,18}$/.test(id)) return null;

    for (const a of findInShadows(`a[href*="${id}"]`, document, false)) {
        // aria-controls may name more than one panel; the first that resolves is the one.
        const controls = (a.getAttribute('aria-controls') || '').trim();
        if (!controls) continue;
        for (const ref of controls.split(/\s+/)) {
            const target = findElementByIdInShadows(ref);
            if (target) {
                console.log(`SOTI AI Analyser: found the workspace root for ${id}`, target);
                return target;
            }
        }
    }
    return null;
}

/* THE ROOT A ONE-CASE READ SHOULD READ FROM, in order of how much it is worth trusting:
 * the tab that names the record asked for, then the tab that looks active, then — only
 * because an empty answer is worse than a wrong one — the whole page. `has` is what tells
 * a root that is merely the wrong SHAPE (a container with no fields under it) from one
 * that is genuinely empty, so a bad guess never becomes an empty case.
 *
 * Returns { root, scope } — scope travels back to the panel so a case read from the wrong
 * place leaves a trace rather than looking like a case that simply had nothing on it.
 */
function rootForRecordRead(recordId, has) {
    const byId = workspaceRootForRecordId(recordId);
    if (byId && (!has || has(byId))) return { root: byId, scope: 'record' };

    /* NOTHING TO DISAMBIGUATE — so do not narrow, and this is deliberate rather than an
     * optimisation. A record on its own page, or in a reader tab the panel opened, IS the
     * whole document: scoping to a scored sub-container there can only LOSE fields that
     * happen to render outside it, in exchange for solving a problem that page does not
     * have. Narrowing is a cost paid where several cases are mounted at once and nowhere
     * else. */
    if (openCaseTabCount() <= 1) return { root: document, scope: 'document' };

    const active = getActiveWorkspaceRoot();
    if (active && active !== document && (!has || has(active))) return { root: active, scope: 'active' };

    return { root: document, scope: 'document' };
}

/* HOW MANY DISTINCT CASE RECORDS THIS PAGE HAS OPEN AT ONCE.
 *
 * Counted off the console's own tab bar — an anchor to a case record that also controls a
 * panel is a tab, not a link in someone's related list — and de-duplicated by record id,
 * because one open case can be named by both a workspace tab and a subtab.
 */
function openCaseTabCount() {
    const ids = new Set();
    for (const a of findInShadows('a[href*="/lightning/r/Case/"]', document, false)) {
        if (!a.getAttribute('aria-controls')) continue;
        const m = (a.getAttribute('href') || '').match(/\/lightning\/r\/Case\/([A-Za-z0-9]{15,18})/);
        if (m) ids.add(m[1]);
    }
    return ids.size;
}

/* ----------------------------------------------------------------------------
 * Feed auto-load — "scroll to the bottom before scraping"
 * ----------------------------------------------------------------------------
 * Salesforce renders only the newest handful of feed posts and lazy-loads older
 * ones as you scroll. A plain scrape therefore captures the TAIL of the email
 * chain and silently misses everything before it. So before scraping we drive
 * the feed's own infinite scroll to the end.
 *
 * Two things make this fiddly:
 *   • The Lightning Console does NOT scroll `window`. The feed sits inside a
 *     nested scroller (.forceChatterScroller, the workspace tab body, ...), so
 *     window.scrollTo() does nothing. We walk up from a real feed item and
 *     scroll every scrollable ancestor we find.
 *   • There is no reliable "end of feed" flag — the "End of Feed" marker is in
 *     the DOM even when more posts can still load. We stop when the post count
 *     stops growing for a few rounds instead, with hard round/time caps so a
 *     slow or enormous case can never hang the sync.
 * -------------------------------------------------------------------------- */

// Set to false to stop the sync expanding collapsed posts (see expandFeedPosts).
const EXPAND_FEED_POSTS = true;

const FEED_ITEM_SELECTOR = 'article.cuf-feedItem, article.cuf-feedElement';

/*
 * REPLIES TO A POST, which are a different element from the post and were being lost.
 *
 * A Chatter comment is its own <article class="cuf-commentItem forceChatterComment">
 * nested INSIDE the feed item it answers. That nesting is why the miss was invisible:
 * the post was found, counted and scraped, so the feed looked fully read — while every
 * reply under it went unscraped. On an internal note that is where the actual answer
 * usually lives ("we are still working on this, we need 2026.1.3 before we can quote"),
 * so the case would sync with the question and without the response.
 *
 * Matched on the class rather than on `article`, because the same comment renders as a
 * plain div in some layouts.
 */
const FEED_COMMENT_SELECTOR = '.cuf-commentItem, .forceChatterComment';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/*
 * Read the replies under one feed item.
 *
 * `readText` is passed in rather than closed over: the caller's version falls back from
 * innerText to textContent, which is what makes a comment readable when the page has it
 * collapsed. A comment nobody expanded is CSS-hidden, and innerText on hidden text is ''.
 *
 * The author, the time and the body each have two shapes, and the second one is not a
 * hypothetical — the sample this was written against carries the timestamp in a title
 * attribute ("13 Aug 2026, 12:58") and a machine-readable one in a nested <time datetime>,
 * and other layouts render only the relative "11 days ago". Absolute beats relative:
 * "11 days ago" is meaningless in a case record read weeks later.
 */
function readFeedComments(item, readText) {
    if (!item || typeof item.querySelectorAll !== 'function') return [];

    const comments = Array.from(item.querySelectorAll(FEED_COMMENT_SELECTOR));
    if (!comments.length) return [];

    const out = [];
    for (const c of comments) {
        // A comment nested inside ANOTHER comment belongs to that one, not to this post.
        // Salesforce does not thread replies today, but querySelectorAll is deep and a
        // future layout that does would otherwise report every reply twice.
        const owner = c.parentElement && c.parentElement.closest
            ? c.parentElement.closest(FEED_COMMENT_SELECTOR)
            : null;
        if (owner && owner !== c) continue;

        const parsed = parseFeedComment(c, readText);
        if (parsed) out.push(parsed);
    }
    return out;
}

/*
 * WHICH POST A REPLY BELONGS TO, when the reply is not inside it.
 *
 * The first version of this read replies with item.querySelectorAll(), which assumes the
 * comment is a DESCENDANT of the feed item. On the layout that prompted the fix it is not:
 * the replies live in a `.cuf-compactFeedBack` block that Salesforce renders as a SIBLING
 * of the post's article, so searching inside the article found nothing and the sync came
 * back exactly as empty as before. Both arrangements exist in the wild — it depends on the
 * Lightning release and whether the feed is compact — so neither may be assumed.
 *
 * Containment first, because it is exact. Failing that, the nearest post ABOVE the reply in
 * document order, which is what the page itself is expressing: a reply renders under the
 * thing it answers.
 */
function ownerFeedItem(comment, feedItems) {
    const inside = comment.closest ? comment.closest(FEED_ITEM_SELECTOR) : null;
    if (inside && feedItems.indexOf(inside) !== -1) return inside;

    // feedItems is in document order, so the last one the comment FOLLOWS is the nearest
    // one above it. Bit 4 is DOCUMENT_POSITION_FOLLOWING, bit 1 is DISCONNECTED — the
    // latter happens across shadow roots, where "nearest above" has no meaning and a guess
    // would attach somebody's reply to an unrelated post.
    let best = null;
    for (const it of feedItems) {
        if (typeof it.compareDocumentPosition !== 'function') continue;
        const pos = it.compareDocumentPosition(comment);
        if (pos & 1) continue;
        if (pos & 4) best = it;
    }
    return best;
}

/*
 * Every reply on the page, grouped by the post it answers. Searched from the scrape root
 * rather than from each item, so it does not matter which of the two layouts is rendered,
 * and it crosses shadow boundaries the way the feed-item search already does.
 */
function collectFeedComments(feedItems, root, readText) {
    const byItem = new Map();
    const stats = { parsed: 0, attached: 0, orphaned: 0 };
    if (!feedItems || !feedItems.length) return { byItem, stats };

    let all = [];
    try {
        all = findInShadows(FEED_COMMENT_SELECTOR, root, false);
    } catch (e) {
        all = [];
    }
    // Belt and braces: if the root search came back empty, still look inside the items.
    // A comment found twice is deduplicated below; a comment never looked for is lost.
    if (!all.length) {
        for (const it of feedItems) {
            try { all = all.concat(Array.from(it.querySelectorAll(FEED_COMMENT_SELECTOR))); } catch (e) {}
        }
    }

    const seen = new Set();
    for (const c of all) {
        if (seen.has(c)) continue;
        seen.add(c);

        // Nested inside another comment → it belongs to that one, not to a post.
        const inner = c.parentElement && c.parentElement.closest
            ? c.parentElement.closest(FEED_COMMENT_SELECTOR)
            : null;
        if (inner && inner !== c) continue;

        const parsed = parseFeedComment(c, readText);
        if (!parsed) continue;
        stats.parsed++;

        const owner = ownerFeedItem(c, feedItems);
        if (!owner) { stats.orphaned++; continue; }
        if (!byItem.has(owner)) byItem.set(owner, []);
        byItem.get(owner).push(parsed);
        stats.attached++;
    }
    return { byItem, stats };
}

/*
 * One comment element → {author, time, body}, or null when there was nothing to read.
 */
function parseFeedComment(c, readText) {
    if (!c || typeof c.querySelector !== 'function') return null;

    {
        // FIRST ONE WITH TEXT IN IT, not first one that matches — they are different here,
        // and the difference cost the author name on the very markup this was written from.
        // Salesforce renders the name block as a <div class="cuf-preamble"> INSIDE a
        // <p class="cuf-commentNameLink">, which is invalid: every HTML parser closes the
        // <p> when the <div> opens, so the class you would reach for first survives as an
        // EMPTY element and the name is now its sibling. A plain querySelector over both
        // finds the empty one, in document order, and reports "Unknown" for a comment
        // whose author is sitting right there.
        const firstText = (selectors) => {
            for (const sel of selectors) {
                for (const el of c.querySelectorAll(sel)) {
                    const t = readText(el);
                    if (t) return t;
                }
            }
            return '';
        };
        const author = firstText([
            '.cuf-commentNameLink .uiOutputText',
            '.cuf-preamble .uiOutputText',
            '.cuf-entityLink .uiOutputText',
            '.cuf-commentNameLink',
            '.cuf-preamble'
        ])
            // Last resort: the avatar's alt text. It is the one place the name appears
            // that is not inside the broken <p>.
            || (c.querySelector('.cuf-smallActorImage img[title], .forceChatterUserPhoto img[title]') || {}).title
            || 'Unknown';

        // Absolute time first, in this order: the human string Salesforce puts in the
        // title, then the ISO datetime, then whatever the element renders (relative).
        const ageEl = c.querySelector('feeds_timestamping-comment-creation, .cuf-commentAge');
        const timeEl = c.querySelector('time[datetime]');
        const time = (ageEl && ageEl.getAttribute('title'))
            || (timeEl && timeEl.getAttribute('datetime'))
            || readText(ageEl)
            || '';

        const body = readText(c.querySelector('.slds-comment__content .feedBodyInner'))
            || readText(c.querySelector('.slds-comment__content'))
            || readText(c.querySelector('.cuf-feedBodyText, .feedBodyInner'));

        // Same floor the posts use. A comment whose body did not come back is worse than
        // absent — "Andries Luten:" with nothing after it reads as an empty reply rather
        // than as a reply this tool failed to read.
        if (!body || body.length < 5) return null;

        return { author, time, body };
    }
}

/*
 * Comment bodies are indented under their post so the shape of the exchange survives into
 * the prompt: the model has to be able to tell "the customer asked" from "we answered",
 * and in a flat transcript the reply reads as a second post from whoever is named next.
 */
function formatFeedComments(comments) {
    return (comments || []).map(c => {
        const head = `    ↳ [${c.time}] [REPLY] ${c.author}:`;
        const body = String(c.body).split('\n').map(l => '      ' + l).join('\n');
        return `${head}\n${body}`;
    }).join('\n\n');
}

/* ===========================================================================
 * WHEN DID ANYTHING LAST HAPPEN ON THIS CASE — and when did WE last touch it?
 * ===========================================================================
 * Two different questions, and the second is the one the queue is worked from:
 * "how many days since I last reached out" is a fact about MY behaviour, and a
 * case where the customer replied an hour ago can still be one I have not
 * written to in three weeks. So the last message and the last message FROM US
 * are found separately and reported separately.
 *
 * Everything here reads whatever the feed has already rendered. It never
 * scrolls: a case feed is newest-first, so the answer to both questions is in
 * the first few posts, and scrolling a case to the end to date its newest post
 * is minutes of work for a field.
 * ========================================================================= */

/* WHAT ORDER DOES THIS BROWSER WRITE DATES IN?
 *
 * Salesforce renders timestamps in the user's own locale, so "07/08/2025" is the 7th of
 * August in one org and the 8th of July in another and the string itself cannot say which.
 * Asking Intl for the order the CURRENT locale uses is the honest way to read it — it is
 * the same setting Salesforce formatted the string with. Falls back to day-first, which is
 * what this org uses (see the note on ageDaysOf in the panel).
 */
function localeDateOrder() {
    try {
        const parts = new Intl.DateTimeFormat().formatToParts(new Date(2000, 0, 2));
        const order = parts.filter(p => p.type === 'day' || p.type === 'month').map(p => p.type);
        if (order[0] === 'month') return 'mdy';
        if (order[0] === 'day') return 'dmy';
    } catch (e) { /* no Intl, or a locale it cannot describe */ }
    return 'dmy';
}

const RELATIVE_UNIT_MS = {
    second: 1000, seconds: 1000, sec: 1000, secs: 1000,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000,
    hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000,
    day: 86400000, days: 86400000,
    week: 604800000, weeks: 604800000,
    month: 2592000000, months: 2592000000,
    year: 31536000000, years: 31536000000
};

/* Turn a rendered Salesforce timestamp into milliseconds.
 *
 * Returns null rather than guessing. A wrong date here becomes "you last reached out 400
 * days ago" on a case you emailed this morning, which is worse than an empty column —
 * every caller treats null as "not known" and says so.
 */
function parseSalesforceDate(raw, now = Date.now()) {
    const t = String(raw || '').replace(/ | /g, ' ').trim();
    if (!t) return null;

    // 1. A machine value. ISO 8601 is unambiguous and is what `<time datetime>` and most
    //    of Lightning's own attributes carry.
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(t)) {
        const ms = Date.parse(t);
        if (Number.isFinite(ms)) return ms;
    }
    // A bare epoch, which some Lightning components put in data- attributes.
    if (/^\d{12,14}$/.test(t)) {
        const ms = parseInt(t, 10);
        if (Number.isFinite(ms)) return ms;
    }

    // 2. Relative — "3 hours ago", "in 2 days", "Just now".
    if (/^just now$/i.test(t) || /^now$/i.test(t)) return now;
    const rel = t.match(/^(?:about\s+)?(\d+)\s*([a-z]+)\s+ago$/i)
             || t.match(/^(\d+)([smhdwy])\s+ago$/i);
    if (rel) {
        const n = parseInt(rel[1], 10);
        const unit = rel[2].toLowerCase();
        const step = RELATIVE_UNIT_MS[unit] || RELATIVE_UNIT_MS[unit + 's'] || {
            s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000
        }[unit];
        if (step) return now - n * step;
    }
    // "Yesterday at 15:04" / "Today at 09:12".
    const rday = t.match(/^(yesterday|today)\b(?:\s*(?:at|,)\s*(\d{1,2}):(\d{2}))?/i);
    if (rday) {
        const d = new Date(now);
        if (/yesterday/i.test(rday[1])) d.setDate(d.getDate() - 1);
        if (rday[2]) d.setHours(parseInt(rday[2], 10), parseInt(rday[3], 10), 0, 0);
        return d.getTime();
    }

    // 3. Numeric, and therefore ambiguous — "24/07/2025, 12:33" or "7/8/2025 1:15 PM".
    const num = t.match(/(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?/i);
    if (num) {
        let [, a, b, c, hh, mm, ss, ampm] = num;
        let year, month, day;
        if (a.length === 4) {                       // 2025-07-24 style, already big-endian
            year = +a; month = +b; day = +c;
        } else {
            year = +c < 100 ? 2000 + +c : +c;
            // A number over 12 can only be a day, whatever the locale says. That check
            // comes first because it is a FACT about this string, where the locale is
            // only ever an assumption about the person reading it.
            if (+a > 12) { day = +a; month = +b; }
            else if (+b > 12) { month = +a; day = +b; }
            else if (localeDateOrder() === 'mdy') { month = +a; day = +b; }
            else { day = +a; month = +b; }
        }
        let hour = hh ? +hh : 0;
        if (ampm) {
            const pm = /p/i.test(ampm);
            if (pm && hour < 12) hour += 12;
            if (!pm && hour === 12) hour = 0;
        }
        const d = new Date(year, month - 1, day, hour, mm ? +mm : 0, ss ? +ss : 0);
        if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    // 4. Anything with a month NAME in it — "24 Jul 2025, 12:33", "Jul 24, 2025".
    if (/[a-z]{3}/i.test(t)) {
        const ms = Date.parse(t);
        if (Number.isFinite(ms)) return ms;
    }
    return null;
}

/* THE TIMESTAMP OF ONE FEED POST.
 *
 * Read in order of how machine-readable each source is: an ISO attribute beats a title
 * attribute beats the words on screen, because the words are the only one of the three
 * that had to be guessed at above.
 */
function feedItemTimestamp(item, now = Date.now()) {
    if (!item) return { ms: null, label: '' };
    const attrEls = item.querySelectorAll('[datetime], [data-timestamp], [data-value], lightning-formatted-date-time, time');
    for (const el of attrEls) {
        for (const attr of ['datetime', 'data-timestamp', 'data-value', 'value']) {
            const v = el.getAttribute && el.getAttribute(attr);
            const ms = v ? parseSalesforceDate(v, now) : null;
            if (ms) return { ms, label: (el.textContent || v || '').trim() };
        }
    }
    // The timestamp anchor Salesforce puts in the post header. Its title is the full date
    // even when its text has been shortened to "3h ago".
    const titled = item.querySelector('.preamble_right [title], .cuf-feedItemTimestamp [title], a[title][href*="feed"]');
    if (titled) {
        const ms = parseSalesforceDate(titled.getAttribute('title'), now);
        if (ms) return { ms, label: (titled.textContent || '').trim() || titled.getAttribute('title') };
    }
    const right = item.querySelector('.preamble_right, .cuf-feedItemTimestamp');
    const text = ((right && (right.innerText || right.textContent)) || '').trim();
    return { ms: parseSalesforceDate(text, now), label: text };
}

/* WHO IS "US"?
 *
 * The signed-in Salesforce user. Read from the global header rather than assumed, because
 * the answer decides which posts count as a reach-out — and a hardcoded name or domain
 * would quietly mark somebody else's emails as mine.
 */
/* THE MENU'S OWN WORDS, NOT A PERSON.
 *
 * The reject list below used to be an EXACT match against three words, and
 * `.profile-link-label` — second in the selector list — is where Salesforce puts the label
 * of the "View profile" link in the user menu. "View profile" is not exactly "profile", so
 * it was returned as the signed-in user's name. Two things went wrong with that and only
 * the first was visible: the usage dashboard labelled the install "View profile", and
 * nameIsOurs then compared every feed author against a string no author can ever equal — so
 * on a case somebody else owns, a post WE wrote stopped counting as ours and the reach-out
 * date fell back to the case owner alone.
 *
 * Tested against the whole string, after the same whitespace squash the names get. Anything
 * carrying the bare word "profile" is chrome: no display name does, and being wrong here
 * costs an empty name — the caller's existing "not known" path — rather than a confident
 * wrong one, which is the failure that hid for this long.
 */
const SF_CHROME_LABELS = new Set([
    'open', 'menu', 'options', 'settings', 'home', 'help', 'search', 'user', 'avatar',
    'log out', 'logout', 'sign out', 'switch to lightning experience', 'view account'
]);
function isChromeLabel(name) {
    const n = String(name || '').toLowerCase();
    return /\bprofile\b/.test(n) || SF_CHROME_LABELS.has(n);
}

function salesforceCurrentUser() {
    const sels = [
        '.branding-userProfile-button', '.profile-link-label', '#userNavLabel',
        '.slds-global-actions__avatar', 'button.branding-userProfile-button',
        '[data-aura-class="forceHeaderButton"] .uiImage',
        // The profile card Lightning renders behind the avatar. It is in the DOM before the
        // menu is ever opened, and on a record page opened cold in a background window it is
        // often the only one of these that has a name in it yet.
        '.profile-card-name', '.oneUserProfileCardTrigger img', '.forceUserProfileCard .fullName',
        'button[title$="User"] img[title]', '.slds-global-header__item img[title]'
    ];
    for (const sel of sels) {
        for (const el of findInShadows(sel, document, false)) {
            const v = (el.getAttribute && (el.getAttribute('title') || el.getAttribute('alt')))
                   || (el.textContent || '');
            const name = String(v).replace(/\s+/g, ' ').replace(/^user\b/i, '').trim();
            if (name && name.length > 1 && name.length < 60 && !isChromeLabel(name)) {
                return name;
            }
        }
    }
    return '';
}

// Phrases the case feed uses for a post that LEFT the building. Salesforce writes the
// preamble as a sentence ("Deji Augustine sent an email to …"), so the direction is
// stated outright on the item that has one.
const FEED_OUTBOUND_RE = /\b(sent an email to|emailed|sent to|replied to|outbound)\b/i;
/* "from:" IS NOT ON THIS LIST ANY MORE. It was, and here is what that cost.
 *
 * Every email in the feed renders a From line — the ones we send as much as the ones we
 * receive — so "contains from:" is not evidence of direction, it is evidence that the post
 * is an email. It never even got to be wrong in that way, though, because `\bfrom:\b` cannot
 * match `From: Deji`: a word boundary after a colon needs a word character next to it, and
 * Salesforce writes a space. So the test the reader was relying on silently never fired.
 *
 * What it fell through to was worse than a wrong word list. The address pattern above it
 * could not read `From: Deji Augustine <deji.augustine@soti.net>` — the shape this org
 * renders, with the display name between the colon and the address, where the pattern
 * demanded the "@" in the very first token — so the last rule standing was "is our name in
 * the first 200 characters". Our name is in the To: line of every email the customer sends
 * us. The column headed "days since I last reached out" was therefore printing days since
 * the CUSTOMER last wrote, on exactly the cases where the two differ, and printing nothing
 * at all on the rest.
 *
 * The address is read properly now (emailHeaderAddress). This list is only for words that
 * appear on a post somebody RECEIVED, and it is consulted last. */
const FEED_INBOUND_RE = /\b(email from|received an email|inbound)\b/i;

// Any email address, anywhere in a line. Deliberately permissive on the local part (Salesforce
// renders plenty of first.last+tag@ addresses) and strict about the domain ending in letters,
// so a trailing full stop or angle bracket is not eaten into the domain.
const EMAIL_RE = /[A-Za-z0-9._%+'\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

// Where one header ends: at the next one. Used to cut the captured run short, so a post
// whose headers all landed on ONE line reads exactly the same as one with a line each.
const NEXT_HEADER_RE = /\b(?:from|to|cc|bcc|sent|subject|date|reply-to)\s*:/i;

/* ONE HEADER OFF A RENDERED EMAIL — "From", "To", "Cc".
 *
 * The FIRST one only. A reply carries the whole conversation quoted underneath it, so a case
 * that has been going a fortnight has a dozen From lines in one post and only the top one
 * belongs to the post itself.
 *
 * NOT anchored to the start of a line, and that is deliberate. This reads `innerText` where
 * it can and falls back to `textContent` where the post is hidden — and textContent has no
 * line breaks in it at all, so a line-anchored pattern found the headers on the posts that
 * were open and none of the headers on the posts that were collapsed. Instead the run is
 * taken from the keyword to the NEXT header keyword, which gives the same answer whether the
 * breaks survived or not.
 */
function emailHeaderLine(text, name) {
    const re = new RegExp('(?:^|[\\s>;,])' + name + '\\s*:\\s*([^\\n]*)', 'i');
    const m = re.exec(String(text || ''));
    if (!m) return '';
    let run = m[1];
    const next = NEXT_HEADER_RE.exec(run);
    if (next) run = run.slice(0, next.index);
    return run.trim();
}

// The address on such a header, lowercased. '' when it names a person and no address —
// which Salesforce does render, and which the NAME half below is there to answer.
function emailHeaderAddress(text, name) {
    const m = EMAIL_RE.exec(emailHeaderLine(text, name));
    return m ? m[0].toLowerCase() : '';
}

// …and the person's name off the same header, with the address and its brackets taken off.
// Capped, because on a run-together post the "line" can be most of the email: a name is two
// or three words, and anything longer is prose that would match everybody.
function emailHeaderName(text, name) {
    const v = emailHeaderLine(text, name)
        .replace(new RegExp(EMAIL_RE.source, 'g'), ' ')
        .replace(/[<>"']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return v.length > 80 ? '' : v;
}

function domainOfAddress(addr) {
    const at = String(addr || '').lastIndexOf('@');
    return at < 0 ? '' : String(addr).slice(at + 1).toLowerCase();
}

/* WHICH EMAIL DOMAINS ARE OURS.
 *
 * SOTI's own, because that is the org this is built for — but never ONLY those. The rest is
 * learned from the feed in readFeedActivity: a post whose author is the signed-in user or
 * the case owner, carrying a From address, has just said what our domain is in this org.
 * Without that, an org on its own domain would classify every one of its own emails as the
 * customer's.
 */
function ourEmailDomains(extra) {
    const out = ['soti.net', 'soti.com', 'soti.co.uk'];
    const d = String(extra || '').toLowerCase().replace(/^@/, '').trim();
    if (d && !out.includes(d)) out.unshift(d);
    return out;
}

/* IS THIS DOMAIN OURS?
 *
 * Sub-domains count — mail.soti.net is soti.net — but a suffix test alone would also make
 * "notsoti.net" ours, so the boundary is checked rather than assumed.
 *
 * A ctx with no domain list on it falls back to the built-in ones rather than answering
 * "no". Answering "no" is not the safe default it looks like: it means our own outbound mail
 * is filed as the customer's, which is the exact wrong answer this whole file exists to stop
 * printing — and it would be given by any caller that had not been through readFeedActivity.
 */
function domainIsOurs(domain, ctx) {
    const d = String(domain || '').toLowerCase();
    if (!d) return false;
    const ours = (ctx && ctx.domains && ctx.domains.length) ? ctx.domains : ourEmailDomains(ctx && ctx.domain);
    for (const own of ours) {
        if (d === own || d.endsWith('.' + own)) return true;
    }
    return false;
}

/* DOES THIS BLOCK OF TEXT NAME THIS PERSON?
 *
 * A different question from samePersonName, which compares two NAMES. This one looks for a
 * name inside prose — the preamble of a post that carries no email headers at all — so
 * containment is the whole test, and the only guard needed is that it lands on a word
 * boundary: an owner alias of "pet" must not match "Peter", and "Ann" must not match
 * "Announcement".
 */
function textNamesPerson(text, name) {
    const norm = (s) => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    const n = norm(name);
    if (n.trim().length < 3) return false;
    return norm(text).includes(n);
}

/* ARE THESE TWO STRINGS THE SAME PERSON?
 *
 * Compared on letters only, so "Deji Augustine (SOTI)", "AUGUSTINE, Deji" and
 * "Deji  Augustine" are one person. Containment counts in one direction only — a feed
 * preamble writes the fuller form — and a single word is never enough on its own: "Peter"
 * matching every Peter in the org is exactly the sort of confident wrong answer this
 * column must not print.
 */
function samePersonName(a, b) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const xs = x.split(' ').filter(w => w.length > 1);
    const ys = y.split(' ').filter(w => w.length > 1);
    if (xs.length < 2 || ys.length < 2) return false;
    // Every word of the shorter name appears in the longer one — which is what "Deji
    // Augustine" and "Deji Augustine (SOTI)" have in common, and what "Deji Augustine" and
    // "Praveen Kumar" do not.
    const [small, big] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
    return small.every(w => big.includes(w));
}

// Us, by name: the signed-in Salesforce user or the case owner.
function nameIsOurs(name, ctx) {
    if (!name) return false;
    return samePersonName(name, (ctx && ctx.user) || '') || samePersonName(name, (ctx && ctx.owner) || '');
}

/* IS THIS POST A REACH-OUT FROM US?
 *
 * Signals in order of how much they actually KNOW, and `null` means "cannot tell" — the
 * caller then keeps looking rather than counting a post it does not understand.
 *
 *   1. The From address, read properly. An address either is on one of our domains or is not.
 *   2. The From NAME, when the header carries no address.
 *   3. The preamble saying it in words.
 *   4. The To address — a post with no readable sender was still addressed to somebody,
 *      and "was it addressed to us" answers the same question from the other end.
 *   5. Who posted it: the signed-in user, or the case owner.
 *   6. Inbound phrasing.
 *   7. Nothing — not classified.
 *
 * An INTERNAL note is never a reach-out however it scores, and is filtered out before this
 * is called: writing a note to yourself is not contacting the customer, and counting it
 * would report a case as chased when nobody outside SOTI has heard anything.
 */
function feedItemIsFromUs(text, ctx, sender) {
    const t = String(text || '');

    // 1 — the From address.
    const fromAddr = emailHeaderAddress(t, 'from');
    if (fromAddr) return domainIsOurs(domainOfAddress(fromAddr), ctx);

    // 2 — a From line naming a person and no address.
    const fromName = emailHeaderName(t, 'from');
    if (fromName) {
        if (nameIsOurs(fromName, ctx)) return true;
        if (ctx && ctx.contact && samePersonName(fromName, ctx.contact)) return false;
        // A From we can read and cannot place is NOT evidence of anything; fall through.
    }

    // 3 — the preamble in words.
    if (FEED_OUTBOUND_RE.test(t)) return true;

    /* THE CONTACT WROTE IT — checked before the To line, not after.
     *
     * "Addressed to somebody outside the building" is decent evidence a post went out, and it
     * is exactly wrong on the one shape that produces it by accident: a customer writing in
     * and copying a colleague at their own company. The person on the other side of the case
     * is named on the record, so ask that first and the To line never gets the chance. */
    if (ctx && ctx.contact && samePersonName(sender, ctx.contact)) return false;

    // 4 — who it was addressed to. Our own address in To means we received it; an address
    //     that is not ours means it went out. Cc is not consulted: we are copied on plenty
    //     of mail we did not send.
    const toLine = emailHeaderLine(t, 'to');
    if (toLine) {
        const addrs = toLine.match(new RegExp(EMAIL_RE.source, 'g')) || [];
        if (addrs.length) return !addrs.some(a => domainIsOurs(domainOfAddress(a), ctx));
    }

    // 5 — the author of the post. The name first, then the preamble it sits in: a case owner
    //     is often only an ALIAS ("aaugu"), which never appears as a tidy two-word name.
    if (nameIsOurs(sender, ctx)) return true;
    const head = t.slice(0, 200);
    if (ctx && ctx.user && textNamesPerson(head, ctx.user)) return true;
    if (ctx && ctx.owner && textNamesPerson(head, ctx.owner)) return true;

    // 6 — words that only appear on something received.
    if (FEED_INBOUND_RE.test(t)) return false;
    return null;
}

// The name on a feed post. `.preamble_left` is where the case feed puts it; `.cuf-preamble`
// is where a comment and the newer post markup put it. innerText THEN textContent, the same
// fallback the chain scrape uses: innerText is the RENDERED text and comes back empty for
// anything the page has hidden with CSS — and Salesforce hides plenty. Reading only innerText
// loses the sender's name on exactly the posts that were collapsed.
function feedItemSender(item) {
    for (const sel of ['.preamble_left', '.cuf-preamble', '.cuf-entityLink']) {
        const el = item.querySelector(sel);
        const v = el ? (el.innerText || el.textContent || '') : '';
        const name = String(v).replace(/\s+/g, ' ').trim();
        if (name) return name;
    }
    return '';
}

/* IS THIS POST AN INTERNAL NOTE?
 *
 * Two tests, ORed, because being wrong in one direction is far worse than the other: an
 * internal note counted as a reach-out reports a case as chased when the customer has heard
 * nothing, and that is the one lie this column must never tell. A customer email skipped
 * because the word "internal" was in it costs a date that the post before it will supply.
 */
function feedItemIsInternal(item, text) {
    const pre = item.querySelector('.preamble_custom-preamble');
    if (pre && /\binternal\b/i.test((pre.innerText || pre.textContent || ''))) return true;
    return /\binternal\b/i.test(String(text || '').slice(0, 300));
}

/* ----------------------------------------------------------------------------
 * WHAT IS ATTACHED TO THE EMAILS ON THIS CASE
 * ----------------------------------------------------------------------------
 * The customer sends a log bundle, a screenshot of the error, a config export — and every one
 * of them arrives as a link in the case feed, where the sync could see it and did nothing with
 * it. So the evidence the case turns on sat two clicks away in Salesforce while the AI was
 * told only about whatever the engineer had separately downloaded and dragged in.
 *
 * This reads the LINKS, not the files. Nothing is fetched here: a content script has the
 * page's session and could pull every attachment on a long case in one go, which is a lot of
 * traffic and a lot of memory for files nobody asked for. The panel gets a list, offers it to
 * the engineer, and downloads only what they pick — see the attachment picker after a sync.
 *
 * THREE THINGS SALESFORCE CALLS AN ATTACHMENT, and they render differently:
 *
 *   · a ContentDocument (the modern one) — /sfc/servlet.shepherd/version/download/068…
 *     or /sfc/servlet.shepherd/document/download/069…
 *   · a classic Attachment — /servlet/servlet.FileDownload?file=00P…
 *   · an INLINE IMAGE inside the email body, which is an <img> whose src is one of the above.
 *     Those are the screenshots — "here is what the console shows" — and they are the ones
 *     worth OCR'ing, which is why `kind` distinguishes them rather than lumping everything
 *     together as a file.
 *
 * A name is not guaranteed. Salesforce puts one on the link title on most layouts and on none
 * of them reliably, so a missing name falls back to the file id — which is at least unique and
 * at least tells the engineer the two attachments are different files.
 * -------------------------------------------------------------------------- */
/* EVERY SHAPE A SALESFORCE FILE LINK COMES IN.
 *
 * The old rule was one regular expression over two URL shapes — the shepherd download and the
 * classic FileDownload servlet — and it is why a customer's five log files arrived in the
 * picker as one, and why a screenshot pasted into the body of an email was not offered at all.
 * Neither of those renders as a plain download link on a modern case feed:
 *
 *   · a file CARD links to the record, not the file: /lightning/r/ContentDocument/069…/view
 *   · a file card's thumbnail is a RENDITION: …/version/renditionDownload?…&versionId=068…
 *   · an image pasted INTO the email body is served by the rich-text servlet:
 *     /servlet/rtaImage?eid=…&feoid=Body&refid=0EM… — a shape with no file id in the path at
 *     all, which is exactly the "image in the email body, not an attachment" case
 *   · and some layouts put the id in a data- attribute and give the anchor href="javascript:void(0)"
 *
 * So the id is extracted from whichever of those a URL turns out to be, and every entry is
 * reduced to a CANONICAL download URL — the one shape that actually returns the file's bytes.
 * A thumbnail rendition is 120x90 pixels of a screenshot: OCR'ing one reads nothing, so a
 * rendition is rewritten to the full download of the same version rather than fetched as-is.
 */
const SF_SHEPHERD_PATH_RE = /\/sfc\/servlet\.shepherd\/(version|document)\/download\/([A-Za-z0-9]{15,18})/i;
const SF_RENDITION_RE     = /\/sfc\/servlet\.shepherd\/version\/renditionDownload\b[^"']*?[?&]versionId=([A-Za-z0-9]{15,18})/i;
const SF_CLASSIC_FILE_RE  = /servlet\.FileDownload\?file=([A-Za-z0-9]{15,18})/i;
const SF_RTA_IMAGE_RE     = /\/servlet\/rtaImage\b/i;
const SF_RECORD_DOC_RE    = /\/lightning\/r\/ContentDocument\/([A-Za-z0-9]{15,18})/i;
const SF_CONTENT_DOC_PARAM_RE = /[?&](?:contentDocumentId|ContentDocumentId|documentId)=([A-Za-z0-9]{15,18})/;
// The Salesforce ID prefixes that mean "a file": ContentVersion, ContentDocument, the classic
// Attachment, and the rich-text image record an inline <img> is served from.
const SF_FILE_ID_RE = /\b(068|069|00P|0EM)[A-Za-z0-9]{12,15}\b/;

// Salesforce's own chrome, rendered as images inside the feed: avatars, the coloured
// activity dots, spacer gifs, and the emoji/icon sprites. None of them is case evidence and
// OCR'ing them is pure cost.
const SF_CHROME_IMG_RE = /\/(?:profilephoto|img\/icon|img\/emoji|assets\/images|assets\/icons|s\.gif|spacer|slds\/)/i;

/* What a URL is, as far as this file is concerned: its id, and the URL that returns its
 * bytes. Returns null when the URL is not a Salesforce file at all. */
function sfFileRefFromUrl(url) {
    const raw = String(url || '');
    if (!raw) return null;

    let m = SF_SHEPHERD_PATH_RE.exec(raw);
    if (m) return { id: m[2], url: raw, canonical: true };

    // A thumbnail. Same version id, so the full download is one path away — and the full
    // download is the only version of it worth OCR'ing.
    m = SF_RENDITION_RE.exec(raw);
    if (m) return { id: m[1], url: `/sfc/servlet.shepherd/version/download/${m[1]}`, canonical: true };

    m = SF_CLASSIC_FILE_RE.exec(raw);
    if (m) return { id: m[1], url: raw, canonical: true };

    // The rich-text servlet: an image pasted into the body of an email. There is no file id in
    // the path — the refid is the record it hangs off — and the URL itself IS the download, so
    // it is kept exactly as it is. The id only has to be unique enough to de-duplicate with.
    if (SF_RTA_IMAGE_RE.test(raw)) {
        const ref = /[?&]refid=([A-Za-z0-9]{15,18})/.exec(raw);
        const eid = /[?&]eid=([A-Za-z0-9]{15,18})/.exec(raw);
        const id = (ref && ref[1]) || (eid && eid[1]) || raw.slice(-40);
        return { id: `rta:${id}`, url: raw, canonical: true, inline: true };
    }

    // A link to the FILE RECORD rather than to the file. The download for a ContentDocument is
    // a fixed path off its id, so the card's own link is enough to fetch by.
    m = SF_RECORD_DOC_RE.exec(raw) || SF_CONTENT_DOC_PARAM_RE.exec(raw);
    if (m) return { id: m[1], url: `/sfc/servlet.shepherd/document/download/${m[1]}`, canonical: true };

    return null;
}

// Kept for callers elsewhere in this file and for anything that only wants the id.
function sfFileIdFromUrl(url) {
    const ref = sfFileRefFromUrl(url);
    return ref ? ref.id : '';
}

/* An id sitting in a data- attribute, on a layout whose anchor has no usable href. */
const SF_ID_ATTRS = ['data-fileid', 'data-file-id', 'data-recordid', 'data-record-id',
                     'data-attachmentid', 'data-contentdocumentid', 'data-versionid', 'data-id'];
function sfFileRefFromAttrs(el) {
    if (!el || !el.getAttribute) return null;
    for (const attr of SF_ID_ATTRS) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const m = SF_FILE_ID_RE.exec(v);
        if (!m) continue;
        const id = m[0];
        const url = /^069/.test(id)
            ? `/sfc/servlet.shepherd/document/download/${id}`
            : /^068/.test(id)
                ? `/sfc/servlet.shepherd/version/download/${id}`
                : `/servlet/servlet.FileDownload?file=${id}`;
        return { id, url, canonical: true };
    }
    return null;
}

function feedAttachmentName(el, fallbackId) {
    const pick = (a) => (a && a.getAttribute && (a.getAttribute('title') || a.getAttribute('alt')
        || a.getAttribute('aria-label') || a.getAttribute('data-filename')
        || a.getAttribute('download'))) || '';
    let n = (pick(el) || (el.textContent || '')).replace(/\s+/g, ' ').trim();
    // The link text on a file card is often the name plus its size and type — "MS.log 2.4 MB
    // Download" — and the trailing words are chrome rather than part of the name.
    n = n.replace(/\s*(?:download|preview|open|view)\s*$/i, '').trim();
    n = n.replace(/\s*[·|-]?\s*\d+(?:\.\d+)?\s*(?:B|KB|MB|GB)\s*$/i, '').trim();
    // "Preview MS.log" / "Download MS.log" — the verb Salesforce puts in an aria-label.
    n = n.replace(/^(?:download|preview|open|view|file)\s+/i, '').trim();
    if (!n || n.length > 120) n = '';
    return n || (fallbackId ? `Salesforce file ${fallbackId}` : 'Attachment');
}

/* An <img> that is worth reading. Salesforce chrome and anything the size of a signature logo
 * or a tracking pixel are not — but an image whose dimensions are not known yet (it has not
 * finished loading, or it is off screen) IS, because refusing one for having no size is how a
 * screenshot below the fold gets silently dropped. */
function feedImageIsEvidence(img) {
    const src = img.getAttribute('src') || '';
    if (!src || SF_CHROME_IMG_RE.test(src)) return false;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w && h && (w < 80 || h < 80)) return false;
    // An emoji or a rendered signature sits in a class Salesforce names for what it is.
    if (/\b(?:emoji|avatar|profile|logo|icon)\b/i.test(img.className || '')) return false;
    return true;
}

/* EVERY ELEMENT INSIDE ONE FEED ITEM, INCLUDING THE ONES INSIDE SHADOW ROOTS — queryDeep(),
 * defined further down this file beside the field readers that share it.
 *
 * `item.querySelectorAll` stops at the first shadow boundary, and a Lightning case feed is
 * full of them: the file cards on an email are rendered by components that keep their markup
 * inside their own roots. That is the other half of "five attachments arrived as one" — the
 * plain query handed back whichever card happened to sit in the light DOM and never saw the
 * rest. Everything below queries deep for that reason.
 */

// The extensions that settle it: whatever a thumbnail says, this file is not a picture.
const NON_IMAGE_NAME_RE = /\.(?:log|txt|zip|7z|rar|gz|tgz|csv|xml|json|pdf|docx?|xlsx?|pptx?|cab|msi|evtx|dmp|har|cfg|conf|ini|reg|sql|xlsm)$/i;

function readFeedAttachments(root, opts = {}) {
    const { limit = 120 } = opts;
    const out = [];
    // Keyed on the FILE, not on the URL. The same file reaches this function two and three
    // times over — as a card link, as a thumbnail rendition, as a record link — and keying on
    // the URL filed those as different files, while a layout that gave two different files the
    // same-looking wrapper could still collapse them. The id is the file.
    const byId = new Map();

    let items = findInShadows(FEED_ITEM_SELECTOR, root || document, false);
    if (!items.length && root !== document) items = findInShadows(FEED_ITEM_SELECTOR, document, false);

    const add = (rec) => {
        if (!rec || !rec.id || !rec.url) return;
        const prev = byId.get(rec.id);
        if (!prev) {
            if (byId.size >= limit) return;
            byId.set(rec.id, rec);
            out.push(rec);
            return;
        }
        /* THE SAME FILE, SEEN AGAIN, BETTER. A thumbnail carries no name; the card link
         * carries the name but sometimes no size; the <img> is what tells us the thing is a
         * picture. Merge rather than discard, so one file ends up with the best of each. */
        // A thumbnail RENDITION exists for files that are not pictures — Salesforce renders one
        // for a PDF and for anything it can preview — so "an <img> pointed at this id" is not
        // proof the file is an image. A name that ends in a log/archive/document extension is.
        if (rec.kind === 'image' && !NON_IMAGE_NAME_RE.test(prev.name || '')) prev.kind = 'image';
        if (prev.name && /^(?:Salesforce file |Attachment$|Inline image)/i.test(prev.name)
            && rec.name && !/^(?:Salesforce file |Attachment$|Inline image)/i.test(rec.name)) {
            prev.name = rec.name;
        }
        if (!prev.whenMs && rec.whenMs) { prev.whenMs = rec.whenMs; prev.whenLabel = rec.whenLabel; }
        if (!prev.from && rec.from) prev.from = rec.from;
    };

    let inlineSeq = 0;

    const readItem = (item, meta) => {
        const { whenMs, whenLabel, from } = meta;

        // 1. LINKS — anchors, and anything else carrying an href.
        for (const a of queryDeep(item, 'a[href], area[href], [data-href]')) {
            const href = a.getAttribute('href') || a.getAttribute('data-href') || '';
            const ref = sfFileRefFromUrl(href) || sfFileRefFromAttrs(a);
            if (!ref) continue;
            let url = ref.url;
            try { url = new URL(ref.url, location.origin).href; } catch (e) { continue; }
            add({ id: ref.id, url, name: feedAttachmentName(a, ref.id),
                  kind: ref.inline ? 'image' : 'file', whenMs, whenLabel, from });
        }

        // 2. ELEMENTS THAT CARRY THE ID IN AN ATTRIBUTE and link to nothing — the file cards
        //    on the layouts where the anchor is a click handler rather than a URL.
        for (const el of queryDeep(item, '[data-fileid],[data-file-id],[data-recordid],[data-record-id],[data-attachmentid],[data-contentdocumentid],[data-versionid]')) {
            const ref = sfFileRefFromAttrs(el);
            if (!ref) continue;
            let url = ref.url;
            try { url = new URL(ref.url, location.origin).href; } catch (e) { continue; }
            add({ id: ref.id, url, name: feedAttachmentName(el, ref.id), kind: 'file', whenMs, whenLabel, from });
        }

        // 3. IMAGES — the screenshots. Both the ones attached as files and, which is the whole
        //    point of the rtaImage shape, the ones pasted straight into the body of the email.
        for (const img of queryDeep(item, 'img[src]')) {
            const src = img.getAttribute('src') || '';
            if (!feedImageIsEvidence(img)) continue;

            // An image the email carries INLINE as base64 needs no download at all — the bytes
            // are already here. Handed over as the data: URL itself.
            if (/^data:image\//i.test(src)) {
                inlineSeq++;
                add({ id: `data:${from || 'feed'}:${src.length}:${src.slice(24, 64)}`, url: src,
                      name: feedAttachmentName(img, '') === 'Attachment'
                          ? `Inline image ${inlineSeq}` : feedAttachmentName(img, ''),
                      kind: 'image', whenMs, whenLabel, from });
                continue;
            }

            const ref = sfFileRefFromUrl(src) || sfFileRefFromAttrs(img);
            if (!ref) continue;
            let url = ref.url;
            try { url = new URL(ref.url, location.origin).href; } catch (e) { continue; }
            let name = feedAttachmentName(img, '');
            if (!name || name === 'Attachment') { inlineSeq++; name = `Inline image ${inlineSeq}`; }
            add({ id: ref.id, url, name, kind: 'image', whenMs, whenLabel, from });
        }
    };

    for (const item of items) {
        // WHICH EMAIL IT CAME FROM. The picker shows this so the engineer can tell the log
        // the customer sent last week from the one they sent this morning — which is the whole
        // question they are answering when they choose.
        let whenMs = null, whenLabel = '';
        try {
            // { ms, label } — the milliseconds where the date could be parsed, and whatever
            // Salesforce actually printed ("3h ago") either way. The panel prefers the number
            // and falls back to the label, so a date this build cannot parse still reads.
            const t = feedItemTimestamp(item) || {};
            whenMs = t.ms || null;
            whenLabel = t.label || '';
        } catch (e) { /* an undated post is still an attachment worth offering */ }
        let from = '';
        try { from = feedItemSender(item) || ''; } catch (e) { from = ''; }
        try { readItem(item, { whenMs, whenLabel, from }); }
        catch (e) { /* one unreadable post must not cost the other twenty their attachments */ }
    }

    /* THE SWEEP. Everything above is scoped to a feed item, because knowing WHICH email a file
     * came from is most of what makes the picker useful. But a file that renders outside one —
     * the Files related list, an expanded attachment tray, a layout whose email body is not
     * inside article.cuf-feedItem at all — was simply not offered, and "the tool only found one
     * of the five" is what that looks like from the outside. So the page is swept once for
     * anything not already accounted for, and those entries say only that they are on the case.
     */
    try {
        const scope = (root && root.querySelectorAll) ? root : document;
        for (const a of queryDeep(scope, 'a[href]')) {
            const ref = sfFileRefFromUrl(a.getAttribute('href') || '');
            if (!ref || byId.has(ref.id)) continue;
            let url = ref.url;
            try { url = new URL(ref.url, location.origin).href; } catch (e) { continue; }
            add({ id: ref.id, url, name: feedAttachmentName(a, ref.id),
                  kind: ref.inline ? 'image' : 'file', whenMs: null, whenLabel: '', from: '' });
        }
        for (const img of queryDeep(scope, 'img[src]')) {
            if (!feedImageIsEvidence(img)) continue;
            const ref = sfFileRefFromUrl(img.getAttribute('src') || '');
            if (!ref || byId.has(ref.id)) continue;
            let url = ref.url;
            try { url = new URL(ref.url, location.origin).href; } catch (e) { continue; }
            let name = feedAttachmentName(img, '');
            if (!name || name === 'Attachment') { inlineSeq++; name = `Inline image ${inlineSeq}`; }
            add({ id: ref.id, url, name, kind: 'image', whenMs: null, whenLabel: '', from: '' });
        }
    } catch (e) { /* the per-item pass already returned what it found */ }

    return out;
}

/* THE CASE'S ACTIVITY, from whatever the feed has rendered.
 *
 * Returns the newest post's time, and the newest time we can attribute to US — plus how
 * many posts it looked at and WHY the reach-out came back empty when it did, so a caller can
 * tell "nothing was found" from "there was nothing to look at". That last one is not a
 * nicety: an empty column that always says "not read yet" hid a classifier bug for a whole
 * build, because the message for "the sync has not run" and the message for "the sync ran
 * and understood nothing" were the same sentence.
 */
function readFeedActivity(root, opts = {}) {
    const { limit = 40, now = Date.now() } = opts;
    const out = {
        lastMessageAt: null, lastMessageLabel: '', lastMessageFrom: '',
        lastReachOutAt: null, lastReachOutLabel: '', lastReachOutFrom: '',
        itemsRead: 0, user: '', classified: 0, dated: 0, reason: 'no-feed'
    };

    let items = findInShadows(FEED_ITEM_SELECTOR, root || document, false);
    if (!items.length && root && root !== document) items = findInShadows(FEED_ITEM_SELECTOR, document, false);
    if (!items.length) return out;

    const ctx = {
        user: salesforceCurrentUser(),
        owner: opts.owner || '',
        contact: opts.contact || '',
        domains: ourEmailDomains(opts.domain)
    };
    out.user = ctx.user;

    const scope = items.slice(0, limit);

    /* WHAT IS OUR DOMAIN IN THIS ORG? Asked of the feed itself, before anything is
     * classified. A post written by the signed-in user or the case owner that carries a From
     * address has answered it outright, and one pass over text that has to be read anyway is
     * the whole cost. */
    for (const item of scope) {
        const text = (item.innerText || item.textContent || '').trim();
        const addr = emailHeaderAddress(text, 'from');
        if (!addr) continue;
        const who = emailHeaderName(text, 'from') || feedItemSender(item);
        if (!nameIsOurs(who, ctx)) continue;
        const domain = domainOfAddress(addr);
        if (domain && !ctx.domains.includes(domain)) ctx.domains.unshift(domain);
    }

    // Newest-first is how a case feed is ordered, but that is a default an org can change,
    // so this takes the MAXIMUM timestamp rather than the first item it reads. A feed
    // flipped to oldest-first then answers correctly instead of dating the case to its
    // opening post.
    for (const item of scope) {
        out.itemsRead++;
        const { ms, label } = feedItemTimestamp(item, now);
        if (!ms) continue;
        out.dated++;

        const text = (item.innerText || item.textContent || '').trim();
        const sender = feedItemSender(item);

        if (out.lastMessageAt === null || ms > out.lastMessageAt) {
            out.lastMessageAt = ms;
            out.lastMessageLabel = label;
            out.lastMessageFrom = sender;
        }

        // Internal notes are excluded before the direction is even asked: they never leave
        // SOTI, so they cannot be the last time we contacted anybody.
        if (feedItemIsInternal(item, text)) continue;

        const fromUs = feedItemIsFromUs(text, ctx, sender);
        if (fromUs === null) continue;
        out.classified++;
        if (fromUs && (out.lastReachOutAt === null || ms > out.lastReachOutAt)) {
            out.lastReachOutAt = ms;
            out.lastReachOutLabel = label;
            out.lastReachOutFrom = sender || emailHeaderName(text, 'from');
        }
    }

    /* WHY THERE IS NO DATE. Each of these is a different thing to do about it, which is the
     * only reason to tell them apart. */
    out.reason = out.lastReachOutAt ? 'ok'
        : !out.dated ? 'no-dates'          // posts rendered, none of them carried a timestamp
        : !out.classified ? 'not-attributed'  // dated, and not one could be placed as ours or theirs
        : 'customer-only';                 // read and understood: nobody here has written to them
    return out;
}

// The feed list itself. Prefer whichever candidate holds the most posts — a case
// page can contain more than one feed-ish container (e.g. a background tab).
function findFeedContainer(root) {
    const countIn = el => el.querySelectorAll(FEED_ITEM_SELECTOR).length;

    const feeds = findInShadows('.cuf-feed', root, false);
    if (feeds.length) {
        return feeds.slice().sort((a, b) => countIn(b) - countIn(a))[0];
    }

    // No .cuf-feed (Salesforce markup drift) — climb from any feed item instead.
    const items = findInShadows(FEED_ITEM_SELECTOR, root, false);
    if (items.length) {
        return items[0].closest('.forceChatterFeed, .forceChatterScroller, .cuf-feed') || root;
    }
    return null;
}

// Every element between `el` and the document, crossing shadow boundaries.
// We keep the whole chain rather than pre-filtering for "currently scrollable",
// because a container only starts overflowing once enough posts have loaded —
// filter on each pass instead (see scrollChainToBottom).
function getAncestorChain(el) {
    const chain = [];
    let node = el;

    while (node && node !== document) {
        if (node.nodeType === Node.ELEMENT_NODE) chain.push(node);
        node = node.parentNode;
        // A shadow root's parentNode is null; hop to its host to keep climbing.
        if (node && node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && node.host) node = node.host;
    }

    const doc = document.scrollingElement || document.documentElement;
    if (doc && !chain.includes(doc)) chain.push(doc);
    return chain;
}

function isScrollable(el) {
    if (el === document.scrollingElement || el === document.documentElement) {
        return el.scrollHeight > el.clientHeight + 4;
    }
    const oy = window.getComputedStyle(el).overflowY;
    return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
           el.scrollHeight > el.clientHeight + 4;
}

function scrollChainToBottom(chain) {
    for (const el of chain) {
        if (isScrollable(el)) el.scrollTop = el.scrollHeight;
    }
}

const LOAD_MORE_RE = /(view|show|load)\s+more|older posts|more posts/i;

/*
 * THE ONE RULE EVERY CLICK IN THIS FILE OBEYS: never open something.
 *
 * The sync clicks a handful of things on a live case — the Feed tab, "View more" at the
 * bottom of the feed, the expand-post chevrons, "N more comments". Each one is meant to
 * REVEAL TEXT IN PLACE so it can be read. None of them is meant to open a popover, a menu
 * or a dialog, and when one does the engineer watching sees the tool doing something they
 * did not ask for — which is the complaint that produced this rule: the ⓘ beside an email's
 * recipients kept opening during a sync.
 *
 * That ⓘ is reachable from two directions, which is why the guard lives here rather than at
 * one call site. It is a disclosure control, so `aria-expanded="false"` matches it and the
 * chevron sweep clicks it. And its label is assistive text INSIDE the button, so it lands in
 * textContent — "Show more recipients" satisfies LOAD_MORE_RE's `show\s+more` and the feed
 * loader clicks it too.
 */
// Word START only, no closing boundary. Every one of these arrives plural on a real
// control — "Show all recipientS", "Show more detailS", "Email addresseS" — and a trailing
// \b rejects all three, which is precisely the shape the reported icon comes in.
const OPENS_A_PANEL_RE = /\b(recipient|address|detail|attachment|action|menu|option|informa|info|preview)/i;

function opensSomethingElse(el) {
    if (!el || typeof el.getAttribute !== 'function') return true;

    // A popup trigger says so itself. This is the reliable half of the test.
    if (el.getAttribute('aria-haspopup')) return true;
    if (el.closest && el.closest('.cuf-commentActionButton, .slds-dropdown-trigger, [role="menu"], [role="dialog"], .cuf-commentInput, .commentInputArea')) return true;

    // And the naming half, for the controls that declare nothing. Assistive text counts:
    // on an icon-only button it IS the label, and it is what textContent returns.
    const label = ((el.textContent || '') + ' ' + (el.getAttribute('title') || '')
        + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
    if (label.length <= 60 && OPENS_A_PANEL_RE.test(label)) return true;

    return false;
}

/**
 * On a long chain Salesforce stops auto-loading and puts a "View More" button at
 * the foot of the feed — scrolling alone then gets you nowhere. Click it.
 *
 * Scope note: `region` must be the whole Chatter feed component (.forceChatterFeed),
 * NOT the .cuf-feed post list — the button renders in a container that sits
 * OUTSIDE the post list. It must also stay narrower than the page, because the
 * case sidebar has its own unrelated "Show More" buttons (Milestones, Knowledge)
 * we mustn't touch.
 */
function clickFeedLoadMore(region) {
    let clicked = 0;
    // Salesforce has shipped this as a <button>, a bare <a href="javascript:void(0)">
    // and a role="button" span over the years, so accept all three.
    for (const el of region.querySelectorAll('button, a, [role="button"]')) {
        const label = ((el.textContent || '') + ' ' + (el.getAttribute('title') || '')).trim();
        // A long label means we've matched some wrapper that merely CONTAINS the
        // words (e.g. a post whose body says "show more"), not the control itself.
        if (label.length > 40 || !LOAD_MORE_RE.test(label)) continue;
        if (!isVisible(el)) continue;
        // "Show more recipients" reads exactly like "Show more posts" to the regex above.
        if (opensSomethingElse(el)) continue;
        el.click();
        clicked++;
    }
    return clicked;
}

/* ----------------------------------------------------------------------------
 * The feed has to be ON SCREEN before it can be read
 * ----------------------------------------------------------------------------
 * A Lightning case record is split into sub-tabs — Feed, Details, Related — and
 * Salesforce renders only the ACTIVE one. Sync from a case sitting on Details and
 * there is no feed anywhere in the DOM: the loader above reports "no-feed-found",
 * not one post is scraped, and the panel says "no email chain was found — open the
 * case Feed tab and sync again". That instruction worked, and the engineer had to
 * follow it once per case.
 *
 * So the sync opens the tab itself. Three rules keep that from becoming a nuisance
 * of its own:
 *
 *   • It only clicks when no feed is on screen. On a case already showing its Feed
 *     — the common case — nothing is touched and nothing moves.
 *   • It runs AFTER the fields have been read (see scrapeSalesforce). Leaving a
 *     sub-tab unmounts it, so opening the Feed first would trade an empty chain
 *     for empty case fields.
 *   • It matches the tab by its LABEL, never by `data-tab-value`. Those values
 *     ("flexipage_tab3") are assigned per layout — the number differs between orgs
 *     and changes when somebody edits the page, so hard-coding one would work here
 *     and silently click the wrong tab elsewhere.
 * -------------------------------------------------------------------------- */

// The word, not the substring: "Feedback" is a real tab on some support layouts and
// must never be mistaken for the feed, while "Case Feed" must still match.
const FEED_TAB_RE = /(^|\W)(feed|chatter)(\W|$)/i;
const NOT_FEED_TAB_RE = /feedback|survey|newsfeed reader/i;

function isFeedTabLabel(label) {
    const t = String(label || '').replace(/\s+/g, ' ').trim();
    // A long label is a paragraph that happens to contain the word, not a tab.
    if (!t || t.length > 30) return false;
    if (NOT_FEED_TAB_RE.test(t)) return false;
    return FEED_TAB_RE.test(t);
}

// The label Salesforce puts on a tab, in the order the markup is worth trusting:
// data-label is the layout's own name for it, title is the accessible name, and the
// link text is what is actually drawn.
function tabLabelOf(el) {
    const li = el.closest ? el.closest('li') : null;
    const pick = (a, name) => (a && a.getAttribute && a.getAttribute(name)) || '';
    return (pick(el, 'data-label') || pick(li, 'data-label') ||
            pick(el, 'title') || pick(li, 'title') ||
            (el.textContent || '')).replace(/\s+/g, ' ').trim();
}

// Every visible tab control that names itself the feed. Invisible ones are excluded
// deliberately: a background workspace tab keeps its whole tab bar in the DOM, and
// clicking that one would switch a case the engineer is not looking at.
const TAB_LINK_SELECTOR = 'a[role="tab"], button[role="tab"], .slds-tabs_default__link';

function findFeedTabLinks(root) {
    const out = [];
    const seen = new Set();
    for (const el of findInShadows(TAB_LINK_SELECTOR, root, false)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const label = tabLabelOf(el);
        if (!isFeedTabLabel(label) || !isVisible(el)) continue;
        const li = el.closest ? el.closest('li') : null;
        const active = el.getAttribute('aria-selected') === 'true' ||
                       !!(li && li.className && /slds-is-active/.test(li.className));
        out.push({ el, label, active, exact: /^(feed|chatter)$/i.test(label) });
    }
    // "Feed" before "Case Feed Settings"-ish labels: the plainest name is the tab.
    out.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
    return out;
}

// Is a feed rendered and on screen right now?
function feedIsShowing(root) {
    const feed = findFeedContainer(root) || (root !== document ? findFeedContainer(document) : null);
    return !!(feed && isVisible(feed));
}

/**
 * Open the case's Feed tab if it is not already open.
 * Returns { clicked, label, reason } — never throws; every failure just leaves the
 * page as it was and lets the scrape read whatever is there, exactly as before.
 */
async function activateFeedTab(root, opts = {}) {
    /* SIX SECONDS WAS NOT ENOUGH.
     *
     * Clicking the Feed tab mounts a Lightning panel, and on a cold record that is a server
     * round trip on a page that is already fetching everything else it needs. Six seconds
     * cleared it most of the time, and the times it did not the sync reported "the Feed tab
     * was opened but no posts rendered" about a case whose feed arrived a second later —
     * a failure message about a page that had simply not finished.
     *
     * Waiting longer costs nothing when the feed is quick, because the loop below returns
     * the moment the feed appears. It only spends the extra time on the cases that need it.
     */
    const { waitMs = 15000, stepMs = 200, maxTries = 3 } = opts;

    if (feedIsShowing(root)) return { clicked: false, reason: 'already-showing' };

    let candidates = findFeedTabLinks(root);
    if (!candidates.length && root !== document) candidates = findFeedTabLinks(document);
    if (!candidates.length) return { clicked: false, reason: 'no-feed-tab' };

    /* THE TAB SAYS IT IS OPEN AND THERE IS STILL NO FEED — which is two different states
     * wearing the same badge, and treating them as one is half of the "sometimes it goes to
     * the Feed tab and sometimes it doesn't" report.
     *
     *   • The feed is genuinely EMPTY. Nothing to wait for, and returning at once is right:
     *     a case with no posts must not add fifteen seconds to every sync.
     *   • The feed is still MOUNTING. Lightning marks the sub-tab active the moment it is
     *     selected — on a cold record, on a workspace tab being restored, and on a tab that
     *     was merely switched to — and paints the posts a beat later. Returning here handed
     *     the scrape a page with no feed in it, which is scraped as a case with no email
     *     chain. Whether it worked came down to how warm the page happened to be.
     *
     * The two are told apart by WAITING, briefly, and by what the wait finds — not by
     * guessing. A short budget, because the empty-feed case pays it on every sync: three
     * seconds is enough for a panel that is mid-mount and cheap enough for one that will
     * never fill.
     *
     * If it is still empty after that, the tab is clicked anyway on the way past — re-
     * selecting an active Lightning sub-tab re-mounts it, which is the one recovery
     * available for a panel that mounted into an error and has been sitting blank since. */
    if (candidates[0].active) {
        const settleMs = Math.max(0, Math.min(opts.activeSettleMs != null ? opts.activeSettleMs : 3000, waitMs));
        const until = Date.now() + settleMs;
        while (Date.now() < until) {
            await sleep(stepMs);
            if (feedIsShowing(root)) {
                return { clicked: false, label: candidates[0].label, reason: 'already-active-settled' };
            }
        }
        try { candidates[0].el.click(); } catch (_) { /* nothing else to try */ }
        const retryUntil = Date.now() + Math.min(waitMs, 5000);
        while (Date.now() < retryUntil) {
            await sleep(stepMs);
            if (feedIsShowing(root)) {
                return { clicked: true, label: candidates[0].label, reason: 'remounted' };
            }
        }
        return { clicked: true, label: candidates[0].label, reason: 'already-active-no-feed' };
    }

    let last = '';
    for (const c of candidates.slice(0, maxTries)) {
        last = c.label;
        try { c.el.click(); } catch (_) { continue; }
        // Lightning mounts the panel asynchronously, and on a cold tab that is a
        // server round trip — so this waits for the feed to EXIST rather than
        // assuming a click is the same thing as a rendered tab.
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
            await sleep(stepMs);
            if (feedIsShowing(root)) return { clicked: true, label: c.label, reason: 'opened' };
        }
    }
    // Clicked, and still nothing. Said out loud rather than swallowed, because the
    // panel's "no email chain" message is otherwise indistinguishable from a case
    // that genuinely has no posts.
    return { clicked: true, label: last, reason: 'clicked-no-feed' };
}

/**
 * Scroll the case feed until no more posts load.
 * Returns { items, rounds, reason } — never throws; a failure just means we
 * scrape whatever was already on screen, exactly as before this existed.
 */
async function loadEntireFeed(root, opts = {}) {
    const {
        maxRounds    = 80,     // hard cap on scroll attempts
        settleMs     = 700,    // pause after each scroll so Salesforce can fetch
        stableRounds = 3,      // stop after this many rounds with no new posts
        maxMs        = 60000   // overall time budget
    } = opts;

    const feed = findFeedContainer(root);
    if (!feed) return { items: 0, rounds: 0, reason: 'no-feed-found' };

    const countItems = () => feed.querySelectorAll(FEED_ITEM_SELECTOR).length;

    // Remember where the user was so we can put the page back afterwards.
    const anchor = feed.querySelector(FEED_ITEM_SELECTOR) || feed;
    const chain = getAncestorChain(anchor);
    const originalTops = chain.map(el => el.scrollTop);

    // Salesforce's infinite-scroll sentinel lives on the scroller, a few levels
    // ABOVE .cuf-feed — so look for it from there, not from the feed's parent.
    const scroller = feed.closest('.forceChatterScroller') || feed.parentElement || feed;
    // The "View More" button renders OUTSIDE the .cuf-feed post list (in a
    // .cuf-showMoreContainer), so searching for it needs the whole feed component.
    // Prefer the OUTER container: the button can sit as a sibling of .forceChatterFeed
    // rather than inside it. Still far narrower than the page, so the sidebar's own
    // Show More buttons stay out of reach (see clickFeedLoadMore).
    const feedRegion =
        feed.closest('.supportCompactRecordFeedContainerDesktop') ||
        feed.closest('.forceChatterFeed') ||
        scroller;

    const started = Date.now();
    let previous = countItems();
    let stable = 0;
    let rounds = 0;
    let reason = 'exhausted-rounds';

    while (rounds < maxRounds) {
        if (Date.now() - started > maxMs) { reason = 'time-budget'; break; }
        rounds++;

        // Push every scroller to its bottom; one of them is the real one.
        scrollChainToBottom(chain);
        // Belt and braces: pull the last post (and the infinite-scroll sentinel,
        // if present) into view, which is what actually trips Salesforce's
        // IntersectionObserver on some layouts.
        const trigger = scroller.querySelector('.loadMoreTrigger');
        const items = feed.querySelectorAll(FEED_ITEM_SELECTOR);
        const last = items[items.length - 1];
        try { (trigger || last)?.scrollIntoView({ block: 'end' }); } catch (_) {}

        // Now that the foot of the feed is on screen, click any "View More" that
        // was blocking further scrolling. Order matters: clicking after the scroll
        // mirrors what a human does, and guarantees the button is rendered.
        const clicked = clickFeedLoadMore(feedRegion);

        // A click fires a server round-trip, which routinely outlasts one settle.
        await sleep(clicked ? settleMs * 2 : settleMs);

        const current = countItems();
        if (current > previous) {
            previous = current;
            stable = 0;
        } else {
            stable++;
        }

        // Be more patient while we're actively clicking "View More" — the posts
        // may simply still be in flight. Bounded, so a button that never resolves
        // still terminates (and maxRounds/maxMs bound the whole loop regardless).
        if (stable >= (clicked ? stableRounds + 3 : stableRounds)) {
            reason = 'no-new-posts';
            break;
        }
    }

    if (EXPAND_FEED_POSTS) await expandFeedPosts(root, feed);

    // Put the user's scroll position back — the sync shouldn't move their page.
    chain.forEach((el, i) => { el.scrollTop = originalTops[i]; });

    return { items: countItems(), rounds, reason };
}

/**
 * Posts arrive collapsed, and Salesforce doesn't render a collapsed post's body
 * at all — only its truncated one-line summary. So after everything has loaded,
 * click the feed's own "Expand all visible posts" toolbar button to materialise
 * the full email bodies the scraper reads.
 */
async function expandFeedPosts(root, feed) {
    const expandAll = findInShadows('button[title*="Expand all"]', root, false).filter(isVisible);
    if (expandAll.length) {
        expandAll[0].click();
        await sleep(900);
    } else {
        // Fallback: click each post's own collapsed chevron.
        //
        // `aria-expanded="false"` is the markup for ANY collapsed disclosure control, not
        // just a post — the ⓘ that expands an email's recipients is one, and this swept it
        // up with the rest. The post chevrons are what this is for; anything that opens a
        // panel is not a post.
        const chevrons = Array.from(feed.querySelectorAll('a[role="button"][aria-expanded="false"]'))
            .filter(el => !opensSomethingElse(el));
        if (chevrons.length) {
            chevrons.forEach(c => { try { c.click(); } catch (_) {} });
            await sleep(900);
        }
    }

    // Always, on BOTH paths. "Expand all" is the common one and it opens posts only —
    // returning early after it, as this used to, would have left every hidden reply
    // hidden on exactly the layout most cases use.
    await expandFeedComments(feed);
}

/*
 * "Expand all" opens POSTS. It does not touch replies, and replies are hidden two
 * separate ways:
 *
 *   • Salesforce shows the most recent few and puts the rest behind a "N more comments"
 *     link. Those unshown ones are not in the DOM at all, so no amount of careful reading
 *     finds them — the link has to be clicked.
 *   • A long reply is truncated with its own "Expand Post" control, leaving the tail
 *     rendered but hidden. That half the scraper can still read (readText falls back to
 *     textContent), so it is worth clicking but not worth failing over.
 *
 * Both are best-effort and deliberately quiet: this runs on someone's live case page, and
 * a click that does not land should cost the sync nothing. Bounded to two rounds because
 * "more comments" can reveal another "more comments" on a long thread, and unbounded
 * clicking on a stranger's page is not a trade worth making for the third page of replies.
 */
async function expandFeedComments(feed) {
    if (!feed || typeof feed.querySelectorAll !== 'function') return;

    // Where replies live. Everything below is searched from HERE and not from the feed,
    // so an email header, a post's action menu and the record's own chrome are outside
    // the blast radius of every click this makes.
    const COMMENT_REGIONS = '.cuf-feedback, .cuf-compactFeedBack, .forceChatterFeedback, .slds-feed__item-comments';

    const regions = Array.from(feed.querySelectorAll(COMMENT_REGIONS));
    if (!regions.length) return;

    for (let round = 0; round < 2; round++) {
        const links = [];
        for (const region of regions) {
            for (const el of region.querySelectorAll('a, button')) {
                if (isMoreCommentsControl(el)) links.push(el);
            }
        }
        if (!links.length) break;
        links.forEach(el => { try { el.click(); } catch (_) {} });
        await sleep(700);
    }

    // Truncated reply bodies. `.cuf-more` carries `hidden` when there is nothing to
    // expand, so filtering on it avoids a pile of no-op clicks on an ordinary feed.
    const moreText = [];
    for (const region of regions) {
        for (const el of region.querySelectorAll('.cuf-more')) {
            if (el.classList && el.classList.contains('hidden')) continue;
            if (opensSomethingElse(el)) continue;
            moreText.push(el);
        }
    }
    if (moreText.length) {
        moreText.forEach(el => { try { el.click(); } catch (_) {} });
        await sleep(500);
    }
}

/* opensSomethingElse() is defined once, beside LOAD_MORE_RE — every click site shares it. */

/*
 * Is this the "3 more comments" link, and nothing else?
 *
 * Matched on VISIBLE TEXT only. The first version also searched the title attribute, which
 * is where icon buttons keep their labels — so a bare icon whose tooltip happened to pair
 * "show" with "comment" became a click target, and the regex made that easy by allowing
 * `.*` to leap between the two words across an entire label.
 *
 * The real link says one of a few short things — "2 more comments", "Show all comments",
 * "View more comments" — so the test is: it must NAME comments, be short enough to be a
 * link rather than a paragraph that mentions them, and START like a count or a verb.
 */
function isMoreCommentsControl(el) {
    if (opensSomethingElse(el)) return false;

    const label = ((el.innerText || el.textContent || '')).replace(/\s+/g, ' ').trim();
    if (!label || label.length > 40) return false;
    if (!/\bcomments?\b/i.test(label)) return false;
    return /^(\d+|show|view|see|all|more|load)\b/i.test(label);
}

/*
 * `exact` skips cleanFieldValue's action-word surgery. That surgery exists to cut the
 * "Open"/"Edit"/"Preview" button text Salesforce jams onto LOOKUP values, but it also
 * fires on a picklist whose own value ENDS in one of those words: a Case Status of
 * "Case Closed" comes back as "Case", "Ready to Close" as "Ready to", "Awaiting Edit"
 * as "Awaiting". (Values where the word is the whole string, like "Closed", survive —
 * the split only wins when there is text in front of it.) Passing exact is safe
 * precisely when a specific value element was found, because then there is no button
 * text on the end to strip. The container fallbacks below still clean, since that is
 * the case the cleaning was written for.
 */
/*
 * Every shape a Salesforce case layout renders a FIELD LABEL in. A case record does not have one
 * canonical markup — it depends on the org's layout, the release, and whether the record is being
 * viewed in the console, on its own page, or in Classic:
 *
 *   .test-id__field-label / .slds-form-element__label  Lightning record detail and Dynamic Forms
 *   records-highlights-details-item .slds-text-title   the compact highlights strip at the top of
 *                                                     the record — on a good number of org layouts
 *                                                     that is the ONLY place Case Number, Status
 *                                                     and Owner are rendered at all
 *   .labelCol                                         Salesforce Classic, whose detail page is a
 *                                                     plain table and matches none of the above
 *
 * Scraping only the first pair is what makes the sync look broken on somebody else's view: the
 * page is a case, the feed loads and scrolls, and not one field is found.
 */
const FIELD_LABEL_SELECTOR = [
    '.test-id__field-label',
    '.slds-form-element__label',
    'records-highlights-details-item .slds-text-title',
    '.slds-page-header__detail-block .slds-text-title',
    'td.labelCol',
    'th.labelCol',
    '.labelCol'
].join(', ');

/*
 * A field LABEL, normalised. Classic writes "Status:" with a colon, a required field is
 * rendered "* Status", and a wrapped label arrives with a newline in the middle — all three
 * miss an exact match on "status", which is how a layout ends up syncing no fields at all.
 * Used for BOTH halves of the scrape: to recognise a label, and to recognise a "value" that is
 * really just that label handed back to us (see getFieldValue).
 */
function normaliseLabel(raw) {
    return (raw || '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[*\s]+/, '')
        .replace(/\s*[:：]\s*$/, '')
        .trim()
        .toLowerCase();
}

const labelTextOf = (el) => normaliseLabel(el && el.textContent);

/*
 * Every shape a case renders a field VALUE in, MOST SPECIFIC FIRST — and the order is the whole
 * point of the list. These used to be joined into one querySelector, which returns the first
 * match in DOCUMENT order, not the first selector that matches. In the highlights strip at the
 * top of a case the label sits ABOVE the value and is itself a <p title="Status">Status</p>, so
 * the generic `p[title]` at the tail of the list won on document order and the sync came back
 * with the words "Status" and "JIRA Number" — each field's own label, stored as its value.
 * Tried one selector at a time, the element Salesforce actually marks as the output field wins
 * wherever on the page it sits.
 */
const FIELD_VALUE_SELECTORS = [
    '[data-output-element-id="output-field"]',
    'slot[name="outputField"] lightning-formatted-text',
    'lightning-formatted-text',
    'lightning-formatted-name',
    'lightning-formatted-number',        // formula/number fields (e.g. Case Age in days)
    'lightning-formatted-date-time',
    'lightning-formatted-rich-text',
    'lightning-formatted-url a',
    'a[data-refid="recordId"]',
    'a[href*="/lightning/r/"]',
    '.slds-form-element__static',
    '.uiOutputText',
    '.slds-text-body_regular',
    'p[title]'
];

// querySelectorAll that also descends into shadow roots — including the container's own, which
// findInShadows() skips because its TreeWalker starts at the container's descendants.
function queryDeep(root, selector) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const found = findInShadows(selector, root, false);
    if (root.shadowRoot) found.push(...findInShadows(selector, root.shadowRoot, false));
    return found;
}

/*
 * The chrome Salesforce renders INSIDE a field's value box: the inline-edit pencil, whose whole
 * text is a screen-reader label reading "Edit JIRA Number", plus any other button and any
 * assistive-text run. On a field the case has left EMPTY that affordance is the only text in the
 * box, which is how a case with no defect raised against it came back with the words "Edit JIRA
 * Number" sitting in the JIRA Number field. Anchors are deliberately NOT in here: a lookup and a
 * URL field render their value as one.
 */
const VALUE_CHROME_SELECTOR = [
    'button',
    '.slds-button',
    '[role="button"]',
    '.slds-assistive-text',
    '.assistiveText',
    'lightning-primitive-icon',
    '.slds-form-element__icon',
    'svg'
].join(', ');

// A value element's text with that chrome taken out. Cloned rather than edited — this runs on
// the live Salesforce page the engineer is reading.
function valueText(el) {
    if (!el) return '';
    let source = el;
    if (typeof el.cloneNode === 'function' && typeof el.querySelector === 'function' &&
        el.querySelector(VALUE_CHROME_SELECTOR)) {
        source = el.cloneNode(true);
        source.querySelectorAll(VALUE_CHROME_SELECTOR).forEach(node => node.remove());
    }
    return source.textContent || '';
}

/*
 * Is this candidate the field's own LABEL rather than its value? Salesforce renders a label more
 * than once — the visible title, the form element's <span>, an assistive-text copy for screen
 * readers — and any of them can match a generic value selector such as `p[title]`.
 */
function isLabelElement(el, labelEl, wanted) {
    if (!el || el === labelEl) return true;
    if (typeof el.contains === 'function' && (el.contains(labelEl) || labelEl.contains(el))) return true;
    try { if (el.matches(FIELD_LABEL_SELECTOR)) return true; } catch (_) {}
    if (el.classList && el.classList.contains('slds-assistive-text')) return true;
    return labelTextOf(el) === wanted;
}

/*
 * The boxes this field's value could be sitting in, NARROWEST FIRST, so the value nearest the
 * label wins. A box that also holds ANOTHER field's label is skipped outright: whatever we found
 * inside it may belong to the neighbour, and a confidently wrong value is worse than a blank —
 * it reads as the case's real status and every later step believes it. A second copy of the SAME
 * label is not a neighbour; Salesforce routinely renders one.
 */
function valueScopes(labelEl) {
    const wanted = labelTextOf(labelEl);
    const seen = new Set();
    const scopes = [];

    const consider = (el) => {
        if (!el || el.nodeType !== Node.ELEMENT_NODE || seen.has(el)) return;
        seen.add(el);
        const foreign = Array.from(el.querySelectorAll(FIELD_LABEL_SELECTOR))
            .some(other => other !== labelEl && labelTextOf(other) !== wanted);
        if (foreign) return;
        scopes.push(el);
    };

    consider(labelEl.parentElement);
    consider(labelEl.closest('records-highlights-details-item'));
    consider(labelEl.closest('.slds-page-header__detail-block'));
    consider(labelEl.closest('lightning-output-field'));
    consider(labelEl.closest('.slds-form-element'));
    consider(labelEl.closest('records-record-layout-item'));
    consider(labelEl.parentElement && labelEl.parentElement.parentElement);

    return scopes;
}

// The value element inside one box: first by SELECTOR priority, then by document order, never
// the label itself, never an element with no text in it — where "no text" means none once the
// edit pencil has been discounted, so an empty field does not pass its own affordance off as a
// value.
function findValueElement(scope, labelEl, wanted) {
    const candidates = queryDeep(scope, FIELD_VALUE_SELECTORS.join(', '));
    if (!candidates.length) return null;

    for (const selector of FIELD_VALUE_SELECTORS) {
        for (const el of candidates) {
            let matches = false;
            try { matches = el.matches(selector); } catch (_) {}
            if (!matches) continue;
            if (isLabelElement(el, labelEl, wanted)) continue;
            if (!valueText(el).trim()) continue;
            return el;
        }
    }
    return null;
}

/*
 * A LONG TEXT FIELD KEEPS ITS LINES.
 *
 * valueText() returns textContent, and textContent does not know what a <br> is — so the
 * case Description, which Salesforce renders as one element with <br> between every line,
 * came back as a single paragraph with its structure gone. On a real description that
 * structure IS the content: "Device make and model: …", "OS type and version: …",
 * "Detailed description of issue: …" are separate lines that run together into nonsense
 * when the breaks are dropped.
 *
 * Whitespace is tidied per line rather than globally, so indentation noise goes without
 * taking the line breaks with it, and a run of blank lines collapses to one.
 */
function valueTextMultiline(el) {
    if (!el || typeof el.cloneNode !== 'function') return valueText(el);

    const clone = el.cloneNode(true);
    try { clone.querySelectorAll(VALUE_CHROME_SELECTOR).forEach(n => n.remove()); } catch (_) {}

    const doc = el.ownerDocument || document;
    // replaceChild rather than replaceWith: the latter is missing on older engines, and a
    // throw here would lose the whole field rather than just its line breaks.
    clone.querySelectorAll('br').forEach(br => {
        if (br.parentNode) br.parentNode.replaceChild(doc.createTextNode('\n'), br);
    });
    // A block element ends a line too — some orgs render the description as <p> per line.
    clone.querySelectorAll('p, div, li').forEach(b => b.appendChild(doc.createTextNode('\n')));

    return (clone.textContent || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.replace(/[ \t ]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getFieldValue(labelEl, exact = false, multiline = false) {
    if (!labelEl) return '';
    const wanted = labelTextOf(labelEl);

    const read = (el) => {
        if (!el) return '';
        // multiline implies exact: cleanFieldValue would cut a long description at the
        // first "Edit" or "Close" it happens to contain, which in prose is a real word.
        if (multiline) return valueTextMultiline(el);
        return exact
            ? valueText(el).replace(/\s{2,}/g, ' ').trim()
            : cleanFieldValue(valueText(el));
    };
    // Nothing leaves here that is the field describing ITSELF rather than saying what it holds —
    // the label read back, or the button offering to fill the field in. Both were reported: Case
    // Status syncing as "Status", and a case with no defect raised against it syncing "Edit JIRA
    // Number" as its JIRA number. Either is worse than an empty field, because the panel leaves a
    // blank field open for the engineer to fill in and silently trusts a filled one.
    const accept = (value) => {
        const v = (value || '').trim();
        if (!v) return '';
        const n = normaliseLabel(v);
        if (n === wanted) return '';
        // The inline-edit affordance, reached by a fallback broad enough to have swept the pencil
        // up along with the value it sits beside.
        if (n === `edit ${wanted}` || n === `${wanted} edit`) return '';
        if (n === 'edit' || n === 'open' || n === 'preview') return '';
        return v;
    };

    // SALESFORCE CLASSIC: the detail page is a table, and the value is the sibling cell on the
    // same row. None of the Lightning containers below exist there. Walk forward from THIS label
    // to its own cell rather than taking the row's first .dataCol — a Classic row normally
    // carries two label/value pairs, so the first cell belongs to the left-hand pair and every
    // right-hand label would read its neighbour's value.
    if (labelEl.classList && labelEl.classList.contains('labelCol')) {
        let cell = labelEl.nextElementSibling;
        while (cell && !(cell.classList && cell.classList.contains('dataCol'))) {
            cell = cell.nextElementSibling;
        }
        if (!cell) {
            const row = labelEl.closest('tr');
            cell = row && row.querySelector('td.dataCol, .dataCol');
        }
        const classic = accept(read(cell));
        if (classic) return classic;
    }

    // LIGHTNING: the highlights strip, the record detail, Dynamic Forms — all of them are a
    // label with its value in one of the boxes around it.
    for (const scope of valueScopes(labelEl)) {
        const value = accept(read(findValueElement(scope, labelEl, wanted)));
        if (value) return value;
    }

    // Broader container fallback: the field's whole control box with its action buttons removed.
    // Cleaned even when `exact` was asked for — a whole control carries the button text that
    // `exact` is only safe to skip when a specific value element was found.
    const fieldComponent = labelEl.closest('records-record-layout-item, lightning-output-field, .slds-form-element');
    if (fieldComponent) {
        const control = fieldComponent.querySelector('.slds-form-element__control');
        if (control) {
            const clone = control.cloneNode(true);
            clone.querySelectorAll(VALUE_CHROME_SELECTOR + ', [class*="action"], .test-id__action').forEach(el => el.remove());
            const value = accept(cleanFieldValue(clone.textContent));
            if (value) return value;
        }
    }

    // Simple sibling fallback — skipping a sibling that is itself a label, which is the next
    // FIELD, not this one's value.
    const sibling = labelEl.nextElementSibling;
    if (sibling) {
        let siblingIsLabel = false;
        try { siblingIsLabel = sibling.matches(FIELD_LABEL_SELECTOR); } catch (_) {}
        if (!siblingIsLabel) return accept(cleanFieldValue(valueText(sibling)));
    }

    return '';
}

/*
 * The issue key inside a JIRA field's value. Most layouts hold a bare key ("MCMR-44187"), but
 * others render the field as a link or wrap it in words, and the panel turns whatever it is
 * given into a jira.soti.net/browse/<key> link — so pull the key out rather than storing the
 * wrapping. A label read back ("JIRA Number") holds no key, so it can never survive this.
 */
function issueKeyIn(raw) {
    const m = (raw || '').toUpperCase().match(/\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/);
    return m ? `${m[1]}-${m[2]}` : '';
}

/*
 * The link back to the case record. In the Salesforce CONSOLE the address bar shows the
 * console, not the record — the record lives on a workspace tab whose anchor carries a
 * RELATIVE href ("/lightning/r/Case/500OF00000ShNVtYAN/view"). It is resolved against the
 * page's OWN origin, never a hard-coded one, so a sandbox, a different pod or a My Domain
 * rename all keep working.
 *
 * Several case tabs are normally open at once, so the tab that NAMES the case we just
 * scraped wins over the merely-active one; the record page's own URL is the last resort.
 */
function findCaseRecordUrl(caseNumber) {
    const CASE_PATH = /\/lightning\/r\/Case\/[A-Za-z0-9]{15,18}(\/|$)/;
    const abs = (href) => { try { return new URL(href, location.origin).href; } catch (e) { return ''; } };
    const hrefOf = (a) => a.getAttribute('href') || '';

    const anchors = findInShadows('a[href*="/lightning/r/Case/"]', document, false)
        .filter(a => CASE_PATH.test(hrefOf(a)));

    const num = (caseNumber || '').trim();
    if (num) {
        const byNumber = anchors.find(a => `${a.getAttribute('title') || ''} ${a.textContent || ''}`.includes(num));
        if (byNumber) return abs(hrefOf(byNumber));
    }
    const active = anchors.find(a => a.getAttribute('aria-selected') === 'true');
    if (active) return abs(hrefOf(active));
    if (CASE_PATH.test(location.pathname)) return location.href.split('?')[0];
    return anchors.length ? abs(hrefOf(anchors[0])) : '';
}


/* ===========================================================================
 * THE NPS AVERAGES — a Flow screen, not a record field
 * ===========================================================================
 * "NPS Score (90 Days Avg)" and "NPS Score (365 Days Avg)" are not on the record layout.
 * They are rendered by a Flow inside an accordion headed "Net Promoter Scores for Customer
 * (Value in Percentage)", and there the label and the value are SEPARATE SIBLING screen
 * fields — two rich-text blocks in one column, the label in the first and a bare "NA" or
 * "72" in the next, with an empty spacer block between them.
 *
 * So there is no label-to-value relationship for getFieldValue to follow: it looks for the
 * value inside or beside the label's own form element, and here the value is a different
 * element with no connection to the label but its position. Hence a dedicated reader.
 *
 * These two matter because the closure workflow turns on them — an N/A or a score under 100
 * is what makes a case a self-recovery — so a layout that carries them and a reader that
 * cannot see them is the same thing as a case with no NPS at all, which is the one state
 * the closure directive must never be told.
 * ========================================================================= */
const NPS_AVERAGE_FIELDS = [
    { key: 'd90', re: /nps\s*score\s*\(?\s*90\s*days?\s*(?:avg|average)/i, label: 'NPS Score (90 Days Avg)' },
    { key: 'd365', re: /nps\s*score\s*\(?\s*365\s*days?\s*(?:avg|average)/i, label: 'NPS Score (365 Days Avg)' }
];

/* Is this text a SCORE? Deliberately narrow: the blocks around a Flow field hold labels,
 * help text and whole paragraphs, and anything that is not plainly a number or an N/A must
 * come back empty rather than be stored as somebody's NPS. */
function npsAverageScore(raw) {
    const s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > 16) return '';
    if (/^-?\d+(?:\.\d+)?\s*%?$/.test(s)) return s;
    if (/^(?:n\s*[\/.]?\s*a|na|none|not applicable|not available)$/i.test(s)) return 'NA';
    return '';
}

/* Walk forward from the label's screen field to the block holding its number.
 *
 * The Flow emits EMPTY rich-text blocks among the real ones — in the layout this was written
 * against one sits directly above the label — so the value is not reliably the immediate
 * sibling and the blanks are skipped. It stops at the first block that has text and is NOT a
 * score, because that block is the next LABEL, and its neighbour is another field's value:
 * a reader that kept walking would report the 365-day score as the 90-day one on any layout
 * where the 90-day figure is missing. */
function npsAverageValueAfter(labelField) {
    let el = labelField && labelField.nextElementSibling;
    for (let hops = 0; el && hops < 5; hops++, el = el.nextElementSibling) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        return npsAverageScore(t);
    }
    return '';
}

function readNpsAverages(root) {
    const out = { d90: '', d365: '' };
    let fields = findInShadows('flowruntime-screen-field', root, false);
    /* The Flow is a component on the page, not part of the record detail, so on a layout
     * where getActiveWorkspaceRoot() picks the record container the accordion is outside it.
     * Widening to the document is safe here in a way it is not for the case's own fields:
     * these two are matched by their full label text, which no other field carries. */
    if (!fields.length && root !== document) fields = findInShadows('flowruntime-screen-field', document, false);
    if (!fields.length) return out;

    const seen = fields.map(el => ({ el, t: (el.textContent || '').replace(/\s+/g, ' ').trim() }));
    for (const spec of NPS_AVERAGE_FIELDS) {
        /* THE TIGHTEST MATCH WINS. Every ancestor of the label block contains the label too —
         * up to the accordion that holds BOTH scores — and reading forward from an ancestor
         * finds the other score or nothing at all. Sorting by text length puts the label's own
         * block first, which is the only one whose next sibling is its value. */
        const hits = seen.filter(x => spec.re.test(x.t)).sort((a, b) => a.t.length - b.t.length);
        for (const hit of hits) {
            // Some orgs render the label and the number in ONE block; take that first.
            const inline = hit.t.replace(spec.re, '').replace(/^[)\s:·•—-]+/, '');
            const v = npsAverageScore(inline) || npsAverageValueAfter(hit.el);
            if (v) { out[spec.key] = v; break; }
        }
    }
    return out;
}

async function scrapeSalesforce(options = {}) {
    const { loadFullFeed = true } = options;
    const data = {
        caseNumber: '',
        caseStatus: '',
        contactName: '',
        accountName: '',
        subject: '',
        description: '',
        currentVersion: '',
        product: '',
        licenseType: '',
        // "MC Hosted" (Cloud vs On-Prem) decides whether SOTI Support can pull the server logs
        // itself or has to request them from the customer, so it is scraped from the case
        // rather than inferred from License Type (which only ever guessed at it).
        mcHosted: '',
        caseAge: '',
        /* EVERY NPS-LABELLED FIELD ON THE LAYOUT — [{ label, value }].
         *
         * A list rather than a field, because the closure rule is about "either of the NPS
         * scores" and layouts carry more than one under names that vary per org. See the
         * readFields branch that fills it. */
        npsScores: [],
        /* THE TWO NPS AVERAGES, read off the Flow screen rather than the record layout —
         * { d90, d365 }, each a number, 'NA', or '' when the block was not on the page.
         * Kept as their own field as well as being merged into npsScores above, because the
         * Case Info panel shows these two specifically and matching them back out of a list
         * by their label text would be a second, weaker copy of the same read. */
        npsAverages: { d90: '', d365: '' },
        /* HAS THE CASE BEEN ESCALATED — 'yes' | 'no' | '' (could not be read).
         * A mandatory trigger for a TL recovery call at closure. Tri-state on purpose: see
         * readCheckboxField, and the closure directive in the panel. */
        escalated: '',
        /* THE FILES ATTACHED TO THIS CASE'S EMAILS — [{ id, url, name, kind, when, from }].
         * Links, never contents: see readFeedAttachments. `kind` is 'file' or 'image', and
         * the panel treats the two differently — an image is OCR'd, a file is ingested. */
        attachments: [],
        // Absolute link back to this case record, so the panel can reopen it.
        caseUrl: '',
        // The engineering defect raised off this case (e.g. MCMR-42071).
        jiraNumber: '',
        // Who owns the case in Salesforce. Used as one of the signals that decides whether a
        // feed post went out from us — see feedItemIsFromUs.
        caseOwner: '',
        /* WHO LAST TOUCHED IT, which is a different and more useful question for a support
         * queue: the owner of a case is routinely a queue rather than a person, and stays
         * the same for weeks, while the last editor is whoever is actually working it.
         *
         * Read here as well as off the list view (see caseListCellAny) so a case ADDED BY
         * URL, or refreshed with the per-case Sync now, fills the same column as one that
         * arrived from a list — otherwise the queue's Modified by column is populated for
         * some rows and blank for others for no reason the engineer can see. */
        lastModifiedBy: '',
        // WHEN ANYTHING LAST HAPPENED, and when WE last wrote to the customer. Two numbers,
        // because the second is the one an engineer is judged on and the first can hide it:
        // a case the customer replied to an hour ago may still be one nobody has answered.
        // Milliseconds, or null when the feed carried no timestamp this build could read.
        lastMessageAt: null,
        lastMessageLabel: '',
        lastMessageFrom: '',
        lastReachOutAt: null,
        lastReachOutLabel: '',
        lastReachOutFrom: '',
        emailChain: '',
        feedItemCount: 0,
        feedTab: null,      // { clicked, label, reason } — see activateFeedTab
        feedLoad: null      // { items, rounds, reason } — see loadEntireFeed
    };

    // Find the root of the active case to avoid pulling data from background tabs
    const activeRoot = getActiveWorkspaceRoot();
    console.log('SOTI AI Analyser: Scraping from root', activeRoot);

    let fieldLabels = findInShadows(FIELD_LABEL_SELECTOR, activeRoot, false);
    // getActiveWorkspaceRoot is a HEURISTIC — it scores containers and picks a winner. When it
    // picks one that does not actually hold the record detail (an unfamiliar console layout, a
    // record opened in its own browser tab, Classic), it returns a subtree with no fields in it
    // and the whole sync comes back empty. Searching the entire document is strictly better than
    // returning an empty case: the worst case is reading a background tab's fields, and the case
    // number is reconciled against the page's own URL below anyway.
    let rootFellBack = false;
    if (!fieldLabels.length && activeRoot !== document) {
        fieldLabels = findInShadows(FIELD_LABEL_SELECTOR, document, false);
        rootFellBack = true;
        console.warn('SOTI AI Analyser: no fields under the active root — falling back to the whole document');
    }

    // Whether data.jiraNumber holds a real issue key yet, or merely the best guess so far.
    let jiraNumberIsKey = false;

    // Run over a set of labels, filling in whatever is still blank. Every assignment below is
    // guarded on the field being empty, so this is safe to run more than once over widening sets
    // of labels — the first (narrowest, most trustworthy) reading of a field always wins.
    const readFields = (labels) => labels.forEach(label => {
        // NORMALISED before it is matched (see normaliseLabel). Several of the tests below are
        // deliberately EXACT ("status", not anything containing it — a case layout is full of
        // Sub Status / Escalation Status), and an exact test is only as good as the string it
        // is given.
        const text = labelTextOf(label);
        if (!text) return;
        if (text.includes('case number') && !data.caseNumber) {
            data.caseNumber = getFieldValue(label);
        }
        // Matched EXACTLY: a case layout is full of other "… Status" labels (Sub Status,
        // Escalation Status, Approval Status), and any of them would win a loose match.
        if ((text === 'status' || text === 'case status') && !data.caseStatus) {
            data.caseStatus = getFieldValue(label, true);
        }
        if ((text === 'contact name' || text === 'contact') && !data.contactName) {
            data.contactName = getFieldValue(label);
        }
        if ((text === 'account name' || text === 'account') && !data.accountName) {
            data.accountName = getFieldValue(label);
        }
        // Matched exactly, and the alias variant separately: a case layout also carries
        // "Case Owner Alias" and "Last Modified By Alias", and a loose `includes('owner')`
        // would take whichever Salesforce rendered first.
        if ((text === 'case owner' || text === 'owner' || text === 'assigned to'
             || text === 'case owner alias') && !data.caseOwner) {
            data.caseOwner = getFieldValue(label);
        }
        /* THE ALIAS IS PREFERRED, and the two are read into the same field on purpose: the
         * queue's column is 70px wide and "aaugu" fits where "Ayodeji Augustine" does not,
         * which is why the list views carry the alias column in the first place. The full
         * name is taken only when the layout does not offer the alias, so the cell is never
         * blank on a case that plainly has an editor. Matched EXACTLY — a loose match on
         * "last modified" also takes "Last Modified Date", which is a date, not a person. */
        if (text === 'last modified by alias') {
            // Whenever it turns up, it wins — the two labels can come in either order.
            const alias = getFieldValue(label);
            if (alias) data.lastModifiedBy = alias;
        } else if (text === 'last modified by' && !data.lastModifiedBy) {
            data.lastModifiedBy = getFieldValue(label);
        }
        if (text === 'subject' && !data.subject) {
            data.subject = getFieldValue(label);
        }
        if (text === 'description' && !data.description) {
            data.description = getFieldValue(label, true, true);
        }
        if (text.includes('current version') && !data.currentVersion) {
            data.currentVersion = getFieldValue(label);
        }
        if (text === 'product' && !data.product) {
            data.product = getFieldValue(label);
        }
        if (text.includes('license type') && !data.licenseType) {
            data.licenseType = getFieldValue(label);
        }
        // "MC Hosted" is the field name on the SOTI case layout; the others are the variants
        // seen on older/renamed layouts. Matched narrowly so unrelated labels that merely
        // contain "host" (e.g. "Hostname") never win.
        if (!data.mcHosted && (
            text.includes('mc hosted') || text.includes('mobicontrol hosted') ||
            text === 'hosted' || text === 'hosting' ||
            text === 'hosted by' || text === 'hosting type' || text === 'deployment type'
        )) {
            data.mcHosted = getFieldValue(label);
        }
        if (text.includes('case age') && !data.caseAge) {
            data.caseAge = getFieldValue(label);
        }
        /* HAS THIS CASE EVER BEEN ESCALATED — the first mandatory trigger in the closure
         * workflow, and the one that can be derived from nothing else on the record.
         *
         * Salesforce's standard `IsEscalated` is a CHECKBOX, and a checkbox is the one field
         * shape getFieldValue cannot read: Lightning renders a ticked box as an `<img alt="True">`
         * or as a faux-checkbox span with no text in it at all, so the generic reader returns ''
         * — which would make "not escalated" indistinguishable from "never looked". Hence the
         * dedicated read below, and hence `escalated` being a TRI-STATE ('yes' / 'no' / '')
         * rather than a boolean: assuming `no` on an unreadable layout would silently skip a
         * mandatory recovery call, which is the one direction this must not fail in. */
        if (!data.escalated && /(^|\W)escalat/.test(text) && !text.includes('reason')) {
            data.escalated = readCheckboxField(label);
        }
        /* THE NPS SCORES — read as a LIST, not as one field.
         *
         * The closure process turns on them: an N/A on either score is what makes a case a
         * self-recovery call rather than a normal close (see buildCaseClosureDirective in the
         * panel). "Either" is the operative word — layouts carry two, sometimes more, under
         * names that differ per org: "NPS Score" and "NPS Comments", "NPS Rating 1" / "…2",
         * "Customer Satisfaction (NPS)". Picking one label and calling it "the" NPS score
         * would silently read whichever Salesforce rendered first and miss the very case the
         * rule exists for — the one where the OTHER score is the blank one.
         *
         * So every NPS-labelled field on the layout is captured with the name it carries, and
         * the panel decides what an N/A means. Matched on "nps" as a word so a label like
         * "Response" cannot match on the letters alone, and each label is taken once. */
        if (/(^|\W)nps(\W|$)/.test(text) || text.includes('net promoter')) {
            const v = getFieldValue(label);
            const name = (label.textContent || '').replace(/\s+/g, ' ').trim() || text;
            if (!data.npsScores.some(s => s.label.toLowerCase() === name.toLowerCase())) {
                data.npsScores.push({ label: name, value: v });
            }
        }
        // The engineering defect. "JIRA Number" is the label on the SOTI case layout;
        // the rest are the variants seen on older/renamed ones. Matched on the LABEL,
        // never on the value's shape, so a case number or an asset tag cannot win.
        // Among the labels that DO match, an issue key wins outright: a layout carrying both
        // "JIRA Number" and "JIRA Status" would otherwise sync whichever of the two Salesforce
        // happened to render first, and put "In Progress" in the JIRA Number box.
        if (!jiraNumberIsKey && (
            text.includes('jira') || text.includes('mcmr') ||
            text.includes('defect') || text.includes('bug number') || text.includes('bug id')
        )) {
            const raw = getFieldValue(label);
            const key = issueKeyIn(raw);
            if (key) {
                data.jiraNumber = key;
                jiraNumberIsKey = true;
            } else if (!data.jiraNumber) {
                data.jiraNumber = raw;
            }
        }
    });

    readFields(fieldLabels);

    /* The HIGHLIGHTS strip at the top of a record sits OUTSIDE the record-detail container, and
     * getActiveWorkspaceRoot() scores .forceRecordLayout as a candidate root — so on a layout
     * where it wins, the strip is not in the subtree we just read. On the many org layouts that
     * render Case Number and Status ONLY in the highlights, those fields then come back blank
     * while Product and Version sync fine, which reads as "the sync half works".
     *
     * The whole-document fallback above cannot rescue it: that only fires when NOT ONE label was
     * found. So widen by climbing towards the page one ancestor at a time, stopping the moment
     * the case is complete. Staying as close to the record as possible is the point — a console
     * routinely has several case tabs open, and jumping straight to the document would let a
     * background case's Status fill this case's blank. */
    let scannedLabels = fieldLabels;
    const incomplete = () => !data.caseNumber || !data.caseStatus || !data.subject;
    if (!rootFellBack && activeRoot !== document && incomplete()) {
        let scope = activeRoot.parentElement;
        for (let hops = 0; scope && hops < 6 && incomplete(); hops++) {
            const wider = findInShadows(FIELD_LABEL_SELECTOR, scope, false);
            if (wider.length > scannedLabels.length) {
                scannedLabels = wider;
                readFields(wider);
            }
            scope = scope.parentElement;
        }
    }

    /* THE NPS AVERAGES, and then INTO npsScores with everything else.
     *
     * The closure directive asks one question of "the NPS scores" and these are two of them,
     * so they are merged into the same list the record fields fill — a rule that reads a
     * list and a reader that keeps some scores outside it is how a case with an N/A average
     * closes as though its NPS were fine. They are ALSO kept on their own for the panel.
     * Guarded on the label so a layout that exposes the same average as a record field too
     * cannot record it twice under two spellings. */
    data.npsAverages = readNpsAverages(activeRoot);
    for (const spec of NPS_AVERAGE_FIELDS) {
        const value = data.npsAverages[spec.key];
        if (!value) continue;
        const already = data.npsScores.find(s => spec.re.test(s.label));
        if (already) already.value = already.value || value;
        else data.npsScores.push({ label: spec.label, value });
    }

    data.caseUrl = findCaseRecordUrl(data.caseNumber);

    // Fallback for a layout whose JIRA label we do not recognise — or one where the label we did
    // recognise turned out not to be the number field. An MCMR-##### value is a SOTI engineering
    // defect key and nothing else on a case is shaped like it, so the field holding one IS the
    // JIRA number. Deliberately anchored to MCMR rather than a generic PROJ-123 shape, which
    // would also match order numbers and asset tags.
    if (!jiraNumberIsKey) {
        for (const label of scannedLabels) {
            const val = (getFieldValue(label) || '').trim();
            if (/^MCMR-\d+$/i.test(val)) { data.jiraNumber = val.toUpperCase(); break; }
        }
    }

    // Fallback: Try the page header for Case Number
    if (!data.caseNumber) {
        const headerTitle = document.querySelector('lightning-formatted-text[slot="primaryField"], .slds-page-header__title .uiOutputText');
        if (headerTitle) {
            const val = headerTitle.textContent.trim();
            if (/^\d{6,}$/.test(val)) data.caseNumber = val;
        }
    }

    // Drive the feed's lazy-loading to the end BEFORE reading it, otherwise we
    // only capture the newest posts. Failures here are non-fatal: we fall through
    // and scrape whatever is already rendered.
    if (loadFullFeed) {
        // OPEN THE FEED TAB FIRST — and only here, once every field above has been
        // read. Salesforce unmounts the sub-tab being left, so doing this any earlier
        // would trade an empty email chain for empty case fields. A case already on
        // its Feed is left untouched (see activateFeedTab).
        try {
            data.feedTab = await activateFeedTab(activeRoot);
            if (data.feedTab.clicked) {
                console.log('SOTI AI Analyser: opened the case Feed tab', data.feedTab);
            }
        } catch (e) {
            console.warn('SOTI AI Analyser: could not open the Feed tab, reading whatever is on screen', e);
        }
        try {
            data.feedLoad = await loadEntireFeed(activeRoot);
            console.log('SOTI AI Analyser: Feed load complete', data.feedLoad);
        } catch (e) {
            console.warn('SOTI AI Analyser: Feed auto-load failed, scraping visible posts only', e);
        }
    }

    // Attempt to capture Email Chain / Feed.
    // FEED_ITEM_SELECTOR, not 'article.cuf-feedItem' alone. The feed LOADER counts posts with the
    // full selector (it matches cuf-feedElement too), so on a view that renders the element form
    // the loader scrolled the entire case to the bottom and then this line matched NOTHING —
    // the case scrolled, and not one message came back. The two must use the same selector or the
    // scrape silently disagrees with the thing that just did the work.
    let feedItems = findInShadows(FEED_ITEM_SELECTOR, activeRoot, false);
    // Same reasoning as the field labels: never let a bad root guess be the reason a case with a
    // visible feed syncs as empty.
    if (!feedItems.length && activeRoot !== document) {
        feedItems = findInShadows(FEED_ITEM_SELECTOR, document, false);
    }
    data.feedItemCount = feedItems.length;

    /* WHEN THE CASE LAST MOVED, AND WHEN WE LAST MOVED IT.
     *
     * Read from the same rendered feed the chain comes from, so it costs one pass over
     * posts that are already on screen. Wrapped: a timestamp this build cannot parse must
     * cost the sync nothing — every field it fills is optional and the panel says "not
     * known" rather than showing a number it invented.
     */
    try {
        const activity = readFeedActivity(activeRoot, {
            owner: data.caseOwner,
            // Everything the feed will be compared against, so "is this ours" has the case's
            // own people to check rather than a global guess.
            contact: data.contactName,
            limit: 60
        });
        data.lastMessageAt = activity.lastMessageAt;
        data.lastMessageLabel = activity.lastMessageLabel;
        data.lastMessageFrom = activity.lastMessageFrom;
        data.lastReachOutAt = activity.lastReachOutAt;
        data.lastReachOutLabel = activity.lastReachOutLabel;
        data.lastReachOutFrom = activity.lastReachOutFrom;
        data.activityRead = {
            items: activity.itemsRead, dated: activity.dated,
            classified: activity.classified, user: activity.user, reason: activity.reason
        };
        /* WHAT IS ATTACHED TO THOSE EMAILS — links only, nothing fetched. The panel offers
         * them to the engineer after the sync and downloads only what they choose. Wrapped
         * separately from the activity read above so a layout this cannot parse costs the
         * sync nothing: an empty list means "none offered", which is what happened before
         * this existed. */
        try {
            data.attachments = readFeedAttachments(activeRoot);
        } catch (e) {
            console.warn('SOTI AI Analyser: could not read the feed attachments', e);
        }
    } catch (e) {
        console.warn('SOTI AI Analyser: could not read case activity', e);
    }

    // Declared out here, not in the block below, because the diagnostics at the end of this
    // function report them.
    let commentsSeen = 0;
    let commentsOrphaned = 0;

    if (feedItems.length > 0) {
        // innerText, then textContent. innerText is the better read — it respects line breaks the
        // way the post is laid out — but it is the RENDERED text, so it comes back EMPTY for
        // anything the page has hidden with CSS. Salesforce hides plenty (see the summary line
        // below, which was already reading textContent for exactly this reason), and a post that
        // expandFeedPosts could not open is hidden by definition. Reading innerText alone loses
        // those messages silently: the feed is found, the post is counted, and its body is blank.
        const readText = (el) => {
            if (!el) return '';
            const rendered = typeof el.innerText === 'string' ? el.innerText.trim() : '';
            return rendered || (el.textContent || '').trim();
        };

        // Replies are gathered ONCE, from the scrape root, and grouped by the post they
        // answer — see collectFeedComments. Doing it per item would re-assume the reply is
        // inside the article, which is the assumption that made this miss them entirely.
        const collected = collectFeedComments(feedItems, activeRoot, readText);
        const commentsByItem = collected.byItem;
        commentsSeen = collected.stats.attached;
        commentsOrphaned = collected.stats.orphaned;

        const chain = feedItems.slice(0, 700).map(item => {
            // Target the header columns specifically
            const leftCol = item.querySelector('.preamble_left');
            const rightCol = item.querySelector('.preamble_right');

            const sender = readText(leftCol) || 'Unknown';
            const time = readText(rightCol);

            // Identify type using attributes and icons
            const typeAttr = item.getAttribute('data-type') || '';
            const hasCallIcon = item.querySelector('.slds-icon-standard-log-a-call, [title*="Call"]');
            const itemText = readText(item);
            const isInternal = itemText.includes('Internal') ||
                readText(item.querySelector('.preamble_custom-preamble')).includes('Internal');

            let typePrefix = '';
            if (typeAttr.includes('Call') || hasCallIcon) typePrefix = '[CALL LOG] ';
            else if (isInternal) typePrefix = '[INTERNAL] ';

            // Collect content from all possible body locations
            const summary = readText(item.querySelector('.preamble_custom-summary'));
            const emailBody = readText(item.querySelector('.emailMessageBody'));
            const callBody = readText(item.querySelector('.logCallDescription'));
            // Scoped past the replies. A comment's body carries the SAME classes as a
            // post's, so on a post with no body of its own — an attachment-only note, a
            // record-change entry — this used to return the first REPLY's text and file it
            // under the post's author. Harmless while replies were invisible; a duplicate
            // now that they are read separately, and one attributed to the wrong person.
            const postBodyEl = Array.from(item.querySelectorAll('.forceChatterFeedBodyText, .feedBodyInner'))
                .find(el => !el.closest(FEED_COMMENT_SELECTOR));
            const postBody = readText(postBodyEl);
            
            // Special check for EmailMessageEvent rich text attributes
            const richTextEl = item.querySelector('emailui-rich-text-output');
            let richText = '';
            if (richTextEl && richTextEl.getAttribute('value')) {
                const raw = richTextEl.getAttribute('value');
                // Simple HTML-to-text conversion for the encoded value
                richText = raw.replace(/<[^>]*>/g, ' ')
                             .replace(/&nbsp;/g, ' ')
                             .replace(/&quot;/g, '"')
                             .replace(/&lt;/g, '<')
                             .replace(/&gt;/g, '>')
                             .trim();
            }

            // Prefer the longest content to avoid truncated summaries
            let content = [emailBody, callBody, postBody, richText, summary]
                .filter(Boolean)
                .sort((a, b) => b.length - a.length)[0] || '';

            const comments = commentsByItem.get(item) || [];

            // The guard is now "did this item say ANYTHING", not "did the post body".
            // A note whose own body is empty but which carries three replies is one of
            // the most useful items in the feed, and the old test dropped the whole
            // article — post, replies and all — because the first half came back short.
            if (content.length < 5 && !comments.length) return null;

            const head = content.length >= 5
                ? `[${time}] ${typePrefix}${sender}:\n${content}`
                : `[${time}] ${typePrefix}${sender}:`;
            return comments.length
                ? `${head}\n\n${formatFeedComments(comments)}`
                : head;
        }).filter(Boolean).join('\n\n' + '='.repeat(40) + '\n\n');
        
        if (chain) data.emailChain = chain;
    }

    // Fallback: If feed scraping failed, try broader selectors
    if (!data.emailChain) {
        const emailSelectors = [
            '.email-body',
            '.email-thread-view',
            '.forceChatterEmailMessageBody',
            '.forceChatterFeedItemBody',
            '.slds-feed__item-content',
            'lightning-formatted-rich-text.email-message-body',
            '.email-message-body',
            '.email-thread-item',
            '.email-item-body'
        ];
        
        let emailItems = findInShadows(emailSelectors.join(', '), activeRoot, false);
        if (!emailItems.length && activeRoot !== document) {
            emailItems = findInShadows(emailSelectors.join(', '), document, false);
        }
        if (emailItems.length > 0) {
            const seen = new Set();
            data.emailChain = emailItems
                .slice(0, 700)
                .map(item => {
                    const rendered = typeof item.innerText === 'string' ? item.innerText.trim() : '';
                    return rendered || (item.textContent || '').trim();
                })
                .filter(txt => {
                    if (txt.length < 40 || seen.has(txt.slice(0, 100))) return false;
                    seen.add(txt.slice(0, 100));
                    return true;
                })
                .join('\n\n' + '='.repeat(40) + '\n\n');
        }
    }

    // WHY A SYNC CAME BACK EMPTY. Without this the panel could only say "nothing happened",
    // which is indistinguishable from the button not working — the shape the original report
    // arrived in. These are facts about what was actually looked at, so the panel can tell an
    // engineer whose tab is not a case apart from one whose LAYOUT was not understood.
    data.diagnostics = {
        onCasePage: !!(data.caseNumber || /\/lightning\/r\/Case\//i.test(location.pathname) ||
                       /[?&]id=500/i.test(location.search) || /\/500[A-Za-z0-9]{12,15}/.test(location.pathname)),
        labelsSeen: scannedLabels.length,
        feedItemsSeen: feedItems.length,
        // Replies read, and replies read but attached to no post. Zero seen on a case that
        // visibly has replies says the layout changed, not that the case is quiet — which
        // is the one thing this scraper cannot work out for itself. A non-zero orphan count
        // says the opposite: they were found and read, and the association is what failed.
        feedCommentsSeen: commentsSeen,
        feedCommentsOrphaned: commentsOrphaned,
        rootFellBack,
        rootWasDocument: activeRoot === document,
        href: (location.href || '').split('?')[0]
    };

    return data;
}

/* ===========================================================================
 *  JIRA (server / Data Center) ISSUE SCRAPE
 * ---------------------------------------------------------------------------
 *  Reads the classic JIRA issue view on jira.soti.net. Every value is taken
 *  from the ids JIRA has used for years (#type-val, #priority-val, the
 *  li[id^="rowForcustomfield_"] rows, #attachment_thumbnails, the comment
 *  blocks) with a fallback wherever one exists, because a field that is not on
 *  the layout must leave a blank rather than throw and lose the whole scrape.
 * ========================================================================= */

// A value cell carries inline "Edit" affordances and a "(4)" expander that are
// chrome, not content. Strip them, then collapse whitespace: JIRA pretty-prints
// its markup, so the raw textContent is full of newlines and runs of spaces.
function jiraFieldText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll(
        '.overlay-icon, .aui-iconfont-edit, .shortener-expand, .assign-to-me-link, ' +
        '.user-hover-trigger, script, style, img'
    ).forEach(n => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim().replace(/[,\s]+$/, '');
}

function scrapeJira() {
    const data = {
        key: '', summary: '', status: '', type: '', priority: '', resolution: '',
        fixVersions: '', affectsVersions: '', components: '', labels: '',
        assignee: '', reporter: '', watchers: '',
        fields: [], attachments: [], comments: [], digest: ''
    };
    const one = (sel) => jiraFieldText(document.querySelector(sel));

    // --- Key. #key-val is the canonical element; the URL and the hidden <h2>
    // ("[MCMR-42071] summary") are the fallbacks for layouts that drop it.
    data.key = one('#key-val');
    if (!data.key) {
        const fromUrl = location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
        if (fromUrl) data.key = fromUrl[1].toUpperCase();
    }
    let headline = '';
    for (const h2 of document.querySelectorAll('h2')) {
        const m = (h2.textContent || '').trim().match(/^\[([A-Z][A-Z0-9]+-\d+)\]\s*([\s\S]+)$/i);
        if (m) { if (!data.key) data.key = m[1].toUpperCase(); headline = m[2].trim(); break; }
    }
    data.summary = one('#summary-val') || headline;

    // --- Workflow state. #status-val is the badge; the transitions button
    // ("Plan Queue") carries it on boards that render the workflow instead.
    data.status = one('#status-val') || one('#opsbar-transitions_more .dropdown-text');

    data.type = one('#type-val');
    data.priority = one('#priority-val');
    data.resolution = one('#resolution-val');
    data.fixVersions = one('#fixfor-val');
    data.affectsVersions = one('#versions-val');
    data.components = one('#components-val');
    data.assignee = one('#assignee-val');
    data.reporter = one('#reporter-val');
    data.watchers = one('#watcher-data');

    const labels = Array.from(document.querySelectorAll('#wrap-labels .labels li, .labels-wrap .labels li'))
        .map(li => jiraFieldText(li)).filter(Boolean);
    data.labels = labels.join(', ');

    // --- Custom fields: Salesforce Case #, MC Hosted, Workaround exists,
    // Customer Phase, Found In Build # and friends all live in these rows.
    document.querySelectorAll('li[id^="rowForcustomfield_"]').forEach(li => {
        const label = jiraFieldText(li.querySelector('.name label') || li.querySelector('.name')).replace(/:$/, '');
        const value = jiraFieldText(li.querySelector('[id$="-val"]'));
        if (label && value) data.fields.push({ label, value });
    });

    document.querySelectorAll('#attachment_thumbnails li.attachment-content').forEach(li => {
        const name = jiraFieldText(li.querySelector('.attachment-title'));
        if (!name) return;
        data.attachments.push({
            name,
            size: jiraFieldText(li.querySelector('.attachment-size')),
            date: jiraFieldText(li.querySelector('.attachment-date'))
        });
    });

    // --- Comments. Each block renders TWICE — a "verbose" copy and a "concise"
    // one — so read only the verbose half or every comment arrives doubled.
    document.querySelectorAll('#issue_actions_container .activity-comment, .issuePanelContainer .activity-comment')
        .forEach(block => {
            const verbose = block.querySelector('.twixi-wrap.verbose') || block;
            const bodyEl = verbose.querySelector('.action-body');
            if (!bodyEl) return;
            const body = (bodyEl.innerText || bodyEl.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
            if (!body) return;
            const dateEl = verbose.querySelector('.action-details .date, .action-details time');
            data.comments.push({
                author: jiraFieldText(verbose.querySelector('.action-details a.user-hover')),
                when: (dateEl && (dateEl.getAttribute('title') || dateEl.getAttribute('datetime'))) || jiraFieldText(dateEl),
                body: body.slice(0, 4000)
            });
        });
    data.comments = data.comments.slice(0, 300);

    data.digest = buildJiraDigest(data);
    return data;
}

// One readable block for the JIRA Details field. Same shape as the Salesforce
// email chain — "[when] Who:" then the text — so a chain and a JIRA thread read
// the same way whether a human or the model is doing the reading.
function buildJiraDigest(d) {
    const out = [];
    const head = [d.key, d.summary].filter(Boolean).join(' — ');
    if (head) out.push(head);

    const line = (label, value) => { if (value) out.push(`${label}: ${value}`); };
    line('Status', d.status);
    line('Type', d.type);
    line('Priority', d.priority);
    line('Resolution', d.resolution);
    line('Affects Version/s', d.affectsVersions);
    line('Fix Version/s', d.fixVersions);
    line('Component/s', d.components);
    line('Labels', d.labels);
    line('Assignee', d.assignee);
    line('Reporter', d.reporter);
    line('Watchers', d.watchers);
    d.fields.forEach(f => line(f.label, f.value));

    if (d.attachments.length) {
        out.push('', `ATTACHMENTS (${d.attachments.length})`);
        d.attachments.forEach(a => out.push(`- ${a.name}${a.size ? ` (${a.size}` : ''}${a.date ? `, ${a.date})` : (a.size ? ')' : '')}`));
    }
    if (d.comments.length) {
        out.push('', `COMMENTS (${d.comments.length}, newest first)`);
        d.comments.forEach(c => {
            out.push('', `[${c.when || 'no date'}] ${c.author || 'Unknown'}:`);
            out.push(c.body);
        });
    }
    return out.join('\n').trim();
}

// Listen for requests from the side panel
/* ---------------------------------------------------------------------------
 * THE OPEN-CASE LIST (Salesforce list view, e.g. "My Open Cases")
 * ---------------------------------------------------------------------------
 * A different shape of page from a case record, and a much friendlier one: the
 * Lightning datatable labels every cell with data-label="Case Number", "Subject",
 * "Status" and so on, so the columns are read by NAME rather than by position.
 * That matters because the engineer chooses their own columns and order — reading
 * the 5th cell would work until someone dragged a column.
 *
 * Rows are read from the DOM, so this reflects the list view as displayed: the
 * filter, the sort and the row limit are whatever Salesforce is showing. That is
 * the intended behaviour — "my open cases" means the list the engineer curated,
 * not every case in the org.
 * ------------------------------------------------------------------------- */
const CASE_ROW_SELECTOR = 'tr[data-row-key-value]';

/* ---------------------------------------------------------------------------
 * THE OTHER GRID SALESFORCE SHIPS
 * ---------------------------------------------------------------------------
 * Everything above assumes the LWC datatable, where a row is `tr[data-row-key-value]` and
 * every cell names its own column with `data-label="Case Number"`. That is what a CASE list
 * view renders. It is not what a KNOWLEDGE list view renders.
 *
 * Knowledge is still served by the older Aura component — `forceListViewManager` around a
 * `table.uiVirtualDataTable` — and that grid has neither attribute. Its rows carry no key and
 * its cells carry no labels at all; the only thing linking a cell to a column is its POSITION
 * under the header row:
 *
 *     <thead><tr><th title="Article Title"> <th title="Summary"> …
 *     <tbody><tr><th scope="row">…</th> <td>…</td> …
 *
 * That single difference is the whole of the "Sync knowledge" bug. Both list views opened
 * perfectly and then matched zero rows, so the scrape returned an empty array and the panel
 * could only conclude the list views did not exist.
 *
 * So: a row selector that is the union of the two shapes, and a cell reader that falls back
 * from the label to the position. The case path is untouched — an LWC row still resolves its
 * cells by name on the first try and never reaches the positional code.
 * ------------------------------------------------------------------------- */
const AURA_ROW_SELECTOR = 'table.uiVirtualDataTable > tbody > tr';
const LIST_ROW_SELECTOR = `${CASE_ROW_SELECTOR}, ${AURA_ROW_SELECTOR}`;

/* THE HEADER ROW READ ONCE PER GRID.
 *
 * Resolving a column by position means reading the header, and a list view scrape asks for
 * eight columns on every one of up to two thousand rows. Walking the header sixteen thousand
 * times for an answer that cannot change between rows is the kind of cost that turns a scrape
 * into a visible freeze, so it is cached against the table element — and keyed on the header
 * ROW as well, because Aura replaces the whole grid when the list re-renders and a stale map
 * would then point every column one place to the left.
 */
const AURA_COLUMN_CACHE = new WeakMap();

function auraGridColumns(row) {
    const table = row && row.closest ? row.closest('table') : null;
    if (!table) return null;
    const headRow = table.querySelector('thead > tr');
    if (!headRow) return null;

    const cached = AURA_COLUMN_CACHE.get(table);
    if (cached && cached.headRow === headRow) return cached.byLabel;

    const byLabel = new Map();
    const heads = headRow.children;
    for (let i = 0; i < heads.length; i++) {
        const th = heads[i];
        /* title and aria-label are where Salesforce puts the column NAME, and they are clean.
         * The visible text is the fallback and it is not: the header also contains the sort
         * link's assistive text and the column-actions menu, so a raw textContent read of the
         * Article Title header returns "SortArticle TitleSorted AscendingShow Article Title
         * Column Actions". Hence the narrow span selector, and the attributes first. */
        let name = (th.getAttribute('title') || th.getAttribute('aria-label') || '').trim();
        if (!name) {
            const span = th.querySelector('.slds-th__action .slds-truncate, .slds-truncate');
            name = ((span && span.textContent) || '').trim();
        }
        name = normaliseLabel(name);
        // First one wins: the two leading columns (the error marker and the select-all
        // checkbox) are unnamed, and a duplicate label later in the header is a column the
        // engineer added twice — either way the leftmost is the one being shown.
        if (!name || byLabel.has(name)) continue;
        byLabel.set(name, i);
    }
    AURA_COLUMN_CACHE.set(table, { headRow, byLabel });
    return byLabel;
}

/* THE CELL FOR ONE COLUMN, on whichever of the two grids this row belongs to. */
function listCellElement(row, label) {
    if (!row || !label) return null;
    // The LWC datatable, where the cell names its own column.
    try {
        const named = row.querySelector(`[data-label="${String(label).replace(/"/g, '\\"')}"]`);
        if (named) return named;
    } catch (e) { /* a label with a quote in it is not a selector — fall through */ }
    // The Aura grid, where it does not.
    const cols = auraGridColumns(row);
    if (!cols) return null;
    const at = cols.get(normaliseLabel(label));
    if (at == null) return null;
    return row.children[at] || null;
}

/* WHITESPACE ONLY — the cleaner for a cell whose value is PROSE.
 *
 * cleanFieldValue is calibrated for case-list columns: it cuts the value at the first
 * occurrence of "Open", "Preview", "Edit", "Close" or "Show Actions" and then deletes the
 * words "Account", "Contact" and "Subject" outright, because on a case row those are button
 * names and column headings glued to the value by Lightning's markup.
 *
 * On a Knowledge title they are the value. Run through it, real articles in the list come back
 * as:
 *
 *     "Administrator Cannot Edit User Passwords"          → "Administrator Cannot"
 *     "Add or Remove Email Accounts From Android …"       → "Add or Remove Email s From …"
 *     "Enabling a Contact for Customer Portal"            → "Enabling a  for Customer Portal"
 *
 * — silently, and the corrupted title is then what gets stored, searched, ranked and quoted.
 * So Knowledge cells are read through this instead: collapse whitespace, nothing else.
 */
function cleanCellText(raw) {
    return String(raw || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/*
 * HOW MANY CASES THE LIST SAYS IT HAS.
 *
 * Salesforce prints it above the table — "27 items • Sorted by Status • …" — which turns the
 * scroll loop below from "keep going until nothing new appears" into "keep going until you
 * have them all", and lets the panel say *27 of 27* rather than hoping.
 *
 * Returns null when there is no number to read, or when the count is capped ("50+ items"):
 * a "+" means Salesforce is not telling us the total either, so treating 50 as the target
 * would stop the scroll early on exactly the long lists that need it most.
 */
function declaredCaseCount(root) {
    // textContent, NOT aria-label. On this element Salesforce puts the LIST NAME in the
    // aria-label ("My Open Cases") and the count in the text ("27 items • Sorted by …"), so
    // preferring the label reads the name and finds no number at all.
    // Several selectors, first number wins. The status line is rendered by a different
    // component depending on how the list view was reached (a tab, a related list, the
    // App Launcher), and a single selector that missed simply returned null — which
    // downgrades the scroll below from "keep going until you have all 30" to "keep going
    // until nothing new turns up", the weaker of the two stopping rules.
    const els = (root || document).querySelectorAll(
        '.countSortedByFilteredBy, force-list-view-manager-status-info, '
        + '.slds-page-header__meta-text, [class*="countSortedByFilteredBy"]');
    for (const el of els) {
        const text = (el && el.textContent) || '';
        const m = text.match(/([\d,]+)\s*\+?\s*items?/i);
        if (!m) continue;
        if (/[\d,]+\s*\+/.test(m[0])) continue;     // "50+" — an unknown total, not a total
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

/*
 * "100+ ITEMS" IS NOT A TOTAL, BUT IT IS A FLOOR.
 *
 * declaredCaseCount above refuses a capped count outright, and it is right to: treating the
 * 100 in "100+ items" as the total would stop a scroll the moment the first page of rows
 * landed, on exactly the lists long enough to be capped.
 *
 * Thrown away entirely, though, it costs the other half of the same sentence. Salesforce is
 * saying there are MORE than a hundred — so a loader that has a hundred rows and no new ones
 * arriving has not reached the end of the list, it has reached the end of a PAGE, and the
 * only correct thing to do is keep asking. That is the difference between a knowledge base
 * synced at 100 articles and one synced at 240.
 *
 * Returns { exact, atLeast }: `exact` is declaredCaseCount's answer and means stop here,
 * `atLeast` is the floor and means do not stop before here.
 */
function declaredListSize(root) {
    const exact = declaredCaseCount(root);
    let atLeast = null;
    const els = (root || document).querySelectorAll(
        '.countSortedByFilteredBy, force-list-view-manager-status-info, '
        + '.slds-page-header__meta-text, [class*="countSortedByFilteredBy"]');
    for (const el of els) {
        const text = (el && el.textContent) || '';
        const m = text.match(/([\d,]+)\s*\+\s*items?/i);
        if (!m) continue;
        const n = parseInt(m[1].replace(/,/g, ''), 10);
        if (Number.isFinite(n) && n > 0) { atLeast = Math.max(atLeast || 0, n); }
    }
    return { exact, atLeast };
}

/*
 * THE DATATABLE'S OWN SCROLL BOX.
 *
 * A Lightning list view does NOT scroll the window: the grid sits inside
 * `<div class="slds-scrollable_y">` and that div is the thing with a scrollbar. The
 * ancestor-chain sweep below finds it too, but only on a pass where it is already
 * overflowing — and on a list that has not overflowed yet (or whose overflow is set by a
 * stylesheet the computed-style probe reads late) it is skipped, so nothing scrolls and
 * the infinite loader never fires. Naming it outright removes that dependency.
 */
function caseListScroller(row) {
    if (!row) return null;
    let el = row.parentElement;
    while (el && el !== document.body) {
        const c = el.classList;
        // slds-scrollable* is the LWC datatable's box. uiScroller / scroller-wrapper is the
        // Aura grid's — a Knowledge list view has no slds-scrollable anywhere in it, so
        // without this the KB scrape only ever sees the first screenful of articles.
        if (c && (c.contains('slds-scrollable_y') || c.contains('slds-scrollable')
                  || c.contains('uiScroller') || c.contains('scroller-wrapper'))) return el;
        el = el.parentElement;
    }
    return null;
}

/*
 * THE GRID AS A WHOLE — scroll box, header, and the spinner that covers them while a page
 * of rows is in flight.
 *
 * Narrower than the page and wider than the scroll box, because the datatable's loading
 * spinner sits on one side of that boundary or the other depending on the layout: sometimes
 * inside `.slds-scrollable_y` under the last row, sometimes as its sibling in the component
 * root. Watching only the scroll box misses half of them; watching the whole document picks
 * up spinners belonging to every other component on the page.
 */
function caseListRegion(box) {
    if (!box) return null;
    const near = box.closest('lightning-datatable, .slds-table_header-fixed_container, '
        + '.listViewContent, force-list-view-manager, .forceListViewManager, '
        + '.forceListViewManagerGrid, .forceListViewManagerPrimaryDisplayManager')
        || box.parentElement
        || box;
    /* ON THE AURA GRID THE SPINNER IS OUTSIDE THE NEAREST MATCH, and `closest` returns the
     * nearest by definition. A Knowledge list view nests like this:
     *
     *     .forceListViewManagerPrimaryDisplayManager
     *       .slds-spinner_container            <-- the "fetching the next page" spinner
     *       .forceListViewManagerGrid
     *         .listViewContent                 <-- what `closest` stops at
     *           .uiScroller                    <-- box
     *
     * So the scope handed to waitWhileFetching contained no spinner at all, every round
     * decided the fetch had already finished, and the loader gave a grid that was still
     * loading about half a second to produce rows before calling the list ended. Climbing to
     * the display manager puts the spinner back in view. The LWC path is untouched: a case
     * list has none of these classes, so `near` is returned exactly as before. */
    const isAuraGrid = !!(near.querySelector && near.querySelector('table.uiVirtualDataTable'));
    if (!isAuraGrid) return near;
    const outer = near.closest && near.closest(
        '.forceListViewManagerPrimaryDisplayManager, .forceListViewManager, force-list-view-manager');
    return outer || near;
}

/* THE LIST VIEW'S OWN REFRESH BUTTON.
 *
 * Matched by `name="refreshButton"` first, which is what Lightning actually puts on it and
 * the one attribute that is neither localised nor layout-dependent. The title and the
 * assistive text are the fallbacks, and they are matched only inside the list's header
 * region: "Refresh" is a common enough word that a page-wide search for it would eventually
 * find somebody else's button and press it.
 *
 * Returns null rather than guessing. The caller degrades to syncing what is on screen, which
 * is what it did before this existed.
 */
const LIST_REFRESH_SELECTOR = 'button[name="refreshButton"], lightning-button-icon[name="refreshButton"]';

function findListRefreshButton(root) {
    const scope = root || document;

    // The unambiguous one, anywhere on the page — the name is ours to trust.
    for (const el of findInShadows(LIST_REFRESH_SELECTOR, scope, false)) {
        const btn = el.tagName === 'BUTTON' ? el : (el.querySelector && el.querySelector('button')) || el;
        if (btn && isVisible(btn)) return btn;
    }

    /* NAME-LESS LAYOUTS. Some orgs render the action bar through an older component that
     * carries only a title. Confined to the list header so a "Refresh" elsewhere on the page
     * — a related list, a report chart, a dashboard tile — cannot be picked up instead. */
    const headers = scope.querySelectorAll(
        '.slds-page-header, .listViewContainer, force-list-view-manager-header, '
        + '.forceListViewManagerHeader, [class*="listViewManagerHeader"]');
    for (const header of headers) {
        for (const btn of header.querySelectorAll('button, [role="button"]')) {
            const label = ((btn.getAttribute && (btn.getAttribute('title') || btn.getAttribute('aria-label'))) || '')
                + ' ' + ((btn.querySelector('.slds-assistive-text') || {}).textContent || '');
            if (!/^\s*refresh\s*$/i.test(label.replace(/\s+/g, ' ').trim())) continue;
            if (isVisible(btn)) return btn;
        }
    }
    return null;
}

/*
 * IS SALESFORCE STILL FETCHING THE NEXT PAGE OF ROWS?
 *
 * This is the difference between reading 30 cases and reading 25. The loop used to scroll,
 * sleep a fixed 550ms, and count: if the server took longer than that — and on a list view
 * with twenty columns it routinely does — the count came back unchanged, three times in a
 * row inside two seconds, and the loader concluded the list had ended. It had not. It was
 * still loading, which the page says out loud with a spinner.
 *
 * So wait for the spinner instead of guessing. Only VISIBLE spinners count: Salesforce
 * leaves hidden `.slds-spinner_container` nodes lying around the page, and treating those
 * as "still loading" would stall every sync until the time budget ran out.
 */
function listIsFetching(scope) {
    const els = (scope || document).querySelectorAll(
        'lightning-spinner, .slds-spinner_container, .slds-spinner, .forceInlineSpinner');
    for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        return true;
    }
    return false;
}

// Bounded: a spinner that never resolves must not hold the sync open forever. Returns
// true if it cleared, false if we gave up on it — either way the caller carries on.
async function waitWhileFetching(scope, maxMs, stepMs = 250) {
    const until = Date.now() + maxMs;
    if (!listIsFetching(scope)) return true;
    while (Date.now() < until) {
        await sleep(stepMs);
        if (!listIsFetching(scope)) return true;
    }
    return false;
}

/*
 * SCROLL THE LIST VIEW UNTIL EVERY CASE IS IN THE DOM.
 *
 * A Lightning list view is virtualised: it renders about the first 25 rows and fetches more
 * only when you scroll near the bottom. The scraper reads the DOM, so without this it reads
 * whatever happened to be rendered — a 30-case queue silently syncs as 25, and nothing about
 * the result looks wrong. Same failure the case feed had, same fix.
 *
 * Two things separate this from a scroll that stops early, and both are about the datatable
 * RE-RENDERING under us rather than appending to what is already there:
 *
 *   - The scroll targets are resolved fresh every round. Fetching a page can replace the
 *     grid's containers outright, and a chain captured once from the first row then points
 *     at detached nodes — every later `scrollTop = scrollHeight` writes to an element that
 *     is no longer on the page, so the list stops growing while the loop happily reports
 *     "no new rows".
 *   - Each round waits for the loading spinner to clear before it counts, instead of
 *     sleeping a fixed interval and hoping (see listIsFetching).
 *
 * The user's scroll position is restored afterwards: syncing should not move their page.
 */
async function loadWholeCaseList(root, opts = {}) {
    const {
        maxRounds    = 80,
        settleMs     = 700,    // pause after each scroll so Salesforce can start fetching
        fetchWaitMs  = 8000,   // how long to let one page of rows finish arriving
        stableRounds = 4,      // stop after this many rounds with no new rows
        maxMs        = 60000,
        /* WHICH ROWS. Defaulted to the case grid so nothing about the case path changes, and
         * a parameter because the Knowledge list view is the other grid entirely — its rows
         * match none of this selector, so a scroll loop that counted them would report
         * "no-rows-found" on a list of two thousand articles. */
        rowSelector  = CASE_ROW_SELECTOR
    } = opts;

    const scope = root || document;
    const countRows = () => scope.querySelectorAll(rowSelector).length;

    const first = scope.querySelector(rowSelector);
    if (!first) return { rows: 0, declared: declaredCaseCount(scope), rounds: 0, reason: 'no-rows-found' };

    // Where the engineer was, so we can put them back. Captured from the first row, which
    // is the one node in the grid that keeps a stable position across a re-render.
    const restoreChain = getAncestorChain(first);
    const originalTops = restoreChain.map(el => el.scrollTop);

    const declared = declaredCaseCount(scope);
    const started = Date.now();
    let previous = countRows();
    let stable = 0;
    let rounds = 0;
    let reason = 'exhausted-rounds';
    let spinnerStalled = false;

    // Already complete — a short list needs no scrolling at all.
    if (declared && previous >= declared) {
        return { rows: previous, declared, rounds: 0, reason: 'already-complete' };
    }

    while (rounds < maxRounds) {
        if (Date.now() - started > maxMs) { reason = 'time-budget'; break; }
        rounds++;

        // Re-read the rows every round: this is both the scroll target and the proof that
        // the nodes we are about to scroll are the ones currently on the page.
        const rows = scope.querySelectorAll(rowSelector);
        const last = rows[rows.length - 1];

        // Three ways at the same scrollbar, because different list-view layouts respond to
        // different ones and there is no cost to doing all three.
        if (last) scrollChainToBottom(getAncestorChain(last));
        const box = caseListScroller(last || first);
        if (box) box.scrollTop = box.scrollHeight;
        // Pulling the last row into view is what actually trips the datatable's
        // "enable-infinite-loading" observer on the layouts where scrollTop alone does not.
        try { last?.scrollIntoView({ block: 'end' }); } catch (_) {}

        // Give the observer a moment to fire, then wait out the fetch it started rather
        // than counting rows that are still in flight.
        //
        // Watch for the spinner INSIDE the grid, not across the whole page. A Salesforce case
        // list sits beside components with spinners of their own, and one of those left up —
        // a related list still loading, a chart refreshing — would otherwise mean every round
        // waits out the full fetch budget for a fetch that is not ours, and then reports a
        // complete list as "still loading". Falls back to the whole scope when the grid has
        // no scroll box we recognise, which is the layout where a wrong wait costs least.
        await sleep(settleMs);
        const fetchScope = caseListRegion(box) || scope;
        if (!(await waitWhileFetching(fetchScope, fetchWaitMs))) spinnerStalled = true;

        const current = countRows();
        if (declared && current >= declared) {
            previous = current;
            reason = 'all-rows-loaded';
            break;
        }
        if (current > previous) {
            previous = current;
            stable = 0;
            // Rows arrived, so whatever that spinner was doing, it finished. Clearing this
            // keeps "still-loading" meaning the LAST thing that happened rather than the
            // worst thing that ever happened — one slow page early on should not label an
            // otherwise complete sync as truncated.
            spinnerStalled = false;
        } else if (++stable >= stableRounds) {
            // A spinner that never cleared means the list was still working when we stopped
            // asking, which is a different answer from "the list has ended" and the panel
            // words it differently — see syncCaseListFromSalesforce.
            reason = spinnerStalled ? 'still-loading' : 'no-new-rows';
            break;
        }
    }

    /* PUT THE ENGINEER'S SCROLL POSITION BACK — in two passes, because the grid may have
     * been rebuilt underneath us while we scrolled.
     *
     * The first pass restores the containers that were on the page when we started. That is
     * the ordinary case and the only one that can be put back exactly. Writing to one that
     * has since been detached does nothing, which is fine.
     *
     * The second pass catches a scroller Salesforce CREATED during the scroll. There is no
     * "before" position for a node that did not exist, and the first pass cannot touch it —
     * so without this it keeps the position OUR scrolling left it at, parked at the foot of
     * the list. That is the sync visibly moving the page, which is the thing this block
     * exists to prevent. A list view opens at the top, so that is where it goes back to.
     */
    const wasThereBefore = new Set(restoreChain);
    restoreChain.forEach((el, i) => { try { el.scrollTop = originalTops[i]; } catch (_) {} });
    const currentFirst = scope.querySelector(rowSelector);
    if (currentFirst) {
        for (const el of getAncestorChain(currentFirst)) {
            if (wasThereBefore.has(el)) continue;
            try { if (isScrollable(el)) el.scrollTop = 0; } catch (_) {}
        }
    }
    return { rows: countRows(), declared, rounds, reason };
}

/* READ ONE CELL, and hand its value back scrubbed.
 *
 * `clean` is a parameter because the two list views need different amounts of scrubbing:
 * cleanFieldValue for the case columns, cleanCellText for Knowledge prose. See cleanCellText
 * for what happens to an article title run through the case cleaner.
 *
 * A CELL CONTAINS CONTROLS AS WELL AS DATA, and the controls are named.
 *
 * Salesforce drops a "Preview" icon button inside the Subject cell and a "Show Actions" menu
 * inside the last one. Both carry a title and assistive text, and both sit in the cell exactly
 * like the value does — so a plain "first element with a title" read returns the name of a
 * button. That is not hypothetical: every case in the Open Cases queue came back with the
 * subject "Preview", because the subject's own <a> is the one link in the table rendered
 * WITHOUT a title, so the fallback ran and found the Preview button first.
 *
 * So each step below skips anything that is part of a control, and the value is looked for in
 * order of how trustworthy it is.
 */
function listCellValue(cell, clean) {
    if (!cell) return '';

    const isControl = (el) => !!(el.closest
        && (el.closest('button, lightning-button-icon, lightning-button-menu, lightning-button-stateful, [role="button"], [role="menu"]')
            || (el.classList && el.classList.contains('slds-assistive-text'))));

    /* Each step below CONTINUES on an empty result rather than returning it. An `<a title="">`
     * — which is exactly what Salesforce renders for the row-actions link, and occasionally
     * for a lookup whose label has not resolved yet — would otherwise satisfy step one and
     * end the read with nothing, while the value sat in plain text two steps further down. */

    // 1. A titled link. The title is the CLEAN value — the visible text of the same link
    //    is ellipsised by .slds-truncate when the column is narrow.
    for (const a of cell.querySelectorAll('a[title]')) {
        if (isControl(a)) continue;
        const t = clean(a.getAttribute('title'));
        if (t) return t;
    }
    // 2. The record link's own text, for the Subject column, which has no title on it.
    for (const a of cell.querySelectorAll('a')) {
        if (isControl(a)) continue;
        const t = clean(a.textContent || '');
        if (t) return t;
    }
    // 3. Any other titled element — how Status, Priority and JIRA Number are rendered.
    for (const el of cell.querySelectorAll('[title]')) {
        if (isControl(el)) continue;
        const t = clean(el.getAttribute('title'));
        if (t) return t;
    }
    // 4. The cell's own text, with the control labels taken out first. Reading textContent
    //    raw would return "…Customer DevicesPreview" — the value with a button name glued
    //    to the end of it.
    let text = cell.textContent || '';
    if (cell.querySelector('.slds-assistive-text, button, lightning-button-icon, lightning-button-menu')) {
        const clone = cell.cloneNode(true);
        clone.querySelectorAll('.slds-assistive-text, button, lightning-button-icon, lightning-button-menu')
            .forEach(n => n.remove());
        text = clone.textContent || '';
    }
    return clean(text);
}

/* THE CASE LIST'S READER. Unchanged behaviour: resolve the column by its data-label and scrub
 * the value with the case cleaner. */
function caseListCell(row, label) {
    return listCellValue(listCellElement(row, label), cleanFieldValue);
}

/* THE KNOWLEDGE LIST'S READER — first of several column names that this org actually has, and
 * whitespace-only cleaning (see cleanCellText for why that distinction is not cosmetic). */
function kbListCell(row, labels) {
    for (const label of labels) {
        const v = listCellValue(listCellElement(row, label), cleanCellText);
        if (v) return v;
    }
    return '';
}

/* THE FIRST OF SEVERAL COLUMN NAMES THAT IS ACTUALLY IN THIS LIST VIEW.
 *
 * Engineers build their own list views, and the same fact goes by different column names in
 * each: the owner is "Case Owner" on one, "Case Owner Alias" on another, and on the list the
 * report came from it is only present as "Last Modified By Alias". Reading a single label
 * means the field is silently blank for everyone whose list view calls it something else.
 */
/* A CHECKBOX FIELD, read as 'yes' / 'no' / '' (could not be read).
 *
 * getFieldValue is built for fields whose value is TEXT, and every one of its steps looks for
 * some. A Salesforce checkbox has none: Lightning draws a ticked one as an `<img alt="True">`
 * or as a faux-checkbox span carrying only assistive text, and Classic as a checked
 * `<input type="checkbox">` that is disabled. So the generic reader returns '' for both states
 * and the caller cannot tell "unticked" from "this layout does not render it in a way I can
 * read" — which for the escalation trigger is the difference between closing a case normally
 * and skipping a mandatory recovery call.
 *
 * Hence the third state. '' means exactly what it says, and the panel reports it as unknown
 * rather than as false.
 */
function readCheckboxField(labelEl) {
    if (!labelEl) return '';
    // The value sits beside the label, inside the same form element on Lightning and in the
    // next cell on Classic. Walk out to whichever container holds both, then look inside it.
    let scope = labelEl.closest
        ? (labelEl.closest('.slds-form-element, records-record-layout-item, tr, .test-id__field') || labelEl.parentElement)
        : labelEl.parentElement;
    if (!scope) return '';

    // 1. A real input. Classic, and Lightning's edit mode.
    const box = scope.querySelector('input[type="checkbox"]');
    if (box) return box.checked ? 'yes' : 'no';

    // 2. Lightning's read-only rendering: an image whose alt IS the value.
    for (const img of scope.querySelectorAll('img')) {
        const alt = String((img.getAttribute && img.getAttribute('alt')) || '').trim().toLowerCase();
        if (alt === 'true' || alt === 'checked' || alt === 'yes') return 'yes';
        if (alt === 'false' || alt === 'unchecked' || alt === 'no') return 'no';
    }

    // 3. The faux checkbox, whose state is in its class or its assistive text.
    const faux = scope.querySelector('.slds-checkbox_faux, .slds-checkbox--faux, [role="checkbox"]');
    if (faux) {
        const aria = faux.getAttribute && faux.getAttribute('aria-checked');
        if (aria === 'true') return 'yes';
        if (aria === 'false') return 'no';
    }

    // 4. Some orgs render it as a plain picklist or text after all.
    const t = cleanFieldValue(scope.textContent || '').toLowerCase();
    if (/\b(true|yes|checked)\b/.test(t)) return 'yes';
    if (/\b(false|no|unchecked)\b/.test(t)) return 'no';
    return '';
}

function caseListCellAny(row, labels) {
    for (const label of labels) {
        const v = caseListCell(row, label);
        if (v) return v;
    }
    return '';
}

/* A CELL WHOSE VALUE IS A PICTURE.
 *
 * "Last Completed Activity Icon" is a formula field that renders a coloured dot as an <img>
 * served out of Salesforce's own file store:
 *
 *     <img src="/servlet/servlet.FileDownload?file=0150y0000039Kj1" alt="Green" …>
 *
 * caseListCell cannot read it, and not by accident: every one of its four steps looks for
 * TEXT, and this cell has none — the colour is in the alt attribute and the src is an opaque
 * file id that says nothing. So the cell came back empty and the column could not exist.
 *
 * The alt is the value, and it is the right thing to trust: it is what Salesforce puts there
 * for a screen reader, so it is the field's own word for the state rather than a colour this
 * file has decided to infer from an image. The title is a fallback for orgs that set one
 * instead, and the image FILE ID is the last resort — an org that ships the icons with no
 * alt text at all still has three distinct ids, so the colours can at least be told apart
 * even when they cannot be named.
 *
 * Normalised to one of green / yellow / red, and '' for anything else. An unrecognised value
 * is dropped rather than passed through: the panel paints this as a coloured dot, and a
 * colour it cannot map would paint as nothing while claiming the case had been read.
 */
const ACTIVITY_ICON_WORDS = [
    { key: 'green',  re: /\bgreen\b|\bon track\b|\bcurrent\b|\bok\b/i },
    { key: 'yellow', re: /\byellow\b|\bamber\b|\bwarn(?:ing)?\b|\bdue\b/i },
    { key: 'red',    re: /\bred\b|\boverdue\b|\bbreach|\blate\b/i }
];

function normaliseActivityIcon(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    for (const w of ACTIVITY_ICON_WORDS) if (w.re.test(t)) return w.key;
    return '';
}

function caseListIconCell(row, labels) {
    for (const label of labels) {
        const cell = listCellElement(row, label);
        if (!cell) continue;
        for (const img of cell.querySelectorAll('img')) {
            const named = normaliseActivityIcon(img.getAttribute('alt'))
                || normaliseActivityIcon(img.getAttribute('title'));
            if (named) return named;
        }
        // No alt and no title: fall back to the cell's own text, which some orgs render
        // instead of an image ("Green"), and only then give up on the row.
        const text = normaliseActivityIcon(cleanFieldValue(cell.textContent || ''));
        if (text) return text;
    }
    return '';
}

function scrapeSalesforceCaseList() {
    // CASE_ROW_SELECTOR, not a second copy of the same string. The loader counts rows to
    // decide when it has them all and this reads them; if the two ever disagreed the scroll
    // would report success over rows the scrape cannot see. The feed had exactly that bug.
    const rows = [...document.querySelectorAll(CASE_ROW_SELECTOR)];
    const out = [];
    for (const row of rows) {
        const caseNum = caseListCell(row, 'Case Number');
        if (!caseNum) continue;                       // header/spacer rows carry none
        const link = row.querySelector('[data-label="Case Number"] a');
        const href = link ? (link.getAttribute('href') || '') : '';
        let url = '';
        try { if (href) url = new URL(href, location.origin).href; } catch (e) { /* relative junk */ }
        out.push({
            recordId: row.getAttribute('data-row-key-value') || '',
            url,
            caseNum,
            subject:  caseListCell(row, 'Subject'),
            status:   caseListCell(row, 'Status'),
            priority: caseListCell(row, 'Case Priority'),
            account:  caseListCell(row, 'Account Name'),
            contact:  caseListCell(row, 'Contact Name'),
            jira:     caseListCell(row, 'JIRA Number'),
            // The support tier this case is entitled to. It is what decides which cases
            // are worked first, so the panel groups the queue by it.
            entitlement: caseListCell(row, 'Entitlement Name'),
            // Only present if the engineer put Description in their list view columns —
            // most do not, and then the panel fetches it per case from the record instead.
            // Free to try, and it saves a page load for every case when it is there.
            description: caseListCell(row, 'Description'),
            // What the case is ABOUT, for the panel's per-case expander. The list view's
            // own analysis column is the only prose it carries — the Salesforce
            // Description field is not one of these columns — and on a worked case it
            // opens with a written Case Summary, which is exactly the question the
            // expander answers. Empty on a case nobody has written up yet; the panel
            // falls back to the subject and says so.
            analysis: caseListCell(row, 'Case Analysis Comments'),
            ageDays:  caseListCell(row, 'Case Age (in days)'),
            opened:   caseListCell(row, 'Date/Time Opened'),
            modified: caseListCell(row, 'Last Modified Date'),
            /* WHOSE CASE IS THIS. Read through the alias names as well as the full ones,
             * because the alias columns are the ones most list views actually carry.
             *
             * "Last Modified By Alias" USED TO BE LAST IN THIS LIST, as a final fallback,
             * and it is not here any more: it is who touched the case, not who owns it, and
             * letting it answer to `owner` meant an editor's alias was stored as the owner
             * on every list view without an owner column. It has its own field below, the
             * queue's column reads that (see ocOwnerOf), and `owner` is now only ever an
             * owner. */
            owner: caseListCellAny(row, [
                'Case Owner', 'Case Owner: Full Name', 'Owner', 'Owner Full Name',
                'Assigned To', 'Case Owner Alias', 'Owner Alias'
            ]),
            /* WHO LAST TOUCHED IT — what the queue's "Modified by" column shows. The alias
             * first: it is the column the org's list views carry, and it is what fits. */
            lastModifiedBy: caseListCellAny(row, ['Last Modified By Alias', 'Last Modified By']),
            // Only if the engineer put it on their list view. Perpetual and Subscription both
            // mean an on-prem deployment; the panel reads that (see applyHostingFromLicence).
            licenseType: caseListCellAny(row, ['License Type', 'Licence Type', 'License Model']),
            /* THE GREEN / YELLOW / RED DOT. Salesforce's own judgement of how the last
             * completed activity on this case is ageing, and the one column on the list view
             * that is a picture rather than a value — see caseListIconCell. Read through
             * several names because the field is a formula and orgs label it differently;
             * blank when the list view does not carry it, and the panel then hides the
             * column rather than inventing a colour. */
            activityIcon: caseListIconCell(row, [
                'Last Completed Activity Icon', 'Last Completed Activity',
                'Activity Icon', 'Case Health', 'Health'
            ])
        });
    }
    // The list's own title, so the panel can say WHICH list these came from rather
    // than implying it holds every open case in Salesforce.
    const titleEl = document.querySelector('.slds-page-header__title, h1 .slds-page-header__title');
    return {
        listName: titleEl ? cleanFieldValue(titleEl.textContent || '') : '',
        // The org this list came from. Each row already carries its own absolute url, but
        // a row whose Case Number cell rendered without a link has only a recordId — and a
        // record id is useless without knowing which Salesforce to ask. Captured once here
        // rather than guessed later, because the org host differs per customer and a
        // hardcoded one would send someone to a login page for a org that is not theirs.
        origin: location.origin,
        scrapedAt: Date.now(),
        cases: out
    };
}

/* ----------------------------------------------------------------------------
 * READING SALESFORCE KNOWLEDGE
 * ----------------------------------------------------------------------------
 * A Knowledge list view is NOT the same component as a case list view, and that was the whole
 * of the bug this replaces. Cases render through the LWC datatable (labelled cells, keyed
 * rows); Knowledge renders through the older Aura grid, where a cell belongs to a column only
 * because of where it sits under the header. See AURA_ROW_SELECTOR — the row selector, the
 * scroll loader and the cell reader all now handle both shapes, so this file is still short.
 *
 * Column names vary by org (Knowledge is heavily customised almost everywhere), so every field
 * is read through a list of candidates rather than one name. A row with no title is not an
 * article; it is a spacer.
 * -------------------------------------------------------------------------- */

// The record link, and its id. Knowledge puts both on the title cell and again on the article
// number cell, and each is an <a data-recordid="ka2…"> — which is worth reading directly,
// because it is the ONE thing on the row that identifies the article no matter how the org
// has arranged its columns, and it still answers when the href did not render.
const KB_RECORD_LINK_SELECTOR = 'a[data-recordid][href*="/lightning/r/"], a[data-refid="recordId"][href*="/lightning/r/"], a[href*="/lightning/r/"]';

const KB_TITLE_LABELS  = ['Article Title', 'Title', 'Knowledge Title', 'Name', 'Master Version Title'];
const KB_NUMBER_LABELS = ['Article Number', 'ArticleNumber', 'Article #', 'Number'];
const KB_TYPE_LABELS   = ['Article Record Type', 'Record Type', 'Article Type', 'Type'];
// PUBLICATION status only. "Validation Status" is a different field with different values
// (Draft / Validated / Not Validated) and reading it as the publication status is how a
// published article ends up labelled "NOT PUBLISHED (Draft)" in the prompt.
const KB_STATUS_LABELS = ['Publication Status', 'Publish Status', 'Status'];
const KB_VALIDATION_LABELS = ['Validation Status'];
/* WHEN IT LAST CHANGED — the field that makes a re-sync incremental. An article whose date has
 * not moved does not need reading again. Several names, and the created date last: plenty of
 * Knowledge list views carry only "Article Created Date", which never moves — a weak signal,
 * but a real one for spotting an article that has been replaced by a newer version, and the
 * panel has a time-based fallback for lists that carry no date column at all. */
const KB_MODIFIED_LABELS = [
    'Last Modified Date', 'Last Published Date', 'Last Modified', 'Version Created Date',
    'Last Modified By Date', 'Article Created Date', 'Created Date'
];
const KB_SUMMARY_LABELS = ['Summary', 'Abstract', 'Description'];

function scrapeSalesforceKbList() {
    const rows = [...document.querySelectorAll(LIST_ROW_SELECTOR)];
    const out = [];
    const seen = new Set();
    for (const row of rows) {
        const title = kbListCell(row, KB_TITLE_LABELS);
        if (!title) continue;

        const link = row.querySelector(KB_RECORD_LINK_SELECTOR);
        const href = link ? (link.getAttribute('href') || '') : '';
        let url = '';
        try { if (href) url = new URL(href, location.origin).href; } catch (e) { /* relative junk */ }

        // data-recordid first: it is the id itself rather than an id parsed back out of a
        // path, and it is present on the Aura grid, which has no data-row-key-value at all.
        const recordId = (link && link.getAttribute('data-recordid'))
            || row.getAttribute('data-row-key-value')
            || (url.match(/\/lightning\/r\/(?:[^/]+\/)?([a-zA-Z0-9]{15,18})\//) || [])[1]
            || '';

        /* A ROW WITH AN ID BUT NO LINK IS STILL AN ARTICLE. Salesforce occasionally renders a
         * cell's link as plain text while the row is still settling, and the article record
         * page is reachable from the id alone — so build the address rather than dropping the
         * article for the sake of one missing href. */
        if (!url && recordId) url = `${location.origin}/lightning/r/Knowledge__kav/${recordId}/view`;
        if (!url) continue;

        // The same article can be listed twice — a re-render that leaves both grids briefly in
        // the DOM, or a column the engineer added twice. Keyed on the id, so the second copy
        // is dropped rather than read a second time in the sync that follows.
        const key = recordId || url;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
            recordId,
            url,
            title,
            number: kbListCell(row, KB_NUMBER_LABELS),
            type: kbListCell(row, KB_TYPE_LABELS),
            status: kbListCell(row, KB_STATUS_LABELS),
            validation: kbListCell(row, KB_VALIDATION_LABELS),
            modified: kbListCell(row, KB_MODIFIED_LABELS),
            summary: kbListCell(row, KB_SUMMARY_LABELS)
        });
    }
    const titleEl = document.querySelector('.slds-page-header__title, h1 .slds-page-header__title');

    /* "NO ITEMS TO DISPLAY" IS AN ANSWER, not a failure to load.
     *
     * The panel polls this scrape until it returns rows, so a list view that is legitimately
     * empty — a draft queue with nothing in it — would otherwise be polled until the deadline
     * and then reported as a page that would not load.
     *
     * Salesforce says so out loud with an empty-state panel, but that panel is in the DOM
     * whether or not it applies: it is rendered once and hidden with a class. So several things
     * have to agree before this claims the list is empty, and the first two are the ones that
     * matter — a grid holding rows is not an empty list whatever any panel says, and a grid
     * that is still loading has not said anything yet. Without them an org whose stylesheet
     * hides the panel some other way would have every populated list reported as empty, and
     * the sync would stop before it read a single article. */
    let emptyState = false;
    const stillLoading = listIsFetching(document)
        || [...document.querySelectorAll('.forceListViewPlaceholder')].some(el => !el.classList.contains('hidden') && isVisible(el));
    if (!rows.length && !stillLoading) {
        for (const el of document.querySelectorAll('.emptyContent, .slds-no-results')) {
            // `hidden` / `slds-hide` on the panel itself or on anything it sits inside.
            if (el.closest('.hidden, .slds-hide, [hidden]')) continue;
            if (!isVisible(el)) continue;
            if (!/no items to display|no results/i.test(el.textContent || '')) continue;
            emptyState = true;
            break;
        }
    }

    return {
        listName: titleEl ? cleanCellText(titleEl.textContent || '') : '',
        origin: location.origin,
        scrapedAt: Date.now(),
        // How many rows the grid held versus how many became articles. When those disagree the
        // panel can say WHY the sync found nothing, instead of blaming the list view.
        rowsSeen: rows.length,
        emptyState,
        articles: out
    };
}

/* ===========================================================================
 * READING A KNOWLEDGE LIST VIEW TO THE END
 * ===========================================================================
 * The sync was reading ten articles out of a list of two hundred and forty, and reporting a
 * finished knowledge base. Everything downstream was correct — the ten it read, it read
 * properly — so nothing about the result looked wrong except its size.
 *
 * Three separate things were wrong here, and each one on its own is enough to cause it:
 *
 *   1. THE SCRAPE HAPPENED ONCE, AT THE END. `table.uiVirtualDataTable` is called virtual
 *      because it is: rows are materialised in animation-frame batches as the grid is
 *      scrolled, and older ones can be dropped again behind you. Scrolling to the bottom and
 *      then reading the DOM asks the grid for a photograph of a moment, when what is needed
 *      is everything that was ever on screen. So the rows are ABSORBED every round now, keyed
 *      on record id, and the answer is the union — which is right whether the grid appends,
 *      recycles, or re-renders itself wholesale between rounds.
 *
 *   2. IT JUMPED STRAIGHT TO THE BOTTOM. One `scrollTop = scrollHeight` per round skips over
 *      every band in between, and a virtualised grid never renders the rows it was never
 *      scrolled past. It walks down a screenful at a time now, and only jumps to the bottom
 *      once it is already there — which is where the infinite loader lives.
 *
 *   3. IT STOPPED AT THE END OF A PAGE. "100+ items" was discarded as an unknown total (it
 *      is), and with it went the fact that there are more than a hundred. Four quiet rounds
 *      at the foot of the first page therefore looked exactly like the end of the list. The
 *      floor from declaredListSize makes the difference: below it, quiet means "still
 *      fetching", not "finished".
 *
 * Bounded on rounds, on the clock, and on patience, because a page that will not load must
 * still end the sync rather than hold it open forever.
 */
async function loadKbListFully(opts = {}) {
    const {
        maxRounds    = 600,
        maxMs        = 300000,   // five minutes for ONE list view — this is once per sync
        settleMs     = 550,      // pause after each scroll so the grid can render/fetch
        fetchWaitMs  = 12000,    // how long one page of rows may take to arrive
        stableRounds = 8,        // quiet rounds before the list is called finished
        firstRowMs   = 45000     // how long to wait for the grid to exist at all
    } = opts;

    const started = Date.now();
    const byKey = new Map();
    let rowsSeen = 0;
    let last = null;

    /* EVERYTHING THIS ROUND CAN SEE, merged into everything seen so far. Fields are filled in
     * rather than overwritten: a row caught mid-render can carry a title and no article
     * number, and the next time it comes round it may carry both. Nothing already read is
     * ever replaced with a blank. */
    const FIELDS = ['title', 'number', 'type', 'status', 'validation', 'modified', 'summary'];
    const absorb = () => {
        let added = 0;
        let snap;
        try { snap = scrapeSalesforceKbList(); } catch (e) { return 0; }
        last = snap;
        rowsSeen = Math.max(rowsSeen, snap.rowsSeen || 0);
        for (const a of snap.articles || []) {
            const key = a.recordId || a.url;
            if (!key) continue;
            const had = byKey.get(key);
            if (!had) { byKey.set(key, a); added++; continue; }
            for (const f of FIELDS) if (!had[f] && a[f]) had[f] = a[f];
        }
        return added;
    };

    // THE GRID HAS TO EXIST BEFORE IT CAN BE SCROLLED. The panel starts asking two and a half
    // seconds after the tab is created, which on a Lightning list view is comfortably before
    // the first row. Bailing out there is what made an empty scrape look like a short list.
    while (Date.now() - started < firstRowMs) {
        if (document.querySelector(LIST_ROW_SELECTOR)) break;
        absorb();
        if (last && last.emptyState) {
            return { listName: last.listName, origin: location.origin, scrapedAt: Date.now(),
                     rowsSeen: 0, emptyState: true, articles: [],
                     // An empty list view is a finished read of an empty list, not a short one.
                     listLoad: { rounds: 0, reason: 'empty-list', ms: Date.now() - started,
                                 complete: true, short: 0 } };
        }
        await sleep(400);
    }

    const first = document.querySelector(LIST_ROW_SELECTOR);
    if (!first) {
        absorb();
        return Object.assign(last || {
            listName: '', origin: location.origin, scrapedAt: Date.now(),
            rowsSeen: 0, emptyState: false, articles: []
        }, { articles: [...byKey.values()], rowsSeen,
             listLoad: { rounds: 0, reason: 'no-rows-found', ms: Date.now() - started,
                         complete: false, short: 0 } });
    }

    // Put the engineer's scroll position back afterwards. The reader tab is thrown away, so
    // this is for the case where the same scrape runs against a list view they have open.
    const restoreChain = getAncestorChain(first);
    const originalTops = restoreChain.map(el => el.scrollTop);

    /* WHAT SALESFORCE SAYS THE LIST HOLDS — RE-READ EVERY ROUND, WHICH IS THE WHOLE POINT.
     *
     * This was read once, here, before the first scroll, and that single read is how a sync
     * of a nine-hundred-article knowledge base could stop at a few hundred and report a
     * clean finish. The status line is not a constant: Salesforce writes "50+ items" when
     * the first page lands, then "200+ items", "450+ items" as the scroll pulls more, and
     * finally an EXACT "939 items" once it has them all. Read once, at the only moment it
     * says the least, and the floor is fifty forever — so from row fifty-one onwards the
     * loader is running on its weakest stopping rule ("nothing new for eight rounds"), and
     * one slow page fetch in the middle of the list ends the scrape as `no-new-rows`, which
     * is the reason it prints for a list it genuinely finished.
     *
     * Re-read, the same sentence does the two jobs it was always supposed to do: the floor
     * RISES as rows arrive, so quiet below it always means "still fetching" and buys the
     * doubled patience; and the exact count, when it finally appears, ends the scroll on
     * `all-rows-loaded` — the only reason of the six that is proof rather than inference.
     *
     * Monotonic on purpose. The status line is re-rendered mid-scroll and can flicker back
     * to a smaller figure or to nothing at all between two reads; a floor that could fall is
     * a floor that stops holding at exactly the moment it matters. */
    let target = null;      // an exact count means stop when we have them all
    let floor  = null;      // "100+" means do not stop before a hundred
    const readDeclaredSize = () => {
        let size;
        try { size = declaredListSize(document); } catch (e) { return; }
        if (size.exact && size.exact > (target || 0)) target = size.exact;
        if (size.atLeast && size.atLeast > (floor || 0)) floor = size.atLeast;
    };
    readDeclaredSize();

    absorb();

    let rounds = 0;
    let stable = 0;
    let reason = 'exhausted-rounds';
    let spinnerStalled = false;

    while (rounds < maxRounds) {
        if (Date.now() - started > maxMs) { reason = 'time-budget'; break; }
        rounds++;

        const rows = document.querySelectorAll(LIST_ROW_SELECTOR);
        const lastRow = rows[rows.length - 1] || first;
        const box = caseListScroller(lastRow);

        /* A SCREENFUL AT A TIME while there is somewhere to go, then the bottom. The step is
         * what makes the middle of a virtualised list render; the jump is what trips the
         * infinite loader once the rendered rows have run out. */
        let atBottom = true;
        if (box) {
            const room = box.scrollHeight - box.clientHeight;
            atBottom = box.scrollTop >= room - 8;
            if (!atBottom) {
                box.scrollTop = Math.min(room, box.scrollTop + Math.max(240, box.clientHeight * 0.85));
            } else {
                box.scrollTop = box.scrollHeight;
            }
        }
        if (atBottom) {
            // The three ways at the scrollbar the case list already uses, for the layouts
            // where the named box is not the one that actually scrolls.
            scrollChainToBottom(getAncestorChain(lastRow));
            try { lastRow.scrollIntoView({ block: 'end' }); } catch (e) { /* detached */ }
        }

        await sleep(settleMs);
        const fetchScope = caseListRegion(box) || document;
        if (!(await waitWhileFetching(fetchScope, fetchWaitMs))) spinnerStalled = true;

        const added = absorb();
        // Before the stopping rules, not after: the count Salesforce prints is what those
        // rules are made of, and reading it a round late is reading the previous page's.
        readDeclaredSize();
        const have = byKey.size;

        if (target && have >= target) { reason = 'all-rows-loaded'; break; }

        if (added > 0) { stable = 0; spinnerStalled = false; continue; }
        if (!atBottom) { stable = 0; continue; }   // still walking down what is already loaded

        /* QUIET AT THE BOTTOM. That is the end of the list — unless Salesforce has told us
         * there are more than this, in which case it is the end of a PAGE and the fetch for
         * the next one is simply slower than our patience. Twice the patience below the
         * floor, and the reason says which of the two it was. */
        const need = (floor && have <= floor) ? stableRounds * 2 : stableRounds;
        if (++stable >= need) {
            reason = spinnerStalled ? 'still-loading'
                   : (floor && have <= floor) ? 'capped-at-page' : 'no-new-rows';
            break;
        }
    }

    restoreChain.forEach((el, i) => { try { el.scrollTop = originalTops[i]; } catch (e) {} });

    readDeclaredSize();     // the final figure, which is usually the exact one
    const articles = [...byKey.values()];

    /* DID THIS READ THE WHOLE LIST, OR JUST STOP? Six reasons come out of the loop above and
     * only one of them is PROOF: `all-rows-loaded` means Salesforce printed a total and we
     * hold it. Everything else is inference from silence, and the sync has no business
     * presenting inference as a finished knowledge base — "did not sync all the articles" is
     * unanswerable when the only thing the panel can say is how many it happened to get.
     *
     * `short` is the arithmetic where there is any: what Salesforce declared, minus what we
     * hold. Positive means rows were left on the page, and the caller says so out loud. */
    const declared = target || (floor ? floor : null);
    const short = declared ? Math.max(0, declared - articles.length) : 0;
    const complete = reason === 'all-rows-loaded'
        || (reason === 'no-new-rows' && !short);

    return {
        listName: (last && last.listName) || '',
        origin: location.origin,
        scrapedAt: Date.now(),
        rowsSeen: Math.max(rowsSeen, articles.length),
        emptyState: !articles.length && !!(last && last.emptyState),
        articles,
        listLoad: {
            rounds, reason, ms: Date.now() - started,
            declared: target, atLeast: floor, rows: articles.length,
            complete, short
        }
    };
}

/* ONE ARTICLE, read off its record page.
 *
 * A Knowledge article is mostly RICH TEXT, and that is what makes it different from a case:
 * the answer lives in one or two long formatted fields (Resolution, Details, Answer) rather
 * than in a grid of short ones. Two passes, because neither alone is enough:
 *
 *   1. The labelled fields, through the same machinery the case scrape uses. This gets the
 *      short ones (product, version, category) and the long ones on layouts that label them.
 *   2. A sweep of the rich-text OUTPUT blocks. Lightning renders a rich text field into
 *      `lightning-formatted-rich-text` / `.slds-rich-text-editor__output`, and on several
 *      layouts those sit in their own card with the heading outside the label selector — so
 *      pass one finds the card and not its contents. Anything substantial that pass one did
 *      not already capture is appended.
 *
 * Deduplicated on the text itself: the two passes overlap by design, and the same resolution
 * appearing twice in the prompt is budget spent on nothing.
 */
const KB_RICH_TEXT_SELECTOR = [
    'lightning-formatted-rich-text',
    '.slds-rich-text-editor__output',
    '.ql-editor',
    '[data-output-element-id="output-field"] .slds-rich-text-area__content'
].join(', ');

// Fields that are chrome rather than content — they say something about the RECORD, not about
// the problem it solves, and every one of them costs prompt budget the answer needs.
//
// The DATE fields are here for a second reason as well. They are what the HIGHLIGHTS panel at
// the top of an article shows, and the highlights panel renders long before the record layout
// below it does — so on a page caught half-rendered they were the whole of the "article", and
// an article whose body is "Last Modified Date: 27/08/2025" reads to the model as an article
// with no body at all. See KB_CONTENT_LABEL_RE.
const KB_SKIP_LABEL_RE = /^(created by|created date|last modified by|last modified|last modified date|article created date|version created date|owner|article number|url name|version|version number|language|publication status|publish status|validation status|is latest version|is visible|is visible in public knowledge base|visible in public knowledge base|first published|first published date|last published|last published date|archived|archived date|assigned to|record type|article record type|data categories)$/i;

/* THE FIELDS THAT ARE THE ARTICLE. Everything else on a Knowledge record is filing.
 *
 * Used for one decision only, and it is the important one: whether what we just scraped is
 * the ARTICLE or merely the page furniture that renders before it. See `ready` below. */
const KB_CONTENT_LABEL_RE = /^(summary|abstract|description|issue description|environment|symptoms|prevention|cause|root cause|issue resolution|resolution|resolution steps|workaround|workarounds|additional information|known issues|internal notes|details|content|answer|question|steps|more information|notes)$/i;

/* THE TEXT OF ONE RENDERED FIELD, with the structure that makes it readable kept.
 *
 * `innerText` was doing this job and doing it badly on exactly the fields that matter. A
 * Knowledge resolution is a bulleted list; flattened to running prose, "Execute the command
 * wipeapplication com.google.android.gms. Update the Play Store app to 40.X." reads as one
 * instruction rather than two, and the model repeats it as one. So a <li> keeps its bullet.
 *
 * A link keeps its href too. "refer to the Google Play Services Bug Announcement" is not a
 * reference an engineer can follow, and the model cannot invent the address back.
 */
function kbNodeText(node) {
    let out = '';
    const walk = (n) => {
        if (!n) return;
        if (n.nodeType === 3) { out += String(n.nodeValue || '').replace(/\u00a0/g, ' '); return; }
        if (n.nodeType !== 1) return;
        const tag = (n.tagName || '').toLowerCase();
        if (tag === 'br') { out += '\n'; return; }
        if (tag === 'li') {
            if (out && !/\n$/.test(out)) out += '\n';
            out += '- ';
            for (const c of n.childNodes) walk(c);
            out += '\n';
            return;
        }
        if (tag === 'a') {
            const at = out.length;
            for (const c of n.childNodes) walk(c);
            const href = n.getAttribute('href') || '';
            if (/^https?:/i.test(href) && !out.slice(at).includes(href)) out += ` (${href})`;
            return;
        }
        const block = /^(p|div|ul|ol|table|tr|h[1-6]|blockquote|pre|section|article)$/.test(tag);
        if (block && out && !/\n$/.test(out)) out += '\n';
        for (const c of n.childNodes) walk(c);
        if (block && out && !/\n$/.test(out)) out += '\n';
    };
    walk(node);
    return out
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ONE FIELD'S VALUE off a Lightning record layout.
 *
 * The help "?" beside a label is a BUTTON whose accessible name is "Help Summary", and the
 * checkbox fields carry their own label again as assistive text. Both sit inside the field and
 * both are read by textContent, so a field's value came back as its own label repeated — which
 * is worse than empty, because it is confident. They are removed before the text is taken.
 */
function kbFieldValueText(valueEl) {
    if (!valueEl) return '';
    /* A CHECKBOX HAS NO TEXT. Its value is a tick, and the only place the state is written
     * down is the icon's title. Read before the clone, because the clone is about to delete
     * the assistive text that is the other half of it. */
    const hasText = valueEl.querySelector('lightning-formatted-text, lightning-formatted-rich-text, '
        + '.outputRichText, lightning-formatted-date-time, lightning-formatted-number, lightning-formatted-url');
    if (!hasText) {
        const icon = valueEl.querySelector('lightning-icon[title], [data-key="check"]');
        const t = ((icon && icon.getAttribute && icon.getAttribute('title')) || '').trim();
        if (/^true$/i.test(t)) return 'Yes';
        if (/^false$/i.test(t)) return 'No';
    }
    let clone;
    try { clone = valueEl.cloneNode(true); } catch (e) { return ''; }
    for (const junk of clone.querySelectorAll('lightning-helptext, .slds-assistive-text, [part="label"], '
        + '.slds-form-element__help, .slds-form-element__label, style, script')) {
        junk.remove();
    }
    return kbNodeText(clone);
}

/* THE ARTICLE'S OWN FIELDS, read off the record layout rather than guessed at.
 *
 * The generic case-field reader below finds most of these, but it works by finding a LABEL and
 * then hunting outwards for something that looks like its value — calibrated for a case, where
 * that is the only option. A Knowledge record layout does not need guessing: every field is one
 * `records-record-layout-item`, the label is on it as an attribute, and the value is the one
 * element inside it with the value class. Reading it directly is both exact and, because the
 * item either exists or does not, the answer to "has this page actually rendered yet".
 */
function kbDetailFields(root = document) {
    const out = [];
    const seenLabels = new Set();
    for (const item of findInShadows('records-record-layout-item', root, false)) {
        let label = (item.getAttribute && item.getAttribute('field-label') || '').trim();
        if (!label) {
            const l = item.querySelector('.test-id__field-label');
            label = ((l && l.textContent) || '').replace(/\s+/g, ' ').trim();
        }
        if (!label) continue;
        const valueEl = item.querySelector('.test-id__field-value') || item.querySelector('.slds-form-element__control');
        const value = kbFieldValueText(valueEl);
        // An empty field is not a fact about the problem — it is a field somebody left blank,
        // and there are a dozen of them on this layout.
        if (!value) continue;
        const key = normaliseLabel(label) + '\u0000' + value.slice(0, 120);
        if (seenLabels.has(key)) continue;
        seenLabels.add(key);
        out.push({ label, value });
    }
    return out;
}

/* WHO WROTE IT AND WHO TOUCHED IT LAST.
 *
 * These are FILING fields — KB_SKIP_LABEL_RE keeps them out of the article body on purpose,
 * because "Created By: Ana Silva" is not knowledge about the problem and it is exactly the
 * kind of half-rendered highlights-strip text that used to get stored AS the article.
 *
 * They are read separately all the same, because one question about a knowledge base cannot
 * be answered without them: an article that is years old and out of date has an OWNER, and
 * "this needs updating" is a message to a person, not a note to nobody. Kept off `fields` and
 * therefore out of `body` and out of `contentChars`, so nothing about the readiness test or
 * the prompt budget changes. */
const KB_AUTHOR_LABEL_RE = /^(created by|article created by|author|owner)$/i;
const KB_EDITOR_LABEL_RE = /^(last modified by|last modified by alias|last updated by)$/i;

// A Lightning person field renders as a link with the name, and sometimes with a date beside
// it ("Ana Silva, 27/08/2025, 09:14"). The name is the part that can be reached out to.
function kbPersonName(value) {
    const t = String(value || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const name = t.split(',')[0].trim();
    // Nothing that is plainly a date rather than a person.
    if (/^\d/.test(name) || /^\d{1,4}[-/]/.test(name)) return '';
    return name.slice(0, 80);
}

function scrapeSalesforceKbArticle() {
    const out = { title: '', number: '', type: '', url: location.href.split('?')[0], fields: [], body: '',
                  author: '', editor: '', modified: '',
                  hasDetail: false, contentChars: 0, ready: false };

    // cleanCellText, not cleanFieldValue: an article title is prose, and the case cleaner would
    // cut "Administrator Cannot Edit User Passwords" down to "Administrator Cannot". See
    // cleanCellText.
    const titleEl = document.querySelector('.slds-page-header__title, records-highlights2 h1, h1 .slds-page-header__title');
    if (titleEl) out.title = cleanCellText(titleEl.textContent || '');

    const seen = new Set();
    const seenLabels = new Set();
    /* THE SAME PARAGRAPH TWICE IS WORSE THAN ONCE. The three passes below overlap by design —
     * each is a fallback for the layouts the one before cannot read — so the same field is
     * routinely offered more than once, in slightly different renderings. The key is therefore
     * the text with its FORMATTING REMOVED: pass 1 renders a resolution as "- Execute the
     * command…" and pass 3 renders it as "Execute the command…", which are the same knowledge
     * and used to be stored as two fields. Every article then carried its own resolution
     * twice, and since only the first 2,600 characters of an article reach the model (see
     * perArticleCap), the duplicate pushed the real content off the end. */
    const dedupeKey = (v) => v.replace(/[^a-z0-9]+/gi, '').toLowerCase().slice(0, 300);
    const push = (label, value) => {
        const v = String(value || '').replace(/\s+\n/g, '\n').trim();
        if (!v || v.length < 2) return;
        const key = dedupeKey(v);
        if (!key || seen.has(key)) return;
        seen.add(key);
        const l = normaliseLabel(label);
        if (l) seenLabels.add(l);
        out.fields.push({ label: label || '', value: v });
    };

    /* 1. THE RECORD LAYOUT — Summary, Issue Description, Environment, Symptoms, Prevention,
     *    Cause, Issue Resolution, Workarounds, Additional Information, Known Issues, Internal
     *    Notes. This is the article. Read first so its exact label/value pairing wins over
     *    anything the generic passes below infer, and so `hasDetail` says whether the page had
     *    rendered the part worth reading. */
    const detail = kbDetailFields(document);
    out.hasDetail = detail.length > 0;
    for (const f of detail) {
        const n = normaliseLabel(f.label);
        if (n === 'article number') { out.number = out.number || f.value; continue; }
        if (n === 'record type' || n === 'article record type') { out.type = out.type || f.value; continue; }
        // Lifted out of the skip list BEFORE it is applied, and never pushed onto `fields`:
        // they are answers to "who do I talk to about this article", not article text.
        if (KB_AUTHOR_LABEL_RE.test(n)) { out.author = out.author || kbPersonName(f.value); continue; }
        if (KB_EDITOR_LABEL_RE.test(n)) { out.editor = out.editor || kbPersonName(f.value); continue; }
        if (/^(last modified date|last modified|last published date|last published)$/i.test(n)) {
            out.modified = out.modified || String(f.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            continue;
        }
        if (KB_SKIP_LABEL_RE.test(n)) continue;
        push(f.label, f.value);
    }

    // 2. The labelled fields, the generic way — for a layout that is not this one (Classic, a
    //    custom component, an org that renders Knowledge some other way). Deduped by `push`,
    //    so on the ordinary layout this adds only what pass 1 could not see.
    for (const label of findInShadows(FIELD_LABEL_SELECTOR, document, false)) {
        const name = labelTextOf(label);
        if (!name || KB_SKIP_LABEL_RE.test(name)) {
            // The article number IS worth keeping — just not as body text.
            if (/^article number$/i.test(name)) out.number = getFieldValue(label);
            if (/^record type$/i.test(name)) out.type = getFieldValue(label);
            continue;
        }
        // Already read off the record layout, exactly, in pass 1 — and this pass INFERS its
        // value by hunting outwards from the label, so where the two disagree pass 1 is right.
        if (seenLabels.has(name)) continue;
        // multiline: a Knowledge resolution is prose and cleanFieldValue would cut it at the
        // first word that happens to match a button name.
        const v = getFieldValue(label, true, true);
        if (v) push((label.textContent || name).replace(/\s+/g, ' ').trim(), v);
    }

    /* 3. The rich-text blocks the first two passes could not reach — for a page with no record
     *    layout on it. Skipped when there IS one, because pass 1 has already read every one of
     *    these blocks WITH the label that says which field it is, and re-adding them here would
     *    only add the same prose back a second time without its heading. */
    for (const el of (out.hasDetail ? [] : findInShadows(KB_RICH_TEXT_SELECTOR, document, false))) {
        const t = (el.innerText || el.textContent || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        // Short blocks are picklist values and single-line fields the first pass already has.
        if (t.length < 60) continue;
        push('', t);
    }

    out.body = out.fields
        .map(f => (f.label ? `${f.label}:\n${f.value}` : f.value))
        .join('\n\n')
        .slice(0, 20000);

    /* HOW MUCH OF WHAT WE HAVE IS THE ARTICLE, as opposed to the filing around it. */
    out.contentChars = out.fields.reduce(
        (n, f) => n + (!f.label || KB_CONTENT_LABEL_RE.test(normaliseLabel(f.label)) ? f.value.length : 0), 0);

    /* IS THIS PAGE FINISHED, or did we catch it half-rendered?
     *
     * The question the reader in the side panel has to answer before it stores anything, and
     * it used to answer it with `body.length > 40`. That is true of an article page a fifth of
     * a second after it opens, when the highlights strip has painted its record type and its
     * last-modified date and the record layout underneath has not painted at all — so the sync
     * stored the filing card as the article, and because a stored article with a body is never
     * re-read, it stayed the filing card. That is the whole of the "it knows the title but not
     * the contents" fault.
     *
     * `hasDetail` is the honest signal: the record layout either rendered or it did not, and
     * if it did then whatever it holds IS the article, however short. The other two are for
     * layouts that have no `records-record-layout-item` at all, so that an org rendering
     * Knowledge some other way still finishes rather than timing out on every article. */
    out.ready = out.hasDetail || out.contentChars >= 200 || out.fields.length >= 6;
    return out;
}

/* THE KNOWLEDGE LIST SCRAPE IN FLIGHT, and its answer once it has one. Page-scoped: the
 * reader tab navigates for each list view, and a navigation is a new content script with both
 * of these back at their starting values. */
let kbListRun = null;
let kbListCache = null;

/* ============================================================================
 * WRITING TO THE CASE — the publisher at the top of the Feed tab
 * ============================================================================
 * Everything else in this file READS Salesforce. This is the only part that
 * writes to it, and that difference governs how it is built.
 *
 * A scrape that misreads a field produces a wrong answer in a panel, which the
 * engineer can see and ignore. A write that goes to the wrong place puts a note
 * on somebody else's case, in the customer's timeline, under the engineer's
 * name — so every step here either finds exactly what it was looking for or
 * stops and says which step it was. Nothing is assumed to have worked because
 * a click did not throw: the note is confirmed by the composer EMPTYING, which
 * is the page's own signal that it accepted the record.
 *
 * Two things go through the publisher and they are different UIs behind one
 * idea:
 *
 *   LOG A CALL builds a Task. Its tab shows a stub with an "Add" button that
 *   expands the real form, and that form has a Subject picklist and a Comments
 *   textarea — both Aura, both driven by events rather than by assignment.
 *
 *   POST writes a Chatter FeedItem into a Quill rich-text editor, which keeps
 *   its own model of the document and will not notice a value written straight
 *   into the DOM. It is typed with execCommand for that reason, which needs the
 *   tab to be FOCUSED — the panel activates it before asking (see
 *   postToSalesforceFeed in sidepanel.js).
 *
 * Neither drives the page blind: the record root is resolved from the id the
 * panel names, exactly as a one-case read is, so a console with six cases open
 * writes to the one the panel is showing rather than the leftmost one.
 * ========================================================================== */

// Poll until `fn` returns something truthy, or give up. Returns what fn returned,
// or null — never throws, and a throwing probe counts as "not yet".
async function untilTrue(fn, timeoutMs = 12000, stepMs = 150) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        let v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) return v;
        if (Date.now() >= until) return null;
        await sleep(stepMs);
    }
}

/* EVERY NAME A CONTROL GOES BY, because no one of them is reliable on its own.
 *
 * `title` is the accessible name on some of these controls and a TOOLTIP on
 * others — the publisher's Share button is titled "Click, or press Ctrl+Enter"
 * and says "Share" only in its text, while the quick action's Save is titled
 * "Save" and wraps its text in a span. Reading title first and falling back to
 * text finds neither reliably; matching against all of them finds both.
 *
 * Callers test EXACTLY against these (/^share$/i, not /share/) — see
 * findPublisherButton for why a substring match is dangerous here.
 */
function controlNames(el) {
    if (!el) return [];
    const out = [];
    const push = (v) => {
        const s = String(v || '').replace(/\s+/g, ' ').trim();
        if (s && !out.includes(s)) out.push(s);
    };
    if (el.getAttribute) {
        push(el.getAttribute('title'));
        push(el.getAttribute('data-label'));
        push(el.getAttribute('aria-label'));
    }
    push(el.textContent);
    return out;
}

function controlLabelOf(el) {
    const names = controlNames(el);
    return names.length ? names[names.length - 1] : '';
}

const controlIsCalled = (el, re) => controlNames(el).some(n => re.test(n));

function controlIsEnabled(el) {
    if (!el || el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    if (el.classList && el.classList.contains('disabled')) return false;
    return true;
}

/* ONE OF THE PUBLISHER'S OWN TABS — "Log a Call", "Post", "Email".
 *
 * `a.tabHeader` is the publisher's shape and is preferred; the generic role="tab"
 * fallback is there because this strip is not the same markup in every org. The
 * match is EXACT against the whole label rather than a substring: "Post" as a
 * substring also matches "Post to Chatter" and, on some layouts, the record's own
 * "Posts" related list — and clicking the wrong one leaves the write pointing at
 * a UI that looks close enough to fill in.
 */
/* RENDERED, EVEN IF IT IS NOT ON SCREEN AT THIS SCROLL POSITION.
 *
 * `isVisible` rejects anything whose box sits more than 500px above or left of the
 * viewport, and that check earns its place: Salesforce parks inactive console tabs
 * off-screen rather than hiding them, and without it a write could go to a case the
 * engineer is not looking at.
 *
 * It is the wrong question for a control the engineer has merely SCROLLED PAST, though,
 * and the publisher is exactly that: it sits at the top of the case feed, so reading any
 * distance down the history puts it above the viewport — measured at y = -878 on a feed
 * with one quoted thread in it. The write then failed with "No Email tab is on this
 * case's publisher", about a publisher that was right there.
 *
 * So: same test, minus the position. A box with real dimensions that nothing has hidden
 * is a rendered control. Used only as a SECOND pass, and only within the record's own
 * root, so the off-screen console tabs the strict test exists to reject are still out of
 * reach of it. */
function isRenderedIgnoringScroll(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.classList && (el.classList.contains('slds-hide') || el.classList.contains('slds-is-collapsed'))) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function findPublisherTab(root, re) {
    const pass = (visible) => {
        let best = null;
        for (const el of findInShadows('a.tabHeader, a[role="tab"], button[role="tab"], .slds-tabs_default__link', root, false)) {
            if (!controlIsCalled(el, re) && !re.test(tabLabelOf(el))) continue;
            if (!visible(el)) continue;
            const label = controlLabelOf(el) || tabLabelOf(el);
            const li = el.closest ? el.closest('li') : null;
            const active = el.getAttribute('aria-selected') === 'true' ||
                           !!(li && li.className && /slds-is-active/.test(li.className));
            // The publisher's own strip wins over any other tab bar that happens to
            // carry the same word.
            const score = (el.classList && el.classList.contains('tabHeader') ? 2 : 0) + (active ? 1 : 0);
            if (!best || score > best.score) best = { el, label, active, score };
        }
        return best;
    };
    // On screen first — that is always the right answer when there is one.
    return pass(isVisible) || pass(isRenderedIgnoringScroll);
}

// Bring a control the engineer has scrolled past back into view before pressing it.
// `block: 'nearest'` so a publisher already on screen is not jerked around.
function scrollControlIntoView(el) {
    try { if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    catch (_) { /* an element in a frame that will not scroll — the click still works */ }
}

/* A BUTTON IN THE PUBLISHER, BY ITS EXACT NAME.
 *
 * Exact, because "Save & New" contains "Save" and is one place to the right of it:
 * a substring match on a three-button row is a coin toss that files the note and
 * then opens a blank form over the top of the case.
 *
 * The brand-styled `cuf-publisherShareButton` is the one the engineer would press
 * — the wide button in the publisher's bottom bar — so it is preferred over the
 * quick-action layout's own Save, which is the same action rendered twice.
 */
function findPublisherButton(root, re) {
    const sel = 'button.cuf-publisherShareButton, button.forceActionButton, .publisherButtons button, '
              + 'button.slds-button, button.uiButton';
    return findInScopes(root, (scope) => {
        let best = null;
        for (const b of findInShadows(sel, scope, false)) {
            if (isStubSubmitButton(b)) continue;   // wears the same name; see below
            if (!controlIsCalled(b, re) || !isVisible(b) || !controlIsEnabled(b)) continue;
            const label = controlLabelOf(b);
            const score = (b.classList && b.classList.contains('cuf-publisherShareButton')) ? 1 : 0;
            if (!best || score > best.score) best = { el: b, label, score };
        }
        return best ? best.el : null;
    });
}

/* THE COLLAPSED PUBLISHER'S OWN BUTTON, WHICH DOES NOT SUBMIT ANYTHING.
 *
 * A publisher nobody has clicked into yet renders a STUB: a one-line placeholder
 * and a button carrying the real action's name — "Add" on Log a Call, "Share" on
 * Post. Pressing it expands the composer and files nothing.
 *
 * Salesforce marks it `dummyButtonSubmitAction`, and on the Post tab that class is
 * the ONLY thing telling it apart from the real Share: same bar, same label, same
 * `uiButton` shape. Hence findPublisherButton skipping it — asked for Share while
 * the stub is still up it would otherwise hand back the expander, and a writer
 * that "clicked Share" and then saw the box empty would report a post that was
 * never made.
 */
function isStubSubmitButton(el) {
    return !!(el && el.classList &&
        (el.classList.contains('dummyButtonSubmitAction') ||
         el.classList.contains('testid__dummy-button-submit-action')));
}

function findStubSubmitButton(root) {
    return findInShadows('button.dummyButtonSubmitAction, button.testid__dummy-button-submit-action', root, false)
        .find(b => isVisible(b) && controlIsEnabled(b)) || null;
}

/* WHERE IT IS SAFE TO LOOK for a form that has just been opened.
 *
 * The record's own panel first, always. The whole document second — but ONLY when
 * there is one case open, because some orgs render the quick action as an OVERLAY
 * attached to the body rather than inline in the publisher, and a form that is not
 * under the record panel is unfindable from it.
 *
 * The guard is the point. With several cases mounted at once, a document-wide
 * search can find a publisher another case left expanded, and the note goes to
 * that one — which is the exact failure the record scoping exists to prevent, let
 * back in through the side door. One case open means there is nothing to confuse
 * it with.
 */
/* WORKED OUT ONCE PER WRITE, not once per look.
 *
 * The finders below run inside polling loops — several times a second for up to
 * fifteen seconds — and openCaseTabCount() walks the whole document including
 * every shadow root. Asking it on every poll is a full-page tree walk five times
 * a second against the page being driven, which is a real cost on a console with
 * six cases open and buys nothing: how many cases are open cannot change in the
 * middle of one write. Reset at the top of postToCaseFeed so the NEXT one asks
 * again — the engineer may have opened a case in between. */
let writeScopeCache = null;

function writeScopes(root) {
    if (writeScopeCache && writeScopeCache.root === root) return writeScopeCache.scopes;
    let scopes = [root];
    if (root === document) {
        scopes = [document];
    } else {
        let single = false;
        try { single = openCaseTabCount() <= 1; } catch (e) { single = false; }
        if (single) scopes = [root, document];
    }
    writeScopeCache = { root, scopes };
    return scopes;
}

function findInScopes(root, fn) {
    for (const scope of writeScopes(root)) {
        const hit = fn(scope);
        if (hit) return hit;
    }
    return null;
}

// The Comments box on the Log a Call form. Named by the layout first —
// Task.Description is what the field IS — then by shape, so an org that renders
// the quick action differently still finishes.
function findCallNoteTextarea(root) {
    return findInScopes(root, (scope) => {
        const named = findInShadows('[data-target-selection-name="sfdc:RecordField.Task.Description"] textarea', scope, false)
            .find(isVisible);
        if (named) return named;
        return findInShadows('textarea.uiInputTextArea, textarea[role="textbox"]', scope, false).find(isVisible) || null;
    });
}

// The Subject picklist on the same form. It is an LWC combobox, so the input is
// what carries the value and the options live beside it.
function findSubjectCombobox(root) {
    return findInScopes(root, (scope) => {
        const byLabel = findInShadows('input.slds-combobox__input[aria-label="Subject"]', scope, false).find(isVisible);
        if (byLabel) return byLabel;
        for (const g of findInShadows('lightning-grouped-combobox', scope, false)) {
            const label = (g.querySelector('label') || {}).textContent || '';
            if (!/^\s*subject\s*$/i.test(label)) continue;
            const input = g.querySelector('input.slds-combobox__input, input[role="combobox"]');
            if (input && isVisible(input)) return input;
        }
        return null;
    });
}

/* SET AN AURA TEXT FIELD SO THE COMPONENT BELIEVES IT.
 *
 * Assigning `.value` updates the DOM and nothing else: Aura holds the value on
 * the component and re-renders from there, so the next re-render wipes it and
 * Save files an empty note. The native setter plus input/change is what a real
 * keystroke looks like from the framework's side.
 */
function setAuraFieldValue(el, text) {
    if (!el) return 0;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { el.focus(); } catch (e) { /* not focusable yet */ }
    setter.call(el, text);
    for (const type of ['input', 'change']) {
        el.dispatchEvent(new Event(type, { bubbles: true }));
    }
    // Some publisher buttons enable off keyboard activity rather than off the
    // value, and this costs nothing where they do not.
    try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' })); } catch (e) { /* older engine */ }
    return (el.value || '').length;
}

/* PICK ONE OPTION OUT OF AN LWC COMBOBOX.
 *
 * The options are in the DOM whether the dropdown is open or not, and clicking a
 * hidden one does nothing — so the input is clicked first and the option is
 * waited for. Selection is confirmed by reading the input back: an option that
 * was clicked while the component was mid-render leaves the field on --None--,
 * and a call note filed under the wrong subject is not something the engineer
 * would ever think to check.
 */
async function pickComboboxOption(input, value) {
    if (!input) return false;
    const reads = () => String(input.value || input.getAttribute('data-value') || '').trim();
    if (reads() === value) return true;

    try { input.focus(); input.click(); } catch (e) { /* the wait below reports it */ }

    const scope = (input.closest && input.closest('.slds-combobox_container')) || null;
    const option = await untilTrue(() => {
        const from = [
            ...(scope ? scope.querySelectorAll('lightning-base-combobox-item, [role="option"]') : []),
            ...findInShadows('lightning-base-combobox-item, [role="option"]', document, false)
        ];
        return from.find(o =>
            o.getAttribute('data-value') === value ||
            String(o.textContent || '').replace(/\s+/g, ' ').trim() === value);
    }, 6000, 120);
    if (!option) return false;

    /* THE APPROACH, THEN ONE CLICK.
     *
     * The component listens on mousedown to keep focus off the option and selects
     * on click, so a bare .click() misses the first half and the dropdown can shut
     * before the selection registers. The click itself is .click() rather than a
     * fifth dispatched MouseEvent, because doing both fires the handler TWICE —
     * which on this combobox is a harmless re-selection of the same value and on
     * the next component to be driven this way would not be. */
    for (const type of ['mouseover', 'mousedown', 'mouseup']) {
        try { option.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); }
        catch (e) { /* try the next one */ }
    }
    try { option.click(); }
    catch (e) {
        try { option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
        catch (e2) { /* the read-back below reports it */ }
    }

    return !!(await untilTrue(() => reads() === value, 4000, 100));
}

// The Chatter post editor. Quill in every org seen so far, but matched by role as
// well so a plain contenteditable publisher still works.
function findPostEditor(root) {
    return findInShadows('.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]', root, false)
        .find(isVisible) || null;
}

function escapeForHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* TYPE INTO THE RICH-TEXT EDITOR.
 *
 * execCommand rather than innerHTML, because Quill keeps its own model of the
 * document: text written into the DOM behind its back is not in that model, so
 * the Share button stays disabled and — if it is pressed anyway — an empty post
 * is filed. execCommand goes through the browser's editing pipeline, which Quill
 * listens to, so the model and the DOM agree.
 *
 * It needs the DOCUMENT to be focused, which is why the panel activates the tab
 * before asking. The innerHTML path below is the fallback for when it is not,
 * and it removes ql-blank by hand because Quill's placeholder is driven by that
 * class rather than by the content.
 */
function typeIntoRichText(el, text) {
    if (!el) return 0;
    try { el.focus(); } catch (e) { /* reported by the length check below */ }
    // Select what is there so a retry REPLACES the text rather than doubling it.
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    } catch (e) { /* no selection API — the fallback covers it */ }

    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }

    if (!ok || !String(el.innerText || '').trim()) {
        el.innerHTML = String(text).split(/\r?\n/)
            .map(line => `<p>${line ? escapeForHtml(line) : '<br>'}</p>`).join('');
        if (el.classList) el.classList.remove('ql-blank');
        try {
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        } catch (e) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    return String(el.innerText || '').trim().length;
}

// A step that failed, in the shape the panel reports. `step` is what to say went
// wrong; `why` is what was actually on the page when it did.
const wrote = (step, why) => ({ ok: false, step, why: why || '' });

/* LOG A CALL — Feed tab, Log a Call, Add, Subject = Note, Comments, Save. */
async function writeCallNote(root, text) {
    const tab = findPublisherTab(root, /^log a call$/i);
    if (!tab) {
        return wrote('the Log a Call tab',
            'No "Log a Call" tab is on this case\'s publisher. It may be switched off for this record type.');
    }
    if (!tab.active) {
        try { tab.el.click(); } catch (e) { return wrote('the Log a Call tab', 'The tab would not take a click.'); }
    }

    /* THE FORM, WHICH MAY OR MAY NOT NEED OPENING.
     *
     * The tab shows a stub with an Add button that expands the real form — but a
     * publisher the engineer has already clicked into is ALREADY expanded, and
     * pressing Add there is pressing SUBMIT on an empty task: it files a blank
     * call note and leaves the driver typing into a form that is no longer on the
     * page. So the two are told apart rather than assumed.
     *
     * Waiting for EITHER of them, rather than waiting for the form and then
     * looking for the stub, is what keeps the common path quick: the publisher
     * usually renders the stub, and a fixed wait for a form that cannot appear
     * until Add is pressed is dead time on every single note. This returns the
     * instant the tab has rendered whichever it was going to render. */
    let box = findCallNoteTextarea(root);
    if (!box) {
        const found = await untilTrue(() => {
            const t = findCallNoteTextarea(root);
            if (t) return { box: t };
            const a = findStubSubmitButton(root) || findPublisherButton(root, /^add$/i);
            return a ? { add: a } : null;
        }, 15000, 150);

        if (!found) return wrote('the Add button', 'The Log a Call tab opened but had no Add button and no form.');
        if (found.box) {
            box = found.box;
        } else {
            try { found.add.click(); } catch (e) { /* the wait below reports it */ }
            box = await untilTrue(() => findCallNoteTextarea(root), 15000, 200);
        }
    }
    if (!box) return wrote('the Comments box', 'The Log a Call form never rendered a Comments box.');

    /* SUBJECT FIRST, TEXT SECOND. The picklist re-renders the row it is in when
     * it changes, and on some layouts that re-render clears a Comments box that
     * had already been filled — so the field that disturbs the form is set while
     * the form is still empty. */
    const subjectOk = await pickComboboxOption(findSubjectCombobox(root), 'Note');

    const held = setAuraFieldValue(box, text);
    if (held < text.length) {
        return wrote('the Comments box',
            `It accepted ${held.toLocaleString()} of ${text.length.toLocaleString()} characters, so the note would have been filed cut short.`);
    }

    const save = await untilTrue(() => findPublisherButton(root, /^save$/i), 6000, 150);
    if (!save) return wrote('the Save button', 'The form was filled in but no enabled Save button could be found.');
    try { save.click(); } catch (e) { return wrote('the Save button', 'Save would not take a click.'); }

    /* THE COMPOSER EMPTYING IS THE ONLY PROOF THERE IS.
     *
     * A click that lands on a disabled control, on a form with a validation error,
     * or on a page mid-re-render throws nothing at all — so "clicked Save" is not
     * the same statement as "the note is on the case", and reporting the first as
     * though it were the second is how an engineer ends up believing a call was
     * logged that was not. */
    const gone = await untilTrue(() => {
        const still = findCallNoteTextarea(root);
        return !still || !String(still.value || '').trim();
    }, 20000, 250);

    if (!gone) {
        return wrote('saving',
            'Save was pressed and the form still holds the note — Salesforce may have rejected it. Check the case before writing it again.');
    }
    return { ok: true, subject: subjectOk ? 'Note' : '', subjectSet: subjectOk, chars: text.length };
}

/* WRITE A POST — Feed tab, Post, type, Share. */
async function writeFeedPost(root, text) {
    const tab = findPublisherTab(root, /^post$/i);
    if (!tab) return wrote('the Post tab', 'No "Post" tab is on this case\'s publisher.');
    if (!tab.active) {
        try { tab.el.click(); } catch (e) { return wrote('the Post tab', 'The tab would not take a click.'); }
    }

    /* THE COMPOSER, WHICH MAY STILL BE A STUB.
     *
     * A publisher nobody has clicked into shows a stub — a placeholder and a Share
     * button that expands it into the real thing. Some orgs render that stub WITH
     * a `.ql-editor` inside it, which is the trap: the editor is found on the very
     * first look, is not the live one, and swallows everything typed into it while
     * Share never comes alive. So a visible stub button — NOT the presence of an
     * editor — is what says which state this publisher is in, and it is pressed
     * first whenever there is one.
     *
     * Only the dummy-classed button counts as a stub; see isStubSubmitButton. The
     * real Share answers to the same name and sits in the same bar, and pressing
     * THAT one to open the composer is pressing send on an empty post.
     *
     * Waiting for EITHER returns the moment the tab has rendered whichever it was
     * going to, rather than spending fifteen seconds on an editor that cannot
     * appear until the stub is pressed. */
    const opened = await untilTrue(() => {
        const stub = findStubSubmitButton(root);
        if (stub) return { stub };
        const e = findPostEditor(root);
        return e ? { editor: e } : null;
    }, 15000, 150);
    if (!opened) {
        return wrote('the post box', 'The Post tab opened but rendered neither a text box nor a Share button.');
    }

    let editor = opened.editor || null;
    if (opened.stub) {
        try { opened.stub.click(); } catch (e) { /* the wait below reports it */ }
        /* THE STUB GOING AWAY is what says the expand happened. The editor node is
         * sometimes reused across the swap, so waiting for a *different* one hangs
         * on the orgs that reuse it and its identity proves nothing on the rest. */
        await untilTrue(() => !findStubSubmitButton(root), 8000, 150);
        editor = await untilTrue(() => findPostEditor(root), 15000, 200);
    }
    if (!editor) return wrote('the post box', 'The publisher expanded but never rendered a text box.');

    let typed = typeIntoRichText(editor, text);

    // A stub that only appeared once the tab had settled — one expand, one retry,
    // before a box that will not take text is reported as a box that will not take
    // text.
    if (!typed) {
        const stub = findStubSubmitButton(root);
        if (stub) {
            try { stub.click(); } catch (e) { /* the retry below reports it */ }
            await untilTrue(() => !findStubSubmitButton(root), 8000, 150);
            editor = findPostEditor(root) || editor;
            typed = typeIntoRichText(editor, text);
        }
    }

    if (!typed) {
        return wrote('the post box',
            'The text box would not take the text. If this tab was in the background, bring it to the front and try again.');
    }

    /* SHARE ENABLES OFF THE EDITOR'S OWN MODEL, so waiting for it to come alive
     * is also the check that the typing actually registered rather than merely
     * appearing on screen. */
    const share = await untilTrue(() => findPublisherButton(root, /^share$/i), 8000, 150);
    if (!share) {
        return wrote('the Share button',
            'The text went in but Share never became available — Salesforce did not register the text.');
    }
    try { share.click(); } catch (e) { return wrote('the Share button', 'Share would not take a click.'); }

    const gone = await untilTrue(() => {
        const still = findPostEditor(root);
        return !still || !String(still.innerText || '').trim();
    }, 20000, 250);

    if (!gone) {
        return wrote('sharing',
            'Share was pressed and the text is still in the box — Salesforce may have rejected it. Check the feed before posting again.');
    }
    return { ok: true, chars: text.length };
}

/* THE WHOLE WRITE, from the panel's request to a result it can report. */
async function postToCaseFeed(request) {
    writeScopeCache = null;                 // re-decide where it is safe to look
    const text = String((request && request.text) || '');
    if (!text.trim()) return wrote('the text', 'There was nothing to write.');
    const kind = (request && request.kind) === 'post' ? 'post' : 'callNote';

    /* THE RIGHT CASE, not the first one in the DOM. The console keeps every open
     * case mounted at once, so a publisher found by walking the document belongs
     * to whichever tab happens to be leftmost — see rootForRecordRead. Writing is
     * where that matters most: a read into the wrong case is a wrong answer on
     * screen, a write into the wrong case is a note on somebody else's timeline. */
    const picked = rootForRecordRead(request && request.recordId,
        (r) => findFeedTabLinks(r).length > 0 || feedIsShowing(r));
    const root = picked.root;

    // Step one of the sequence the engineer would follow by hand. A case with no
    // posts yet reports no feed and still has a publisher, so this only fails the
    // write when there was no Feed tab to open at all.
    const tab = await activateFeedTab(root, { waitMs: 20000 });
    if (tab && tab.reason === 'no-feed-tab' && !feedIsShowing(root)) {
        return Object.assign(wrote('the Feed tab', 'No Feed tab could be found on this case.'), { scope: picked.scope });
    }

    const out = kind === 'post' ? await writeFeedPost(root, text) : await writeCallNote(root, text);
    return Object.assign(out, { scope: picked.scope, feedTab: (tab && tab.reason) || '' });
}

/* ============================================================================
 * THE ACCOUNT TEAM — the people who have to be on the email
 * ============================================================================
 * "Account Email" sends the customer the same reply the email action drafts, with
 * the account's own team copied in: the account owner, the TAM, the backup TAM
 * and the aligned support engineers. Those names are not on the CASE. They live
 * one record up, on the Account, and the sequence an engineer follows by hand is
 * Details tab → click the account → read six fields → back to the case.
 *
 * THIS DOES NOT CLICK THE ACCOUNT LINK, and that is the one deliberate departure
 * from the by-hand steps. Clicking it NAVIGATES the tab the case is open in, and
 * the panel would then be driving a page that is no longer the case — the write
 * that follows needs the case's own publisher, so it would have to navigate back
 * and wait for the record to mount a second time. The link's HREF is the useful
 * part of that click; the panel takes the href and reads the account in the same
 * hidden background window every other record read uses (see ocReader in
 * sidepanel.js), which leaves the engineer's tab exactly where they left it.
 *
 * TWO MESSAGES, because they happen in two different tabs:
 *
 *   GET_SALESFORCE_CASE_ACCOUNT runs in the CASE tab and answers "which account
 *   is this case against, and where is its record" — the Details tab is opened
 *   only if the field is not already mounted.
 *
 *   GET_SALESFORCE_ACCOUNT_TEAM runs in the ACCOUNT tab and reads the six people
 *   fields off the record.
 * ========================================================================== */

const ACCOUNT_LINK_RE = /\/lightning\/r\/Account\/([A-Za-z0-9]{15,18})(?:\/|$|\?)/;
const USER_LINK_RE = /\/lightning\/r\/User\/([A-Za-z0-9]{15,18})(?:\/|$|\?)/;

/* THE HIGHLIGHTS PANEL — the strip across the top of a record, which Lightning
 * renders from the COMPACT layout and keeps on screen whatever sub-tab is showing.
 *
 * It has to be identifiable, because it is a liar about two different things.
 *
 * It carries field LABELS: `records-highlights-details-item .slds-text-title` and
 * `.slds-page-header__detail-block .slds-text-title` are both in
 * FIELD_LABEL_SELECTOR, deliberately — reading a value out of the strip is often
 * the only way to get it. But a label in the strip is not a field in the record's
 * DETAIL layout, and code that counts labels to decide whether the layout has
 * mounted counts these and concludes that it has.
 *
 * That is not hypothetical. A SOTI Account's compact layout is Account Owner and
 * TAM. Both were found in the strip, on a record whose Details tab had never been
 * opened and whose other five team fields were therefore not in the document at
 * all — and because two fields had been "seen", nothing ever opened it. Every
 * account read back as its owner and its TAM, on every account, whatever its real
 * team, and the read reported itself finished.
 */
const HIGHLIGHTS_REGION_SELECTOR = [
    'records-highlights2',
    'records-highlights-details-item',
    'forcegenerated-highlights_panel',
    '.slds-page-header_record-home',
    '.slds-page-header--record-home',
    '.slds-page-header__detail-block',
    '.slds-page-header__detail-row'
].join(', ');

function inHighlightsRegion(el) {
    if (!el || typeof el.closest !== 'function') return false;
    try { return !!el.closest(HIGHLIGHTS_REGION_SELECTOR); } catch (e) { return false; }
}

/* THE RECORD'S OWN DETAIL FORM IS MOUNTED — which is not the same question as
 * "does this page have any field labels on it". A case shows its highlights strip
 * (Priority, Status, Case Number) whatever sub-tab is selected, and those labels
 * match FIELD_LABEL_SELECTOR, so "there are labels" is true on the Feed tab too
 * and would say the Details tab was already open when it was not.
 *
 * `data-target-selection-name="sfdc:RecordField.…"` is what Lightning puts on a
 * field rendered by the record DETAIL layout — but the highlights panel carries it
 * on its own items in some releases, so the strip is excluded by element rather
 * than trusted to be different.
 *
 * PRESENCE, NOT VISIBILITY, and that is a change. A Details panel the engineer has
 * opened once stays in the DOM afterwards, merely hidden behind whichever sub-tab
 * is showing — findCaseAccountLink already reads it where it lies, and a field in
 * a background reader window that Chrome is not painting measures 0×0 whether or
 * not it is there. Asking "is it rendered" answered "no" for a form that was
 * perfectly readable, and the only consequence was clicking a tab that did not
 * need clicking. What this has to decide is whether the layout is in the document. */
function detailFieldsShowing(root) {
    return findInShadows('[data-target-selection-name^="sfdc:RecordField."]', root, false)
        .some(el => !inHighlightsRegion(el));
}

/* SECTIONS SOMEBODY LEFT COLLAPSED. "Enterprise Support Information" is a
 * collapsible section on the Account layout, and a collapsed one on a Dynamic Forms
 * page does not render its fields at all — so the Details tab can be open, the
 * layout mounted, and the aligned engineers still nowhere in the document.
 *
 * Only ever called on the background reader tab, where nothing is being taken away
 * from anyone: expanding a section there is the same thing the engineer would do by
 * hand before reading the record, and the tab is closed a few seconds later.
 */
const SECTION_TOGGLE_SELECTOR = [
    '.slds-section__title-action',
    '.test-id__section-header-button',
    '.slds-accordion__summary-action'
].join(', ');

/* IS THIS SECTION SHUT? Asked two ways, because `aria-expanded` is not always there.
 *
 * SLDS marks an open section by putting `slds-is-open` on the `.slds-section` (or
 * `.slds-accordion__section`) container, and Lightning USUALLY also writes
 * `aria-expanded` on the title button — usually, not always, and a page that omits it
 * reported thirteen sections of which none looked collapsed while none of their fields
 * were anywhere in the document.
 *
 * `aria-expanded="true"` is believed outright: that is the page saying so. Otherwise
 * the container is asked, and a container that is neither open nor identifiable is
 * treated as SHUT — clicking a section that turned out to be open costs one collapsed
 * section on a page nobody is looking at, and missing one costs the account team.
 */
function sectionIsCollapsed(btn) {
    const aria = btn.getAttribute && btn.getAttribute('aria-expanded');
    if (aria === 'true') return false;
    if (aria === 'false') return true;
    const box = btn.closest && btn.closest('.slds-section, .slds-accordion__section, lightning-accordion-section');
    if (!box) return true;
    return !/\bslds-is-open\b/.test(String(box.className || ''));
}

function expandRecordSections(root, max = 30) {
    let opened = 0;
    for (const btn of findInShadows(SECTION_TOGGLE_SELECTOR, root, false)) {
        if (opened >= max) break;
        if (!sectionIsCollapsed(btn)) continue;
        try { btn.click(); opened++; } catch (_) { /* a section that will not open is not fatal */ }
    }
    return opened;
}

/* HOW MANY COLLAPSIBLE SECTIONS THE PAGE HAS AT ALL, open or shut — which is a
 * different number from how many were expanded, and the difference is diagnostic.
 * "Expanded 0" reads as a failure and is usually not one: it is what a page with no
 * collapsed sections says, and also what a page with no sections at all says, and
 * also what a page that has not rendered its layout yet says. */
const countRecordSections = (root) => findInShadows(SECTION_TOGGLE_SELECTOR, root, false).length;

/* AWAY AND BACK AGAIN — for a Details tab that is already the selected one and has
 * nothing under it.
 *
 * That combination is a real state and not a contradiction: Lightning mounts a record's
 * detail panel when the tab is SWITCHED TO, and a tab that was already selected when the
 * page loaded is never switched to. Clicking it changes nothing, because from the
 * framework's point of view it is already where it should be — which is why
 * activateDetailsTab reports `already-active-no-details` and stops.
 *
 * Leaving and returning is the one thing that does make the framework mount it, and it is
 * what an engineer does by hand without thinking about it: click Related, click Details.
 *
 * Only ever done in the background reader tab, on a record nobody is looking at.
 */
async function bounceDetailsTab(root, opts = {}) {
    const { waitMs = 2500, stepMs = 200, settleMs = 600 } = opts;
    if (detailFieldsShowing(root)) return { reason: 'already-showing' };

    const tabs = [];
    const seen = new Set();
    for (const el of findInShadows(TAB_LINK_SELECTOR, root, false)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const label = tabLabelOf(el);
        if (!label) continue;
        tabs.push({ el, label, isDetails: DETAILS_TAB_RE.test(label) });
    }
    const details = tabs.find(t => t.isDetails);
    // Anything that is not Details and not the feed — the feed is expensive to mount and
    // is the one tab that can start loading a whole Chatter history we do not want.
    const other = tabs.find(t => !t.isDetails && !/^(chatter|feed|activity)$/i.test(t.label));
    if (!details || !other) return { reason: 'no-sibling-tab', tabs: tabs.length };

    try { other.el.click(); } catch (e) { return { reason: 'sibling-click-failed', tabs: tabs.length }; }
    await sleep(settleMs);
    try { details.el.click(); } catch (e) { return { reason: 'return-click-failed', via: other.label }; }

    const until = Date.now() + waitMs;
    while (Date.now() < until) {
        await sleep(stepMs);
        if (detailFieldsShowing(root)) return { reason: 'opened', via: other.label };
    }
    return { reason: 'bounced-no-details', via: other.label, tabs: tabs.length };
}

/* A SCROLL, FOR A PAGE THAT MOUNTS WHAT IT THINKS YOU CAN SEE.
 *
 * Lightning defers rendering the parts of a long record that are below the fold, and
 * decides what is below the fold from geometry. In the reader tab that geometry is
 * degenerate, so "below the fold" is everything — which is the shape of a page that has
 * thirteen section headers and not one field inside them.
 *
 * Scrolling every scroller on the page to the bottom and back is what tells the framework
 * those sections have been looked at. It costs a few property writes and cannot damage a
 * page that is about to be closed; on a page that was never lazy it does nothing at all.
 */
/* IT HAS TO STEP, and a single jump to the bottom is why the first version of this would
 * not have worked either. Lightning mounts a section when it comes INTO VIEW, so what
 * mounts the whole record is the sections passing through the viewport one after another
 * — not the scroll position ending up somewhere. Jumping straight to the bottom moves
 * nothing through anything: the sections in between are never on screen for a frame, and
 * the observers that would have mounted them never fire.
 *
 * So: a screenful at a time, with long enough between steps for the framework to react,
 * and then back to the top. Capped in both directions — a page cannot cost more than
 * `steps` pauses however long it is, and a page that does not scroll costs one look. */
/* WHICH RECORDS THIS DOCUMENT HAS ALREADY BEEN WALKED THROUGH. Per DOCUMENT, so a fresh
 * load of the same record — which is what the panel does when a read comes back short —
 * starts again from nothing, as it should: the point of reloading is to render it again. */
const accountScrolled = new Set();

async function nudgeRecordScroll(root, opts = {}) {
    /* FASTER THAN IT WAS, because the window is now genuinely being painted while this
     * runs (see ocReaderHoldFront in sidepanel.js). The old numbers — four scrollers,
     * ten steps, 140ms apart — were sized for a page that might not react at all, and
     * cost five and a half seconds of every read. Two scrollers is the record and its
     * one container; eight steps still walks every section through the viewport; 90ms is
     * comfortably more than a frame on a window that is drawing them. */
    const { maxScrollers = 2, steps = 8, stepMs = 90 } = opts;

    /* FOUND BY MEASUREMENT, NOT BY CLASS NAME. The first version of this looked for the
     * container classes a Lightning record page is BELIEVED to scroll in
     * (`.slds-template__container`, `.oneCenterStage`, and the rest) and scrolled the
     * document when it found none of them — which is a list of guesses about somebody
     * else's markup, and it guessed wrong on the very page it was written for: it
     * reported that it had scrolled, and nothing had moved.
     *
     * `isScrollable` asks the element instead — computed overflow, and more content than
     * box — which is the same question the feed auto-loader has always asked and is true
     * whatever the org calls its containers. The deepest scrollers come first, because on
     * a record page the outer ones are chrome and the inner one holds the record. */
    const scrollers = [];
    const consider = (el) => {
        if (!el || scrollers.includes(el)) return;
        try { if (isScrollable(el)) scrollers.push(el); } catch (_) {}
    };
    for (const el of findInShadows('div, main, section, [role="main"]', root, false)) consider(el);
    scrollers.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    try { consider(document.scrollingElement || document.documentElement); } catch (_) {}
    if (!scrollers.length) return 0;
    scrollers.length = Math.min(scrollers.length, maxScrollers);

    for (const el of scrollers) {
        let start = 0;
        try { start = el.scrollTop; } catch (_) {}
        for (let i = 1; i <= steps; i++) {
            let done = false;
            try {
                const to = Math.ceil((el.scrollHeight - el.clientHeight) * (i / steps));
                el.scrollTop = to;
                done = to <= 0;
            } catch (_) { done = true; }
            if (done) break;
            await sleep(stepMs);
        }
        try { el.scrollTop = start; } catch (_) {}
    }
    return scrollers.length;
}

/* WHAT IS ACTUALLY ON THIS PAGE — a census, not a scrape.
 *
 * When an account team comes back as two people off the highlights strip, the question
 * is where the other five fields are, and every answer to that looks the same from
 * outside: no fields. They could be behind a tab, inside a collapsed section, in a
 * shadow root this file cannot reach, or rendered under labels nobody expected.
 *
 * So this counts the shapes each of those would leave behind and hands them back with
 * the read. It is a dozen selector queries on a page that is about to be closed, and it
 * turns "it did not work" into a specific sentence about a specific org's markup.
 */
function accountPageProbe(root) {
    const labels = findInShadows(FIELD_LABEL_SELECTOR, root, false);
    const outside = labels.filter(el => !inHighlightsRegion(el));
    const toggles = findInShadows(SECTION_TOGGLE_SELECTOR, root, false);

    let shadowRoots = 0;
    try {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.shadowRoot) shadowRoots++;
    } catch (_) { shadowRoots = -1; }

    return {
        /* IS THIS TAB BEING RENDERED AT ALL — the question every other number here is a
         * proxy for. A Lightning record page mounts its field components lazily, and in a
         * tab Chrome has decided is hidden (minimized window, or a restored one sitting
         * fully behind another) the geometry every lazy-mount decision is made from is
         * degenerate: nothing intersects the viewport, so nothing mounts. The section
         * headers come up because they are part of the layout shell; the fields inside
         * them never do. `visibility` and `viewport` say whether that is what happened,
         * and no amount of selector work can. */
        visibility: (typeof document.visibilityState === 'string') ? document.visibilityState : '?',
        focused: (typeof document.hasFocus === 'function') ? document.hasFocus() : null,
        viewport: `${window.innerWidth || 0}x${window.innerHeight || 0}`,
        url: String(location.pathname || ''),
        title: String(document.title || '').slice(0, 80),
        // What the page calls its own sections and tabs — so a layout that simply does not
        // hold these fields can be told from one that has not rendered them.
        sectionTitles: toggles.slice(0, 20)
            .map(b => String(b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
            .filter(Boolean),
        tabLabels: findInShadows(TAB_LINK_SELECTOR, root, false)
            .map(tabLabelOf).filter(Boolean).slice(0, 12),
        labels: labels.length,
        labelsOutsideStrip: outside.length,
        // The first few, so a label this file is not asking for can be SEEN rather than
        // guessed at — an org that renamed "Backup TAM" is otherwise indistinguishable
        // from one that never rendered it.
        sample: (() => {
            const seen = new Set();
            const uniq = [];
            for (const el of outside) {
                const t = labelTextOf(el);
                if (!t || seen.has(t)) continue;
                seen.add(t);
                uniq.push(t);
            }
            /* THE NEAR MISSES FIRST. A label this panel is not asking for but plainly
             * should be — a renamed TAM field, an engineer numbered past four — is the
             * one thing worth every character it costs, and the first fourteen labels
             * on a thirty-field layout will never contain it. */
            const teamish = uniq.filter(t => /tam|engineer|aligned|support|owner/.test(t));
            const rest = uniq.filter(t => !teamish.includes(t));
            return teamish.concat(rest).slice(0, 20);
        })(),
        selectionNames: findInShadows('[data-target-selection-name^="sfdc:RecordField."]', root, false).length,
        flexipageFields: findInShadows('flexipage-field', root, false).length,
        outputFields: findInShadows('lightning-output-field', root, false).length,
        forceLookups: findInShadows('force-lookup', root, false).length,
        userLinks: findInShadows('a[href*="/lightning/r/User/"]', root, false).length,
        sections: toggles.length,
        sectionsCollapsed: toggles.filter(sectionIsCollapsed).length,
        shadowRoots
    };
}

const DETAILS_TAB_RE = /^(details|record details|case details|account details)$/i;

/* `allowHidden` IS FOR THE BACKGROUND READER WINDOW, and without it the reader
 * window cannot open a Details tab at all.
 *
 * Invisible tabs are skipped by default for a good reason: the console keeps every
 * open case's tab bar in the DOM, so clicking an invisible one switches a case the
 * engineer is looking at. That reason does not exist in the reader window — it holds
 * one record, nobody is looking at it, and it is closed a few seconds later. What
 * DOES exist there is that Chrome barely renders a minimized background window, so
 * `isVisible` measures 0×0 for controls that are present and perfectly clickable —
 * the same thing accountFieldBox works around when it reads fields.
 *
 * So: visible candidates first, always, and hidden ones only as a fallback and only
 * when the caller says the page is safe to click blind. */
function findDetailsTabLinks(root, allowHidden = false) {
    const out = [];
    const hidden = [];
    const seen = new Set();
    for (const el of findInShadows(TAB_LINK_SELECTOR, root, false)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const label = tabLabelOf(el);
        if (!DETAILS_TAB_RE.test(label)) continue;
        const li = el.closest ? el.closest('li') : null;
        const active = el.getAttribute('aria-selected') === 'true' ||
                       !!(li && li.className && /slds-is-active/.test(li.className));
        (isVisible(el) ? out : hidden).push({ el, label, active, exact: /^details$/i.test(label) });
    }
    const byExact = (a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0);
    out.sort(byExact);
    if (allowHidden) { hidden.sort(byExact); out.push(...hidden); }
    return out;
}

/* Open the record's Details tab if the detail form is not already mounted.
 *
 * Same shape as activateFeedTab and the same rules: never throws, never clicks a
 * tab belonging to a case the engineer is not looking at (findInShadows is given
 * the record's own root and invisible controls are skipped), and reports what it
 * did so a read that came back empty can say why.
 *
 * A LAYOUT WITH NO SUB-TABS AT ALL is the common case on an Account record — the
 * fields are simply on the page — so "no details tab" is reported without waiting
 * for anything, and the caller reads what is there.
 */
async function activateDetailsTab(root, opts = {}) {
    const { waitMs = 12000, stepMs = 200, maxTries = 2, allowHidden = false, mustShow = false } = opts;

    /*  IS THE DIFFERENCE BETWEEN READING AND WRITING, and it is not a nicety.
     *
     * A reader only needs the detail form to be IN THE DOCUMENT — a Details panel the
     * engineer opened once stays there, merely hidden behind whichever sub-tab is showing,
     * and it is read where it lies without disturbing them. detailFieldsShowing answers
     * that, and this returns early on it.
     *
     * A WRITE has to be looked at. Filling in a field on a panel the engineer cannot see —
     * and then telling them to press Save — is asking them to go and find it, on a case
     * where the note is the whole point of the exercise. So a caller that is about to write
     * asks for the tab to be SHOWN, and the early return is skipped: the only thing that
     * counts then is whether the Details tab is the ACTIVE one. */
    if (!mustShow && detailFieldsShowing(root)) {
        return { clicked: false, reason: 'already-showing', candidates: 0 };
    }

    let candidates = findDetailsTabLinks(root, allowHidden);
    if (!candidates.length && root !== document) candidates = findDetailsTabLinks(document, allowHidden);
    if (!candidates.length) return { clicked: false, reason: 'no-details-tab', candidates: 0 };

    /* A TAB THAT IS ALREADY SELECTED IS NOT WAITING TO BE CLICKED. Salesforce marks the
     * live one with `aria-selected="true"` (or `slds-is-active` on the li), and clicking
     * it again does nothing but spend the caller's budget — which matters here because the
     * caller POLLS, so the same fruitless click would otherwise be made every 700ms for
     * the whole read. Reported rather than retried: "the Details tab is selected and there
     * are still no fields under it" is a fact about the page worth getting back, and it is
     * not the same failure as "there is no Details tab". */
    const clickable = candidates.filter(c => !c.active);
    if (!clickable.length) {
        // Already the tab in front — which is the whole of what  wanted.
        return { clicked: false, candidates: candidates.length, label: candidates[0].label,
                 reason: mustShow ? 'already-active' : 'already-active-no-details' };
    }

    let last = '';
    for (const c of clickable.slice(0, maxTries)) {
        last = c.label;
        try { c.el.click(); } catch (_) { continue; }
        const until = Date.now() + waitMs;
        while (Date.now() < until) {
            await sleep(stepMs);
            if (mustShow ? findDetailsTabLinks(root, allowHidden).some(t => t.active) : detailFieldsShowing(root)) {
                return { clicked: true, label: c.label, reason: 'opened', candidates: candidates.length };
            }
        }
    }
    return { clicked: true, label: last, reason: 'clicked-no-details', candidates: candidates.length };
}

/* WHERE THIS CASE'S ACCOUNT RECORD IS.
 *
 * Read off the Account Name field's own anchor rather than off the field's text,
 * because the text is a name and the panel needs a record to go and read. The
 * name comes back too — it is what the confirmation box says out loud, so the
 * engineer can see the team belongs to the account they think it does.
 *
 * VISIBILITY IS NOT REQUIRED, and that is what usually saves the click. A Details
 * tab the engineer has opened once stays in the DOM afterwards, merely hidden
 * behind whichever sub-tab is showing — and the account link in it is still this
 * case's account, so it is read where it lies. Only a panel Lightning has never
 * mounted has nothing in it to find, and that is the one case activateDetailsTab
 * is called for.
 *
 * The field is found the same way every other field on this page is (label, then
 * the boxes around it), and only then does it fall back to any account link under
 * the record's detail form. The fallback is scoped to a detail-layout field for a
 * reason: a case page carries account links in its related lists and in the
 * highlights strip's hover cards, and the FIRST account link in document order is
 * not reliably the case's own account.
 */
function findCaseAccountLink(root) {
    const fromAnchor = (a) => {
        const href = String((a && a.getAttribute && a.getAttribute('href')) || '');
        const m = href.match(ACCOUNT_LINK_RE);
        if (!m) return null;
        const name = cleanFieldValue(valueText(a)) || String(a.textContent || '').replace(/\s+/g, ' ').trim();
        return { id: m[1], name, url: new URL(href, location.origin).href };
    };

    for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
        const text = labelTextOf(label);
        if (text !== 'account name' && text !== 'account') continue;
        for (const scope of valueScopes(label)) {
            for (const a of queryDeep(scope, 'a[href*="/lightning/r/Account/"]')) {
                const hit = fromAnchor(a);
                if (hit && hit.name) return hit;
            }
        }
    }

    for (const field of findInShadows('[data-target-selection-name^="sfdc:RecordField."]', root, false)) {
        if (!isVisible(field)) continue;
        const sel = field.getAttribute('data-target-selection-name') || '';
        if (!/\.Account(Id)?$/i.test(sel)) continue;
        for (const a of queryDeep(field, 'a[href*="/lightning/r/Account/"]')) {
            const hit = fromAnchor(a);
            if (hit && hit.name) return hit;
        }
    }

    return null;
}

/* THE SIX PEOPLE, EACH BY ITS API NAME FIRST AND ITS LABEL SECOND.
 *
 * The API name is the field, and it is what the layout writes into
 * `data-target-selection-name` and `data-field-id` — so it survives an org
 * renaming the label, which two of these have plainly had done to them:
 * Aligned_Backup_Engineer_1__c is labelled "Aligned Support Engineer 3" and
 * Aligned_Backup_Engineer_2__c is "Aligned Support Engineer 4". Matching those
 * two by their labels alone would have looked right and read the wrong fields the
 * day somebody put the labels back.
 *
 * The label list is the fallback, for the layout that renders these as plain
 * form elements with no selection name on them (Salesforce Classic, and a
 * Dynamic Forms layout in some orgs), and it carries the alternative wording each
 * field is known by.
 *
 * "Support Comments / Aligned Engineers" is NOT on this list, deliberately: it is
 * free text about the account (language, volume, product specialist) and not a
 * person field, so there is no address to be had from it.
 */
const ACCOUNT_TEAM_FIELDS = [
    { key: 'owner', role: 'Account Owner', api: 'Owner',
      labels: [/^account owner$/, /^owner$/, /^owner name$/] },
    { key: 'tam', role: 'TAM', api: 'Support_Owner__c',
      labels: [/^tam$/, /^technical account manager$/, /^support owner$/] },
    { key: 'backupTam', role: 'Backup TAM', api: 'Backup_TAM__c',
      labels: [/^backup tam$/, /^backup technical account manager$/] },
    { key: 'ase1', role: 'Aligned Support Engineer 1', api: 'Aligned_Support_Engineer_1__c',
      labels: [/^aligned support engineer 1$/] },
    { key: 'ase2', role: 'Aligned Support Engineer 2', api: 'Aligned_Support_Engineer_2__c',
      labels: [/^aligned support engineer 2$/] },
    { key: 'ase3', role: 'Aligned Support Engineer 3', api: 'Aligned_Backup_Engineer_1__c',
      labels: [/^aligned support engineer 3$/, /^aligned backup engineer 1$/] },
    { key: 'ase4', role: 'Aligned Support Engineer 4', api: 'Aligned_Backup_Engineer_2__c',
      labels: [/^aligned support engineer 4$/, /^aligned backup engineer 2$/] }
];

// `Support_Owner__c` → `RecordSupport_Owner_cField`, which is what the flexipage
// writes on the field wrapper. A standard field has no trailing __c and keeps its
// own name.
function flexipageFieldId(api) {
    return 'Record' + String(api || '').replace(/__c$/, '_c') + 'Field';
}

/* VISIBLE FIRST, AND THEN ANY MATCH AT ALL — which is the same rule
 * findCaseAccountLink states above it, applied here for the same reason.
 *
 * This record is read in the BACKGROUND READER WINDOW: a minimized window Chrome
 * is not painting, holding a long Account layout of which perhaps a third is
 * inside the viewport it thinks it has. `isVisible` answers by measuring a rect,
 * so a field that is mounted, populated and perfectly readable reports 0x0 for no
 * better reason than that it is a long way down the page or inside a section
 * somebody left collapsed — and requiring visibility discarded it and returned
 * null, which the caller cannot tell apart from "this account has no TAM".
 *
 * A field's own box is not ambiguous the way a page's first account link is: it
 * was found BY this field's API name or BY this field's label, so a hidden one is
 * still this field. Visible-first keeps the live layout winning wherever there
 * genuinely are two.
 */
/* TWO BOXES ARE THE SAME FIELD IF EITHER CONTAINS THE OTHER.
 *
 * The three lookups below hand back DIFFERENT ELEMENTS for one field: the selection-name
 * path returns the flexipage's outer `div.slds-grid`, the label path returns the
 * `.slds-form-element` inside it. Comparing by identity would therefore let one field be
 * claimed twice — once as the outer box and once as the inner — and the sweep below would
 * report the same engineer as a second person. */
function sameFieldBox(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try { return a.contains(b) || b.contains(a); } catch (e) { return false; }
}

const boxIsClaimed = (claimed, box) => claimed.some(c => sameFieldBox(c, box));

function accountFieldBox(root, spec, claimed = []) {
    const free = (els) => els.filter(el => !boxIsClaimed(claimed, el));
    const pick = (els) => { const f = free(els); return f.find(isVisible) || f[0] || null; };

    const byName = pick(findInShadows(
        `[data-target-selection-name="sfdc:RecordField.Account.${spec.api}"]`, root, false));
    if (byName) return byName;

    const byFieldId = pick(findInShadows(
        `[data-field-id="${flexipageFieldId(spec.api)}"]`, root, false));
    if (byFieldId) return byFieldId;

    /* THE LABEL, which is the path every field takes on a layout that renders
     * these as plain form elements with no selection name and no flexipage
     * wrapper on them — and several of the aligned-engineer fields do exactly
     * that on a real org's Account page.
     *
     * `claimed` is what makes a DUPLICATED label survivable, and duplicated labels are
     * real: an org whose layout has two aligned-engineer fields both reading "Aligned
     * Support Engineer 1" would otherwise hand the same box to both specs and lose the
     * second engineer entirely. Skipping boxes already taken resolves them positionally
     * instead — first match to the first field that asks, second to the next. */
    let hidden = null;
    for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
        const text = labelTextOf(label);
        if (!spec.labels.some(re => re.test(text))) continue;
        const box = (label.closest && label.closest(
            'records-record-layout-item, lightning-output-field, .slds-form-element')) || label.parentElement;
        if (!box || boxIsClaimed(claimed, box)) continue;
        if (isVisible(box)) return box;
        if (!hidden) hidden = box;
    }
    return hidden;
}

/* EVERY ALIGNED-ENGINEER FIELD ON THE PAGE, whatever it is numbered and whatever
 * else the layout has done to it.
 *
 * ACCOUNT_TEAM_FIELDS is a list of seven fields this panel knows the API names of, and
 * it is right for the ones it names — but it is a closed list, and the account team is
 * not. An org can put a fifth aligned engineer on the layout, renumber the ones it has,
 * label two of them the same, or rename `Aligned_Backup_Engineer_1__c` again. Every one
 * of those loses an engineer silently: the field is on the page, plainly labelled, with
 * a User link in it, and nothing asks for it.
 *
 * So after the seven named fields are read, this sweeps for anything that is obviously
 * an aligned engineer and was not claimed by one of them. It is deliberately generous
 * about the label — support/backup, any number, any of the wordings — because a field
 * this reads by mistake shows up as a named person in the review box with an × beside
 * it, whereas one it misses shows up as nothing at all.
 */
const ALIGNED_ENGINEER_LABEL_RE = /^aligned\s+(support|backup)\s+engineer(\s*\d+)?$/;

function alignedEngineerBoxes(root) {
    const out = [];
    for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
        const text = labelTextOf(label);
        if (!ALIGNED_ENGINEER_LABEL_RE.test(text)) continue;
        const box = (label.closest && label.closest(
            'records-record-layout-item, lightning-output-field, .slds-form-element')) || label.parentElement;
        if (!box) continue;
        // The same field reached through both its label elements — the container carries
        // .slds-form-element__label and the span inside it .test-id__field-label, and
        // FIELD_LABEL_SELECTOR matches both.
        if (out.some(h => sameFieldBox(h.box, box))) continue;
        out.push({ box, role: String(label.textContent || '').replace(/\s+/g, ' ').trim() });
    }
    return out;
}

/* THE PERSON IN ONE OF THOSE BOXES, or null for a field the account has left
 * empty — which four of the seven routinely are.
 *
 * The user LINK is what is read, not the box's text, and that is what makes an
 * empty field distinguishable from a filled one: an empty lookup still renders a
 * `<span class="not-navigable">` with nothing in it, and on some layouts the
 * inline-edit affordance beside it is the only text in the whole box. A link with
 * a name in it is the one unambiguous statement that somebody is in this field.
 *
 * The id comes back with the name because it is the only thing about a Salesforce
 * user that cannot be two people. The Cc lookup is driven by name — there is no
 * address on this page to drive it with — so the id is what the panel reports
 * against when a name comes back ambiguous.
 */
function personFromFieldBox(box) {
    if (!box) return null;

    for (const a of queryDeep(box, 'a[href*="/lightning/r/User/"]')) {
        const name = cleanFieldValue(valueText(a)) || String(a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        const m = String(a.getAttribute('href') || '').match(USER_LINK_RE);
        return { name, userId: m ? m[1] : '' };
    }

    /* NO LINK. Either the field is empty, or this org renders these as plain text
     * (a formula field carrying the name, and Classic's detail table). Read the
     * CONTROL rather than the box: the box holds the label as well, and "TAM" is
     * not a person. */
    const control = (box.querySelector && box.querySelector('.slds-form-element__control')) || null;
    const output = (box.querySelector && box.querySelector('[data-output-element-id="output-field"]')) || null;
    const text = cleanFieldValue(valueText(output || control || null));
    if (!text) return null;
    // The affordance, and the label read back — the same two things getFieldValue
    // refuses, for the same reason.
    if (/^(edit|open|preview)\b/i.test(text)) return null;
    return { name: text, userId: '' };
}

/* HAS THIS FIELD ANSWERED YET — which is a different question from "is it empty",
 * and telling the two apart is the whole of why an account team came back short.
 *
 * A Lightning record layout mounts in two stages. The FIELD BOXES come up first,
 * label and all, carrying `data-target-selection-name` and matching every selector
 * accountFieldBox uses; the VALUES arrive afterwards, when the record data lands.
 * For the seconds in between, "Backup TAM" is on the page with nothing in it — and
 * personFromFieldBox reports exactly what it reports for an account that genuinely
 * has no backup TAM: null.
 *
 * `fieldsSeen` therefore counts the SKELETON, and the panel's readiness test used
 * it as though it counted the answer: seven boxes on the page ended the poll, the
 * reader tab was closed, and whichever lookups had resolved by then — in practice
 * the Account Owner and the TAM — were reported as the whole account team, cached
 * for fifteen minutes, and Cc'd. That is the "only two people" bug.
 *
 * `<span class="not-navigable">` is the signal that separates them, and it is worth
 * being precise about why: that span is how `force-lookup` renders a lookup whose
 * value it HAS and which is blank — it is on both unfilled aligned-engineer fields
 * of the record this was written against, sitting exactly where the avatar and the
 * User link sit on the filled ones. A lookup still waiting on the record data has
 * neither: the control is empty, or the `force-lookup` is not there at all.
 *
 * So the marker is asked for RATHER THAN the wrapper. A bare `force-lookup` with
 * no link and no blank marker in it is a shell, and calling that "resolved" would
 * put the whole weight back on a timer — which is the thing this exists to replace.
 *
 * Text layouts (Classic's detail table, a formula field carrying the name) render
 * no `force-lookup` ever, so any text in the control counts as an answer too. An
 * empty field on one of those layouts has no positive marker to offer and is read
 * as still loading, which costs the caller time and never costs it people: the
 * painted pass runs its full budget and returns whoever is there.
 */
const FIELD_BLANK_MARKER_SELECTOR = '.not-navigable, .slds-form-element__static.is-empty, [data-empty="true"]';

function fieldHasResolved(box) {
    if (!box) return false;
    // A spinner in the box is Salesforce saying so itself.
    if (queryDeep(box, 'lightning-spinner, .slds-spinner, .slds-spinner_container').length) return false;
    if (queryDeep(box, FIELD_BLANK_MARKER_SELECTOR).length) return true;
    const control = (box.querySelector && box.querySelector('.slds-form-element__control')) || null;
    return !!(control && String(control.textContent || '').replace(/\s+/g, ' ').trim());
}

function scrapeAccountTeam(root) {
    /* `fieldsTotal` travels with the answer so the PANEL can tell a layout that
     * has finished mounting from one that is still arriving — see
     * readAccountRecordTeam, which used to stop polling at the first field it
     * saw and reported the two people who mount first as the whole team.
     *
     * `fieldsPending` is the other half of that, and the important half: a box
     * that is on the page but has not produced its value yet (see
     * fieldHasResolved). A read with any pending field is NOT a finished read,
     * however many boxes it found.
     *
     * `fromHighlights` and `detailForm` are the third thing, and the one that made
     * every account look like a two-person account: a field read out of the
     * highlights strip is a real field and a real person, but it is NOT evidence
     * that the record's detail layout has mounted. Counted separately so the caller
     * can tell "this account has two people" from "this page is showing me its
     * header and nothing else". See inHighlightsRegion. */
    const out = { accountName: '', people: [], fieldsSeen: 0, fieldsFilled: 0,
                  fieldsTotal: ACCOUNT_TEAM_FIELDS.length, fieldsPending: 0,
                  fromHighlights: 0, detailForm: detailFieldsShowing(root),
                  extraEngineers: 0 };

    for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
        const text = labelTextOf(label);
        if (text !== 'account name' && text !== 'account') continue;
        out.accountName = getFieldValue(label);
        if (out.accountName) break;
    }
    if (!out.accountName) {
        // The record's own heading, which an Account page always has and which is
        // the account's name by definition.
        const title = findInShadows(
            'records-entity-label + h1, h1 .entityNameTitle, .slds-page-header__title, records-highlights2 h1',
            root, false).map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim())
            .find(t => t && t.length < 120);
        if (title) out.accountName = cleanFieldValue(title);
    }

    /* CLAIMED BOXES, carried across all seven specs — see accountFieldBox. Without it a
     * layout with two identically-labelled engineer fields gives the same box to both
     * and the second engineer is lost. */
    const claimed = [];
    for (const spec of ACCOUNT_TEAM_FIELDS) {
        const box = accountFieldBox(root, spec, claimed);
        if (!box) continue;
        claimed.push(box);
        out.fieldsSeen++;
        if (inHighlightsRegion(box)) out.fromHighlights++;
        const person = personFromFieldBox(box);
        if (!person && !fieldHasResolved(box)) out.fieldsPending++;
        if (!person) continue;
        out.fieldsFilled++;
        out.people.push({ key: spec.key, role: spec.role, name: person.name, userId: person.userId });
    }

    /* AND THEN EVERY OTHER ALIGNED ENGINEER ON THE PAGE — see alignedEngineerBoxes.
     * The seven named fields are the ones this panel knows the API names of; this is the
     * catch for the ones it does not, which on a real org is a renumbered field, a fifth
     * engineer, or two fields wearing the same label. Reported with the label the page
     * actually printed, so the review box names the field it came from rather than a slot
     * number this file made up.
     *
     * Deduplicated by user id here as well as in the panel: the same person reached twice
     * through two boxes that are genuinely different fields is a real duplicate and worth
     * merging, and dedupeAccountTeam would merge it anyway — doing it here keeps
     * `extraEngineers` an honest count of what the sweep actually ADDED. */
    for (const hit of alignedEngineerBoxes(root)) {
        if (boxIsClaimed(claimed, hit.box)) continue;
        claimed.push(hit.box);
        out.fieldsSeen++;
        const person = personFromFieldBox(hit.box);
        if (!person && !fieldHasResolved(hit.box)) out.fieldsPending++;
        if (!person) continue;
        const dup = out.people.some(p => (p.userId && person.userId && p.userId === person.userId)
            || (!p.userId && !person.userId && samePersonName(p.name, person.name)));
        if (dup) continue;
        out.fieldsFilled++;
        out.extraEngineers++;
        out.people.push({ key: 'aseExtra', role: hit.role || 'Aligned Support Engineer',
                          name: person.name, userId: person.userId });
    }
    return out;
}

/* ============================================================================
 * WRITING THE EMAIL INTO THE CASE'S OWN COMPOSER
 * ============================================================================
 * Feed tab → Email → Cc → the recipients → Subject → the body. The same six
 * clicks the engineer would make, and every one of them confirmed rather than
 * assumed, exactly as in "WRITING TO THE CASE" above.
 *
 * IT DOES NOT PRESS SEND, and that is a rule rather than an omission. Everything
 * else this file writes lands somewhere internal — a call note, a Chatter post —
 * and can be corrected afterwards by whoever reads it. An email cannot: it is
 * gone the moment Send is pressed, to the customer and to the whole account team
 * this action exists to copy in. So the composer is left FILLED IN and open, the
 * engineer reads it in the place they would read any other draft, and the last
 * click is theirs.
 *
 * THE Cc LOOKUP IS DRIVEN BY NAME, because a name is all the Account record has.
 * The team fields are user lookups: they render "Vlastimil Turzik" and a link to
 * a User record, and nowhere on that page is there an email address. Salesforce's
 * own recipient lookup resolves a name to the right address — it is the same
 * search the engineer would use — so the name is typed and the org's own answer
 * is taken. Nothing here ever COMPOSES an address out of a name: a guessed
 * firstname.lastname@ that happens to be wrong is an email about a customer's
 * case sent to whoever does own that mailbox, and the panel would report it as a
 * success.
 * ========================================================================== */

const RECIPIENT_INPUT_SELECTOR =
    'input[aria-describedby="recipientsInputLabel"], ' +
    'input.uiInputTextForAutocomplete[role="combobox"], ' +
    'input.uiPillContainerAutoComplete[role="combobox"]';

// Every To/Cc/Bcc box the composer is currently showing, in document order — so
// the first one is To, which is the one thing about their order that is fixed.
function findRecipientInputs(root) {
    for (const scope of writeScopes(root)) {
        const found = findInShadows(RECIPIENT_INPUT_SELECTOR, scope, false).filter(isVisible);
        if (found.length) return found;
    }
    return [];
}

/* THE "Cc" TOGGLE — the link that reveals the row, not a row that is already
 * there. Salesforce renders it as an anchor whose href is the literal string
 * "Cc", which is the most specific handle on the page; the text match is the
 * fallback for a layout that renders it as a button.
 *
 * EXACT, and against a very short label: /cc/ as a substring also matches
 * "Bcc", and the two sit side by side.
 */
function findRecipientToggle(root, re, hrefValue) {
    return findInScopes(root, (scope) => {
        if (hrefValue) {
            const byHref = findInShadows(`a[href="${hrefValue}"]`, scope, false)
                .find(el => isVisible(el) && controlIsEnabled(el));
            if (byHref) return byHref;
        }
        for (const el of findInShadows('a[role="button"], a.uiOutputURL, button', scope, false)) {
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!re.test(t) || !isVisible(el) || !controlIsEnabled(el)) continue;
            return el;
        }
        return null;
    });
}

/* IS THIS BOX THE Cc BOX?
 *
 * Asked of the row the input sits in, walking outward until a box is found that
 * holds exactly ONE recipient input — because a container holding both To and Cc
 * would match on the Cc label and hand back the To box, which is the one mistake
 * here that cannot be seen afterwards: the account team would go to the customer
 * as visible recipients.
 *
 * Anchors and buttons are skipped when reading the row's words. The To row is
 * where the "Cc" and "Bcc" TOGGLES live, so the To row genuinely contains the
 * text "Cc" — in a control, which is exactly what distinguishes it from a label.
 */
function recipientRowLabel(input) {
    let node = input && input.parentElement;
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
        let boxes = 0;
        try { boxes = node.querySelectorAll(RECIPIENT_INPUT_SELECTOR).length; } catch (_) { boxes = 0; }
        if (boxes !== 1) continue;

        let words = [];
        try {
            words = Array.from(node.querySelectorAll('label, legend, .label, .uiLabel, .slds-form-element__label, span'))
                .filter(el => !(el.closest && el.closest('a, button')))
                .map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim().replace(/[:：]\s*$/, '').toLowerCase())
                .filter(t => t === 'to' || t === 'cc' || t === 'bcc');
        } catch (_) { words = []; }

        if (words.includes('cc')) return 'cc';
        if (words.includes('bcc')) return 'bcc';
        if (words.includes('to')) return 'to';
    }
    return '';
}

function recipientInputByRole(root, role) {
    return findRecipientInputs(root).find(i => recipientRowLabel(i) === role) || null;
}

/* ============================================================================
 * REPLY ALL — the step that makes it a REPLY rather than a new message
 * ============================================================================
 * Pressing "Email" on the publisher opens a BLANK compose form. That is not what an
 * engineer answering a case does: they press Reply All on the customer's last email,
 * which is what puts the customer and everyone already on the thread into To, sets the
 * subject to "RE: <their subject>" so it threads in the customer's mail client, and
 * quotes the message being answered underneath.
 *
 * Skipping it produced a draft that LOOKED complete in the composer — account team on
 * Cc, subject filled in, body written — and would have arrived as a brand-new message
 * to whoever Salesforce happened to prefill, breaking the thread and dropping anybody
 * who was on the original but is not the case contact.
 *
 * IT IS PRESSED ONCE, AND ONLY WHEN THE COMPOSER IS NOT ALREADY A REPLY. Pressing it
 * on a composer that is already in reply mode is the one thing here that can lose work:
 * on most layouts it re-opens the form and takes any recipients and any typed body with
 * it. `composerIsAlreadyReply` is the guard, and it asks the question two ways — the To
 * row has pills in it, or the body already carries a quoted thread — because either
 * alone is a state a fresh compose can be in.
 */
const REPLY_ALL_RE = /^reply\s*all$/i;

/* ============================================================================
 * NOT THE OUT-OF-OFFICE ONE
 * ============================================================================
 * "Reply All on the most recent email" is right until the most recent email is an
 * automatic reply, and then it is precisely wrong: the thread it answers is the
 * auto-responder's, the subject becomes "RE: Automatic reply", and the customer's actual
 * question — the one below it, the one the draft is an answer to — is not the message
 * being replied to at all. An engineer scrolls past an out-of-office without thinking
 * about it; this has to do the same.
 *
 * THE REGEXES ARE THE PANEL'S. `SELF_OOO_RE`, `OOO_AUTOREPLY_MARKER_RE` and the shape of
 * the test below are copied from isOooAutoReply in sidepanel.js, and they are copied
 * rather than shared because a content script cannot call into the panel. They carry a
 * lot of specific hard-won behaviour and should not be casually re-derived here:
 *
 *   · the absence has to be the SENDER'S OWN — "my colleague is out of office" is a real
 *     email from a real person who is covering the case, and treating it as an auto-reply
 *     skipped a live request to the customer;
 *   · it has to be near the TOP — leave mentioned in passing deep inside a long message
 *     is a message, not an auto-reply;
 *   · a message that ASKS for something is never an auto-reply, whatever else it says;
 *   · and short is not a sufficient test on its own: a 754-character auto-reply with a
 *     corporate footer read as a substantive email until the return-date marker was added.
 *
 * If one of these is ever improved, improve the other.
 */
const SELF_OOO_RE = /\bI\s*(?:'?m|am|will be|'?ll be|shall be|was|have been)?\s*(?:currently\s+|presently\s+)?(?:out of (?:the )?office|away from (?:the )?office|off sick|unavailable|on (?:\w+\s+){0,2}leave\b|away on (?:\w+\s+){0,2}leave\b|on (?:holiday|vacation|annual leave|sick leave|parental leave|maternity leave|paternity leave|PTO)\b|travell?ing for work\b)|\bben ik\s+(?:momenteel\s+)?afwezig\b|\bmomenteel afwezig\b|\bmomenteel niet aanwezig\b|\bbeperkt beschikbaar\b/i;
const OOO_AUTOREPLY_MARKER_RE = /\breturning (?:on|to the office|tomorrow|next)\b|\bI will (?:review|read|respond to|reply to|action) your (?:e-?mail|message)\b[^.\n]{0,40}\b(?:on my return|when I return)\b|\bresponses? will be delayed\b|\bback in the office\b|\bwill (?:reply|respond|get back to you) (?:on|upon|after) my return\b|\bduring my absence\b|\bin my absence\b/i;

/* THE SUBJECT LINE is the one signal the panel's copy does not have — by the time it sees
 * a chain the subject has been folded into the text, whereas a feed item still shows it.
 * "Automatic reply: …" is the most reliable marker of an auto-reply there is.
 *
 * ANCHORED AT THE START OF A LINE, and that is not fussiness. Tested loosely against the
 * opening of the message it matches "I will be assisting you with this case as my
 * colleague, Imran Ali, is out of office" — a live request from a real person covering the
 * case, which is exactly the false positive isOooAutoReply in sidepanel.js records having
 * had to fix. A mail client writes the marker as a subject PREFIX; a human writing about
 * a colleague writes it mid-sentence. The anchor is the whole difference. */
const OOO_SUBJECT_RE = /^(?:(?:re|fw|fwd|aw|antwort|tr)\s*:\s*)*(?:automatic reply|auto-?reply|out of (?:the )?office|abwesenheits?notiz|automatische antwort|r[ée]ponse automatique|absence du bureau|respuesta autom[áa]tica|fuori sede|risposta automatica|automatisch antwoord|afwezigheid)\b/i;

function looksOutOfOffice(text) {
    const raw = String(text || '').replace(/\r/g, '');
    const lines = raw.split('\n')
        .map(l => l.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean);
    if (!lines.length) return false;

    /* The first few lines only — a feed item opens with the author, a timestamp and the
     * subject in some order, and the marker is in one of those or it is not a subject. */
    if (lines.slice(0, 3).some(l => OOO_SUBJECT_RE.test(l))) return true;

    const body = lines.join(' ');
    if (/\bautomatic reply\b|\bauto-?reply\b/i.test(body.slice(0, 400))) return true;
    const m = body.match(SELF_OOO_RE);
    if (!m) return false;
    if (m.index > 300) return false;
    if (/\?|\bcould you\b|\bcan you\b|\bplease (?:send|provide|share|confirm|try|run|collect|check)\b/i.test(body)) return false;
    return body.length <= 700 || OOO_AUTOREPLY_MARKER_RE.test(body.slice(0, 500));
}

/* THE FEED ITEM A "Reply All" BELONGS TO, so the action can be judged by the email it
 * would answer. The anchor sits inside the item's own action row, so climbing to the
 * nearest feed item is the whole of it; a Reply All that is not inside one is left alone
 * and treated as un-judgeable rather than skipped. */
function feedItemForAction(el) {
    try { return (el.closest && el.closest(FEED_ITEM_SELECTOR)) || null; } catch (e) { return null; }
}

function replyAllTargetIsOoo(el) {
    const item = feedItemForAction(el);
    if (!item) return false;
    // The rendered text of the post, which on an email item is the subject line followed
    // by the message — exactly what looksOutOfOffice expects to read.
    const text = (item.innerText || item.textContent || '');
    return looksOutOfOffice(text);
}

/* EVERY Reply All ON THE PAGE, newest first — which is document order, because a
 * Salesforce feed puts the most recent post at the top. */
function findReplyAllActions(root) {
    const out = [];
    const seen = new Set();
    const take = (el) => {
        if (!el || seen.has(el)) return;
        if (!isVisible(el) || !controlIsEnabled(el)) return;
        seen.add(el);
        out.push(el);
    };
    for (const scope of writeScopes(root)) {
        /* THE ICON IS THE STRONGEST HANDLE. `utility:reply_all` is what the action IS,
         * and it survives the label being translated — which on an org running in
         * anything but English it will be. The anchor is found from the icon rather
         * than the other way round because the icon sits inside the <a>. */
        for (const icon of findInShadows(
            'lightning-icon[icon-name="utility:reply_all"], .slds-icon-utility-reply-all', scope, false)) {
            take(icon.closest && icon.closest('a, button'));
        }
        /* THEN THE NAME, EXACTLY. "Reply" is a prefix of "Reply All" and sits directly
         * beside it in the same action row — a substring match here answers a request to
         * copy in the whole thread by replying to one person. */
        for (const el of findInShadows('a.action, a[role="button"], a[title], button', scope, false)) {
            const name = String((el.getAttribute && (el.getAttribute('title') || el.getAttribute('aria-label'))) || '')
                .replace(/\s+/g, ' ').trim();
            const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!REPLY_ALL_RE.test(name) && !REPLY_ALL_RE.test(text)) continue;
            take(el);
        }
        if (out.length) return out;
    }
    return out;
}

/* THE ONE TO PRESS: the newest email that is not an automatic reply.
 *
 * Reported as `{ el, skipped }` rather than just the element, because "we replied to the
 * message under two out-of-office notices" is a fact about the draft the engineer is
 * about to send and belongs in what the panel says afterwards.
 *
 * IF EVERY CANDIDATE LOOKS LIKE AN AUTO-REPLY, the newest is used anyway. That is the
 * safer failure by a distance: replying to the top of the thread is what pressing the
 * button by hand would do, and refusing to reply at all because a heuristic did not like
 * any of the emails would leave the engineer with a blank composer and no explanation.
 */
function pickReplyAllAction(root) {
    const all = findReplyAllActions(root);
    if (!all.length) return { el: null, skipped: 0, total: 0 };
    let skipped = 0;
    for (const el of all) {
        if (!replyAllTargetIsOoo(el)) return { el, skipped, total: all.length };
        skipped++;
    }
    return { el: all[0], skipped: 0, total: all.length, allOoo: true };
}

function findReplyAllAction(root) {
    return pickReplyAllAction(root).el;
}

/* IS THIS COMPOSER ALREADY A REPLY? Facts about the form rather than about what we did to
 * it — so a composer the ENGINEER put into reply mode before pressing the button counts
 * too, which is the common case when they were already half way through answering by hand.
 *
 * "THE To ROW HAS PILLS IN IT" USED TO BE ONE OF THE TESTS, AND IT WAS WRONG.
 *
 * Salesforce's Email publisher PREFILLS To with the case contact on a blank compose. So on
 * an ordinary case the guard was satisfied before anything had happened, Reply All was
 * skipped as redundant, and the draft went out as a NEW message: no quoted thread, no
 * "RE:" on the subject, and only whoever Salesforce had prefilled — dropping everyone else
 * who was on the original. It looked complete in the composer, which is why it survived so
 * long. That is the report: "let it click Reply All before pasting."
 *
 * What actually distinguishes a reply is what Reply All PRODUCES and a blank compose does
 * not:
 *
 *   · a quoted thread in the body — the strongest signal, and the one this file already
 *     knows how to find in every shape the org renders (see quotedThreadNode);
 *   · a subject Salesforce has prefixed. It writes "RE: <their subject>" on a reply and
 *     leaves the box empty, or on the case's own subject, for a new message.
 *
 * Both are things the framework did, and neither is true of the form Salesforce hands you
 * when you press Email.
 */
const REPLY_SUBJECT_RE = /^\s*(?:re|aw|antw|sv|vs|res|odp|r)\s*:/i;

function composerIsAlreadyReply(root) {
    const editor = findEmailBodyEditor(root);
    if (editor && quotedThreadNode(editor.el)) return true;
    const subject = findEmailSubjectInput(root);
    return !!(subject && REPLY_SUBJECT_RE.test(String(subject.value || '')));
}

/* WHERE THE QUOTED THREAD STARTS IN THE BODY, or null on a body that has none.
 *
 * Needed for two different reasons and it is the same question both times: to know
 * whether Reply All has already been pressed, and — once it has — to write the draft
 * ABOVE the quote instead of over the top of it.
 *
 * Salesforce does not mark the boundary with anything reliable, so this looks for what
 * a quoted thread actually IS: a blockquote, one of the classes the common mail clients
 * leave behind, or a block whose text opens with the "From: … Sent/Date: … To: …"
 * header every quoted email carries. The header test is last and is deliberately strict
 * about needing two of those fields, because "From:" on its own is a line somebody
 * might legitimately type.
 */
function quotedThreadNode(bodyEl) {
    if (!bodyEl || !bodyEl.querySelectorAll) return null;
    let marked = null;
    try {
        marked = bodyEl.querySelector(
            'blockquote, .gmail_quote, .OutlookMessageHeader, [id*="divRplyFwdMsg"], '
            + '[name="messageReplySection"], [id*="SF_QUOTED"], [class*="quoted"]');
    } catch (_) { marked = null; }
    if (marked) return marked;

    /* SALESFORCE'S OWN SEPARATOR, which is what this org's Reply All actually produces
     * and which neither test below used to match:
     *
     *     <div>--------------- Original Message ---------------<br>
     *          <b>From:</b> EU - Support [support.eu@soti.net]<br>
     *          <b>Sent:</b> 04/09/2026, 11:06<br> …
     *
     * It carries no blockquote, no gmail_quote, no SF_QUOTED class — nothing marked at
     * all — and its text does not START with "From:", it starts with the dashes. So the
     * whole body read as un-quoted, and a draft written into it went over the top of the
     * entire thread instead of above it. On a case with eight replies on it that is eight
     * emails of history deleted out of the composer.
     *
     * Two ways in, because the separator's wording is translated and its dashes are not:
     * the named separator, and a "From: … Sent: …" header that a separator run is allowed
     * to sit in front of. */
    const SEPARATOR_RE = /^\s*[-–—_=*]{3,}\s*(?:original message|forwarded message|message d['’]origine|urspr(?:ü|ue)ngliche nachricht|weitergeleitete nachricht|mensaje original|mensagem original|messaggio originale|oorspronkelijk bericht|ursprungligt meddelande|opprinnelig melding|alkuper(?:ä|a)inen viesti|wiadomo(?:ś|s)(?:ć|c) oryginalna)\s*[-–—_=*]{3,}/i;
    // "From:" at the start of the block, or immediately after a "----- something -----" run.
    const HEADER_RE = /^\s*(?:[-–—_=*]{3,}[^\n]{0,40}?[-–—_=*]{3,}\s*)?(from|de|von|da|från|od|nadawca)\s*:/i;
    const SECOND_RE = /\b(sent|date|to|enviado|gesendet|inviato|skickat|para|an|a|wys(?:ł|l)ano|do)\s*:/i;
    /* READ THROUGH innerText, NOT textContent, and the difference is load-bearing here.
     * A quoted header is separated by <br>, which textContent renders as NOTHING — so
     * "…Support</b><br><b>Sent:</b>…" collapses to "SupportSent:", and `\bsent` has no
     * word boundary to match on. The header test then fails on a header that is plainly
     * there, and the whole thread reads as un-quoted. It happens to work when the From
     * line ends in a bracket or a full stop and to fail when it ends in a letter, which
     * is the kind of difference nobody would ever guess at from the symptom.
     * innerText turns those <br>s into line breaks, which is what they are. */
    const readBlock = (el) => {
        let t = '';
        try { t = String(el.innerText || ''); } catch (_) { t = ''; }
        if (!t.trim()) t = String(el.textContent || '');
        return t.replace(/\s+/g, ' ').trim();
    };

    for (const el of Array.from(bodyEl.children || [])) {
        const text = readBlock(el);
        if (!text) continue;
        if (SEPARATOR_RE.test(text)) return el;
        if (HEADER_RE.test(text) && SECOND_RE.test(text.slice(0, 400))) return el;
    }
    return null;
}

/* WAKE THE RECIPIENT ROW UP.
 *
 * Some Lightning email layouts do not render the "Cc" and "Bcc" toggles until the
 * recipient area has been touched — the row ships as a To box on its own and
 * grows its links on focus. A panel that only ever LOOKS at the row therefore
 * never sees a toggle to press, however long it waits. This is the same focus a
 * mouse would deliver, and on a layout whose toggles are already there it costs
 * nothing and changes nothing.
 */
function nudgeRecipientRow(input) {
    if (!input) return;
    try { input.focus(); } catch (_) { /* the caller re-looks either way */ }
    for (const type of ['mousedown', 'mouseup', 'click']) {
        try { input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); }
        catch (_) { /* ditto */ }
    }
}

/* OPEN THE Cc ROW AND HAND BACK ITS BOX.
 *
 * WHY THIS WAITS, which is the whole of the fix for "no Cc field could be found
 * or revealed". This used to ask its questions ONCE, in the tick it was called,
 * and every one of them can be truthfully answered "no" by a composer that is
 * simply not finished rendering. writeEmailDraft's own wait is satisfied by the
 * FIRST of a body editor, a stub button or a recipient box — and the TinyMCE
 * iframe is routinely up before the Aura recipient row is. So on a slow case the
 * sequence ran: body editor appears, the wait resolves, this function finds no Cc
 * box (true), no To box (true), no toggle (true), and reports a composer with no
 * Cc field on it. Nothing was wrong with the page. The question was asked too
 * early, and asked only once.
 *
 * Now it is asked until the deadline, and the states are still told apart rather
 * than guessed at:
 *
 *   ALREADY OPEN — the engineer opened it, or the case's own settings show it by
 *   default. Clicking the toggle here would HIDE the row, taking any recipients
 *   already in it with it. Re-checked at the top of every pass for that reason.
 *
 *   CLOSED, with a toggle — the normal state. Click it, then wait for a
 *   recipient box that was NOT there before: that box is the Cc box. Identifying
 *   it by what appeared is stronger than identifying it by its label, because it
 *   is a fact about this click rather than a guess about this org's markup.
 *
 *   NO TOGGLE YET — either the row has not rendered at all, or it is a layout
 *   that grows its toggles on focus. Nudge it and look again.
 *
 *   NO TOGGLE AND NO LABEL, but two boxes — a layout that renders To and Cc with
 *   nothing to press. Then the second box is Cc, by the same fixed order that
 *   makes the first one To.
 *
 * A SECOND CLICK IS ONLY EVER SENT TO A TOGGLE THAT DID NOTHING. If the box count
 * grew, the row opened — take it, labelled or not. Clicking a toggle that worked
 * would collapse the row again, which is the one mistake in here that would look
 * exactly like success.
 */
async function openCcRecipientInput(root, opts = {}) {
    const { waitMs = 20000 } = opts;
    const deadline = Date.now() + waitMs;
    const left = () => Math.max(0, deadline - Date.now());

    // The row itself, first. Everything below is a question about a row that has
    // to exist before any answer to it means anything.
    await untilTrue(() => findRecipientInputs(root).length || null, left(), 150);

    let nudged = false;
    while (true) {
        const labelled = recipientInputByRole(root, 'cc');
        if (labelled) return { input: labelled, how: 'already-open' };

        const before = findRecipientInputs(root);
        const toggle = findRecipientToggle(root, /^cc$/i, 'Cc');

        if (toggle) {
            try { toggle.click(); } catch (_) { /* the re-look below decides */ }
            const fresh = await untilTrue(() => {
                const now = findRecipientInputs(root);
                return now.find(i => before.indexOf(i) === -1) || recipientInputByRole(root, 'cc') || null;
            }, Math.min(6000, left()), 120);
            if (fresh) return { input: fresh, how: 'toggled' };
            // The click did nothing at all — safe to try again on the next pass.
            if (findRecipientInputs(root).length !== before.length) return null;
        } else if (before.length >= 2) {
            return { input: before[1], how: 'second-box' };
        } else if (before.length === 1 && !nudged) {
            nudged = true;
            nudgeRecipientRow(before[0]);
            await untilTrue(() => findRecipientToggle(root, /^cc$/i, 'Cc'), Math.min(4000, left()), 150);
        }

        if (left() <= 0) return null;
        await sleep(Math.min(250, left()));
        if (left() <= 0) return null;
    }
}

/* WHAT THE COMPOSER ACTUALLY HAD ON IT when the Cc step gave up — so the sentence
 * the engineer reads names the state rather than restating the failure. A report
 * that says "no Cc field" about a composer that had no recipient row at all sends
 * somebody hunting for a field that was never the problem. */
function ccFailureDetail(root) {
    let boxes = 0, toggle = false;
    try { boxes = findRecipientInputs(root).length; } catch (_) { boxes = 0; }
    try { toggle = !!findRecipientToggle(root, /^cc$/i, 'Cc'); } catch (_) { toggle = false; }
    if (!boxes) return 'the composer never rendered a recipient row';
    if (toggle) return 'the Cc link is there but would not open its row';
    return `the composer has ${boxes === 1 ? 'only a To box' : boxes + ' recipient boxes'} and no Cc link`;
}

// The names already in a recipient box, read off its pills. The pill container is
// the box's own row, so this is scoped the same way recipientRowLabel is.
function recipientPills(input) {
    let node = input && input.parentElement;
    for (let i = 0; i < 7 && node; i++, node = node.parentElement) {
        let boxes = 0;
        try { boxes = node.querySelectorAll(RECIPIENT_INPUT_SELECTOR).length; } catch (_) { boxes = 0; }
        if (boxes !== 1) continue;
        let pills = [];
        try {
            pills = Array.from(node.querySelectorAll('.pillText, .slds-pill__label, .uiPill .label'))
                .map(el => String(el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
        } catch (_) { pills = []; }
        if (pills.length) return pills;
    }
    return [];
}

/* THE OPTIONS THE LOOKUP IS OFFERING. The list is rendered beside the input on
 * some layouts and portalled to the end of the body on others, so the input's own
 * row is searched first and the document second — and every option is matched
 * against the name we asked for, so a document-wide search cannot pick up another
 * lookup's open list.
 */
function recipientOptions(input) {
    const out = [];
    const push = (els) => {
        for (const el of els) {
            if (out.indexOf(el) === -1 && isVisible(el)) out.push(el);
        }
    };
    /* OUTWARD FROM THE INPUT, stopping at the first box that holds any options —
     * NOT `input.closest('.uiAutocomplete')`, which resolves to the input itself:
     * the autocomplete classes are on the input element, and searching an <input>
     * for list items finds nothing however many are on screen. */
    let node = input && input.parentElement;
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        push(findInShadows('li[role="option"], [role="option"], .lookup__item a', node, false));
        if (out.length) break;
    }
    push(findInShadows('[role="listbox"] [role="option"], ul[role="listbox"] li[role="option"]', document, false));
    return out;
}

/* THE OPTION THAT IS THIS PERSON — every word of their name, in the option's own
 * text. A last-name search on a big org returns a page of people, so the match
 * has to be the whole name however little of it was typed; and "Mitulski" alone
 * would otherwise take whichever Mitulski Salesforce listed first.
 */
function matchRecipientOption(options, name) {
    const words = String(name || '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
    if (words.length < 2) return null;
    for (const el of options) {
        const text = String(el.textContent || '').toLowerCase();
        if (words.every(w => text.includes(w))) return el;
    }
    return null;
}

/* WHAT TO TYPE INTO THE LOOKUP, in order.
 *
 * The full name first, which is what the field holds and what the lookup is
 * happiest with. Then the surname on its own, because a name Salesforce stores
 * with a middle initial, a married name, or an accent the Account field renders
 * differently will not match the full string — and matchRecipientOption still
 * demands every word of the full name in the option, so the shorter search only
 * ever widens what is OFFERED, never what is accepted.
 */
function recipientSearchTerms(name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    const words = clean.split(' ').filter(Boolean);
    const terms = [clean];
    if (words.length > 1) {
        const last = words[words.length - 1];
        if (last.length > 2) terms.push(last);
    }
    return terms;
}

/* ADD ONE PERSON TO A RECIPIENT BOX, and confirm it by their PILL.
 *
 * The pill is the only proof: an option clicked while the component was
 * mid-render leaves the box holding a half-typed name, which Salesforce will
 * either refuse to send or — worse — keep as a literal string in the Cc header.
 * So a person is reported as added when their pill is there and not before.
 *
 * A person who could not be matched leaves the box EMPTY rather than with their
 * name sitting in it unresolved, and is named in the report so the engineer can
 * add them by hand. Half a Cc list the panel is quiet about is worse than a Cc
 * list it says is half done.
 */
async function addRecipient(input, person) {
    const name = String((person && person.name) || '').replace(/\s+/g, ' ').trim();
    if (!input) return { ok: false, why: 'the Cc box went away' };
    if (!name) return { ok: false, why: 'no name on the record' };

    if (recipientPills(input).some(p => samePersonName(p, name))) {
        return { ok: true, why: 'already in the Cc field' };
    }

    for (const term of recipientSearchTerms(name)) {
        setAuraFieldValue(input, term);
        const option = await untilTrue(() => matchRecipientOption(recipientOptions(input), name), 6000, 150);
        if (!option) continue;

        /* The approach, then one click — see pickComboboxOption for why both
         * halves are needed and why the click itself is .click() rather than a
         * fifth dispatched event. */
        for (const type of ['mouseover', 'mousedown', 'mouseup']) {
            try { option.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); }
            catch (_) { /* try the next one */ }
        }
        try { option.click(); }
        catch (_) {
            try { option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); }
            catch (_2) { /* the read-back below reports it */ }
        }

        const landed = await untilTrue(() => recipientPills(input).some(p => samePersonName(p, name)), 5000, 150);
        if (landed) return { ok: true };
    }

    setAuraFieldValue(input, '');
    return { ok: false, why: 'Salesforce’s recipient lookup offered nobody by that name' };
}

/* THE SUBJECT BOX. A plain text input on the Email tab, unlike Log a Call's
 * Subject, which is an LWC picklist — see findSubjectCombobox, which is a
 * different control with the same name and must not be confused with this one.
 *
 * `getElementById` for the label's `for`, never querySelector: Aura ids look like
 * "11549:0", and a colon in an id makes it an invalid CSS selector — the query
 * would throw and take the whole write with it.
 */
function findEmailSubjectInput(root) {
    return findInScopes(root, (scope) => {
        const named = findInShadows(
            'input[name="subject"], input[data-refid="subjectInput"], input.subjectInput, '
            + 'input[placeholder="Subject"], input[aria-label="Subject"], input[title="Subject"]',
            scope, false).find(isVisible);
        if (named) return named;

        for (const label of findInShadows('label, .uiLabel', scope, false)) {
            const t = String(label.textContent || '').replace(/\s+/g, ' ').trim().replace(/[:：]\s*$/, '');
            if (!/^subject$/i.test(t)) continue;
            const forId = label.getAttribute && label.getAttribute('for');
            if (forId) {
                const byFor = (label.ownerDocument || document).getElementById(forId);
                if (byFor && byFor.tagName === 'INPUT' && isVisible(byFor)) return byFor;
            }
            const near = label.parentElement
                && label.parentElement.querySelector('input[type="text"], input:not([type])');
            if (near && isVisible(near)) return near;
        }
        return null;
    });
}

/* THE BODY, WHICH IS USUALLY IN AN IFRAME.
 *
 * Salesforce's email composer is TinyMCE, and TinyMCE edits a document of its
 * own inside an iframe — so the editable node is not in this page's document at
 * all and no selector run against `document` will ever find it. The iframe is
 * same-origin (it has no src of its own, so it inherits this page's origin),
 * which is what makes reaching into `contentDocument` legal here; a cross-origin
 * frame throws on the property access and is skipped.
 *
 * Returns { el, doc, win, frame } — the caller needs all four, because typing
 * into another document means using THAT document's selection and events rather
 * than this one's.
 *
 * The inline shapes are tried afterwards for the orgs that do not use the iframe
 * build: TinyMCE in inline mode, CKEditor (the older Aura composer), and a plain
 * contenteditable.
 */
function findEmailBodyEditor(root) {
    const framed = (frame) => {
        let doc = null;
        try { doc = frame.contentDocument; } catch (_) { return null; }   // cross-origin
        if (!doc) return null;
        let body = null;
        try {
            body = doc.querySelector('body#tinymce[contenteditable="true"], body.mce-content-body[contenteditable="true"], '
                + 'body[contenteditable="true"], body .cke_editable[contenteditable="true"]');
        } catch (_) { return null; }
        if (!body) return null;
        return { el: body, doc, win: doc.defaultView || frame.contentWindow || null, frame };
    };

    for (const scope of writeScopes(root)) {
        // The editor's own iframe first — named by TinyMCE and by the Aura wrapper
        // — then any same-origin iframe that turns out to hold an editable body.
        const frames = [
            ...findInShadows('iframe.tox-edit-area__iframe, iframe[id$="_ifr"], '
                + 'iframe[title*="Rich Text"], iframe[title*="Rich text"]', scope, false),
            ...findInShadows('iframe', scope, false)
        ];
        for (const frame of frames) {
            if (!isVisible(frame)) continue;
            const hit = framed(frame);
            if (hit) return hit;
        }
        const inline = findInShadows(
            'div.mce-content-body[contenteditable="true"], .cke_editable[contenteditable="true"], '
            + 'div[contenteditable="true"][role="textbox"]', scope, false).find(isVisible);
        if (inline) {
            const doc = inline.ownerDocument || document;
            return { el: inline, doc, win: doc.defaultView || window, frame: null };
        }
    }
    return null;
}

/* THE QUOTE'S TOP-LEVEL ANCESTOR inside the body, which is the node the draft has to
 * stop in front of. quotedThreadNode may match something nested (a <blockquote> two
 * divs down); a range end and a re-serialised tail both need the outermost block it
 * sits in, or the draft lands inside the quote instead of above it. */
function topLevelQuotedNode(bodyEl) {
    const q = quotedThreadNode(bodyEl);
    if (!q) return null;
    let n = q;
    while (n && n.parentElement && n.parentElement !== bodyEl) n = n.parentElement;
    return (n && n.parentElement === bodyEl) ? n : null;
}

// Everything from this node to the end of its parent, as HTML — the quoted thread and
// anything Salesforce put after it (a signature block, a disclaimer).
function htmlFromNodeOnwards(node) {
    const parts = [];
    for (let n = node; n; n = n.nextSibling) {
        if (n.nodeType === 1) parts.push(n.outerHTML);
        else if (n.nodeType === 3 && n.textContent.trim()) {
            parts.push(n.textContent.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]));
        }
    }
    return parts.join('');
}

// The text of the part of the body the DRAFT owns — everything above the quote, or the
// whole body when there is no quote.
function draftRegionText(bodyEl) {
    if (!bodyEl) return '';
    const quote = topLevelQuotedNode(bodyEl);
    if (!quote) return String(bodyEl.innerText || bodyEl.textContent || '');
    let out = '';
    for (let n = bodyEl.firstChild; n && n !== quote; n = n.nextSibling) {
        out += (n.nodeType === 1 ? (n.innerText || n.textContent || '') : (n.textContent || ''));
    }
    return out;
}

/* PUT THE DRAFT IN THE BODY.
 *
 * HTML rather than text, because the draft's paragraph breaks and its font are
 * the difference between an email that looks written and one that looks pasted —
 * the panel builds that HTML with the same emailBodyAsHtml() the Copy button
 * uses, so a draft that goes in through this path and one that is pasted by hand
 * arrive identically.
 *
 * execCommand FIRST, and in the editor's own document: TinyMCE keeps its own
 * model of the document, and content written straight into the DOM behind its
 * back is not in that model — the editor can re-render it away, and Send would
 * file an email the engineer watched appear on screen. execCommand goes through
 * the browser's editing pipeline, which the editor listens to.
 *
 * It needs the editor's WINDOW focused, which is why the panel brings the tab to
 * the front before asking (see accountEmailToSalesforce in sidepanel.js). The
 * innerHTML path is the fallback for when that still is not enough, and the
 * events after it are the only way left to tell an editor that lives in the
 * page's own JS world — out of a content script's reach — that its content
 * changed.
 */
function typeIntoEmailBody(target, html, text) {
    if (!target || !target.el) return 0;
    const { el, doc, frame } = target;
    const win = target.win || (doc && doc.defaultView) || window;

    try { if (frame) frame.focus(); } catch (_) { /* the length check below reports it */ }
    try { if (win && win.focus) win.focus(); } catch (_) { /* ditto */ }
    try { el.focus(); } catch (_) { /* ditto */ }

    /* WHAT GETS REPLACED, AND WHAT MUST SURVIVE.
     *
     * Selecting the whole body and writing over it is right on a BLANK compose form and
     * wrong the moment Reply All has been pressed: the body then holds the quoted message
     * being answered, and replacing everything deletes it. The customer would get a reply
     * with no thread under it, which on a case running for weeks is most of the context
     * they have.
     *
     * TWO DIFFERENT WRITES, because one mechanism cannot do both jobs safely.
     */
    const quote = topLevelQuotedNode(el);
    let ok = false;

    if (quote) {
        /* WITH A QUOTE: placed by DOM, deliberately NOT by execCommand.
         *
         * A range that ends before the quote node does not stop the browser SPLITTING
         * that node: inserting against it took the quote's own "From: …" line out of
         * `#divRplyFwdMsg` and left it above the boundary as a bare <div>, so the header
         * was torn in half and the first line of it counted as part of the draft. There
         * is no arrangement of the selection that reliably prevents that.
         *
         * Placing the nodes directly cannot split anything: the previous draft (whatever
         * sits above the quote) is removed, the new one is inserted before the quote, and
         * the quote node itself is never touched. That also keeps a re-press correct —
         * the previous draft is exactly what is above the quote, so it is exactly what
         * gets replaced. The events fired below are what tell the editor its content
         * changed, which is the same thing the innerHTML path has always relied on. */
        try {
            while (el.firstChild && el.firstChild !== quote) el.removeChild(el.firstChild);
            const holder = doc.createElement('div');
            // The blank line a reply wants between the draft and the thread.
            holder.innerHTML = html + '<div><br></div>';
            while (holder.firstChild) el.insertBefore(holder.firstChild, quote);
            if (el.classList) el.classList.remove('mce-content-body-empty');
            ok = true;
        } catch (_) { ok = false; }
    } else {
        // Select what is there, so a retry REPLACES the draft rather than doubling it.
        try {
            const range = doc.createRange();
            range.selectNodeContents(el);
            const sel = win.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) { /* no selection API — the fallback covers it */ }

        try { ok = doc.execCommand('insertHTML', false, html); } catch (_) { ok = false; }

        if (!ok || !String(el.innerText || el.textContent || '').trim()) {
            try {
                el.innerHTML = html;
                if (el.classList) el.classList.remove('mce-content-body-empty');
                ok = true;
            } catch (_) { ok = false; }
        }
    }

    const Ev = (win && win.Event) || Event;
    const KbEv = (win && win.KeyboardEvent) || KeyboardEvent;
    for (const type of ['input', 'change']) {
        try { el.dispatchEvent(new Ev(type, { bubbles: true })); } catch (_) { /* older engine */ }
    }
    try { el.dispatchEvent(new KbEv('keyup', { bubbles: true, key: 'a' })); } catch (_) { /* ditto */ }
    // And on the host element too, which is what an Aura wrapper is listening to.
    if (frame) {
        try { frame.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) { /* ditto */ }
    }

    void text;   // kept in the signature: the plain flavour is what the caller measures against
    /* MEASURED OVER THE DRAFT REGION ONLY, never the whole body. With a quoted thread
     * on the form the body is never empty, so measuring all of it would report a
     * comfortable few thousand characters for a write that put nothing in at all — and
     * the caller uses this number to decide whether the body took the draft. */
    return draftRegionText(el).trim().length;
}

/* THE WHOLE EMAIL WRITE. Every step reports what stopped it and what was on the
 * page at the time; nothing here presses Send.
 */
async function writeEmailDraft(root, req) {
    const subject = String((req && req.subject) || '');
    const bodyHtml = String((req && req.bodyHtml) || '');
    /* `bodyTextSigned` CARRIES THE SIGNATURE BLOCK, `bodyText` does not — see
     * emailBodyAsText in sidepanel.js. The signed one is preferred wherever plain text is
     * what lands, so an editor that refuses the HTML still produces a signed message
     * rather than a bare one; the unsigned original remains the fallback for an older
     * panel that does not send it. */
    const bodyText = String((req && (req.bodyTextSigned || req.bodyText)) || '');
    const people = Array.isArray(req && req.cc) ? req.cc : [];

    const tab = findPublisherTab(root, /^e-?mail$/i);
    if (!tab) {
        return wrote('the Email tab',
            'No "Email" tab is on this case’s publisher. Email-to-case may be switched off for this record type.');
    }
    if (!tab.active) {
        // It may be above the viewport — the publisher is at the top of the feed and the
        // engineer has usually scrolled down it. See isRenderedIgnoringScroll.
        scrollControlIntoView(tab.el);
        try { tab.el.click(); } catch (_) { return wrote('the Email tab', 'The tab would not take a click.'); }
    }

    /* THE COMPOSER, WHICH MAY STILL BE A STUB — same two states as the Post tab,
     * told apart the same way and for the same reason: the stub's button carries
     * the real action's name, and pressing the real one to open the composer is
     * pressing Send on an empty email. See isStubSubmitButton. */
    const opened = await untilTrue(() => {
        const stub = findStubSubmitButton(root);
        if (stub) return { stub };
        const body = findEmailBodyEditor(root);
        if (body) return { body };
        return findRecipientInputs(root).length ? { recipients: true } : null;
    }, 20000, 200);
    if (!opened) {
        return wrote('the email composer',
            'The Email tab opened but rendered neither a recipient box nor a message body.');
    }
    if (opened.stub) {
        try { opened.stub.click(); } catch (_) { /* the wait below reports it */ }
        await untilTrue(() => !findStubSubmitButton(root), 8000, 150);
    }

    /* RECIPIENTS FIRST, BODY LAST, and the order is load-bearing. Opening the Cc
     * row and dropping pills into it re-lays out everything below the header —
     * the composer grows a row and the body moves down the page — and on some
     * layouts that re-render replaces the editor's iframe outright. A body
     * written before the Cc field would be written into an editor that is about
     * to be thrown away. */
    const report = { ok: true, cc: [], ccFailed: [], to: [], subjectSet: false, chars: 0,
                     ccHow: '', replyAll: '', replyAllSkipped: 0, replyAllOfTotal: 0,
                     quoted: false };

    /* REPLY ALL, BEFORE ANYTHING IS WRITTEN — see the section header above it.
     *
     * FIRST of all the steps, because it is the one that rebuilds the form: it fills To
     * from the thread, sets "RE: …" in Subject and drops the quoted message into the
     * body. A Cc list added before it, or a draft typed before it, is a Cc list and a
     * draft thrown away by the re-render that follows.
     *
     * BEST EFFORT, and deliberately unable to fail the write. Not every case has an
     * email to reply to — a case raised by phone, or the first message on a brand-new
     * one — and on those there is no Reply All to press and a blank compose is the
     * correct and only thing available. So a missing action is reported in `replyAll`
     * and the write carries on; what it must never do is stop, because everything after
     * this point still works and the engineer would be left with an empty composer. */
    if (composerIsAlreadyReply(root)) {
        report.replyAll = 'already-a-reply';
    } else {
        /* THE NEWEST EMAIL THAT IS NOT AN AUTOMATIC REPLY — see pickReplyAllAction. An
         * out-of-office at the top of the thread is the one case where "reply to the most
         * recent email" answers the wrong message, and it is common enough on a case that
         * has been waiting on somebody's return to be worth stepping over. */
        const pick = pickReplyAllAction(root);
        const replyAll = pick.el;
        // How many automatic replies were stepped over to reach it, and whether the pick
        // was a real choice or a fallback. Both end up in what the panel says afterwards.
        report.replyAllSkipped = pick.skipped || 0;
        report.replyAllOfTotal = pick.total || 0;
        if (!replyAll) {
            report.replyAll = 'no-reply-all';
        } else {
            try { replyAll.click(); } catch (_) { /* the wait below decides */ }
            /* Confirmed by what it PRODUCED rather than by the click returning: the
             * recipients it fills in, or the thread it quotes. Either is proof the form
             * has come back as a reply. */
            const became = await untilTrue(() => composerIsAlreadyReply(root), 10000, 150);
            report.replyAll = became
                // `all-look-automatic` is not a failure — the newest email was replied to,
                // which is what pressing the button by hand does. It is reported because
                // the engineer may want to look at which message they are answering.
                ? (pick.allOoo ? 'clicked-all-look-automatic' : 'clicked')
                : 'clicked-no-change';
            // The form is rebuilt underneath us; let the new recipient row settle before
            // the Cc step starts asking it questions.
            await sleep(250);
        }
    }


    if (people.length) {
        /* TWENTY SECONDS, and they are worth spending. This is the one step whose
         * failure cannot be repaired by looking at the composer afterwards: a
         * missing subject or an empty body is obvious in the draft on screen,
         * whereas an account team that is silently not on the Cc line looks
         * exactly like an account team that is. */
        const cc = await openCcRecipientInput(root, { waitMs: 20000 });
        if (!cc) {
            return wrote('the Cc field',
                'The email composer opened but its Cc field could not be reached — '
                + ccFailureDetail(root) + '. Add the account team by hand before sending.');
        }
        report.ccHow = cc.how;
        for (const person of people) {
            const added = await addRecipient(cc.input, person);
            if (added.ok) report.cc.push(person.name);
            else report.ccFailed.push({ name: person.name, role: person.role || '', why: added.why || '' });
        }
    }

    /* WHO THE EMAIL IS ADDRESSED TO — read, never written. Salesforce fills To in
     * from the case contact, and that prefill is the customer; overwriting it from
     * here would be this panel deciding who the email is to on the strength of a
     * field it read one record away. It is reported instead, because an empty To
     * on a composer full of Cc'd colleagues is worth saying out loud BEFORE the
     * engineer presses Send. */
    const toBox = recipientInputByRole(root, 'to') || findRecipientInputs(root)[0] || null;
    if (toBox) report.to = recipientPills(toBox);

    if (subject) {
        const box = await untilTrue(() => findEmailSubjectInput(root), 8000, 150);
        if (box) {
            /* NOT OVER THE TOP OF ONE SALESFORCE ALREADY WROTE. A reply opened from
             * a customer's email arrives with "RE: <their subject>" in the field,
             * which is the thread the customer will recognise — replacing it with
             * the model's own wording breaks the threading in their mail client for
             * no gain. Ours goes in only when the field is empty. */
            const had = String(box.value || '').trim();
            if (!had) {
                setAuraFieldValue(box, subject);
                report.subjectSet = String(box.value || '').trim() === subject.trim();
            } else {
                report.subjectKept = had;
            }
        }
    }

    const editor = await untilTrue(() => findEmailBodyEditor(root), 15000, 200);
    if (!editor) {
        return Object.assign(wrote('the message body',
            'The composer never rendered a message body this panel could write into.'), report, { ok: false });
    }
    report.chars = typeIntoEmailBody(editor, bodyHtml, bodyText);
    /* WHETHER A QUOTED THREAD IS UNDER THE DRAFT. Read back from the body rather than
     * remembered from the Reply All step, because the only claim worth making is about
     * what is on the form NOW — an engineer who pressed Reply All by hand before this
     * ran has one too, and a click that quietly produced nothing has not. */
    try { report.quoted = !!quotedThreadNode(editor.el); } catch (_) { report.quoted = false; }
    if (!report.chars) {
        return Object.assign(wrote('the message body',
            'The body would not take the draft. If this tab was in the background, bring it to the front and try again.'),
            report, { ok: false });
    }

    /* NO SEND, AND NO CHECK FOR ONE. There is deliberately nothing here that
     * finds the Send button — see the header of this section. The engineer reads
     * the draft in the composer and sends it themselves. */
    return report;
}

/* ============================================================================
 * THE INTERNAL PROBLEM & RESOLUTION NOTE, WRITTEN ONTO THE CASE
 * ============================================================================
 * The panel writes a two-line internal record — what the customer's issue actually was,
 * and exactly how it was resolved — and until now the engineer copied it and filed it by
 * hand: Details tab, find the field, press the pencil, paste, Save. Three of those five
 * steps are the panel's to do.
 *
 * THE FIELD IS `Internal_Resolution_Note__c`, labelled "Problem & Resolution Summary
 * (Internal)" on the layout. It is found by API NAME first and by label second, for the
 * same reason the account team's fields are: the API name is what the layout writes into
 * `data-target-selection-name`, and it survives the org renaming the label — which two of
 * the account fields have plainly had done to them.
 *
 * IT DOES NOT PRESS SAVE, and that is a rule rather than an omission — the same rule the
 * email composer follows. The note is filed against a customer's case and read by whoever
 * picks it up next; the engineer reads it in the place they would read any other draft,
 * and the last click is theirs. It also makes the write reversible: nothing is committed,
 * so a field whose previous contents were replaced is one Escape away from being restored.
 * ========================================================================== */

const INTERNAL_NOTE_API = 'Internal_Resolution_Note__c';
const INTERNAL_NOTE_LABEL_RE = /^problem\s*(?:&|and)\s*resolution\s*summary\s*\(internal\)$/i;

/* THE FIELD'S ROW ON THE DETAIL LAYOUT — the whole `records-record-layout-item`, because
 * the pencil and the textarea are siblings inside it and finding one from the other is how
 * this stays on the right field. Visible first, then any match at all: see accountFieldBox
 * above, which works around the same 0×0 rects. */
function findInternalNoteBox(root) {
    const pick = (els) => els.find(isVisible) || els[0] || null;

    const byName = pick(findInShadows(
        `[data-target-selection-name="sfdc:RecordField.Case.${INTERNAL_NOTE_API}"]`, root, false));
    if (byName) return byName.closest('records-record-layout-item') || byName;

    const byFieldLabel = pick(findInShadows(
        'records-record-layout-item[field-label], [field-label]', root, false)
        .filter(el => INTERNAL_NOTE_LABEL_RE.test(
            String(el.getAttribute('field-label') || '').replace(/\s+/g, ' ').trim())));
    if (byFieldLabel) return byFieldLabel;

    for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
        const text = String(label.textContent || '').replace(/\s+/g, ' ').trim();
        if (!INTERNAL_NOTE_LABEL_RE.test(text)) continue;
        const box = (label.closest && label.closest(
            'records-record-layout-item, lightning-textarea, .slds-form-element')) || label.parentElement;
        if (box) return box;
    }
    return null;
}

/* THE PENCIL. Salesforce renders it as a button inside the field's own row, and the class
 * it carries has changed more than once across releases — so the row is asked for anything
 * that looks like an inline-edit affordance, and the title is the fallback ("Edit Problem &
 * Resolution Summary (Internal)"). Scoped to the row, never to the page: every editable
 * field on a case has one of these, and the page's first pencil is not this field's. */
const INLINE_EDIT_SELECTOR = [
    'button.test-id__inline-edit-trigger',
    'button.inline-edit-trigger',
    '.inline-edit-trigger-icon',
    'lightning-button-icon[data-inline-edit-trigger]',
    'button[title^="Edit"]',
    'button[aria-label^="Edit"]'
].join(', ');

function findInlineEditPencil(box) {
    if (!box) return null;
    for (const el of queryDeep(box, INLINE_EDIT_SELECTOR)) {
        const btn = (el.tagName === 'BUTTON') ? el : (el.closest && el.closest('button')) || el;
        if (btn && controlIsEnabled(btn)) return btn;
    }
    return null;
}

// The textarea Salesforce renders once the field is in edit mode.
const findInternalNoteTextarea = (box) =>
    box ? (queryDeep(box, 'textarea.slds-textarea, textarea').find(t => controlIsEnabled(t)) || null) : null;

/* WRITE IT. Details tab, pencil, text — and then stop. */
async function writeInternalResolutionNote(request) {
    writeScopeCache = null;
    const text = String((request && request.text) || '').trim();
    if (!text) return wrote('the note', 'There was nothing to put in the field.');

    const hasFields = (r) => findInShadows(FIELD_LABEL_SELECTOR, r, false).length > 0;
    const picked = rootForRecordRead(request && request.recordId, hasFields);
    const root = picked.root;

    /* 1. THE DETAILS TAB, AND ACTUALLY SHOWN — see `mustShow`.
     *
     * Not merely mounted. A Details panel the engineer opened once stays in the DOM behind
     * whichever sub-tab they are on now, so the write would land perfectly on a form they
     * cannot see — and then ask them to press Save on it. That is the report: it put it in
     * and left the engineer on the Feed tab looking for it.
     *
     * `allowHidden` is deliberately NOT passed: this is the ENGINEER'S OWN tab, and a
     * control that measures 0×0 here is genuinely off-screen rather than in a window Chrome
     * is not painting. Clicking one blind could switch a case they are looking at. */
    const details = await activateDetailsTab(root, {
        mustShow: true,
        waitMs: Math.max(1000, parseInt(request && request.detailsWaitMs, 10) || 10000)
    });

    let box = await untilTrue(() => findInternalNoteBox(root), 10000, 200);
    if (!box) {
        return Object.assign(wrote('the field',
            'No "Problem & Resolution Summary (Internal)" field could be found on this case’s '
            + 'Details tab. It may not be on this record type’s layout.'),
            { scope: picked.scope, detailsTab: (details && details.reason) || '' });
    }

    /* 2. THE PENCIL — unless the field is already open for editing, which it is when the
     * engineer has started typing in it themselves. Clicking then would not toggle it shut,
     * but there is no reason to click something that has already done its job. */
    let area = findInternalNoteTextarea(box);
    let clickedPencil = false;
    if (!area) {
        const pencil = findInlineEditPencil(box);
        if (!pencil) {
            return Object.assign(wrote('the pencil',
                'The field is on the page but its edit (pencil) button could not be found — it may '
                + 'be read-only for your profile.'), { scope: picked.scope });
        }
        scrollControlIntoView(pencil);
        try { pencil.click(); } catch (e) {
            return Object.assign(wrote('the pencil', 'The edit button would not take a click.'),
                { scope: picked.scope });
        }
        clickedPencil = true;
        // The row is re-rendered into edit mode, so the box is re-found rather than reused.
        area = await untilTrue(() => {
            const b = findInternalNoteBox(root) || box;
            box = b;
            return findInternalNoteTextarea(b);
        }, 10000, 150);
    }
    if (!area) {
        return Object.assign(wrote('the text box',
            'The edit button was pressed but no text box appeared for the field.'),
            { scope: picked.scope, detailsTab: (details && details.reason) || '' });
    }

    /* 3. THE TEXT. What was there before is reported rather than silently discarded — and
     * because Save is not pressed, "replaced" means "replaced in the form", which Cancel
     * undoes. The field caps at 6000 characters on the layout; the cap is read off the
     * element rather than assumed, and a note that would overflow is refused instead of
     * being written half in. */
    const had = String(area.value || '').trim();
    const cap = parseInt(area.getAttribute('maxlength'), 10) || 0;
    if (cap && text.length > cap) {
        return Object.assign(wrote('the note',
            `The summary is ${text.length} characters and the field holds ${cap}. Shorten it and try again.`),
            { scope: picked.scope, had: had.length });
    }

    const chars = setAuraFieldValue(area, text);
    if (!chars) {
        return Object.assign(wrote('the note', 'The text box would not take the summary.'),
            { scope: picked.scope });
    }

    /* AND PUT IT ON SCREEN. The Details tab is showing now, but this field is a long-text
     * one and on a real case layout it sits well down the page — so being on the right tab
     * is not the same as being able to see what was written. The engineer is asked to read
     * it and press Save; the least this can do is have it in front of them. */
    try { scrollControlIntoView(area); } catch (e) { /* not fatal — the text is still there */ }
    try { area.focus(); } catch (e) { /* nor is this */ }

    return {
        ok: true,
        chars,
        replaced: had.length,
        clickedPencil,
        cap,
        scope: picked.scope,
        detailsTab: (details && details.reason) || ''
    };
}

async function writeEmailToCaseComposer(request) {
    writeScopeCache = null;                 // re-decide where it is safe to look
    if (!String((request && request.bodyText) || '').trim()) {
        return wrote('the draft', 'There was nothing to put in the email.');
    }

    // The right case, not the first one in the DOM — see postToCaseFeed.
    const picked = rootForRecordRead(request && request.recordId,
        (r) => findFeedTabLinks(r).length > 0 || feedIsShowing(r));
    const root = picked.root;

    const tab = await activateFeedTab(root, { waitMs: 20000 });
    if (tab && tab.reason === 'no-feed-tab' && !feedIsShowing(root)) {
        return Object.assign(wrote('the Feed tab', 'No Feed tab could be found on this case.'), { scope: picked.scope });
    }

    const out = await writeEmailDraft(root, request);
    return Object.assign(out, { scope: picked.scope, feedTab: (tab && tab.reason) || '' });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "GET_SALESFORCE_CASE_LIST") {
        // Scroll the whole list into the DOM FIRST. A list view renders about 25 rows and
        // fetches the rest on scroll, so scraping without this reads only what happened to
        // be on screen — and a 30-case queue coming back as 25 looks exactly like a 25-case
        // queue. Async, hence the awaited chain and the `return true` below.
        (async () => {
            try {
                const load = await loadWholeCaseList(document);
                const data = scrapeSalesforceCaseList();
                data.listLoad = load;
                console.log(`SOTI AI Analyser: Scraped case list — ${data.cases.length} rows`
                    + (load.declared ? ` of ${load.declared} the list declares` : '')
                    + ` (${load.rounds} scroll round(s), ${load.reason})`);
                sendResponse(data);
            } catch (err) {
                console.error('SOTI AI Analyser: Case list scrape failed', err);
                sendResponse(null);
            }
        })();
        return true;
    }
    /* ========================================================================
     * THE KNOWLEDGE BASE ON SALESFORCE
     * ========================================================================
     * There are in-depth resolutions to common issues sitting in Salesforce Knowledge, written
     * by the people who solved them, and the panel could not see any of it. It had SOTI's
     * public documentation (Pulse) and the case in front of it, and neither one contains "here
     * is what we actually did the last four times this happened".
     *
     * Two messages, because reading the knowledge base is two different jobs:
     *
     *   GET_SALESFORCE_KB_LIST reads a Knowledge LIST VIEW — the same virtualised datatable
     *   the case list uses, so it reuses the same scroll loader and the same cell reader. It
     *   returns titles, article numbers and record URLs, and it is cheap: one page.
     *
     *   GET_SALESFORCE_KB_ARTICLE reads ONE article record — its fields and its rich-text
     *   body. Expensive: one page load each, which is why the panel drives it over a queue in
     *   a background window and remembers what it already holds.
     * ====================================================================== */
    if (request.action === "GET_SALESFORCE_KB_LIST") {
        /* ONE SCRAPE PER PAGE, however many times the panel asks.
         *
         * The panel POLLS: it sends this message every 800ms until an answer comes back with
         * articles in it, because a Lightning page reaches readyState complete long before its
         * grid exists. Each of those messages used to start its own scroll-to-the-end — so a
         * list view that took a minute to load had seventy scroll loops running at once,
         * scrolling the same grid in opposite directions and each restoring the scroll
         * position out from under the others.
         *
         * So the first ask starts the run and every later ask either joins the answer or is
         * told to keep waiting. Only a run that actually found something is remembered: a
         * scrape that came back empty because the grid had not rendered yet must be allowed to
         * happen again, which is exactly what the polling is for.
         */
        if (kbListCache) { sendResponse(kbListCache); return false; }
        if (!kbListRun) {
            kbListRun = (async () => {
            try {
                /* NOT loadWholeCaseList. That one scrolls to the end and leaves the caller
                 * to read the DOM afterwards, which is right for the LWC case grid — it
                 * appends rows and keeps them. The Aura grid Knowledge renders does neither
                 * reliably, so reading it needs a loader that accumulates as it goes and
                 * that knows "100+ items" means keep asking. See loadKbListFully, which is
                 * that loader and which does its own scraping every round. This is one page
                 * load per SYNC, not per article — the cost of being generous here is
                 * seconds, and the cost of stopping early is articles the panel will never
                 * know exist. */
                const data = await loadKbListFully();
                const load = data.listLoad || {};
                console.log(`SOTI AI Analyser: Scraped knowledge list "${data.listName}" — `
                    + `${data.articles.length} articles from ${data.rowsSeen} rows `
                    + `(${load.rounds} scroll round(s), ${load.reason}`
                    + `${load.declared ? `, list declares ${load.declared}` : ''}`
                    + `${load.atLeast ? `, list declares ${load.atLeast}+` : ''}`
                    + `, ${Math.round((load.ms || 0) / 1000)}s)`);
                return data;
            } catch (err) {
                console.warn('SOTI AI Analyser: KB list scrape failed', err);
                try { return scrapeSalesforceKbList(); } catch (e2) { return null; }
            }
            })().then((data) => {
                // Worth remembering only if it is an answer. Zero articles and no empty-state
                // panel means the grid had not rendered — ask again.
                if (data && (data.articles.length > 0 || data.emptyState)) kbListCache = data;
                kbListRun = null;
                return data;
            }, () => { kbListRun = null; return null; });
        }
        // The run is under way. Say so rather than blocking this message on it: the panel uses
        // the gap between polls to make Chrome paint the tab, and a poll that never returns is
        // a poll that never gets the chance.
        sendResponse({ pending: true, articles: [], rowsSeen: 0, emptyState: false });
        return false;
    }
    if (request.action === "GET_SALESFORCE_KB_ARTICLE") {
        try {
            sendResponse(scrapeSalesforceKbArticle());
        } catch (err) {
            sendResponse(null);
        }
        return true;
    }
    /* PRESS SALESFORCE'S OWN REFRESH BEFORE READING THE LIST.
     *
     * A list view that has been sitting open is a SNAPSHOT: Lightning fetched those rows when
     * the page loaded and does not re-fetch them because time passed. So a saved list link
     * that finds its tab already open — the normal state of a tab somebody keeps all day —
     * was syncing this morning's queue: cases closed since then still in it, cases opened
     * since then missing from it, and every status and age cell stale. Nothing about the
     * result looked wrong, which is what made it worth fixing.
     *
     * Salesforce has the button for exactly this, and clicking it is the only way to make the
     * list re-query. Everything after the click is about knowing when the new rows are
     * actually there — a refresh that is scraped mid-flight reads the OLD grid and gains
     * nothing at all:
     *
     *   • the row count is remembered and the first row element identified BEFORE the click,
     *     so a re-render can be recognised by the node being replaced rather than by a count
     *     that may legitimately come back the same;
     *   • the spinner is waited out (waitWhileFetching), which is the reliable signal on this
     *     grid and the same one the scroll loader already trusts;
     *   • and it is bounded end to end. A refresh that never resolves must degrade to
     *     "sync what is on screen", which is exactly what the old behaviour was — so the
     *     worst case here is no worse than not having tried.
     */
    if (request.action === "REFRESH_SALESFORCE_LIST") {
        (async () => {
            const budgetMs = Math.max(2000, Math.min(request.budgetMs || 20000, 60000));
            const deadline = Date.now() + budgetMs;
            try {
                const btn = findListRefreshButton(document);
                if (!btn) {
                    sendResponse({ ok: false, reason: 'no-refresh-button', rows: document.querySelectorAll(CASE_ROW_SELECTOR).length });
                    return;
                }

                const before = document.querySelectorAll(CASE_ROW_SELECTOR).length;
                const firstBefore = document.querySelector(CASE_ROW_SELECTOR);

                try { btn.click(); } catch (e) {
                    sendResponse({ ok: false, reason: 'click-failed', rows: before });
                    return;
                }

                /* WAIT FOR THE REFRESH TO START. The click is asynchronous — Lightning fires
                 * the request and the spinner appears a frame or two later — so checking for
                 * "is it fetching?" immediately reads the quiet BEFORE the refresh, decides
                 * it is already finished, and scrapes the same stale grid. A row node being
                 * swapped counts as started too: a fast refresh can be over before a spinner
                 * is ever painted. */
                let started = false;
                const startDeadline = Math.min(Date.now() + 3000, deadline);
                while (Date.now() < startDeadline) {
                    await sleep(120);
                    if (listIsFetching(document)) { started = true; break; }
                    const firstNow = document.querySelector(CASE_ROW_SELECTOR);
                    if (firstBefore && firstNow && firstNow !== firstBefore) { started = true; break; }
                }

                // Then wait for it to FINISH. Bounded by whatever is left of the budget.
                const cleared = await waitWhileFetching(document, Math.max(1000, deadline - Date.now()));

                // And settle: the grid paints its rows a beat after the spinner goes.
                const settleUntil = Math.min(Date.now() + 1200, deadline);
                while (Date.now() < settleUntil) {
                    await sleep(150);
                    if (document.querySelectorAll(CASE_ROW_SELECTOR).length > 0) break;
                }

                sendResponse({
                    ok: true,
                    started,
                    cleared,
                    rowsBefore: before,
                    rows: document.querySelectorAll(CASE_ROW_SELECTOR).length,
                    declared: declaredCaseCount(document)
                });
            } catch (err) {
                sendResponse({ ok: false, reason: String((err && err.message) || err) });
            }
        })();
        return true;
    }
    /* "IS THE LIST ON SCREEN YET?" — the list-view twin of GET_SALESFORCE_CASE_READY, asked
     * while a saved list link is loading so the queue syncs from a grid that exists.
     *
     * A Lightning list view reaches readyState complete with an empty table and fills it in
     * from the server afterwards, so a sync fired at 'complete' scrapes zero rows and reports
     * "no case rows found" — a complaint about the wrong page, aimed at someone whose page
     * was simply not finished. Rows are the proof, and they are the same rows the scrape is
     * about to read. Cheap: one selector, nothing touched. */
    if (request.action === "GET_SALESFORCE_LIST_READY") {
        try {
            const rows = document.querySelectorAll(CASE_ROW_SELECTOR).length;
            sendResponse({
                ready: rows > 0,
                rows,
                declared: declaredCaseCount(document),
                // Still fetching its first page — the caller keeps waiting rather than
                // syncing a grid that is visibly mid-load.
                fetching: listIsFetching(document)
            });
        } catch (err) {
            sendResponse({ ready: false, rows: 0 });
        }
        return true;
    }
    /* "IS THE CASE ON SCREEN YET?" — asked repeatedly while a case opens, so it must be
     * cheap and must not touch the page. No scrolling, no expanding, no clicking: the
     * engineer is watching their own tab load and the auto-sync has not started yet.
     *
     * Ready means the RECORD is rendered, not that the document finished loading. Lightning
     * reaches readyState complete with an empty shell and fills it in afterwards, so
     * 'complete' on its own would hand the sync a page with no case on it. Any one of these
     * is proof the record itself has arrived: a case number read off the layout, a field
     * label from the record detail, or a feed item. */
    if (request.action === "GET_SALESFORCE_CASE_READY") {
        try {
            const onCaseUrl = /\/lightning\/r\/(?:[^/]+\/)?500[A-Za-z0-9]{12,15}\//.test(location.pathname)
                || /[?&]id=500/i.test(location.search);
            const hasFeed = !!document.querySelector(FEED_ITEM_SELECTOR);
            // getFieldValue takes a label ELEMENT, so the case-number probe reads the label
            // the same way the scrape does — find it, then ask it for its value. Passing the
            // string would have returned '' every time and the check would never have fired.
            const caseNum = [...document.querySelectorAll(FIELD_LABEL_SELECTOR)]
                .some(l => labelTextOf(l).includes('case number') && getFieldValue(l));
            const hasLabels = document.querySelectorAll(FIELD_LABEL_SELECTOR).length > 3;

            /* CAN THE SYNC REACH THE FEED YET? — a separate question from "has the record
             * rendered", and the one that actually matters to the caller.
             *
             * Lightning paints the highlights panel and the field labels BEFORE it paints
             * the sub-tab strip. So a page can satisfy every check above while the Feed tab
             * does not exist yet, and a sync started there finds no tab to click and reports
             * "no Feed tab could be found on this layout" — a layout complaint about a page
             * that was merely still loading. Either the feed is already on screen, or there
             * is a tab that will show it; anything else is not ready for a sync. */
            let feedReady = false;
            try {
                feedReady = feedIsShowing(document) || findFeedTabLinks(document).length > 0;
            } catch (e) { /* treat as not ready — the caller has its own ceiling */ }

            /* AND HAS THE RECORD'S OWN DETAIL LAYOUT ARRIVED — which is a third question
             * again, and the one behind "the auto-sync leaves Case Owner, Product and SOTI
             * Version empty and I have to press Sync myself".
             *
             * Every check above is satisfied by the HIGHLIGHTS STRIP. Lightning paints that
             * strip first, it carries the compact layout's own field labels — Case Number
             * among them — and those labels are in FIELD_LABEL_SELECTOR on purpose. So
             * `caseNum` is true and `hasLabels` passes its count while the detail layout,
             * where Case Owner and Product and SOTI Version actually live, is not in the
             * document at all. The sync fired there scrapes a header and reports a case with
             * three empty fields — and pressing Sync a minute later works, because by then
             * the layout has arrived. That is the whole of the report.
             *
             * detailFieldsShowing asks the right question: a record field OUTSIDE the strip.
             * See the highlights notes above it. */
            let detailReady = false;
            try { detailReady = detailFieldsShowing(document); } catch (e) { /* not ready */ }

            sendResponse({
                ready: !!(caseNum || hasFeed || hasLabels),
                feedReady, detailReady, onCaseUrl,
                // What the strip alone would have answered, so a caller that gave up waiting
                // can say WHY the fields came back empty instead of blaming the scraper.
                labels: document.querySelectorAll(FIELD_LABEL_SELECTOR).length
            });
        } catch (err) {
            sendResponse({ ready: false });
        }
        return true;
    }
    /* JUST THE DESCRIPTION, off a case record page.
     *
     * The Open Cases queue shows a case's Description in its expander, and a list view has
     * no Description column — the field only exists on the record. So the panel opens the
     * record in a background tab and asks for this.
     *
     * Deliberately NOT GET_SALESFORCE_DATA. That one drives the feed's infinite scroll to
     * the end and expands every post before it reads anything, which is right for a sync
     * and absurd for filling in one expander: minutes of scrolling somebody's case to read
     * a field that is on screen the moment the record renders. This reads two fields and
     * touches nothing. */
    if (request.action === "GET_SALESFORCE_CASE_BRIEF") {
        /* Async now, because of `wantActivity` below — the reply has to wait for the Feed
         * tab to mount. The synchronous half is unchanged and still answers in one pass. */
        (async () => {
        try {
            const out = {
                caseNumber: '', subject: '', description: '', owner: '', lastModifiedBy: '',
                status: '',
                priority: '', licenseType: '', contactName: '', accountName: '', caseAge: '',
                entitlement: '', jiraNumber: '', recordId: '', caseUrl: '', readScope: '',
                lastMessageAt: null, lastMessageLabel: '', lastMessageFrom: '',
                lastReachOutAt: null, lastReachOutLabel: '', lastReachOutFrom: ''
            };

            /* READ ONE CASE, NOT WHICHEVER CASE IS FIRST IN THE DOM.
             *
             * This used to walk `document`, and on a record page opened on its own that is
             * the same thing. In the CONSOLE it is not: every open case is mounted at once,
             * a background workspace tab keeps all of its fields, and `findInShadows` hands
             * them back in document order — so the first tab in the row answered for the
             * case the engineer was actually looking at. Four cases open, and Add Case put
             * in the leftmost one, with the ACTIVE case's URL on it: a row whose link and
             * whose fields described two different cases.
             *
             * The caller names the record it means (it has it from the address bar), so the
             * read is scoped to that case's own workspace panel. See rootForRecordRead for
             * the fallbacks — and note the `has` test, which is what stops a root guess that
             * lands somewhere without fields turning a real case into an empty one. */
            const hasFields = (r) => findInShadows(FIELD_LABEL_SELECTOR, r, false).length > 0;
            const picked = rootForRecordRead(request.recordId, hasFields);
            const root = picked.root;
            out.readScope = picked.scope;
            out.recordId = picked.scope === 'record' ? String(request.recordId || '') : '';

            for (const label of findInShadows(FIELD_LABEL_SELECTOR, root, false)) {
                const text = labelTextOf(label);
                if (!out.caseNumber && text.includes('case number')) out.caseNumber = getFieldValue(label);
                if (!out.subject && text === 'subject') out.subject = getFieldValue(label);
                if (!out.description && text === 'description') out.description = getFieldValue(label, true, true);
                if (!out.owner && (text === 'case owner' || text === 'owner' || text === 'case owner alias')) {
                    out.owner = getFieldValue(label);
                }
                // The queue's Modified by column — see the same pair in scrapeSalesforce.
                // The alias wins whenever it appears, whichever order the two labels come in.
                if (text === 'last modified by alias') {
                    const alias = getFieldValue(label);
                    if (alias) out.lastModifiedBy = alias;
                } else if (text === 'last modified by' && !out.lastModifiedBy) {
                    out.lastModifiedBy = getFieldValue(label);
                }
                if (!out.status && (text === 'status' || text === 'case status')) out.status = getFieldValue(label, true);
                if (!out.priority && (text === 'case priority' || text === 'priority')) out.priority = getFieldValue(label);
                if (!out.licenseType && text.includes('license type')) out.licenseType = getFieldValue(label);
                /* THE THREE FIELDS A LIST VIEW CAN ALSO CARRY — read here so the routes that
                 * never touch a list view still get them.
                 *
                 * A queue filled by "Sync from Salesforce" gets the account, the contact and
                 * the case age out of the list's own columns. The two per-case routes — Add
                 * Case URL, and the per-case Sync now — have no list view behind them at all,
                 * so a case that arrived either way had three permanently empty cells and a
                 * Case Info panel with no account or contact on it. They are on the record,
                 * they cost nothing to read while the loop is already walking every label,
                 * and they are matched with the SAME conditions the full scrape uses (see
                 * scrapeSalesforce) so the two can never disagree about which label is which.
                 *
                 * Account Name and Contact Name are lookup fields — the value is a link with
                 * a Preview button beside it — and Case Age is a formula. getFieldValue reads
                 * all three: it strips buttons and assistive text before taking the text, so
                 * "Elektro-Material AG" does not come back as "Elektro-Material AGPreview".
                 *
                 * The contact has a second job here, and it predates the display one: it is
                 * handed to readFeedActivity below as the person on the OTHER side, so a post
                 * from them is the one thing that is certainly not a reach-out. */
                if (!out.contactName && (text === 'contact name' || text === 'contact')) {
                    out.contactName = getFieldValue(label);
                }
                if (!out.accountName && (text === 'account name' || text === 'account')) {
                    out.accountName = getFieldValue(label);
                }
                if (!out.caseAge && text.includes('case age')) {
                    out.caseAge = getFieldValue(label);
                }
                /* THE ENTITLEMENT IS THE ONE THAT CHANGES WHERE THE CASE APPEARS.
                 *
                 * It is not just another cell: entitlementTier() reads it to decide which
                 * GROUP the row is drawn under and which tier chip counts it, because the
                 * queue is worked tier by tier. Until now it came only from the list view's
                 * "Entitlement Name" column, so a case added by URL sat under "No entitlement
                 * listed" for ever — filed under the one heading that means "we don't know".
                 *
                 * Read EXACTLY, unlike the account and the contact above. Those are lookup
                 * fields whose value sits beside a Preview button, so they need the cleaning
                 * pass that splits on button words — and that pass would cut an entitlement
                 * name at the first "Open"/"Close"/"Edit" it happened to contain. This field
                 * is a read-only formula with no chrome inside it, so there is nothing to
                 * strip and nothing to be gained by risking the split. Same reasoning, and
                 * the same `true`, as Case Status.
                 *
                 * Matched on the two exact labels: a case layout also carries "Entitlement
                 * Process" and "Entitlement Status", and a loose match takes whichever
                 * Salesforce rendered first. */
                if (!out.entitlement && (text === 'entitlement name' || text === 'entitlement')) {
                    out.entitlement = getFieldValue(label, true);
                }
                /* THE DEFECT RAISED OFF THIS CASE — the queue has a JIRA column and this read
                 * was not filling it, so a case added or synced by this route showed an em
                 * dash in it however many times it was read. It is one more label in a loop
                 * that is already walking every label on the record, so it costs nothing.
                 *
                 * issueKeyIn, not the raw value: the field renders as a bare key on some
                 * layouts and as a link or a sentence on others, and the panel builds a
                 * jira.soti.net/browse/<key> address out of whatever it is given. */
                if (!out.jiraNumber && text.includes('jira')) {
                    out.jiraNumber = issueKeyIn(getFieldValue(label));
                }
            }

            /* THE LINK BACK TO THIS CASE, resolved from the console's own tab bar rather
             * than from the address bar. The panel needs a URL it can reopen the record by,
             * and it is the one thing it cannot always take from the tab it asked: on a
             * record reached through a list view the address bar can still be showing the
             * list. findCaseRecordUrl prefers the anchor that NAMES this case number, so it
             * agrees with the fields that were just read rather than with whatever tab
             * happens to be selected. */
            try { out.caseUrl = findCaseRecordUrl(out.caseNumber) || ''; } catch (e) { /* the caller has the tab URL */ }

            /* THE ACTIVITY HALF — asked for separately, because it is the only part that
             * touches the page.
             *
             * The description read above is free: the fields are on screen the moment the
             * record renders. "When did I last reach out" is not — it lives in the feed, and
             * on a record opened cold the Feed tab may not be the one showing. So this opens
             * it, waits briefly for it to mount, and reads the posts already rendered. It
             * never scrolls: a case feed is newest-first and both answers are at the top.
             */
            if (request.wantActivity) {
                try {
                    /* THE CALLER SETS THE BUDGET. One case read on demand can afford to wait
                     * for a slow Feed tab; the same wait multiplied across a whole queue is
                     * minutes. The queue-wide sync sends smaller numbers and takes "—" in a
                     * column over holding up every case behind this one. */
                    const activityWaitMs = Math.max(1000, parseInt(request.activityWaitMs, 10) || 9000);
                    const feedWaitMs = Math.max(500, parseInt(request.feedWaitMs, 10) || 4000);
                    /* THE SAME ROOT THE FIELDS CAME FROM — see rootForRecordRead above.
                     * A background workspace tab keeps its sub-tab bar AND its feed, so a
                     * document-wide read here would take the reach-out date off one case and
                     * staple it to another's description. Worse, activateFeedTab would be
                     * free to click a Feed tab belonging to a case the engineer is not
                     * looking at, switching a sub-tab under them. */
                    const tab = await activateFeedTab(root, { waitMs: activityWaitMs });
                    /* A tab that has just mounted can still be empty for a beat. Polled in
                     * short steps and exited the moment a post appears, so a quick feed costs
                     * one step rather than the whole allowance.
                     *
                     * findInShadows, not querySelector: the feed can render inside a shadow
                     * root, and a plain querySelector then reports "still empty" for the whole
                     * budget on a case whose posts are right there — the read that follows
                     * pierces shadow roots and would have found them. */
                    const feedUntil = Date.now() + feedWaitMs;
                    const feedHasPosts = () => findInShadows(FEED_ITEM_SELECTOR, root, false).length > 0;
                    while (Date.now() < feedUntil && !feedHasPosts()) {
                        await sleep(250);
                    }
                    /* WHERE THE POSTS ARE READ FROM, and the one place the strictness has to
                     * bend. When the root came from the record's own console tab it holds the
                     * whole case, feed included, and widening the search could only ever pull
                     * in another case's posts — so that root stays exactly as it is.
                     *
                     * A root that came from the SCORING heuristic is a different thing: it can
                     * legitimately be a sub-container (.forceRecordLayout and friends) that
                     * holds the fields and not the feed, and scoping to it would report "no
                     * posts" about a case whose feed is on screen. Same reasoning, and the
                     * same fallback, as the full scrape. */
                    let feedRoot = root;
                    if (picked.scope !== 'record' && root !== document && !feedHasPosts()) {
                        feedRoot = document;
                    }
                    const activity = readFeedActivity(feedRoot, {
                        owner: out.owner, contact: out.contactName, limit: 40
                    });
                    out.lastMessageAt = activity.lastMessageAt;
                    out.lastMessageLabel = activity.lastMessageLabel;
                    out.lastMessageFrom = activity.lastMessageFrom;
                    out.lastReachOutAt = activity.lastReachOutAt;
                    out.lastReachOutLabel = activity.lastReachOutLabel;
                    out.lastReachOutFrom = activity.lastReachOutFrom;
                    /* WHAT THE READ ACTUALLY SAW. The panel prints this when the column comes
                     * back empty, so "the sync has not run yet" and "the sync ran and could
                     * not place a single post" stop being the same sentence — which is what
                     * hid a classifier bug behind a plausible-looking em dash. */
                    out.activityRead = {
                        items: activity.itemsRead, dated: activity.dated,
                        classified: activity.classified, user: activity.user,
                        reason: activity.reason, feedTab: (tab && tab.reason) || ''
                    };
                } catch (e) {
                    // The description is still a good answer on its own — never lose it
                    // because the feed would not open.
                    console.warn('SOTI AI Analyser: case brief activity failed', e);
                }
            }
            sendResponse(out);
        } catch (err) {
            console.warn('SOTI AI Analyser: case brief failed', err);
            sendResponse(null);
        }
        })();
        return true;
    }
    /* THE ONLY MESSAGE IN THIS FILE THAT CHANGES ANYTHING IN SALESFORCE.
     *
     * Answers with { ok } and, when it is false, with the STEP that stopped and
     * what was on the page at the time — because "it didn't work" about a
     * six-step sequence in somebody else's UI is not something anyone can act
     * on, and the engineer's next move (check the case, or try again) depends
     * entirely on whether the note was filed before the failure or after. */
    if (request.action === "POST_SALESFORCE_FEED") {
        (async () => {
            try {
                const out = await postToCaseFeed(request);
                console.log('SOTI AI Analyser: feed write', out);
                sendResponse(out);
            } catch (err) {
                console.error('SOTI AI Analyser: feed write failed', err);
                sendResponse({ ok: false, step: 'the write', why: (err && err.message) || String(err) });
            }
        })();
        return true;
    }
    /* WHICH ACCOUNT THIS CASE IS AGAINST, and where its record is — asked in the
     * CASE tab, and the first half of the Account Email action.
     *
     * The Details tab is opened only when the account field is not already
     * mounted: on a case the engineer has been working, it usually is, and
     * switching a sub-tab under somebody for a field that was already readable is
     * a change to their page for nothing. */
    if (request.action === "GET_SALESFORCE_CASE_ACCOUNT") {
        (async () => {
            try {
                const hasFields = (r) => findInShadows(FIELD_LABEL_SELECTOR, r, false).length > 0;
                const picked = rootForRecordRead(request.recordId, hasFields);
                const root = picked.root;

                let link = findCaseAccountLink(root);
                let details = null;
                if (!link && request.openDetails !== false) {
                    details = await activateDetailsTab(root, {
                        waitMs: Math.max(1000, parseInt(request.detailsWaitMs, 10) || 12000)
                    });
                    link = findCaseAccountLink(root);
                }

                if (!link) {
                    sendResponse({
                        ok: false,
                        why: (details && details.reason === 'no-details-tab')
                            ? 'This case layout has no Account Name field this panel could read.'
                            : 'The case’s Details tab opened but carried no Account Name link.',
                        readScope: picked.scope,
                        detailsTab: (details && details.reason) || ''
                    });
                    return;
                }
                sendResponse({
                    ok: true, id: link.id, name: link.name, url: link.url,
                    readScope: picked.scope, detailsTab: (details && details.reason) || ''
                });
            } catch (err) {
                console.warn('SOTI AI Analyser: case account read failed', err);
                sendResponse({ ok: false, why: (err && err.message) || String(err) });
            }
        })();
        return true;
    }
    /* THE ACCOUNT TEAM — asked in the ACCOUNT tab, which is a background reader
     * tab the panel opened at the URL the message above handed it.
     *
     * Polled by the caller while the record loads, exactly like the case brief, so
     * this has to be cheap on an unrendered page and it is: a read of seven fields
     * and no clicking at all unless the detail form is genuinely not mounted. */
    if (request.action === "GET_SALESFORCE_ACCOUNT_TEAM") {
        (async () => {
            try {
                const hasFields = (r) => findInShadows(FIELD_LABEL_SELECTOR, r, false).length > 0;
                const picked = rootForRecordRead(request.recordId, hasFields);
                const root = picked.root;

                let team = scrapeAccountTeam(root);
                let details = null;
                let sectionsOpened = 0;
                let bounce = null;
                let nudged = 0;

                /* THE TEST IS "IS THE DETAIL LAYOUT IN THE DOCUMENT", not "did I find
                 * any fields at all", and getting that wrong is what made every account
                 * read back as its owner and its TAM.
                 *
                 * The old gate was `!team.fieldsSeen`. On a SOTI Account the compact
                 * layout in the highlights strip IS Account Owner and TAM, and the strip
                 * is on screen whatever sub-tab is selected — so two fields were always
                 * "seen", the gate never fired, the Details tab was never opened, and the
                 * five fields that actually hold the account team were never in the
                 * document to be read. The read then reported itself finished, because
                 * from inside it nothing had gone wrong.
                 *
                 * activateDetailsTab self-gates on detailFieldsShowing, so calling it when
                 * the layout IS mounted costs one selector query and returns
                 * 'already-showing'. The wait is shorter than it was because the caller
                 * POLLS: a Details tab that is not on the page yet gets another try in
                 * 700ms, which is cheaper than sitting here for twelve seconds.
                 *
                 * NOTHING BUT THE STRIP is the other way in, and it is the one that does
                 * not depend on `data-target-selection-name` being on the layout at all —
                 * some orgs render these as bare form elements, and on one of those
                 * detailFieldsShowing is false with the whole team plainly on the page.
                 * "Every field I found came from the highlights strip" is true regardless
                 * of how the org writes its markup. */
                const stripOnly = (team.fieldsSeen - team.fromHighlights) <= 0;
                if (request.openDetails !== false && (stripOnly || !detailFieldsShowing(root))) {
                    details = await activateDetailsTab(root, {
                        waitMs: Math.max(1000, parseInt(request.detailsWaitMs, 10) || 4000),
                        /* THIS RUNS IN THE BACKGROUND READER TAB, which holds one record,
                         * is not on screen, and is closed when the read finishes — and
                         * which Chrome renders so little of that a Details tab sitting
                         * right there measures 0×0 and reads as invisible. Clicking blind
                         * is safe here and is the only way the tab ever opens. */
                        allowHidden: true
                    });
                }
                /* AND THEN ANY SECTION SOMEBODY LEFT COLLAPSED. "Enterprise Support
                 * Information" is one, and a collapsed section on a Dynamic Forms layout
                 * renders none of its fields — so an open Details tab is not on its own
                 * enough to have the aligned engineers in the document. */
                if (request.openDetails !== false) sectionsOpened = expandRecordSections(root);

                /* STILL NOTHING BUT THE STRIP. Two more things are worth doing before the
                 * page is believed, and both are what an engineer does without noticing:
                 * leave the Details tab and come back to it, which is the only thing that
                 * makes Lightning mount a panel that was already selected; and scroll,
                 * which is what tells it the sections below the fold have been looked at.
                 * The BOUNCE is only for a panel that never mounted at all, which is what
                 * "nothing outside the strip" means. */
                if (request.openDetails !== false && (team.fieldsSeen - team.fromHighlights) <= 0) {
                    bounce = await bounceDetailsTab(root);
                    if (bounce && bounce.reason === 'opened') {
                        sectionsOpened += expandRecordSections(root);
                        team = scrapeAccountTeam(root);
                    }
                }

                /* THE SCROLL IS FOR THE OTHER HALF OF THE PROBLEM, and gating it on the
                 * same condition is what stopped it running on the record that needed it.
                 *
                 * A Hornbach-shaped Account layout mounts perfectly: Details showing,
                 * fourteen sections, sixty-three field labels, a real 1133x904 viewport.
                 * All of it the TOP of the page — Account Information, Address
                 * Information, and the section headers below them with nothing inside.
                 * Lightning renders a long record as it comes into view, and in a tab
                 * nobody scrolls, nothing below the fold ever does. "Enterprise Support
                 * Information" is one of the sections down there.
                 *
                 * That page is not "nothing outside the strip" — it has sixty-three
                 * labels — so the old gate skipped it, and the scroll that would have
                 * mounted the team never ran. The right question is whether the fields
                 * this panel is LOOKING FOR are all here yet, which is the same question
                 * the caller's readiness test asks. Scrolling costs a few property writes
                 * on a page that is about to be closed, and does nothing at all on a page
                 * that was never lazy. */
                /* ONCE PER RECORD, WHATEVER THE FIRST READ FOUND — and then again whenever
                 * the read is still short.
                 *
                 * Gating it on "am I short" alone made it a reaction to a page that had
                 * already failed to render, and on a record whose team section is below the
                 * fold the first read is short precisely BECAUSE nobody has scrolled. The
                 * whole record is walked through the viewport once, up front, so the page
                 * has been looked at before it is judged. Repeating it costs a second and
                 * a half and is only done while something is still missing. */
                if (request.openDetails !== false) {
                    const key = String(request.recordId || location.pathname || '');
                    const firstLook = !accountScrolled.has(key);
                    if (firstLook || team.fieldsSeen < team.fieldsTotal) {
                        accountScrolled.add(key);
                        nudged = await nudgeRecordScroll(root);
                        if (nudged) {
                            // Sections that only existed once the page had been scrolled past.
                            sectionsOpened += expandRecordSections(root);
                        }
                    }
                }

                if (details || sectionsOpened || bounce || nudged) team = scrapeAccountTeam(root);

                team.readScope = picked.scope;
                team.detailsTab = (details && details.reason) || '';
                team.detailsLabel = (details && details.label) || '';
                team.detailsCandidates = details ? (details.candidates || 0) : -1;
                team.sectionsOpened = sectionsOpened;
                team.sectionsOnPage = countRecordSections(root);
                team.bounce = (bounce && bounce.reason) || '';
                team.scrollers = nudged;
                /* Only when the read came back with nothing but the highlights strip —
                 * which is the one outcome nobody can explain from the result alone. On
                 * every other read this is a dozen selector queries nobody needs. */
                if (team.fieldsSeen < team.fieldsTotal) team.probe = accountPageProbe(root);
                sendResponse(team);
            } catch (err) {
                console.warn('SOTI AI Analyser: account team read failed', err);
                sendResponse(null);
            }
        })();
        return true;
    }
    /* FILL IN THE CASE'S EMAIL COMPOSER — Cc, Subject, body. Never Send.
     *
     * The second message in this file that changes anything in Salesforce, and the
     * only one that touches something the customer will read. It reports the same
     * way POST_SALESFORCE_FEED does — the step that stopped and what was on the
     * page — and it additionally reports WHO made it into the Cc field, because a
     * recipient the org's own lookup could not resolve is the one failure here
     * that leaves a usable composer behind and still needs saying. */
    /* THE INTERNAL PROBLEM & RESOLUTION NOTE — Details tab, pencil, text, and stop.
     *
     * The third message in this file that changes anything in Salesforce, and it reports the
     * same way the other two do: the step that stopped and what was on the page. It also
     * reports how much text the field ALREADY held, because replacing somebody's note is a
     * thing the engineer needs to be told about even though nothing is saved. */
    if (request.action === "WRITE_SALESFORCE_INTERNAL_NOTE") {
        (async () => {
            try {
                const out = await writeInternalResolutionNote(request);
                console.log('SOTI AI Analyser: internal note write', out);
                sendResponse(out);
            } catch (err) {
                console.error('SOTI AI Analyser: internal note write failed', err);
                sendResponse({ ok: false, step: 'the note', why: (err && err.message) || String(err) });
            }
        })();
        return true;
    }
    if (request.action === "WRITE_SALESFORCE_EMAIL") {
        (async () => {
            try {
                const out = await writeEmailToCaseComposer(request);
                console.log('SOTI AI Analyser: email composer write', out);
                sendResponse(out);
            } catch (err) {
                console.error('SOTI AI Analyser: email composer write failed', err);
                sendResponse({ ok: false, step: 'the email', why: (err && err.message) || String(err) });
            }
        })();
        return true;
    }
    if (request.action === "GET_JIRA_DATA") {
        try {
            const data = scrapeJira();
            console.log('SOTI AI Analyser: Scraped JIRA', data);
            sendResponse(data);
        } catch (err) {
            console.error('SOTI AI Analyser: JIRA scrape failed', err);
            sendResponse(null);
        }
        return true;
    }
    if (request.action === "GET_SALESFORCE_DATA") {
        // Scraping is now asynchronous (it scrolls the feed to the bottom first),
        // so we reply from the promise. `return true` below keeps the message
        // channel open until then — without it Chrome closes it immediately and
        // the side panel receives undefined.
        scrapeSalesforce({ loadFullFeed: request.loadFullFeed !== false })
            .then(data => {
                console.log('SOTI AI Analyser: Scraped Data', data);
                sendResponse(data);
            })
            .catch(err => {
                console.error('SOTI AI Analyser: Scrape failed', err);
                sendResponse(null);
            });
    }
    return true;
});


/* ===========================================================================
 *  QA TOOL — THE STRUCTURED FEED READ
 * ---------------------------------------------------------------------------
 *  Everything above this line is the SOTI AI Analyser's Salesforce reader,
 *  carried over unchanged so that a fix made there can be dropped in here
 *  without a merge. This section is the QA Tool's own, and it exists for one
 *  reason: the analyser hands the feed to a model as PROSE, and quality
 *  assurance is arithmetic before it is judgement.
 *
 *  `emailChain` is a single string of "[3h ago] [CALL LOG] Jane Doe: …" blocks.
 *  A model can read that. It cannot be asked "was the first response inside two
 *  hours" and be believed, because the answer depends on turning "3h ago" and
 *  "Yesterday at 14:02" into real instants and subtracting them — and a model
 *  asked to do date arithmetic over forty posts will produce a confident number
 *  that is wrong often enough to matter when somebody's coaching record is the
 *  output.
 *
 *  So the QA read returns the feed as DATA: one record per post, with the
 *  timestamp already resolved to milliseconds by the same parseSalesforceDate
 *  the analyser trusts for its own activity dates, the direction already
 *  decided by the same feedItemIsFromUs, and the replies attached to the post
 *  they answer. qa-engine.js then measures first response time, silence gaps
 *  and missing meeting notes in JavaScript, and the model is asked only for the
 *  things that genuinely need reading: whether the answer was any good, and
 *  what the agent should be taught.
 * ========================================================================= */

/* WHICH POST IS A MEETING.
 *
 * A logged call is one by construction — Salesforce's own Log a Call icon says so, and
 * that is the strongest signal on the page. Everything else is a post whose text says a
 * meeting happened or is about to, and the wording is the team's own: "WebEx", "Teams
 * call", "remote session", "screen share". Deliberately NOT the bare word "call": half
 * the support corpus contains "please call me back" and "the call stack shows", and a
 * meeting-note rule that fires on those flags every case in the queue.
 */
const QA_MEETING_TEXT = /\b(webex|zoom call|teams (?:call|meeting|session)|remote session|screen ?share|screenshare|gotomeeting|google meet|conference call|troubleshooting session|joint session|live session|remote assistance)\b/i;

/* …AND WHICH POST IS THE NOTE THAT HAS TO FOLLOW ONE.
 *
 * The rule the team works to is that a meeting is written up in the call log or in a post
 * afterwards. A call log entry IS a meeting note. A post counts when it reads like a
 * record of what happened rather than an arrangement to meet — so the test is on the
 * past-tense vocabulary of a write-up, and it is applied only to posts that come AFTER
 * the meeting (see qa-engine.js), which is what stops "we discussed this last week" in an
 * opening email being read as a note for a session that had not happened yet.
 */
const QA_MEETING_NOTE_TEXT = /\b(meeting notes?|call notes?|session notes?|minutes of|summary of (?:the )?(?:call|meeting|session)|during (?:the|our) (?:call|meeting|session)|on (?:the|our) call|we (?:discussed|reviewed|walked through|went through|covered|agreed)|attendees|action items?|as discussed)\b/i;

// The Log a Call icon, and the record type Salesforce puts on the article. Either is
// enough; both together are the ordinary case.
function qaItemIsCall(item) {
    if (!item) return false;
    const type = (item.getAttribute && item.getAttribute('data-type')) || '';
    if (/call/i.test(type)) return true;
    return !!item.querySelector('.slds-icon-standard-log-a-call, [title*="Log a Call"], [title*="Call"]');
}

// An EMAIL as opposed to a Chatter post. The body element is the tell: Salesforce renders
// an email's text through its own component, and a post's through the plain feed body.
function qaItemIsEmail(item) {
    if (!item) return false;
    const type = (item.getAttribute && item.getAttribute('data-type')) || '';
    if (/email/i.test(type)) return true;
    return !!item.querySelector('.emailMessageBody, emailui-rich-text-output, .forceChatterEmailMessageBody');
}

/* ONE POST'S TEXT, read the same way the analyser reads it.
 *
 * Lifted from scrapeSalesforce rather than reimplemented: the "prefer the longest of the
 * candidate bodies" rule is there because Salesforce renders a truncated summary beside
 * the full text and reading the wrong one silently halves the evidence. Scoped past the
 * replies for the same reason it is there — a comment's body carries a post's classes, so
 * an attachment-only post would otherwise be filed under its first reply's words.
 */
function qaItemBody(item, readText) {
    const summary = readText(item.querySelector('.preamble_custom-summary'));
    const emailBody = readText(item.querySelector('.emailMessageBody'));
    const callBody = readText(item.querySelector('.logCallDescription'));
    const postBodyEl = Array.from(item.querySelectorAll('.forceChatterFeedBodyText, .feedBodyInner'))
        .find(el => !el.closest(FEED_COMMENT_SELECTOR));
    const postBody = readText(postBodyEl);

    let richText = '';
    const richTextEl = item.querySelector('emailui-rich-text-output');
    if (richTextEl && richTextEl.getAttribute('value')) {
        richText = richTextEl.getAttribute('value')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim();
    }
    return [emailBody, callBody, postBody, richText, summary]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || '';
}

/* THE WHOLE FEED, AS RECORDS, OLDEST FIRST.
 *
 * Oldest first because every measurement this tool makes is a duration between one event
 * and the NEXT one, and reading a newest-first list backwards is where an off-by-one in a
 * gap calculation comes from. The analyser's own reads take a maximum rather than a
 * position for the same reason — a feed's sort order is a setting, not a guarantee.
 *
 * A post with no timestamp this build can parse is KEPT, with `at: null`. It is still
 * evidence of what was said; it simply cannot take part in the arithmetic, and
 * qa-engine.js says how many were dropped from it rather than quietly measuring a case
 * with half its posts missing.
 */
function readQaFeedItems(root, opts = {}) {
    const now = Date.now();
    const out = { user: '', domains: [], items: [], seen: 0, dated: 0, classified: 0, reason: 'no-feed' };

    let items = findInShadows(FEED_ITEM_SELECTOR, root || document, false);
    if (!items.length && root && root !== document) items = findInShadows(FEED_ITEM_SELECTOR, document, false);
    if (!items.length) return out;

    const ctx = {
        user: salesforceCurrentUser(),
        owner: opts.owner || '',
        contact: opts.contact || '',
        domains: ourEmailDomains(opts.domain)
    };
    const scope = items.slice(0, 700);

    /* LEARN OUR OWN EMAIL DOMAIN OFF THE FEED FIRST — the same pass readFeedActivity makes,
     * and for the same reason: a post written by the signed-in user or the case owner that
     * carries a From address has answered the question outright, and every direction
     * decision below is only as good as that answer. */
    for (const item of scope) {
        const text = (item.innerText || item.textContent || '').trim();
        const addr = emailHeaderAddress(text, 'from');
        if (!addr) continue;
        const who = emailHeaderName(text, 'from') || feedItemSender(item);
        if (!nameIsOurs(who, ctx)) continue;
        const domain = domainOfAddress(addr);
        if (domain && !ctx.domains.includes(domain)) ctx.domains.unshift(domain);
    }
    out.user = ctx.user;
    out.domains = ctx.domains.slice();

    const readText = (el) => {
        if (!el) return '';
        const rendered = typeof el.innerText === 'string' ? el.innerText.trim() : '';
        return rendered || (el.textContent || '').trim();
    };

    // Replies, gathered once from the root and grouped by the post they answer — the
    // analyser's own routine, so a reply lands under the right post here too.
    let byItem = new Map();
    try { byItem = collectFeedComments(scope, root || document, readText).byItem; } catch (e) { /* posts alone */ }

    for (const item of scope) {
        out.seen++;
        const { ms, label } = feedItemTimestamp(item, now);
        if (ms) out.dated++;

        const text = (item.innerText || item.textContent || '').trim();
        const sender = feedItemSender(item) || 'Unknown';
        const internal = feedItemIsInternal(item, text);
        const call = qaItemIsCall(item);
        const kind = call ? 'call' : internal ? 'internal' : qaItemIsEmail(item) ? 'email' : 'post';

        /* DIRECTION. An internal note never leaves SOTI, so it is ours by definition and is
         * not put through the classifier — which is what readFeedActivity does, and for the
         * same reason: asking "did this go to the customer" of a note that cannot have is a
         * question with no true answer. A call log is ours too; nobody but us writes one.
         * Everything else is asked, and `null` — genuinely could not tell — is preserved
         * rather than collapsed into "theirs", because a gap blamed on the customer when we
         * simply could not read who wrote the last post is the worst output this tool has. */
        let fromUs;
        if (internal || call) fromUs = true;
        else fromUs = feedItemIsFromUs(text, ctx, sender);
        if (fromUs !== null && !internal && !call) out.classified++;

        const body = qaItemBody(item, readText);
        const replies = (byItem.get(item) || []).map(c => ({
            author: c.author,
            label: c.time,
            at: parseSalesforceDate(c.time, now),
            body: c.body
        }));

        if (!body && !replies.length) continue;   // a record-change entry, not a message

        out.items.push({
            at: ms,
            label,
            sender,
            kind,
            internal,
            fromUs,
            body,
            replies,
            // Read here rather than in the engine so the test runs against the post's WHOLE
            // rendered text — headers, subject line and all — which is where "WebEx invite"
            // usually is. The engine sees only the body.
            mentionsMeeting: QA_MEETING_TEXT.test(text),
            readsAsMeetingNote: kind === 'call' || QA_MEETING_NOTE_TEXT.test(text)
        });
    }

    /* OLDEST FIRST, and undated posts at the end. A null timestamp sorted as zero would put
     * every unreadable post at the start of the case and make the first response time the
     * distance to whichever one of them happened to be there. */
    out.items.sort((a, b) => {
        if (a.at === b.at) return 0;
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return a.at - b.at;
    });

    out.reason = !out.items.length ? 'no-items'
        : !out.dated ? 'no-dates'
        : !out.classified ? 'not-attributed'
        : 'ok';
    return out;
}

/* WHEN THE CASE WAS OPENED — the instant every first-response measurement starts from.
 *
 * scrapeSalesforce does not read this field: the analyser wants the case AGE, which the
 * layout gives it as a number, and never needs the opening instant. QA does — "within two
 * hours" is meaningless without it — so it is read here, off the same labels, through the
 * same getFieldValue. Several names because orgs differ, and the plain "Opened" last so a
 * layout carrying only that still answers.
 */
function readCaseOpenedAt(root) {
    const out = { raw: '', at: null };
    /* THE ACTIVE RECORD'S ROOT, not the whole document — and the document only as a
     * fallback when that root holds no labels at all. A Salesforce console keeps every open
     * case in the DOM at once, so reading the document for "Date/Time Opened" can answer
     * with a DIFFERENT case's opening instant, and the first response time would then be
     * measured from a moment that has nothing to do with this case. Same reasoning, and the
     * same fallback, as the field read inside scrapeSalesforce. */
    let labels = findInShadows(FIELD_LABEL_SELECTOR, root || document, false);
    if (!labels.length && root && root !== document) labels = findInShadows(FIELD_LABEL_SELECTOR, document, false);
    const wanted = ['date/time opened', 'date opened', 'opened date', 'created date', 'opened'];
    for (const want of wanted) {
        for (const label of labels) {
            const text = labelTextOf(label);
            if (text !== want) continue;
            const v = getFieldValue(label, true);
            if (!v) continue;
            out.raw = v;
            out.at = parseSalesforceDate(v, Date.now());
            if (out.at) return out;
        }
    }
    return out;
}

/* THE ONE MESSAGE THE QA PANEL SENDS PER CASE.
 *
 * A separate listener rather than another branch in the one above, so this file stays a
 * clean copy of the analyser's with an appendix: the diff against the upstream reader is
 * "everything after the QA TOOL banner", which is the only shape in which the two can be
 * kept in step by hand. Chrome delivers a message to every listener and takes the first
 * response that arrives, so the listener above — which never answers to this action —
 * costs nothing.
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'GET_SALESFORCE_QA_CASE') return;
    (async () => {
        try {
            /* THE ANALYSER'S OWN SCRAPE FIRST, WHOLE. It activates the Feed tab, scrolls the
             * feed to its end, expands the truncated posts and opens the collapsed replies —
             * so by the time it returns, the DOM the structured read below walks is the
             * complete case rather than the twenty posts that fitted on screen. Doing it in
             * the other order is how a QA run reports "no gaps" on a case whose first six
             * months had not been loaded. */
            const data = await scrapeSalesforce({ loadFullFeed: true });
            const root = getActiveWorkspaceRoot();
            data.qaFeed = readQaFeedItems(root, { owner: data.caseOwner, contact: data.contactName });
            data.qaOpened = readCaseOpenedAt(root);
            data.qaReadAt = Date.now();
            console.log(`SOTI QA Tool: read ${data.caseNumber || 'case'} — `
                + `${data.qaFeed.items.length} feed record(s), ${data.qaFeed.dated} dated (${data.qaFeed.reason})`);
            sendResponse(data);
        } catch (err) {
            console.error('SOTI QA Tool: case read failed', err);
            sendResponse(null);
        }
    })();
    return true;
});
