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
        /* FIRST RESPONSE TIME. "Within 2 hours" — the team's own figure. Measured from when
         * the case was TRANSFERRED TO ITS OWNER to the first thing we sent the customer; not
         * to the first thing that happened on the case, because an internal note to yourself
         * is not a response, and not from when the case was opened, because the hours a case
         * spent in a queue before anybody was given it are not the owner's silence. See
         * ownerAssignedAt below for what starts the clock and what it falls back to. */
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
        openWaitDays: 2,
        /* SEND THE CASE, NOT THE PEOPLE IN IT. On by default, for two reasons that
         * happen to point the same way. The first is that M365 Copilot refuses outright
         * to assess an identifiable employee, and a QA review that names the agent is
         * exactly that — the refusals came back looking like successful answers and
         * filled the sheet with blank rows. The second is that a support case carries
         * the customer's name and address as well as the agent's, and none of it needs
         * to leave the browser for the case to be audited. See buildAliases. */
        deident: true
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

    /* WHEN THE CASE BECAME THIS ENGINEER'S — and therefore when their two hours start.
     *
     * The team measures first response from the TRANSFER, not from the opening: a case is
     * raised into a queue, sits there until somebody is given it, and the clock the reviewer
     * is checking begins at the handover. Measuring from the opening turns "answered within
     * two hours of picking it up" into "thirteen days late" on the record of an engineer who
     * did nothing wrong, which is the single most damaging number this tool can print.
     *
     * WHICH TRANSFER, when a case has been passed around more than once: the FIRST one that
     * handed it to the engineer who owns it now. That is the moment they became answerable
     * for it. A case reassigned away and back is measured from the first time it was theirs,
     * which is the harsher of the two readings and the one the team asked for.
     *
     * If no transfer names the current owner — an owner set at creation, a feed too long to
     * have kept the change — the earliest transfer to anyone who is not a queue is used, and
     * failing that the caller falls back to the case opening, which is what this tool did
     * before it could read transfers at all.
     */
    const QUEUE_NAME = /\b(queue|group)\b/i;

    /* A LIST, WHATEVER CAME BACK. Not defensive programming for its own sake: the feed is
     * scraped out of a live Lightning page, and a shape this code did not expect is a thing
     * that happens. An empty list reviews the case as "nothing readable in the feed", which
     * is a finding a reviewer can act on; an exception loses the case, which is not. */
    function asList(v) {
        return Array.isArray(v) ? v : [];
    }

    function normName(s) {
        return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function ownerAssignedAt(data, feed) {
        const all = asList(feed && feed.ownerChanges);
        const changes = all.filter(c => c && c.at);
        // `seen` is not the same question as `at`. A transfer that was read but carried no
        // parseable timestamp still proves the case was handed over — which is enough to
        // stop the tool measuring an agent's first response from a moment before they had
        // the case, even though it is not enough to measure it from.
        const none = { at: null, to: '', from: '', seen: all.length > 0 };
        if (!changes.length) return none;
        const owner = normName(data && data.caseOwner);
        const toOwner = owner ? changes.filter(c => normName(c.to) === owner) : [];
        /* THE TRANSFER TO THE CURRENT OWNER, and only if there is one.
         *
         * The fallback — the earliest transfer to anybody who is not a queue — is for the
         * case where the owner field and the feed spell the same person differently, which
         * is common enough (an alias in one, a full name in the other) that refusing to
         * measure would cost more than it saved. A transfer INTO a queue is never a start:
         * the clock runs from the moment a person was given the case. */
        let usable = toOwner.length ? toOwner : changes.filter(c => !QUEUE_NAME.test(c.to || ''));

        /* A CHAIN OF HANDOVERS MADE IN ONE MOMENT HAS ONE DESTINATION.
         *
         * Salesforce clumps changes made together into a single feed entry, so a case
         * reassigned twice in one action arrives as "Kartikay Kapil to Saksham Gupta" AND
         * "Saksham Gupta to Ayodeji Augustine" under the same timestamp. Only the last of
         * those is a handover to anybody; the middle name never held the case for a
         * measurable instant. So a transfer whose destination is another transfer's ORIGIN
         * at the same moment is dropped — it is a step, not an arrival.
         *
         * Only needed on the fallback path: when the owner field matched, the filter above
         * has already picked the arrival by name. */
        if (!toOwner.length && usable.length > 1) {
            const steppedOverAt = new Map();
            for (const c of changes) {
                if (!steppedOverAt.has(c.at)) steppedOverAt.set(c.at, new Set());
                steppedOverAt.get(c.at).add(normName(c.from));
            }
            const arrivals = usable.filter(c => !(steppedOverAt.get(c.at) || new Set()).has(normName(c.to)));
            if (arrivals.length) usable = arrivals;
        }

        const pick = usable.slice().sort((a, b) => a.at - b.at)[0];
        return pick
            ? { at: pick.at, to: pick.to || '', from: pick.from || '', matchedOwner: !!toOwner.length, seen: true }
            : none;
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
        const items = asList(feed.items).filter(i => i && typeof i === 'object');
        const dated = items.filter(i => i.at);
        const now = (data && data.qaReadAt) || Date.now();

        const opened = caseOpenedAt(data, dated);
        const assigned = ownerAssignedAt(data, feed);
        // The instant the first response is measured FROM: the transfer when the feed carried
        // one, the case opening when it did not.
        const frtFrom = assigned.at || opened.at;
        const out = {
            readable: feed.reason === 'ok' || feed.reason === 'not-attributed',
            feedReason: feed.reason,
            itemsSeen: items.length,
            itemsDated: dated.length,
            itemsUndated: items.length - dated.length,
            // How many articles the page actually held, against how many became messages.
            feedSeen: Number(feed.seen) || items.length,
            /* AND WHETHER THE SCROLL GOT TO THE END. `reason` is loadEntireFeed's own
             * verdict: 'no-new-posts' is a feed that ran out, which is the good answer;
             * 'time-budget' and 'exhausted-rounds' are a feed that was still going when the
             * clock stopped, and a review written from a case that was still loading is
             * missing the oldest half of it — which is the half the first response is in. */
            feedLoad: (feed.load && feed.load.reason) || '',
            feedLoadRounds: (feed.load && feed.load.rounds) || 0,
            feedTruncated: !!(feed.load && /time-budget|exhausted-rounds/.test(feed.load.reason || '')),
            // …and of the messages, how many arrived with no readable text in them. Their
            // timing still counts; their words cannot be quoted.
            itemsBodyless: Number(feed.bodyless) || 0,
            openedAt: opened.at,
            openedFrom: opened.from,
            openedDerived: !!opened.derived,
            ageDays: ageDaysOf(data && data.caseAge),
            milestone: milestoneFor(data && data.caseAge, R),
            counts: { email: 0, call: 0, internal: 0, post: 0, fromUs: 0, fromCustomer: 0, unattributed: 0 },
            // Who the case was handed to, and when — the start of the first response clock
            assignedAt: assigned.at,
            assignedTo: assigned.to,
            assignedFrom: assigned.from,
            assignedSeen: !!assigned.seen,
            assignedMatchedOwner: !!assigned.matchedOwner,
            // What the feed carried in the way of record changes — see readQaFeedItems.
            changeItems: Number(feed.changeItems) || 0,
            changedFields: asList(feed.changedFields).slice(0, 12),
            // First response
            firstResponseAt: null,
            firstResponseMs: null,
            firstResponseBy: '',
            frtFrom,               // the instant the two hours are counted from
            frtFromWhat: assigned.at ? 'assigned' : opened.from,   // 'assigned' | 'field' | 'first-post' | 'age' | 'none'
            frtMet: null,          // true / false / null = could not be measured
            frtTargetHours: R.frtHours,
            // Why it could not be measured, when it could not. Read by the write-up and by
            // the card, so "we cannot tell" never has to be inferred from a blank.
            frtUnmeasured: '',
            // Whether the first thing that went out was sent by the case owner themselves.
            frtByOwner: null,
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

        /* FIRST RESPONSE. From the moment the case was handed to its owner (see
         * ownerAssignedAt; the case opening when no transfer was readable) to the first thing
         * that went OUT to the customer. An internal note is excluded by construction — it
         * never left SOTI, so it cannot be a response to anybody — and so is a call log,
         * which is a record of a conversation rather than a reply to a message. Both still
         * count as ACTIVITY, and both appear in the gap arithmetic below; they are simply not
         * first responses.
         *
         * THE FIRST OUTBOUND AFTER THE HANDOVER, not the first on the case. On a transferred
         * case the emails the previous owner sent are somebody else's first response, and
         * counting one of them here would report this owner as having answered before they
         * had the case.
         *
         * A case whose feed came back 'not-attributed' — read, dated, and not one post
         * placeable as ours or theirs — gets `frtMet: null` rather than a guess. */
        const outbound = dated.filter(i => i.fromUs === true && !i.internal && i.kind !== 'call');
        const first = outbound.find(i => frtFrom === null || i.at >= frtFrom - 5 * 60 * 1000);
        if (first && frtFrom) {
            out.firstResponseAt = first.at;
            out.firstResponseMs = Math.max(0, first.at - frtFrom);
            out.firstResponseBy = first.sender;
            const ownerName = normName(data && data.caseOwner);
            out.frtByOwner = ownerName ? normName(first.sender) === ownerName : null;

            /* A MISS IS ONLY A MISS IF THE CLOCK'S START IS KNOWN.
             *
             * The target runs from the handover, not from the case opening. When the
             * transfer was readable, the arithmetic is the arithmetic and the answer is
             * true or false.
             *
             * WHEN IT WAS NOT, the duration measured here starts too early by however long
             * the case sat in a queue — which can be days. In that direction the error only
             * ever goes one way, and that asymmetry is what this uses:
             *
             *   inside the target measured from the OPENING  → inside it from the handover
             *                                                  too, because the handover can
             *                                                  only have come later. A PASS.
             *   outside it                                   → says nothing at all. The
             *                                                  handover may have been two
             *                                                  minutes before the reply.
             *                                                  UNKNOWN, never a fail.
             *
             * This is the whole of the "19 days late" bug: an agent who answered 38 minutes
             * after the case landed on their desk was reported as three weeks late against a
             * two-hour target, on their own coaching record, because the case had sat in the
             * queue for three weeks before anybody was given it. */
            const inTarget = out.firstResponseMs <= R.frtHours * HOUR;
            if (assigned.at) {
                out.frtMet = inTarget;
            } else if (inTarget) {
                out.frtMet = true;
            } else {
                out.frtMet = null;
                out.frtUnmeasured = assigned.seen
                    ? 'the case was transferred, but the transfer carried no readable date'
                    : 'no transfer of the case to its owner could be read in the feed';
            }
        } else if (frtFrom && feed.reason === 'ok') {
            /* NOTHING WENT OUT AFTER THE HANDOVER, on a feed this build read and understood.
             * That is not an unmeasurable case — it is a failed first response, and the
             * strongest one there is. Only claimed when the feed was actually attributed; on
             * an unreadable feed the same emptiness means nothing.
             *
             * `outbound.length` is not part of the test any more: a case whose only outbound
             * emails were sent by the PREVIOUS owner, before the transfer, has had nothing
             * sent to the customer by the person being reviewed, and that is the same finding
             * as a case with no outbound email at all. */
            out.frtMet = false;
            out.firstResponseMs = null;
        } else if (frtFrom) {
            out.frtUnmeasured = 'the feed could not be read well enough to tell what was sent';
        } else {
            out.frtUnmeasured = 'the case has no readable opening date and no readable transfer, so there is nothing to measure from';
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

        if (out.feedTruncated) {
            F('warn', 'feed-truncated', `The case feed was still loading when the read stopped (${out.feedLoad} after ${out.feedLoadRounds} scroll rounds), `
                + `so the ${out.itemsSeen} message(s) below are the NEWEST part of this case and not all of it. `
                + 'The oldest posts are the missing ones, which is where the first response is — treat the timings as a floor, not a fact.');
        }
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
        if (out.openedDerived && !out.assignedAt) {
            F('info', 'derived-open', 'The case has no readable Date/Time Opened, so the first response time is measured from the case age and is approximate.');
        }

        /* WHERE THE CLOCK STARTED, said out loud and next to the number it produced. A first
         * response time is only meaningful with its starting instant attached, and this is
         * the line that lets a reviewer check the tool's arithmetic against the feed rather
         * than take it on trust. */
        if (out.assignedAt) {
            F('info', 'assigned', `The case was transferred to ${out.assignedTo || 'the case owner'} on ${fmtDateTime(out.assignedAt)}`
                + `${out.assignedFrom ? ` from ${out.assignedFrom}` : ''} — the first response is measured from there, not from the case opening.`);
        } else if (out.openedAt) {
            /* WHICH OF THE TWO REASONS. A feed carrying record changes, none of them an
             * owner change, is a case that really was never transferred — the number below
             * is the owner's from the start and can be read at face value. A feed carrying
             * NO record changes at all is a feed that did not give them up: they were
             * filtered out of the view, or the entries were still collapsed when it was
             * read. Those want opposite responses, and one sentence covering both told
             * nobody anything. */
            const why = out.changedFields.length
                ? `The feed carried ${out.changeItems} record change(s) — ${out.changedFields.slice(0, 6).join(', ')} — `
                  + 'and none of them was a Case Owner change, so this case appears never to have been transferred.'
                : out.changeItems
                    ? `The feed carried ${out.changeItems} record change(s), but none of them would open, so what they changed could not be read. `
                      + 'That is a reading failure rather than a fact about the case.'
                    : 'The feed carried NO record changes at all, which usually means they are filtered out of this case feed rather than that none happened.';
            F('warn', 'frt-from-open', 'No transfer of the case to its owner could be read in the feed, so the first response below is '
                + 'measured from the CASE OPENING instead. Any time the case spent in a queue before it was given to anybody is inside '
                + 'that number and is not the owner\'s. ' + why);
        }

        if (out.frtMet === false && out.firstResponseMs !== null) {
            F('fail', 'frt', `First response took ${fmtDuration(out.firstResponseMs)} from the transfer to ${out.assignedTo || 'the case owner'} — over the ${R.frtHours}-hour target.`);
        } else if (out.frtMet === false) {
            F('fail', 'frt-none', out.assignedAt
                ? 'Nothing was sent to the customer after the case was transferred to its owner — there is no first response.'
                : 'Nothing was sent to the customer on this case at all — there is no first response.');
        } else if (out.frtMet === true) {
            F('pass', 'frt', `First response in ${fmtDuration(out.firstResponseMs)}${out.assignedAt ? ' from the transfer' : ' from the case opening'}, inside the ${R.frtHours}-hour target.`);
        } else if (out.firstResponseMs !== null) {
            /* NOT A PASS AND NOT A FAIL. The reply came later than the target measured from
             * the case OPENING, and the moment the case actually reached its owner is not
             * readable — so the only honest thing to report is the number and why it cannot
             * be counted. Reporting this as a miss is what put "19 days over a 2-hour
             * target" on the record of somebody who answered in 38 minutes. */
            F('warn', 'frt-unknown', `First response ${fmtDuration(out.firstResponseMs)} after the case opened`
                + `${out.firstResponseBy ? `, sent by ${out.firstResponseBy}` : ''} — but ${out.frtUnmeasured}, `
                + `so this CANNOT be counted against the ${R.frtHours}-hour target. The target runs from the handover, and the case may have sat in a queue for most of that time.`);
        } else if (out.frtUnmeasured) {
            F('warn', 'frt-unknown', `The first response could not be measured on this case — ${out.frtUnmeasured}.`);
        }
        // Somebody else answered for the owner. Not a failure — the customer got a reply —
        // but it is the difference between "they were quick" and "their colleague was".
        if (out.frtByOwner === false && out.firstResponseBy) {
            F('info', 'frt-cover', `The first response was sent by ${out.firstResponseBy}, not by the case owner.`);
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
        const items = asList(data && data.qaFeed && data.qaFeed.items).filter(i => i && typeof i === 'object');
        const lines = [];
        let used = 0;
        let dropped = 0;
        let cut = 0;        // posts whose text was trimmed to fit

        for (const i of items) {
            const who = i.fromUs === true ? 'SOTI' : i.fromUs === false ? 'CUSTOMER' : 'UNKNOWN SIDE';
            const kind = i.kind === 'call' ? 'CALL LOG'
                : i.internal ? 'INTERNAL NOTE'
                : i.kind === 'email' ? 'EMAIL' : 'POST';
            const when = i.at ? fmtDateTime(i.at) : (i.label ? `${i.label} (no absolute date)` : 'date not known');
            let body = String(i.body || '').replace(/\n{3,}/g, '\n\n').trim();
            if (body.length > perPost) {
                cut++;
                body = body.slice(0, perPost) + `\n… [${body.length - perPost} more characters of this post not shown]`;
            }
            /* SAY IT WAS UNREADABLE RATHER THAN SHOWING NOTHING. A blank body under a real
             * header invites the write-up to conclude that an empty message was sent. The
             * time, the author and the direction of this one are known and are above; only
             * its text is missing, and the model must not quote what it cannot see. */
            if (!body && i.bodyUnread) body = '[The text of this message could not be read from the page — its timing and author are known, its wording is not. Do not quote or characterise its contents.]';

            let block = `[${when}] [${kind}] [${who}] ${i.sender}:\n${body}`;
            for (const r of asList(i.replies)) {
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
        /* SAID FIRST, not in a footnote. When a case has been shortened to fit, that is a
         * fact about the evidence and it has to be read before the evidence is. */
        if (cut || dropped) {
            const bits = [];
            if (cut) bits.push(`${cut} of these ${lines.length} message(s) have had their text trimmed`);
            if (dropped) bits.push(`${dropped} further message(s) are missing entirely`);
            text = `[THIS TRANSCRIPT IS A SHORTENED COPY OF THE CASE — ${bits.join(', ')}, because the whole case was `
                + 'larger than one request could carry. It is a SAMPLE. Do not conclude that anything is absent from this '
                + 'case on the strength of not seeing it here, and do not describe what a trimmed message said. The '
                + 'MEASURED FACTS above were computed over the WHOLE case and are complete.]\n\n' + text;
        }
        if (dropped) {
            /* WHAT IS MISSING, SAID OUT LOUD. A truncated transcript that does not admit to
             * being truncated invites the write-up to conclude that nothing happened in the
             * part it cannot see — "no follow-up was sent", "the case went quiet" — about
             * messages that are sitting on the record. */
            text += `\n\n[${dropped} further post(s) are NOT included here — the case is longer than one request can carry. `
                + 'Do not conclude that anything is missing from this case: what you have is a SAMPLE of it. '
                + 'The measured facts above were computed over the WHOLE case and remain true.]';
        }
        return text;
    }

    // The measured facts, written for the prompt. Stated as GIVENS the model may not
    // recompute, because everything in here is arithmetic it would do worse.
    function measurementBlock(m, R) {
        const L = [];
        L.push('[MEASURED FACTS — these are computed from the case timestamps. Treat every line as true. Do NOT recalculate any of them, and do NOT contradict them.]');
        L.push(`Case opened: ${fmtDateTime(m.openedAt)}${m.openedDerived ? ' (approximate — derived from the case age)' : ''}`);
        /* THE HANDOVER, ABOVE THE FIRST RESPONSE LINE AND BEFORE IT. The model is being told
         * a duration; without this line it has no way to know the duration does not start at
         * the case opening, and it writes "the case sat for thirteen days before a reply"
         * under a number that measures nothing of the kind. */
        if (m.assignedAt) {
            L.push(`Case transferred to ${m.assignedTo || 'the case owner'}: ${fmtDateTime(m.assignedAt)}`
                + `${m.assignedFrom ? ` (from ${m.assignedFrom})` : ''}. THE FIRST RESPONSE TARGET RUNS FROM THIS MOMENT, not from the case opening — the time the case spent in a queue beforehand is not the owner's.`);
        } else {
            L.push('Case transferred to its owner: NO TRANSFER COULD BE READ in the feed'
                + (asList(m.changedFields).length
                    ? ` (the feed carried ${m.changeItems} record change(s) and none was a Case Owner change)`
                    : m.changeItems
                        ? ` (the feed carried ${m.changeItems} record change(s) but none of them could be opened and read)`
                        : ' (the feed carried no record changes at all)')
                + '. The first response target runs from the handover, so any duration below that is measured from the case opening '
                + 'includes however long the case sat in a queue before anybody was given it. Do NOT describe the first response as '
                + 'late on this case: say that the handover could not be established.');
        }
        if (m.ageDays !== null) L.push(`Case age: ${Math.round(m.ageDays)} days${m.milestone ? ` — at its ${m.milestone}-day review milestone` : ''}`);
        L.push(`Feed read: ${m.itemsSeen} message(s), ${m.itemsDated} with a usable timestamp${m.itemsUndated ? `, ${m.itemsUndated} without` : ''}`
            + `${m.itemsBodyless ? `. ${m.itemsBodyless} of them arrived with NO READABLE TEXT — their timing counts, their wording is unknown, and you must not characterise what they said` : ''}.`);
        L.push(`Message mix: ${m.counts.email} email(s), ${m.counts.call} call log(s), ${m.counts.internal} internal note(s), ${m.counts.post} post(s). ${m.counts.fromUs} from SOTI, ${m.counts.fromCustomer} from the customer${m.counts.unattributed ? `, ${m.counts.unattributed} could not be attributed` : ''}.`);

        const frtStart = m.assignedAt ? 'the transfer' : 'the case opening';
        if (m.frtMet === true) L.push(`FIRST RESPONSE: MET — ${fmtDuration(m.firstResponseMs)} after ${frtStart} (target ${R.frtHours} hours), sent by ${m.firstResponseBy || 'an agent'}.`);
        else if (m.frtMet === false && m.firstResponseMs !== null) L.push(`FIRST RESPONSE: MISSED — ${fmtDuration(m.firstResponseMs)} after ${frtStart}, against a ${R.frtHours}-hour target, sent by ${m.firstResponseBy || 'an agent'}.`);
        else if (m.frtMet === false) L.push(`FIRST RESPONSE: MISSED — nothing was sent to the customer ${m.assignedAt ? 'after the case was transferred to its owner' : 'on this case at all'}.`);
        else if (m.firstResponseMs !== null) L.push(`FIRST RESPONSE: NOT MEASURABLE — the first thing sent to the customer went out ${fmtDuration(m.firstResponseMs)} after the case OPENED`
            + `${m.firstResponseBy ? `, sent by ${m.firstResponseBy}` : ''}, but ${m.frtUnmeasured}. The ${R.frtHours}-hour target runs from the handover, NOT from the opening, `
            + 'so this case is neither a pass nor a miss. State that the first response cannot be assessed and why. Do NOT call it late, and do NOT count it against the agent.');
        else L.push(`FIRST RESPONSE: could not be measured on this case${m.frtUnmeasured ? ` — ${m.frtUnmeasured}` : ''}. Say so; do not estimate it.`);
        if (m.frtByOwner === false && m.firstResponseBy) L.push(`NOTE: that first reply was sent by ${m.firstResponseBy}, who is not the case owner.`);

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
        if (m.feedTruncated) {
            L.push('WARNING: THE FEED WAS STILL LOADING when this case was read, so what follows is the NEWEST part of it and not the whole case. '
                + 'The oldest posts are the ones missing. Do not conclude that anything is absent from this case — say that the record could not be read in full.');
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
     * DE-IDENTIFICATION — why a QA tool hides the names it already knows
     * ---------------------------------------------------------------------
     * M365 Copilot carries an enterprise guardrail that REFUSES to "evaluate,
     * judge, or provide a performance assessment of an identifiable employee".
     * A QA review is exactly that, and the case material hands it the name on a
     * plate: the Case Owner field, the author of every feed post, the signature
     * at the bottom of every reply. So the relay answered "Sorry, I can't assist
     * with…" instead of a write-up — and a refusal has no headers in it, which
     * is how a whole run of blank rows arrived on the QA sheet.
     *
     * THE NAMES WERE NEVER NEEDED. The tool already knows whose case it is: the
     * queue row carries the owner, the review is filed under it, and the sheet
     * writes the Agent column from the RECORD rather than from the answer. So
     * what goes out is the case as a RECORD, with everyone in it under a role
     * label — Agent A, Customer 1 — and what comes back has the labels swapped
     * for the real names before a reviewer ever sees it. The write-up on screen
     * is word for word what it always was. Only the wire is anonymous.
     *
     * IT IS ALSO THE RIGHT DEFAULT ON ITS OWN MERITS, guardrail or not: a
     * support case carries the customer's name and address as well as the
     * agent's, and none of it has to leave the browser to get a case audited.
     * ------------------------------------------------------------------- */

    /* WORDS THAT ARE ALSO NAMES. A bare "Will", "Mark" or "Case" replaced everywhere it
     * appears would shred the transcript it is meant to protect — "will be" becomes
     * "Agent B be" and the review is written about nonsense. A token on this list is only
     * ever hidden as part of a FULL name ("Mark Bennett"), never on its own. That is a
     * deliberate trade: a bare surname left standing is a far weaker identifier than a full
     * name, and mangled evidence is worse than either. */
    const NAME_STOPWORDS = new Set([
        'will', 'mark', 'bill', 'rose', 'may', 'june', 'april', 'august', 'grace', 'hope',
        'faith', 'joy', 'art', 'ray', 'dawn', 'sky', 'summer', 'autumn', 'rich', 'frank',
        'drew', 'chase', 'guy', 'max', 'bob', 'don', 'van', 'page', 'case', 'note', 'reply',
        'king', 'young', 'brown', 'white', 'black', 'green', 'gray', 'grey', 'long', 'short',
        'best', 'good', 'new', 'old', 'low', 'high', 'park', 'hill', 'field', 'wood', 'ford',
        'west', 'east', 'north', 'south', 'love', 'price', 'bond', 'stone', 'day', 'sun',
        'star', 'well', 'bell', 'bright', 'swift', 'small', 'strong', 'french', 'english',
        'many', 'more', 'over', 'under', 'from', 'with', 'call', 'mail', 'team', 'lead',
        'user', 'admin', 'support', 'service', 'system', 'server', 'client', 'agent', 'sales',
        // …and the words this product is made of, which are not people however they look.
        'soti', 'mobicontrol', 'xtreme', 'hub', 'surf', 'assist', 'pocket', 'snap', 'connect',
        'android', 'windows', 'apple', 'google', 'microsoft', 'linux', 'zebra', 'honeywell'
    ]);

    /* A NAME AS THE RECORD WROTE IT, minus everything that is not the name. Salesforce hands
     * back "Ali, Mohammed", "Mohammed Ali (SOTI)", "mohammed.ali@soti.net" and "Mohammed Ali
     * <mohammed.ali@soti.net>" for the same person on the same case, and three of those four
     * would otherwise become three different people in the map. */
    function cleanName(raw) {
        let s = String(raw || '').trim();
        if (!s) return '';
        s = s.replace(/<[^>]*>/g, ' ');                        // "Name <addr>" — drop the address
        s = s.replace(/\([^)]*\)/g, ' ');                      // "(SOTI)", "(Customer)"
        s = s.replace(/[\w.+-]+@[\w.-]+\.\w+/g, ' ');          // a bare address
        s = s.replace(/^(?:mr|mrs|ms|miss|dr|prof)\.?\s+/i, '');
        s = s.replace(/\s*\|.*$/, '');                         // "Name | Support Engineer"
        s = s.replace(/[^\p{L}\p{M}'’\-, ]/gu, ' ').replace(/\s+/g, ' ').trim();
        // "Ali, Mohammed" → "Mohammed Ali", so the same person matches whichever way round
        // the record happened to write them.
        const comma = s.match(/^([\p{L}\p{M}'’\-]+)\s*,\s*(.+)$/u);
        if (comma) s = comma[2].trim() + ' ' + comma[1].trim();
        s = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        // A single token is a first name or a Salesforce alias — still worth hiding, still a
        // name. Anything past four tokens is a job title that came along for the ride.
        return s.split(' ').filter(Boolean).slice(0, 4).join(' ');
    }

    // A newline, named. The prompt builders are template literals whose inner single-quoted
    // strings cannot span lines, so this is how one of them adds a blank line.
    const LINE_BREAK = String.fromCharCode(10);

    function escapeRe(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /* THE ALIAS MAP FOR ONE CASE.
     *
     * The agent under review is ALWAYS "Agent A" — added first, from the Case Owner, before
     * anything the feed says — so no prompt has to explain which of several agents is the one
     * being audited. Everyone else falls in behind in the order the case introduces them,
     * which keeps the labels stable across a re-run of the same case.
     *
     * `hide()` goes on the way out and `show()` on the way back. They are exact inverses on
     * the labels, which is what lets the tool send an anonymous case and still put a real
     * name in front of the reviewer.
     */
    /* WHO GETS CALLED WHAT. Sides are 'us' (a SOTI agent), 'them' (the customer side) and
     * anything else. The FIRST 'us' in the list becomes Agent A, which is why every caller
     * puts the person under review at the front. */
    function aliasesFromNames(entries, on) {
        const people = [];
        const seen = new Map();
        const counts = { us: 0, them: 0, other: 0 };
        const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

        const add = (raw, side) => {
            const name = cleanName(raw);
            if (!name || name.length < 2) return null;
            const low = name.toLowerCase();
            if (seen.has(low)) return seen.get(low);
            // A name already seen under one of its other spellings ("Mohammed" after
            // "Mohammed Ali") joins that person rather than becoming a second one.
            for (const p of people) {
                const other = p.real.toLowerCase();
                if (other.startsWith(low + ' ') || low.startsWith(other + ' ')) {
                    seen.set(low, p);
                    p.spellings.push(name);
                    // Keep the LONGEST spelling as canonical: "Mohammed Ali" is a better
                    // thing to put back into the answer than "Mohammed".
                    if (name.length > p.real.length) p.real = name;
                    return p;
                }
            }
            const alias = side === 'us' ? 'Agent ' + (LETTERS[counts.us++] || 'X')
                : side === 'them' ? 'Customer ' + (++counts.them)
                : 'Participant ' + (++counts.other);
            const entry = { real: name, alias, side, spellings: [name] };
            people.push(entry);
            seen.set(low, entry);
            return entry;
        };

        for (const e of (entries || [])) add(e && e.name, (e && e.side) || 'other');
        return aliasRules(people, on !== false);
    }

    /* EVERY PERSON ONE CASE MENTIONS, in the order the case introduces them. */
    function buildAliases(caseRec, data, m, rules) {
        const entries = [];
        const push = (name, side) => entries.push({ name, side });

        // THE AGENT UNDER REVIEW FIRST — see above.
        push((data && data.caseOwner) || (caseRec && caseRec.owner), 'us');
        if (m && m.assignedTo) push(m.assignedTo, 'us');
        if (m && m.firstResponseBy) push(m.firstResponseBy, 'us');
        if (m && m.assignedFrom) push(m.assignedFrom, 'other');
        push((data && data.contactName) || (caseRec && caseRec.contact), 'them');

        for (const i of asList(data && data.qaFeed && data.qaFeed.items)) {
            if (!i || typeof i !== 'object') continue;
            push(i.sender, i.fromUs === true ? 'us' : i.fromUs === false ? 'them' : 'other');
            for (const r of asList(i.replies)) push(r && r.author, 'other');
        }
        for (const mt of asList(m && m.meetings)) push(mt && mt.sender, 'us');
        push((data && data.lastModifiedBy) || (caseRec && caseRec.lastModifiedBy), 'other');

        return aliasesFromNames(entries, !rules || rules.deident !== false);
    }

    /* THE SAME MAP, REBUILT FROM A STORED PEOPLE LIST.
     *
     * A per-case chat happens days after the run, long after the scrape it stood on was
     * dropped, so it cannot call buildAliases again. What it keeps instead is the small
     * list of who was on the case, and this turns that back into the same hide/show pair
     * the review used — which is what makes an alias STABLE across a review and every
     * conversation about it. */
    function aliasRules(people, on) {
        /* THE RULES, LONGEST FIRST. "Mohammed Ali" has to be replaced before "Mohammed", or
         * the second half of the full name is left sitting beside the alias. */
        const hideRules = [];
        const showRules = [];
        for (const p of people) {
            const spellings = [...new Set((p.spellings || []).concat([p.real]))];
            for (const spelling of spellings) {
                const toks = spelling.split(' ').filter(Boolean);
                if (toks.length > 1) {
                    const joined = toks.map(escapeRe).join('[\\s,]+');
                    const reversed = toks.slice().reverse().map(escapeRe).join('[\\s,]+');
                    hideRules.push({ len: spelling.length + 2, re: new RegExp(joined, 'gi'), to: p.alias });
                    // "Ali, Mohammed" — the other way round, as Salesforce lists it.
                    hideRules.push({ len: spelling.length + 2, re: new RegExp(reversed, 'gi'), to: p.alias });
                    /* "mohammed.ali@soti.net" and "mali@soti.net" in a signature: the local
                     * part goes, the DOMAIN STAYS. Which company an address belongs to is
                     * evidence about the case; which person it belongs to is not. */
                    const first = toks[0].toLowerCase();
                    const last = toks[toks.length - 1].toLowerCase();
                    const local = '(?:' + escapeRe(first) + '[._-]?' + escapeRe(last)
                        + '|' + escapeRe(last) + '[._-]?' + escapeRe(first)
                        + '|' + escapeRe(first.charAt(0)) + escapeRe(last) + ')';
                    hideRules.push({
                        len: spelling.length + 40,
                        re: new RegExp('\\b' + local + '(?=@)', 'gi'),
                        to: p.alias.toLowerCase().replace(/\s+/g, '.')
                    });
                }
                for (const t of toks) {
                    const low = t.toLowerCase();
                    // A lone token is hidden only when it is distinctive — see NAME_STOPWORDS.
                    if (low.length < 3 || NAME_STOPWORDS.has(low)) continue;
                    hideRules.push({ len: t.length, re: new RegExp('\\b' + escapeRe(t) + '\\b', 'gi'), to: p.alias });
                }
            }
            showRules.push({ re: new RegExp('\\b' + escapeRe(p.alias) + '\\b', 'g'), to: p.real });
            showRules.push({ re: new RegExp('\\b' + escapeRe(p.alias.toLowerCase().replace(/\s+/g, '.')) + '\\b', 'g'), to: p.real });
        }
        hideRules.sort((a, b) => b.len - a.len);

        const hide = (text) => {
            if (!on) return String(text === null || text === undefined ? '' : text);
            let s = String(text === null || text === undefined ? '' : text);
            for (const r of hideRules) { r.re.lastIndex = 0; s = s.replace(r.re, r.to); }
            return s;
        };
        /* THE WAY BACK. "Agent A" can never eat "Agent AB", because both ends of the match
         * are word boundaries and B is a word character. */
        const show = (text) => {
            if (!on) return String(text === null || text === undefined ? '' : text);
            let s = String(text === null || text === undefined ? '' : text);
            for (const r of showRules) { r.re.lastIndex = 0; s = s.replace(r.re, r.to); }
            return s;
        };

        /* WHAT THE PROMPT SAYS ABOUT ITSELF. Without this the model is reading a case in
         * which everybody is called "Agent B" and has no way to know that is deliberate
         * rather than the record being broken. */
        const legend = () => {
            if (!on || !people.length) return '';
            const owner = people.find(p => p.side === 'us') || people[0];
            const rows = [`- ${owner.alias}: THE SOTI SUPPORT AGENT WHOSE HANDLING OF THIS RECORD IS UNDER REVIEW (the case owner).`];
            for (const p of people) {
                if (p === owner) continue;
                rows.push(`- ${p.alias}: ${p.side === 'us' ? 'another SOTI Support agent who wrote on the record'
                    : p.side === 'them' ? 'someone on the customer side'
                    : 'another participant on the record'}`);
            }
            return '[WHO IS WHO ON THIS RECORD]\nThe people on this record are NOT identified. Their names were removed before '
                + 'this reached you and replaced with the role labels below. Use these labels and only these labels, and do not '
                + 'speculate about who anyone is.\n' + rows.join('\n');
        };

        return { on: !!on, people, agentAlias: (people.find(p => p.side === 'us') || {}).alias || 'Agent A', hide, show, legend };
    }

    /* ---------------------------------------------------------------------
     * WHEN THE RELAY ANSWERS SOMETHING THAT IS NOT AN ANSWER
     * ---------------------------------------------------------------------
     * A refusal arrives through the relay looking exactly like a successful
     * reply: HTTP 200, prose in the body, no error anywhere. Stored as it came,
     * it became a review with every field empty and nothing on the card to say
     * why — and a blank row on the QA sheet under a real case number, which is
     * worse than no row at all because it looks reviewed.
     *
     * So a refusal is DETECTED and named. Only the OPENING of the answer is
     * searched: a genuine write-up can perfectly well say "the case cannot be
     * closed until the customer replies" three paragraphs in, and a check over
     * the whole text would call that a refusal and throw the review away.
     * ------------------------------------------------------------------- */
    const REFUSAL_RES = [
        /\b(?:i|we)\s*(?:'|’)?\s*(?:m|am|are)?\s*(?:sorry|afraid)\b[^.]{0,120}?\b(?:can(?:'|’)?t|cannot|can not|unable|not able|won(?:'|’)?t)\b/i,
        /\b(?:i|we)\s+(?:can(?:'|’)?t|cannot|can not|won(?:'|’)?t|must decline|have to decline|am not able to|are not able to)\s+(?:\w+\s+){0,3}?(?:assist|help|provide|comply|continue|create|draft|write|produce|generate|evaluate|judge|assess|complete|do)\b/i,
        /\bidentifiable\s+(?:employee|individual|person|staff|worker)/i,
        /\bperformance\s+(?:assessment|evaluation|review|feedback|appraisal)s?\s+of\s+(?:an?|the|any)\s+(?:identifiable|named|specific|individual|real)/i,
        /\b(?:goes against|violates|conflicts with|is against)\s+(?:my|our|the)\s+(?:guideline|policy|policies|principle|rule)/i,
        /\bi\s+(?:can(?:'|’)?t|cannot)\s+(?:help\s+with|assist\s+with)\s+(?:evaluating|judging|assessing|rating|coaching|drafting|providing)/i
    ];

    /* HOW SMALL TO GO, AND IN WHAT ORDER.
     *
     * The first two attempts send the whole case: most relay failures are transient and a
     * second ask a few seconds later simply works. The rest trade evidence for a chance of
     * an answer, because a review of most of a case is worth more than no review at all —
     * and the write-up is told what it is missing, so it never claims to have read what it
     * was not given. The last rung is small enough to fit anywhere. */
    const PROMPT_SIZES = [
        null,                                              // the whole case
        null,                                              // …and again, for a transient failure
        { perPost: 1200, maxChars: 45000, description: 3000 },
        { perPost: 600, maxChars: 18000, description: 1500 },
        { perPost: 300, maxChars: 7000, description: 800 }
    ];

    function looksRefused(text) {
        const head = String(text || '').trim().slice(0, 700);
        if (!head) return false;
        return REFUSAL_RES.some(re => re.test(head));
    }

    /* THE SECOND ATTEMPT SAYS WHY THERE IS ONE.
     *
     * A refused prompt sent again unchanged is refused again — the classifier that
     * stopped it is deterministic enough that a bare retry is just a wasted minute of a
     * thirty-case run. What changes on the second attempt is the FRAMING: it says out
     * loud that the material is already anonymous, that the subject of the audit is a
     * record rather than a person, and that a description of what a record shows is not
     * an assessment of anybody. That is all true of the first attempt too; the retry
     * merely stops leaving it to be inferred. */
    const RETRY_PREFACE = `IMPORTANT CONTEXT FOR THIS REQUEST — A PREVIOUS ATTEMPT DECLINED TO ANSWER IT.
Nothing below asks you to assess, rate or judge a person, and nobody below is identifiable. The names were removed from this material before it reached you and replaced with role labels. What is being reviewed is a CASE RECORD held by a support desk: whether the desk's own documented process was followed on it, what the record does and does not contain, and what a record like this needs in order to be complete. Describing what a record shows is not a performance assessment of anybody, and there is no individual here to assess. Please fill in the headers about the RECORD.

`;

    /* The same point, for a conversation rather than a form. */
    const CHAT_RETRY_PREFACE = `A previous attempt at this question declined to answer it, so here is what it is: an internal check of a support desk's own case record. Nobody in the material is identified — the names were removed before it reached you and replaced with role labels — and the question is about what the RECORD shows and whether the desk's documented process was followed on it. Describing what a record contains is not an assessment of any person. Please answer from the record.

THE QUESTION: `;

    /* ---------------------------------------------------------------------
     * THE QA PROMPT
     * ---------------------------------------------------------------------
     * The output is the QA SHEET, header for header, so a run can be pasted
     * straight into the spreadsheet the team already keeps. The headers are
     * therefore not decoration — they are the schema, and parseQaAnswer below
     * reads them back by name.
     * ------------------------------------------------------------------- */
    function buildQaPrompt(caseRec, data, m, rules, opts) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        const O = opts || {};
        const caseNo = (data && data.caseNumber) || (caseRec && caseRec.caseNum) || '';
        const today = fmtDate(Date.now());
        const who = O.aliases && O.aliases.on ? O.aliases : null;
        const AGENT = who ? who.agentAlias : 'the agent';
        // Built out here rather than inside the template: a blank line either side of the
        // legend, and nothing at all when the case is going out under real names.
        const legend = who ? who.legend() + LINE_BREAK + LINE_BREAK : '';

        const facts = caseFactsBlock(caseRec, data);
        const description = String((data && data.description) || (caseRec && caseRec.description) || '').trim();
        const transcript = buildTranscript(data, O.transcript || {});

        return `${O.retry ? RETRY_PREFACE : ''}You are auditing ONE SUPPORT CASE RECORD for SOTI Support's internal case-audit process — the routine check a service desk runs over its own tickets to see whether its process was followed. You are the auditor, not the person who worked the case: what is being examined is the RECORD and the HANDLING on it, not the customer's problem${who ? ', and not any individual — nobody in this material is identified' : ''}.

Fill in EXACTLY the headers below, in this order, one per line, and output nothing before or after them. Each header is a column of the team's QA sheet.

RULES:
- Ground every statement ONLY in the case material below. Never invent a date, a version, an article number, a JIRA code or a name. If something is not in the material, say "Not evident from the case".
- The [MEASURED FACTS] block is arithmetic already done for you. Quote it, never recompute it, and never contradict it. If it says the first response was missed, it was missed.
- The transcript is OLDEST FIRST. The end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER. Anyone writing on behalf of SOTI Support is the AGENT. Never swap these roles.
- ${who ? `Everyone on this record appears under a role label (${AGENT}, Customer 1, and so on) — see [WHO IS WHO ON THIS RECORD] below. Write about the labels. Never use a personal name, and never guess at one.` : 'Refer to people by their role.'}
- Assess the SOTI SIDE of the handling, not the customer's conduct. A difficult customer is not a finding against ${AGENT}; how the case was handled around them is.
- Be specific and quote. "Poor communication" is worthless to whoever reads this; "the 12 March reply answered the licensing question but ignored the enrolment error the customer asked about twice" is something a team can act on.
- Be fair. Say what was done WELL as readily as what was not — a review with an empty Positive(s) line on a competently handled case is a bad review.
- Write plain text. No markdown, no ** or ##, no bullets other than "- ", no emoji, no preamble.

HEADERS TO FILL:
Case Number: ${caseNo || 'read it from the case facts'}
Date Reviewed: ${today}
Closure Check: whether the case was closed correctly — was a resolution given and agreed, was the closure process followed for this case's status, and if it is still open, is it being progressed or is it drifting. If the case is not closed, say what state it is in and whether that is reasonable for its age. One or two sentences.
Internal Resolution Note Quality: judge the internal notes and the resolution write-up — could another engineer pick this case up cold and know what was tried, what was found, and why it was closed. Quote or name the note you are judging. If there is no internal note at all, say so plainly. One to three sentences.
Case Handling Notes: the narrative of how the case was worked — first response, the pace of it, whether the case was driven forward or left to wait, whether meetings were held and written up, whether the troubleshooting had a method to it. Reference the measured facts by their numbers. Three to six sentences.
JIRA / Other Agent Follow-up: whether a defect should have been raised and was not, whether an existing JIRA was chased, and whether anything needs another agent, a Team Lead or Development to pick up. Name the JIRA only if it appears in the case material. If nothing is needed, write "None needed".
KB Articles: whether Knowledge was used or should have been — was an existing article linked to the customer, and does this case's resolution warrant writing one. Name an article number ONLY if it appears in the case material; otherwise describe the article that should exist. If neither applies, write "None applicable".
Positive(s): what the handling did well, specifically. "- " bullets, one to three. If genuinely nothing, write "None identified" — but look first.
Improvement Point(s): what should be done differently on a case like this, specifically and actionably. "- " bullets, one to four. If genuinely nothing, write "None identified".
Final Comment: one or two sentences a Team Lead could read on its own and know how this case went.
QA Score: a whole number out of 100 for how well this case was handled, then a slash and one word — Excellent (85-100), Good (70-84), Needs work (50-69), or Poor (under 50). Example: "72/Good". Base it on the measured facts and your reading, and be consistent: a missed first response, an undocumented meeting and a customer left chasing cannot score above 60.
Main Pattern: ONE short phrase — five to ten words — naming the single most important handling behaviour this record shows. It must be a pattern ("closes cases without a resolution note"), not an event ("no reply on 3 March").
Training Needed: the training areas from the list below, by their exact labels, separated by "; ", most important first. At most three. "None" if the case shows no training need.
Coaching Pointer: one sentence of practical guidance, in the second person, saying exactly what to do differently on the next case like this. It must be something actionable tomorrow.

${trainingBlock()}

${legend}[CASE FACTS]
${facts}

${measurementBlock(m, R)}

${description ? `[CASE DESCRIPTION AS REPORTED]\n${description.slice(0, (O.transcript && O.transcript.description) || 6000)}\n\n` : ''}[CASE TRANSCRIPT — OLDEST FIRST]
${transcript || '(No feed posts could be read for this case.)'}`;
    }

    /* THE 30/60/90 PROMPT — the management-review write-up for an aging case.
     *
     * A different document with a different reader: QA is about how the agent worked; this is
     * about what happens to the case next, and it is read by management. The milestone and the
     * date are computed here and stated as hard facts, because a management-review document
     * whose first line is blank — which is what happens when the model is left to fill in its
     * own milestone — is worse than no document. */
    function build306090Prompt(caseRec, data, m, rules, opts) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        const O = opts || {};
        const who = O.aliases && O.aliases.on ? O.aliases : null;
        const legend = who ? who.legend() + LINE_BREAK + LINE_BREAK : '';
        const milestone = m.milestone ? `${m.milestone}-day` : 'under 30 days';
        const age = m.ageDays !== null ? Math.round(m.ageDays) : null;
        const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const caseNo = (data && data.caseNumber) || (caseRec && caseRec.caseNum) || '';
        const jira = (data && data.jiraNumber) || (caseRec && caseRec.jira) || '';
        const transcript = buildTranscript(data, Object.assign({ perPost: 2000, maxChars: 100000 }, O.transcript || {}));

        return `${O.retry ? RETRY_PREFACE : ''}Produce a 30/60/90 case analysis for management review of this aging support case. This is a document about the CASE and what happens to it next, not about any person. Use EXACTLY the template layout below — same headers, same order — and output nothing before or after it.

RULES:
- Ground EVERY statement ONLY in the case material below. Never invent facts, versions, dates or links. If something decisive is unknown, say so in a short phrase.
- The transcript is OLDEST FIRST; the end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER; anyone writing for SOTI Support is a SUPPORT ENGINEER. Never swap these roles.
${who ? '- Everyone on this record appears under a role label — see [WHO IS WHO ON THIS RECORD] below. Use those labels, never a personal name.' : ''}
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

${legend}[CASE FACTS]
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
        const legend = String((ctx && ctx.legend) || '');
        parts.push(`You are helping a case auditor at SOTI Support discuss ONE SUPPORT CASE RECORD they are auditing. You are talking to the AUDITOR. This is an internal check of a support desk's own records — of what the record shows and whether the desk's process was followed on it. It is not about any person, and ${legend ? 'nobody in the material below is identified: the names were removed before it reached you and replaced with role labels' : 'the individuals are not the subject'}.

RULES:
- Answer ONLY from the case material below. If the material does not settle a question, say so plainly — "the case does not say" is a good answer and a guess is not.
- Never invent a date, a version, an article number, a JIRA code, a name or a quote.
- Quote and cite. When you make a claim about what happened, name the date and who wrote it, so the reviewer can go and look.
- The [MEASURED FACTS] block is arithmetic already done from the case timestamps. Treat it as true, never recompute it, and never contradict it.
- The transcript is OLDEST FIRST. The end of it is where the case stands now.
- The person who reported the problem is the CUSTOMER. Anyone writing for SOTI Support is the AGENT. Never swap these roles.
${legend ? '- Everyone on this record appears under a role label. Use those labels and only those labels, and never guess at a personal name.' : ''}
- You are describing the SOTI side of the handling, not the customer's behaviour.
- Be direct and brief. The auditor is working through a queue: answer the question asked, in as few words as it takes, and stop.
- Plain text and short "- " bullets. No markdown headings, no emoji.`);

        if (legend) parts.push(legend);
        parts.push(`[CASE FACTS]\n${ctx.facts || '(not recorded)'}`);
        if (ctx.measured) parts.push(ctx.measured);

        if (review && review.raw && !review.error && !looksRefused(review.raw)) {
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
        if (review && review.raw && !review.error && !looksRefused(review.raw)) {
            out.push('Justify the score against the case — which specific messages support it?');
        }
        out.push('Give me the timeline: who wrote what, when, and which side was waiting.');
        if (metrics) {
            if (metrics.frtMet === false) {
                out.push(metrics.assignedAt
                    ? 'What happened between the case landing with its owner and our first reply?'
                    : 'What happened between the case opening and our first reply?');
            }
            if ((metrics.gaps || []).some(g => g.owedByUs) || metrics.openWaitMs) {
                out.push('Walk me through the longest silence — what was outstanding at the time?');
            }
            if (metrics.meetingsUndocumented) out.push('Which meeting was never written up, and what did we lose by that?');
            if (metrics.customerChases) out.push('Quote the messages where the customer had to chase.');
        }
        out.push('What should have been done differently on this case, step by step?');
        out.push('Draft the improvement points for this case, as they would go on the QA record.');
        out.push('Was anything technical missed — a log, a version, a known defect?');
        return out.slice(0, 6);
    }

    /* THE COACHING SUMMARY — one row per agent, out of that agent's reviewed cases.
     *
     * Written from the QA records rather than from the cases, deliberately: coaching is about
     * the PATTERN across an agent's work, and a summary derived from the cases again would be
     * a second, weaker QA pass that could disagree with the first. The reviews are the input;
     * the job here is to find what repeats in them. */
    function buildCoachingPrompt(agent, records, opts) {
        const O = opts || {};
        /* THE NAME DOES NOT GO OUT. The panel writes the Agent column from its own
         * record the instant the answer arrives (see buildCoaching), so sending it was
         * only ever telling the relay whose appraisal this is — which is what got the
         * request refused. */
        const label = O.anonymous === false ? String(agent || 'the agent') : 'the agent';
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

        return `${O.retry ? RETRY_PREFACE : ''}You are summarising what a set of CASE AUDIT RECORDS have in common, so that a support desk can decide what to put in its next training session.

The audits below all cover cases handled by the same desk role. Nobody is identified in them. You are describing what the RECORDS repeatedly show and what practice would fix it — not assessing a person.

Fill in EXACTLY these headers, one per line, and output nothing before or after them.

RULES:
- Base everything ONLY on the audit records below. Do not invent a case, a date or a behaviour.
- You are looking for what REPEATS. One case with a late reply is an incident; the same finding in three of five cases is a pattern, and only a pattern belongs in a coaching row.
- If the records genuinely show no repeated problem, say so — a fabricated development area wastes a coaching conversation and costs the team's trust in this process.
- The SMART goal must be Specific, Measurable, Achievable, Relevant and Time-bound, and it must be about something the handling of a case controls. "Improve communication" is not a goal. "Send a written summary in the call log within 4 hours of every customer meeting, for all cases in October" is.
- Plain text. No markdown, no emoji, no preamble.

HEADERS TO FILL:
Agent: ${label}
Main Pattern Observed: the one handling behaviour that shows up most across these cases, in one or two sentences, with the number of cases it appears in.
Coaching Pointer / SMART Goal: one measurable goal for the next month, in one or two sentences.
Due Date: a sensible review date for that goal, one month from today, as a date only.
Notes: anything a Team Lead should know before the conversation — including what these records show being done WELL, which must not be left out.

[${records.length} CASE AUDIT RECORD(S) FROM THE SAME DESK ROLE]
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

    /* WHETHER THE ANSWER WAS AN ANSWER.
     *
     * `filled` counts the headers that actually came back with something under them, and
     * `usable` is the line between a review and a blank row on the sheet. Five is the
     * threshold because Case Number and Date Reviewed are echoed straight back out of the
     * prompt — a reply that carries only those two has understood nothing, and a reply
     * that carries five has at least read the case. */
    const QA_MIN_FIELDS = 5;

    function parseQaAnswer(text, metrics, rules) {
        const fields = parseLabelled(text, QA_FIELDS);
        const filled = QA_FIELDS.filter(f => String(fields[f] || '').trim()).length;
        let score = parseScore(fields['QA Score'], text);

        /* NO REVIEW LEAVES HERE WITHOUT A NUMBER ON IT — see deriveScore. The written score
         * always wins; this only ever fills a hole. The field is filled in too, so the sheet
         * column, the card and the coaching average are all reading the same figure rather
         * than three different fallbacks. */
        if (score.value === null && metrics) {
            score = deriveScore(metrics, rules);
            fields['QA Score'] = `${score.value}/${score.band}`;
        }

        return {
            fields,
            raw: String(text || ''),
            training: parseTraining(fields['Training Needed']),
            score,
            filled,
            refused: looksRefused(text),
            usable: filled >= QA_MIN_FIELDS
        };
    }

    function parseCoachingAnswer(text) {
        const fields = parseLabelled(text, COACHING_FIELDS);
        // The Agent header is echoed back from the prompt, so it does not count towards
        // whether the model said anything of its own.
        const filled = COACHING_FIELDS.filter(f => f !== 'Agent' && String(fields[f] || '').trim()).length;
        return { fields, raw: String(text || ''), filled, refused: looksRefused(text), usable: filled >= 2 };
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

    function bandFor(n) {
        return n >= 85 ? 'Excellent' : n >= 70 ? 'Good' : n >= 50 ? 'Needs work' : 'Poor';
    }

    // "72/Good" — the number is what gets averaged, the word is what gets read. A missing or
    // unparseable score is null rather than zero: an average that silently counts a failed
    // parse as nought is an average that defames somebody.
    function parseScore(raw, whole) {
        const text = String(raw || '');
        let num = text.match(/\b(\d{1,3})\b/);
        /* AND IF THE HEADER WAS NOT THERE, LOOK IN THE REST OF THE ANSWER.
         *
         * A write-up that is otherwise complete and simply put its score somewhere the
         * header parser did not look — "Overall: 72/100", "Score: 72", a line the model
         * bolded past recognition — has a score. Failing to find it and calling the review
         * scoreless throws away a judgement that is sitting there in the text. Anchored to a
         * word that means a score, so a version number or a serial number in the prose can
         * never become somebody's QA result. */
        if (!num && whole) {
            const m = String(whole).match(/\b(?:qa\s+)?(?:score|rating|overall)\b[^\n\d]{0,20}(\d{1,3})\s*(?:\/\s*100|%|\b)/i)
                || String(whole).match(/\b(\d{1,3})\s*(?:\/\s*100|out of 100)\b/i);
            if (m) num = m;
        }
        const n = num ? Math.min(100, Math.max(0, parseInt(num[1], 10))) : null;
        let band = (text.split('/')[1] || '').trim().replace(/\(.*$/, '').trim();
        if (!band && n !== null) band = bandFor(n);
        return { value: n, band };
    }

    /* ---------------------------------------------------------------------
     * A SCORE THE TOOL CAN ALWAYS PRODUCE
     * ---------------------------------------------------------------------
     * Every reviewed case must carry a number. A row on the QA sheet with a
     * blank score column is a case nobody can sort, average or compare — and
     * "reviewed, but the write-up carried no score" is a log line that tells a
     * reviewer nothing except that they have to go and look.
     *
     * So when the model does not give one, the measurement does. This is NOT a
     * second opinion on the prose: it is arithmetic over the same measured
     * facts the write-up was handed, using the rubric the prompt itself states
     * ("a missed first response, an undocumented meeting and a customer left
     * chasing cannot score above 60"). It is marked `derived` everywhere it is
     * shown, because a reviewer must always be able to tell a judgement from a
     * calculation.
     *
     * IT NEVER CONDEMNS ON EVIDENCE IT DOES NOT HAVE. A case whose feed could
     * not be read is capped rather than punished: the deductions below are for
     * things that were SEEN, and an unreadable case has seen nothing.
     * ------------------------------------------------------------------- */
    function deriveScore(m, rules) {
        const R = Object.assign({}, DEFAULT_RULES, rules || {});
        if (!m) return { value: 70, band: 'Good', derived: true, basis: 'nothing was measured on this case' };

        let n = 90;
        const why = [];
        const take = (points, reason) => { n -= points; why.push(reason); };

        if (m.frtMet === false && m.firstResponseMs !== null) {
            take(25, `first response ${fmtDuration(m.firstResponseMs)} against a ${R.frtHours}-hour target`);
        } else if (m.frtMet === false) {
            take(40, 'nothing was ever sent to the customer');
        } else if (m.frtMet === true) {
            n += 4;
            why.push('first response inside target');
        }

        const ourGaps = (m.gaps || []).filter(g => g.owedByUs === true).length;
        if (ourGaps) take(Math.min(24, ourGaps * 8), `${ourGaps} silence gap(s) with the case waiting on us`);
        if (m.openWaitMs) take(12, 'the newest message is the customer\'s, still unanswered');
        if (m.customerChases) take(Math.min(18, m.customerChases * 6), `the customer chased ${m.customerChases} time(s)`);
        if (m.meetingsUndocumented) take(Math.min(16, m.meetingsUndocumented * 8), `${m.meetingsUndocumented} meeting(s) never written up`);
        if (m.counts && m.counts.internal === 0 && m.itemsSeen > 2) take(6, 'no internal note anywhere on the case');

        /* CAPS, NOT DEDUCTIONS, for what could not be established. A case the tool could not
         * read properly must not score as if it were clean, and must not be marked down as
         * if it were bad. */
        if (!m.readable) { n = Math.min(n, 75); why.push('the feed could not be fully read, so this is a provisional figure'); }
        if (m.frtMet === null && m.firstResponseMs !== null) {
            n = Math.min(n, 80);
            why.push('the first response could not be assessed because the handover was not readable');
        }

        /* A FLOOR THAT KEEPS THIS ON THE SAME SCALE AS A WRITTEN SCORE.
         *
         * The deductions stack, and a case that is bad on every axis at once bottoms out in
         * the teens — which is a defensible number in isolation and a misleading one in an
         * average, because a reviewer's written score for the same case would have been
         * somewhere in the thirties. Derived and written scores sit in the same column and
         * feed the same coaching average, so they have to mean roughly the same thing.
         *
         * The floor is lower when NOTHING was ever sent to the customer: there is no case to
         * be made for a case nobody answered. */
        const answered = m.frtMet !== false || m.firstResponseMs !== null;
        n = Math.max(answered ? 20 : 10, Math.min(98, Math.round(n)));
        return {
            value: n,
            band: bandFor(n),
            derived: true,
            basis: why.length ? why.join('; ') : 'nothing was flagged against this case'
        };
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
        buildAliases,
        aliasRules,
        aliasesFromNames,
        cleanName,
        looksRefused,
        PROMPT_SIZES,
        CHAT_RETRY_PREFACE,
        buildChatSystem,
        chatSuggestions,
        buildQaPrompt,
        build306090Prompt,
        buildCoachingPrompt,
        parseQaAnswer,
        parseCoachingAnswer,
        deriveScore,
        bandFor,
        parseTraining,
        parseScore,
        toCsv
    };
})();
