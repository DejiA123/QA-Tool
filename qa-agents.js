/* ============================================================================
 * QA Tool — THE QA AGENTS
 * ============================================================================
 * The SOTI AI Analyser routes every request through specialist agents (Network, Process, KB, Logs) and checks every
 * answer in code. The QA Tool does the same for a case review. Four agents read the case timeline and each points the
 * team lead at the MOMENTS worth looking at — what happened, on which day, and a link straight to that email, post or
 * call in Salesforce:
 *
 *   · TIMELINE        the first response, silences while the case waited on SOTI, customer chases, messages never
 *                     answered
 *   · COMMUNICATION   a customer who sounds frustrated, or asks for escalation, in their own words
 *   · PROCESS         the Out of Scope closure process (2026 onward) and the 3x closure process
 *   · DOCUMENTATION   the Problem & Resolution Summary, internal notes, meetings written up
 *
 * And one that reads the write-up afterwards:
 *
 *   · FACT CHECK      every case number, JIRA, link and email address the write-up quotes must be in the case
 *
 * quickScore turns the measured facts and the agents' flags into a score that starts high and drops with every
 * problem, with the reasons listed — the same figure for a case reviewed in full and one only scanned.
 *
 * Pure: no DOM, no chrome.*, no network. Takes `data` from either read (GraphQL or the page) and `m` from
 * QaEngine.measureCase. Exposes window.QaAgents.
 * ========================================================================== */
(function (root) {
    'use strict';
    const E = () => root.QaEngine;
    const HOUR = 3600000, DAY = 24 * HOUR;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
    const list = (v) => (Array.isArray(v) ? v : []);
    function when(ms) {
        if (!ms) return '';
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function dur(ms) {
        if (ms === null || ms === undefined) return '';
        if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60000))} min`;
        if (ms < 2 * DAY) return `${Math.round(ms / HOUR * 10) / 10} h`;
        return `${Math.round(ms / DAY * 10) / 10} days`;
    }
    const quote = (text, re) => {
        const t = String(text || '').replace(/\s+/g, ' ');
        const m = re.exec(t);
        if (!m) return '';
        const from = Math.max(0, m.index - 60), to = Math.min(t.length, m.index + m[0].length + 80);
        return (from ? '…' : '') + t.slice(from, to).trim() + (to < t.length ? '…' : '');
    };
    // Does `who` name this person? Full name, or the first and last names both, whichever way round.
    function samePerson(who, name) {
        const a = norm(who), b = norm(name);
        if (!a || !b) return false;
        if (a === b || a.includes(b) || b.includes(a)) return true;
        const parts = b.split(' ').filter((x) => x.length > 1);
        return parts.length >= 2 && parts.every((p) => a.includes(p));
    }
    const mentions = (text, name) => {
        const t = norm(text), n = norm(name);
        if (!t || !n) return false;
        if (t.includes(n) || t.includes('@' + n)) return true;
        const first = n.split(' ')[0];
        return first.length > 2 && new RegExp(`@${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
    };

    /* ------------------------------------------------------------------ the agents ------------------------------- */
    function caseLink(data, rec) {
        return (data && data.caseUrl) || (rec && rec.url) || '';
    }
    function itemAt(items, at) {
        if (!at) return null;
        return items.find((i) => i.at === at) || null;
    }

    function timelineAgent(ctx) {
        const { m, items, flag, data, rec } = ctx;
        const cl = caseLink(data, rec);
        if (!m) return;
        if (m.frtMet === false && m.firstResponseMs !== null) {
            const first = itemAt(items, m.firstResponseAt);
            flag('Timeline', 'fail', `First response late — ${dur(m.firstResponseMs)}`,
                `${m.assignedAt ? `Handed to ${m.assignedTo || 'the owner'} on ${when(m.assignedAt)}` : `Case opened ${when(m.openedAt)}`}; the first reply went out ${when(m.firstResponseAt)}${m.firstResponseBy ? ` from ${m.firstResponseBy}` : ''}. The target is ${m.frtTargetHours} hours.`,
                m.firstResponseAt, (first && first.url) || cl, true);
        } else if (m.frtMet === false) {
            flag('Timeline', 'fail', 'No first response', m.assignedAt
                ? `Nothing was sent to the customer after the case was handed over on ${when(m.assignedAt)}.`
                : 'Nothing was sent to the customer on this case.', m.assignedAt || m.openedAt, cl, true);
        } else if (m.frtMet === true) {
            const first = itemAt(items, m.firstResponseAt);
            flag('Timeline', 'pass', `First response in ${dur(m.firstResponseMs)}`,
                `${m.assignedAt ? 'From the handover' : 'From the case opening'}, inside the ${m.frtTargetHours}-hour target.`,
                m.firstResponseAt, (first && first.url) || cl, true);
        }
        for (const g of list(m.gaps)) {
            if (g.owedByUs !== true) continue;
            const before = itemAt(items, g.fromAt);
            flag('Timeline', 'fail', `${dur(g.ms)} with no reply from SOTI`,
                `From ${when(g.fromAt)} (after ${g.afterWhom}'s message) to ${when(g.toAt)}.`, g.fromAt, (before && before.url) || cl, true);
        }
        // Each customer email that followed another with nothing from SOTI between: the customer chasing.
        let lastCustomer = null;
        for (const i of items.filter((x) => x.at)) {
            if (i.fromUs === false) {
                if (lastCustomer) flag('Timeline', 'warn', 'Customer chased', `${i.sender} wrote again on ${when(i.at)} with no reply since ${when(lastCustomer.at)}.`, i.at, i.url || cl, true);
                lastCustomer = i;
            } else if (i.fromUs === true && !i.internal) lastCustomer = null;
        }
        const closed = !!(data && ((data.qaClosed && data.qaClosed.at) || /\bclosed\b/i.test(data.caseStatus || '')));
        for (const u of list(m.unansweredCustomerPosts).slice(-2)) {
            const it = itemAt(items, u.at);
            flag('Timeline', closed ? 'fail' : 'warn', closed ? 'Closed with the customer\'s message unanswered' : 'Customer message waiting on SOTI',
                `${u.sender}'s message of ${when(u.at)} has no reply after it.`, u.at, (it && it.url) || cl, true);
        }
    }

    const FRUSTRATED = /\b(frustrat\w*|disappoint\w*|unacceptable|not (?:happy|acceptable|good enough)|unhappy|very poor|poor service|terrible|ridiculous|still (?:not|no|waiting|broken)|no (?:one|response|reply|update)s? (?:has|from|yet)|any update\??|chasing|again (?:i|we) (?:ask|request)|how (?:much )?longer|urgent(?:ly)?|asap|critical(?:ly)?)\b/i;
    const ESCALATE = /\b(escalat\w+|speak (?:to|with) (?:a|your) (?:manager|supervisor|team ?lead)|formal complaint|raise a complaint|complain\w*)\b/i;
    function communicationAgent(ctx) {
        const { items, flag, data, rec } = ctx;
        const cl = caseLink(data, rec);
        const fromCustomer = items.filter((i) => i.fromUs === false && i.body);
        const esc = fromCustomer.filter((i) => ESCALATE.test(i.body));
        for (const i of esc.slice(-2)) flag('Communication', 'fail', 'Customer asked for escalation or complained', `“${quote(i.body, ESCALATE)}” — ${i.sender}, ${when(i.at)}.`, i.at, i.url || cl, false, 8);
        const upset = fromCustomer.filter((i) => !ESCALATE.test(i.body) && FRUSTRATED.test(i.body));
        for (const i of upset.slice(-3)) flag('Communication', 'warn', 'Customer sounds frustrated', `“${quote(i.body, FRUSTRATED)}” — ${i.sender}, ${when(i.at)}.`, i.at, i.url || cl, false, 3);
    }

    /* THE OUT OF SCOPE CLOSURE PROCESS (EMEA Technical Support, 2026 onward):
     *   1. the agent sets "Duplicate Case #" to C00003333, which triggers a review;
     *   2. the agent tags their TL in the case feed with a justification and a brief case summary, and keeps the case open;
     *   3. the TL reviews and tags the agent in a Salesforce post to close it;
     *   4. the TL completes the Quality Audits section: Case Reviewed By, Case Reviewed ticked, post-review notes;
     *   5. the agent closes the case as guided — Send survey, No survey (Out of Scope), or Reclassify. */
    const OOS = /\bout[\s-]*of[\s-]*scope\b|\bopened[\s-]*in[\s-]*error\b|\boos\b/i;
    function processAgent(ctx) {
        const { items, flag, data, rec } = ctx;
        const cl = caseLink(data, rec);
        const c = (data && data.qaClosure) || {};
        const status = `${data && data.caseStatus || ''} ${c.subStatus || ''}`;
        const dup = String(c.duplicateCase || '');
        const requested = /\bC0*3333\b/i.test(dup);
        const closedAsOos = OOS.test(status);
        const closedAt = (data && data.qaClosed && data.qaClosed.at) || null;
        const owner = (data && data.caseOwner) || (rec && rec.owner) || '';
        const tl = c.teamLead || (rec && rec.ownerManager) || '';
        if (closedAsOos || requested) {
            const posts = items.filter((i) => (i.kind === 'internal' || i.kind === 'post') && i.at);
            /* WERE THE POSTS READ? A post on screen says yes. The GraphQL read says so outright (notesRead); the page read
             * walks the whole feed, posts included, so its silence counts as "none". A scan never reads them. */
            const nr = data && data.qaFeed ? data.qaFeed.notesRead : undefined;
            const notesRead = posts.length > 0 || nr === true || (nr === undefined && !(data && data.qaSource === 'graphql-scan'));
            if (!requested) {
                flag('Process', 'fail', 'Out of Scope: approval not requested', `The case was closed as ${c.subStatus || data.caseStatus || 'Out of Scope'}, but "Duplicate Case #" is ${dup ? `“${dup}”` : 'empty'} — it should be set to C00003333 to trigger the TL review.`, closedAt, cl, false, 12);
            } else {
                flag('Process', 'pass', 'Out of Scope: review requested', 'Duplicate Case # is set to C00003333.', null, cl, false);
            }
            const tag = posts.find((p) => (!owner || samePerson(p.sender, owner)) && (tl ? mentions(p.body, tl) : false) && (!closedAt || p.at <= closedAt))
                || posts.find((p) => (!owner || samePerson(p.sender, owner)) && OOS.test(p.body) && (!closedAt || p.at <= closedAt));
            if (tag) {
                flag('Process', 'pass', 'Out of Scope: TL tagged with a justification', `${tag.sender} posted on ${when(tag.at)}.`, tag.at, tag.url || cl, false);
            } else if (notesRead) {
                flag('Process', 'fail', 'Out of Scope: TL never tagged', `No post by ${owner || 'the agent'} tags ${tl || 'their TL'} with a justification before the case was closed.`, closedAt, cl, false, 12);
            } else {
                flag('Process', 'warn', 'Out of Scope: check the TL was tagged', 'The case feed\'s posts could not be read, so whether the agent tagged their TL with a justification is not known. Check the feed.', closedAt, cl, false);
            }
            const after = tag ? tag.at : 0;
            const tlPost = tl ? posts.find((p) => p.at >= after && samePerson(p.sender, tl)) : null;
            const tlReply = !tlPost && tag && tl ? list(tag.replies).find((r) => samePerson(r.author, tl)) : null;
            if (tlPost || tlReply) {
                const at = tlPost ? tlPost.at : tlReply.at;
                flag('Process', 'pass', 'Out of Scope: TL approved', `${tl} answered on ${when(at)}.`, at, (tlPost && tlPost.url) || (tag && tag.url) || cl, false);
                if (closedAt && at && closedAt < at) flag('Process', 'fail', 'Closed before the TL approved', `The case was closed ${when(closedAt)}, before ${tl}'s post of ${when(at)}.`, closedAt, cl, false, 12);
            } else if (notesRead && tag) {
                flag('Process', 'fail', 'Out of Scope: no TL approval in the feed', `No post from ${tl || 'the TL'} tells the agent to close the case.`, closedAt, (tag && tag.url) || cl, false, 10);
            }
            const audited = c.caseReviewed === true && String(c.caseReviewedBy || '').trim();
            if ('caseReviewed' in c || 'caseReviewedBy' in c) {
                if (audited) flag('Process', 'pass', 'Quality Audits completed', `Case Reviewed by ${c.caseReviewedBy}${String(c.postReview || '').trim() ? ', with post-review notes' : ''}.`, null, cl, false);
                else flag('Process', 'warn', 'Quality Audits section not completed', `“Case Reviewed”${c.caseReviewed === true ? ' is ticked' : ' is not ticked'} and “Case Reviewed By” is ${String(c.caseReviewedBy || '').trim() ? 'filled in' : 'empty'} — the TL completes this when approving.`, null, cl, false);
            }
        }
        // THE 3x CLOSURE PROCESS: three attempts to reach the customer, after their last reply, before closing.
        if (/\b3\s*x\b|three[\s-]*strike|3[\s-]*strike/i.test(status) && closedAt) {
            const dated = items.filter((i) => i.at && i.at <= closedAt);
            const lastCustomer = [...dated].reverse().find((i) => i.fromUs === false);
            const attempts = dated.filter((i) => i.fromUs === true && !i.internal && (i.kind === 'email' || i.kind === 'call') && (!lastCustomer || i.at > lastCustomer.at));
            const days = new Set(attempts.map((i) => new Date(i.at).toDateString())).size;
            if (attempts.length < 3) flag('Process', 'fail', `3x closure with ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`, `Closed under the 3x process, but only ${attempts.length} outgoing email(s) or call(s) followed the customer's last message${lastCustomer ? ` of ${when(lastCustomer.at)}` : ''}.`, closedAt, cl, false, 10);
            else if (days < 3) flag('Process', 'warn', '3x attempts not on separate days', `The ${attempts.length} attempts were made on ${days} day(s).`, attempts[0].at, attempts[0].url || cl, false, 4);
            else flag('Process', 'pass', '3x closure followed', `${attempts.length} attempts on ${days} separate days before closing.`, attempts[attempts.length - 1].at, attempts[attempts.length - 1].url || cl, false);
        }
    }

    function documentationAgent(ctx) {
        const { m, items, flag, data, rec } = ctx;
        const cl = caseLink(data, rec);
        const c = (data && data.qaClosure) || {};
        const closed = !!(data && ((data.qaClosed && data.qaClosed.at) || c.isClosed === true));
        if (closed && 'resolution' in c && !String(c.resolution || '').trim()) {
            flag('Documentation', 'fail', 'No Problem & Resolution Summary', 'The case is closed with the internal Problem & Resolution Summary empty — the next engineer has nothing to go on.', data.qaClosed && data.qaClosed.at, cl, false, 8);
        }
        const notesRead = !(data && data.qaFeed && data.qaFeed.notesRead === false);
        if (m && notesRead && m.counts && m.counts.internal === 0 && m.itemsSeen > 2) {
            flag('Documentation', 'warn', 'No internal notes', 'Nothing on the case records what was found or tried, for the next person.', null, cl, true);
        }
        for (const mt of list(m && m.meetings)) {
            if (mt.documented) continue;
            const it = itemAt(items, mt.at);
            flag('Documentation', 'fail', 'Meeting never written up', `A session around ${when(mt.at)} has no call log or notes after it.`, mt.at, (it && it.url) || cl, true);
        }
    }

    /* ------------------------------------------------------------------ the run ---------------------------------- */
    // { flags, counts } — flags newest-relevant first by severity. `rec` is the queue row (for the case link, the owner's
    // manager), when there is one.
    function review(data, m, rec) {
        const flags = [];
        const items = list(data && data.qaFeed && data.qaFeed.items);
        const flag = (agent, severity, title, detail, at, url, measured, points) =>
            flags.push({ agent, severity, title, detail, at: at || null, when: when(at), url: url || '', measured: !!measured, points: points || 0 });
        const ctx = { m, items, flag, data, rec };
        for (const agent of [timelineAgent, communicationAgent, processAgent, documentationAgent]) {
            try { agent(ctx); } catch (e) { /* one agent's trouble costs only its own flags */ }
        }
        const rank = { fail: 0, warn: 1, info: 2, pass: 3 };
        flags.sort((a, b) => (rank[a.severity] - rank[b.severity]) || ((a.at || 0) - (b.at || 0)));
        const counts = { fail: 0, warn: 0, pass: 0, info: 0 };
        for (const f of flags) counts[f.severity] = (counts[f.severity] || 0) + 1;
        return { flags, counts };
    }

    /* THE QUICK SCORE. QaEngine.deriveScore weighs the measured facts (first response, silences, chases, meetings,
     * internal notes); the agents' own findings that the measurement cannot see (the Out of Scope steps, the 3x process,
     * a missing resolution summary, a customer asking to escalate) take their points off on top. */
    function quickScore(m, flags, rules, opts) {
        /* A case whose notes were NOT READ (a scan: Salesforce's feed service answers one case at a time) is not marked
         * down for having none — "no internal note anywhere" would be a guess about what the scan did not look at. */
        const notesUnread = !!(opts && opts.notesRead === false);
        const mm = notesUnread && m && m.counts ? Object.assign({}, m, { counts: Object.assign({}, m.counts, { internal: null }) }) : m;
        const base = E() ? E().deriveScore(mm, rules) : { value: 70, basis: '' };
        let n = base.value;
        const why = base.basis && base.basis !== 'nothing was flagged against this case' ? base.basis.split('; ') : [];
        const caps = { Process: 24, Documentation: 8, Communication: 12 };
        const taken = { Process: 0, Documentation: 0, Communication: 0 };
        for (const f of list(flags)) {
            if (f.measured || !f.points || f.severity === 'pass') continue;
            const room = (caps[f.agent] || 10) - (taken[f.agent] || 0);
            const pts = Math.min(f.points, Math.max(0, room));
            if (!pts) continue;
            taken[f.agent] = (taken[f.agent] || 0) + pts;
            n -= pts;
            why.push(f.title.toLowerCase());
        }
        n = Math.max(10, Math.min(98, Math.round(n)));
        return { value: n, band: E() ? E().bandFor(n) : '', derived: true, basis: why.length ? why.join('; ') : 'nothing was flagged against this case' };
    }

    /* THE FACT CHECK. What the write-up quotes that the case does not contain: case numbers, JIRA keys, links and email
     * addresses. Each is looked for in the material the write-up was given; what is not there is listed. */
    const CHECKS = [
        { kind: 'case number', re: /\bC0\d{6,8}\b/g },
        { kind: 'JIRA', re: /\b(?:MCMR|MC|XS|SNAP|CON|SR|SUP|DEV|QA|ENG|PLAT|CLD|CS)-\d{2,7}\b/g },
        { kind: 'link', re: /\bhttps?:\/\/[^\s)>\]"']+/g },
        { kind: 'email address', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
    ];
    function factCheck(text, material) {
        const hay = String(material || '').toLowerCase();
        const out = [];
        const seen = new Set();
        for (const { kind, re } of CHECKS) {
            for (const m of String(text || '').matchAll(re)) {
                const tok = m[0].replace(/[.,;:]+$/, '');
                const key = kind + '|' + tok.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const probe = kind === 'link' ? tok.toLowerCase().replace(/\/+$/, '') : tok.toLowerCase();
                if (!hay.includes(probe)) out.push({ kind, value: tok });
            }
        }
        return out;
    }

    root.QaAgents = { review, quickScore, factCheck, samePerson, when, dur, OOS };
})(typeof self !== 'undefined' ? self : window);
