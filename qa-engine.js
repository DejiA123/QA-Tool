/* ============================================================================
 * QA Tool — THE QA ENGINE
 * ============================================================================
 * Everything that decides whether a case was handled well, split in two halves
 * that must not be confused with each other:
 *
 *   MEASURED — first response time, silence gaps, whether a meeting was written
 *   up, how many times the customer had to chase. These are arithmetic over the
 *   timestamps qa-content's structured read produced, and they are computed
 *   HERE, in JavaScript, before any model sees the case.
 *
 *   JUDGED — was the answer any good, was the resolution note worth reading,
 *   what should this agent be taught. These need someone to read the case, and
 *   that is what the model is for.
 *
 * THE SPLIT IS THE WHOLE DESIGN. A model asked "was the first response inside
 * two hours" has to parse forty timestamps, some of them relative ("3h ago"),
 * subtract two of them and compare against a threshold — and it will answer
 * confidently either way. When the output of this tool is a line on somebody's
 * coaching record, a confident wrong number is worse than no number. So every
 * fact that CAN be computed is computed, the model is TOLD those facts as
 * givens, and it is forbidden from re-deriving them. What is left for it is the
 * part that genuinely needs reading.
 *
 * Nothing in this file touches the DOM or chrome.*; it is all pure functions
 * over the record qa-content.js returns, which is what makes the rules
 * checkable without a browser.
 * ========================================================================== */
(function () {
    'use strict';

    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;

    /* ---------------------------------------------------------------------
     * THE RULES
     * ---------------------------------------------------------------------
     * The team's standards, in one place, with the numbers the team gave. They
     * are settings rather than constants because a threshold nobody can change
     * is a threshold people work around: an SLA that moves to four hours next
     * quarter must not need a new build.
     * ------------------------------------------------------------------- */
    const DEFAULT_RULES = {
        // FIRST RESPONSE TIME. "Within 2 hours" — the team's own figure. Measured from when
        // the case was OPENED to the first thing we sent the customer, not to the first thing
        // that happened on the case: an internal note to yourself is not a response.
        frtHours: 2,
        /* HOW LONG IS TOO LONG BETWEEN MESSAGES. Three days is the default because it clears
         * a weekend — a customer who wrote on Friday afternoon and heard back on Monday
         * morning has not been neglected, and a rule that says otherwise flags every case in
         * the queue and is switched off within a week. */
        gapDays: 3,
        /* AND HOW LONG A MEETING HAS TO BE WRITTEN UP IN. The rule the team works to is that
         * a note goes in the call log or a post AFTER EACH MEETING; one working day is the
         * grace this allows before the meeting counts as undocumented. */
        meetingNoteHours: 24,
        // The 30/60/90 management-review milestones, in days. Ordered ascending; the highest
        // one a case has crossed is the one it is reviewed at.
        milestones: [30, 60, 90],
        /* HOW LONG THE CASE MAY SIT WITH THE BALL IN OUR COURT before the run flags it,
         * independently of the gap rule. A case whose newest message is the customer's is
         * waiting on us from that moment, and the wait is still running — so it is measured
         * against now rather than against a following post that does not exist. */
        openWaitDays: 2
    };

    /* ---------------------------------------------------------------------
     * WHAT AN AGENT CAN BE TAUGHT
     * ---------------------------------------------------------------------
     * A CLOSED LIST, and that is the point of it. "Which training does this
     * agent need" answered in free text produces a different phrase every time
     * — "needs to improve troubleshooting", "troubleshooting methodology",
     * "better fault-finding" — and three phrasings of one gap cannot be counted,
     * so the coaching summary can never say "four of Imran's six cases came back
     * with the same finding", which is the only thing that makes the summary
     * worth writing.
     *
     * So the model picks from these and nothing else. The `id` is what gets
     * counted; the `label` is what a human reads; the `covers` line is what the
     * prompt shows the model so it picks the right one rather than the nearest
     * word.
     * ------------------------------------------------------------------- */
    const TRAINING_AREAS = [
        { id: 'troubleshooting', label: 'Troubleshooting methodology',
          covers: 'isolating a fault, forming and testing one hypothesis at a time, asking for the right evidence, not changing three things at once' },
        { id: 'networking', label: 'Networking',
          covers: 'ports, firewalls, proxies, DNS, certificates, TLS, load balancers, connectivity between device, DS and MS' },
        { id: 'product', label: 'Product knowledge',
          covers: 'how MobiControl / Connect / XSight / Snap actually work — console paths, services, agent behaviour, version differences' },
        { id: 'logs', label: 'Log analysis',
          covers: 'finding and reading the right log, correlating timestamps across servers, quoting the error rather than describing it' },
        { id: 'communication', label: 'Customer communication',
          covers: 'clarity, tone, answering what was asked, setting expectations, chasing rather than going quiet, plain language over jargon' },
        { id: 'documentation', label: 'Case documentation',
          covers: 'internal notes, resolution notes, keeping the case readable by whoever picks it up next' },
        { id: 'meetings', label: 'Meeting and call handling',
          covers: 'running a session to an agenda, and writing the note in the call log or a post afterwards' },
        { id: 'escalation', label: 'Escalation and JIRA process',
          covers: 'when to raise a defect, what a good MCMR write-up contains, when to pull in a Team Lead or Development' },
        { id: 'sla', label: 'SLA and time management',
          covers: 'first response inside target, keeping a case moving, not letting a case go quiet, working the queue by entitlement' },
        { id: 'knowledge', label: 'Knowledge base usage',
          covers: 'searching Knowledge before re-solving a solved problem, linking the article on the case, writing one where none exists' },
        { id: 'closure', label: 'Closure process and CSAT',
          covers: 'the recovery-call rules at closure, the resolution summary, the survey, closing a case cleanly rather than letting it lapse' }
    ];

    const TRAINING_BY_ID = new Map(TRAINING_AREAS.map(a => [a.id, a]));

    /* ---------------------------------------------------------------------
     * SMALL FORMATTERS — shared so a duration reads the same everywhere
     * ------------------------------------------------------------------- */
    function fmtDuration(ms) {
        if (ms === null || ms === undefined || !isFinite(ms)) return 'not known';
        if (ms < 0) return 'not known';
        if (ms < 60 * 1000) return 'under a minute';
        const mins = Math.round(ms / 60000);
        if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
        const hours = ms / HOUR;
        if (hours < 48) {
            const h = Math.floor(hours);
            const m = Math.round((hours - h) * 60);
            return m ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
        }
        const days = ms / DAY;
        // One decimal under ten days, whole days after — "12.3 days" is false precision on a
        // figure derived from a feed timestamp that may itself have been "yesterday".
        return days < 10 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`;
    }

    function fmtDateTime(ms) {
        if (!ms) return 'not known';
        try {
            return new Date(ms).toLocaleString(undefined, {
                year: 'numeric', month: 'short', day: '2-digit',
                hour: '2-digit', minute: '2-digit'
            });
        } catch (e) { return 'not known'; }
    }

    function fmtDate(ms) {
        if (!ms) return '';
        try {
            return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
        } catch (e) { return ''; }
    }

    // A number of days out of whatever the case age field happens to hold — "47", "47 days",
    // "1 month 17 days". Anything that does not start with a number is not an age.
    function ageDaysOf(raw) {
        if (raw === null || raw === undefined) return null;
        const n = parseFloat(String(raw).replace(/,/g, '').trim());
        return isNaN(n) ? null : n;
    }

    /* THE MILESTONE A CASE IS AT — the highest one its age has crossed, and nothing else.
     *
     * Derived from the age, deterministically, never guessed and never asked of a model. A
     * case of 61 days is at its 60-day review; it is not "approaching 90". Returns null under
     * the first milestone, which is the ordinary state of most of the queue. */
    function milestoneFor(ageDays, rules) {
        const marks = (rules && rules.milestones) || DEFAULT_RULES.milestones;
        const age = ageDaysOf(ageDays);
        if (age === null) return null;
        let hit = null;
        for (const m of marks) if (age >= m) hit = m;
        return hit;
    }

    /* ---------------------------------------------------------------------
     * THE MEASUREMENT
     * ------------------------------------------------------------------- */

    /* WHEN DID THE CASE START?
     *
     * The Date/Time Opened field when the layout carried one — it is the record's own answer
     * and nothing beats it. Otherwise the oldest dated post, which on a case opened by email
     * IS the opening email. Otherwise, if the age field is all we have, now minus the age:
     * a coarse answer, flagged as `derived`, and better than refusing to measure a first
     * response time on every case whose layout is missing one field. */
    function caseOpenedAt(data, items) {
        if (data && data.qaOpened && data.qaOpened.at) return { at: data.qaOpened.at, from: 'field' };
        const firstDated = items.find(i => i.at);
        if (firstDated) return { at: firstDated.at, from: 'first-post' };
        const age = ageDaysOf(data && data.caseAge);
        if (age !== null) return { at: Date.now() - age * DAY, from: 'age', derived: true };
        return { at: null, from: 'none' };
    }

    /* THE WHOLE MEASUREMENT, in one pass over the feed.
     *
     * Everything here is a fact about timestamps. Nothing here is an opinion, and nothing here
     * asks whether an answer was any GOOD — that is the model's half, and keeping the two
     * apart is what lets a reviewer disagree with the write-up without doubting the numbers.
     */
    function measureCase(data, rules) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        const feed = (data && data.qaFeed) || { items: [], reason: 'no-feed', dated: 0, seen: 0 };
        const items = feed.items || [];
        const dated = items.filter(i => i.at);
        const now = (data && data.qaReadAt) || Date.now();

        const opened = caseOpenedAt(data, dated);
        const out = {
            readable: feed.reason === 'ok' || feed.reason === 'not-attributed',
            feedReason: feed.reason,
            itemsSeen: items.length,
            itemsDated: dated.length,
            itemsUndated: items.length - dated.length,
            openedAt: opened.at,
            openedFrom: opened.from,
            openedDerived: !!opened.derived,
            ageDays: ageDaysOf(data && data.caseAge),
            milestone: milestoneFor(data && data.caseAge, R),
            counts: { email: 0, call: 0, internal: 0, post: 0, fromUs: 0, fromCustomer: 0, unattributed: 0 },
            // First response
            firstResponseAt: null,
            firstResponseMs: null,
            firstResponseBy: '',
            frtMet: null,          // true / false / null = could not be measured
            frtTargetHours: R.frtHours,
            // Silence
            gaps: [],
            worstGapMs: 0,
            openWaitMs: null,      // the ball is with us, right now, and has been this long
            // Chasing
            unansweredCustomerPosts: [],
            customerChases: 0,
            // Meetings
            meetings: [],
            meetingsUndocumented: 0,
            // Response times after the first
            responseTimes: [],
            medianResponseMs: null,
            findings: []           // the measured failures, in plain words, for the prompt and the UI
        };

        for (const i of items) {
            if (out.counts[i.kind] !== undefined) out.counts[i.kind]++;
            if (i.fromUs === true) out.counts.fromUs++;
            else if (i.fromUs === false) out.counts.fromCustomer++;
            else out.counts.unattributed++;
        }

        /* FIRST RESPONSE. From the case opening to the first thing that went OUT to the
         * customer. An internal note is excluded by construction — it never left SOTI, so it
         * cannot be a response to anybody — and so is a call log, which is a record of a
         * conversation rather than a reply to a message. Both still count as ACTIVITY, and
         * both appear in the gap arithmetic below; they are simply not first responses.
         *
         * A case whose feed came back 'not-attributed' — read, dated, and not one post
         * placeable as ours or theirs — gets `frtMet: null` rather than a guess. */
        const outbound = dated.filter(i => i.fromUs === true && !i.internal && i.kind !== 'call');
        const first = outbound.find(i => opened.at === null || i.at >= opened.at - 5 * 60 * 1000);
        if (first && opened.at) {
            out.firstResponseAt = first.at;
            out.firstResponseMs = Math.max(0, first.at - opened.at);
            out.firstResponseBy = first.sender;
            out.frtMet = out.firstResponseMs <= R.frtHours * HOUR;
        } else if (opened.at && !outbound.length && feed.reason === 'ok') {
            /* NOTHING WENT OUT AT ALL, on a feed this build read and understood. That is not
             * an unmeasurable case — it is a failed first response, and the strongest one
             * there is. Only claimed when the feed was actually attributed; on an unreadable
             * feed the same emptiness means nothing. */
            out.frtMet = false;
            out.firstResponseMs = null;
        }

        /* SILENCE. Every consecutive pair of dated posts more than `gapDays` apart, with the
         * side that was holding the case named — because a fortnight during which the
         * CUSTOMER was thinking is not the same finding as a fortnight during which we were.
         *
         * `owedByUs` is tri-state for the same reason `fromUs` is: a gap blamed on the
         * customer because the previous post could not be attributed is the worst output this
         * tool has, so it is left as null and reported as "could not tell". */
        for (let n = 1; n < dated.length; n++) {
            const prev = dated[n - 1];
            const next = dated[n];
            const ms = next.at - prev.at;
            if (ms <= R.gapDays * DAY) continue;
            const gap = {
                fromAt: prev.at, toAt: next.at, ms,
                afterWhom: prev.sender,
                owedByUs: prev.fromUs === null ? null : prev.fromUs === false,
                brokenBy: next.sender,
                brokenByUs: next.fromUs
            };
            out.gaps.push(gap);
            if (ms > out.worstGapMs) out.worstGapMs = ms;
        }

        /* THE GAP THAT IS STILL RUNNING. The loop above can only see silence BETWEEN two
         * posts, so a case whose newest message is the customer's — the single most common
         * shape of a neglected case — produces no gap at all: there is no next post to
         * measure to. Measured against the moment the case was read instead. */
        const newest = dated[dated.length - 1];
        if (newest && newest.fromUs === false) {
            const waiting = now - newest.at;
            if (waiting > R.openWaitDays * DAY) out.openWaitMs = waiting;
        }

        /* CUSTOMER POSTS NOBODY ANSWERED, and how many times they had to ask again. A "chase"
         * is a customer post that follows another customer post with nothing from us in
         * between — which is the customer doing our follow-up for us. */
        let lastWasCustomer = false;
        for (const i of dated) {
            if (i.fromUs === false) {
                if (lastWasCustomer) out.customerChases++;
                lastWasCustomer = true;
            } else if (i.fromUs === true) {
                lastWasCustomer = false;
            }
        }
        for (let n = 0; n < dated.length; n++) {
            const i = dated[n];
            if (i.fromUs !== false) continue;
            const answered = dated.slice(n + 1).some(j => j.fromUs === true && !j.internal);
            if (!answered) out.unansweredCustomerPosts.push({ at: i.at, sender: i.sender });
        }

        /* RESPONSE TIMES AFTER THE FIRST — every customer post to the next thing we sent.
         * The median rather than the mean, because one case that sat over Christmas moves a
         * mean by a week and says nothing about how the agent normally works. */
        for (let n = 0; n < dated.length; n++) {
            const i = dated[n];
            if (i.fromUs !== false) continue;
            const reply = dated.slice(n + 1).find(j => j.fromUs === true && !j.internal);
            if (reply) out.responseTimes.push(reply.at - i.at);
        }
        if (out.responseTimes.length) {
            const sorted = out.responseTimes.slice().sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            out.medianResponseMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
        }

        /* MEETINGS, AND WHETHER THEY WERE WRITTEN UP.
         *
         * A logged call IS its own note — that is what the call log is for — so it is
         * documented by construction. Everything else that mentions a session has to be
         * followed, inside the grace period, by something that reads as a write-up: another
         * call log, or a post in the past tense about what happened.
         *
         * MEETINGS ARE COUNTED ONCE. A WebEx arranged in an email, confirmed in a reply and
         * mentioned again in the note afterwards is one meeting, not three, and counting the
         * mentions would report two undocumented meetings on a case that was written up
         * perfectly. So consecutive mentions inside the grace window collapse into the first
         * of them, and a mention that is ITSELF a write-up ("as discussed on the call") is
         * not treated as a new meeting to chase. */
        const grace = R.meetingNoteHours * HOUR;
        let lastMeetingAt = null;
        for (let n = 0; n < dated.length; n++) {
            const i = dated[n];
            const isCall = i.kind === 'call';
            if (!isCall && !i.mentionsMeeting) continue;
            // A note about a meeting is not another meeting.
            if (!isCall && i.readsAsMeetingNote && lastMeetingAt !== null && (i.at - lastMeetingAt) <= grace) continue;
            if (lastMeetingAt !== null && (i.at - lastMeetingAt) <= grace) continue;
            lastMeetingAt = i.at;

            const documented = isCall || dated.slice(n + 1).some(j =>
                j.at - i.at >= 0 && j.at - i.at <= grace && j.readsAsMeetingNote);
            const meeting = {
                at: i.at, sender: i.sender, kind: i.kind, documented,
                how: isCall ? 'call log' : documented ? 'note written afterwards' : ''
            };
            out.meetings.push(meeting);
            if (!documented) out.meetingsUndocumented++;
        }

        /* ---------------------------------------------------------------
         * THE FINDINGS, IN PLAIN WORDS
         * ---------------------------------------------------------------
         * One list, written once, read twice: it goes into the prompt as the
         * measured facts the model may not contradict, and onto the screen as
         * what the run found. Two copies of this would drift, and the day they
         * drifted the panel would be showing a reviewer something different
         * from what the write-up was based on.
         * ------------------------------------------------------------- */
        const F = (severity, code, text) => out.findings.push({ severity, code, text });

        if (feed.reason === 'no-feed' || feed.reason === 'no-items') {
            F('warn', 'no-feed', 'No feed posts could be read on this case, so nothing below could be measured. The case may genuinely be empty, or the page may not have finished loading.');
        } else if (feed.reason === 'no-dates') {
            F('warn', 'no-dates', `${items.length} post(s) were read but none carried a timestamp this tool could parse, so no timing could be measured.`);
        } else if (feed.reason === 'not-attributed') {
            F('warn', 'not-attributed', 'The posts were read and dated, but none could be placed as ours or the customer\'s — so response times and gaps are not reported for this case.');
        }
        if (out.itemsUndated > 0 && out.itemsDated > 0) {
            F('info', 'partial-dates', `${out.itemsUndated} of ${items.length} posts carried no readable timestamp and were left out of the timing.`);
        }
        if (out.openedDerived) {
            F('info', 'derived-open', 'The case has no readable Date/Time Opened, so the first response time is measured from the case age and is approximate.');
        }

        if (out.frtMet === false && out.firstResponseMs !== null) {
            F('fail', 'frt', `First response took ${fmtDuration(out.firstResponseMs)} — over the ${R.frtHours}-hour target.`);
        } else if (out.frtMet === false) {
            F('fail', 'frt-none', 'Nothing was sent to the customer on this case at all — there is no first response.');
        } else if (out.frtMet === true) {
            F('pass', 'frt', `First response in ${fmtDuration(out.firstResponseMs)}, inside the ${R.frtHours}-hour target.`);
        }

        for (const g of out.gaps) {
            const who = g.owedByUs === true ? 'with us'
                : g.owedByUs === false ? 'with the customer'
                : 'with a side this tool could not identify';
            F(g.owedByUs === true ? 'fail' : 'info', 'gap',
                `${fmtDuration(g.ms)} of silence from ${fmtDateTime(g.fromAt)} to ${fmtDateTime(g.toAt)}, ${who} — last post before it was ${g.afterWhom}'s.`);
        }
        if (out.openWaitMs !== null) {
            F('fail', 'open-wait', `The newest message on the case is the customer's, ${fmtDuration(out.openWaitMs)} ago — it is still waiting on us.`);
        }
        if (out.customerChases > 0) {
            F('fail', 'chase', `The customer wrote again without a reply in between ${out.customerChases} time${out.customerChases === 1 ? '' : 's'}.`);
        }
        for (const m of out.meetings) {
            if (m.documented) {
                F('pass', 'meeting', `Meeting on ${fmtDateTime(m.at)} was written up (${m.how}).`);
            } else {
                F('fail', 'meeting-note', `A meeting or session around ${fmtDateTime(m.at)} has no call log or post written up within ${R.meetingNoteHours} hours.`);
            }
        }
        if (!out.meetings.length && out.itemsDated) {
            F('info', 'no-meetings', 'No meetings or calls were found on this case.');
        }
        if (out.milestone) {
            F('info', 'milestone', `The case is ${Math.round(out.ageDays)} days old — it is at its ${out.milestone}-day review.`);
        }

        return out;
    }

    /* ---------------------------------------------------------------------
     * THE TRANSCRIPT THE MODEL READS
     * ---------------------------------------------------------------------
     * OLDEST FIRST, because a QA review is a story about how a case was handled
     * over time and reading it backwards is how "the agent never followed up"
     * gets written about a case whose follow-up is at the top of the page.
     *
     * Every line carries its absolute date, its direction and its kind, so the
     * model never has to work out who wrote what — and so it cannot get it
     * wrong. Bodies are trimmed per post rather than the whole transcript being
     * cut at the end: losing the last third of a case is losing the resolution,
     * which is the part QA cares about most.
     * ------------------------------------------------------------------- */
    function buildTranscript(data, opts = {}) {
        const perPost = opts.perPost || 2500;
        const maxChars = opts.maxChars || 120000;
        const items = ((data && data.qaFeed && data.qaFeed.items) || []);
        const lines = [];
        let used = 0;
        let dropped = 0;

        for (const i of items) {
            const who = i.fromUs === true ? 'SOTI' : i.fromUs === false ? 'CUSTOMER' : 'UNKNOWN SIDE';
            const kind = i.kind === 'call' ? 'CALL LOG'
                : i.internal ? 'INTERNAL NOTE'
                : i.kind === 'email' ? 'EMAIL' : 'POST';
            const when = i.at ? fmtDateTime(i.at) : (i.label ? `${i.label} (no absolute date)` : 'date not known');
            let body = String(i.body || '').replace(/\n{3,}/g, '\n\n').trim();
            if (body.length > perPost) body = body.slice(0, perPost) + `\n… [${body.length - perPost} more characters of this post not shown]`;

            let block = `[${when}] [${kind}] [${who}] ${i.sender}:\n${body}`;
            for (const r of (i.replies || [])) {
                const rWhen = r.at ? fmtDateTime(r.at) : (r.label || 'date not known');
                let rBody = String(r.body || '').trim();
                if (rBody.length > perPost) rBody = rBody.slice(0, perPost) + '…';
                block += `\n    -> [${rWhen}] [REPLY] ${r.author}: ${rBody}`;
            }

            if (used + block.length > maxChars) { dropped++; continue; }
            used += block.length + 4;
            lines.push(block);
        }

        let text = lines.join('\n\n' + '-'.repeat(30) + '\n\n');
        if (dropped) {
            text += `\n\n[${dropped} further post(s) were not included — this case is longer than one request can carry.]`;
        }
        return text;
    }

    // The measured facts, written for the prompt. Stated as GIVENS the model may not
    // recompute, because everything in here is arithmetic it would do worse.
    function measurementBlock(m, R) {
        const L = [];
        L.push('[MEASURED FACTS — these are computed from the case timestamps. Treat every line as true. Do NOT recalculate any of them, and do NOT contradict them.]');
        L.push(`Case opened: ${fmtDateTime(m.openedAt)}${m.openedDerived ? ' (approximate — derived from the case age)' : ''}`);
        if (m.ageDays !== null) L.push(`Case age: ${Math.round(m.ageDays)} days${m.milestone ? ` — at its ${m.milestone}-day review milestone` : ''}`);
        L.push(`Feed read: ${m.itemsSeen} post(s), ${m.itemsDated} with a usable timestamp${m.itemsUndated ? `, ${m.itemsUndated} without` : ''}.`);
        L.push(`Message mix: ${m.counts.email} email(s), ${m.counts.call} call log(s), ${m.counts.internal} internal note(s), ${m.counts.post} post(s). ${m.counts.fromUs} from SOTI, ${m.counts.fromCustomer} from the customer${m.counts.unattributed ? `, ${m.counts.unattributed} could not be attributed` : ''}.`);

        if (m.frtMet === true) L.push(`FIRST RESPONSE: MET — ${fmtDuration(m.firstResponseMs)} (target ${R.frtHours} hours), sent by ${m.firstResponseBy || 'an agent'}.`);
        else if (m.frtMet === false && m.firstResponseMs !== null) L.push(`FIRST RESPONSE: MISSED — ${fmtDuration(m.firstResponseMs)} against a ${R.frtHours}-hour target, sent by ${m.firstResponseBy || 'an agent'}.`);
        else if (m.frtMet === false) L.push('FIRST RESPONSE: MISSED — nothing was ever sent to the customer on this case.');
        else L.push('FIRST RESPONSE: could not be measured on this case. Say so; do not estimate it.');

        if (m.gaps.length) {
            L.push(`SILENCE GAPS over ${R.gapDays} days: ${m.gaps.length}.`);
            for (const g of m.gaps.slice(0, 12)) {
                const who = g.owedByUs === true ? 'the case was waiting on SOTI'
                    : g.owedByUs === false ? 'the case was waiting on the customer'
                    : 'which side was holding it could not be determined';
                L.push(`  - ${fmtDuration(g.ms)} from ${fmtDateTime(g.fromAt)} to ${fmtDateTime(g.toAt)}; ${who}.`);
            }
            if (m.gaps.length > 12) L.push(`  - …and ${m.gaps.length - 12} more.`);
        } else {
            L.push(`SILENCE GAPS over ${R.gapDays} days: none.`);
        }
        if (m.openWaitMs !== null) L.push(`STILL WAITING ON US: the newest message is the customer's, ${fmtDuration(m.openWaitMs)} ago, with no reply.`);
        if (m.customerChases) L.push(`CUSTOMER CHASED: they wrote again with no reply in between ${m.customerChases} time(s).`);
        if (m.medianResponseMs !== null) L.push(`TYPICAL REPLY TIME after the first response: ${fmtDuration(m.medianResponseMs)} (median of ${m.responseTimes.length}).`);

        if (m.meetings.length) {
            L.push(`MEETINGS / CALLS: ${m.meetings.length}, of which ${m.meetingsUndocumented} have NO note written up within ${R.meetingNoteHours} hours.`);
            for (const mt of m.meetings.slice(0, 12)) {
                L.push(`  - ${fmtDateTime(mt.at)} (${mt.sender}): ${mt.documented ? `written up — ${mt.how}` : 'NO MEETING NOTE FOUND'}`);
            }
        } else {
            L.push('MEETINGS / CALLS: none found on this case.');
        }
        if (!m.readable) {
            L.push('WARNING: this case\'s feed could not be fully read or attributed. Do not report timing findings as certain — say what could not be established.');
        }
        return L.join('\n');
    }

    // The one place the training list is written out for a model. Kept here so the prompt and
    // the parser can never disagree about what the valid answers are.
    function trainingBlock() {
        return '[TRAINING AREAS — pick ONLY from this list, by its exact label. Pick the one to three that this case actually shows evidence for, most important first. If the case shows no training need, write "None".]\n'
            + TRAINING_AREAS.map(a => `- ${a.label}: ${a.covers}`).join('\n');
    }

    /* WHAT THE CASE IS, in the words the record itself uses.
     *
     * One function rather than a copy in each prompt: the QA review, the 30/60/90 and the
     * per-case chat all have to describe the same case, and three copies of this list is
     * three chances for one of them to be describing a slightly different one. The chat is
     * the reason it is exported — it needs the same block long after the scrape is gone.
     */
    function caseFactsBlock(caseRec, data) {
        const pick = (a, b) => (a || b || '');
        const product = (data && data.product) || '';
        const version = (data && data.currentVersion) || '';
        return [
            `Case number: ${pick(data && data.caseNumber, caseRec && caseRec.caseNum) || 'not known'}`,
            `Subject: ${pick(data && data.subject, caseRec && caseRec.subject) || 'not known'}`,
            `Account: ${pick(data && data.accountName, caseRec && caseRec.account) || 'not known'}`,
            `Status: ${pick(data && data.caseStatus, caseRec && caseRec.status) || 'not known'}`,
            `Case owner: ${pick(data && data.caseOwner, caseRec && caseRec.owner) || 'not known'}`,
            pick(data && data.lastModifiedBy, caseRec && caseRec.lastModifiedBy)
                ? `Last modified by: ${pick(data && data.lastModifiedBy, caseRec && caseRec.lastModifiedBy)}` : '',
            product ? `Product: ${product}${version ? ` ${version}` : ''}` : '',
            pick(data && data.jiraNumber, caseRec && caseRec.jira)
                ? `JIRA raised on this case: ${pick(data && data.jiraNumber, caseRec && caseRec.jira)}`
                : 'JIRA raised on this case: none recorded',
            (data && data.escalated) ? `Escalated: ${data.escalated}` : '',
            (data && data.npsScores && data.npsScores.length)
                ? `NPS on the record: ${data.npsScores.map(n => `${n.label}: ${n.value}`).join('; ')}` : ''
        ].filter(Boolean).join('\n');
    }

    /* ---------------------------------------------------------------------
     * THE QA PROMPT
     * ---------------------------------------------------------------------
     * The output is the QA SHEET, header for header, so a run can be pasted
     * straight into the spreadsheet the team already keeps. The headers are
     * therefore not decoration — they are the schema, and parseQaAnswer below
     * reads them back by name.
     * ------------------------------------------------------------------- */
    function buildQaPrompt(caseRec, data, m, rules, sheetColumns) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        const caseNo = (data && data.caseNumber) || (caseRec && caseRec.caseNum) || '';
        const today = fmtDate(Date.now());

        const facts = caseFactsBlock(caseRec, data);
        const description = String((data && data.description) || (caseRec && caseRec.description) || '').trim();
        const transcript = buildTranscript(data);

        return `You are auditing ONE support case for the SOTI Support QA review. You are a QA reviewer, not the agent: your job is to judge how the case was HANDLED, not to solve the customer's problem.

Fill in EXACTLY the headers below, in this order, one per line, and output nothing before or after them. Each header is a column of the team's QA sheet.

RULES:
- Ground every statement ONLY in the case material below. Never invent a date, a version, an article number, a JIRA code or a name. If something is not in the material, say "Not evident from the case".
- The [MEASURED FACTS] block is arithmetic already done for you. Quote it, never recompute it, and never contradict it. If it says the first response was missed, it was missed.
- The transcript is OLDEST FIRST. The end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER. Anyone writing on behalf of SOTI Support is the AGENT. Never swap these roles.
- Judge the AGENT'S work, not the customer's. A difficult customer is not a finding against the agent; how the agent handled them is.
- Be specific and quote. "Poor communication" is worthless to the agent being coached; "the 12 March reply answered the licensing question but ignored the enrolment error the customer asked about twice" is coachable.
- Be fair. Say what was done WELL as readily as what was not — a review with an empty Positive(s) line on a competently handled case is a bad review.
- Write plain text. No markdown, no ** or ##, no bullets other than "- ", no emoji, no preamble.

HEADERS TO FILL:
Case Number: ${caseNo || 'read it from the case facts'}
Date Reviewed: ${today}
Closure Check: whether the case was closed correctly — was a resolution given and agreed, was the closure process followed for this case's status, and if it is still open, is it being progressed or is it drifting. If the case is not closed, say what state it is in and whether that is reasonable for its age. One or two sentences.
Internal Resolution Note Quality: judge the internal notes and the resolution write-up — could another engineer pick this case up cold and know what was tried, what was found, and why it was closed. Quote or name the note you are judging. If there is no internal note at all, say so plainly. One to three sentences.
Case Handling Notes: the narrative of how the case was worked — first response, the pace of it, whether the agent drove the case or waited, whether meetings were held and written up, whether the troubleshooting had a method to it. Reference the measured facts by their numbers. Three to six sentences.
JIRA / Other Agent Follow-up: whether a defect should have been raised and was not, whether an existing JIRA was chased, and whether anything needs another agent, a Team Lead or Development to pick up. Name the JIRA only if it appears in the case material. If nothing is needed, write "None needed".
KB Articles: whether Knowledge was used or should have been — was an existing article linked to the customer, and does this case's resolution warrant writing one. Name an article number ONLY if it appears in the case material; otherwise describe the article that should exist. If neither applies, write "None applicable".
Positive(s): what the agent did well, specifically. "- " bullets, one to three. If genuinely nothing, write "None identified" — but look first.
Improvement Point(s): what the agent should do differently, specifically and actionably. "- " bullets, one to four. If genuinely nothing, write "None identified".
Final Comment: one or two sentences a Team Lead could read on its own and know how this case went.
QA Score: a whole number out of 100 for how well this case was handled, then a slash and one word — Excellent (85-100), Good (70-84), Needs work (50-69), or Poor (under 50). Example: "72/Good". Base it on the measured facts and your reading, and be consistent: a missed first response, an undocumented meeting and a customer left chasing cannot score above 60.
Main Pattern: ONE short phrase — five to ten words — naming the single most important behaviour this case shows about the agent. This is what carries into their coaching record, so it must be a pattern ("closes cases without a resolution note"), not an event ("did not reply on 3 March").
Training Needed: the training areas from the list below, by their exact labels, separated by "; ", most important first. At most three. "None" if the case shows no training need.
Coaching Pointer: one sentence in the second person, telling the agent exactly what to do differently next time. It must be something they can act on tomorrow.

${trainingBlock()}

[CASE FACTS]
${facts}

${measurementBlock(m, R)}

${description ? `[CASE DESCRIPTION AS REPORTED]\n${description.slice(0, 6000)}\n\n` : ''}[CASE TRANSCRIPT — OLDEST FIRST]
${transcript || '(No feed posts could be read for this case.)'}`;
    }

    /* THE 30/60/90 PROMPT — the management-review write-up for an aging case.
     *
     * A different document with a different reader: QA is about how the agent worked; this is
     * about what happens to the case next, and it is read by management. The milestone and the
     * date are computed here and stated as hard facts, because a management-review document
     * whose first line is blank — which is what happens when the model is left to fill in its
     * own milestone — is worse than no document. */
    function build306090Prompt(caseRec, data, m, rules) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        const milestone = m.milestone ? `${m.milestone}-day` : 'under 30 days';
        const age = m.ageDays !== null ? Math.round(m.ageDays) : null;
        const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const caseNo = (data && data.caseNumber) || (caseRec && caseRec.caseNum) || '';
        const jira = (data && data.jiraNumber) || (caseRec && caseRec.jira) || '';
        const transcript = buildTranscript(data, { perPost: 2000, maxChars: 100000 });

        return `Produce a 30/60/90 case analysis for management review of this aging support case. Use EXACTLY the template layout below — same headers, same order — and output nothing before or after it.

RULES:
- Ground EVERY statement ONLY in the case material below. Never invent facts, versions, dates or links. If something decisive is unknown, say so in a short phrase.
- The transcript is OLDEST FIRST; the end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER; anyone writing for SOTI Support is a SUPPORT ENGINEER. Never swap these roles.
- "30/60/90:" MUST be "${milestone}"${age !== null ? ` (the case is ${age} days old)` : ''}.
- "Date of Update:" MUST be ${today}.
- Quote a JIRA / MCMR code ONLY if it already appears on this case${jira ? ` (this case carries ${jira})` : ' (this case carries none)'}. Never any other code.
- Every next step must name the exact thing it acts on — a log file and the server it comes from, a service, a console path, a port, an error string. Steps with no content in them ("verify the configuration", "check the logs", "monitor for stability") are FORBIDDEN.
- Plain text only. No markdown symbols, no emoji, no preamble.

TEMPLATE (fill in after each header):
30/60/90:
Date of Update:
Case Summary: 2-4 sentences — the customer and account, the product and versions, the environment, what was reported, and where the case stands right now.
Next steps: "- " bullets — the concrete actions still to do to move this case forward, each naming the artefact it acts on and who collects it.
Research Links: real URLs that appear in the case material, or "None".
30/60/90 JIRA Justification: 1-3 sentences on whether this aged case warrants a JIRA or development escalation at this milestone, referencing the case age, the business impact, and whether a product defect is suspected.

${measurementBlock(m, R)}

[CASE FACTS]
${caseFactsBlock(caseRec, data)}

[CASE TRANSCRIPT — OLDEST FIRST]
${transcript || '(No feed posts could be read for this case.)'}`;
    }

    /* ---------------------------------------------------------------------
     * THE PER-CASE CHAT
     * ---------------------------------------------------------------------
     * A review answers the questions the sheet asks and then stops. The next
     * question is always the same one — "why?", "show me where", "what should
     * they actually have done" — and that is what this is for.
     *
     * It is grounded in EXACTLY what the review was grounded in: the same facts,
     * the same measured block, the same transcript, plus the review itself when
     * one exists. So the chat can be asked to justify the review against the
     * case, and a reviewer who disagrees is disagreeing with something checkable
     * rather than with a second, differently-informed opinion.
     *
     * `ctx` is the stored case context (see the panel's saveContext) rather than
     * a live scrape, because a chat happens days after the run.
     * ------------------------------------------------------------------- */
    function buildChatSystem(ctx, review) {
        const parts = [];
        parts.push(`You are helping a QA reviewer at SOTI Support discuss ONE support case they are auditing. You are talking to the REVIEWER, not to the agent and not to the customer.

RULES:
- Answer ONLY from the case material below. If the material does not settle a question, say so plainly — "the case does not say" is a good answer and a guess is not.
- Never invent a date, a version, an article number, a JIRA code, a name or a quote.
- Quote and cite. When you make a claim about what happened, name the date and who wrote it, so the reviewer can go and look.
- The [MEASURED FACTS] block is arithmetic already done from the case timestamps. Treat it as true, never recompute it, and never contradict it.
- The transcript is OLDEST FIRST. The end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER. Anyone writing for SOTI Support is the AGENT. Never swap these roles.
- You are judging the AGENT's handling, not the customer's behaviour.
- Be direct and brief. The reviewer is working through a queue: answer the question asked, in as few words as it takes, and stop.
- Plain text and short "- " bullets. No markdown headings, no emoji.`);

        parts.push(`[CASE FACTS]\n${ctx.facts || '(not recorded)'}`);
        if (ctx.measured) parts.push(ctx.measured);

        if (review && review.raw && !review.error) {
            parts.push(`[THE QA REVIEW ALREADY WRITTEN FOR THIS CASE]
This is what was written when the case was reviewed. The reviewer may want to challenge it — if the case material does not support a line in it, SAY SO rather than defending it.

${review.raw}`);
        } else {
            parts.push('[THE QA REVIEW ALREADY WRITTEN FOR THIS CASE]\nNone — this case has not been reviewed yet, or its write-up failed.');
        }

        parts.push(`[CASE TRANSCRIPT — OLDEST FIRST]\n${ctx.transcript || '(No feed posts were read for this case.)'}`);
        return parts.join('\n\n');
    }

    /* THE QUESTIONS A REVIEWER ACTUALLY ASKS NEXT, offered as one-press chips.
     *
     * They are not decoration: an empty chat with a blinking cursor is a chat most people
     * close, and the useful questions here are not obvious until you have asked them once.
     * The list changes with what was MEASURED, so a case with an undocumented meeting offers
     * the meeting question and a case without it does not — a chip that leads to "there were
     * no meetings on this case" has wasted a round trip and some of the reviewer's patience.
     */
    function chatSuggestions(metrics, review) {
        const out = [];
        if (review && review.raw && !review.error) {
            out.push('Justify the score against the case — which specific messages support it?');
        }
        out.push('Give me the timeline: who wrote what, when, and which side was waiting.');
        if (metrics) {
            if (metrics.frtMet === false) out.push('What happened between the case opening and our first reply?');
            if ((metrics.gaps || []).some(g => g.owedByUs) || metrics.openWaitMs) {
                out.push('Walk me through the longest silence — what was outstanding at the time?');
            }
            if (metrics.meetingsUndocumented) out.push('Which meeting was never written up, and what did we lose by that?');
            if (metrics.customerChases) out.push('Quote the messages where the customer had to chase.');
        }
        out.push('What exactly should the agent have done differently, in order?');
        out.push('Draft a short coaching note I can send this agent about this case.');
        out.push('Was anything technical missed — a log, a version, a known defect?');
        return out.slice(0, 6);
    }

    /* THE COACHING SUMMARY — one row per agent, out of that agent's reviewed cases.
     *
     * Written from the QA records rather than from the cases, deliberately: coaching is about
     * the PATTERN across an agent's work, and a summary derived from the cases again would be
     * a second, weaker QA pass that could disagree with the first. The reviews are the input;
     * the job here is to find what repeats in them. */
    function buildCoachingPrompt(agent, records) {
        const lines = records.map((r, n) => {
            const f = r.fields || {};
            const met = r.metrics || {};
            const flags = [];
            if (met.frtMet === false) flags.push('first response missed');
            if (met.meetingsUndocumented) flags.push(`${met.meetingsUndocumented} meeting(s) not written up`);
            if ((met.gaps || []).some(g => g.owedByUs)) flags.push('silence while the case was with us');
            if (met.customerChases) flags.push(`customer chased ${met.customerChases}x`);
            return [
                `CASE ${n + 1} — ${r.caseNum || 'unknown'} (${f['QA Score'] || 'no score'})`,
                flags.length ? `  Measured: ${flags.join('; ')}` : '  Measured: nothing flagged',
                `  Pattern: ${f['Main Pattern'] || '—'}`,
                `  Training: ${f['Training Needed'] || '—'}`,
                `  Improvements: ${(f['Improvement Point(s)'] || '—').replace(/\n/g, ' ')}`,
                `  Positives: ${(f['Positive(s)'] || '—').replace(/\n/g, ' ')}`
            ].join('\n');
        }).join('\n\n');

        return `You are writing the monthly coaching summary row for ONE support agent, from the QA reviews of their cases below.

Fill in EXACTLY these headers, one per line, and output nothing before or after them.

RULES:
- Base everything ONLY on the reviews below. Do not invent a case, a date or a behaviour.
- You are looking for what REPEATS. One case with a late reply is an incident; the same finding in three of five cases is a pattern, and only a pattern belongs in a coaching row.
- If the reviews genuinely show no repeated problem, say so — a fabricated development area wastes a coaching conversation and costs the agent's trust in this process.
- The SMART goal must be Specific, Measurable, Achievable, Relevant and Time-bound, and it must be about something this agent controls. "Improve communication" is not a goal. "Send a written summary in the call log within 4 hours of every customer meeting, for all cases in October" is.
- Plain text. No markdown, no emoji, no preamble.

HEADERS TO FILL:
Agent: ${agent}
Main Pattern Observed: the one behaviour that shows up most across these cases, in one or two sentences, with the number of cases it appears in.
Coaching Pointer / SMART Goal: one measurable goal for the next month, in one or two sentences.
Due Date: a sensible review date for that goal, one month from today, as a date only.
Notes: anything the Team Lead should know before the conversation — including what this agent is doing well, which must not be left out.

[REVIEWS OF ${records.length} CASE(S) HANDLED BY ${agent}]
${lines}`;
    }

    /* ---------------------------------------------------------------------
     * READING THE ANSWER BACK
     * ---------------------------------------------------------------------
     * The prompt names its headers and the sheet is built from them, so parsing
     * is "find each header, take everything up to the next one".
     *
     * IT MUST NOT BE A LINE-BY-LINE MATCH. Half these fields are multi-line by
     * design — Positive(s) is a list of bullets — so a parser that stops at the
     * first newline silently keeps one bullet in three. The next KNOWN header is
     * the terminator, and only a known header: a model that writes "Note:" in
     * the middle of a paragraph must not be able to truncate the field.
     * ------------------------------------------------------------------- */
    const QA_FIELDS = [
        'Case Number', 'Date Reviewed', 'Closure Check', 'Internal Resolution Note Quality',
        'Case Handling Notes', 'JIRA / Other Agent Follow-up', 'KB Articles',
        'Positive(s)', 'Improvement Point(s)', 'Final Comment',
        'QA Score', 'Main Pattern', 'Training Needed', 'Coaching Pointer'
    ];

    const COACHING_FIELDS = [
        'Agent', 'Main Pattern Observed', 'Coaching Pointer / SMART Goal', 'Due Date', 'Notes'
    ];

    // Escape a header for use inside a RegExp — "JIRA / Other Agent Follow-up" and
    // "Positive(s)" both carry characters a regex would otherwise read as syntax, and the
    // parentheses in particular would turn the header into a capture group that matches
    // nothing.
    function reEscape(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    }

    function parseLabelled(text, fields) {
        const src = String(text || '').replace(/\r\n/g, '\n');
        const out = {};
        // Where each header starts. Anchored to the start of a line and tolerant of the
        // leading "**" a model sometimes adds despite being told not to.
        const marks = [];
        for (const f of fields) {
            const re = new RegExp(`^[ \\t]*(?:\\*\\*|##+[ \\t]*)?${reEscape(f)}[ \\t]*:[ \\t]*`, 'im');
            const m = src.match(re);
            if (m && m.index !== undefined) marks.push({ field: f, start: m.index, end: m.index + m[0].length });
        }
        marks.sort((a, b) => a.start - b.start);
        for (let n = 0; n < marks.length; n++) {
            const here = marks[n];
            const next = marks[n + 1];
            let value = src.slice(here.end, next ? next.start : src.length);
            value = value.replace(/\*\*/g, '').replace(/[ \t]+$/gm, '').trim();
            out[here.field] = value;
        }
        for (const f of fields) if (!(f in out)) out[f] = '';
        return out;
    }

    function parseQaAnswer(text) {
        const fields = parseLabelled(text, QA_FIELDS);
        return { fields, raw: String(text || ''), training: parseTraining(fields['Training Needed']), score: parseScore(fields['QA Score']) };
    }

    function parseCoachingAnswer(text) {
        return { fields: parseLabelled(text, COACHING_FIELDS), raw: String(text || '') };
    }

    /* MATCH THE MODEL'S TRAINING WORDS BACK TO THE LIST IT WAS GIVEN.
     *
     * Told to use exact labels, it mostly does — and "mostly" is the problem, because a
     * near-miss ("Networking skills") counted as its own category is exactly the drift the
     * closed list exists to prevent. So the match is on the label OR the id, case-insensitively,
     * and a substring either way. Anything that still matches nothing is KEPT, under
     * `unmatched`, rather than dropped: a training need the tool cannot categorise is still a
     * training need, and silently losing it would make the coaching sheet quietly wrong. */
    function parseTraining(raw) {
        const text = String(raw || '').trim();
        if (!text || /^none\b/i.test(text)) return { ids: [], labels: [], unmatched: [] };
        const parts = text.split(/[;,\n]|\s+\/\s+/).map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
        const ids = [];
        const labels = [];
        const unmatched = [];
        for (const p of parts) {
            const low = p.toLowerCase();
            const hit = TRAINING_AREAS.find(a =>
                low === a.label.toLowerCase() || low === a.id ||
                low.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(low));
            if (hit) {
                if (!ids.includes(hit.id)) { ids.push(hit.id); labels.push(hit.label); }
            } else if (p.length > 2 && !/^none$/i.test(p)) {
                unmatched.push(p);
            }
        }
        return { ids, labels, unmatched };
    }

    // "72/Good" — the number is what gets averaged, the word is what gets read. A missing or
    // unparseable score is null rather than zero: an average that silently counts a failed
    // parse as nought is an average that defames somebody.
    function parseScore(raw) {
        const text = String(raw || '');
        const num = text.match(/\b(\d{1,3})\b/);
        const n = num ? Math.min(100, Math.max(0, parseInt(num[1], 10))) : null;
        let band = (text.split('/')[1] || '').trim();
        if (!band && n !== null) band = n >= 85 ? 'Excellent' : n >= 70 ? 'Good' : n >= 50 ? 'Needs work' : 'Poor';
        return { value: n, band };
    }

    /* ---------------------------------------------------------------------
     * CSV — for the spreadsheet the team already keeps
     * ---------------------------------------------------------------------
     * The BOM is not decoration. Without it Excel on Windows opens a UTF-8 CSV
     * as the system codepage, and every accented customer name in the notes
     * arrives mangled — which is how a QA export gets quietly retyped by hand.
     * CRLF for the same reason: it is what Excel writes, so it is what round
     * trips.
     * ------------------------------------------------------------------- */
    function csvCell(v) {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function toCsv(headers, rows) {
        const lines = [headers.map(csvCell).join(',')];
        for (const r of rows) lines.push(headers.map(h => csvCell(r[h])).join(','));
        return '﻿' + lines.join('\r\n') + '\r\n';
    }

    window.QaEngine = {
        DEFAULT_RULES,
        TRAINING_AREAS,
        TRAINING_BY_ID,
        QA_FIELDS,
        COACHING_FIELDS,
        HOUR, DAY,
        fmtDuration, fmtDateTime, fmtDate,
        ageDaysOf, milestoneFor,
        measureCase,
        buildTranscript,
        measurementBlock,
        caseFactsBlock,
        buildChatSystem,
        chatSuggestions,
        buildQaPrompt,
        build306090Prompt,
        buildCoachingPrompt,
        parseQaAnswer,
        parseCoachingAnswer,
        parseTraining,
        parseScore,
        toCsv
    };
})();
