/* ============================================================================
 * QA Tool — THE PANEL
 * ============================================================================
 * The screen, and the run that drives it.
 *
 * WHAT THIS TOOL IS FOR, in one paragraph, because everything below is shaped by
 * it: a QA reviewer has a Salesforce list of cases and has to go through them
 * one at a time — open each, read every email, post and call log with its dates,
 * work out whether the customer was answered inside the target and whether they
 * were then left waiting, check that every meeting was written up, and decide
 * what the agent should be taught. Doing that by hand is thirty page loads and
 * thirty scrolls to the bottom of a feed before a single judgement is made. This
 * does the reading; the judgement is written by the model and stays on screen
 * for a human to disagree with.
 *
 * THE THREE FILES BESIDE THIS ONE, and why the work is split where it is:
 *
 *   content.js   reads Salesforce. Carried over from the SOTI AI Analyser whole,
 *                with a QA appendix at the end that returns the feed as records
 *                rather than as prose.
 *   case-reader.js  opens one case in a background window and closes it again.
 *                Also the analyser's, and the part of it with the most bruises.
 *   qa-engine.js measures. Every fact that can be computed is computed there, in
 *                JavaScript, before a model sees the case — because a model
 *                asked to subtract two timestamps will answer confidently either
 *                way, and this tool's output ends up on somebody's coaching
 *                record.
 *
 * So what is left here is the panel: the queue with its tick boxes, the run, and
 * the three sheets the run fills in.
 * ========================================================================== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const E = window.QaEngine;
    // The Display size in force — see display-size.js. Screen measurements are divided by it
    // wherever they are written back as a length.
    const uiZoom = () => (window.QaDisplay && window.QaDisplay.zoom()) || 1;

    /* ---------------------------------------------------------------------
     * STATE, AND WHERE IT IS KEPT
     * ---------------------------------------------------------------------
     * All of it in chrome.storage.local, all of it under one prefix. A review
     * takes a minute of somebody's machine and a Copilot round trip to produce,
     * so it survives the panel being closed — which a side panel is, constantly.
     * ------------------------------------------------------------------- */
    const K = {
        cases: 'qa_cases',
        reviews: 'qa_reviews',
        coaching: 'qa_coaching',
        rules: 'qa_rules',
        roster: 'qa_roster',
        lastList: 'qa_last_list',
        /* THE REVIEWER'S OWN SALESFORCE LIST VIEWS, saved by hand — separate from lastList,
         * which is only ever a record of where the last sync happened to come from. One is
         * a memory, the other is a choice, and a sync from somewhere else must not quietly
         * rewrite the queues somebody chose to keep. */
        lists: 'qa_lists',
        listsOffered: 'qa_default_lists_offered',
        month: 'qa_sheet_month',
        // The per-case chats, and the material they stand on. Separate keys because they
        // have different lifetimes: a chat is the reviewer's own work and is only ever
        // deleted deliberately, while a context is a cache of a scrape and is pruned.
        chats: 'qa_chats',
        context: 'qa_context',
        /* THE FULL TRANSCRIPT OF ONE CASE, IN A KEY OF ITS OWN.
         *
         * Not a field on qa_context, and the reason is arithmetic rather than taste. That one
         * key holds every cached case, and chrome.storage rewrites a key WHOLE on every set()
         * — so putting a megabyte of transcript on each of eighty entries would mean reading
         * and writing eighty megabytes to cache one case. Per case, it is one write of one
         * case. qa_context stays the small index it has always been, and the transcript the
         * chat actually stands on lives here, loaded only when a chat is about to send. */
        ctxDoc: (key) => 'qa_ctxdoc_' + key,
        // Which of those documents exist, newest first. A list rather than a scan: finding
        // them by reading every key in storage would mean pulling every review and every
        // cached case into memory once per case read, which on a thirty-case run is tens of
        // megabytes of deserialising to delete one string.
        ctxDocs: 'qa_ctxdoc_keys',
        /* WHAT A ROW SHOWS, AND HOW WIDE EACH COLUMN IS — the reviewer's own layout.
         * Three keys rather than one: the chosen columns, the columns that EXISTED when that
         * choice was made (which is how a later build tells a column somebody switched off
         * from one they were never offered — see loadColumnPrefs), and the dragged widths. */
        columns: 'qa_columns',
        columnsSeen: 'qa_columns_seen',
        colWidths: 'qa_col_widths',
        // Which month and owner folders are open on the Reviews tab — see REV_OPEN.
        revFolders: 'qa_rev_folders'
    };

    /* THE TEAM, as the coaching sheet has it. A default, not a fixture: it is
     * editable in Settings, and an agent who appears in the queue without being
     * on this list is still reviewed and still gets a coaching row. The list
     * decides the ORDER of the sheet and who appears on it with no cases yet. */
    const DEFAULT_ROSTER = ['Mohammed', 'Ayse', 'Imran', 'Bill', 'Jose', 'Yucel', 'Sasan', 'Taran', 'Kennedy'];

    let CASES = { listName: '', origin: '', scrapedAt: 0, cases: [] };
    let REVIEWS = [];
    let COACHING = [];
    let RULES = Object.assign({ workers: 2 }, E.DEFAULT_RULES);
    let ROSTER = DEFAULT_ROSTER.slice();
    let LAST_LIST = null;              // { url, name, at }
    let LISTS = [];                    // [{ id, name, url, at }] — the saved Salesforce list views
    let SHEET_MONTH = '';
    let SELECTED = new Set();
    /* SELECTING — the analyser's Select mode. Off, a row opens its case in Salesforce; on,
     * every row grows a tick-box and a click ticks it. The QA run acts on what is ticked. */
    let SELECTING = false;
    let VIEW = 'cases';
    let FILTER = 'all';
    // Which entitlement tier is showing. Deliberately not persisted, like the search box: a
    // filter you cannot see the reason for is how a queue comes back looking half-empty.
    let TIER = 'all';
    // "Which of these has a defect open against it" — see the JIRA chip in renderTierChips.
    // Not persisted, for the same reason TIER is not.
    let ONLY_JIRA = false;
    // "★ Focus" — the cases that need action now. Computed, never curated; see needsAction.
    let ONLY_FOCUS = false;
    /* THE OWNERS PICKED IN THE OWNER DROPDOWN — ownerKey()s, empty for everyone. Not persisted,
     * for TIER's reason; the button says who is picked, so the filter is never invisible. */
    let OWNERS = new Set();

    /* THE CHAT, AND WHAT IT STANDS ON.
     *
     * CHATS is the reviewer's own work — one conversation per case, kept until they clear
     * it. CONTEXT is a cache of what was read off Salesforce during a run: the facts, the
     * measured block and the transcript, which is what makes an answer days later as
     * grounded as the review was on the day.
     *
     * They are bounded differently on purpose. A chat is a few kilobytes and there is no
     * reason to throw one away. A context carries a whole case transcript, so it is capped
     * per case and the oldest are pruned — see saveContext. */
    let CHATS = {};
    let CONTEXT = {};
    let CHAT_KEY = '';
    let CHAT_BUSY = false;
    let CHAT_ABORT = null;

    // How much of a case transcript is kept INSIDE THE INDEX. Small on purpose: this copy
    // exists so a card can be drawn and a chat still has something to stand on when the full
    // document has been pruned, and it is rewritten along with every other cached case on
    // every save. The chat's real material is the document below. Whatever is dropped is
    // declared inside the transcript itself.
    const CONTEXT_MAX_CHARS = 60000;
    // How many cases keep a stored index entry. The oldest fall off; their chats survive and
    // say so, and the case can be re-read from the chat screen in one press.
    const CONTEXT_KEEP = 80;
    /* AND HOW MUCH OF THE CASE THE CHAT ITSELF READS.
     *
     * A chat is a QA review continued by other means — "justify that score", "what did the
     * customer actually ask on the 3rd" — and both of those questions are answered by the
     * post that the 60,000-character index copy is most likely to have dropped. The chat
     * attaches its material exactly as the write-up does, so the chat box is not the limit;
     * disk is. Half a megabyte a case, thirty cases: a case beyond this is one nobody is
     * still chatting about, and the cut declares itself in the transcript either way. */
    const CHAT_DOC_MAX_CHARS = 500000;
    const CHAT_DOC_KEEP = 30;
    // How many turns of a conversation travel with each new question. The material is the
    // expensive part of the prompt and it goes every time regardless, so this only bounds
    // the history — and a chat that has run past twenty turns has stopped being about one
    // question anyway.
    const CHAT_HISTORY_TURNS = 12;
    // Per-case run state, keyed the same way SELECTED is. Never persisted: a run
    // does not survive the panel closing, and a row still saying "reading…" after
    // a reload would be a lie the panel had no way to correct.
    const ROW_STATE = new Map();

    const RUN = { active: false, stop: false, total: 0, done: 0, failed: 0, kind: 'qa', note: '', saidHow: false, accessBlocked: false, coaching: false };

    /* ---------------------------------------------------------------------
     * SMALL SHARED PIECES
     * ------------------------------------------------------------------- */
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    let toastTimer = null;
    function toast(msg, kind = 'i', ms = 4200) {
        const el = $('toast');
        if (!el) return;
        el.textContent = msg;
        el.className = 'toast show ' + kind;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast'; }, ms);
    }
    /* SHARED WITH backup.js and display-size.js, which are separate files and have no way
     * into this closure. Exposed rather than duplicated: two toast implementations means two
     * places to fix when the timer or the class names change. Both fall back to console.log
     * if this is missing, so load order between the files does not matter. */
    window.qaToast = toast;

    function isExt() {
        return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    }

    async function store(patch) {
        if (!isExt()) return;
        try { await chrome.storage.local.set(patch); } catch (e) { console.warn('QA Tool: could not save', e); }
    }

    async function load(keys) {
        if (!isExt()) return {};
        try { return await chrome.storage.local.get(keys); } catch (e) { return {}; }
    }

    /* A CASE'S IDENTITY, everywhere it needs one — selection, run state, reviews.
     *
     * THE RECORD ID FIRST, not the case number, and that is the opposite of what
     * reads naturally. A case number is what a reviewer and a spreadsheet both
     * mean by "which case", so it is the obvious key — but a case ADDED BY URL
     * has no case number until it has been opened, and the read that fills it in
     * happens in the middle of a run. Key on the number and that case's identity
     * CHANGES under the run: its tick, its row state and any earlier review are
     * all filed under a name that no longer exists. The record id is in the URL
     * and in every list row, and it never changes.
     *
     * The case number is still the fallback for a list view that renders no row
     * key, and migrateKey below covers the remaining case where an identity does
     * move.
     */
    function keyOf(rec) {
        if (!rec) return '';
        return String(rec.recordId || rec.caseNum || rec.url || '').trim();
    }

    // An identity that moved anyway — see keyOf. Everything filed under the old name follows
    // it, so a tick made before a case was read is still a tick after it.
    function migrateKey(from, to) {
        if (!from || !to || from === to) return;
        if (SELECTED.has(from)) { SELECTED.delete(from); SELECTED.add(to); }
        if (ROW_STATE.has(from)) { ROW_STATE.set(to, ROW_STATE.get(from)); ROW_STATE.delete(from); }
        for (const r of REVIEWS) if (r.key === from) { r.key = to; r.id = `${to}|${r.kind}`; }
    }

    function urlOf(rec) {
        if (!rec) return '';
        if (rec.url) return rec.url;
        const origin = (CASES.origin || '').replace(/\/$/, '');
        if (!origin || !rec.recordId) return '';
        return `${origin}/lightning/r/${rec.recordId}/view`;
    }

    /* WHOSE CASE IS THIS, for QA purposes.
     *
     * The owner field first, then whoever last modified it. That order is the
     * opposite of the analyser's queue column, and deliberately: the analyser is
     * answering "who is working this right now", where the last editor is the
     * better answer because a SOTI case owner is routinely a queue. QA is
     * answering "whose handling am I reviewing", and the owner is the person the
     * case was assigned to and the person the coaching row belongs to. Where the
     * owner really is a queue name, the reviewer can see it on the row and put
     * the right name in themselves. */
    function agentOf(rec, data) {
        const cand = [
            data && data.caseOwner, rec && rec.owner,
            data && data.lastModifiedBy, rec && rec.lastModifiedBy
        ];
        for (const c of cand) {
            const v = String(c || '').trim();
            if (v && !/^(queue|unassigned)\b/i.test(v)) return v;
        }
        return 'Unassigned';
    }

    function scoreBand(score) {
        if (!score || score.value === null) return '';
        const n = score.value;
        return n >= 85 ? 'excellent' : n >= 70 ? 'good' : n >= 50 ? 'needs' : 'poor';
    }

    /* ---------------------------------------------------------------------
     * A MODAL, because a side panel has no window.prompt worth relying on
     * ---------------------------------------------------------------------
     * Chrome disables the native dialogs in some extension surfaces and gives no
     * warning when it does — the call simply returns null, which reads exactly
     * like the user pressing Cancel. A control that silently does nothing is
     * worse than no control, so this tool asks its own questions.
     * ------------------------------------------------------------------- */
    function ask(opts) {
        return new Promise((resolve) => {
            const back = document.createElement('div');
            back.className = 'qa-modal-back';
            const box = document.createElement('div');
            box.className = 'qa-modal';
            box.innerHTML =
                `<div class="qa-modal-title">${esc(opts.title || '')}</div>`
                + (opts.note ? `<div class="qa-modal-note">${esc(opts.note)}</div>` : '')
                + (opts.input === false ? '' : `<input class="finput qa-modal-input" type="text" placeholder="${esc(opts.placeholder || '')}" spellcheck="false">`)
                + `<div class="qa-modal-err" style="display:none"></div>`
                + `<div class="qa-modal-acts">`
                + `<button class="btn qa-modal-cancel" type="button">Cancel</button>`
                + `<button class="btn qa-btn-primary qa-modal-ok" type="button">${esc(opts.ok || 'OK')}</button>`
                + `</div>`;
            back.appendChild(box);
            document.body.appendChild(back);

            const input = box.querySelector('.qa-modal-input');
            const err = box.querySelector('.qa-modal-err');
            const close = (value) => { back.remove(); resolve(value); };

            /* A SUGGESTED ANSWER. Used by the "name this list" step, where the suggestion is
             * right most of the time. Selected below, after the focus, so the first keystroke
             * replaces it rather than being appended to it. */
            if (input && opts.value) input.value = opts.value;

            box.querySelector('.qa-modal-cancel').onclick = () => close(null);
            box.querySelector('.qa-modal-ok').onclick = () => {
                const v = input ? input.value.trim() : true;
                const why = opts.validate ? opts.validate(v) : '';
                if (why) { err.textContent = why; err.style.display = ''; return; }
                close(v);
            };
            back.onclick = (e) => { if (e.target === back) close(null); };
            box.onkeydown = (e) => {
                if (e.key === 'Escape') close(null);
                if (e.key === 'Enter' && input) box.querySelector('.qa-modal-ok').click();
            };
            if (input) { input.focus(); if (opts.value) input.select(); }
            else box.querySelector('.qa-modal-ok').focus();
        });
    }

    const confirmAsk = (title, note, ok) => ask({ title, note, ok: ok || 'Yes', input: false });

    /* ---------------------------------------------------------------------
     * THE AI
     * ---------------------------------------------------------------------
     * One entry point, so every prompt in this tool goes through the same
     * failure handling. window.SotiAI is ai-provider.js — the analyser's, whole
     * — and in this build it means the Microsoft 365 Copilot relay and nothing
     * else: the tool drives a Copilot tab in a window of its own, so no case
     * data goes anywhere the browser was not already signed in to.
     * ------------------------------------------------------------------- */
    /* TWO TURNS, NOT ONE — AND THAT IS THE WHOLE OF WHY A CASE NOW GOES UP AS A FILE.
     *
     * `prompt` is either a plain string (a one-off question; the connection test at the
     * bottom of Settings is the only one left) or the `{ system, request }` pair every
     * prompt builder in qa-engine.js returns. The pair is sent as a SYSTEM turn and a USER
     * turn, because that is the only shape ai-provider.js can act on: it splits the system
     * turn at the first bracketed ALL-CAPS heading and uploads everything from there as
     * "<case number>-case-material.txt", leaving the rules and the question in the chat box.
     *
     * Flattened into a single user turn — which is what this did until now — there is no
     * system turn to split, so nothing was ever attached: every audit went into the composer
     * as text, and a case with a long email chain on it was sampled, cut into numbered
     * messages or condensed to fit a limit it did not need to be fitted to. The provider
     * still decides whether a file is warranted — a short case belongs inline, where it
     * costs nothing — this only gives it the chance to decide. See the two-halves note above
     * the prompt builders in qa-engine.js.
     */
    async function askAi(prompt, label, out) {
        if (!window.SotiAI) {
            throw new Error('ai-provider.js did not load, so there is nothing to send this to. Check it sits next to qa-panel.js and reload the extension at chrome://extensions.');
        }
        if (label) window.SotiAI.setConversationLabel(label);
        const messages = (prompt && typeof prompt === 'object')
            ? [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.request }]
            : [{ role: 'user', content: String(prompt || '') }];
        /* `out` rather than the module global alone. A chat sent while a run is going would
         * otherwise have the two calls overwrite each other's record, and the review would
         * carry the chat's delivery or the other way about — a provenance note that is wrong
         * is worse than none, because it is the thing a reviewer would check instead of
         * looking. The global stays for the callers that have nowhere to put one. */
        LAST_DELIVERY = planDelivery(messages);
        if (out) out.delivery = LAST_DELIVERY;
        const res = await window.SotiAI.chat({
            messages,
            stream: false,
            // Low, not zero. A QA write-up is prose and needs to read like it; the facts
            // it is allowed to use are pinned by the prompt rather than by the temperature.
            options: { temperature: 0.2 }
        }, {});
        if (!res || !res.ok) {
            const why = res ? await res.text() : 'no answer';
            const err = new Error(String(why).slice(0, 600));
            /* 403 IS "CHROME WILL NOT LET THE RELAY INTO THE COPILOT TAB" — a missing host
             * permission, which no retry can fix and one click can. Marked, so every caller
             * stops asking at once and puts the Connect Copilot dialog in front of the
             * reviewer instead of spending five attempts on each of thirty cases. */
            if (res && res.status === 403) {
                err.access = true;
                // Not a permission at all: Microsoft sent the tab to its sign-in page.
                err.signin = /ended up on|Sign in to Microsoft 365/i.test(err.message);
            }
            throw err;
        }
        const data = await res.json();
        LAST_DELIVERY = confirmDelivery(out ? out.delivery : LAST_DELIVERY);
        if (out) out.delivery = LAST_DELIVERY;
        const text = (data && data.message && data.message.content) || '';
        if (!text.trim()) throw new Error('The relay came back with an empty answer.');
        return text;
    }

    /* ---------------------------------------------------------------------
     * HOW THE CASE REACHED COPILOT — recorded, not assumed
     * ---------------------------------------------------------------------
     * A write-up built on the whole case and a write-up built on a transcript
     * that was cut into eight messages and trimmed by six hundred thousand
     * characters ARRIVE LOOKING IDENTICAL. Same headers, same confident prose,
     * same score. The only difference is whether it is true — and nothing on the
     * card said which one had happened.
     *
     * So every ask records it. Two halves, because they answer two different
     * questions and only one of them can be known in advance:
     *
     *   planDelivery()    — what ai-provider.js WILL do with this prompt,
     *                       computed by calling ai-provider.js's own builder
     *                       rather than by guessing at its thresholds here.
     *   confirmDelivery() — what the relay actually DID, read back off the stage
     *                       trail. This is the half that catches the case that
     *                       matters most: the upload control was missing or the
     *                       site refused the file, the relay fell back to typing
     *                       the case as text, and the answer came back fine.
     *
     * The result goes on the review record and into the run log, so "the whole
     * case went as a file, nothing trimmed" is something a reviewer can read
     * rather than something they have to take on trust.
     * ------------------------------------------------------------------- */
    let LAST_DELIVERY = null;

    function planDelivery(messages) {
        try {
            if (!window.SotiAI || !window.SotiAI.attachesCaseData || !window.SotiAI.attachesCaseData()) {
                /* No upload path at all — a provider that does not attach, or attachData
                 * switched off. Still worth measuring: "went as chat text" says nothing about
                 * how much text, and how much is the whole question on a long case. */
                const sys = (messages[0] && messages[0].role === 'system') ? messages[0].content : '';
                const seen = E.previewSplit({ system: sys });
                return { mode: 'text', chars: seen.materialChars, messageChars: sys.length };
            }
            // ai-provider.js's own builder, asked the same question the send path asks it.
            // No fetches, no side effects — it is pure string work over the prompt.
            const a = window.SotiAI.bridgeAttachment(messages, {});
            /* NULL MEANS THE CASE WAS TOO SMALL TO BE WORTH A FILE, which is the correct
             * outcome for a short case and not the same thing as the upload path being
             * unavailable. Reporting both as "went as chat text" would put a warning shape
             * on a healthy run — so the message layout is measured and named for what it is. */
            if (!a) {
                const t = window.SotiAI.bridgeParts(messages, {});
                return { mode: 'inline', chars: 0, messageChars: t.chars, parts: t.parts.length, trimmed: t.trimmed || 0 };
            }
            return {
                mode: a.caseAttached ? 'file' : 'inline',
                file: a.caseAttached && a.attachments[0] ? a.attachments[0].name : '',
                chars: a.chars || 0,
                messageChars: a.messageChars || 0,
                parts: a.parts.length,
                trimmed: a.trimmed || 0,
                attachTrimmed: a.attachTrimmed || 0
            };
        } catch (e) { return null; }
    }

    function confirmDelivery(plan) {
        const d = plan ? Object.assign({}, plan) : null;
        try {
            const trail = window.SotiAI.lastBridgeDiag ? window.SotiAI.lastBridgeDiag() : [];
            /* THE LAST ATTACH LINE, NOT THE FIRST. One request can drive the relay twice —
             * the composer measures itself, the adapter re-splits and sends again — and the
             * trail is cumulative. An attempt that fell back followed by one that attached is
             * an attachment, and reading the first entry would report the opposite. */
            const lastOf = (re) => { for (let i = trail.length - 1; i >= 0; i--) if (re.test(trail[i])) return trail[i]; return ''; };
            const fell = lastOf(/^attach-fallback:/);
            const done = lastOf(/^attach:/);
            // The case file's real name — its time stamp is set when it is sent, seconds after
            // the plan above was made. The case material is always the first file.
            const sentAs = lastOf(/^attach-name:/).replace(/^attach-name:\s*/, '').split(', ')[0];
            if (d && sentAs && d.mode === 'file') d.file = sentAs;
            if (fell && done) {
                // Both happened. Whichever the relay did LAST is what the answer stands on.
                const win = trail.lastIndexOf(fell) > trail.lastIndexOf(done) ? 'fell' : 'done';
                if (win === 'done') { if (d) d.via = done.replace(/^attach:\s*/, ''); return d; }
            }
            if (!d) return d;
            if (fell) { d.mode = 'text'; d.fellBack = fell.replace(/^attach-fallback:\s*/, ''); }
            else if (done) d.via = done.replace(/^attach:\s*/, '');
        } catch (e) { /* the plan is still worth keeping */ }
        return d;
    }

    /* One line, in a reviewer's words rather than a developer's. */
    function deliveryLine(d) {
        if (!d) return '';
        const n = (x) => Number(x || 0).toLocaleString();
        /* "a 8,125-character question" is the kind of small wrongness that makes a tool read
         * as machine-written. The article follows how the number is SAID, so what decides it
         * is the LEADING GROUP of three: 8,125 is "eight thousand" and takes "an", while
         * 1,125 is "one thousand" and does not. */
        const a = (x) => {
            const t = String(Math.max(0, Math.round(Number(x) || 0)));
            const g = Number(t.slice(0, ((t.length - 1) % 3) + 1));
            return (g === 8 || g === 11 || g === 18 || (g >= 80 && g <= 89) || (g >= 800 && g <= 899)) ? 'an' : 'a';
        };
        if (d.mode === 'file') {
            return `the case went to Copilot as ${d.file} — ${n(d.chars)} characters`
                + (d.attachTrimmed ? `, of which ${n(d.attachTrimmed)} were trimmed from the end` : ', complete')
                + `, with ${a(d.messageChars)} ${n(d.messageChars)}-character question beside it`
                + (d.trimmed ? ` (the question itself lost ${n(d.trimmed)} characters)` : '');
        }
        if (d.mode === 'inline') {
            return `the case was small enough to send in the message itself (${n(d.messageChars)} characters`
                + (d.parts > 1 ? `, ${d.parts} parts` : '') + ')'
                + (d.trimmed ? `, trimmed by ${n(d.trimmed)} characters` : '');
        }
        return d.fellBack
            ? `the upload was refused, so the case went as chat text instead — ${d.fellBack}`
            : `the case went as chat text${d.chars ? ` (${n(d.chars)} characters of material)` : ''}`;
    }

    /* WORTH INTERRUPTING A REVIEWER FOR? Only when evidence was lost, or when the case did
     * not travel the way it was meant to. A clean file upload is the expected outcome and
     * saying so on every one of thirty cases is noise. */
    function deliveryWorrying(d) {
        if (!d) return false;
        if (d.fellBack) return true;
        if (d.attachTrimmed || d.trimmed) return true;
        return false;
    }

    /* ---------------------------------------------------------------------
     * CONNECT COPILOT — the analyser's dialog, for the same reason it has one
     * ---------------------------------------------------------------------
     * Every review is written through the reviewer's own Microsoft 365 Copilot tab,
     * and until Chrome lets the extension read that tab nothing works. Microsoft
     * now forwards m365.cloud.microsoft/chat to copilot.cloud.microsoft, so an
     * install that was granted the first host only is locked out of the second —
     * which is the "Signing in redirected the tab to https://copilot.cloud.microsoft"
     * failure, five times per case, on every case of a run.
     *
     * Chrome only shows its permission prompt in answer to a click, so this dialog
     * IS that click: one button, Chrome's prompt follows it, and the relay test runs
     * by itself the moment access is granted. It opens when the panel starts without
     * the access, when a run or a coaching build is started without it, and when the
     * relay reports a refusal mid-run. A run that was waiting on it starts once the
     * test passes.
     * ------------------------------------------------------------------- */
    let CPS_THEN = null;

    async function copilotAccessMissing() {
        try {
            if (!window.SotiAI || typeof window.SotiAI.bridgeAccessMissing !== 'function') return [];
            return await window.SotiAI.bridgeAccessMissing();
        } catch (e) { return []; }
    }

    function copilotSetupOpen() {
        const back = $('mCopilotSetup');
        return !!(back && back.style.display === 'flex');
    }

    /* `force` opens it even when the panel is not just starting (a run asked for it);
     * `then` is what to do once Copilot has answered the test. */
    async function offerCopilotSetup(opts = {}) {
        try {
            if (!isExt() || !window.SotiAI) return false;
            if (opts.then) CPS_THEN = opts.then;
            if (copilotSetupOpen()) return true;
            const missing = await copilotAccessMissing();
            if (!missing.length && !opts.force) return false;
            // Not on top of a question the reviewer is in the middle of answering.
            if (!opts.force && document.querySelector('.qa-modal-back')) return false;
            const back = $('mCopilotSetup');
            if (!back) return false;
            paintCopilotSetup(missing.length ? 'ask' : opts.signin ? 'signin' : 'granted');
            back.style.display = 'flex';
            setTimeout(() => { try { $('cpsGrant').focus(); } catch (e) {} }, 30);
            return true;
        } catch (e) { return false; }
    }

    function closeCopilotSetup() {
        const back = $('mCopilotSetup');
        if (back) back.style.display = 'none';
        paintCopilotSetupProgress('ask', '');
    }

    /* One dialog, six states: asking, already granted (the relay itself refused), testing,
     * connected, refused by Chrome, and a failed test that says which step. */
    function paintCopilotSetup(state, detail = '') {
        const msg = $('cpsMsg'), status = $('cpsStatus'), grant = $('cpsGrant'), later = $('cpsLater');
        if (!msg || !status || !grant || !later) return;
        status.className = 'cps-status' + (state === 'ok' ? ' is-ok' : (state === 'fail' || state === 'refused') ? ' is-fail' : state === 'testing' ? ' is-busy' : '');
        status.hidden = state === 'ask' || state === 'granted' || state === 'signin';
        status.textContent = state === 'refused'
            ? 'Chrome did not grant access to Copilot. Press the button again and choose Allow — or grant it later under ⋮ → Settings → The AI.'
            : detail;
        grant.hidden = state === 'testing' || state === 'ok';
        grant.disabled = false;
        later.textContent = state === 'ok' ? 'Done' : 'Not now';
        later.disabled = state === 'testing';
        if (state === 'ask' || state === 'refused') {
            msg.textContent = 'The QA Tool writes its reviews through your Microsoft 365 Copilot, in the browser you are already signed in to. '
                + 'Chrome needs your permission for it to read the Copilot tab — Microsoft now moves the chat from m365.cloud.microsoft '
                + 'to copilot.cloud.microsoft, so both are asked for together. Press the button and Chrome will ask you; '
                + 'once it is allowed, the connection is tested straight away.';
            grant.textContent = 'Grant access to Copilot';
        } else if (state === 'signin') {
            msg.textContent = 'Copilot sent the QA Tool to Microsoft\'s sign-in page, so you are not signed in to Microsoft 365 in this browser. '
                + 'Open Copilot, sign in with your work account, then come back and test the connection.';
            grant.textContent = 'Open Copilot to sign in';
        } else if (state === 'granted') {
            msg.textContent = 'Chrome already allows the QA Tool to read Copilot, but the relay could not get in. '
                + 'Test the connection to see which step fails — most often you are not signed in to Microsoft 365 in this browser.';
            grant.textContent = 'Test the connection';
        } else {
            msg.textContent = 'Chrome now allows the QA Tool to read your Copilot tab. Testing the connection opens Copilot in a small '
                + 'window of its own — that window is the one the QA Tool uses from now on.';
            if (state === 'fail') grant.textContent = 'Test again';
        }
        paintCopilotSetupProgress(state, state === 'refused' ? '' : detail);
    }

    /* THE PERCENTAGE UNDER THE STATUS LINE — the analyser's, band for band. A test takes up
     * to half a minute (Copilot has to open and answer), and a line that does not move for
     * that long reads as stuck. Each stage owns a band; inside it the bar creeps towards the
     * top and never claims a stage it has not reached. */
    const CPS_PROGRESS_BANDS = [
        [/Sending a test/i, 45, 96],
        [/Opening Copilot/i, 12, 45],
        [/Access granted|Starting/i, 3, 12]
    ];
    function paintCopilotSetupProgress(state, detail) {
        const box = $('cpsProgress'), fill = $('cpsProgressFill'), pct = $('cpsProgressPct');
        if (!box || !fill || !pct) return;
        const p = paintCopilotSetupProgress;
        const show = (v) => {
            p.shown = v;
            fill.style.width = v.toFixed(1) + '%';
            pct.textContent = Math.floor(v) + '%';
        };
        const stop = () => { if (p.timer) clearTimeout(p.timer); p.timer = null; };
        if (state === 'ok') { stop(); box.hidden = false; box.classList.add('is-done'); show(100); return; }
        if (state !== 'testing') { stop(); box.hidden = true; box.classList.remove('is-done'); show(0); return; }
        const band = CPS_PROGRESS_BANDS.find(([re]) => re.test(detail || '')) || [null, 3, 12];
        box.hidden = false;
        box.classList.remove('is-done');
        p.cap = band[2];
        if (!(p.shown >= band[1])) show(band[1]);
        if (p.timer) return;
        const tick = () => {
            p.timer = null;
            if (!copilotSetupOpen() || box.hidden || box.classList.contains('is-done')) return;
            const gap = (p.cap || 0) - (p.shown || 0);
            if (gap > 0.05) show(p.shown + Math.max(0.05, gap * 0.04));
            p.timer = setTimeout(tick, 250);
        };
        p.timer = setTimeout(tick, 250);
    }

    /* ONE TEST, EVERY WAY IN — the dialog, Settings' Grant button and Settings' Test button.
     * Two stages on purpose: the relay fails three ways that look identical from outside (no
     * permission, no injection, injected but no message box), and the ping tells them apart
     * before a real prompt is spent. Resolves { ok, host, said } or { ok: false, error };
     * never throws. Two presses at once share the first run. */
    let RELAY_TEST = null;
    function runRelayTest(onStep = () => {}) {
        if (RELAY_TEST) return RELAY_TEST;
        RELAY_TEST = (async () => {
            try {
                if (!window.SotiAI) throw new Error('ai-provider.js did not load — check it is in the extension folder and reload the extension.');
                onStep('Opening Copilot…');
                const ping = await window.SotiAI.pingBridge();
                onStep(`Copilot is open (${ping.host}) — Sending a test…`);
                const said = await askAi('Reply with exactly: QA TOOL OK', 'QA Tool test');
                return { ok: true, host: ping.host, said: said.trim() };
            } catch (e) {
                const trail = (window.SotiAI && window.SotiAI.lastBridgeDiag && window.SotiAI.lastBridgeDiag()) || [];
                console.error('[QA Tool relay test]', e, trail);
                return { ok: false, error: (e && e.message) || String(e) };
            }
        })();
        RELAY_TEST.finally(() => { RELAY_TEST = null; refreshAiStatus(); });
        return RELAY_TEST;
    }

    async function testFromCopilotSetup() {
        paintCopilotSetup('testing', 'Starting…');
        const r = await runRelayTest((step) => paintCopilotSetup('testing', step));
        if (r.ok) {
            paintCopilotSetup('ok', `✓ Copilot is connected — ${r.host} replied “${r.said.slice(0, 40)}”.`
                + (CPS_THEN ? ' Starting your run…' : ' You are ready to go.'));
            const then = CPS_THEN;
            CPS_THEN = null;
            if (then) setTimeout(() => { closeCopilotSetup(); then(); }, 900);
        } else {
            paintCopilotSetup('fail', `The connection could not be verified: ${r.error} `
                + 'Make sure you are signed in to Microsoft 365 Copilot in this browser, then press Test again.');
        }
    }

    async function grantFromCopilotSetup() {
        const grant = $('cpsGrant');
        if (!window.SotiAI) return;
        // After a failed test, or when access was already there, only the test needs running.
        if (grant && /^Test/.test(grant.textContent)) return testFromCopilotSetup();
        // Signed out: a normal, visible tab is where Microsoft's sign-in can do its job.
        if (grant && /sign in/i.test(grant.textContent)) {
            try { chrome.tabs.create({ url: 'https://m365.cloud.microsoft/chat/', active: true }); } catch (e) { /* the message says where */ }
            grant.textContent = 'Test again';
            return;
        }
        if (grant) grant.disabled = true;
        // The permission request FIRST, before anything else is awaited: this click is the
        // only thing Chrome accepts it from.
        let ok = false;
        try { ok = await window.SotiAI.ensurePermissions(); } catch (e) { ok = false; }
        refreshAiStatus();
        if (!ok) { paintCopilotSetup('refused'); return; }
        return testFromCopilotSetup();
    }

    /* The provider raises this whenever Chrome refuses it a host in the relay's own group —
     * mid-run, mid-chat, or from Settings' own test. The dialog puts the button in front of
     * the reviewer instead of leaving the fix described in an error they cannot click. */
    window.addEventListener('soti-ai-needs-permission', () => { offerCopilotSetup({ force: true }); });

    /* ---------------------------------------------------------------------
     * BOOT
     * ------------------------------------------------------------------- */
    async function boot() {
        const got = await load([K.cases, K.reviews, K.coaching, K.rules, K.roster, K.lastList,
                                K.lists, K.month, K.chats, K.context,
                                K.columns, K.columnsSeen, K.colWidths, K.revFolders]);
        if (got[K.cases] && Array.isArray(got[K.cases].cases)) CASES = got[K.cases];
        if (Array.isArray(got[K.reviews])) REVIEWS = got[K.reviews];
        if (Array.isArray(got[K.coaching])) COACHING = got[K.coaching];
        if (got[K.rules]) RULES = Object.assign(RULES, got[K.rules]);
        if (Array.isArray(got[K.roster]) && got[K.roster].length) ROSTER = got[K.roster];
        if (got[K.lastList]) LAST_LIST = got[K.lastList];
        if (Array.isArray(got[K.lists])) LISTS = got[K.lists].filter(l => l && l.url);
        await offerDefaultLists();
        SHEET_MONTH = got[K.month] || defaultMonth();
        if (got[K.chats] && typeof got[K.chats] === 'object') CHATS = got[K.chats];
        if (got[K.context] && typeof got[K.context] === 'object') CONTEXT = got[K.context];
        if (Array.isArray(got[K.revFolders])) REV_OPEN = new Set(got[K.revFolders].map(String));
        // Before the first render, so the queue is drawn in the reviewer's own layout rather
        // than drawn in the default and then rearranged under them.
        loadColumnPrefs(got);
        applyColWidths();

        // The GitHub update check is gone; so is what it remembered.
        if (isExt()) { try { chrome.storage.local.remove('qa_update_state'); } catch (e) { /* nothing to forget */ } }

        if (window.SotiAI) {
            try { await window.SotiAI.load(); } catch (e) { /* defaults */ }
            /* THE CASE FILE, AND NOTHING ALONGSIDE IT.
             *
             * ai-provider.js is the analyser's file, whole, and left to itself it uploads
             * knowledge/*.md next to the case material. That is right in the analyser, which
             * ships those files and answers technical questions out of them. This extension
             * ships no knowledge/ folder, so the seven fetches 404 once per session and there
             * is nothing to attach even when they do not — and an audit asks how a record was
             * handled, which SOTI's port matrix has no bearing on. Set at run time only: the
             * panel never calls SotiAI.save(), so this does not write itself into the
             * provider settings the analyser shares. */
            try { window.SotiAI.config.bridge.attachKnowledge = false; } catch (e) { /* the fetches merely fail */ }

            /* AND THE UPLOAD FLOOR COMES OFF, WHICH IS WHY CASES WERE STILL BEING TYPED.
             *
             * ai-provider.js will not attach material smaller than attachMinChars — 8,000
             * characters by default — on the sound reasoning that a small payload is not
             * worth a round trip and a file in the engineer's OneDrive.
             *
             * That number was set for the ANALYSER, whose payload is a log bundle measured in
             * megabytes, and it is the wrong shape of number for a case audit. A support case
             * is PROSE. Measured against real shapes: three messages is 1,900 characters, ten
             * is 3,300, twenty is 5,200 — and a busy case with THIRTY messages on it still
             * comes to about 7,200. Every one of those is under the floor, so every one of
             * them went into the chat box as text and no attachment was ever offered. The
             * only cases that cleared 8,000 were the ones with a long quoted email chain in
             * them, which is why this looked intermittent rather than broken.
             *
             * So for this tool the case ALWAYS goes as a file. The cost is a few seconds and
             * one small .txt per case; what it buys is a message that stays the same tiny
             * size whatever the case is, one place for the model to read evidence from, and
             * no case ever competing with its own instructions for room. Set at run time, like
             * attachKnowledge above — the panel never calls SotiAI.save(), so this does not
             * write itself into the provider settings the analyser shares. */
            try { window.SotiAI.config.bridge.attachMinChars = 1; } catch (e) { /* the floor stays */ }
        }

        applyVersion();
        wire();
        wireTerms();
        fillSettings();
        renderQaColumns();
        renderAll();
        paintIntegrity();
        wireUpdates();
        paintTermsLine();
        // The terms first, then — once the panel is on screen, and only when Chrome has not
        // given it Copilot yet — the Copilot connection.
        if (isExt() && !(await termsAcceptance())) openTermsDialog(false);
        else setTimeout(() => { offerCopilotSetup(); }, 700);
    }

    /* ---------------------------------------------------------------------
     * TERMS OF USE — the SOTI AI Analyser's: shown before anything else the first time the
     * panel is opened (and again whenever TERMS_VERSION changes), accepted with "I agree",
     * recorded on the device with the date, and readable at any time in Settings. The
     * backdrop covers the whole panel, so nothing works until they are accepted.
     * ------------------------------------------------------------------- */
    // 2026-10-23.2: the terms now name the integrity check — everyone sees them again.
    const TERMS_VERSION = '2026-10-23.2';
    const TERMS_KEY = 'qa_terms_accepted';

    async function termsAcceptance() {
        try {
            const got = await chrome.storage.local.get(TERMS_KEY);
            const t = got && got[TERMS_KEY];
            return t && t.version === TERMS_VERSION ? t : null;
        } catch (e) { return null; }
    }

    function openTermsDialog(readOnly) {
        const back = $('mTerms');
        if (!back) return;
        $('termsAgree').hidden = !!readOnly;
        $('termsClose').hidden = !readOnly;
        back.style.display = 'flex';
        setTimeout(() => { try { (readOnly ? $('termsClose') : $('termsAgree')).focus(); } catch (e) { /* not on screen */ } }, 30);
    }

    async function paintTermsLine() {
        const el = $('termsAcceptedLine');
        if (!el) return;
        const t = await termsAcceptance();
        el.textContent = t ? `Terms of use accepted ${new Date(t.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}.` : 'Terms of use not yet accepted.';
    }

    /* ---------------------------------------------------------------------
     * THE INTEGRITY CHECK — the SOTI AI Analyser's, with the analyser's key. Every official
     * copy carries integrity.json: a SHA-256 of each code file and an ECDSA P-256 signature
     * over that list, made with a private key only the owner holds (see
     * .qa-build-tools/sign-integrity.mjs, which is not shipped). At start-up this copy hashes
     * its own files and checks the signature with INTEGRITY_PUBLIC_KEY. A file changed by
     * hand or by an AI tool, a missing signature, or a forged one, and a red strip across
     * every screen says this is an unofficial copy — and Settings names the changed files.
     * Without the private key a changed copy cannot be made to pass.
     * ------------------------------------------------------------------- */
    const INTEGRITY_PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgHZuCCqcKFGFujPwkocaDwObUx/bPnd17DCkJOIKIV5g0YAEnYCXLy7D+VJw9ta7OOpCMBuxNb1noBcbcvQLzQ==';
    const INTEGRITY_OWNER = 'Ayodeji Augustine';

    // manifest.json is fingerprinted by its content: keys sorted, no spacing (sign-integrity.mjs does the same).
    function integrityCanonJson(text) {
        const c = (v) => Array.isArray(v) ? v.map(c) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => { o[k] = c(v[k]); return o; }, {}) : v;
        return JSON.stringify(c(JSON.parse(text)));
    }

    // The exact bytes the owner signed — sign-integrity.mjs builds the same string.
    function integrityPayload(rec) {
        const files = rec.files || {};
        return JSON.stringify([1, rec.by, rec.build, Object.keys(files).sort().map(k => [k, files[k]])]);
    }

    /* { status: 'verified' | 'modified' | 'unsigned' | 'forged' | 'unchecked', changed: [file…], build } */
    async function verifyIntegrity() {
        const unchecked = { status: 'unchecked', changed: [] };
        if (!isExt() || typeof chrome.runtime.getURL !== 'function') return unchecked;
        const subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null;
        if (!subtle) return unchecked;
        const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
        const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
        let rec = null;
        try {
            const res = await fetch(chrome.runtime.getURL('integrity.json'), { cache: 'no-store' });
            if (res.ok) rec = await res.json();
        } catch (e) { rec = null; }
        if (!rec || !rec.files || !rec.sig) return { status: 'unsigned', changed: [] };
        try {
            const key = await subtle.importKey('spki', b64(INTEGRITY_PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const good = rec.by === INTEGRITY_OWNER && await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(rec.sig),
                new TextEncoder().encode(integrityPayload(rec)));
            if (!good) return { status: 'forged', changed: [], build: rec.build };
        } catch (e) { return { status: 'forged', changed: [], build: rec.build }; }
        const changed = [];
        for (const [file, want] of Object.entries(rec.files)) {
            try {
                const res = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
                if (!res.ok) { changed.push(file); continue; }
                let text = (await res.text()).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
                // manifest.json by its content — a browser installing a .crx writes it out in its own layout.
                if (file === 'manifest.json') text = integrityCanonJson(text);
                if (hex(await subtle.digest('SHA-256', new TextEncoder().encode(text))) !== want) changed.push(file);
            } catch (e) { changed.push(file); }
        }
        // A code file added to the folder that the signature does not cover is a change too.
        for (const file of ['QA_Tool.html', 'manifest.json', 'qa-panel.js', 'qa-engine.js', 'ai-provider.js', 'copilot-bridge.js',
                            'background.js', 'content.js', 'case-reader.js', 'reader-wake.js', 'display-size.js', 'backup.js',
                            'updater.js', 'styles.css', 'qa-styles.css']) {
            if (!(file in rec.files)) changed.push(file);
        }
        return { status: changed.length ? 'modified' : 'verified', changed, build: rec.build };
    }

    async function paintIntegrity() {
        const r = await verifyIntegrity();
        paintIntegrity.result = r;
        const line = $('integrityStatus'), bar = $('integrityBanner');
        const changedList = r.changed.slice(0, 4).join(', ') + (r.changed.length > 4 ? ` and ${r.changed.length - 4} more` : '');
        const bad = r.status === 'modified' || r.status === 'unsigned' || r.status === 'forged';
        if (line) {
            line.className = 'about-integrity' + (r.status === 'verified' ? ' is-ok' : bad ? ' is-bad' : '');
            line.textContent = r.status === 'verified' ? `✓ Verified original — signed by ${INTEGRITY_OWNER} (build ${r.build}).`
                : r.status === 'modified' ? `⚠ This copy has been changed from the one ${INTEGRITY_OWNER} published: ${changedList}.`
                : r.status === 'unsigned' ? `⚠ This copy carries no signature from ${INTEGRITY_OWNER}.`
                : r.status === 'forged' ? `⚠ This copy's signature is not ${INTEGRITY_OWNER}'s.`
                : 'This copy could not be checked here.';
        }
        if (bar) {
            bar.hidden = !bad;
            bar.textContent = !bad ? ''
                : `⚠ Unofficial copy — this QA Tool is not the version published by ${INTEGRITY_OWNER}`
                  + (r.status === 'modified' ? ` (changed: ${changedList})`
                     : r.status === 'unsigned' ? ' (integrity.json, its signature, is missing from this folder)'
                     : r.status === 'forged' ? ' (its signature does not check out)' : '')
                  + '. It is not supported and may not work as intended.';
        }
        if (bad) console.warn(`[QA Tool] integrity: ${r.status}`, r.changed);
        return r;
    }

    /* ---------------------------------------------------------------------
     * UPDATES FROM THE SHARED FOLDER — the analyser's (Global 1.3.2); see updater.js
     * ---------------------------------------------------------------------
     * The background finds a complete, signed release in the extension's own folder (OneDrive
     * brings it down from the shared folder this copy was loaded from) and restarts onto it when
     * the panel is closed. While the panel is OPEN it is never pulled from under the reviewer: a
     * bar says "Version X is ready — Restart now". It restarts by itself only when the panel has
     * been out of sight for ten minutes with nothing running. Everything this tool keeps is
     * written to storage as it changes, so a restart loses nothing but a run in progress — which
     * is why a run, a sync, a chat answer or the coaching build holds it off. After the restart,
     * the panel says what it was updated to.
     * ------------------------------------------------------------------- */
    const UPD = { ready: null, dismissed: '', hiddenSince: 0, restarting: false };

    // Something is running that a restart would cut off.
    function updPanelBusy() {
        const sync = $('btnSyncCaseList');
        return !!(RUN.active || RUN.coaching || CHAT_BUSY || (sync && sync.disabled));
    }

    function paintUpdateBanner() {
        const bar = $('updateBanner');
        if (!bar) return;
        const show = !!(UPD.ready && UPD.ready.to !== UPD.dismissed);
        bar.hidden = !show;
        if (!show) return;
        const short = (v) => String(v || '').split(' ')[0];
        $('updateBannerTitle').textContent = `Version ${short(UPD.ready.to)} is ready. Restarting takes a second, and your reviews are kept.`;
        $('updateBannerTitle').title = `Installed: ${UPD.ready.from}. New: ${UPD.ready.to}. Restart now, or it is applied by itself when the panel is closed.`;
    }

    async function updRestartNow(auto) {
        if (UPD.restarting || !window.QaUpdater) return;
        if (!auto && updPanelBusy()) {
            const ok = await confirmAsk('Restart in the middle of this?',
                'Something is still running — a QA run, a sync or an answer being written. Restarting now stops it; '
                + 'reviews already finished are kept. Or press × and it updates by itself once the panel is closed.',
                'Restart now');
            if (!ok) return;
        }
        UPD.restarting = true;
        const go = $('updateBannerGo');
        if (go) { go.disabled = true; go.textContent = 'Restarting…'; }
        try {
            // A version the browser has downloaded (installed by IT policy): restarting is what applies it.
            if (UPD.ready && UPD.ready.crx) { await window.QaUpdater.apply(UPD.ready); return; }
            // Checked again at the moment of restarting: the folder may have changed since.
            const r = await window.QaUpdater.check();
            if (r.state !== 'ready') {
                UPD.ready = null;
                paintUpdateBanner();
                if (!auto) toast('The update is not ready yet — it is still arriving. It is applied by itself when it is.', 'i', 6000);
                return;
            }
            await window.QaUpdater.apply(r);
        } catch (e) {
            console.warn('[QA Tool] update restart failed', e);
        } finally {
            UPD.restarting = false;
            if (go) { go.disabled = false; go.textContent = 'Restart now'; }
        }
    }

    function updShowReady(info) {
        if (!info || !info.to) return;
        const isNew = !UPD.ready || UPD.ready.to !== info.to;
        UPD.ready = { from: info.from, to: info.to, crx: !!info.crx };
        paintUpdateBanner();
        if (isNew) console.log(`[QA Tool] ${info.to} is ready in the shared folder (installed: ${info.from}).`);
    }

    function wireUpdates() {
        if (!isExt() || !window.QaUpdater) return;
        if ($('updateBannerGo')) $('updateBannerGo').onclick = () => updRestartNow(false);
        if ($('updateBannerLater')) $('updateBannerLater').onclick = () => {
            UPD.dismissed = (UPD.ready && UPD.ready.to) || '';
            paintUpdateBanner();
            toast('OK — the update is applied by itself when you close the panel.', 'i', 5000);
        };
        try {
            chrome.runtime.onMessage.addListener((m) => {
                if (m && m.type === 'QA_UPDATE_READY') updShowReady(m);
            });
        } catch (e) { /* the background tells nobody — the panel's own look below still finds it */ }

        // The panel's own look, once it has settled — so a release that arrived while it was closed shows at once.
        setTimeout(async () => {
            try {
                const pend = ((await chrome.storage.session.get('qa_update_crx_pending')) || {}).qa_update_crx_pending;
                if (pend && pend.to) { updShowReady(pend); return; }
            } catch (e) { /* none waiting */ }
            try { const r = await window.QaUpdater.check(); if (r.state === 'ready') updShowReady(r); } catch (e) { /* the background looks too */ }
        }, 15000);

        // Out of sight for ten minutes with nothing running: restart onto it then.
        document.addEventListener('visibilitychange', () => {
            UPD.hiddenSince = document.visibilityState === 'hidden' ? Date.now() : 0;
        });
        setInterval(() => {
            if (!UPD.ready || UPD.restarting) return;
            if (document.visibilityState === 'hidden' && UPD.hiddenSince && Date.now() - UPD.hiddenSince >= 10 * 60000 && !updPanelBusy()) {
                updRestartNow(true);
            }
        }, 60000);

        /* "Updated to …" — once, the first time the panel opens on a new version, however it got
         * there: a release in the shared folder, an IT-policy update, or a browser restart. */
        try {
            const SEEN_KEY = 'qa_version_seen';
            chrome.storage.local.get([window.QaUpdater.APPLIED_KEY, SEEN_KEY]).then((got) => {
                const m = chrome.runtime.getManifest();
                const running = String(m.version_name || m.version);
                const note = got && got[window.QaUpdater.APPLIED_KEY];
                // The version seen last, or — on a panel never opened before — the one a restart note names.
                const prev = (got && got[SEEN_KEY]) || (note && Date.now() - (note.at || 0) < 3 * 86400000 ? note.from : '');
                chrome.storage.local.set({ [SEEN_KEY]: running });
                if (note) chrome.storage.local.remove(window.QaUpdater.APPLIED_KEY);
                if (!prev || prev === running) return;
                const short = (v) => String(v || '').split(' ')[0];
                setTimeout(() => toast(`Updated to version ${short(running)} (from ${short(prev)}). Everything you had is still here.`, 's', 7000), 2500);
            }).catch(() => {});
        } catch (e) { /* nothing to say */ }
    }

    function wireTerms() {
        if ($('termsAgree')) $('termsAgree').onclick = async () => {
            try { await chrome.storage.local.set({ [TERMS_KEY]: { version: TERMS_VERSION, at: new Date().toISOString() } }); } catch (e) { /* asked again next start */ }
            $('mTerms').style.display = 'none';
            paintTermsLine();
            // Accepted: now the Copilot connection, if Chrome has not given it yet.
            setTimeout(() => { offerCopilotSetup(); }, 300);
        };
        if ($('termsClose')) $('termsClose').onclick = () => { $('mTerms').style.display = 'none'; };
        if ($('termsRead')) $('termsRead').onclick = (e) => { e.preventDefault(); openTermsDialog(true); };
        // The first-start dialog does not close on Esc: "I agree" is the only way past it.
        if ($('mTerms')) $('mTerms').addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            if (!$('termsClose').hidden) $('termsClose').click();
        });
    }

    function defaultMonth() {
        try { return new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
        catch (e) { return ''; }
    }

    function applyVersion() {
        const el = $('appVersion');
        if (!el) return;
        try {
            const v = isExt() && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '';
            if (v) el.textContent = 'v' + v; else el.style.display = 'none';
        } catch (e) { el.style.display = 'none'; }
    }

    /* ---------------------------------------------------------------------
     * VIEWS
     * ------------------------------------------------------------------- */
    const VIEWS = {
        cases: 'viewCases', reviews: 'viewReviews', chat: 'viewChat',
        sheet: 'viewSheet', coaching: 'viewCoaching', settings: 'viewSettings'
    };

    function switchView(name) {
        if (!VIEWS[name]) return;
        VIEW = name;
        for (const [k, id] of Object.entries(VIEWS)) {
            const el = $(id);
            if (el) el.style.display = k === name ? '' : 'none';
        }
        for (const t of document.querySelectorAll('.tab-item')) {
            t.classList.toggle('active', t.dataset.view === name);
        }
        if (name === 'sheet') renderSheet();
        if (name === 'coaching') renderCoaching();
        if (name === 'reviews') renderReviews();
        if (name === 'chat') renderChat();
        // Re-read on every visit: Chrome's grant can change behind the panel's back.
        if (name === 'settings') refreshAiStatus();
        // Menus and the column chooser belong to the Cases tab and do not follow you off it.
        if (name !== 'cases') {
            closeMenu();
            closeToolbarMenus();
            const cols = $('ocColsPanel');
            if (cols) cols.style.display = 'none';
            const cog = $('ocColumns');
            if (cog) cog.classList.remove('active');
        }
    }

    function renderAll() {
        renderCases();
        renderReviews();
        renderSheet();
        renderCoaching();
        renderChat();
        renderCounts();
    }

    function renderCounts() {
        const c = $('tabCasesCount');
        if (c) c.textContent = CASES.cases.length ? String(CASES.cases.length) : '';
        /* THE CASES PILL, as the analyser draws it: the count in a well of its own, and a red
         * dot while anything in the queue is waiting on SOTI. */
        const tab = $('tabCases');
        if (tab) {
            const onUs = CASES.cases.filter(x => statusIsOnSoti(x.status)).length;
            tab.classList.toggle('has-count', CASES.cases.length > 0);
            tab.title = CASES.cases.length
                ? `${CASES.cases.length} case${CASES.cases.length === 1 ? '' : 's'}${onUs ? `, ${onUs} on SOTI (waiting on SOTI response, or new and not picked up)` : ''}`
                : 'Cases — the queue you QA from';
            const dot = $('tabCasesDot');
            if (dot) dot.hidden = !onUs;
        }
        const r = $('tabReviewsCount');
        if (r) {
            const bad = REVIEWS.filter(incomplete).length;
            r.textContent = REVIEWS.length ? String(REVIEWS.length) : '';
            r.classList.toggle('qa-count-bad', bad > 0);
            r.title = bad ? `${bad} of ${REVIEWS.length} could not be written up — open Reviews to re-run them.` : '';
        }
        const ch = $('tabChatCount');
        if (ch) {
            const live = Object.values(CHATS).filter(c => c && c.msgs && c.msgs.length).length;
            ch.textContent = live ? String(live) : '';
        }
    }

    /* =====================================================================
     * WHAT A ROW SHOWS — the queue's tiers, colours and columns
     * =====================================================================
     * Lifted from the analyser's queue, because it is the same queue: the same
     * Salesforce list view, read by the same scraper, and a reviewer who has
     * learnt to find a case by its tier stripe and its severity pill there
     * should not have to learn a second, poorer list here.
     *
     * What is NOT lifted is anything this tool has no data for. The analyser's
     * "Last Sent" and "Last msg" columns are read from a case's FEED, which a
     * QA run reads but a list sync does not, so they are not offered — a column
     * that can only ever print an em dash is worse than no column at all. In
     * their place are the two columns this tool has and the analyser does not:
     * the 30/60/90 milestone and the QA score.
     * ------------------------------------------------------------------- */

    /* ENTITLEMENT TIERS. Salesforce names these per contract — "Enterprise Service" and
     * "Enterprise Plus Service" are two entitlements and one tier — so matching is on the
     * tier word rather than the whole string. Order is the order they are worked in, not
     * alphabetical, and anything unrecognised goes last under its own heading rather than
     * being forced into a tier it may not belong to: a case shown as Enterprise when it is
     * not is worse than one shown as unclassified. */
    const TIERS = [
        { key: 'enterprise', label: 'Enterprise', match: /enterprise/i },
        { key: 'premium',    label: 'Premium',    match: /premium/i },
        { key: 'standard',   label: 'Standard',   match: /standard/i }
    ];
    const TIER_OTHER = { key: 'other', label: 'Other entitlements', match: null };
    const TIER_NONE  = { key: 'none',  label: 'No entitlement listed', match: null };

    function entitlementTier(name) {
        const t = String(name || '').trim();
        if (!t) return TIER_NONE;
        return TIERS.find(x => x.match.test(t)) || TIER_OTHER;
    }

    // The tier's working order, then unrecognised, then unlisted. The order INSIDE a tier is
    // left to whatever sort the reviewer chose — see renderCases.
    function tierRank(rec) {
        const key = entitlementTier(rec.entitlement).key;
        const i = TIERS.findIndex(t => t.key === key);
        if (i >= 0) return i;
        return key === 'other' ? TIERS.length : TIERS.length + 1;
    }

    /* SEVERITY. Read off the picklist rather than assumed: SOTI writes "High (Severity 2)",
     * and an org that has renamed the values still carries the word. Severity 1 gets its own
     * colour because it prints as "H" like a Severity 2, so the colour is the only thing left
     * carrying the difference between "high" and "drop what you are doing". */
    const SEVERITY_UNKNOWN = 99;

    function severityRank(priority) {
        const t = String(priority || '');
        const n = t.match(/severity\s*(\d+)/i);
        if (n) return parseInt(n[1], 10);
        if (/critical|urgent/i.test(t)) return 1;
        if (/high/i.test(t)) return 2;
        if (/medium|normal/i.test(t)) return 3;
        if (/low/i.test(t)) return 4;
        return SEVERITY_UNKNOWN;
    }

    function severityShort(priority) {
        const rank = severityRank(priority);
        if (rank <= 2) return 'H';
        if (rank === 3) return 'M';
        if (rank === 4) return 'L';
        return '?';
    }

    function severityTagClass(priority) {
        const rank = severityRank(priority);
        if (rank === 1) return 'sev-crit';
        if (rank === 2) return 'sev-high';
        if (rank === 3) return 'sev-med';
        if (rank === 4) return 'sev-low';
        return '';
    }

    // "Waiting on SOTI" — the ball is with us. It washes the row red, which is the one thing
    // worth seeing on a queue without opening anything.
    function statusIsOnSoti(status) {
        return /waiting\s+on\s+soti|with\s+soti|soti\s+response/i.test(String(status || ''));
    }

    /* THE STATUS AS A NUMBER, for the "on SOTI first" sort. On us, then blocked on
     * engineering, then waiting on the customer, then anything this does not recognise, then
     * the rows with no status at all. The unrecognised rank sits AFTER the three known ones
     * and before the blanks on purpose: a status nobody wrote a rule for is still a status. */
    function statusRank(status) {
        const t = String(status || '').trim();
        if (!t) return 99;
        if (statusIsOnSoti(t)) return 1;
        if (/develop|engineering|r&d|jira/i.test(t)) return 2;
        if (/customer|client|user/i.test(t)) return 3;
        return 50;
    }

    /* SALESFORCE'S DOT AS A NUMBER. Overdue is 0 so it sorts first; a row with no dot is null
     * so it sorts last. Read through activityIcon so a colour Salesforce adds later, or a
     * value an older build stored, comes back "not known" rather than quietly scoring 0. */
    const ACTIVITY_RANK = { red: 0, yellow: 1, green: 2 };

    function activityRank(rec) {
        const v = activityIcon(rec);
        return Object.prototype.hasOwnProperty.call(ACTIVITY_RANK, v) ? ACTIVITY_RANK[v] : null;
    }

    /* THE TWO "PUT THE ONES WE CANNOT ANSWER FOR AT THE BOTTOM" HELPERS, and they are two
     * rather than one because they disagree about what unknown MEANS.
     *
     * nullLast knows only null. unknownLast also treats SEVERITY_UNKNOWN — the 99 an
     * unreadable severity returns — as unknown, which is right for a rank and wrong for
     * anything counted in days: a case 99 days old is the oldest case in the queue, not a
     * missing one, and running it through unknownLast would sort it to the bottom. */
    function nullLast(x, y, cmp) {
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return cmp(x, y);
    }

    function unknownLast(x, y, cmp) {
        const xu = x === null || x === SEVERITY_UNKNOWN;
        const yu = y === null || y === SEVERITY_UNKNOWN;
        if (xu && yu) return 0;
        if (xu) return 1;
        if (yu) return -1;
        return cmp(x, y);
    }

    /* THE CHOSEN ORDER, within whatever tier group the case is in. Returns null for "list
     * order", which means "do not sort at all" — the rows keep the order Salesforce returned
     * them in, which is whatever sort the reviewer already chose on the list view and which
     * this panel has no business overriding.
     *
     * THERE IS NO "LAST SENT: LONGEST AGO" HERE, and that is not an omission. It sorts on how
     * long ago we last emailed the customer, which is read from a case's FEED — and a list
     * sync never opens a case. Offering it would be a sort that quietly did nothing on every
     * row. Same reason the Last Sent column is not in the chooser. */
    function sortComparator(sort) {
        const ageOf = (c) => E.ageDaysOf(c.ageDays);
        switch (sort) {
            case 'age-desc': return (a, b) => unknownLast(ageOf(a), ageOf(b), (x, y) => y - x);
            case 'age-asc':  return (a, b) => unknownLast(ageOf(a), ageOf(b), (x, y) => x - y);
            case 'sev-high': return (a, b) => unknownLast(severityRank(a.priority), severityRank(b.priority), (x, y) => x - y);
            case 'sev-low':  return (a, b) => unknownLast(severityRank(a.priority), severityRank(b.priority), (x, y) => y - x);
            // One direction only: "what is waiting on us" is a question, and its reverse puts
            // the cases nobody can act on at the top.
            case 'status':   return (a, b) => unknownLast(statusRank(a.status), statusRank(b.status), (x, y) => x - y);
            // Worst first — red, yellow, green, then the rows with no dot. One direction, for
            // the same reason status has one. nullLast rather than unknownLast: no dot means
            // the list view has no such column, which is not a rank.
            case 'activity': return (a, b) => nullLast(activityRank(a), activityRank(b), (x, y) => x - y);
            case 'case':     return (a, b) => String(a.caseNum || '').localeCompare(String(b.caseNum || ''));
            case 'owner':    return (a, b) => String(a.owner || a.lastModifiedBy || '').localeCompare(String(b.owner || b.lastModifiedBy || ''));
            /* REVIEWED FIRST, WORST SCORE FIRST, everything unreviewed after them. The one
             * sort that reads the reviews rather than the row, and the direction is the point
             * of it: a lead opening this queue wants the cases that scored badly, because
             * those are the ones with something to coach on. Its reverse would open with the
             * cases nobody needs to look at, which is why there is only one direction — the
             * same reason status and activity have only one. */
            case 'score':    return (a, b) => {
                const s = (c) => {
                    const r = qaReviewFor(c);
                    return r && !incomplete(r) && r.score && r.score.value !== null ? r.score.value : null;
                };
                return nullLast(s(a), s(b), (x, y) => x - y);
            };
            default:         return null;      // 'list' — Salesforce's own order, untouched
        }
    }

    const JIRA_BROWSE_BASE = 'https://jira.soti.net/browse/';
    const JIRA_KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

    function jiraKeyFrom(raw) {
        let v = String(raw || '').trim();
        if (!v) return '';
        // Tolerate a pasted browse URL — somebody copied the link, not the key. Anchored to
        // the SOTI host so a link from anywhere else is not quietly rewritten into one of
        // ours: it fails the key test below and stays plain text.
        const fromUrl = v.match(/^https?:\/\/jira\.soti\.net\/browse\/([A-Za-z][A-Za-z0-9]*-\d+)\b/i);
        if (fromUrl) v = fromUrl[1];
        return JIRA_KEY_RE.test(v) ? v.toUpperCase() : '';
    }

    function jiraUrlFor(raw) {
        const key = jiraKeyFrom(raw);
        return key ? JIRA_BROWSE_BASE + encodeURIComponent(key) : '';
    }

    /* SALESFORCE'S OWN GREEN / YELLOW / RED DOT — the "Last Completed Activity Icon" field,
     * its judgement of how the last completed activity is ageing. Read through a guard so a
     * value stored by an older build, or a colour Salesforce adds later, degrades to "not
     * known" instead of painting a cell with no colour rule behind it. */
    const ACTIVITY_LABELS = {
        green:  'green — activity is current',
        yellow: 'yellow — activity is falling behind',
        red:    'red — activity is overdue'
    };

    function activityIcon(rec) {
        const v = String((rec && rec.activityIcon) || '').toLowerCase().trim();
        return Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, v) ? v : '';
    }

    /* THE COLUMNS THEMSELVES.
     * ---------------------------------------------------------------------
     * One line per case, and a side panel's line is about sixty characters wide, so the
     * choice of what goes on it is the whole design of this list. It is a SETTING rather than
     * a decision made once for everybody: a team lead scans by owner, somebody chasing a
     * release scans by JIRA, and somebody working a backlog scans by score.
     *
     * The order below is the order they appear on the row; `on` is what a fresh install
     * starts with. Each has a SHORT head (the strip above the list) and a long label (the
     * chooser), because "Severity" fits over a column and "Severity (H / M / L)" does not.
     *
     * The width is shared with the CSS: .oc-col-<key> sets the same basis on the cell and on
     * its heading, which is what makes the strip line up with the rows instead of merely
     * sitting above them. */
    const QA_COLUMNS = [
        { key: 'subject',     head: 'Subject',   label: 'Subject',                                  on: true  },
        /* FIRST AMONG THE CELLS because it is a colour rather than a word: the eye finds it
         * without reading the row, which is the entire reason the field exists in Salesforce,
         * and putting it anywhere else would turn a glanceable signal back into something you
         * have to look for. It costs almost nothing to be on — it is one dot wide. */
        { key: 'activity',    head: '●',         label: 'Last completed activity (Salesforce dot)', on: true  },
        { key: 'severity',    head: 'Severity',  label: 'Severity (H / M / L)',                     on: true  },
        { key: 'age',         head: 'Age',       label: 'Case age, in days',                        on: true  },
        /* THE 30/60/90 FLAG — this tool's own column, and the reason the age is on the row at
         * all. Computed from the age, never guessed; see QaEngine.milestoneFor. */
        { key: 'milestone',   head: '30/60/90',  label: '30 / 60 / 90-day review flag',             on: true  },
        { key: 'jira',        head: 'JIRA',      label: 'JIRA number',                              on: false },
        // The other column this tool has and the analyser does not: whether the case has been
        // reviewed, and how it went.
        { key: 'qa',          head: 'QA',        label: 'QA score',                                 on: true  },
        /* ON, because this queue is worked by agent — "everything Imran touched this month"
         * is the second way a reviewer picks work, and the owner select above the list is the
         * first. THE ROW HAS 57px LESS TO SPEND THAN THE ANALYSER'S, though: a tick box
         * before the case number and a chat button after the last cell, neither of which that
         * list carries, and both of which come out of the subject. Squeezed into a narrow
         * side panel this is the first column worth turning off — its job is already done
         * twice above the list, by a search box that matches the owner and the alias and by the
         * owner dropdown, which filters to the people ticked in it. */
        { key: 'owner',       head: 'Owner',     label: 'Case owner',                               on: true  },
        { key: 'status',      head: 'Status',    label: 'Case status',                              on: false },
        { key: 'account',     head: 'Account',   label: 'Account name',                             on: false },
        { key: 'entitlement', head: 'Tier',      label: 'Entitlement',                              on: false },
        { key: 'contact',     head: 'Contact',   label: 'Contact name',                             on: false }
    ];

    /* HOW WIDE EACH COLUMN IS — a starting point, not a fixture.
     * ---------------------------------------------------------------------
     * The figures are a budget measured against a rendered row, so the default columns, the
     * case number and a readable subject all fit a ~400px Chrome side panel. Dragging the
     * right edge of any heading overwrites one, and the value is applied as a CSS custom
     * property on the view — the ancestor of BOTH the heading strip and every row — which is
     * what keeps a heading over its own column instead of merely near it.
     *
     * `def` MUST match the var() fallback in the stylesheet for that key. Two copies of one
     * number, and the only way to avoid it would be to read the computed style of a cell that
     * may not be rendered yet. `min` is the same floor the CSS sets and is enforced here as
     * well, so a drag cannot produce a width the layout then refuses. */
    const COL_SIZES = {
        casenum:     { def: 70, min: 48 },   // a bold "C01720260" is 68px — see .oc-num in qa-styles.css
        subject:     { def: 0,  min: 26 },   // 0 = "whatever is left over" (flex-grow 1)
        activity:    { def: 16, min: 12 },
        severity:    { def: 46, min: 24 },
        age:         { def: 34, min: 28 },
        milestone:   { def: 46, min: 30 },   // wide enough for its own heading, not just "90d"
        jira:        { def: 86, min: 44 },
        qa:          { def: 36, min: 30 },   // two digits, under a two-letter heading
        owner:       { def: 66, min: 40 },
        status:      { def: 88, min: 44 },
        account:     { def: 96, min: 44 },
        entitlement: { def: 80, min: 40 },
        contact:     { def: 86, min: 44 }
    };
    // A ceiling, because the row clips at its right edge rather than scrolling: a column
    // dragged past this would push the ones after it off the row and out of reach, with no
    // way back except Reset.
    const COL_MAX_W = 360;

    function defaultColumns() { return QA_COLUMNS.filter(c => c.on).map(c => c.key); }

    // The chosen set, always in QA_COLUMNS order whatever order it was stored in — the row's
    // layout is this list's, not the order somebody happened to tick the boxes.
    let COLUMNS = defaultColumns();
    // Column key → chosen width in px. Only the columns actually dragged appear here, so a
    // column added in a later build starts at its designed width rather than at whatever a
    // stale stored value happened to say.
    let COL_WIDTHS = {};

    function columnOn(key) { return COLUMNS.includes(key); }
    function enabledColumns() { return QA_COLUMNS.filter(c => COLUMNS.includes(c.key)); }

    /* READING THE SAVED LAYOUT.
     *
     * Both halves are validated on the way in. A stored key from a build that had a column
     * this one does not would otherwise sit in the list forever, counted by the chooser and
     * rendered by nothing; a stored width outside what the layout can hold would be written
     * onto the view where nothing could correct it.
     *
     * A COLUMN ADDED IN A LATER BUILD MUST STILL REACH SOMEBODY WHO ALREADY HAS A SAVED
     * CHOICE — which is everybody except a fresh install. The stored array is their answer to
     * "which columns do you want", and it is the right answer for every column that existed
     * when they gave it. It is the wrong answer for one that did not: they never said no to
     * the new column, they were never asked. So the keys that EXISTED at save time are stored
     * beside the choice, and anything in QA_COLUMNS that is not among them is new to this
     * reviewer — its default applies, inserted in QA_COLUMNS order rather than appended, so
     * the row stays in the layout's order. A column they then switch off is in the known set
     * from that moment, so this can only ever fire once per column. */
    function loadColumnPrefs(got) {
        const widths = got && got[K.colWidths];
        if (widths && typeof widths === 'object') {
            const clean = {};
            for (const [k, v] of Object.entries(widths)) {
                const size = COL_SIZES[k];
                const n = Number(v);
                if (size && Number.isFinite(n)) clean[k] = Math.max(size.min, Math.min(COL_MAX_W, Math.round(n)));
            }
            COL_WIDTHS = clean;
        }
        const saved = got && got[K.columns];
        if (!Array.isArray(saved)) return;

        const valid = saved.filter(k => QA_COLUMNS.some(c => c.key === k));
        COLUMNS = valid.length ? valid : defaultColumns();

        const known = Array.isArray(got[K.columnsSeen]) ? got[K.columnsSeen] : saved;
        const fresh = QA_COLUMNS.filter(c => c.on && !known.includes(c.key) && !COLUMNS.includes(c.key));
        if (fresh.length) {
            const want = new Set([...COLUMNS, ...fresh.map(c => c.key)]);
            COLUMNS = QA_COLUMNS.filter(c => want.has(c.key)).map(c => c.key);
            // Persisted immediately, along with the now-current known set, so the decision is
            // recorded rather than re-made on every start.
            saveColumns();
        } else if (!Array.isArray(got[K.columnsSeen])) {
            // Nothing to add, but the known set still needs writing once so the next column
            // added does not look new to a build that has already seen it.
            saveColumns();
        }
    }

    function saveColumns() {
        // EVERY column that existed when this choice was made, not the chosen ones — it is
        // what lets a later build tell "switched off" from "did not exist yet".
        return store({ [K.columns]: COLUMNS, [K.columnsSeen]: QA_COLUMNS.map(c => c.key) });
    }

    function saveWidths() { return store({ [K.colWidths]: COL_WIDTHS }); }

    /* PUSH THE CHOSEN WIDTHS ONTO THE VIEW.
     *
     * One assignment per column, on #viewCases, and that is the whole mechanism: the heading
     * strip and every row read the same custom property, so there is no code that sizes a
     * heading and separate code that sizes its cells — which is how the two would otherwise
     * drift apart.
     *
     * A column with no stored width has its property REMOVED rather than set to the default,
     * so the CSS fallback is what applies. That matters on reset: setting 46px explicitly and
     * letting the stylesheet say 46px look identical until the stylesheet's number changes in
     * a later build, at which point every install that had ever pressed Reset would be pinned
     * to the old figure. */
    function applyColWidths() {
        const view = $('viewCases');
        if (!view) return;
        for (const key of Object.keys(COL_SIZES)) {
            const w = COL_WIDTHS[key];
            if (key === 'subject') {
                /* The subject is "whatever is left over" until it is dragged; then it is a
                 * fixed width and the leftover goes elsewhere. Both halves have to move
                 * together — a basis with the grow factor still at 1 would be ignored the
                 * moment there is any spare room on the row. */
                if (w) {
                    view.style.setProperty('--ocw-subject', w + 'px');
                    view.style.setProperty('--ocw-subject-grow', '0');
                } else {
                    view.style.removeProperty('--ocw-subject');
                    view.style.removeProperty('--ocw-subject-grow');
                }
                continue;
            }
            if (w) view.style.setProperty('--ocw-' + key, w + 'px');
            else view.style.removeProperty('--ocw-' + key);
        }
    }

    /* THE HEADINGS OVER THE COLUMNS.
     *
     * Built from the same list the rows are, so it cannot name a column that is not there or
     * miss one that is. It is what turns "H" into Severity — a single letter in a queue is a
     * code until something says what it is a code FOR, and hovering every cell to find out is
     * not a design, it is a puzzle.
     *
     * The two spacers stand in for the controls at either end of a row: the tick box before
     * the case number, and the chat button after the last cell. Without them every heading
     * sits a control's width away from the column it names. */
    function renderQaColumnHeader() {
        const head = $('ocColHead');
        if (!head) return;
        const any = (CASES.cases || []).length;
        head.style.display = any ? '' : 'none';
        if (!any) return;

        head.textContent = '';
        // Whatever was chosen last time, before anything is measured — a grip reads the
        // cell's RENDERED width when the drag starts, so the stored width has to already be
        // on the view.
        applyColWidths();

        const num = document.createElement('span');
        num.className = 'oc-colhead-num';
        num.textContent = 'Case';
        addColumnGrip(num, 'casenum', 'Case number');
        head.appendChild(num);

        const subj = document.createElement('span');
        subj.className = 'oc-colhead-subject';
        subj.textContent = columnOn('subject') ? 'Subject' : '';
        // No grip when the subject is off: the element is still there (it is the gutter that
        // keeps everything after it lined up) but it is not a column anybody is looking at,
        // and a handle on an empty cell is a control with nothing behind it.
        if (columnOn('subject')) addColumnGrip(subj, 'subject', 'Subject');
        head.appendChild(subj);

        for (const c of enabledColumns()) {
            if (c.key === 'subject') continue;
            const cell = document.createElement('span');
            cell.className = 'oc-colhead-cell oc-col-' + c.key;
            cell.textContent = c.head;
            cell.title = c.label + ' — drag the right edge to resize this column.';
            addColumnGrip(cell, c.key, c.head);
            head.appendChild(cell);
        }

        const spacer = document.createElement('span');
        spacer.className = 'oc-colhead-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        head.appendChild(spacer);
    }

    /* THE SCROLLBAR IS WORTH A FEW PIXELS, AND THE STRIP IS NOT INSIDE IT.
     *
     * The rows live in .oc-list, which scrolls; the heading strip sits above it and does not.
     * So the moment the queue is long enough to scroll, every row is a scrollbar's width
     * narrower than the strip above it, and every heading drifts right of the column it names
     * — by four pixels on Windows, which is small enough to look like sloppy alignment rather
     * than like a cause.
     *
     * Measured rather than assumed: a scrollbar is 0px on a trackpad-style overlay, ~15px on
     * an old theme, and it appears and disappears as the queue is filtered. The row's own
     * right border is the remaining pixel — the strip has no border. Called after the rows are
     * in, because a list that has not overflowed yet has no scrollbar to measure. */
    function alignColumnHeader() {
        const head = $('ocColHead');
        const list = $('ocList');
        if (!head || !list) return;
        const bar = Math.max(0, list.offsetWidth - list.clientWidth);
        head.style.paddingRight = (8 + bar + 1) + 'px';
    }

    /* THE FIVE PIXELS ON THE RIGHT EDGE OF A HEADING.
     *
     * appendChild, never innerHTML — the heading's text is set with textContent immediately
     * above and would wipe a child written before it.
     *
     * Keyboard as well as pointer. The grip is focusable and the arrow keys nudge the column
     * four pixels at a time, because "drag a five-pixel strip" is not a control everybody can
     * operate, and this is the only way to change a width. Home resets that one column. */
    function addColumnGrip(cell, key, name) {
        if (!cell || !COL_SIZES[key]) return;
        const grip = document.createElement('span');
        grip.className = 'oc-colgrip';
        grip.tabIndex = 0;
        grip.setAttribute('role', 'separator');
        grip.setAttribute('aria-orientation', 'vertical');
        grip.setAttribute('aria-label', `Resize the ${name} column`);
        grip.title = `Drag to resize ${name} — double-click to reset it`;
        grip.onpointerdown = (e) => startColumnResize(e, cell, key, grip);
        // Double-click on a divider means "back to the default" in every table anybody has used.
        grip.ondblclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (COL_WIDTHS[key] === undefined) return;
            delete COL_WIDTHS[key];
            applyColWidths();
            saveWidths();
        };
        grip.onkeydown = (e) => {
            const step = e.key === 'ArrowRight' ? 4 : e.key === 'ArrowLeft' ? -4 : 0;
            if (step) {
                e.preventDefault();
                setColumnWidth(key, (COL_WIDTHS[key] || Math.round(cell.getBoundingClientRect().width / uiZoom())) + step);
                saveWidths();
                return;
            }
            if (e.key === 'Home') {
                e.preventDefault();
                delete COL_WIDTHS[key];
                applyColWidths();
                saveWidths();
            }
        };
        cell.appendChild(grip);
    }

    // Clamp and apply. The floor and the ceiling live in one place so the pointer path, the
    // keyboard path and the stored-value validator cannot disagree about what is allowed.
    function setColumnWidth(key, px) {
        const size = COL_SIZES[key];
        if (!size) return;
        COL_WIDTHS[key] = Math.max(size.min, Math.min(COL_MAX_W, Math.round(px)));
        applyColWidths();
    }

    /* THE DRAG ITSELF.
     *
     * Pointer events with setPointerCapture rather than mousemove on window: capture is what
     * keeps the drag alive when the pointer leaves the five-pixel strip — which it does
     * immediately, because the whole point is to move away from where you pressed — and it
     * delivers the release even if that happens outside the panel entirely.
     *
     * The width is measured from the RENDERED cell, not from the stored value: a column that
     * has never been dragged has no stored value, and one being squeezed by a narrow panel is
     * not as wide as its stored value says. Starting from what is on screen is what makes the
     * first pixel of the drag move the edge by one pixel. */
    function startColumnResize(e, cell, key, grip) {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = Math.round(cell.getBoundingClientRect().width);
        grip.classList.add('is-dragging');
        document.body.classList.add('oc-resizing');
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }

        // Screen pixels in, page pixels out: at a Display size other than 100% the edge would
        // otherwise run ahead of (or behind) the pointer. See display-size.js.
        const move = (ev) => setColumnWidth(key, (startW + (ev.clientX - startX)) / uiZoom());
        const up = () => {
            grip.classList.remove('is-dragging');
            document.body.classList.remove('oc-resizing');
            grip.onpointermove = null;
            grip.onpointerup = null;
            grip.onpointercancel = null;
            try { grip.releasePointerCapture(e.pointerId); } catch (err) { /* never captured */ }
            saveWidths();
        };
        grip.onpointermove = move;
        grip.onpointerup = up;
        grip.onpointercancel = up;
    }

    /* THE CHOOSER, behind the cog. One tick box per column, plus the one thing the grips
     * cannot say for themselves: they are five invisible pixels on the edge of a heading,
     * which is the right way for them to BEHAVE and the wrong way to be DISCOVERED. */
    function renderQaColumns() {
        const body = $('ocColsBody');
        if (!body) return;
        body.textContent = '';

        for (const col of QA_COLUMNS) {
            const row = document.createElement('label');
            row.className = 'oc-col-opt';

            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = columnOn(col.key);
            box.onchange = () => {
                const wanted = new Set(COLUMNS);
                if (box.checked) wanted.add(col.key); else wanted.delete(col.key);
                // Rebuilt from QA_COLUMNS so the stored order is always the row's order — the
                // alternative is a list in tick order, and rows that reshuffle themselves
                // depending on which box somebody touched last.
                COLUMNS = QA_COLUMNS.filter(c => wanted.has(c.key)).map(c => c.key);
                saveColumns();
                renderCases();
            };
            row.appendChild(box);

            const text = document.createElement('span');
            text.className = 'oc-col-opt-t';
            text.textContent = col.label;
            row.appendChild(text);

            body.appendChild(row);
        }

        const hint = document.createElement('div');
        hint.className = 'oc-cols-hint';
        hint.textContent = 'Drag the right edge of any heading to resize a column. '
            + 'Double-click an edge to reset just that one.';
        body.appendChild(hint);
    }

    /* THE TIER CHIPS. Counts reflect the search, the owner and the milestone filters but NOT
     * the tier itself, so the chips keep saying how many cases each tier would show — a chip
     * reading 0 because of the tier you already picked tells you nothing.
     *
     * A tier with no cases in it is not offered: a chip whose only outcome is an empty list is
     * a control that costs a press to teach you nothing. */
    function renderTierChips() {
        const wrap = $('ocTierChips');
        if (!wrap) return;
        const all = CASES.cases || [];
        wrap.style.display = all.length ? '' : 'none';
        if (!all.length) { wrap.textContent = ''; return; }

        /* HOW MANY THE JIRA CHIP WOULD SHOW, measured FIRST and with that filter ignored, so
         * it answers "how many would I see if I pressed you" rather than restating how many
         * are already on screen.
         *
         * It has to be counted before anything else is, because of what happens when the
         * answer is none: the chip is then not drawn at all, and a filter with no visible
         * control to clear it would strand the queue. So the flag lets go here — and doing it
         * BEFORE the pool below is counted is the whole reason this is not further down. Count
         * the pool first and every other chip is measured through a filter that is about to
         * disappear, which showed as "All 0" over a list with a row in it. */
        const withJira = visibleCases({ ignoreTier: true, ignoreJira: true })
            .filter(rec => jiraKeyFrom(rec.jira)).length;
        if (!withJira) ONLY_JIRA = false;
        // The same reasoning for Focus: counted with its own filter off, and let go when the
        // answer is none so the queue is never stranded behind a chip that is not drawn.
        const withFocus = visibleCases({ ignoreTier: true, ignoreFocus: true }).filter(needsAction).length;
        if (!withFocus) ONLY_FOCUS = false;

        const pool = visibleCases({ ignoreTier: true });
        const counts = new Map();
        for (const rec of pool) {
            const k = entitlementTier(rec.entitlement).key;
            counts.set(k, (counts.get(k) || 0) + 1);
        }

        wrap.textContent = '';
        const add = (key, label, count) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'oc-chip' + (TIER === key ? ' active' : '') + (key !== 'all' ? ' tier-' + key : '');
            b.textContent = `${label} ${count}`;
            b.title = key === 'all'
                ? 'Every entitlement tier, grouped in the order they are worked'
                : `Show only the ${label} cases`;
            b.onclick = () => {
                // Clicking the active chip clears it — otherwise the only way back to the
                // whole queue is to find "All" again, and that is one more thing to look for.
                TIER = (TIER === key) ? 'all' : key;
                renderCases();
            };
            wrap.appendChild(b);
        };
        add('all', 'All', pool.length);
        for (const t of [...TIERS, TIER_OTHER, TIER_NONE]) {
            if (counts.get(t.key)) add(t.key, t.label, counts.get(t.key));
        }

        /* THE JIRA CHIP — a filter, beside the tier filters, because that is what it is.
         *
         * "Which of these cases has a defect open against it" is asked constantly and there
         * was no way to ask it: the JIRA number was a column you had to switch on and then
         * read down. Pressing this narrows the queue to the cases that have one AND turns the
         * JIRA column on, so the answer is the list itself — every case with its key beside
         * it — rather than a list you then have to go looking through.
         *
         * Not offered when nothing in the queue has a JIRA: a chip reading "JIRA 0" is a
         * control whose only outcome is an empty list. Its count was taken at the top of this
         * function; see the note there for why it had to be.
         *
         * The tier counts above deliberately do NOT ignore this filter, where its own count
         * does: each chip answers that question about ITSELF, and while JIRA is on,
         * "Enterprise 14" over a list of five would be the chips contradicting the queue. */
        if (withJira) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'oc-chip oc-chip-jira' + (ONLY_JIRA ? ' active' : '');
        b.textContent = `JIRA ${withJira}`;
        b.title = ONLY_JIRA
            ? 'Showing only the cases with a JIRA. Click to show them all again.'
            : 'Show only the cases with a JIRA raised, each with its key.';
        b.onclick = () => {
            ONLY_JIRA = !ONLY_JIRA;
            /* Turning the filter on turns the column on with it — filtering to "cases with a
             * JIRA" and then not showing the JIRA would be the one view where that column is
             * certain to be wanted. Turning the filter back off LEAVES it on: it is a column
             * the reviewer has now seen and may want to keep, and a layout that rearranges
             * itself when a filter is cleared is a layout nobody trusts. */
            if (ONLY_JIRA && !columnOn('jira')) {
                COLUMNS = QA_COLUMNS.filter(c => c.key === 'jira' || COLUMNS.includes(c.key)).map(c => c.key);
                saveColumns();
                renderQaColumns();
            }
            renderCases();
        };
        wrap.appendChild(b);
        }

        /* ★ FOCUS — the analyser's "which of these is on us right now", from what the list
         * already says: the status is Waiting on SOTI or New, or Salesforce's activity dot is
         * red. (The analyser also counts "no email sent in five days", which needs the feed —
         * a list sync does not read it, so it is not guessed at here.) */
        if (withFocus) {
            const f = document.createElement('button');
            f.type = 'button';
            f.className = 'oc-chip oc-chip-focus' + (ONLY_FOCUS ? ' active' : '');
            f.textContent = `★ Focus ${withFocus}`;
            f.title = ONLY_FOCUS
                ? 'Showing only the cases that need action. Click to show them all again.'
                : `Focus: show only the ${withFocus} case${withFocus === 1 ? '' : 's'} that need action — the status is Waiting on SOTI or New, or the Salesforce activity dot is red.`;
            f.onclick = () => { ONLY_FOCUS = !ONLY_FOCUS; renderCases(); };
            wrap.appendChild(f);
        }
    }

    /* ---------------------------------------------------------------------
     * THE OWNER DROPDOWN — whose cases are on screen
     * ---------------------------------------------------------------------
     * It lists the people who own the cases LOADED NOW, and nobody else: sync Robert's, Daiva's
     * and Callum's cases and those are the three names in it. Tick one to see only their cases,
     * tick several to see them together; with none ticked every case shows. It works with every
     * other filter rather than instead of one — the tier chips, the search box and Select all
     * all act on what it leaves on screen, and their counts follow it.
     *
     * The owner is the name the Owner column shows: the Case Owner, or whoever last modified the
     * case when the list carries no owner column. Two spellings that differ only in case or
     * spacing are one person. A case with neither is listed as "No owner listed", so a list
     * filtered by owner can still reach it.
     * ------------------------------------------------------------------- */
    const NO_OWNER = '';
    function ownerOf(rec) {
        return String((rec && (rec.owner || rec.lastModifiedBy)) || '').replace(/\s+/g, ' ').trim();
    }
    function ownerKey(rec) { return ownerOf(rec).toLowerCase(); }

    // Every owner among the loaded cases, A to Z with "No owner listed" last: [{ key, name, total }].
    function ownerNames() {
        const map = new Map();
        for (const rec of CASES.cases || []) {
            const key = ownerKey(rec);
            const had = map.get(key);
            if (had) had.total++;
            else map.set(key, { key, name: key === NO_OWNER ? 'No owner listed' : ownerOf(rec), total: 1 });
        }
        return [...map.values()].sort((a, b) => (a.key === NO_OWNER) - (b.key === NO_OWNER)
            || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    function ownerMenuOpen() {
        const m = $('ocOwnerMenu');
        return !!m && m.style.display !== 'none';
    }
    function closeOwnerMenu() {
        const m = $('ocOwnerMenu');
        if (!m || m.style.display === 'none') return;
        m.style.display = 'none';
        const btn = $('ocOwnerBtn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    }
    function openOwnerMenu() {
        const m = $('ocOwnerMenu');
        const btn = $('ocOwnerBtn');
        if (!m || !btn) return;
        closeToolbarMenus();
        closeMenu();
        m.style.display = '';
        btn.setAttribute('aria-expanded', 'true');
        const find = $('ocOwnerFind');
        if (find) find.value = '';
        renderOwnerPicker();
        // Kept inside the panel: the button sits at the right-hand end of the chip line, so a
        // menu hung off its left edge would run off the side.
        m.style.left = '';
        m.style.right = '0';
        const box = m.getBoundingClientRect();
        if (box.left < 8) { m.style.right = ''; m.style.left = '0'; }
        if (find && find.offsetParent) try { find.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ }
    }

    function toggleOwner(key) {
        if (OWNERS.has(key)) OWNERS.delete(key); else OWNERS.add(key);
        renderCases();
    }

    /* THE BUTTON, AND — WHILE IT IS OPEN — THE LIST UNDER IT.
     *
     * Each name carries the number of its cases the list would show with every OTHER filter as
     * it is, the chips' rule: it answers "how many would I see if I ticked this". A picked owner
     * whose cases have all gone with a re-sync is let go here, so the queue is never filtered by
     * a name that is no longer in the dropdown to untick. */
    function renderOwnerPicker() {
        const wrap = $('ocOwnerWrap');
        if (!wrap) return;
        const owners = ownerNames();
        const present = new Set(owners.map(o => o.key));
        for (const k of [...OWNERS]) if (!present.has(k)) OWNERS.delete(k);
        wrap.style.display = owners.length ? '' : 'none';
        if (!owners.length) { closeOwnerMenu(); return; }

        const picked = owners.filter(o => OWNERS.has(o.key));
        const label = $('ocOwnerLabel');
        const btn = $('ocOwnerBtn');
        if (label) {
            label.textContent = !picked.length ? 'All owners'
                : picked.length === 1 ? picked[0].name
                : `${picked.length} owners`;
        }
        if (btn) {
            btn.classList.toggle('active', picked.length > 0);
            btn.title = picked.length
                ? `Showing the cases of ${picked.map(o => o.name).join(', ')}. Click to change who is picked.`
                : `Show only the cases of the owners you pick — tick one or several. ${owners.length} owner${owners.length === 1 ? '' : 's'} in this list.`;
        }
        if (!ownerMenuOpen()) return;

        const head = $('ocOwnerHead');
        if (head) head.textContent = picked.length
            ? `${picked.length} of ${owners.length} owner${owners.length === 1 ? '' : 's'} picked`
            : `${owners.length} owner${owners.length === 1 ? '' : 's'} in this list`;
        const clear = $('ocOwnerClear');
        if (clear) clear.hidden = !picked.length;
        const find = $('ocOwnerFind');
        // The find box only earns its line once the list is long enough to need finding in.
        if (find) find.style.display = owners.length > 8 ? '' : 'none';
        const q = find && owners.length > 8 ? find.value.trim().toLowerCase() : '';

        const counts = new Map();
        for (const rec of visibleCases({ ignoreOwner: true })) {
            const k = ownerKey(rec);
            counts.set(k, (counts.get(k) || 0) + 1);
        }

        const list = $('ocOwnerList');
        if (!list) return;
        const keepScroll = list.scrollTop;
        // The list is rebuilt under the click that ticked a name, so the focus is put back on
        // that name afterwards — otherwise the keyboard loses its place on every tick.
        const had = document.activeElement;
        const keepFocus = had && list.contains(had) ? had.dataset.key : null;
        list.textContent = '';
        const row = (key, name, count, on, extra) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qa-owner-item' + (on ? ' on' : '') + (extra || '');
            b.dataset.key = key;
            b.setAttribute('role', 'option');
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            const box = document.createElement('span');
            box.className = 'qa-owner-box';
            box.setAttribute('aria-hidden', 'true');
            const nm = document.createElement('span');
            nm.className = 'qa-owner-name';
            nm.textContent = name;
            nm.title = name;
            const n = document.createElement('span');
            n.className = 'qa-owner-n';
            n.textContent = String(count);
            b.append(box, nm, n);
            return b;
        };

        if (!q) {
            const all = row('*', 'All owners', visibleCases({ ignoreOwner: true }).length, !picked.length, ' qa-owner-all');
            all.title = 'Every owner\'s cases — clears the ticks below';
            all.onclick = (e) => { e.stopPropagation(); OWNERS.clear(); renderCases(); };
            list.appendChild(all);
        }
        const shown = owners.filter(o => !q || o.name.toLowerCase().includes(q));
        for (const o of shown) {
            const count = counts.get(o.key) || 0;
            const b = row(o.key, o.name, count, OWNERS.has(o.key), count ? '' : ' qa-owner-zero');
            b.title = count === o.total
                ? `${o.name} — ${o.total} case${o.total === 1 ? '' : 's'}`
                : `${o.name} — ${count} of their ${o.total} case${o.total === 1 ? '' : 's'} pass the other filters`;
            b.onclick = (e) => { e.stopPropagation(); toggleOwner(o.key); };
            list.appendChild(b);
        }
        if (!shown.length) {
            const none = document.createElement('div');
            none.className = 'qa-owner-none';
            none.textContent = 'No owner matches that.';
            list.appendChild(none);
        }
        list.scrollTop = keepScroll;
        if (keepFocus !== null) {
            const again = [...list.querySelectorAll('.qa-owner-item')].find(x => x.dataset.key === keepFocus);
            if (again) try { again.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
        }
    }

    function wireOwnerPicker() {
        const btn = $('ocOwnerBtn');
        const menu = $('ocOwnerMenu');
        if (!btn || !menu) return;
        btn.onclick = (e) => {
            e.stopPropagation();
            if (ownerMenuOpen()) closeOwnerMenu(); else openOwnerMenu();
        };
        // A click inside the menu is not a click outside it — see the document handler in wire().
        menu.addEventListener('click', (e) => e.stopPropagation());
        $('ocOwnerClear').onclick = () => { OWNERS.clear(); renderCases(); };
        $('ocOwnerFind').oninput = () => renderOwnerPicker();
        menu.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                const find = $('ocOwnerFind');
                if (find && find.value) { find.value = ''; renderOwnerPicker(); return; }
                closeOwnerMenu();
                try { btn.focus({ preventScroll: true }); } catch (err) { /* gone */ }
            } else if (e.key === 'Enter' && e.target === $('ocOwnerFind')) {
                // Enter in the find box ticks the one name it has narrowed the list to.
                e.preventDefault();
                const items = [...$('ocOwnerList').querySelectorAll('.qa-owner-item:not(.qa-owner-all)')];
                if (items.length === 1) items[0].click();
            }
        });
    }

    /* ONE COLUMN'S CELL ON ONE ROW.
     *
     * Every branch draws a cell even when the value is missing, and that is the point: a
     * fixed grid of columns is only readable if the columns stay in the same place from row
     * to row. Skipping the empty ones would slide every later cell one place left on that
     * row, and the heading strip above would then be lying about all of them.
     *
     * The empty cell is an em dash with a title saying WHY it is empty, which for several of
     * these is a real instruction rather than a shrug — most list views do not carry every
     * column, and the fix is in Salesforce. */
    function addColumnCell(into, key, rec) {
        const cell = (text, cls, title) => {
            const t = document.createElement('span');
            t.className = 'oc-tag oc-col-' + key + (cls ? ' ' + cls : '') + (text === '—' ? ' oc-tag-empty' : '');
            t.textContent = text;
            if (title) t.title = title;
            into.appendChild(t);
            return t;
        };

        switch (key) {
            /* THE SALESFORCE DOT. Rendered as a dot rather than as the word, because that is
             * what it is in Salesforce and because the word would cost six characters of
             * subject to say something the colour already says. A row with no colour still
             * draws — an empty ring, not a gap — and its tooltip says the list view has no
             * such column and what to do about it. */
            case 'activity': {
                const state = activityIcon(rec);
                const t = cell(state ? '●' : '○', 'oc-act-dot oc-act-' + (state || 'none'),
                    state
                        ? `Last completed activity: ${ACTIVITY_LABELS[state]}`
                        : 'No "Last Completed Activity Icon" column on this list view — add it in '
                          + 'Salesforce and sync again.');
                t.setAttribute('aria-label', state
                    ? `Last completed activity ${ACTIVITY_LABELS[state]}`
                    : 'Last completed activity unknown');
                break;
            }
            case 'severity': {
                const p = rec.priority || '';
                // The letter on the row, the whole picklist value on hover — "H" is the shape
                // of the queue, "High (Severity 2)" is the fact, and only one of them fits.
                cell(p ? severityShort(p) : '—', severityTagClass(p),
                     p ? `Severity: ${p}` : 'No severity on this case');
                break;
            }
            case 'age': {
                const n = E.ageDaysOf(rec.ageDays);
                cell(n === null ? '—' : `${Math.round(n)}d`, '',
                     n === null ? 'No case age on this row' : `Case age: ${Math.round(n)} days`);
                break;
            }
            /* THE 30/60/90 FLAG. Colour is doing the work: at a glance down the list the eye
             * should find the 90s without reading a single age. A case not yet at its first
             * review still draws a cell, and its tooltip says how far off it is — which is the
             * question somebody looking at an empty flag is actually asking. */
            case 'milestone': {
                const ms = milestoneOf(rec);
                const n = E.ageDaysOf(rec.ageDays);
                if (ms) {
                    cell(ms + 'd', 'qa-ms qa-ms-' + ms,
                         `This case is ${Math.round(n)} days old — it is due its ${ms}-day management review.`);
                } else {
                    cell('—', '', n === null
                        ? 'No case age on this row, so no milestone can be worked out'
                        : `${Math.round(n)} days old — not yet at its 30-day review`);
                }
                break;
            }
            case 'jira': {
                const jk = jiraKeyFrom(rec.jira);
                if (jk) addJiraCell(into, jk);
                else cell('—', '', 'No JIRA raised off this case');
                break;
            }
            /* ALREADY REVIEWED, AND HOW IT WENT. The band's colour behind the number: a
             * colour and a number are both readable running down a list, and "72" on its own
             * is not.
             *
             * A REVIEW WITH NO SCORE IS NO LONGER A THING THAT HAPPENS — every reviewed case
             * carries one, worked out from the measured facts when the write-up gave none
             * (see deriveScore). What is left in the second branch is the case that was read
             * but never written up at all, and that is not a tick: a tick beside a case whose
             * review is a refusal is the panel saying "done" about work that is not. */
            case 'qa': {
                const rev = qaReviewFor(rec);
                /* INCOMPLETE FIRST. A write-up that failed still carries the score worked out
                 * from the measured facts (see deriveScore), and drawn first that number sat
                 * beside a case whose review never came back — the panel saying "88" about
                 * work that is not done. The '!' is what such a case is. */
                if (rev && incomplete(rev)) {
                    cell('!', 'qa-score qa-score-bad',
                         `Read ${E.fmtDateTime(rev.at)}, but the write-up did not come back. Open Reviews to see why and re-run it.`);
                } else if (rev && rev.score && rev.score.value !== null) {
                    cell(String(rev.score.value),
                         'qa-score band-' + scoreBand(rev.score) + (rev.score.derived ? ' qa-score-derived' : ''),
                         rev.score.derived
                            ? `QA score ${rev.score.value}/100 — ${rev.score.band}, worked out from the measured facts because the write-up gave none. Reviewed ${E.fmtDateTime(rev.at)}.`
                            : `QA score ${rev.score.value}/100 — ${rev.score.band}. Reviewed ${E.fmtDateTime(rev.at)}.`);
                } else if (rev) {
                    cell('✓', 'qa-score', `Reviewed ${E.fmtDateTime(rev.at)}.`);
                } else {
                    cell('—', '', 'Not reviewed yet — select it and press QA.');
                }
                break;
            }
            /* WHOSE CASE IS THIS. The owner when the list view carries one, and whoever last
             * touched it when it does not — the Owner field on a SOTI case is routinely a
             * queue rather than a person. The cell's tooltip names the field it actually
             * read, so the heading is the team's vocabulary and the hover is the record's. */
            case 'owner': {
                const who = rec.owner || rec.lastModifiedBy || '';
                cell(who || '—', '',
                    who
                        ? (rec.owner ? `Case owner: ${who}` : `Last modified by: ${who}`)
                        : 'No owner on this list view — add a Case Owner or Last Modified By Alias column.');
                break;
            }
            case 'status':
                cell(rec.status || '—', statusIsOnSoti(rec.status) ? 'needs-soti' : '',
                     rec.status ? `Status: ${rec.status}` : 'No status on this row');
                break;
            case 'account':
                cell(rec.account || '—', '', rec.account ? `Account: ${rec.account}` : 'No account on this row');
                break;
            case 'entitlement': {
                const tier = entitlementTier(rec.entitlement);
                cell(rec.entitlement ? tier.label : '—', 'ent-' + tier.key,
                     rec.entitlement || 'No entitlement listed');
                break;
            }
            case 'contact':
                cell(rec.contact || '—', '', rec.contact ? `Contact: ${rec.contact}` : 'No contact on this row');
                break;
            default:
                break;
        }
    }

    /* THE JIRA CELL IS A LINK. A real href so it can be copied or middle-clicked, but inside
     * the extension the click opens a browser tab, because a side panel that navigates itself
     * to Jira has thrown away the queue somebody was working. */
    function addJiraCell(into, key) {
        const url = jiraUrlFor(key);
        const a = document.createElement('a');
        a.className = 'oc-tag oc-col-jira sev-jira oc-tag-link';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = 'Open ' + url;
        a.textContent = key;

        const icon = document.createElement('span');
        icon.className = 'oc-tag-ext';
        icon.textContent = '↗';
        icon.setAttribute('aria-hidden', 'true');
        a.appendChild(icon);

        // The row itself opens the case in Salesforce, so this must stop the event: a click
        // on a ticket key means the ticket, never "open the case".
        a.onclick = (e) => {
            e.stopPropagation();
            if (isExt() && window.QaReader && window.QaReader.createTab) {
                e.preventDefault();
                window.QaReader.createTab({ url, active: true }, () => {});
            }
        };
        into.appendChild(a);
    }

    /* ---------------------------------------------------------------------
     * THE CASES TAB
     * ------------------------------------------------------------------- */

    // The reviews this case already has, newest of each kind.
    function reviewsFor(rec) {
        const k = keyOf(rec);
        return REVIEWS.filter(r => r.key === k);
    }

    function qaReviewFor(rec) {
        const list = reviewsFor(rec).filter(r => r.kind === 'qa');
        return list.length ? list[list.length - 1] : null;
    }

    function milestoneOf(rec) {
        return E.milestoneFor(rec && rec.ageDays, RULES);
    }

    /* THE FILTER BOX, read the analyser's way. Commas separate alternatives, and every word of
     * one alternative must appear somewhere on the row, in any order — "linde enrol" finds the
     * Linde enrolment case. A term that names somebody who owns cases in this queue is matched
     * against the OWNER only, as whole words, so "Tom" finds Tom's cases and not every subject
     * with "customer" in it. The owner dropdown at the end of the chip line does the same job by
     * picking names off a list rather than typing them — see renderOwnerPicker. */
    function searchTerms(q) {
        return String(q || '').toLowerCase().split(/[,;]+/).map(t => t.trim()).filter(Boolean);
    }
    function ownerWords(rec) {
        return [rec.owner, rec.lastModifiedBy].filter(Boolean).join(' ').toLowerCase()
            .split(/[\s.,()]+/).filter(Boolean);
    }
    function nameHit(words, term) {
        const want = term.split(/\s+/).filter(Boolean);
        return want.length > 0 && want.every(w => words.includes(w));
    }
    function matchesSearch(rec, terms, ownerTerms) {
        if (!terms.length) return true;
        const hay = [rec.caseNum, rec.subject, rec.account, rec.contact, rec.jira, rec.entitlement,
                     rec.status, rec.owner, rec.lastModifiedBy].filter(Boolean).join(' ').toLowerCase();
        return terms.some(t => ownerTerms.has(t)
            ? nameHit(ownerWords(rec), t)
            : t.split(/\s+/).filter(Boolean).every(w => hay.includes(w)));
    }

    // ★ Focus — see renderTierChips.
    function needsAction(rec) {
        return !!rec && (statusIsOnSoti(rec.status) || activityIcon(rec) === 'red');
    }

    /* WHICH CASES ARE ON SCREEN.
     *
     * The `ignore…` options are for the chips themselves: each chip's count answers "how many
     * would this chip show", which is a question about every OTHER filter and not about the
     * one it is. Everything else reads this with no options at all. */
    function visibleCases(opts) {
        const ignoreTier = !!(opts && opts.ignoreTier);
        const ignoreJira = !!(opts && opts.ignoreJira);
        const ignoreFocus = !!(opts && opts.ignoreFocus);
        const ignoreOwner = !!(opts && opts.ignoreOwner);
        const terms = searchTerms($('ocSearch').value);
        const sort = $('ocSort').value || 'age-desc';
        const all = CASES.cases;
        const ownerTerms = new Set(terms.filter(t => all.some(c => nameHit(ownerWords(c), t))));

        let list = all.filter(c => matchesSearch(c, terms, ownerTerms));
        if (!ignoreOwner && OWNERS.size) {
            list = list.filter(c => OWNERS.has(ownerKey(c)));
        }
        if (!ignoreTier && TIER !== 'all') {
            list = list.filter(c => entitlementTier(c.entitlement).key === TIER);
        }
        if (!ignoreJira && ONLY_JIRA) {
            list = list.filter(c => jiraKeyFrom(c.jira));
        }
        if (!ignoreFocus && ONLY_FOCUS) {
            list = list.filter(needsAction);
        }
        if (FILTER !== 'all') {
            list = list.filter(c => {
                const ms = milestoneOf(c);
                if (FILTER === 'milestone') return ms !== null;
                // A write-up that never came back is not QA'd — it is the case to run again.
                const done = qaReviewFor(c);
                if (FILTER === 'unreviewed') return !done || incomplete(done);
                if (FILTER === 'reviewed') return !!done && !incomplete(done);
                return String(ms) === FILTER;
            });
        }

        /* NO SORT AT ALL under "List order" — Salesforce's own order is the answer. A missing
         * age, severity or status sorts LAST whichever direction is chosen, rather than being
         * counted as zero: a case whose row carried no severity is not the least severe case
         * in the queue, it is one this tool cannot answer for. See unknownLast. */
        const cmp = sortComparator(sort);
        if (cmp) list.sort(cmp);
        return list;
    }

    function renderCases() {
        const list = $('ocList');
        if (!list) return;
        const total = CASES.cases.length;

        // Repainted with the queue, not only when one is added: the chip for the view on
        // screen is marked, the tier chips and the heading strip are built from what the sync
        // returned, and the Sync button's title carries the count and the age.
        renderLists();
        renderOwnerPicker();
        renderTierChips();
        renderQaColumnHeader();
        paintSyncLabel();

        /* NOTHING SYNCED: the hint says what to do, and the filters and the list bar — which
         * act on a list — stay out of the way until there is one. */
        const hint = $('ocHint');
        if (hint) hint.style.display = total ? 'none' : '';
        for (const id of ['ocFilters', 'ocFilters2']) {
            const el = $(id);
            if (el) el.style.display = total ? '' : 'none';
        }
        if (!total && SELECTING) { SELECTING = false; SELECTED.clear(); }
        const view = $('viewCases');
        if (view) view.classList.toggle('oc-selecting', SELECTING);

        const shown = visibleCases();
        renderListBar(shown);
        list.textContent = '';
        if (!total) { renderCounts(); return; }

        if (!shown.length) {
            /* NAME EVERY FILTER THAT IS ON, not just the first — "no cases" while a tier filter
             * is quietly also on sends the reviewer looking in the wrong place. */
            const active = [];
            const q = ($('ocSearch').value || '').trim();
            const terms = searchTerms(q);
            if (q) active.push(terms.length > 1 ? `matching any of “${terms.join('”, “')}”` : `matching “${q}”`);
            if (OWNERS.size) {
                const names = ownerNames().filter(o => OWNERS.has(o.key)).map(o => o.name);
                active.push(names.length === 1 ? `owned by ${names[0]}` : `owned by the ${names.length} owners picked`);
            }
            if (TIER !== 'all') active.push('in that tier');
            if (ONLY_JIRA) active.push('with a JIRA');
            if (ONLY_FOCUS) active.push('needing action');
            if (FILTER !== 'all') active.push('under that chip');
            const none = document.createElement('div');
            none.className = 'oc-open';
            none.textContent = active.length ? `No cases ${active.join(', ')}.` : 'No cases to show.';
            list.appendChild(none);
            renderCounts();
            return;
        }

        /* GROUPED BY ENTITLEMENT TIER, in the order the tiers are worked — but only when no
         * single tier is picked. Tier first, the chosen sort second: Array.sort is stable, so
         * the order inside a tier is exactly what visibleCases put them in. */
        const grouping = TIER === 'all';
        const ordered = grouping ? [...shown].sort((a, b) => tierRank(a) - tierRank(b)) : shown;

        /* DRAWN IN SLICES, as the analyser draws its queue: every row is a dozen elements with
         * their handlers, so a list of a thousand cases is drawn a slice at a time as the
         * bottom of it comes into view. Filtering, sorting, Select all and the counts work on
         * the data, never on what happens to be drawn. */
        let drawn = 0;
        let lastTier = null;
        let watcher = null;
        const drawMore = () => {
            const frag = document.createDocumentFragment();
            const upto = Math.min(ordered.length, drawn + RENDER_CHUNK);
            for (const rec of ordered.slice(drawn, upto)) {
                if (grouping) {
                    const tier = entitlementTier(rec.entitlement);
                    if (tier.key !== lastTier) {
                        lastTier = tier.key;
                        const h = document.createElement('div');
                        h.className = 'oc-group tier-' + tier.key;
                        h.textContent = tier.label;
                        frag.appendChild(h);
                    }
                }
                frag.appendChild(caseRow(rec));
            }
            drawn = upto;
            const more = list.querySelector('.oc-more');
            if (more) more.remove();
            list.appendChild(frag);
            if (watcher) { watcher.disconnect(); watcher = null; }
            if (drawn < ordered.length) {
                const tail = document.createElement('div');
                tail.className = 'oc-more';
                tail.style.cssText = 'padding:8px;text-align:center;font-size:10.5px;color:var(--txt3)';
                tail.textContent = `Showing ${drawn.toLocaleString()} of ${ordered.length.toLocaleString()} — scroll for more`;
                list.appendChild(tail);
                if (typeof IntersectionObserver === 'function') {
                    watcher = new IntersectionObserver((ents) => { if (ents.some(x => x.isIntersecting)) drawMore(); }, { rootMargin: '600px' });
                    watcher.observe(tail);
                } else tail.onclick = drawMore;
            }
        };
        drawMore();
        alignColumnHeader();
        renderCounts();
    }

    const RENDER_CHUNK = 150;

    /* ONE ROW PER CASE — the analyser's row, with this tool's chat button on it.
     *
     * The tier is a coloured stripe down the left edge, so the grouping is still readable once
     * its heading has scrolled away; `needs-soti` washes the row red, because "this one is
     * waiting on us" is the thing most worth seeing without opening anything.
     *
     * Off, a click on the row opens the case in Salesforce. Selecting, it ticks the row — a
     * click meant to choose a case must never cost a Salesforce tab — and the controls at the
     * end step aside (see .oc-selecting in qa-styles.css). The class is toggled in place
     * rather than the list re-rendered, so a run of clicks down the queue repaints nothing. */
    function caseRow(rec) {
        const key = keyOf(rec);
        const row = document.createElement('div');
        row.className = 'oc-row tier-' + entitlementTier(rec.entitlement).key
            + (statusIsOnSoti(rec.status) ? ' needs-soti' : '');
        row.dataset.key = key;

        const state = ROW_STATE.get(key);
        if (state) row.classList.add('qa-' + state);

        const main = document.createElement('div');
        main.className = 'oc-row-main';
        const opens = urlOf(rec) ? `Open ${rec.caseNum || 'this case'} in Salesforce` : 'This case has no Salesforce link yet';
        main.title = rec.subject ? `${rec.subject}\n\n${opens}` : opens;

        if (SELECTING) {
            const box = document.createElement('span');
            box.className = 'oc-sel-box';
            box.textContent = '✓';
            box.setAttribute('aria-hidden', 'true');
            row.appendChild(box);
            const on = SELECTED.has(key);
            row.classList.toggle('is-selected', on);
            row.setAttribute('role', 'checkbox');
            row.setAttribute('aria-checked', on ? 'true' : 'false');
            row.tabIndex = 0;
            const flip = () => {
                // The run took its list when it started; ticks made now would read as part of it.
                if (RUN.active) { toast('A run is going — the selection is held until it finishes.', 'w'); return; }
                const now = !SELECTED.has(key);
                if (now) SELECTED.add(key); else SELECTED.delete(key);
                row.classList.toggle('is-selected', now);
                row.setAttribute('aria-checked', now ? 'true' : 'false');
                renderListBar();
            };
            row.onclick = flip;
            row.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
        } else {
            main.onclick = () => openInSalesforce(rec);
        }

        const num = document.createElement('span');
        num.className = 'oc-num';
        num.textContent = rec.caseNum || '(no number)';
        main.appendChild(num);

        /* THE SUBJECT'S SLOT IS ALWAYS FILLED, AND ALWAYS HERE — it is the cell that absorbs
         * whatever width the fixed columns do not use, and the heading strip keeps its subject
         * cell in this same position, so the two lines stay a grid whether it is on or off. */
        const subject = document.createElement('span');
        if (columnOn('subject')) {
            subject.className = 'oc-subject';
            subject.textContent = rec.subject || '(no subject)';
        } else {
            subject.className = 'oc-subject oc-subject-empty';
            subject.setAttribute('aria-hidden', 'true');
        }
        main.appendChild(subject);

        for (const col of enabledColumns()) {
            if (col.key === 'subject') continue;
            addColumnCell(main, col.key, rec);
        }

        if (state) {
            const st = document.createElement('span');
            st.className = 'qa-row-state';
            st.textContent = state === 'working' ? 'reading…' : state === 'queued' ? 'queued' : 'failed';
            main.appendChild(st);
        }
        row.appendChild(main);

        /* THE WAY INTO THIS CASE'S CHAT — this tool's one addition to the analyser's row.
         * Outside .oc-row-main, because the row itself opens Salesforce. */
        const chat = document.createElement('button');
        chat.className = 'qa-row-chat';
        chat.type = 'button';
        const existing = CHATS[key];
        const n = existing && existing.msgs ? existing.msgs.filter(m => m.role === 'user').length : 0;
        chat.title = n
            ? `Chat about this case (${n} question${n === 1 ? '' : 's'} asked so far)`
            : 'Chat about this case';
        chat.setAttribute('aria-label', chat.title);
        chat.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
        if (n) chat.classList.add('has-chat');
        chat.onclick = (e) => { e.stopPropagation(); openChat(key); };
        row.appendChild(chat);

        // WHAT THE CASE IS ABOUT, one click away and closed by default.
        const body = document.createElement('div');
        body.className = 'oc-desc';
        body.style.display = 'none';

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'oc-desc-toggle';
        toggle.textContent = '▸';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', `Show what ${rec.caseNum || 'this case'} is about`);
        toggle.title = 'Issue summary, and its QA review';
        toggle.onclick = (e) => {
            // Without this the click bubbles to the row and opens the case in Salesforce.
            e.stopPropagation();
            const open = body.style.display === 'none';
            if (open) fillCaseDescription(body, rec);
            body.style.display = open ? '' : 'none';
            toggle.textContent = open ? '▾' : '▸';
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        row.appendChild(toggle);

        /* TAKE A CASE OFF THE QUEUE. Local only, and it asks first: the × is a few pixels from
         * the chevron, inside a list people scroll with a trackpad. */
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'oc-row-del';
        del.textContent = '×';
        del.title = `Remove ${rec.caseNum || 'this case'} from this list — it asks first. Local only; nothing changes in Salesforce.`;
        del.setAttribute('aria-label', `Remove ${rec.caseNum || 'this case'} from the list`);
        del.onclick = (e) => { e.stopPropagation(); removeCases([rec]); };
        row.appendChild(del);

        row.appendChild(body);

        // Right-click: open it, QA it, chat about it, copy it, remove it.
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openCaseRowMenu(e, rec); });
        return row;
    }

    /* THE EXPANDER. What the case is about, as the list view has it, and where its QA stands.
     * Built with textContent throughout — every string here was scraped off a Salesforce page,
     * and a case subject can contain anything at all. Filled on every open, so a review written
     * since the row was drawn is there the next time it is opened. */
    function fillCaseDescription(body, rec) {
        body.textContent = '';
        const label = document.createElement('div');
        label.className = 'oc-desc-label';
        label.textContent = 'Issue Summary';
        body.appendChild(label);

        const prose = String(rec.analysis || rec.description || '').trim();
        const text = document.createElement('div');
        if (prose) {
            text.className = 'oc-desc-text';
            text.style.whiteSpace = 'pre-wrap';
            text.textContent = prose.length > 1500 ? prose.slice(0, 1500) + '…' : prose;
        } else {
            text.className = 'oc-desc-none';
            text.textContent = rec.subject && rec.subject !== '(not read yet)'
                ? `${rec.subject}. The list view carries no summary for this case — it is read in full when it is QA'd.`
                : 'Not read yet — the case is read in full the first time it is QA\'d.';
        }
        body.appendChild(text);

        const tags = document.createElement('div');
        tags.className = 'oc-desc-tags';
        const tag = (value, cls, title) => {
            if (!value) return;
            const t = document.createElement('span');
            t.className = 'oc-tag' + (cls ? ' ' + cls : '');
            t.textContent = value;
            t.title = title || value;
            tags.appendChild(t);
        };
        const tier = entitlementTier(rec.entitlement);
        tag(rec.entitlement, 'ent-' + tier.key);
        tag(rec.status, statusIsOnSoti(rec.status) ? 'needs-soti' : '');
        tag(rec.priority ? `Severity: ${rec.priority}` : '', severityTagClass(rec.priority));
        tag(rec.account);
        tag(rec.contact);
        tag(rec.owner ? `Owner: ${rec.owner}` : rec.lastModifiedBy ? `Last modified by: ${rec.lastModifiedBy}` : '');
        const ms = milestoneOf(rec);
        if (ms) tag(`Due its ${ms}-day review`, 'qa-ms qa-ms-' + ms);
        if (tags.childNodes.length) body.appendChild(tags);

        /* WHERE ITS QA STANDS, and the next thing to do about it — so the expander answers
         * "has this been reviewed, and how did it go" without a trip to the Reviews tab. */
        const rev = qaReviewFor(rec);
        const qaLabel = document.createElement('div');
        qaLabel.className = 'oc-desc-label';
        qaLabel.style.marginTop = '9px';
        qaLabel.textContent = 'QA';
        body.appendChild(qaLabel);
        const qaLine = document.createElement('div');
        qaLine.className = rev && !incomplete(rev) ? 'oc-desc-text' : 'oc-desc-none';
        if (rev && !incomplete(rev)) {
            const sc = rev.score && rev.score.value !== null ? `${rev.score.value}/100 — ${rev.score.band}` : 'no score';
            qaLine.textContent = `Reviewed ${E.fmtDateTime(rev.at)}: ${sc}${rev.score && rev.score.derived ? ' (worked out from the measured facts)' : ''}.`;
        } else if (rev) {
            qaLine.textContent = `Read ${E.fmtDateTime(rev.at)}, but the write-up did not come back — open the review to see why, or QA it again.`;
        } else {
            qaLine.textContent = 'Not QA\'d yet.';
        }
        body.appendChild(qaLine);

        const acts = document.createElement('div');
        acts.className = 'oc-sync-row';
        const btn = (text, title, run) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'oc-sync-btn';
            b.textContent = text;
            b.title = title;
            b.onclick = (e) => { e.stopPropagation(); run(); };
            acts.appendChild(b);
        };
        btn(rev ? '▶ QA again' : '▶ QA this case', 'Read this case and write its QA review now', () => startRun('qa', [rec]));
        if (rev) btn('Open review', 'Show this case\'s review on the Reviews tab', () => showReview(rev));
        btn('💬 Chat', 'Ask about this case', () => openChat(keyOf(rec)));
        body.appendChild(acts);
    }

    /* A REVIEW, ON SCREEN — the Reviews tab, filtered to that case, with its card open. */
    function showReview(rev) {
        if (!rev) return;
        switchView('reviews');
        const search = $('revSearch');
        if (search) { search.value = rev.caseNum || ''; renderReviews(); }
        setTimeout(() => {
            const card = [...document.querySelectorAll('#revList .qa-rev')].find(c => c.dataset.id === rev.id) || document.querySelector('#revList .qa-rev');
            const head = card && card.querySelector('.qa-rev-head');
            if (head && card.querySelector('.qa-rev-body') && card.querySelector('.qa-rev-body').style.display === 'none') head.click();
            if (card) card.scrollIntoView({ block: 'start' });
        }, 30);
    }

    /* RIGHT-CLICK ON A CASE — the analyser's menu, with this tool's two actions in it. */
    function openCaseRowMenu(e, rec) {
        const url = urlOf(rec);
        const copy = async (text, what) => {
            try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 's', 1800); }
            catch (err) { toast('Could not copy to the clipboard', 'e'); }
        };
        const items = [{ head: rec.caseNum || 'Case' }];
        if (url) items.push({ label: 'Open in Salesforce', title: url, run: () => openInSalesforce(rec) });
        items.push({ label: qaReviewFor(rec) ? 'QA this case again' : 'QA this case', run: () => startRun('qa', [rec]) });
        items.push({ label: 'Chat about this case', run: () => openChat(keyOf(rec)) });
        const rev = qaReviewFor(rec);
        if (rev) items.push({ label: 'Open its review', run: () => showReview(rev) });
        items.push({ sep: true });
        if (rec.caseNum) items.push({ label: 'Copy case number', run: () => copy(rec.caseNum, 'Case number') });
        if (url) items.push({ label: 'Copy link', run: () => copy(url, 'Link') });
        items.push({ sep: true });
        items.push({ label: 'Remove from this list', danger: true, run: () => removeCases([rec]) });
        openMenu({ x: e.clientX, y: e.clientY }, items);
    }

    /* A SMALL MENU AT THE POINTER — the analyser's, used for a row and for a Current View chip.
     * Placed at the pointer and kept on screen; the pointer is in SCREEN pixels and the menu's
     * position is in the page's own, so it is divided by the Display size. */
    function closeMenu() {
        const m = $('qaMenu');
        if (m) m.remove();
    }
    function openMenu(at, items) {
        closeMenu();
        closeToolbarMenus();
        const menu = document.createElement('div');
        menu.id = 'qaMenu';
        menu.className = 'oc-menu oc-view-menu';
        menu.setAttribute('role', 'menu');
        for (const it of items) {
            if (it.head) {
                const h = document.createElement('div');
                h.className = 'oc-view-menu-head';
                h.textContent = it.head;
                menu.appendChild(h);
                continue;
            }
            if (it.sep) {
                const sep = document.createElement('div');
                sep.className = 'oc-view-menu-sep';
                menu.appendChild(sep);
                continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'oc-view-menu-item' + (it.danger ? ' is-danger' : '');
            b.setAttribute('role', 'menuitem');
            const t = document.createElement('span');
            t.className = 'oc-view-menu-t';
            t.textContent = it.label;
            b.appendChild(t);
            if (it.title) b.title = it.title;
            b.onclick = (ev) => { ev.stopPropagation(); closeMenu(); it.run(); };
            menu.appendChild(b);
        }
        menu.addEventListener('click', (ev) => ev.stopPropagation());
        menu.addEventListener('keydown', (ev) => {
            const btns = [...menu.querySelectorAll('.oc-view-menu-item')];
            const i = btns.indexOf(document.activeElement);
            if (ev.key === 'Escape') { ev.preventDefault(); closeMenu(); }
            else if (ev.key === 'ArrowDown' && btns.length) { ev.preventDefault(); btns[(i + 1) % btns.length].focus(); }
            else if (ev.key === 'ArrowUp' && btns.length) { ev.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
        });
        document.body.appendChild(menu);
        const W = window.innerWidth || document.documentElement.clientWidth || 420;
        const H = window.innerHeight || document.documentElement.clientHeight || 800;
        const r = menu.getBoundingClientRect();
        let x = at.alignRight ? at.x - r.width : at.x;
        let y = at.y;
        if (x + r.width > W - 8) x = W - 8 - r.width;
        if (x < 8) x = 8;
        if (y + r.height > H - 8) y = Math.max(8, H - 8 - r.height);
        menu.style.left = Math.round(x / uiZoom()) + 'px';
        menu.style.top = Math.round(y / uiZoom()) + 'px';
        const first = menu.querySelector('.oc-view-menu-item');
        if (first) try { first.focus({ preventScroll: true }); } catch (err) { /* not focusable yet */ }
    }

    // The Add Case menu and the cog's menu — both hang off the toolbar and close together.
    function closeToolbarMenus() {
        for (const id of ['ocAddMenu', 'ocCogMenu']) {
            const m = $(id);
            if (m) m.style.display = 'none';
        }
        closeOwnerMenu();
    }

    /* TAKE CASES OFF THE QUEUE — one from its ×, or the ticked ones from the bin. Asked first,
     * and the question says what happens next: a case still on the Salesforce list view comes
     * back with the next sync, one added by hand does not. Reviews already written are kept. */
    async function removeCases(recs) {
        const list = (recs || []).filter(Boolean);
        if (!list.length) return;
        if (RUN.active && list.some(r => ROW_STATE.has(keyOf(r)))) {
            toast('That case is part of the run going now — wait for it to finish.', 'w');
            return;
        }
        const one = list.length === 1;
        const manual = list.filter(r => r.manual).length;
        const fate = one
            ? (list[0].manual
                ? 'It was added by hand, so it is in no Salesforce list view — a sync will NOT bring it back.'
                : 'Sync From Salesforce brings it back while it is still on the list view.')
            : (manual
                ? `${manual} of them ${manual === 1 ? 'was' : 'were'} added by hand and will not come back with a sync; the rest come back while they are still on the list view.`
                : 'Sync From Salesforce brings them back while they are still on the list view.');
        const ok = await confirmAsk(
            one ? `Remove ${list[0].caseNum || 'this case'} from this list?` : `Remove ${list.length} cases from this list?`,
            `${fate} Nothing changes in Salesforce, and reviews already written are kept.`,
            'Remove');
        if (!ok) return;
        const gone = new Set(list.map(keyOf));
        CASES.cases = CASES.cases.filter(c => !gone.has(keyOf(c)));
        for (const k of gone) SELECTED.delete(k);
        if (SELECTING && !SELECTED.size && !one) SELECTING = false;
        await store({ [K.cases]: CASES });
        renderCases();
        toast(one ? `${list[0].caseNum || 'Case'} removed from the list.` : `${list.length} cases removed from the list.`, 'i', 5000);
    }


    /* THE BAR ABOVE THE CASES — its two states, as the analyser's has them. Normal: Select, the
     * QA run, the cog. Selecting: the count, Select all, the bin and Cancel in place of Select,
     * and the whole view marked so every row grows its tick-box.
     *
     * THE COUNT IS ON THE QA BUTTON, not only beside it — pressing it should never be a guess
     * about what it will act on, least of all when a filter is narrowing the list, because a
     * tick made under one filter stays ticked under the next (and the count says so). */
    function renderListBar(shown) {
        const bar = $('ocActions');
        if (!bar) return;
        const total = CASES.cases.length;
        bar.style.display = total ? '' : 'none';
        const view = $('viewCases');
        if (view) view.classList.toggle('oc-selecting', SELECTING);
        const vis = shown || visibleCases();
        const visKeys = new Set(vis.map(keyOf));
        const n = SELECTED.size;
        const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
        show('ocSelect', !SELECTING);
        show('ocSelectAll', SELECTING);
        show('ocSelCount', SELECTING);
        show('ocSelDelete', SELECTING);
        show('ocSelCancel', SELECTING);

        const count = $('ocSelCount');
        if (count) {
            const hidden = [...SELECTED].filter(k => !visKeys.has(k)).length;
            count.textContent = `${n} selected`;
            count.title = hidden ? `${hidden} of them ${hidden === 1 ? 'is' : 'are'} not shown by the filter now on` : '';
        }
        const selAll = $('ocSelectAll');
        if (selAll) selAll.disabled = RUN.active || (vis.length > 0 && vis.every(r => SELECTED.has(keyOf(r))));
        const del = $('ocSelDelete');
        if (del) {
            del.disabled = !n || RUN.active;
            del.title = n
                ? `Remove the ${n} ticked case${n === 1 ? '' : 's'} from this list. Local only; nothing changes in Salesforce, and reviews already written are kept.`
                : 'Nothing ticked — click a case to tick it';
            del.setAttribute('aria-label', n ? `Remove ${n} ticked case${n === 1 ? '' : 's'}` : 'Nothing ticked');
        }

        const qa = $('btnRunQa');
        const qaLabel = $('btnRunQaLabel');
        if (qa) {
            qa.disabled = RUN.active;
            qa.classList.toggle('is-ready', n > 0);
            qa.title = RUN.active ? 'A run is going — wait for it or press Stop.'
                : n ? `Write a QA review of the ${n} ticked case${n === 1 ? '' : 's'}`
                : 'Press to choose cases — tick them, then press QA again';
        }
        if (qaLabel) qaLabel.textContent = n ? `QA ${n} case${n === 1 ? '' : 's'}` : 'QA selected';
        const b369 = $('btnRun306090');
        if (b369) b369.disabled = RUN.active;
    }

    function setSelecting(on) {
        SELECTING = !!on;
        if (!SELECTING) SELECTED.clear();
        renderCases();
    }

    function selectedRecords() {
        return CASES.cases.filter(c => SELECTED.has(keyOf(c)));
    }

    function openInSalesforce(rec) {
        const url = urlOf(rec);
        if (!url) { toast('This case has no Salesforce link — sync the list again.', 'w'); return; }
        if (!isExt()) { window.open(url, '_blank'); return; }
        window.QaReader.createTab({ url, active: true }, () => {});
    }

    /* ---------------------------------------------------------------------
     * SYNCING THE QUEUE FROM A SALESFORCE LIST VIEW
     * ---------------------------------------------------------------------
     * A Lightning list view is a SNAPSHOT of the moment it loaded — it does not
     * re-query because time has passed — so syncing a tab that has been open all
     * day reads this morning's queue: cases closed since then still in it, cases
     * opened since then missing, every age stale, and nothing about the result
     * looking wrong. Refreshing first is therefore part of what this button IS,
     * rather than a second control beside it.
     * ------------------------------------------------------------------- */
    const SF_HOST = /(^|\.)(salesforce\.com|force\.com)$/i;

    function sfUrl(raw) {
        try {
            const u = new URL(String(raw || ''));
            if (u.protocol !== 'https:' || !SF_HOST.test(u.hostname)) return '';
            return u.href;
        } catch (e) { return ''; }
    }

    function isListUrl(raw) {
        const url = sfUrl(raw);
        if (!url) return false;
        if (reportIdOf(url)) return true;
        try { return /\/lightning\/o\/[^/]+\/(list|home)\b/i.test(new URL(url).pathname); }
        catch (e) { return false; }
    }

    /* A REPORT IS A CASE LIST TOO (the analyser's rule): /lightning/r/Report/00O…/view, the
     * viewer opened on its own, or a Classic /00O… report. content.js reads its rows out of the
     * report's frame. The report's id when the address is one, '' otherwise. */
    function reportIdOf(raw) {
        const url = sfUrl(raw);
        if (!url) return '';
        try {
            const u = new URL(url);
            const m = u.pathname.match(/\/lightning\/r\/(?:Report\/)?(00O[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)(?:\/|$)/)
                || u.pathname.match(/^\/(00O[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)(?:\/|$)/);
            if (m) return m[1];
            const id = /\/reports\/lightningReportApp\.app/i.test(u.pathname) ? (u.searchParams.get('reportId') || '') : '';
            return /^00O[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/.test(id) ? id : '';
        } catch (e) { return ''; }
    }

    /* EMEA AGENT CASES, THERE FROM THE START — the analyser's default list (named "Agent Cases"
     * there, and here until 3.1.0 — see RENAMED_LISTS). Put in Current View the
     * first time this build runs, like a list the reviewer saved themselves: same chip, same
     * sync, same right-click. OFFERED ONCE: its id is written down when it is put in, so a
     * reviewer who forgets it has forgotten it, and one who already saved the same report under
     * another name keeps theirs and is not given a second chip. */
    const DEFAULT_LISTS = [
        { id: 'ql-agent-cases', name: 'EMEA Agent Cases',
          url: 'https://soti.lightning.force.com/lightning/r/Report/00OOF000003bijV2AQ/view?queryScope=userFolders' },
        /* EVERY CASE CLOSED IN EMEA — the list to QA closed work from. Its closed date is what
         * files each review under its month on the Reviews tab, and the owner dropdown narrows
         * it to the people being reviewed. Second, so a first Sync still opens EMEA Agent Cases. */
        { id: 'ql-emea-closed', name: 'EMEA Closed Cases',
          url: 'https://soti.lightning.force.com/lightning/r/Report/00OOF000003c2K12AI/view?queryScope=userFolders' }
    ];
    /* A DEFAULT LIST WHOSE NAME HAS CHANGED SINCE IT WAS PUT IN — renamed once, on the copies
     * that still carry the old name. A reviewer who renamed it themselves keeps their name, and
     * the marker in listsOffered stops a name they later set back from being changed again. */
    const RENAMED_LISTS = [
        { id: 'ql-agent-cases', from: 'Agent Cases', to: 'EMEA Agent Cases', marker: 'ql-agent-cases:emea-name' }
    ];
    async function offerDefaultLists() {
        if (!isExt()) return;
        try {
            const got = await load([K.listsOffered]);
            const offered = Array.isArray(got[K.listsOffered]) ? got[K.listsOffered] : [];
            let changed = false;
            for (const r of RENAMED_LISTS) {
                if (offered.includes(r.marker)) continue;
                offered.push(r.marker);
                changed = true;
                const def = DEFAULT_LISTS.find(d => d.id === r.id);
                for (const l of LISTS) if (l.id === r.id && l.name === r.from) l.name = r.to;
                // The tooltip's "synced … from Agent Cases" is the same name, remembered separately.
                if (LAST_LIST && LAST_LIST.name === r.from && def && sameList(LAST_LIST.url, def.url)) {
                    LAST_LIST.name = r.to;
                    await store({ [K.lastList]: LAST_LIST });
                }
            }
            const added = [];
            for (const d of DEFAULT_LISTS) {
                if (offered.includes(d.id)) continue;
                offered.push(d.id);
                if (!LISTS.some(l => l.id === d.id || sameList(l.url, d.url))) {
                    added.push({ id: d.id, name: d.name, url: d.url, at: Date.now() });
                }
                changed = true;
            }
            /* In front of the reviewer's own lists, and in THIS order — EMEA Agent Cases first,
             * because a Sync that has never run opens the first list in Current View. A reviewer who
             * has already been given it gets the new one put just after it. */
            if (added.length) {
                const after = LISTS.findIndex(l => l.id === 'ql-agent-cases');
                if (after >= 0 && !added.some(a => a.id === 'ql-agent-cases')) LISTS.splice(after + 1, 0, ...added);
                else LISTS.unshift(...added);
            }
            if (changed) await store({ [K.lists]: LISTS, [K.listsOffered]: offered });
        } catch (e) { /* offered next start */ }
    }

    // Two list-view addresses are THE SAME LIST when they agree on path and filter.
    // Salesforce rewrites its own query string as the grid is used, so a whole-URL match
    // would fail against the very tab it is looking for.
    function sameList(a, b) {
        if (!a || !b) return false;
        try {
            const x = new URL(a), y = new URL(b);
            if (x.hostname !== y.hostname) return false;
            // A report is the same report whatever view of it the address names.
            const rx = reportIdOf(a), ry = reportIdOf(b);
            if (rx || ry) return rx.slice(0, 15) === ry.slice(0, 15);
            if (x.pathname !== y.pathname) return false;
            return (x.searchParams.get('filterName') || '') === (y.searchParams.get('filterName') || '');
        } catch (e) { return false; }
    }

    function listLabel(url) {
        try {
            const u = new URL(url);
            const f = u.searchParams.get('filterName');
            if (f) return f.replace(/[_-]+/g, ' ').trim();
            if (reportIdOf(url)) return 'Salesforce report';
            const o = (u.pathname.match(/\/lightning\/o\/([^/]+)\//) || [])[1];
            if (o) return o + ' list';
        } catch (e) { /* fall through */ }
        return 'the Salesforce list';
    }

    const queryTabs = (q) => new Promise((res) => {
        try { chrome.tabs.query(q, (t) => { void chrome.runtime.lastError; res(t || []); }); }
        catch (e) { res([]); }
    });

    function focusTab(tab) {
        if (!tab) return;
        try {
            chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId != null && chrome.windows && chrome.windows.update) {
                chrome.windows.update(tab.windowId, { focused: true });
            }
        } catch (e) { /* the tab went between the query and the update */ }
    }

    /* WHICH TAB TO READ, in the order a person would look.
     *
     * It NEVER GUESSES AT A URL: the remembered list is one the reviewer stood on and synced
     * from, and a list view assembled out of an org's hostname would be a queue read from a
     * filter nobody chose. And never a reader tab — those hold case records open during a
     * run, in a minimized window, and "focusing" one sends the reviewer somewhere they
     * cannot see. */
    async function resolveListTab() {
        const all = (await queryTabs({})).filter(t => t && t.url && !window.QaReader.ownsTab(t));
        const [active] = await queryTabs({ active: true, currentWindow: true });
        const activeOk = active && active.id != null && !window.QaReader.ownsTab(active);

        if (activeOk && isListUrl(active.url)) return { tab: active };
        if (LAST_LIST) {
            const hit = all.find(t => sameList(t.url, LAST_LIST.url));
            if (hit) { focusTab(hit); return { tab: hit }; }
        }
        const anyList = all.find(t => isListUrl(t.url));
        if (anyList) { focusTab(anyList); return { tab: anyList }; }
        // Never synced yet: the first saved list — EMEA Agent Cases unless the reviewer forgot it —
        // is opened, as the analyser's Sync does.
        const target = LAST_LIST || (LISTS.length ? { url: LISTS[0].url, name: LISTS[0].name } : null);
        if (!target && activeOk && sfUrl(active.url)) return { tab: active };
        if (target) {
            const opened = await new Promise((res) => {
                try { window.QaReader.createTab({ url: target.url, active: true }, (t) => res(t || null)); }
                catch (e) { res(null); }
            });
            if (opened && opened.id != null) return { openedTabId: opened.id, name: target.name };
            return { why: `Could not open ${target.name} in a new tab.` };
        }
        return {
            why: 'Open a Salesforce case LIST view — Cases, then whichever queue you review from — and press this once. '
                + 'After that this tool remembers it and can go back on its own.'
        };
    }

    // A tab that was already open when the extension was installed or reloaded has NO content
    // script in it: Chrome injects those as a page loads. So a message to it goes nowhere and
    // the sync fails with "could not read that tab" about a page that was perfectly readable.
    // Inject and ask again.
    async function tell(tabId, message) {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (e) {
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            await new Promise(r => setTimeout(r, 600));
            return await chrome.tabs.sendMessage(tabId, message);
        }
    }

    async function waitForGrid(tabId, deadline) {
        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 900));
            let r = null;
            try { r = await tell(tabId, { action: 'GET_SALESFORCE_LIST_READY' }); } catch (e) { r = null; }
            if (r && r.ready && !r.fetching) return true;
        }
        return false;
    }

    /* THE COUNT AND THE AGE OF THE LAST SYNC, on the Sync button's own title — the analyser
     * moved them there from a strip of their own, and the label keeps to what it does. */
    const SYNC_TITLE = 'Refresh the Salesforce list view and read every case from it. If it is open in another tab this '
        + 'brings it to the front; if it is closed it opens the one you last synced from.';
    function paintSyncLabel() {
        const btn = $('btnSyncCaseList');
        const label = $('ocSyncLabel');
        if (!btn || !label || btn.disabled) return;
        label.textContent = 'Sync From Salesforce';
        const t = CASES.cases.length;
        if (!t) { btn.title = SYNC_TITLE; return; }
        const n = visibleCases().length;
        const count = n === t ? String(t) : `${n} of ${t}`;
        const when = CASES.scrapedAt ? ` · synced ${E.fmtDateTime(CASES.scrapedAt)}` : '';
        const from = LAST_LIST && LAST_LIST.name ? ` from ${LAST_LIST.name}` : '';
        btn.title = `${count} case${t === 1 ? '' : 's'}${when}${from}. Press to sync again.\n\n${SYNC_TITLE}`;
    }

    async function syncCaseList() {
        const found = await resolveListTab();
        if (!found.tab && found.openedTabId == null) {
            toast(found.why || 'No Salesforce case list to read.', 'e', 12000);
            return;
        }
        return runSync(found, found.name || (LAST_LIST && LAST_LIST.name) || 'The case list');
    }

    /* THE SYNC ITSELF, given a tab to read it from.
     *
     * Split out from syncCaseList so the saved list views below can drive exactly the same
     * job. There is only ever one of these: two ways into a sync that then read the list
     * differently is how "Sync" and "press the chip" end up producing different queues from
     * the same Salesforce view, and nobody would know which one to believe.
     *
     * `found` is what resolveListTab returns, or the same shape built by hand: a tab to read,
     * or the id of one that has just been opened and has not finished loading yet.
     */
    async function runSync(found, name) {
        if (!isExt()) { toast('Syncing needs the Chrome extension.', 'e'); return; }
        const btn = $('btnSyncCaseList');
        const label = $('ocSyncLabel');
        const was = label ? label.textContent : '';
        if (btn) btn.disabled = true;
        if (label) label.textContent = 'Syncing…';
        try {
            let tab = found.tab;
            if (found.openedTabId != null) {
                toast(`${name || 'The case list'} was not open — opening it and syncing once the grid has loaded…`, 'i', 9000);
                // A report draws in a frame of its own and takes longer than a list view.
                const ok = await waitForGrid(found.openedTabId, Date.now() + 90000);
                if (!ok) { toast('The list did not finish loading. Press Sync again once it has.', 'w', 9000); return; }
                try { tab = await chrome.tabs.get(found.openedTabId); } catch (e) { tab = null; }
            }
            if (!tab) {
                toast(found.why || 'No Salesforce case list to read.', 'e', 12000);
                return;
            }

            if (label) label.textContent = 'Refreshing…';
            let refreshed = null;
            try {
                refreshed = await Promise.race([
                    tell(tab.id, { action: 'REFRESH_SALESFORCE_LIST', budgetMs: 25000 }),
                    new Promise(r => setTimeout(() => r(null), 30000))
                ]);
            } catch (e) { refreshed = null; }
            if (!refreshed || !refreshed.ok) {
                // Said out loud, because it is the one thing the reviewer cannot see for
                // themselves: the sync is about to run against the same rows as before, and
                // silence would leave them believing the queue is current when it is not.
                toast('Could not press Refresh on the list — reading it as it stands. If it has been open a while, refresh it yourself and sync again.', 'w', 9000);
            }

            if (label) label.textContent = 'Reading…';
            toast('Reading the case list — scrolling to load every case…', 'i', 6000);
            const data = await tell(tab.id, { action: 'GET_SALESFORCE_CASE_LIST' });
            if (!data || !Array.isArray(data.cases) || !data.cases.length) {
                toast('No case rows found. Open a case list view or report (e.g. EMEA Agent Cases) and try again.', 'e', 10000);
                return;
            }

            mergeCases(data);
            /* NAMED FROM THE TAB THAT WAS ACTUALLY READ, not from whatever was pressed. A
             * sync can land on a list the reviewer was already standing on rather than the
             * one this run set out to open, and a queue labelled with the wrong view is worse
             * than one labelled "Case list". The reviewer's own name for the view wins when
             * it is genuinely the same view — that is what they chose to call it. */
            const saved = LISTS.find(l => sameList(l.url, tab.url));
            LAST_LIST = { url: sfUrl(tab.url), name: (saved && saved.name) || (reportIdOf(tab.url) && data.listName) || listLabel(tab.url), at: Date.now() };
            await store({ [K.cases]: CASES, [K.lastList]: LAST_LIST });
            renderCases();

            /* SAY WHETHER THE WHOLE LIST CAME BACK. The list view prints its own total, and
             * the scraper reports it, so a short read can be NAMED rather than left to look
             * like a complete queue that happens to be small — which is the failure the
             * scroll loader exists to prevent: 30 cases arriving as 25 looks exactly like
             * 25 cases. */
            const load = data.listLoad || {};
            const got = data.cases.length;
            const gaveUp = ['time-budget', 'exhausted-rounds', 'still-loading'].includes(load.reason);
            if (load.declared && got < load.declared) {
                toast(`Synced ${got} cases, but the list says it has ${load.declared}. It stopped after ${load.rounds} scroll(s) (${load.reason}) — sync again, or scroll the list yourself and retry.`, 'w', 12000);
            } else if (!load.declared && gaveUp) {
                toast(`Synced ${got} cases, but the list was still loading when the scroll gave up (${load.reason}) — there may be more. Sync again to pick up the rest.`, 'w', 11000);
            } else {
                toast(`Synced ${got} case${got === 1 ? '' : 's'}${load.declared ? ` of ${load.declared}` : ''}`, 's');
            }
        } catch (e) {
            toast('Sync failed: ' + ((e && e.message) || e), 'e', 12000);
        } finally {
            if (btn) btn.disabled = false;
            if (label) label.textContent = was || 'Sync From Salesforce';
            paintSyncLabel();
        }
    }

    /* ---------------------------------------------------------------------
     * SAVED SALESFORCE LIST VIEWS
     * ---------------------------------------------------------------------
     * The reviewer's own list-view addresses, e.g.
     *   https://soti.lightning.force.com/lightning/o/Case/list?filterName=Escalations
     * kept as chips under the toolbar. Pressing one opens that view in Salesforce AND syncs
     * the queue from it once the grid has rendered — which is the entire point of them: the
     * four-step "go to Salesforce, find the view, come back, press Sync" is the reason a
     * reviewer QAs whichever queue happens to be on screen rather than the one they meant.
     *
     * The same feature, the same class names and the same two-step dialog as the analyser's,
     * because a reviewer has both panels open at once and one of them behaving differently
     * for no reason is a thing they have to remember rather than know.
     *
     * WHAT IS DIFFERENT HERE, and deliberately: deleting a chip does NOT delete cases. In
     * the analyser a queue accumulates several lists at once, so a list owns its rows and
     * takes them with it. In this tool a sync REPLACES the queue (see mergeCases) — the
     * queue is one list's snapshot — so there are no rows that belong to the chip being
     * deleted, and pretending otherwise would delete somebody else's list.
     *
     * ONLY https SALESFORCE ADDRESSES GO IN. This is a URL the panel will navigate a tab to
     * on a click, so it is checked when it is saved rather than trusted because a person
     * pasted it.
     * ------------------------------------------------------------------- */
    /* CURRENT VIEW — the saved list views, drawn as the analyser draws its own: a heading, then a
     * row of chips that scrolls sideways rather than wrapping. Press one to open that view in
     * Salesforce and sync the queue from it; right-click it to rename or forget it. The one
     * the queue was last synced from is marked, so a reviewer with four saved queues can see
     * which they are looking at. */
    function renderLists() {
        const wrap = $('ocLists');
        if (!wrap) return;
        const before = wrap.querySelector('.oc-links-row');
        const keepScroll = before ? before.scrollLeft : 0;
        wrap.textContent = '';
        // Empty is HIDDEN, not an empty band between the toolbar and the filters.
        wrap.style.display = LISTS.length ? '' : 'none';
        if (!LISTS.length) return;

        const label = document.createElement('div');
        label.className = 'oc-links-label';
        label.textContent = 'Current View';
        wrap.appendChild(label);

        const row = document.createElement('div');
        row.className = 'oc-links-row';
        row.setAttribute('role', 'toolbar');
        row.setAttribute('aria-label', 'Current View — your saved list views');
        wrap.appendChild(row);

        for (const link of LISTS) {
            const chip = document.createElement('button');
            chip.type = 'button';
            const current = !!(LAST_LIST && sameList(LAST_LIST.url, link.url));
            chip.className = 'oc-view-chip is-list' + (current ? ' is-current' : '');
            chip.dataset.id = link.id;
            const icon = document.createElement('span');
            icon.className = 'oc-view-ic';
            icon.innerHTML = LIST_ICON;
            chip.appendChild(icon);
            const name = document.createElement('span');
            name.className = 'oc-view-name';
            name.textContent = link.name;
            chip.appendChild(name);
            chip.title = `${link.name} — open it in Salesforce and sync this queue from it.\nRight-click to rename or forget it.`;
            chip.onclick = () => openList(link);
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const r = chip.getBoundingClientRect();
                const at = (e.clientX || e.clientY) ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 };
                openMenu(at, [
                    { head: link.name },
                    { label: 'Open and sync', run: () => openList(link) },
                    { label: 'Rename', run: () => renameList(link.id) },
                    { sep: true },
                    { label: 'Forget this list view', danger: true, run: () => deleteList(link.id) }
                ]);
            });
            row.appendChild(chip);
        }
        row.scrollLeft = keepScroll;
    }

    // What KIND of chip it is, before its name is read — the analyser's list glyph.
    const LIST_ICON = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="9" y1="6" x2="21" y2="6"></line><line x1="9" y1="12" x2="21" y2="12"></line><line x1="9" y1="18" x2="21" y2="18"></line><line x1="3.5" y1="6" x2="3.6" y2="6"></line><line x1="3.5" y1="12" x2="3.6" y2="12"></line><line x1="3.5" y1="18" x2="3.6" y2="18"></line></svg>';

    async function renameList(id) {
        const link = LISTS.find(l => l.id === id);
        if (!link) return;
        const name = await ask({
            title: 'Rename this list view',
            note: 'What it says on the chip. Nothing changes in Salesforce.',
            value: link.name,
            placeholder: link.name,
            ok: 'Rename',
            validate: (v) => v ? '' : 'Give it a name.'
        });
        if (!name) return;
        link.name = name;
        await store({ [K.lists]: LISTS });
        renderLists();
    }

    async function addListByUrl() {
        const url = await ask({
            title: 'Add a Salesforce list view',
            note: 'Paste the address of a case list view or a Salesforce report of cases — EMEA Agent Cases, or whichever queue you QA from. '
                + 'It is kept as a button here, and pressing it opens that view in Salesforce and syncs this queue from it.',
            placeholder: 'https://your-org.lightning.force.com/lightning/o/Case/list?filterName=…',
            ok: 'Save list view',
            validate: (v) => {
                if (!v) return 'Paste the list view address.';
                if (!sfUrl(v)) return 'That is not an https Salesforce address.';
                /* A CASE LINK PASTED HERE IS A MISTAKE WORTH NAMING, because the two buttons
                 * sit side by side and the addresses look alike at a glance. Saying which
                 * button it belongs to costs a line and saves the reviewer working it out. */
                if (isCaseUrl(v)) {
                    return 'That is a link to one case, not a list view. Use "Add case" for that.';
                }
                if (!isListUrl(v)) return 'That is not a Salesforce list view or report address — it should contain /lightning/o/Case/list or /lightning/r/Report/.';
                if (LISTS.some(l => sameList(l.url, v))) return 'That list view is already saved.';
                return '';
            }
        });
        if (!url) return;

        const clean = sfUrl(url);
        // NAMED IN A SECOND STEP rather than assumed, because the filterName Salesforce puts
        // in the address ("Open_Cases10") is a machine's name for the view and the reviewer
        // has their own. Cancelling here saves nothing — a half-added list is not a list.
        const name = await ask({
            title: 'Name this list view',
            note: 'What it says on the button. Leave the suggestion if it is fine.',
            value: listLabel(clean),
            placeholder: 'Escalations',
            ok: 'Save'
        });
        if (name === null) return;

        LISTS.push({ id: 'ql-' + Date.now().toString(36), name: name || listLabel(clean), url: clean, at: Date.now() });
        await store({ [K.lists]: LISTS });
        renderLists();
        toast('List view saved. Press it to open that queue and sync from it.', 's', 6000);
    }

    async function deleteList(id) {
        const link = LISTS.find(l => l.id === id);
        if (!link) return;
        const ok = await confirmAsk(`Forget "${link.name}"?`,
            'Only the button goes. Nothing changes in Salesforce, the cases already synced stay in the queue, '
            + 'and the view can be added again from its address.',
            'Forget it');
        if (!ok) return;
        LISTS = LISTS.filter(l => l.id !== id);
        await store({ [K.lists]: LISTS });
        renderLists();
    }

    /* PRESS A SAVED VIEW: go there, then sync from it.
     *
     * An already-open tab on the same view is REUSED rather than duplicated — a reviewer who
     * presses the chip three times should not end up with three Salesforce tabs — and it is
     * matched with sameList, which compares the path and the filter rather than the whole
     * address, because Lightning rewrites its own query string as the grid is used.
     *
     * Never a reader tab: those hold case records open during a run, in a minimized window,
     * and "focusing" one sends the reviewer somewhere they cannot see.
     */
    async function openList(link) {
        const url = sfUrl(link && link.url);
        if (!url) { toast('That saved list view is not a valid Salesforce address any more.', 'e'); return; }
        if (!isExt()) { toast('Opening a list view needs the Chrome extension.', 'e'); return; }

        const open = (await queryTabs({})).filter(t => t && t.url && !window.QaReader.ownsTab(t));
        const hit = open.find(t => sameList(t.url, url));
        if (hit) {
            focusTab(hit);
            toast(`${link.name} is already open — syncing it now…`, 'i', 8000);
            return runSync({ tab: hit }, link.name);
        }

        const tab = await new Promise((res) => {
            try { window.QaReader.createTab({ url, active: true }, (t) => res(t || null)); }
            catch (e) { res(null); }
        });
        if (!tab || tab.id == null) { toast(`Could not open ${link.name} in a new tab.`, 'e', 9000); return; }
        return runSync({ openedTabId: tab.id }, link.name);
    }

    /* A SYNC REPLACES THE LIST, BUT KEEPS WHAT THE LIST CANNOT SAY.
     *
     * The queue IS the Salesforce list — a case closed since this morning should leave it,
     * and one opened since should arrive. What must survive is anything this tool learned
     * that the list view has no column for: nothing yet on the row itself, but the SELECTION
     * and the REVIEWS are keyed by case number and would otherwise be orphaned by a re-sync
     * that rebuilt every row. Reviews live in their own store and are unaffected; the
     * selection is pruned here to whatever is still in the queue, so "QA 6 cases" can never
     * mean a case that is no longer on screen. */
    function mergeCases(data) {
        /* AND THE ROWS ADDED BY HAND. A case put in with its link is in no list view, so a sync
         * that rebuilt the queue from the list alone would quietly drop it — the very case the
         * reviewer went out of their way to add. It stays, unless the list now has it too. */
        const fresh = data.cases.slice();
        const has = new Set(fresh.map(keyOf));
        const kept = (CASES.cases || []).filter(c => c.manual && !has.has(keyOf(c))
            && !fresh.some(x => c.caseNum && x.caseNum === c.caseNum));
        CASES = {
            listName: data.listName || CASES.listName || '',
            origin: data.origin || CASES.origin || '',
            scrapedAt: data.scrapedAt || Date.now(),
            cases: [...fresh, ...kept]
        };
        const live = new Set(CASES.cases.map(keyOf));
        for (const k of [...SELECTED]) if (!live.has(k)) SELECTED.delete(k);
    }

    function isCaseUrl(v) {
        return !!sfUrl(v) && (/\/lightning\/r\/(?:[^/]+\/)?500[A-Za-z0-9]{12,15}\//.test(v) || /[?&]id=500/i.test(v));
    }

    async function addByUrl(given) {
        const url = typeof given === 'string' ? given : await ask({
            title: 'Add a case by its link',
            note: 'Paste the Salesforce address of one case. It is added to the list below and can then be ticked and reviewed like any other.',
            placeholder: 'https://your-org.lightning.force.com/lightning/r/Case/500…/view',
            ok: 'Add case',
            validate: (v) => {
                if (!v) return 'Paste the case link.';
                if (!sfUrl(v)) return 'That is not an https Salesforce address.';
                if (!isCaseUrl(v)) return 'That link does not point at a case record.';
                return '';
            }
        });
        if (!url) return;
        const clean = sfUrl(url);
        const recordId = (clean.match(/\/(500[A-Za-z0-9]{12,15})(?:\/|$)/) || clean.match(/[?&]id=(500[A-Za-z0-9]{12,15})/i) || [])[1] || '';
        if (CASES.cases.some(c => c.url === clean || (recordId && c.recordId === recordId))) {
            toast('That case is already in the list.', 'w');
            return;
        }
        /* ADDED BLANK, and honestly so: a link carries a record id and nothing else, so the
         * row has no subject, no owner and no age until it is read. Everything on it fills in
         * from the case itself the first time it is reviewed — see applyReadToRecord. MANUAL,
         * so a sync from a list view that does not hold it keeps it — see mergeCases. */
        CASES.cases.push({ recordId, url: clean, caseNum: '', subject: '(not read yet)', owner: '', ageDays: '', status: '', manual: true });
        if (!CASES.origin) { try { CASES.origin = new URL(clean).origin; } catch (e) {} }
        await store({ [K.cases]: CASES });
        renderCases();
        toast('Case added. Select it and press QA to read it in.', 's');
    }

    /* FROM THE SALESFORCE TAB — the case in front of the reviewer, without copying its link.
     * The tab asked for is the active one in the window they were last working in; the side
     * panel is not a tab, so that is the Salesforce page beside it. */
    async function addFromSalesforceTab() {
        if (!isExt()) { toast('Adding from a tab needs the Chrome extension.', 'e'); return; }
        const tabs = (await queryTabs({ active: true, lastFocusedWindow: true }))
            .concat(await queryTabs({ active: true }))
            .filter(t => t && t.url && !(window.QaReader && window.QaReader.ownsTab(t)));
        const hit = tabs.find(t => isCaseUrl(t.url));
        if (!hit) {
            toast('The tab in front is not a Salesforce case. Open the case, or use Add Case URL and paste its link.', 'w', 9000);
            return;
        }
        return addByUrl(hit.url);
    }

    /* WHAT THE READ TAUGHT US ABOUT THE ROW. A case added by URL has an empty row until it
     * has been opened; a case from a list view has whatever columns that list happened to
     * carry. Either way the record itself is the better source, so a review fills the row in.
     * Blank values never overwrite filled ones: a read that came back thin must not erase
     * what the list already told us. */
    function applyReadToRecord(rec, data) {
        if (!rec || !data) return;
        const set = (k, v) => { if (v !== null && v !== undefined && v !== '') rec[k] = v; };
        set('caseNum', data.caseNumber);
        if (!rec.subject || rec.subject === '(not read yet)') set('subject', data.subject);
        set('owner', data.caseOwner);
        set('lastModifiedBy', data.lastModifiedBy);
        set('status', data.caseStatus);
        set('account', data.accountName);
        set('contact', data.contactName);
        set('jira', data.jiraNumber);
        set('ageDays', data.caseAge);
        // The closing instant, when the record shows one — see closedAtOf.
        if (data.qaClosed && data.qaClosed.at) { rec.closedAt = data.qaClosed.at; rec.closed = data.qaClosed.raw || ''; }
        if (!rec.url && data.caseUrl) set('url', data.caseUrl);
    }

    /* WHEN THE CASE CLOSED, as far as anything this tool has read can say — the record itself
     * first (read during the run), then the list or report it was synced from. null for a case
     * that is still open, and for one whose layout and list carry no closed date. */
    function closedAtOf(rec, data) {
        const read = data && data.qaClosed && data.qaClosed.at;
        const n = Number(read || (rec && rec.closedAt));
        return Number.isFinite(n) && n > 0 ? n : null;
    }

    /* ---------------------------------------------------------------------
     * THE RUN
     * ---------------------------------------------------------------------
     * READING AND WRITING ARE DIFFERENT KINDS OF SLOW, and separating them is
     * most of the speed here.
     *
     * Reading a case is the browser: a Lightning page load and a scroll to the
     * end of a feed, a minute on a long case, and several can happen at once —
     * each in its own tab in the reader window.
     *
     * Writing a review is the relay: one Copilot tab, one conversation, one
     * answer at a time. Two reviews sent at once would be two prompts typed into
     * the same message box, and the answer that came back would belong to
     * neither case. So the AI half is STRICTLY SERIALISED behind one promise
     * chain, while the readers carry on ahead of it.
     *
     * The result is a pipeline: while case three is being written up, cases four
     * and five are already loading. It is bounded by `workers`, because every
     * case being read is a whole Salesforce page in memory on a support laptop.
     * ------------------------------------------------------------------- */
    async function startRun(kind, only) {
        if (RUN.active) { toast('A run is already going — wait for it or press Stop.', 'w'); return; }
        // One thing at a time through the relay — and one thing at a time on the pill.
        if (RUN.coaching) { toast('The coaching summary is being written — wait for it or press Stop.', 'w'); return; }
        const recs = only && only.length ? only.slice() : selectedRecords();
        if (!recs.length) { toast('Select some cases first — press Select, then click them.', 'w'); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open ⋮ → Settings and press Grant access to Copilot.', 'e', 10000);
            switchView('settings');
            return;
        }
        /* COPILOT FIRST, CASES SECOND. Reading thirty cases and then finding the relay locked
         * out is half an hour of work that ends in thirty "write-up FAILED" cards. Chrome's
         * grant is checked before anything is opened, and when a host is missing the Connect
         * Copilot dialog takes over — and starts this same run once Copilot has answered. */
        if ((await copilotAccessMissing()).length) {
            offerCopilotSetup({ force: true, then: () => startRun(kind, recs) });
            return;
        }

        RUN.active = true;
        RUN.stop = false;
        RUN.accessBlocked = false;
        RUN.kind = kind;
        RUN.total = recs.length;
        RUN.done = 0;
        RUN.failed = 0;
        // The first write-up of every run states how the case reached Copilot, even when
        // nothing is wrong — see the note where it is written. After that the log only speaks
        // up when something was lost.
        RUN.saidHow = false;

        for (const r of recs) ROW_STATE.set(keyOf(r), 'queued');
        // The run has its list; the ticks have done their job. Selecting ends with them.
        SELECTING = false;
        SELECTED.clear();
        renderCases();
        showRunPill(true);
        logLine(`Run started — ${recs.length} case(s), ${kind === '306090' ? '30/60/90 analysis' : 'QA review'}.`);
        switchView('reviews');

        const queue = recs.slice();
        let aiChain = Promise.resolve();

        const worker = async () => {
            while (queue.length && !RUN.stop) {
                const rec = queue.shift();
                const key = keyOf(rec);
                ROW_STATE.set(key, 'working');
                updateRow(key);
                setRunNote(`Reading ${rec.caseNum || 'a case'}… (${RUN.done}/${RUN.total})`);

                let read = await readOnce(rec);

                /* ONE MORE GO BEFORE GIVING UP ON IT.
                 *
                 * Most read failures on a long run are a Lightning page that took longer than
                 * its ceiling on this particular pass — the tab was one of four being loaded,
                 * or the feed was still fetching when the clock ran out. That case reads fine
                 * on its own a moment later, which is exactly what "one case keeps failing"
                 * looks like from the outside, and it is not worth making a reviewer notice
                 * and re-tick it. Failures that can never succeed — no link, not a case
                 * record, not running as an extension — are not retried; see retryableRead. */
                if (!read.ok && !RUN.stop && retryableRead(read.error)) {
                    logLine(`${rec.caseNum || key}: ${read.error} Trying it once more.`, 'warn');
                    setRunNote(`Retrying ${rec.caseNum || 'a case'}…`);
                    await new Promise(r => setTimeout(r, 2000));
                    read = await readOnce(rec);
                }

                if (!read.ok) {
                    ROW_STATE.set(key, 'failed');
                    updateRow(key);
                    RUN.failed++;
                    RUN.done++;
                    logLine(`${rec.caseNum || key}: ${read.error}`, 'fail');
                    /* A FAILED READ MUST NOT DELETE A GOOD REVIEW. Re-reviewing a case
                     * replaces its review, which is right when the new one is a review — but
                     * a case that would not open today is not a reason to lose the write-up
                     * from the day it did. */
                    const had = REVIEWS.find(r => r.id === `${key}|${kind}` && !r.error);
                    if (had) logLine(`${rec.caseNum || key}: keeping the review already on file for it.`, 'warn');
                    else await saveReview(failedReview(rec, kind, read.error));
                    setRunNote(`${RUN.done}/${RUN.total} done, ${RUN.failed} failed`);
                    continue;
                }

                let metrics;
                try {
                    applyReadToRecord(rec, read.data);
                    migrateKey(key, keyOf(rec));
                    metrics = E.measureCase(read.data, RULES);
                } catch (e) {
                    /* THE CASE WAS READ AND THE MEASUREMENT FELL OVER ON IT. That is a bug
                     * worth seeing rather than a case worth abandoning the run for, so it is
                     * reported against the case, by name, and the queue carries on. */
                    const why = 'This case was read, but measuring it failed — ' + ((e && e.message) || e);
                    ROW_STATE.set(keyOf(rec), 'failed');
                    updateRow(keyOf(rec));
                    RUN.failed++;
                    RUN.done++;
                    logLine(`${rec.caseNum || key}: ${why}`, 'fail');
                    await saveReview(failedReview(rec, kind, why));
                    setRunNote(`${RUN.done}/${RUN.total} done, ${RUN.failed} failed`);
                    continue;
                }
                /* KEEP WHAT THE CASE SAID, not just what the review concluded.
                 *
                 * The read is the expensive part — a page load and a scroll to the end of a
                 * feed — and the review that comes out of it is a summary. Every question a
                 * reviewer asks afterwards ("show me where", "quote the chase") is a
                 * question about the material, so the material is kept and the per-case chat
                 * stands on it. Without this, opening a chat would mean reading the case
                 * again, days later, on a record that has since moved on. */
                // Keeping the material is a convenience for the chat afterwards, not part of
                // the review — so a store that will not take it costs the chat, not the run.
                try {
                    await saveContext(rec, read.data, metrics);
                } catch (e) {
                    logLine(`${rec.caseNum || key}: the case was reviewed, but its material could not be kept for the chat — ${(e && e.message) || e}`, 'warn');
                }
                /* THE NUMBERS THAT SAY WHETHER THE READ WAS ANY GOOD. "read 5 post(s)" was
                  * the count of messages KEPT and nothing else, so a forty-message case that
                  * lost thirty-five of them to unrenderable bodies looked exactly like a
                  * five-message case. Both halves are printed now. */
                const thin = metrics.feedTruncated || metrics.itemsBodyless > 0
                    || metrics.feedSeen > metrics.itemsSeen + metrics.changeItems;
                logLine(`${read.data.caseNumber || rec.caseNum || key}: read ${metrics.itemsSeen} message(s) of ${metrics.feedSeen} feed entr(y/ies), ${metrics.itemsDated} dated`
                    + `${metrics.itemsBodyless ? `, ${metrics.itemsBodyless} with no readable text` : ''}`
                    + `${metrics.feedTruncated ? ' — FEED STILL LOADING when the read stopped, so this is not the whole case' : ''}`
                    + `. ${describeMeasure(metrics)}`,
                    metrics.readable && !thin ? 'ok' : 'warn');

                /* The AI half, one at a time — see the header above.
                 *
                 * A case whose write-up did not come back COUNTS AS A FAILURE, even though it
                 * was read and measured successfully and its findings are saved. The tally at
                 * the end of a run is what a reviewer decides whether to re-run on, and
                 * counting a review with no review in it as "reviewed" would hide exactly the
                 * cases that need going back to. */
                const wrote = await (aiChain = aiChain.then(() => writeUp(rec, read.data, metrics, kind)).catch(async (e) => {
                    /* writeUp SAVES ITS OWN FAILURES, so getting here means it fell over
                     * before it could — and a case that was read but left no record at all is
                     * the one kind of failure a reviewer cannot see, cannot filter for and
                     * cannot re-run. So one is written here. */
                    const why = 'The write-up failed before it started — ' + ((e && e.message) || e);
                    logLine(`${rec.caseNum || key}: ${why}`, 'fail');
                    try { await saveReview(failedReview(rec, kind, why)); } catch (e2) { /* nothing left to try */ }
                    return false;
                }));
                if (!wrote) RUN.failed++;

                ROW_STATE.delete(keyOf(rec));
                RUN.done++;
                try {
                    updateRow(keyOf(rec));
                    setRunNote(`${RUN.done}/${RUN.total} done${RUN.failed ? `, ${RUN.failed} failed` : ''}`);
                } catch (e) { /* a repaint is not worth a run */ }
            }
        };

        /* allSettled, NOT all. Two workers, and one of them throwing something this loop did
         * not anticipate would otherwise resolve the await immediately — running the finally
         * below, clearing the row states and announcing the run as finished, while the other
         * worker carried on reading cases into a run that had already declared itself over. */
        const workers = Math.max(1, Math.min(4, Number(RULES.workers) || 2));
        try {
            const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, recs.length) }, worker));
            for (const outcome of settled) {
                if (outcome.status === 'rejected') {
                    logLine(`A reader stopped early — ${(outcome.reason && outcome.reason.message) || outcome.reason}`, 'fail');
                }
            }
        } finally {
            // Whatever happened, nothing is left saying "reading…" — a row stuck in that
            // state after a run is the panel lying about work that is not happening.
            for (const r of recs) if (ROW_STATE.get(keyOf(r)) === 'working' || ROW_STATE.get(keyOf(r)) === 'queued') ROW_STATE.delete(keyOf(r));
            RUN.active = false;
            await store({ [K.cases]: CASES });
            renderAll();
            showRunPill(false);
            const stopped = RUN.accessBlocked ? ' (stopped — Copilot could not be reached)' : RUN.stop ? ' (stopped early)' : '';
            logLine(`Run finished: ${RUN.done - RUN.failed} reviewed, ${RUN.failed} failed${stopped}.`, RUN.failed ? 'warn' : 'ok');
            toast(`Run finished — ${RUN.done - RUN.failed} reviewed${RUN.failed ? `, ${RUN.failed} failed` : ''}${stopped}`, RUN.failed ? 'w' : 's', 8000);
        }
    }

    // One line of the run log, from the measured half, so the log says something about the
    // case rather than only that it was read.
    function describeMeasure(m) {
        const bits = [];
        if (m.frtMet === true) bits.push('first response met' + (m.assignedAt ? '' : ' (measured from the case opening)'));
        else if (m.frtMet === false) bits.push('FIRST RESPONSE MISSED');
        // Neither. Said out loud, because a run log that is silent about the first response
        // reads as "fine" — and the reason it is silent is the thing worth knowing.
        else if (m.frtUnmeasured) bits.push('first response NOT ASSESSABLE — ' + m.frtUnmeasured);
        if (m.gaps.length) bits.push(`${m.gaps.length} gap(s)`);
        if (m.meetingsUndocumented) bits.push(`${m.meetingsUndocumented} meeting(s) not written up`);
        if (m.openWaitMs !== null) bits.push('waiting on us');
        return bits.length ? bits.join(', ') + '.' : 'nothing flagged.';
    }

    /* AN ERROR, SHORT ENOUGH FOR A LOG LINE AND STILL WORTH READING.
     *
     * NOT `split('.')[0]`. The relay's errors begin with the host they came from, so that
     * rule printed "m365" — every relay failure, whatever it was, reduced to the first
     * label of a domain name. This keeps whole words up to a sensible length and says
     * nothing more, and the card carries the full text either way. */
    function firstLine(msg) {
        const t = String(msg || '').replace(/\s+/g, ' ').trim();
        if (t.length <= 150) return t;
        const cut = t.slice(0, 150);
        const space = cut.lastIndexOf(' ');
        return (space > 60 ? cut.slice(0, space) : cut) + '…';
    }

    /* WAS THAT AN ANSWER? One question, asked the same way of both kinds of write-up.
     *
     * A QA review is judged on how many of its headers came back filled in; a 30/60/90 is one
     * document with no headers to count, so it is judged on whether anything substantial came
     * back at all. Both report `refused` separately, because "it declined" and "it answered
     * badly" want different words on the card and only one of them is worth asking twice. */
    function judgeAnswer(text, kind, metrics) {
        if (kind === 'qa') return E.parseQaAnswer(text, metrics, RULES);
        const body = String(text || '').trim();
        const refused = E.looksRefused(body);
        return { filled: body.length, refused, usable: !refused && body.length > 200, fields: {} };
    }

    async function writeUp(rec, data, metrics, kind) {
        const caseNo = data.caseNumber || rec.caseNum || keyOf(rec);
        setRunNote(`Writing up ${caseNo}…`);

        /* THE CASE GOES OUT ANONYMOUS AND COMES BACK NAMED.
         *
         * Everything the relay is shown has the people in it replaced with role labels, and
         * everything it says has the labels replaced with the real names again before it is
         * stored. The write-up a reviewer reads is identical either way; what changes is that
         * Copilot is no longer being asked to assess an identifiable employee, which it
         * refuses to do. See buildAliases in qa-engine.js for why that refusal was the thing
         * filling the QA sheet with blank rows.
         *
         * BUILT INSIDE THE TRY, not before it. The alias map and the prompt are both walks
         * over the scrape, and a feed shaped in a way they did not expect threw out here —
         * past every catch — so the case was read, measured, and then simply disappeared:
         * no review, no row, nothing to re-run, and a queue one case shorter than the number
         * the reviewer had ticked. */
        let aliases = E.aliasRules([], false);
        let text = '';
        let error = '';
        let parsed = null;
        let threw = '';           // the last transport failure, if the relay never answered
        let refusedOnce = false;
        /* HOW THE ANSWER THAT WAS KEPT TRAVELLED — not how the last one did.
         *
         * The ladder sends less of the case on each retry and keeps whichever attempt said
         * the most, so the answer stored is frequently NOT the answer from the final ask.
         * Recording LAST_DELIVERY at the end would therefore describe a request whose answer
         * was thrown away: a review written from the whole attached case could carry a note
         * saying its transcript had been trimmed to seven thousand characters. Captured with
         * the text it belongs to instead. */
        let keptDelivery = null;
        let askDelivery = null;   // the one the ask that just returned actually used

        try {
            aliases = E.buildAliases(rec, data, metrics, RULES);
        } catch (e) {
            aliases = E.aliasRules([], false);
        }

        /* WHAT "THE WHOLE CASE" MEANS, WHICH IS NOT THE SAME ON BOTH PATHS.
         *
         * `sizing` comes from the retry ladder below: each rung down sends less of the
         * transcript in the hope a smaller request gets through. On the first two rungs it is
         * null — "send the whole case" — and that used to fall through to buildTranscript's
         * defaults, which clip every post at 2,500 characters and the transcript at 120,000.
         * Those numbers are shaped by the relay's chat input. When the material goes up as a
         * FILE there is no chat input in the way, so the same defaults were throwing evidence
         * away for nothing and labelling what was left a SAMPLE — on precisely the long,
         * email-heavy cases where the missing half is the case. Asked of the provider rather
         * than assumed: only it knows whether the bridge is the active provider AND its
         * upload is enabled. If it is not, the old budgets are still exactly right.
         */
        const wholeCase = () => {
            try {
                if (!window.SotiAI.attachesCaseData()) return undefined;
                /* THE PROVIDER'S OWN CEILING, not a second copy of it kept here. attachMaxChars
                 * is where ai-provider.js stops — a MEASURED figure rather than a hopeful one —
                 * and reading it means a build that raises or lowers it moves this budget with
                 * it instead of leaving the two to drift apart. See attachedSize in
                 * qa-engine.js for what it does with the number. */
                const b = window.SotiAI.config && window.SotiAI.config.bridge;
                return E.attachedSize(b && b.attachMaxChars);
            } catch (e) { return undefined; }
        };

        const ask = async (retry, sizing, label) => {
            const opts = { aliases, retry, transcript: sizing || wholeCase() };
            const prompt = kind === '306090'
                ? E.build306090Prompt(rec, data, metrics, RULES, opts)
                : E.buildQaPrompt(rec, data, metrics, RULES, opts);
            /* BOTH HALVES THROUGH THE ALIAS MAP. The request line carries a case number and
             * nothing else today, but hide() is cheap and one real name in one turn is all it
             * takes for the relay to decline the request — which is the failure this whole
             * de-identification exists to prevent. */
            const out = {};
            const said = aliases.show(await askAi({
                system: aliases.hide(prompt.system),
                request: aliases.hide(prompt.request)
            }, label, out));
            askDelivery = out.delivery;
            return said;
        };

        /* THE LADDER. A write-up must not simply fail.
         *
         * The relay is a web page being driven, not an API, and it fails the way a web page
         * does: the composer would not take a message that size, the conversation had not
         * gone idle before the next part was typed, the answer took longer than the timeout,
         * the page rate-limited a run of twenty-nine cases. Every one of those is transient
         * or size-related — and the tool used to catch the first of them and file the case as
         * "write-up FAILED" without ever asking again.
         *
         * So each case gets up to five asks. The first two send the whole thing, seconds
         * apart, because most of these come good on the second go. The rest send less of the
         * case each time — the transcript is the only part big enough to matter — because a
         * review of most of a case beats no review at all, and the transcript says out loud
         * when it is a sample so the write-up cannot claim to have read what it was not sent.
         *
         * A REFUSAL IS A DIFFERENT FAILURE and keeps its own answer: the retry framing that
         * gets past the guardrail is set on the SECOND ask onwards, whatever went wrong first.
         */
        const sizes = E.PROMPT_SIZES;
        let asks = 0;
        let accessBlocked = false;
        let signinBlocked = false;
        for (let n = 0; n < sizes.length; n++) {
            if (RUN.stop) break;
            if (n > 0) {
                // A pause that grows. A rate limit needs seconds, not milliseconds, and
                // hammering it is how a run turns one slow case into twenty-nine.
                const pause = Math.min(15000, 2500 * n);
                setRunNote(`Retrying ${caseNo} (${n + 1}/${sizes.length})…`);
                await new Promise(r => setTimeout(r, pause));
                if (RUN.stop) break;
            }
            const label = n === 0 ? caseNo : `${caseNo} (try ${n + 1})`;
            asks++;
            let said = '';
            try {
                said = await ask(n > 0, sizes[n], label);
                threw = '';
            } catch (e) {
                threw = (e && e.message) || String(e);
                if (e && e.access) { accessBlocked = true; signinBlocked = !!e.signin; break; }
                logLine(`${caseNo}: the relay failed on attempt ${n + 1} of ${sizes.length} — ${firstLine(threw)}`, 'warn');
                continue;
            }

            const judged = judgeAnswer(said, kind, metrics);
            // Keep whichever attempt said the most, so a later, smaller ask that comes back
            // worse than an earlier one cannot throw the better answer away.
            if (!parsed || judged.usable || judged.filled > parsed.filled) {
                text = said;
                parsed = judged;
                keptDelivery = askDelivery;
            }
            if (judged.usable) break;

            refusedOnce = refusedOnce || judged.refused;
            // n >= 2 means the retry framing has now been sent twice and declined twice.
            const giveUp = judged.refused && n >= 2;
            logLine(`${caseNo}: ${judged.refused ? 'the relay declined to write this up' : 'the answer came back without a review in it'}`
                + `${!giveUp && n + 1 < sizes.length ? ' — asking again.' : '.'}`, 'warn');
            if (giveUp) break;
        }

        /* AND IF NONE OF THAT WORKED, SAY WHICH KIND OF NOTHING IT WAS.
         *
         * Three different failures used to arrive as one word. A relay that never answered,
         * a relay that declined, and a relay that answered with something that was not a
         * review want three different responses from the reviewer, and only the first of
         * them is worth simply running again. */
        if (!parsed || !parsed.usable) {
            if (accessBlocked) {
                /* NOT A FAILURE OF THIS CASE, and the rest of the queue would fail the same
                 * way — so the run stops here, the case keeps its measurement, and the
                 * reviewer is handed the one button that fixes it. "Re-run the incomplete
                 * ones" picks this case up again once that is done. Two causes, two fixes:
                 * a host Chrome has not granted, or a Copilot that sent the tab to sign in. */
                error = signinBlocked
                    ? 'Copilot could not be reached because Microsoft asked for a sign-in — you are not signed in to Microsoft 365 in this browser. '
                      + 'Sign in at m365.cloud.microsoft in a normal tab, then re-run this case. What the relay said: ' + threw
                    : 'Copilot could not be reached because Chrome has not given the QA Tool access to it. '
                      + 'Press "Grant access to Copilot" in the dialog (or ⋮ → Settings → The AI), then re-run this case. '
                      + 'What the relay said: ' + threw;
                if (!RUN.accessBlocked) {
                    RUN.accessBlocked = true;
                    RUN.stop = true;
                    logLine(signinBlocked
                        ? 'Run stopped: Microsoft 365 wants you to sign in. Sign in to Copilot in a normal tab, then press "Re-run the incomplete ones".'
                        : 'Run stopped: Chrome has not given the QA Tool access to Copilot. Grant it, then press "Re-run the incomplete ones".', 'fail');
                    offerCopilotSetup({ force: true, signin: signinBlocked });
                }
            } else if (!asks && RUN.stop) {
                // Read and measured, never sent: the run was stopped while it waited its turn.
                error = RUN.accessBlocked
                    ? 'Not written — the run stopped before this case reached Copilot, because Copilot could not be reached. Re-run it once that is fixed.'
                    : 'Not written — the run was stopped before this case was sent to Copilot. Re-run it to write it up.';
            } else if (threw && (!parsed || !parsed.filled)) {
                error = `The AI relay could not be reached for this case. It was asked ${asks} times, `
                    + 'with less of the case each time, and the last attempt said: ' + threw;
            } else if (refusedOnce) {
                error = `The AI relay declined to write this case up. It was asked ${asks} times, `
                    + 'including with the request framed as a check of the case record rather than of a person. '
                    + (aliases.on
                        ? 'The case went out with every name already removed, so this is not about who is on it.'
                        : 'The case went out with the real names in it — turn on "Send cases with the names removed" '
                          + 'in Settings, which is what this refusal is usually about, and run it again.')
                    + ' What it said instead is below.';
            } else {
                error = 'The answer came back without a usable write-up in it — the QA headers were missing. '
                    + (threw ? 'A later attempt could not reach the relay at all: ' + threw + ' ' : '')
                    + 'What came back is below.';
            }
        }

        /* A FAILED WRITE-UP STILL SAVES THE MEASUREMENT.
         *
         * The expensive half of a review is opening the case and reading its feed to the end;
         * the relay failing afterwards must not throw that away and make the reviewer do it
         * again. The record is saved with its findings and its error, the card says the
         * write-up is missing, and re-running that one case is a tick and a button. */
        // The 30/60/90 is read as a whole document, not as sheet columns — it has its own
        // template and no row on the QA sheet — so only a QA review is parsed into fields.
        if (kind === 'qa' && !parsed) parsed = E.parseQaAnswer(text, metrics, RULES);

        const review = {
            id: `${keyOf(rec)}|${kind}`,
            key: keyOf(rec),
            kind,
            at: Date.now(),
            caseNum: caseNo,
            subject: data.subject || rec.subject || '',
            account: data.accountName || rec.account || '',
            status: data.caseStatus || rec.status || '',
            // What files this review under its month on the Reviews tab — see closedBucketOf.
            closedAt: closedAtOf(rec, data),
            agent: agentOf(rec, data),
            url: urlOf(rec) || data.caseUrl || '',
            milestone: metrics.milestone,
            metrics: slimMetrics(metrics),
            findings: metrics.findings,
            raw: text,
            error
        };
        if (kind === 'qa') {
            review.fields = parsed.fields;
            review.training = parsed.training;
            review.score = parsed.score;
        } else {
            review.fields = {};
        }
        // So a card can say "sent with the names removed" rather than leaving the reviewer to
        // wonder why the answer talks about Agent A.
        review.deidentified = aliases.on;
        review.refused = refusedOnce || !!(parsed && parsed.refused);
        /* HOW MUCH OF THE CASE THIS WRITE-UP ACTUALLY READ, kept on the record itself.
         *
         * It belongs with the review rather than only in the run log, because the question it
         * answers — "was this written from the whole case?" — is asked weeks later, by someone
         * looking at a score they disagree with, long after the log has scrolled away. It is
         * the LAST ask's delivery: the ladder sends less of the case on each retry, and what
         * grounded the answer that was kept is the one worth recording. */
        review.delivery = keptDelivery || askDelivery;
        await saveReview(review);
        const said = error ? 'write-up FAILED — ' + firstLine(error)
            : kind === '306090' ? '30/60/90 written'
            : review.score && review.score.value !== null
                ? `reviewed — ${review.score.value}/100 (${review.score.band})`
                  + (review.score.derived ? ' — score worked out from the measured facts, the write-up gave none' : '')
            : 'reviewed';
        logLine(`${caseNo}: ${said}`, error ? 'fail' : 'ok');
        /* ONCE PER RUN WHEN ALL IS WELL, AND EVERY TIME IT IS NOT.
         *
         * The first case says how it travelled whatever happened, because "is it actually
         * attaching?" is the question somebody has after changing this, and an answer they
         * have to open a review card to find is one they will not look for. Every case after
         * that stays quiet unless something was lost — a reassurance printed thirty times is
         * one nobody reads, and it would bury the single line that matters. */
        if (!error && review.delivery && (deliveryWorrying(review.delivery) || !RUN.saidHow)) {
            RUN.saidHow = true;
            logLine(`${caseNo}: ${deliveryLine(review.delivery)}`,
                deliveryWorrying(review.delivery) ? 'warn' : 'ok');
        }
        return !error;
    }

    async function readOnce(rec) {
        try {
            return await window.QaReader.readCase(urlOf(rec));
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
        }
    }

    /* WHICH READ FAILURES ARE WORTH A SECOND ATTEMPT. Everything except the ones whose
     * cause cannot change between now and two seconds from now: a record with no link on
     * it, a link that does not point at a case, and a build that is not running as an
     * extension at all. Retrying those is two seconds spent to print the same sentence. */
    function retryableRead(why) {
        const t = String(why || '');
        if (/has no Salesforce link/i.test(t)) return false;
        if (/does not open a case record/i.test(t)) return false;
        if (/only read cases when it is running as a Chrome extension/i.test(t)) return false;
        return true;
    }

    /* THE MEASUREMENT, MINUS WHAT IT WOULD COST TO KEEP.
     *
     * The full metrics object carries every response time on the case and every gap; over a
     * few hundred reviews that is megabytes of arrays nothing ever reads back. What the
     * sheets and the coaching summary actually use is kept, plus the first dozen gaps so a
     * card can still show them. The findings are stored whole because they are the review. */
    function slimMetrics(m) {
        return {
            frtMet: m.frtMet,
            firstResponseMs: m.firstResponseMs,
            firstResponseBy: m.firstResponseBy,
            // The start of the first response clock, and what it was. Five small fields, and
            // without them nothing downstream can say what the number beside them means.
            assignedAt: m.assignedAt,
            assignedTo: m.assignedTo,
            assignedFrom: m.assignedFrom,
            frtFromWhat: m.frtFromWhat,
            frtUnmeasured: m.frtUnmeasured,
            frtByOwner: m.frtByOwner,
            feedSeen: m.feedSeen,
            itemsBodyless: m.itemsBodyless,
            feedLoad: m.feedLoad,
            feedTruncated: m.feedTruncated,
            changeItems: m.changeItems,
            changedFields: m.changedFields,
            openedAt: m.openedAt,
            ageDays: m.ageDays,
            milestone: m.milestone,
            itemsSeen: m.itemsSeen,
            itemsDated: m.itemsDated,
            counts: m.counts,
            gaps: m.gaps.slice(0, 12),
            worstGapMs: m.worstGapMs,
            openWaitMs: m.openWaitMs,
            customerChases: m.customerChases,
            medianResponseMs: m.medianResponseMs,
            meetings: m.meetings.length,
            meetingsUndocumented: m.meetingsUndocumented,
            readable: m.readable,
            feedReason: m.feedReason
        };
    }

    function failedReview(rec, kind, error) {
        return {
            id: `${keyOf(rec)}|${kind}`,
            key: keyOf(rec),
            kind,
            at: Date.now(),
            caseNum: rec.caseNum || keyOf(rec),
            subject: rec.subject || '',
            account: rec.account || '',
            status: rec.status || '',
            closedAt: closedAtOf(rec, null),
            agent: agentOf(rec, null),
            url: urlOf(rec),
            fields: {},
            findings: [],
            metrics: null,
            raw: '',
            error
        };
    }

    /* ONE REVIEW PER CASE PER KIND. Re-reviewing a case REPLACES its review rather than
     * adding a second one: two reviews of one case would each claim to be the QA record for
     * it, and the sheet would carry the case twice with different scores. */
    async function saveReview(review) {
        const at = REVIEWS.findIndex(r => r.id === review.id);
        if (at >= 0) REVIEWS[at] = review; else REVIEWS.push(review);
        await store({ [K.reviews]: REVIEWS });
        renderCounts();
        if (VIEW === 'reviews') renderReviews();
    }

    /* ---------------------------------------------------------------------
     * THE RUN PILL AND THE LOG
     * ------------------------------------------------------------------- */
    /* THE PILL STAYS FOR A MOMENT AFTER THE RUN ENDS, and stops pulsing.
     *
     * A run that finishes while the reviewer is looking at another application would
     * otherwise leave nothing behind at all — they come back to a panel that looks exactly
     * like one that was never started. Six seconds of "12/12 done" is what says it happened,
     * and the dot going still and green is what says it is no longer happening. */
    let pillHide = null;
    function showRunPill(on) {
        const pill = $('runPill');
        if (!pill) return;
        if (pillHide) { clearTimeout(pillHide); pillHide = null; }
        // Stop only while there is something to stop — a finished pill offering it was a
        // button that did nothing.
        const stop = $('btnStopRun');
        if (on) {
            pill.style.display = '';
            pill.classList.remove('done', 'failed');
            if (stop) stop.hidden = false;
            return;
        }
        if (stop) stop.hidden = true;
        pill.classList.add(RUN.failed ? 'failed' : 'done');
        pillHide = setTimeout(() => {
            if (!RUN.active) pill.style.display = 'none';
            pillHide = null;
        }, 6000);
    }

    function setRunNote(note) {
        RUN.note = note;
        const el = $('runPillTxt');
        if (el) el.textContent = note;
    }

    function logLine(text, kind) {
        const log = $('runLog');
        if (!log) return;
        log.style.display = '';
        const line = document.createElement('div');
        line.className = kind ? 'ln-' + kind : '';
        const t = document.createElement('span');
        t.className = 'ln-time';
        try { t.textContent = new Date().toLocaleTimeString(); } catch (e) { t.textContent = ''; }
        line.appendChild(t);
        line.appendChild(document.createTextNode(text));
        log.appendChild(line);
        // A day of runs is thousands of lines, and the oldest of them are about cases
        // reviewed hours ago. The newest thousand is what anybody scrolls back through.
        while (log.childElementCount > 1000) log.removeChild(log.firstChild);
        log.scrollTop = log.scrollHeight;
    }

    // Repaint ONE row rather than the list. A thirty-case run repaints on every state change,
    // and rebuilding thirty rows each time throws away the reviewer's scroll position and
    // any checkbox they are mid-click on.
    function updateRow(key) {
        const row = document.querySelector(`.oc-row[data-key="${CSS.escape(key)}"]`);
        if (!row) return;
        const rec = CASES.cases.find(c => keyOf(c) === key);
        if (!rec) return;
        row.replaceWith(caseRow(rec));
    }

    /* =====================================================================
     * THE PER-CASE CHAT
     * =====================================================================
     * A review answers the questions the sheet asks and then stops. The next
     * question is always the same one — "why?", "show me where", "what should
     * they actually have done" — and there was nowhere to ask it.
     *
     * So every case gets a conversation of its own, grounded in exactly what the
     * review was grounded in: the same facts, the same measured findings, the
     * review itself, and the whole transcript oldest-first. That is what makes
     * it worth having rather than a second opinion from a model that has not
     * read the case — and it is why the reviewer can say "justify that score"
     * and get an answer with dates in it.
     * =================================================================== */

    /* WHAT THE CHAT STANDS ON, captured at read time.
     *
     * Bounded twice. The transcript is capped per case, and the store keeps only the most
     * recent CONTEXT_KEEP cases — a QA queue is worked forward, so the case somebody wants
     * to talk about is almost always one of the last few dozen read. Pruning is by read
     * time, and a chat whose context has been pruned still opens: it says the material has
     * gone and offers to read the case again. */
    async function saveContext(rec, data, metrics) {
        const key = keyOf(rec);
        if (!key) return;
        /* THE MATERIAL IS KEPT UNDER THE REAL NAMES and hidden on the way out, rather than
         * stored already hidden. Two reasons. The panel's own screens — the grounding line,
         * the case row — should say who the case belongs to, and a store full of "Agent A"
         * would make that a lookup. And the de-identification setting can be turned off
         * later without every case read before that being permanently anonymous. */
        const aliases = E.buildAliases(rec, data, metrics, RULES);
        CONTEXT[key] = {
            key,
            caseNum: data.caseNumber || rec.caseNum || '',
            subject: data.subject || rec.subject || '',
            agent: agentOf(rec, data),
            url: urlOf(rec) || data.caseUrl || '',
            at: Date.now(),
            facts: E.caseFactsBlock(rec, data),
            measured: E.measurementBlock(metrics, RULES),
            transcript: E.buildTranscript(data, { perPost: 1500, maxChars: CONTEXT_MAX_CHARS }),
            metrics: slimMetrics(metrics),
            // Small — a name, a label and a side each — and it is what lets a chat use the
            // same aliases the review used instead of inventing a second set.
            people: aliases.people.map(x => ({ real: x.real, alias: x.alias, side: x.side })),
            legend: aliases.legend()
        };
        const keys = Object.keys(CONTEXT).sort((a, b) => (CONTEXT[b].at || 0) - (CONTEXT[a].at || 0));
        for (const gone of keys.slice(CONTEXT_KEEP)) delete CONTEXT[gone];
        await store({ [K.context]: CONTEXT });

        /* THE FULL TRANSCRIPT, WRITTEN SEPARATELY AND PRUNED SEPARATELY.
         *
         * After the index, never before it and never in the same write: if this one fails —
         * a quota, a storage error — the case is still cached and the chat still works off
         * the index copy. The reverse order would leave a document with no entry pointing at
         * it, which nothing would ever read or clean up. */
        try {
            await store({ [K.ctxDoc(key)]: { key, at: Date.now(), transcript: E.buildTranscript(data, { perPost: Infinity, maxChars: CHAT_DOC_MAX_CHARS }) } });
            await rememberContextDoc(key);
        } catch (e) {
            // The index copy is still there and the chat still has material. Worth a console
            // line, not worth failing a case read that otherwise succeeded.
            console.warn('QA Tool: could not store the full transcript for', key, e);
        }
    }

    /* THIS CASE TO THE FRONT, AND THE OLDEST OFF THE BACK.
     *
     * The list is written BEFORE the removal and includes only what is being kept, so a
     * failure between the two leaves documents that nothing points at rather than pointers
     * to documents that are gone — the first is dead disk the next save clears, the second
     * is a chat that loads nothing and says nothing about why. */
    async function rememberContextDoc(key) {
        if (!isExt()) return;
        let list = [];
        try {
            const got = await chrome.storage.local.get(K.ctxDocs);
            if (Array.isArray(got[K.ctxDocs])) list = got[K.ctxDocs];
        } catch (e) { /* start a new list */ }
        const next = [key].concat(list.filter(k => k !== key));
        const keep = next.slice(0, CHAT_DOC_KEEP);
        const gone = next.slice(CHAT_DOC_KEEP);
        await store({ [K.ctxDocs]: keep });
        if (gone.length) {
            try { await chrome.storage.local.remove(gone.map(K.ctxDoc)); } catch (e) { /* cleared on the next save */ }
        }
    }

    /* EVERY KEY THIS TOOL OWNS, for "clear everything this tool has stored". The transcript
     * documents are named per case, so they cannot be listed as constants the way the rest
     * of the store can — and left out of the sweep they would be the one thing a "clear
     * everything" did not clear. */
    async function contextDocKeys() {
        if (!isExt()) return [];
        try {
            const got = await chrome.storage.local.get(K.ctxDocs);
            const list = Array.isArray(got[K.ctxDocs]) ? got[K.ctxDocs] : [];
            return [K.ctxDocs].concat(list.map(K.ctxDoc));
        } catch (e) { return []; }
    }

    /* THE CHAT'S MATERIAL, FETCHED THE MOMENT BEFORE IT IS NEEDED.
     *
     * Never held in memory with the index: it is up to half a megabyte a case and the panel
     * caches eighty cases. Returns '' when there is no document — a case read by an earlier
     * build, or one whose document has been pruned — and buildChatSystem then falls back to
     * the index copy, which is what every chat used before this existed. */
    async function loadContextDoc(key) {
        if (!key || !isExt()) return '';
        try {
            const got = await chrome.storage.local.get(K.ctxDoc(key));
            const doc = got && got[K.ctxDoc(key)];
            return (doc && doc.transcript) || '';
        } catch (e) { return ''; }
    }

    function chatFor(key) {
        if (!CHATS[key]) {
            const ctx = CONTEXT[key];
            const rec = CASES.cases.find(c => keyOf(c) === key);
            const rev = REVIEWS.filter(r => r.key === key && r.kind === 'qa').pop();
            CHATS[key] = {
                key,
                caseNum: (ctx && ctx.caseNum) || (rec && rec.caseNum) || (rev && rev.caseNum) || '',
                subject: (ctx && ctx.subject) || (rec && rec.subject) || (rev && rev.subject) || '',
                agent: (ctx && ctx.agent) || (rev && rev.agent) || (rec && rec.owner) || '',
                url: (ctx && ctx.url) || (rev && rev.url) || (rec ? urlOf(rec) : ''),
                msgs: []
            };
        }
        return CHATS[key];
    }

    function openChat(key) {
        if (!key) return;
        /* NOT WHILE AN ANSWER IS ARRIVING. The streaming paint writes into the last answer
         * bubble on screen, so changing case underneath it would append case A's answer to
         * case B's conversation — and it would look perfectly normal. */
        if (CHAT_BUSY) { toast('Wait for the current answer to finish, or press Stop.', 'w'); return; }
        CHAT_KEY = key;
        chatFor(key);
        switchView('chat');
    }

    // Every case this tool has anything to say about — read, reviewed, or merely in the
    // queue — newest first, so the picker opens on what was just worked.
    function chattableCases() {
        const seen = new Map();
        /* THE FLAGS ADD UP; ONLY THE NAMES AND THE TIME COMPETE. This used to keep whichever
         * source was NEWEST and drop the rest — and a case's material is saved just BEFORE its
         * review is written, so every reviewed case lost its "read" flag to its own review and
         * the picker said "not read" about the very cases it could open straight away. */
        const add = (key, obj, at) => {
            if (!key) return;
            const prev = seen.get(key);
            const merged = Object.assign({}, prev || {}, obj);
            if (prev && (prev.at || 0) > (at || 0)) {
                for (const k of ['caseNum', 'subject', 'agent']) if (prev[k]) merged[k] = prev[k];
            }
            merged.key = key;
            merged.at = Math.max((prev && prev.at) || 0, at || 0);
            seen.set(key, merged);
        };
        for (const c of CASES.cases) {
            add(keyOf(c), { caseNum: c.caseNum, subject: c.subject, agent: c.owner || c.lastModifiedBy, inQueue: true }, 0);
        }
        for (const r of REVIEWS) {
            if (r.kind !== 'qa') continue;
            add(r.key, { caseNum: r.caseNum, subject: r.subject, agent: r.agent, reviewed: true }, r.at);
        }
        for (const c of Object.values(CONTEXT)) {
            add(c.key, { caseNum: c.caseNum, subject: c.subject, agent: c.agent, grounded: true }, c.at);
        }
        for (const c of Object.values(CHATS)) {
            if (!c.msgs || !c.msgs.length) continue;
            const last = c.msgs[c.msgs.length - 1];
            add(c.key, { caseNum: c.caseNum, subject: c.subject, agent: c.agent, chatted: c.msgs.length }, last.at);
        }
        return [...seen.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
    }

    function renderChat() {
        const picker = $('chatPicker');
        const head = $('chatHead');
        const ground = $('chatGround');
        const msgs = $('chatMsgs');
        const chips = $('chatChips');
        const compose = $('chatCompose');
        if (!picker) return;

        const on = !!CHAT_KEY;
        head.style.display = on ? '' : 'none';
        ground.style.display = on ? '' : 'none';
        msgs.style.display = on ? '' : 'none';
        chips.style.display = on ? '' : 'none';
        compose.style.display = on ? '' : 'none';
        picker.style.display = on ? 'none' : '';

        if (!on) { renderChatPicker(picker); return; }

        const chat = chatFor(CHAT_KEY);
        const ctx = CONTEXT[CHAT_KEY];
        const rev = REVIEWS.filter(r => r.key === CHAT_KEY && r.kind === 'qa').pop();

        $('chatCaseNum').textContent = chat.caseNum || '(no number)';
        $('chatSubject').textContent = chat.subject || '';
        $('chatSubject').title = chat.subject || '';
        $('btnChatOpenSf').style.display = chat.url ? '' : 'none';

        renderChatGround(ground, ctx, rev, chat);
        renderChatMessages(msgs, chat);
        renderChatChips(chips, ctx, rev, chat);

        const send = $('btnChatSend');
        const stop = $('btnChatStop');
        send.disabled = CHAT_BUSY || !ctx;
        send.style.display = CHAT_BUSY ? 'none' : '';
        stop.style.display = CHAT_BUSY ? '' : 'none';
        $('chatInput').disabled = CHAT_BUSY || !ctx;
        // Same reason as the guard in openChat: nothing may move the conversation out from
        // under an answer that is still being written into it.
        $('btnChatSwitch').disabled = CHAT_BUSY;
        $('btnChatClear').disabled = CHAT_BUSY;
        renderCounts();
    }

    function renderChatPicker(picker) {
        picker.textContent = '';
        const list = chattableCases();
        if (!list.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-empty';
            hint.innerHTML = 'Nothing to talk about yet.<br><br>Sync a case list and review some cases — every case that gets read keeps its material, '
                + 'and the chat here stands on exactly what the review stood on.';
            picker.appendChild(hint);
            return;
        }
        const lead = document.createElement('div');
        lead.className = 'qa-chat-lead';
        lead.textContent = 'Pick a case to talk about.';
        picker.appendChild(lead);

        for (const c of list) {
            const row = document.createElement('div');
            row.className = 'oc-row qa-chat-pick';
            const main = document.createElement('div');
            main.className = 'oc-row-main';
            main.onclick = () => openChat(c.key);

            const num = document.createElement('span');
            num.className = 'oc-num';
            num.textContent = c.caseNum || '(no number)';
            main.appendChild(num);

            const subj = document.createElement('span');
            subj.className = 'oc-subject';
            subj.textContent = c.subject || '';
            subj.title = c.subject || '';
            main.appendChild(subj);

            /* THE ROW SAYS WHETHER THERE IS ANYTHING TO STAND ON. "Read" means the material
             * is here and the chat can start straight away; a case with no tag has to be
             * read first, which costs a page load — and knowing that before you click is the
             * difference between choosing and being surprised. */
            if (c.chatted) {
                const t = document.createElement('span');
                t.className = 'qa-tag qa-tag-chat';
                t.textContent = `${c.chatted} msg`;
                main.appendChild(t);
            }
            if (c.grounded) {
                const t = document.createElement('span');
                t.className = 'qa-tag qa-tag-read';
                t.textContent = 'read';
                t.title = 'The case material is stored — this chat can start immediately.';
                main.appendChild(t);
            } else {
                const t = document.createElement('span');
                t.className = 'qa-tag';
                t.textContent = 'not read';
                t.title = 'The case has to be read before it can be discussed. One press, one page load.';
                main.appendChild(t);
            }
            if (c.agent) {
                const a = document.createElement('span');
                a.className = 'qa-owner-cell';
                a.textContent = c.agent;
                main.appendChild(a);
            }
            row.appendChild(main);
            picker.appendChild(row);
        }
    }

    /* WHAT THE ANSWERS ARE STANDING ON, said out loud.
     *
     * A chat that will not say where its facts came from can be quietly wrong for a whole
     * session. This names the material and its age — and when there is none, it says so and
     * offers the one button that fixes it rather than letting the reviewer type a question
     * into something that cannot answer it. */
    function renderChatGround(el, ctx, rev, chat) {
        el.textContent = '';
        if (!ctx) {
            const say = document.createElement('span');
            say.textContent = 'This case has not been read yet, so there is nothing to ground an answer in. ';
            el.appendChild(say);
            const btn = document.createElement('button');
            btn.className = 'btn qa-btn-primary';
            btn.textContent = 'Read this case now';
            btn.onclick = () => readForChat(chat);
            el.appendChild(btn);
            el.classList.add('qa-chat-ground-empty');
            return;
        }
        el.classList.remove('qa-chat-ground-empty');
        const bits = [`Grounded in the case as read ${E.fmtDateTime(ctx.at)}`];
        if (rev && !incomplete(rev)) bits.push(`and its QA review${rev.score && rev.score.value !== null ? ` (${rev.score.value}/100)` : ''}`);
        el.appendChild(document.createTextNode(bits.join(' ') + '. '));
        if (chatAliases(ctx).on) {
            const priv = document.createElement('span');
            priv.className = 'qa-chat-priv';
            priv.textContent = 'Names removed on the way out.';
            priv.title = 'Everyone on this case is sent under a role label and named again in the answer, '
                + 'so nothing you read here changes — see Settings.';
            el.appendChild(priv);
        }
        const again = document.createElement('button');
        again.className = 'btn';
        again.textContent = 'Read it again';
        again.title = 'Open the case in Salesforce again and refresh the material this chat stands on.';
        again.onclick = () => readForChat(chat);
        el.appendChild(again);
    }

    async function readForChat(chat) {
        if (CHAT_BUSY) return;
        /* ONE THING DRIVING THE READER AT A TIME. A QA run already owns the reader window
         * and the progress pill; a read started from here in the middle of one would fight
         * it for both, and the pill would end up reporting whichever finished last. */
        if (RUN.active) { toast('A QA run is going — wait for it to finish, or press Stop.', 'w', 7000); return; }
        const rec = CASES.cases.find(c => keyOf(c) === chat.key)
            || { recordId: chat.key, url: chat.url, caseNum: chat.caseNum, subject: chat.subject };
        const url = urlOf(rec) || chat.url;
        if (!url) { toast('This case has no Salesforce link, so it cannot be read.', 'e', 8000); return; }
        CHAT_BUSY = true;
        renderChat();
        RUN.failed = 0;
        showRunPill(true);
        setRunNote(`Reading ${chat.caseNum || 'the case'} for this chat…`);
        try {
            const read = await window.QaReader.readCase(url);
            if (!read.ok) { toast(read.error, 'e', 12000); RUN.failed = 1; return; }
            applyReadToRecord(rec, read.data);
            const metrics = E.measureCase(read.data, RULES);
            await saveContext(rec, read.data, metrics);
            // The row in the queue learns from the read too — a case added by URL fills in
            // its number and subject here exactly as it would during a run.
            if (CASES.cases.includes(rec)) await store({ [K.cases]: CASES });
            const ctx = CONTEXT[keyOf(rec)];
            if (ctx) {
                chat.caseNum = ctx.caseNum || chat.caseNum;
                chat.subject = ctx.subject || chat.subject;
                chat.agent = ctx.agent || chat.agent;
                chat.url = ctx.url || chat.url;
                // The key can move when a case added by URL learns its number — carry the
                // chat across with it rather than stranding it under the old name.
                if (keyOf(rec) !== chat.key) {
                    delete CHATS[chat.key];
                    chat.key = keyOf(rec);
                    CHATS[chat.key] = chat;
                    CHAT_KEY = chat.key;
                }
                await store({ [K.chats]: CHATS });
            }
            toast('Case read — ask away.', 's');
        } catch (e) {
            toast('Could not read the case: ' + ((e && e.message) || e), 'e', 12000);
            RUN.failed = 1;
        } finally {
            CHAT_BUSY = false;
            showRunPill(false);
            renderChat();
            renderCases();
        }
    }

    function renderChatMessages(el, chat) {
        el.textContent = '';
        if (!chat.msgs.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-chat-empty';
            hint.innerHTML = 'Ask anything about this case. Answers come only from the case material and are asked to quote it, '
                + 'so "the case does not say" is a real answer here.';
            el.appendChild(hint);
            return;
        }
        for (const m of chat.msgs) el.appendChild(chatBubble(m));
        // Scrolled after the paint, or the box is still zero-height and the scroll goes
        // nowhere — which reads as "my question vanished".
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }

    function chatBubble(m) {
        const wrap = document.createElement('div');
        wrap.className = 'qa-msg qa-msg-' + (m.role === 'user' ? 'you' : 'ai') + (m.error ? ' qa-msg-error' : '');
        const who = document.createElement('div');
        who.className = 'qa-msg-who';
        who.textContent = m.role === 'user' ? 'You' : 'QA Tool';
        wrap.appendChild(who);
        const body = document.createElement('div');
        body.className = 'qa-msg-body';
        if (m.role === 'user') body.textContent = m.content;
        else body.innerHTML = renderRich(m.content || (m.error ? '' : '…'));
        wrap.appendChild(body);
        if (m.error) {
            const err = document.createElement('div');
            err.className = 'qa-msg-err';
            err.textContent = m.error;
            wrap.appendChild(err);
        }
        /* THE ANSWER IS FINE AND THE EVIDENCE WAS NOT. Not an error — the reply below it is
         * a real reply — but the reviewer is about to act on an answer that was grounded in
         * less than the whole case, and only this line will ever tell them so. Written only
         * when something was actually lost; a clean upload says nothing here. */
        if (m.note) {
            const note = document.createElement('div');
            note.className = 'qa-msg-note';
            note.textContent = m.note;
            wrap.appendChild(note);
        }
        if (m.role !== 'user' && m.content && !m.streaming) {
            const acts = document.createElement('div');
            acts.className = 'qa-msg-acts';
            const copy = document.createElement('button');
            copy.className = 'btn';
            copy.textContent = 'Copy';
            copy.onclick = () => copyText(m.content, 'Answer copied');
            acts.appendChild(copy);
            wrap.appendChild(acts);
        }
        return wrap;
    }

    /* A SMALL, SAFE RENDERER — not a markdown engine.
     *
     * The prompt asks for plain text and short bullets, and this handles what comes back
     * anyway: the odd **bold**, a `code` span, "- " bullets and blank-line paragraphs. It
     * escapes FIRST and only then puts tags in, so nothing a case contains — and a support
     * case contains plenty of angle brackets — can become markup. */
    function renderRich(text) {
        const src = String(text || '').replace(/\r\n/g, '\n');
        const inline = (s) => esc(s)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

        const out = [];
        let bullets = null;
        const flush = () => { if (bullets) { out.push('<ul>' + bullets.join('') + '</ul>'); bullets = null; } };

        for (const rawLine of src.split('\n')) {
            const line = rawLine.replace(/\s+$/, '');
            const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
            if (bullet) {
                if (!bullets) bullets = [];
                bullets.push('<li>' + inline(bullet[1]) + '</li>');
                continue;
            }
            flush();
            if (!line.trim()) { out.push('<div class="qa-gap"></div>'); continue; }
            // A "Header:" line on its own is how every prompt in this tool asks for its
            // output, so it is worth setting apart when it comes back inside a chat answer.
            const head = line.match(/^([A-Z][^:\n]{2,60}):\s*$/);
            if (head) { out.push('<div class="qa-rich-h">' + inline(head[1]) + '</div>'); continue; }
            out.push('<div>' + inline(line) + '</div>');
        }
        flush();
        return out.join('');
    }

    function renderChatChips(el, ctx, rev, chat) {
        el.textContent = '';
        if (!ctx || CHAT_BUSY) return;
        // Only while the conversation is young. Once the reviewer is asking their own
        // questions, a row of suggested ones is in the way.
        if (chat.msgs.length > 2) return;
        const metrics = (ctx && ctx.metrics) || (rev && rev.metrics) || null;
        for (const q of E.chatSuggestions(metrics, rev)) {
            const chip = document.createElement('button');
            chip.className = 'oc-chip qa-chat-chip';
            chip.type = 'button';
            chip.textContent = q;
            chip.title = q;
            chip.onclick = () => sendChat(q);
            el.appendChild(chip);
        }
    }

    /* THE ALIASES FOR ONE CHAT.
     *
     * Normally they come straight off the stored material, which is what keeps a label
     * meaning the same person in the review and in every conversation about it.
     *
     * MATERIAL READ BEFORE THIS EXISTED has no people list, and that is the case for every
     * case already in the store. Rather than send those under their real names — which is
     * the thing that was being refused — the agent's own name is hidden on its own. It is
     * the name that matters here: the guardrail is about assessing an employee, and the
     * employee is the one the review is about. */
    function chatAliases(ctx) {
        const people = (ctx && ctx.people && ctx.people.length)
            ? ctx.people
            : (ctx && ctx.agent ? [{ real: E.cleanName(ctx.agent), alias: 'Agent A', side: 'us' }] : []);
        return E.aliasRules(people.filter(x => x && x.real), RULES.deident !== false && !!people.length);
    }

    async function sendChat(question) {
        const text = String(question || '').trim();
        if (!text || CHAT_BUSY || !CHAT_KEY) return;
        const ctx = CONTEXT[CHAT_KEY];
        if (!ctx) { toast('Read the case first — there is nothing to ground an answer in.', 'w', 8000); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open ⋮ → Settings and press Grant access to Copilot.', 'e', 9000);
            switchView('settings');
            return;
        }
        // Copilot first — the question stays in the box until there is somewhere to send it.
        if ((await copilotAccessMissing()).length) {
            $('chatInput').value = text;
            offerCopilotSetup({ force: true });
            return;
        }

        const chat = chatFor(CHAT_KEY);
        const rev = REVIEWS.filter(r => r.key === CHAT_KEY && r.kind === 'qa').pop();
        chat.msgs.push({ role: 'user', content: text, at: Date.now() });
        const reply = { role: 'assistant', content: '', at: Date.now(), streaming: true };
        chat.msgs.push(reply);
        CHAT_BUSY = true;
        $('chatInput').value = '';
        renderChat();

        /* THE MATERIAL EVERY TIME, THE HISTORY BOUNDED.
         *
         * The relay reuses a Copilot conversation for a while and then starts a new one, and
         * there is no way from here to know which turn that happens on. An answer that
         * quietly lost the case transcript halfway through a conversation would be the worst
         * failure this feature could have — it would keep answering, in the same voice, from
         * nothing. So the material is re-sent with every question and the model is never
         * relying on the relay's memory for it. */
        /* THE WHOLE CASE, NOT THE INDEX COPY OF IT.
         *
         * Loaded here rather than held with the index — see loadContextDoc. An empty result
         * is not a failure: buildChatSystem falls back to the index copy, which is what a
         * case read before this build has and what a chat used to run on. */
        const fullTranscript = await loadContextDoc(CHAT_KEY);
        const messages = [{ role: 'system', content: E.buildChatSystem(ctx, rev, { transcript: fullTranscript }) }];
        const history = chat.msgs.slice(0, -1).slice(-CHAT_HISTORY_TURNS * 2);
        for (const m of history) {
            if (!m.content) continue;
            messages.push({ role: m.role, content: m.content });
        }

        /* THE SAME ALIASES THE REVIEW USED — see saveContext.
         *
         * The whole conversation goes through them, not just the case material: the
         * reviewer's own question ("what did Mohammed do on the 3rd?") carries the name as
         * readily as the transcript does, and one un-hidden name in the last message is
         * enough for the relay to decline the whole turn. The answer comes back through
         * show(), so the reviewer never sees a label. */
        const aliases = chatAliases(ctx);

        const msgsEl = $('chatMsgs');
        const paint = () => {
            const bubbles = msgsEl.querySelectorAll('.qa-msg-ai .qa-msg-body');
            const last = bubbles[bubbles.length - 1];
            if (last) last.innerHTML = renderRich(reply.content || '…');
            msgsEl.scrollTop = msgsEl.scrollHeight;
        };

        CHAT_ABORT = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const label = chat.caseNum ? `QA chat — ${chat.caseNum}` : 'QA chat';
        // This chat's own delivery record — see the note on askAi. A review being written in
        // the background at the same moment must not end up wearing this chat's provenance.
        const sent = {};
        const send = (msgs) => streamAi(
            msgs.map(m => ({ role: m.role, content: aliases.hide(m.content) })), label,
            // Re-identified as it streams, so a half-written "Agent A" becomes the real name
            // the moment the label completes rather than after the whole answer lands.
            (soFar) => { reply.content = aliases.show(soFar); paint(); },
            CHAT_ABORT ? CHAT_ABORT.signal : undefined, sent);

        try {
            reply.content = aliases.show(await send(messages));

            /* ASK ONCE MORE WHEN IT DECLINES. Same reasoning as the write-up's retry: the
             * refusal is about being asked to assess a person, and nothing here is — so the
             * second attempt says that in as many words instead of leaving it implied. It
             * happens once, silently, and the reviewer sees the answer rather than the
             * apology they cannot do anything with. */
            if (E.looksRefused(reply.content) && !(CHAT_ABORT && CHAT_ABORT.signal && CHAT_ABORT.signal.aborted)) {
                reply.content = '';
                paint();
                const again = messages.slice();
                again[again.length - 1] = {
                    role: 'user',
                    content: E.CHAT_RETRY_PREFACE + messages[messages.length - 1].content
                };
                reply.content = aliases.show(await send(again));
            }
            if (E.looksRefused(reply.content)) {
                reply.error = 'The AI relay declined to answer this one, twice. '
                    + (aliases.on
                        ? 'The case went out with every name already removed, so try asking about what the RECORD shows '
                          + 'rather than about the person who wrote it.'
                        : 'The case went out with the real names in it — turn on "Send cases with the names removed" in '
                          + 'Settings and ask again.')
                    + ' What it said is above.';
            }
        } catch (e) {
            const why = (e && e.message) || String(e);
            reply.error = /abort/i.test(why) ? 'Stopped.' : why;
        } finally {
            reply.streaming = false;
            CHAT_BUSY = false;
            CHAT_ABORT = null;
            const how = confirmDelivery(sent.delivery);
            if (!reply.error && deliveryWorrying(how)) reply.note = 'Note: ' + deliveryLine(how) + '.';
            // An answer that came back empty AND without an error has nothing to say and
            // nothing to explain — drop the bubble rather than leaving a blank one.
            if (!reply.content && !reply.error) chat.msgs.pop();
            await store({ [K.chats]: CHATS });
            renderChat();
        }
    }

    /* THE STREAMING CALL. The relay hands back NDJSON — one JSON object per line, each
     * carrying a delta — so an answer appears as it is written rather than after a minute of
     * silence. On a runtime with no readable body it falls back to reading the lot at once,
     * which is the old behaviour and still correct. */
    async function streamAi(messages, label, onDelta, signal, record) {
        if (!window.SotiAI) {
            throw new Error('ai-provider.js did not load, so there is nothing to send this to.');
        }
        if (label) window.SotiAI.setConversationLabel(label);
        // The same record the write-up keeps. A chat grounded in a case that had to be typed
        // into the box in eight parts is a different chat from one grounded in an attached
        // file, and the reviewer is entitled to know which they are having.
        LAST_DELIVERY = planDelivery(messages);
        if (record) record.delivery = LAST_DELIVERY;
        const res = await window.SotiAI.chat({
            messages,
            stream: true,
            options: { temperature: 0.3 }
        }, signal ? { signal } : {});
        if (!res || !res.ok) {
            const err = new Error(String(res ? await res.text() : 'no answer').slice(0, 600));
            if (res && res.status === 403) {                     // see askAi
                err.access = true;
                err.signin = /ended up on|Sign in to Microsoft 365/i.test(err.message);
            }
            throw err;
        }

        let out = '';
        const eat = (line) => {
            let frame;
            try { frame = JSON.parse(line); } catch (e) { return; }
            if (frame.error) throw new Error(String(frame.error));
            const bit = (frame.message && frame.message.content) || '';
            /* A REPLACEMENT, NOT AN ADDITION. When Copilot re-renders an answer it has already
             * drawn, the relay sends the whole answer so far with `replace` set — appended, it
             * printed the opening of the answer twice. See streamAsNdjson in ai-provider.js. */
            if (frame.replace) { out = bit; onDelta(out); }
            else if (bit) { out += bit; onDelta(out); }
        };

        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            // {stream:true} on every decode, because a multi-byte character can be split
            // across two chunks and decoding them independently produces a replacement
            // character in the middle of somebody's name.
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line) eat(line);
                }
            }
            buf += dec.decode();
            if (buf.trim()) eat(buf.trim());
        } else {
            const data = await res.json();
            out = (data && data.message && data.message.content) || '';
            onDelta(out);
        }
        if (!out.trim()) throw new Error('The relay came back with an empty answer.');
        return out;
    }

    /* ---------------------------------------------------------------------
     * THE REVIEWS TAB
     * ------------------------------------------------------------------- */
    /* WHAT COUNTS AS AN INCOMPLETE REVIEW.
     *
     * An `error` is the obvious half — the case would not open, or the relay threw. The other
     * half is the one that caused the blank sheet: a QA review that came back with no fields
     * in it. That is not a review, however successfully it arrived, and every place that
     * counts, filters or exports reviews asks this rather than asking about `error` alone. */
    function incomplete(r) {
        if (!r) return true;
        if (r.error) return true;
        if (r.kind === 'qa') return !Object.keys(r.fields || {}).some(k => String(r.fields[k] || '').trim());
        return !String(r.raw || '').trim();
    }

    function renderReviews() {
        const list = $('revList');
        if (!list) return;
        list.textContent = '';

        const q = ($('revSearch').value || '').trim().toLowerCase();
        const filter = $('revFilter').value || '';
        const order = $('revOrder');
        if (order) order.style.display = REVIEWS.length ? '' : 'none';
        let shown = REVIEWS.slice().sort((a, b) => b.at - a.at);
        if (filter === 'qa') shown = shown.filter(r => r.kind === 'qa' && !incomplete(r));
        if (filter === 'milestone') shown = shown.filter(r => r.kind === '306090');
        if (filter === 'failed') shown = shown.filter(incomplete);
        if (q) {
            shown = shown.filter(r => [r.caseNum, r.subject, r.account, r.agent, r.raw]
                .some(v => String(v || '').toLowerCase().includes(q)));
        }

        const meta = $('revMeta');
        const bad = REVIEWS.filter(incomplete);
        if (meta) {
            meta.textContent = REVIEWS.length
                ? `${shown.length} of ${REVIEWS.length} review${REVIEWS.length === 1 ? '' : 's'}${bad.length ? `, ${bad.length} incomplete` : ''}`
                : '';
        }
        /* THE WAY OUT OF THE PROBLEM, NEXT TO THE COUNT OF IT. Every case here was read once
         * already; what is missing is the write-up, and re-running them is the fix. The button
         * only exists when there is something for it to do. */
        const retry = $('btnRetryFailed');
        if (retry) {
            retry.style.display = bad.length && !RUN.active ? '' : 'none';
            retry.textContent = `Re-run the ${bad.length} incomplete one${bad.length === 1 ? '' : 's'}`;
        }

        /* THE DELETE BUTTON, LABELLED WITH WHAT IT WILL DELETE. It acts on the list as
         * filtered, because that is the list in front of the person pressing it — and it
         * says so, so "Delete all 27" and "Delete these 3" are never confusable. Hidden
         * when there is nothing to delete, and out of reach during a run: a run writes
         * reviews as it goes, and deleting the list underneath it would race it. */
        const del = $('btnDeleteReviews');
        if (del) {
            const filtered = shown.length !== REVIEWS.length;
            del.style.display = REVIEWS.length ? '' : 'none';
            del.disabled = RUN.active || !shown.length;
            del.textContent = filtered
                ? `Delete these ${shown.length}`
                : `Delete all ${REVIEWS.length}`;
            del.title = RUN.active
                ? 'Not while a run is going — it is writing reviews into this list.'
                : filtered
                    ? `Delete the ${shown.length} review(s) this filter is showing. The other ${REVIEWS.length - shown.length} are kept.`
                    : 'Delete every review in this list.';
            // The ids are read back by the click handler rather than closed over, so a
            // repaint between the paint and the press cannot delete a stale set.
            del.dataset.ids = JSON.stringify(shown.map(r => r.id));
        }
        const tools = $('revTools');
        if (tools) tools.style.display = (retry && retry.style.display !== 'none') || (del && del.style.display !== 'none') ? '' : 'none';

        if (!shown.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-empty';
            hint.innerHTML = REVIEWS.length
                ? 'No review matches this filter.'
                : 'No reviews yet.<br><br>Go to <b>Cases</b>, press <b>Select</b>, tick the ones you want reviewed, and press <b>QA</b>. '
                  + 'Each case is opened in a background window, read to the end of its feed, and written up here.';
            list.appendChild(hint);
            return;
        }
        renderReviewFolders(list, shown, !!(q || filter));
    }

    /* ---------------------------------------------------------------------
     * THE REVIEWS, IN FOLDERS — the month the case closed, then its owner
     * ---------------------------------------------------------------------
     * A month folder holds every review of a case that closed in that month, and carries the
     * AVERAGE SCORE of all of them. Inside it, one folder per owner with that owner's own
     * average, and inside that, the review cards. So "how did October go" and "how did Robert
     * do in October" are each one look, not a calculation.
     *
     * WHERE THE CLOSING MONTH COMES FROM, best first: the Date/Time Closed read off the case
     * itself when it was reviewed; then the closed date on the list or report the case was last
     * synced from (a report of closed cases carries one — sync it and older reviews move into
     * their months). A case with neither is either still open — its status says so — and sits
     * under "Not closed yet", or it is filed under "Closed month not known".
     *
     * The average counts the written-up QA reviews that have a score. A 30/60/90 analysis and an
     * incomplete review sit in the folder with everything else but are not scored, and the
     * count beside the average says how many it is the average of.
     * ------------------------------------------------------------------- */
    // The folders that are open: 'm:2026-10', 'open', 'unknown', and '<bucket>|<owner>' for an
    // owner inside one. null until the reviewer first opens or closes one — the newest is then
    // open by default. Kept in storage: it is how the reviewer left the tab.
    let REV_OPEN = null;

    const CLOSED_STATUS_RE = /\bclosed\b/i;

    function closedBucketOf(r, rec) {
        const at = Number(r.closedAt) || Number(rec && rec.closedAt) || 0;
        if (at > 0) {
            const d = new Date(at);
            const key = `m:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            let label = key.slice(2);
            try { label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); } catch (e) { /* the bare key */ }
            return { key, label, rank: -(d.getFullYear() * 12 + d.getMonth()) };
        }
        /* NO CLOSING DATE. The status says which kind of "no": a list synced after the review is
         * the fresher word on it, so a case that has closed since moves out of "Not closed yet"
         * — into its month when that list carries the date, otherwise into "not known". */
        const fresh = rec && rec.status && CASES.scrapedAt > (r.at || 0);
        const status = String((fresh && rec.status) || r.status || (rec && rec.status) || '');
        if (status && !CLOSED_STATUS_RE.test(status)) {
            return { key: 'open', label: 'Not closed yet', rank: -Infinity,
                     note: 'These cases were still open — no closing date yet. Once a case closes, a sync from a report of closed cases (or a re-run of its review) files it under its month.' };
        }
        return { key: 'unknown', label: 'Closed month not known', rank: Infinity,
                 note: 'No closing date was read for these — neither the case page nor the list it came from showed Date/Time Closed. '
                     + 'Sync them from a report of closed cases that has a Closed Date column, or re-run the review, and they move into their month.' };
    }

    function reviewScore(r) {
        return r && r.kind === 'qa' && !incomplete(r) && r.score && r.score.value !== null && r.score.value !== undefined
            ? Number(r.score.value) : null;
    }

    // { avg, n } over the scored reviews in a folder, or null when none is scored.
    function averageScore(reviews) {
        const got = reviews.map(reviewScore).filter(v => v !== null && Number.isFinite(v));
        if (!got.length) return null;
        return { avg: Math.round(got.reduce((a, b) => a + b, 0) / got.length), n: got.length };
    }

    function reviewSortComparator(sort, recOf) {
        const age = (r) => {
            const a = E.ageDaysOf(r.metrics && r.metrics.ageDays);
            if (a !== null) return a;
            const rec = recOf(r);
            return rec ? E.ageDaysOf(rec.ageDays) : null;
        };
        const closed = (r) => Number(r.closedAt) || Number((recOf(r) || {}).closedAt) || null;
        const newest = (a, b) => (b.at || 0) - (a.at || 0);
        const then = (cmp) => (a, b) => cmp(a, b) || newest(a, b);
        switch (sort) {
            case 'at-asc':      return then((a, b) => (a.at || 0) - (b.at || 0));
            case 'score-asc':   return then((a, b) => nullLast(reviewScore(a), reviewScore(b), (x, y) => x - y));
            case 'score-desc':  return then((a, b) => nullLast(reviewScore(a), reviewScore(b), (x, y) => y - x));
            case 'age-desc':    return then((a, b) => nullLast(age(a), age(b), (x, y) => y - x));
            case 'age-asc':     return then((a, b) => nullLast(age(a), age(b), (x, y) => x - y));
            case 'closed-desc': return then((a, b) => nullLast(closed(a), closed(b), (x, y) => y - x));
            case 'case':        return then((a, b) => String(a.caseNum || '').localeCompare(String(b.caseNum || ''), undefined, { numeric: true }));
            default:            return newest;
        }
    }

    function saveRevFolders() {
        return store({ [K.revFolders]: REV_OPEN ? [...REV_OPEN] : [] });
    }

    // One folder: a header that opens and closes it, and a body built only when it is opened —
    // a year of reviews is hundreds of cards, and nobody opens every month at once.
    function revFolder(level, id, title, meta, avg, note, open, build, onToggle) {
        const fold = document.createElement('div');
        fold.className = `qa-fold qa-fold-${level}` + (open ? ' open' : '');
        fold.dataset.id = id;

        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'qa-fold-head';
        head.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (note) head.title = note;

        const chev = document.createElement('span');
        chev.className = 'qa-fold-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = '▸';
        const icon = document.createElement('span');
        icon.className = 'qa-fold-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = level === 'month'
            ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>'
            : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
        const t = document.createElement('span');
        t.className = 'qa-fold-title';
        t.textContent = title;
        const m = document.createElement('span');
        m.className = 'qa-fold-meta';
        m.textContent = meta;
        head.append(chev, icon, t, m);

        const score = document.createElement('span');
        score.className = 'qa-fold-avg';
        const lab = document.createElement('span');
        lab.className = 'qa-fold-avglab';
        lab.textContent = level === 'month' ? 'Avg score' : 'Avg';
        const val = document.createElement('span');
        if (avg) {
            val.className = 'qa-score band-' + scoreBand({ value: avg.avg });
            val.textContent = String(avg.avg);
            score.title = `Average of ${avg.n} scored review${avg.n === 1 ? '' : 's'}`;
        } else {
            val.className = 'qa-score';
            val.textContent = '—';
            score.title = 'No scored QA review in here yet';
        }
        score.append(lab, val);
        head.appendChild(score);

        const body = document.createElement('div');
        body.className = 'qa-fold-body';
        let built = false;
        const paint = (isOpen) => {
            fold.classList.toggle('open', isOpen);
            head.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            body.hidden = !isOpen;
            if (isOpen && !built) { built = true; build(body); }
        };
        head.onclick = () => {
            const now = !fold.classList.contains('open');
            paint(now);
            onToggle(now);
        };
        fold.append(head, body);
        paint(open);
        return fold;
    }

    function renderReviewFolders(list, shown, forced) {
        const sort = ($('revSort') && $('revSort').value) || 'at-desc';
        const recByKey = new Map((CASES.cases || []).map(c => [keyOf(c), c]));
        const recOf = (r) => recByKey.get(r.key) || null;
        const cmp = reviewSortComparator(sort, recOf);
        const n = (x, one, many) => `${x} ${x === 1 ? one : (many || one + 's')}`;

        // month → owner → reviews
        const buckets = new Map();
        for (const r of shown) {
            const b = closedBucketOf(r, recOf(r));
            if (!buckets.has(b.key)) buckets.set(b.key, Object.assign({ reviews: [], owners: new Map() }, b));
            const bucket = buckets.get(b.key);
            bucket.reviews.push(r);
            const name = String(r.agent || '').replace(/\s+/g, ' ').trim() || 'Unassigned';
            const okey = name.toLowerCase();
            if (!bucket.owners.has(okey)) bucket.owners.set(okey, { key: okey, name, reviews: [] });
            bucket.owners.get(okey).reviews.push(r);
        }
        const months = [...buckets.values()].sort((a, b) => a.rank - b.rank);

        const isOpen = (id, dflt) => forced || (REV_OPEN ? REV_OPEN.has(id) : dflt);
        const toggled = (id) => (now) => {
            if (forced) return;   // a search opens what it found; it does not rewrite the layout
            if (!REV_OPEN) {
                // The first press: write the default down first, so it is what the press changes.
                REV_OPEN = new Set(months.length ? [months[0].key] : []);
            }
            if (now) REV_OPEN.add(id); else REV_OPEN.delete(id);
            saveRevFolders();
        };

        // The score orders rank the owners by their average; every other order keeps them A to Z.
        const ownerOrder = (owners) => {
            const list = [...owners.values()];
            const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
            if (sort === 'score-asc' || sort === 'score-desc') {
                const avg = new Map(list.map(o => [o.key, averageScore(o.reviews)]));
                const v = (o) => (avg.get(o.key) ? avg.get(o.key).avg : null);
                return list.sort((a, b) => nullLast(v(a), v(b), (x, y) => sort === 'score-asc' ? x - y : y - x) || byName(a, b));
            }
            return list.sort(byName);
        };

        const frag = document.createDocumentFragment();
        months.forEach((month, i) => {
            const owners = ownerOrder(month.owners);
            const meta = `${n(month.reviews.length, 'review')} · ${n(owners.length, 'owner')}`;
            frag.appendChild(revFolder('month', month.key, month.label, meta, averageScore(month.reviews), month.note,
                isOpen(month.key, i === 0),
                (body) => {
                    if (month.note) {
                        const why = document.createElement('div');
                        why.className = 'qa-fold-note';
                        why.textContent = month.note;
                        body.appendChild(why);
                    }
                    for (const owner of owners) {
                        const id = `${month.key}|${owner.key}`;
                        const bad = owner.reviews.filter(incomplete).length;
                        const ometa = n(owner.reviews.length, 'review') + (bad ? ` · ${bad} incomplete` : '');
                        body.appendChild(revFolder('owner', id, owner.name, ometa, averageScore(owner.reviews), '',
                            isOpen(id, false),
                            (inner) => {
                                for (const r of owner.reviews.slice().sort(cmp)) inner.appendChild(reviewCard(r, recOf(r)));
                            },
                            toggled(id)));
                    }
                },
                toggled(month.key)));
        });
        list.appendChild(frag);
    }

    // Every folder on the tab, open or shut — for Expand all / Collapse all.
    function setAllRevFolders(open) {
        if (open) {
            const recByKey = new Map((CASES.cases || []).map(c => [keyOf(c), c]));
            const ids = new Set();
            for (const r of REVIEWS) {
                const b = closedBucketOf(r, recByKey.get(r.key) || null);
                ids.add(b.key);
                ids.add(`${b.key}|${(String(r.agent || '').replace(/\s+/g, ' ').trim() || 'Unassigned').toLowerCase()}`);
            }
            REV_OPEN = ids;
        } else {
            REV_OPEN = new Set();
        }
        saveRevFolders();
        renderReviews();
    }

    function reviewCard(r, rec) {
        const card = document.createElement('div');
        card.className = 'qa-rev';
        card.dataset.id = r.id;
        if (incomplete(r)) card.classList.add('qa-rev-failed');
        else if (r.score) card.classList.add('band-' + scoreBand(r.score));

        const head = document.createElement('div');
        head.className = 'qa-rev-head';

        const num = document.createElement('span');
        num.className = 'qa-rev-num';
        num.textContent = r.caseNum || '(no number)';
        head.appendChild(num);

        if (r.kind === '306090') {
            const tag = document.createElement('span');
            tag.className = 'qa-ms qa-ms-' + (r.milestone || 30);
            tag.textContent = (r.milestone || '?') + 'd review';
            head.appendChild(tag);
        }

        const subj = document.createElement('span');
        subj.className = 'qa-rev-subject';
        subj.textContent = r.subject || '';
        subj.title = r.subject || '';
        head.appendChild(subj);

        const who = document.createElement('span');
        who.className = 'qa-rev-agent';
        who.textContent = r.agent || '';
        head.appendChild(who);

        // When it closed — the date its month folder was chosen by.
        const closedAt = Number(r.closedAt) || Number(rec && rec.closedAt) || 0;
        if (closedAt) {
            const c = document.createElement('span');
            c.className = 'qa-rev-closed';
            c.textContent = 'Closed ' + E.fmtDate(closedAt);
            c.title = `Closed ${E.fmtDateTime(closedAt)}`;
            head.appendChild(c);
        }

        if (incomplete(r)) {
            // Not a score: a review that did not come back has nothing to score — see the
            // QA column on the Cases tab for the same rule.
            const s = document.createElement('span');
            s.className = 'qa-score qa-score-bad';
            s.textContent = '!';
            s.title = 'Incomplete — the write-up did not come back. Open the card to see why.';
            head.appendChild(s);
        } else if (r.score && r.score.value !== null) {
            const s = document.createElement('span');
            s.className = 'qa-score band-' + scoreBand(r.score);
            s.textContent = String(r.score.value);
            if (r.score.derived) {
                // The dot is the whole marker. A word here would be read as part of the
                // score, and the number is the thing being read.
                s.classList.add('qa-score-derived');
                s.title = 'Worked out from the measured facts — the write-up did not give a score.'
                    + (r.score.basis ? ' Based on: ' + r.score.basis + '.' : '');
            } else {
                s.title = `${r.score.value}/100 — ${r.score.band}`;
            }
            head.appendChild(s);
        }

        const chev = document.createElement('span');
        chev.className = 'qa-rev-chev';
        chev.textContent = '▾';
        head.appendChild(chev);

        const body = document.createElement('div');
        body.className = 'qa-rev-body';
        body.style.display = 'none';
        head.onclick = () => {
            const open = body.style.display === 'none';
            body.style.display = open ? '' : 'none';
            chev.textContent = open ? '▴' : '▾';
        };
        card.appendChild(head);
        card.appendChild(body);

        /* THE MEASURED FINDINGS FIRST, AND LOOKING DIFFERENT FROM THE PROSE.
         * These are arithmetic; the paragraphs under them are judgement. A reader has to be
         * able to tell which is which without being told, because they carry different
         * weight in a coaching conversation. */
        if (r.findings && r.findings.length) {
            const wrap = document.createElement('div');
            wrap.className = 'qa-findings';
            for (const f of r.findings) {
                const line = document.createElement('div');
                line.className = 'qa-find sev-' + f.severity;
                const mark = document.createElement('span');
                mark.className = 'qa-find-mark';
                mark.textContent = f.severity === 'fail' ? '✕' : f.severity === 'pass' ? '✓' : f.severity === 'warn' ? '!' : '·';
                line.appendChild(mark);
                line.appendChild(document.createTextNode(f.text));
                wrap.appendChild(line);
            }
            body.appendChild(wrap);
        }

        if (r.error) {
            const f = document.createElement('div');
            f.className = 'qa-field';
            f.innerHTML = `<div class="qa-field-k">This review is incomplete</div><div class="qa-field-v">${esc(r.error)}</div>`;
            body.appendChild(f);
        }

        if (r.kind === 'qa') {
            for (const key of E.QA_FIELDS) {
                const v = (r.fields && r.fields[key]) || '';
                if (!v) continue;
                if (key === 'Training Needed') continue;   // rendered as pills below
                const f = document.createElement('div');
                f.className = 'qa-field';
                f.innerHTML = `<div class="qa-field-k">${esc(key)}</div><div class="qa-field-v">${esc(v)}</div>`;
                body.appendChild(f);
            }
            if (r.training && (r.training.labels.length || r.training.unmatched.length)) {
                const f = document.createElement('div');
                f.className = 'qa-field';
                const pills = r.training.labels.map(l => `<span class="qa-train">${esc(l)}</span>`).join('')
                    + r.training.unmatched.map(l => `<span class="qa-train qa-train-other" title="Not one of the tool's training areas — kept as the model wrote it.">${esc(l)}</span>`).join('');
                f.innerHTML = `<div class="qa-field-k">Training needed</div><div>${pills}</div>`;
                body.appendChild(f);
            }
            /* AND WHEN THERE WAS NO REVIEW IN THE ANSWER, THE ANSWER.
             *
             * Without this the card is empty and says nothing at all — which is what a
             * refusal looked like, and it is the reason a run of them went unnoticed until
             * the sheet was opened. It is shown as a quotation, not as prose, because it is
             * not this tool speaking. */
            if (incomplete(r) && String(r.raw || '').trim()) {
                const f = document.createElement('div');
                f.className = 'qa-field qa-rev-said';
                const how = r.deidentified === undefined ? ''
                    : r.deidentified ? ' — this case was sent with the names removed'
                    : ' — this case was sent with the real names in it';
                f.innerHTML = `<div class="qa-field-k">${r.refused ? 'The relay declined' : 'What came back instead'}${esc(how)}</div>`
                    + `<div class="qa-field-v">${esc(String(r.raw).trim().slice(0, 4000))}</div>`;
                body.appendChild(f);
            }
        } else if (r.raw) {
            const f = document.createElement('div');
            f.className = 'qa-field';
            f.innerHTML = `<div class="qa-field-k">30/60/90 analysis</div><div class="qa-field-v">${esc(r.raw)}</div>`;
            body.appendChild(f);
        }

        /* WHAT THIS WRITE-UP WAS GROUNDED IN, at the bottom of the card where a footnote
         * belongs. It is the answer to the question a reviewer asks when they disagree with a
         * score — "did it even read the whole case?" — and it is the one question the card
         * could not answer before. Only on reviews that carry the record: everything written
         * by an earlier build has no `delivery` and gets no line rather than a misleading one. */
        if (r.delivery) {
            const f = document.createElement('div');
            f.className = 'qa-field qa-rev-delivery';
            const worry = !!(r.delivery.fellBack || r.delivery.attachTrimmed || r.delivery.trimmed);
            f.innerHTML = `<div class="qa-field-k">${worry ? 'How the case was sent — read this' : 'How the case was sent'}</div>`
                + `<div class="qa-field-v${worry ? ' qa-rev-delivery-warn' : ''}">${esc(deliveryLine(r.delivery))}</div>`;
            body.appendChild(f);
        }

        const acts = document.createElement('div');
        acts.className = 'qa-rev-acts';
        /* FIRST, and the primary. A review is read in order to disagree with it or to act on
         * it, and both of those are questions — so the control that lets you ask one belongs
         * at the front of this row rather than after Copy and Delete. */
        const talk = document.createElement('button');
        talk.className = 'btn' + (incomplete(r) ? '' : ' qa-btn-primary');
        talk.textContent = 'Ask about this case';
        talk.onclick = () => openChat(r.key);
        acts.appendChild(talk);
        /* ON AN INCOMPLETE REVIEW THIS IS THE PRIMARY, and "Ask about this case" is not:
         * there is nothing yet to ask about. One case, read and written up again, without
         * going back to the queue to find and tick it. */
        if (incomplete(r)) {
            const again = document.createElement('button');
            again.className = 'btn qa-btn-primary';
            again.textContent = 'Read and write it up again';
            again.onclick = () => rerunReviews([r]);
            acts.appendChild(again);
        }
        const copy = document.createElement('button');
        copy.className = 'btn';
        copy.textContent = 'Copy';
        copy.onclick = () => copyText(reviewAsText(r), 'Review copied');
        acts.appendChild(copy);
        if (r.url) {
            const open = document.createElement('button');
            open.className = 'btn';
            open.textContent = 'Open in Salesforce';
            open.onclick = () => window.QaReader.createTab({ url: r.url, active: true }, () => {});
            acts.appendChild(open);
        }
        const del = document.createElement('button');
        del.className = 'btn';
        del.textContent = 'Delete';
        del.onclick = async () => {
            if (RUN.active) { toast('Wait for the run to finish — it is writing into this list.', 'w'); return; }
            const ok = await confirmAsk(`Delete the review of ${r.caseNum || 'this case'}?`,
                'It took a read of the case and a Copilot answer to write, and there is no undo. The case itself stays in the queue.',
                'Delete');
            if (!ok) return;
            REVIEWS = REVIEWS.filter(x => x.id !== r.id);
            await store({ [K.reviews]: REVIEWS });
            renderAll();
        };
        acts.appendChild(del);
        body.appendChild(acts);

        return card;
    }

    /* RE-RUNNING WHAT DID NOT COME OUT.
     *
     * A review knows its own case — key, link, number — so it can be run again without the
     * reviewer going back to the queue to find the row it came from. A case that is still in
     * the queue is run as that record, so the run fills its row in as it always did; one
     * that has since been cleared out of the queue is run from what the review remembers.
     */
    function rerunReviews(list) {
        if (RUN.active) { toast('A run is already going — wait for it or press Stop.', 'w'); return; }
        const recs = [];
        const noLink = [];
        for (const r of list) {
            const rec = CASES.cases.find(c => keyOf(c) === r.key)
                || { recordId: /^500/.test(r.key) ? r.key : '', url: r.url || '', caseNum: r.caseNum || '', subject: r.subject || '', owner: r.agent || '' };
            if (!urlOf(rec)) { noLink.push(r.caseNum || r.key); continue; }
            if (!recs.some(x => keyOf(x) === keyOf(rec))) recs.push(rec);
        }
        if (noLink.length) {
            toast(`${noLink.length} of these has no Salesforce link to re-open: ${noLink.slice(0, 3).join(', ')}${noLink.length > 3 ? '…' : ''}`, 'w', 9000);
        }
        if (!recs.length) return;
        // 30/60/90 records and QA reviews are different documents from different prompts, so
        // a mixed selection runs as two passes rather than one that would rewrite half of
        // them as the wrong kind. QA first, because it is the one somebody is waiting on.
        const kinds = [...new Set(list.map(r => r.kind))].sort();
        const kind = kinds.length === 1 ? kinds[0] : 'qa';
        if (kinds.length > 1) toast('Re-running the QA reviews. Re-run the 30/60/90 analyses from their own cards.', 'w', 8000);
        startRun(kind, recs.filter(rec => list.some(r => r.kind === kind && r.key === keyOf(rec))));
    }

    function reviewAsText(r) {
        const head = `${r.caseNum} — ${r.subject}\nAgent: ${r.agent}\nReviewed: ${E.fmtDateTime(r.at)}\n`;
        const findings = (r.findings || []).map(f => `  ${f.severity.toUpperCase()}: ${f.text}`).join('\n');
        return `${head}\nMEASURED\n${findings}\n\n${r.raw || '(no write-up)'}`;
    }

    /* ---------------------------------------------------------------------
     * THE QA SHEET
     * ---------------------------------------------------------------------
     * The team's own spreadsheet, column for column and in its order, so a run
     * can be pasted straight into it.
     *
     * THE LAST THREE COLUMNS ARE ADDITIONS and are marked as such in the README:
     * Agent, QA Score and Training Needed. They come after the ten the sheet
     * already has, never in among them, so pasting into the existing spreadsheet
     * lines up and the extras spill into the empty columns to the right of it
     * rather than pushing everything one across.
     * ------------------------------------------------------------------- */
    const SHEET_COLUMNS = [
        'Case Number', 'Date Reviewed', 'Closure Check', 'Internal Resolution Note Quality',
        'Case Handling Notes', 'JIRA / Other Agent Follow-up', 'KB Articles',
        'Positive(s)', 'Improvement Point(s)', 'Final Comment',
        'Agent', 'QA Score', 'Training Needed'
    ];

    function sheetRows() {
        return REVIEWS
            // NOT `!r.error`. A refused write-up carries no error and no fields, and under
            // that test it put a row on the sheet with a case number, a date and eleven
            // empty columns — which reads, to anyone opening the sheet, as a reviewed case.
            .filter(r => r.kind === 'qa' && !incomplete(r))
            .sort((a, b) => a.at - b.at)
            .map(r => {
                const f = r.fields || {};
                const row = {};
                for (const col of SHEET_COLUMNS) row[col] = f[col] || '';
                row['Case Number'] = f['Case Number'] || r.caseNum || '';
                row['Date Reviewed'] = f['Date Reviewed'] || E.fmtDate(r.at);
                row['Agent'] = r.agent || '';
                row['QA Score'] = f['QA Score'] || (r.score && r.score.value !== null ? `${r.score.value}/${r.score.band}` : '');
                row['Training Needed'] = (r.training && r.training.labels.length)
                    ? r.training.labels.concat(r.training.unmatched).join('; ')
                    : (f['Training Needed'] || '');
                return row;
            });
    }

    // The columns that carry the review itself, as opposed to the ones this tool fills in
    // from its own record. A row with all of these empty has nothing in it that was written.
    const PROSE_COLUMNS = [
        'Closure Check', 'Internal Resolution Note Quality', 'Case Handling Notes',
        'JIRA / Other Agent Follow-up', 'KB Articles', 'Positive(s)', 'Improvement Point(s)', 'Final Comment'
    ];

    function renderSheet() {
        const table = $('sheetTable');
        const hint = $('sheetHint');
        if (!table) return;
        const rows = sheetRows();
        table.textContent = '';
        if (hint) hint.style.display = rows.length ? 'none' : '';
        const monthEl = $('sheetMonth');
        if (monthEl && monthEl.value !== SHEET_MONTH) monthEl.value = SHEET_MONTH;
        if (!rows.length) return;

        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const col of SHEET_COLUMNS) {
            const th = document.createElement('th');
            th.textContent = col;
            hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of rows) {
            const tr = document.createElement('tr');
            // A row that came back with the prose columns empty is still a real review — it
            // was read and measured — but it is not one to paste anywhere, so it is dimmed
            // and labelled rather than shown as if it were finished.
            const thin = !PROSE_COLUMNS.some(c => String(row[c] || '').trim());
            if (thin) tr.className = 'qa-row-empty';
            for (const col of SHEET_COLUMNS) {
                const td = document.createElement('td');
                if (col === 'Case Number') td.className = 'qa-cell-num';
                if (col === 'Date Reviewed') td.className = 'qa-cell-date';
                td.textContent = row[col] || '';
                if (thin && col === 'Case Number') {
                    const flag = document.createElement('span');
                    flag.className = 'qa-row-flag';
                    flag.textContent = 'not written up';
                    flag.title = 'The case was read and measured, but the write-up came back empty. Re-run it from Reviews.';
                    td.appendChild(flag);
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
    }

    /* ---------------------------------------------------------------------
     * THE COACHING SHEET
     * ------------------------------------------------------------------- */
    const COACH_COLUMNS = ['Agent', 'Main Pattern Observed', 'Coaching Pointer / SMART Goal', 'Due Date', 'Notes'];

    // Every agent who has a reviewed case, plus everyone on the roster — so a team member
    // with nothing reviewed this month has a visible empty row rather than being absent,
    // which is the difference between "nothing to say" and "forgotten".
    function agentsWithReviews() {
        const map = new Map();
        for (const name of ROSTER) map.set(name.toLowerCase(), { name, reviews: [] });
        for (const r of REVIEWS) {
            if (r.kind !== 'qa' || incomplete(r)) continue;
            const who = r.agent || 'Unassigned';
            const low = who.toLowerCase();
            // Match a roster first name against the fuller name Salesforce reports —
            // "Imran" on the sheet is "Imran Khan" on the case, and two rows for one
            // person is exactly what the roster exists to prevent.
            let slot = map.get(low);
            if (!slot) {
                for (const [k, v] of map) {
                    if (low.startsWith(k + ' ') || k.startsWith(low + ' ')) { slot = v; break; }
                }
            }
            if (!slot) { slot = { name: who, reviews: [] }; map.set(low, slot); }
            slot.reviews.push(r);
        }
        return [...map.values()];
    }

    function renderCoaching() {
        const strip = $('coachStrip');
        const table = $('coachTable');
        const hint = $('coachHint');
        if (!table) return;

        const agents = agentsWithReviews();
        const withWork = agents.filter(a => a.reviews.length);
        const meta = $('coachMeta');
        if (meta) {
            meta.textContent = withWork.length
                ? `${withWork.length} agent${withWork.length === 1 ? '' : 's'} with reviewed cases, ${COACHING.length} coaching row${COACHING.length === 1 ? '' : 's'} written`
                : '';
        }
        if (hint) hint.style.display = withWork.length ? 'none' : '';

        /* WHAT EACH AGENT'S REVIEWS ADD UP TO, counted rather than judged. This is the check
         * on the written row beside it: if the summary says "documentation" and the count
         * says the top area was networking, one of them is wrong and a reviewer can see it. */
        if (strip) {
            strip.textContent = '';
            for (const a of withWork) {
                const scores = a.reviews.map(r => r.score && r.score.value).filter(v => typeof v === 'number');
                const avg = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
                const counts = new Map();
                for (const r of a.reviews) for (const id of ((r.training && r.training.ids) || [])) {
                    counts.set(id, (counts.get(id) || 0) + 1);
                }
                const top = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
                const box = document.createElement('div');
                box.className = 'qa-agent';
                const n = document.createElement('div');
                n.className = 'qa-agent-name';
                n.textContent = a.name;
                const m = document.createElement('div');
                m.className = 'qa-agent-meta';
                m.textContent = `${a.reviews.length} case${a.reviews.length === 1 ? '' : 's'}${avg !== null ? ` · avg ${avg}` : ''}`;
                box.appendChild(n);
                box.appendChild(m);
                if (top) {
                    const t = document.createElement('div');
                    t.className = 'qa-agent-top';
                    const area = E.TRAINING_BY_ID.get(top[0]);
                    t.textContent = `${area ? area.label : top[0]} ×${top[1]}`;
                    box.appendChild(t);
                }
                strip.appendChild(box);
            }
        }

        table.textContent = '';
        const order = new Map(ROSTER.map((n, i) => [n.toLowerCase(), i]));
        const rows = agents
            .filter(a => a.reviews.length || order.has(a.name.toLowerCase()))
            .sort((a, b) => {
                const ia = order.has(a.name.toLowerCase()) ? order.get(a.name.toLowerCase()) : 999;
                const ib = order.has(b.name.toLowerCase()) ? order.get(b.name.toLowerCase()) : 999;
                return ia - ib || a.name.localeCompare(b.name);
            });
        if (!rows.length) return;

        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const col of COACH_COLUMNS) {
            const th = document.createElement('th');
            th.textContent = col;
            hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const a of rows) {
            const written = COACHING.find(c => c.agent.toLowerCase() === a.name.toLowerCase());
            const tr = document.createElement('tr');
            for (const col of COACH_COLUMNS) {
                const td = document.createElement('td');
                if (col === 'Agent') td.textContent = a.name;
                else td.textContent = (written && written.fields && written.fields[col]) || '';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
    }

    async function buildCoaching() {
        if (RUN.active) { toast('Wait for the QA run to finish first.', 'w'); return; }
        if (RUN.coaching) return;
        const agents = agentsWithReviews().filter(a => a.reviews.length);
        if (!agents.length) { toast('No reviewed cases to summarise yet.', 'w'); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open ⋮ → Settings and press Grant access to Copilot.', 'e', 9000);
            return;
        }
        const btn = $('btnBuildCoaching');
        if (btn) btn.disabled = true;
        // The pill reads RUN.failed to decide whether it ends green or red, and that count
        // belongs to whatever ran last. Cleared, or a clean coaching pass inherits the
        // failures of the QA run before it.
        RUN.failed = 0;
        if ((await copilotAccessMissing()).length) {
            offerCopilotSetup({ force: true });
            if (btn) btn.disabled = false;
            return;
        }
        RUN.stop = false;
        RUN.coaching = true;
        showRunPill(true);
        let written = 0, failed = 0, blocked = false;
        try {
            for (let i = 0; i < agents.length; i++) {
                if (RUN.stop) break;
                const a = agents[i];
                setRunNote(`Coaching summary ${i + 1}/${agents.length} — ${a.name}…`);
                // NOTE the conversation label below is a NUMBER, not the agent's name: the
                // relay keeps a list of its own conversations, and a QA run should not be
                // writing a roster of who was appraised this month into somebody's Copilot.
                try {
                    /* THE ONE PROMPT THAT IS ABOUT A PERSON BY CONSTRUCTION — a month of one
                     * agent's cases, summarised into a coaching row. So it is the one that was
                     * refused hardest, and the one where hiding the names costs nothing at all:
                     * the Agent column is written from the roster two lines below, and never
                     * from the answer. See coachingAliases. */
                    const aliases = coachingAliases(a.name);
                    const askCoach = async (retry) => {
                        const prompt = E.buildCoachingPrompt(a.name, a.reviews, { retry });
                        return aliases.show(await askAi(
                            { system: aliases.hide(prompt.system), request: aliases.hide(prompt.request) },
                            retry ? `Coaching — ${i + 1} (again)` : `Coaching — ${i + 1} of ${agents.length}`));
                    };

                    /* THE SAME LADDER AS A WRITE-UP, for the same reason — see writeUp.
                     * A coaching row is asked for once per agent at the end of a run, which
                     * is exactly when the relay has been driven hardest and is most likely
                     * to rate-limit; giving up on the first throw meant losing the row for
                     * that agent and being told "m365". There is no transcript to shrink
                     * here — the input is a handful of reviews — so the ladder is pauses
                     * rather than sizes. */
                    let text = '';
                    let parsed = null;
                    let threw = '';
                    let refused = false;
                    for (let n = 0; n < 3; n++) {
                        if (n > 0) await new Promise(r => setTimeout(r, 3000 * n));
                        let said = '';
                        try {
                            said = await askCoach(n > 0);
                            threw = '';
                        } catch (e) {
                            threw = (e && e.message) || String(e);
                            if (e && e.access) throw e;
                            logLine(`Coaching for ${a.name}: attempt ${n + 1} of 3 failed — ${firstLine(threw)}`, 'warn');
                            continue;
                        }
                        const judged = E.parseCoachingAnswer(said);
                        if (!parsed || judged.usable || judged.filled > parsed.filled) { text = said; parsed = judged; }
                        if (judged.usable) break;
                        refused = refused || judged.refused;
                    }
                    if (!parsed || !parsed.usable) {
                        throw new Error(threw && (!parsed || !parsed.filled)
                            ? 'the relay could not be reached after 3 attempts — ' + threw
                            : refused
                                ? 'the relay declined to write a coaching row, 3 times'
                                : 'the answer came back without the coaching headers in it');
                    }
                    parsed.fields['Agent'] = a.name;          // ours, not the model's
                    const row = { agent: a.name, at: Date.now(), fields: parsed.fields, raw: text, cases: a.reviews.length };
                    const at = COACHING.findIndex(c => c.agent.toLowerCase() === a.name.toLowerCase());
                    if (at >= 0) COACHING[at] = row; else COACHING.push(row);
                    await store({ [K.coaching]: COACHING });
                    written++;
                    renderCoaching();
                } catch (e) {
                    if (e && e.access) {
                        // Every agent after this one would fail the same way.
                        blocked = true;
                        offerCopilotSetup({ force: true, signin: !!e.signin });
                        break;
                    }
                    failed++;
                    toast(`${a.name}: ${(e && e.message) || e}`, 'e', 9000);
                }
            }
            if (blocked) {
                RUN.failed = Math.max(1, RUN.failed);
                setRunNote('Coaching stopped — Copilot access needed');
                toast('Coaching stopped — Chrome has not given the QA Tool access to Copilot. Grant it, then press Build from reviews again.', 'e', 12000);
            } else if (RUN.stop) {
                RUN.failed = failed;
                setRunNote(`Coaching stopped — ${written} row${written === 1 ? '' : 's'} written`);
                toast(`Coaching stopped — ${written} of ${agents.length} row${agents.length === 1 ? '' : 's'} written.`, 'i', 8000);
            } else {
                RUN.failed = failed;
                setRunNote(`Coaching: ${written} of ${agents.length} written${failed ? `, ${failed} failed` : ''}`);
                toast(`Coaching rows written for ${written} of ${agents.length} agent${agents.length === 1 ? '' : 's'}`
                    + (failed ? ` — ${failed} could not be written.` : '.'), failed ? 'w' : 's', 8000);
            }
        } finally {
            RUN.coaching = false;
            if (btn) btn.disabled = false;
            showRunPill(false);
        }
    }

    /* WHO A COACHING SUMMARY HAS TO HIDE.
     *
     * Not one case's people but the whole team's: the row is built out of a month of review
     * text, and that text names the agent it is about, whoever covered for them, and the
     * customers on their cases. The agent being summarised is put first so they come out as
     * Agent A, exactly as they would in a review of one of their own cases. */
    function coachingAliases(primary) {
        const entries = [{ name: primary, side: 'us' }];
        for (const n of ROSTER) entries.push({ name: n, side: 'us' });
        for (const r of REVIEWS) if (r.agent) entries.push({ name: r.agent, side: 'us' });
        for (const c of Object.values(CONTEXT)) {
            for (const x of (c.people || [])) if (x && x.real) entries.push({ name: x.real, side: x.side });
        }
        return E.aliasesFromNames(entries, RULES.deident !== false);
    }

    /* ---------------------------------------------------------------------
     * GETTING IT OUT — clipboard and CSV
     * ------------------------------------------------------------------- */
    async function copyText(text, said) {
        try {
            await navigator.clipboard.writeText(text);
            toast(said || 'Copied', 's');
        } catch (e) {
            // Clipboard permission can be refused in a panel that has just lost focus. A
            // hidden textarea and execCommand is the fallback every browser still honours.
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                toast(said || 'Copied', 's');
            } catch (e2) {
                toast('Could not copy — select the text and copy it by hand.', 'e');
            }
        }
    }

    // TAB-SEPARATED for the clipboard, comma-separated for the file. A paste into Excel is a
    // paste of tab-separated text; commas in a QA note would be read as new columns and the
    // row would arrive shredded across twenty cells.
    function toTsv(headers, rows) {
        const cell = (v) => String(v === null || v === undefined ? '' : v)
            .replace(/\t/g, ' ')
            .replace(/\r?\n/g, ' ↵ ');   // a visible return, so a bullet list survives as one cell
        return [headers.join('\t')]
            .concat(rows.map(r => headers.map(h => cell(r[h])).join('\t')))
            .join('\n');
    }

    function download(name, text, mime) {
        const blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const done = () => setTimeout(() => URL.revokeObjectURL(url), 20000);
        if (isExt() && chrome.downloads && chrome.downloads.download) {
            chrome.downloads.download({ url, filename: name, saveAs: true }, () => { void chrome.runtime.lastError; done(); });
            return;
        }
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        done();
    }

    function stamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    /* ---------------------------------------------------------------------
     * SETTINGS
     * ------------------------------------------------------------------- */
    function fillSettings() {
        $('setFrt').value = RULES.frtHours;
        $('setGap').value = RULES.gapDays;
        $('setMeetingNote').value = RULES.meetingNoteHours;
        $('setOpenWait').value = RULES.openWaitDays;
        $('setWorkers').value = RULES.workers;
        $('setRoster').value = ROSTER.join('\n');
        $('setDeident').checked = RULES.deident !== false;
        refreshAiStatus();
    }


    /* EVERY HOST IN THE GRANT, not only the configured one. Microsoft forwards the chat from
     * m365.cloud.microsoft to copilot.cloud.microsoft, and naming only the first is how this
     * read "Ready" in green while every review failed on the host the tab had landed on. */
    async function refreshAiStatus() {
        const el = $('aiStatus');
        const btn = $('btnGrantAi');
        if (!el) return;
        if (!window.SotiAI) {
            el.textContent = 'ai-provider.js did not load';
            el.className = 'qa-set-status bad';
            return;
        }
        const bare = (o) => String(o).replace(/^https?:\/\//, '');
        const hosts = (window.SotiAI.bridgeOrigins ? window.SotiAI.bridgeOrigins() : []).map(bare);
        const missing = (await copilotAccessMissing()).map(bare);
        el.textContent = !missing.length
            ? `Ready — ${hosts.join(' + ')}`
            : missing.length < hosts.length
                ? `${missing.join(' + ')} is not granted yet — Microsoft moves the chat there, so reviews fail until you allow it`
                : 'Not granted yet — reviews cannot be written until you allow it';
        el.className = 'qa-set-status ' + (missing.length ? 'bad' : 'ok');
        if (btn) btn.textContent = missing.length ? 'Grant access to Copilot' : 'Access granted to Copilot';
    }

    async function saveSettings() {
        const num = (id, lo, hi, fallback) => {
            const v = parseFloat($(id).value);
            return isFinite(v) && v >= lo && v <= hi ? v : fallback;
        };
        RULES.frtHours = num('setFrt', 0.25, 72, E.DEFAULT_RULES.frtHours);
        RULES.gapDays = num('setGap', 1, 60, E.DEFAULT_RULES.gapDays);
        RULES.meetingNoteHours = num('setMeetingNote', 1, 168, E.DEFAULT_RULES.meetingNoteHours);
        RULES.openWaitDays = num('setOpenWait', 1, 30, E.DEFAULT_RULES.openWaitDays);
        RULES.workers = Math.round(num('setWorkers', 1, 4, 2));
        RULES.deident = !!$('setDeident').checked;
        ROSTER = ($('setRoster').value || '').split('\n').map(s => s.trim()).filter(Boolean);
        if (!ROSTER.length) ROSTER = DEFAULT_ROSTER.slice();
        await store({ [K.rules]: RULES, [K.roster]: ROSTER });
        fillSettings();
        renderAll();
        toast('Settings saved.', 's');
    }

    /* ---------------------------------------------------------------------
     * WIRING
     * ------------------------------------------------------------------- */
    function wire() {
        for (const t of document.querySelectorAll('.tab-item')) {
            t.onclick = () => switchView(t.dataset.view);
            t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView(t.dataset.view); } };
        }
        $('btnHome').onclick = () => switchView('cases');
        $('btnHome').onkeydown = (e) => { if (e.key === 'Enter') switchView('cases'); };

        const more = $('moreDropdown');
        $('btnMore').onclick = (e) => {
            e.stopPropagation();
            more.style.display = more.style.display === 'none' ? '' : 'none';
        };
        document.addEventListener('click', () => { more.style.display = 'none'; });
        $('btnGoSettings').onclick = () => switchView('settings');
        $('btnExportAll').onclick = exportEverything;
        $('btnClearReviews').onclick = async () => {
            const chats = Object.values(CHATS).filter(c => c && c.msgs && c.msgs.length).length;
            const ok = await confirmAsk('Clear everything this tool has stored?',
                `This deletes all ${REVIEWS.length} review(s), ${COACHING.length} coaching row(s)`
                + `${chats ? `, ${chats} case conversation(s)` : ''} and the stored case material. `
                + 'To delete only the reviews and keep the conversations, use Delete on the Reviews tab instead. '
                + 'The cases in Salesforce are untouched. This cannot be undone.',
                'Delete everything');
            if (!ok) return;
            REVIEWS = [];
            COACHING = [];
            CHATS = {};
            CONTEXT = {};
            CHAT_KEY = '';
            await store({ [K.reviews]: REVIEWS, [K.coaching]: COACHING, [K.chats]: CHATS, [K.context]: CONTEXT });
            /* AND THE TRANSCRIPT DOCUMENTS, which are keyed per case and so are not in the
             * list of constants above. Left out, the one thing "clear everything" would fail
             * to clear is the largest thing this tool stores — and it is the customer's case
             * text, which is exactly what somebody pressing this button means by everything. */
            const docs = await contextDocKeys();
            if (docs.length && isExt()) {
                try { await chrome.storage.local.remove(docs); } catch (e) { console.warn('QA Tool: could not clear the stored transcripts', e); }
            }
            renderAll();
            toast('Reviews, chats and stored case material cleared.', 's');
        };

        $('btnSyncCaseList').onclick = syncCaseList;
        $('ocRefresh').onclick = syncCaseList;

        /* ADD CASE — a menu of three ways in, as the analyser has it. */
        const addMenu = $('ocAddMenu');
        $('btnAddCase').onclick = (e) => {
            e.stopPropagation();
            const opening = addMenu.style.display === 'none';
            closeMenu();
            closeToolbarMenus();
            addMenu.style.display = opening ? '' : 'none';
            $('btnAddCase').setAttribute('aria-expanded', opening ? 'true' : 'false');
        };
        addMenu.onclick = (e) => e.stopPropagation();
        $('ocAddFromSf').onclick = () => { closeToolbarMenus(); addFromSalesforceTab(); };
        $('btnAddByUrl').onclick = () => { closeToolbarMenus(); addByUrl(); };
        $('btnAddList').onclick = () => { closeToolbarMenus(); addListByUrl(); };
        document.addEventListener('click', () => { closeToolbarMenus(); closeMenu(); });
        wireOwnerPicker();

        $('ocSearch').oninput = () => { renderCases(); };
        $('ocSearch').onkeydown = (e) => {
            if (e.key === 'Escape' && $('ocSearch').value) { e.preventDefault(); e.stopPropagation(); $('ocSearch').value = ''; renderCases(); }
        };
        $('ocSort').onchange = () => renderCases();
        for (const chip of document.querySelectorAll('#ocChips .oc-chip')) {
            chip.onclick = () => {
                // Clicking the active chip clears it, like the tier chips above.
                FILTER = (FILTER === chip.dataset.filter) ? 'all' : chip.dataset.filter;
                for (const c of document.querySelectorAll('#ocChips .oc-chip')) c.classList.toggle('active', c.dataset.filter === FILTER);
                renderCases();
            };
        }

        /* THE COG — the Cases tab's settings: the column chooser, which a right-click on the
         * column headings also opens. A toggle, so the control that opened it also closes it. */
        const cog = $('ocColumns');
        const cogMenu = $('ocCogMenu');
        const cols = $('ocColsPanel');
        const openColumns = () => {
            closeToolbarMenus();
            closeMenu();
            cols.style.display = '';
            cog.classList.add('active');
            // Rebuilt on the way in: the JIRA chip can switch a column on behind its back.
            renderQaColumns();
        };
        cog.onclick = (e) => {
            e.stopPropagation();
            const opening = cogMenu.style.display === 'none';
            closeMenu();
            closeToolbarMenus();
            cogMenu.style.display = opening ? '' : 'none';
        };
        cogMenu.onclick = (e) => e.stopPropagation();
        $('ocCogColumns').onclick = (e) => { e.stopPropagation(); openColumns(); };
        $('ocColHead').addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openColumns(); });
        cols.onclick = (e) => e.stopPropagation();
        $('ocColsClose').onclick = () => {
            cols.style.display = 'none';
            cog.classList.remove('active');
        };
        /* RESET PUTS BACK BOTH HALVES — which columns and how wide. They are one layout as
         * far as anybody pressing this is concerned. */
        $('ocColsReset').onclick = async () => {
            COLUMNS = defaultColumns();
            COL_WIDTHS = {};
            applyColWidths();
            await Promise.all([saveColumns(), saveWidths()]);
            renderQaColumns();
            renderCases();
            toast('Rows are back to the columns and widths this tool ships with.', 's');
        };

        /* SELECT, SELECT ALL, THE BIN, CANCEL — the analyser's bar. */
        $('ocSelect').onclick = () => setSelecting(true);
        $('ocSelCancel').onclick = () => setSelecting(false);
        $('ocSelectAll').onclick = () => {
            if (RUN.active) return;
            for (const r of visibleCases()) SELECTED.add(keyOf(r));
            renderCases();
        };
        $('ocSelDelete').onclick = () => removeCases(selectedRecords());
        /* Esc stops selecting; Ctrl+A selects every case on screen — on the Cases tab, and
         * never while something is being typed or a question is open. */
        document.addEventListener('keydown', (e) => {
            if (VIEW !== 'cases' || document.querySelector('.qa-modal-back') || copilotSetupOpen()) return;
            if (e.key === 'Escape' && ownerMenuOpen()) { e.preventDefault(); closeOwnerMenu(); return; }
            const t = e.target;
            const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
            if (e.key === 'Escape' && SELECTING && !typing) { e.preventDefault(); setSelecting(false); return; }
            if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !typing && CASES.cases.length && !RUN.active) {
                e.preventDefault();
                SELECTING = true;
                for (const r of visibleCases()) SELECTED.add(keyOf(r));
                renderCases();
            }
        });
        wireTopFold();

        const needTicks = () => {
            if (SELECTED.size) return false;
            setSelecting(true);
            toast('Click the cases to QA — then press QA again.', 'i', 6000);
            return true;
        };
        $('btnRunQa').onclick = () => { if (!needTicks()) startRun('qa'); };
        $('btnRun306090').onclick = async () => {
            if (needTicks()) return;
            /* THE 30/60/90 IS FOR AGING CASES, and saying so before the run rather than
             * after is the difference between a warning and an apology: a milestone analysis
             * of a four-day-old case is a page of "not applicable" that cost a Copilot round
             * trip and two minutes of somebody's laptop. */
            const recs = selectedRecords();
            const young = recs.filter(r => milestoneOf(r) === null);
            if (young.length) {
                const ok = await confirmAsk('Some of these are not at a milestone yet',
                    `${young.length} of the ${recs.length} ticked case(s) are under 30 days old, so there is no 30/60/90 review due on them. Run it on all of them anyway?`,
                    'Run on all');
                if (!ok) return;
            }
            startRun('306090');
        };
        $('btnStopRun').onclick = () => {
            RUN.stop = true;
            setRunNote('Stopping after the case being read now…');
            toast('Stopping — the case being read now will finish first.', 'i');
        };

        $('revSearch').oninput = renderReviews;
        $('revFilter').onchange = renderReviews;
        $('revSort').onchange = renderReviews;
        $('revExpand').onclick = () => setAllRevFolders(true);
        $('revCollapse').onclick = () => setAllRevFolders(false);
        $('btnDeleteReviews').onclick = async () => {
            if (RUN.active) { toast('Wait for the run to finish — it is writing into this list.', 'w'); return; }
            let ids = [];
            try { ids = JSON.parse($('btnDeleteReviews').dataset.ids || '[]'); } catch (e) { ids = []; }
            if (!ids.length) { toast('Nothing to delete.', 'i'); return; }
            const all = ids.length === REVIEWS.length;

            /* WHAT ELSE GOES, SAID BEFORE IT GOES. A coaching row is built out of an agent's
             * reviews and cites them by number, so a row left standing after its reviews are
             * deleted is a document quoting evidence that no longer exists. The chats and the
             * stored case material are the reviewer's own work and a cache of an expensive
             * read — they are NOT taken here. The ⋮ menu is where everything goes at once. */
            const coachGoing = all ? COACHING.length : 0;
            const ok = await confirmAsk(
                all ? `Delete all ${REVIEWS.length} review${REVIEWS.length === 1 ? '' : 's'}?`
                    : `Delete these ${ids.length} review${ids.length === 1 ? '' : 's'}?`,
                (all
                    ? `Every review in this list goes${coachGoing ? `, along with ${coachGoing} coaching row${coachGoing === 1 ? '' : 's'} built out of them` : ''}. `
                    : `The other ${REVIEWS.length - ids.length} review(s) this filter is hiding are kept. `)
                + 'Case conversations and the stored case material are kept, so a case can still be '
                + 'discussed and re-reviewed without reading it again. The cases in Salesforce are '
                + 'untouched. This cannot be undone.',
                all ? 'Delete them all' : `Delete these ${ids.length}`);
            if (!ok) return;

            REVIEWS = REVIEWS.filter(r => !ids.includes(r.id));
            const patch = { [K.reviews]: REVIEWS };
            if (all) { COACHING = []; patch[K.coaching] = COACHING; }
            await store(patch);
            // The queue rows carry a review's score in their QA column, so they are repainted
            // too — a row still showing "58" for a review that has just been deleted is the
            // panel remembering something it has thrown away.
            renderAll();
            // The toast is the whole confirmation. NOT the run log: that is a record of what a
            // run opened and what came back, and making it appear on the Reviews tab because
            // somebody pressed Delete would be a log of something that never ran.
            toast(`${ids.length} review${ids.length === 1 ? '' : 's'} deleted${all && coachGoing ? ', coaching sheet cleared' : ''}.`, 's');
        };

        $('btnRetryFailed').onclick = () => {
            const bad = REVIEWS.filter(incomplete);
            if (!bad.length) { toast('Nothing incomplete to re-run.', 'i'); return; }
            rerunReviews(bad);
        };

        // --- the per-case chat ---
        $('btnChatSwitch').onclick = () => { CHAT_KEY = ''; renderChat(); };
        $('btnChatOpenSf').onclick = () => {
            const chat = CHAT_KEY && CHATS[CHAT_KEY];
            if (chat && chat.url) window.QaReader.createTab({ url: chat.url, active: true }, () => {});
        };
        $('btnChatClear').onclick = async () => {
            if (!CHAT_KEY) return;
            const chat = chatFor(CHAT_KEY);
            if (!chat.msgs.length) return;
            const ok = await confirmAsk('Clear this conversation?',
                `The ${chat.msgs.length} message(s) about ${chat.caseNum || 'this case'} are deleted. The review and the case material are kept.`,
                'Clear it');
            if (!ok) return;
            chat.msgs = [];
            await store({ [K.chats]: CHATS });
            renderChat();
        };
        $('btnChatSend').onclick = () => sendChat($('chatInput').value);
        $('btnChatStop').onclick = () => {
            if (CHAT_ABORT) { try { CHAT_ABORT.abort(); } catch (e) {} }
        };
        /* ENTER SENDS, SHIFT+ENTER BREAKS THE LINE — which is what every chat box does, and
         * so the one thing a reviewer will do without thinking. The composer is two rows
         * high on purpose: a one-line box invites one-line questions, and the useful ones
         * here are longer than that. */
        $('chatInput').onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChat($('chatInput').value);
            }
        };

        $('sheetMonth').oninput = async () => {
            SHEET_MONTH = $('sheetMonth').value;
            await store({ [K.month]: SHEET_MONTH });
        };
        $('btnSheetCopy').onclick = () => {
            const rows = sheetRows();
            if (!rows.length) { toast('Nothing to copy yet.', 'w'); return; }
            copyText(`${SHEET_MONTH}\n` + toTsv(SHEET_COLUMNS, rows), `${rows.length} row(s) copied — paste into the sheet.`);
        };
        $('btnSheetCsv').onclick = () => {
            const rows = sheetRows();
            if (!rows.length) { toast('Nothing to export yet.', 'w'); return; }
            download(`QA sheet ${stamp()}.csv`, E.toCsv(SHEET_COLUMNS, rows));
        };

        $('btnBuildCoaching').onclick = buildCoaching;
        $('btnCoachCopy').onclick = () => {
            const rows = coachRows();
            if (!rows.length) { toast('Nothing to copy yet.', 'w'); return; }
            copyText(toTsv(COACH_COLUMNS, rows), `${rows.length} coaching row(s) copied.`);
        };
        $('btnCoachCsv').onclick = () => {
            const rows = coachRows();
            if (!rows.length) { toast('Nothing to export yet.', 'w'); return; }
            download(`QA coaching ${stamp()}.csv`, E.toCsv(COACH_COLUMNS, rows));
        };

        $('setDeident').onchange = async () => {
            RULES.deident = !!$('setDeident').checked;
            await store({ [K.rules]: RULES });
            toast(RULES.deident
                ? 'Cases will be sent with the names removed and named again in the answer.'
                : 'Cases will be sent with real names in them. Copilot usually refuses to review those.',
                RULES.deident ? 's' : 'w', 8000);
            renderChat();
        };
        $('btnSaveSettings').onclick = saveSettings;
        $('btnResetSettings').onclick = async () => {
            const ok = await confirmAsk('Reset the settings?', 'The thresholds and the team list go back to what this tool shipped with. Reviews are kept.', 'Reset');
            if (!ok) return;
            RULES = Object.assign({ workers: 2 }, E.DEFAULT_RULES);
            ROSTER = DEFAULT_ROSTER.slice();
            await store({ [K.rules]: RULES, [K.roster]: ROSTER });
            fillSettings();
            renderAll();
            toast('Settings reset.', 's');
        };

        $('btnBackupNow').onclick = () => {
            if (!window.QaBackup) { toast('backup.js did not load — check it sits next to qa-panel.js.', 'e', 9000); return; }
            window.QaBackup.backup();
        };
        $('btnRestore').onclick = () => {
            if (!window.QaBackup) { toast('backup.js did not load — check it sits next to qa-panel.js.', 'e', 9000); return; }
            const file = $('restoreFile');
            file.value = '';                    // so picking the same file twice still fires
            file.click();
        };
        $('restoreFile').onchange = async () => {
            const file = $('restoreFile');
            const picked = file.files && file.files[0];
            file.value = '';
            if (!picked) return;
            const ok = await confirmAsk('Restore from this backup?',
                `${picked.name} — its reviews, chats and settings replace the ones stored now; anything the file does not hold is kept. The panel reloads afterwards.`,
                'Restore');
            if (!ok) return;
            if (await window.QaBackup.restore(picked)) setTimeout(() => location.reload(), 1200);
        };

        $('btnGrantAi').onclick = async () => {
            if (!window.SotiAI) { toast('ai-provider.js did not load.', 'e'); return; }
            // Chrome only grants optional host permissions from inside a user gesture, and
            // this click is one. Asking at the first review instead would surface a
            // permission prompt in the middle of a run, or fail silently because the
            // gesture had expired.
            const ok = await window.SotiAI.ensurePermissions();
            refreshAiStatus();
            if (!ok) {
                toast('Chrome did not grant access to Copilot. If no prompt appeared, reload the extension at chrome://extensions so it picks up the updated manifest.', 'e', 14000);
                return;
            }
            // GRANTED → TESTED, with nothing else to press — the analyser's order of things.
            toast('✓ Access granted to Copilot — testing the connection…', 's', 5000);
            $('btnTestAi').click();
        };
        $('btnTestAi').onclick = async () => {
            const btn = $('btnTestAi');
            const was = 'Test the relay';
            btn.disabled = true;
            btn.textContent = 'Testing…';
            const r = await runRelayTest((step) => { btn.textContent = step.replace(/ — .*$/, '…'); });
            btn.disabled = false;
            btn.textContent = was;
            if (r.ok) toast(`✓ The relay works. ${r.host} replied: "${r.said.slice(0, 60)}"`, 's', 8000);
            else toast('Relay test failed: ' + r.error, 'e', 15000);
        };
        $('cpsGrant').onclick = () => grantFromCopilotSetup();
        $('cpsLater').onclick = () => {
            const done = $('cpsLater').textContent === 'Done';
            const signin = /sign in|Test/i.test($('cpsGrant').textContent);
            CPS_THEN = null;
            closeCopilotSetup();
            if (!done) {
                toast(signin
                    ? 'Sign in to Copilot at m365.cloud.microsoft in a normal tab, then re-run — ⋮ → Settings → The AI → Test the relay checks it.'
                    : 'You can grant Copilot access any time: ⋮ → Settings → The AI → Grant access to Copilot.', 'i', 8000);
            }
        };
        $('mCopilotSetup').addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !$('cpsLater').disabled) { e.preventDefault(); $('cpsLater').click(); }
        });
        $('btnTestUpload').onclick = testUpload;
    }

    /* THE TOP OF THE CASES TAB FOLDS AWAY WHEN THE LIST IS SCROLLED DOWN — the analyser's
     * behaviour, and its reasoning: everything in #ocTop is for FINDING a case, and once you
     * are scrolling through the list those rows were a third of the panel spent on controls.
     * Direction, not position: a scroll down past the first rows folds it, any scroll up
     * brings it back, and at the very top it is always shown. Never while a menu hangs off it,
     * and a key pressed in the folded filter box opens it again first. */
    function wireTopFold() {
        const list = $('ocList');
        const top = $('ocTop');
        if (!list || !top) return;
        let last = 0;
        let quietUntil = 0;
        const busy = () => {
            const menu = $('ocAddMenu');
            return (menu && menu.style.display !== 'none') || ownerMenuOpen() || !!$('qaMenu');
        };
        const setFolded = (fold) => {
            if (fold === top.classList.contains('oc-top-hidden')) return;
            top.style.setProperty('--oc-top-h', top.scrollHeight + 'px');
            top.classList.add('oc-top-anim');
            void top.offsetHeight;             // commit the pinned height before it changes
            top.classList.toggle('oc-top-hidden', fold);
            // Folding makes the list taller, which moves scrollTop by itself — not a scroll.
            quietUntil = Date.now() + 320;
        };
        top.addEventListener('transitionend', (e) => {
            if (e.propertyName !== 'max-height') return;
            top.classList.remove('oc-top-anim');
            if (!top.classList.contains('oc-top-hidden')) top.style.removeProperty('--oc-top-h');
        });
        list.addEventListener('scroll', () => {
            const y = list.scrollTop;
            const dy = y - last;
            last = y;
            if (y <= 4) { setFolded(false); return; }
            if (Date.now() < quietUntil) return;
            if (dy > 6 && y > 40 && !busy()) setFolded(true);
            else if (dy < -6) setFolded(false);
        }, { passive: true });
        const unfold = () => { if (top.classList.contains('oc-top-hidden')) setFolded(false); };
        top.addEventListener('keydown', unfold, true);
        top.addEventListener('focusin', unfold);
    }

    /* ---------------------------------------------------------------------
     * DOES THE UPLOAD ACTUALLY WORK ON THIS MACHINE?
     * ---------------------------------------------------------------------
     * "Test the relay" proves a message can be typed and an answer read back.
     * It proves nothing at all about the path everything now depends on — that
     * a FILE reaches the site, that the site reads it, and that what it reads is
     * the whole file rather than its first page. Those fail differently and they
     * fail quietly: a missing upload control makes the relay fall back to typing
     * the case as text, and a partially-read file makes the model answer about
     * the half it saw. Both come back looking like a working tool.
     *
     * So this sends a case that is nothing BUT a check. Three markers, planted at
     * the start, the middle and the end of a payload big enough to force the
     * upload, and one instruction: read all three back. Getting the last one
     * proves the file was read to its end, which is the claim that matters and
     * the one a smaller test cannot make.
     *
     * It is a real request through the real path — same builder, same relay, same
     * attachment — so a pass here is evidence about reviews rather than about a
     * test harness.
     * ------------------------------------------------------------------- */
    async function testUpload() {
        const btn = $('btnTestUpload');
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('Grant access to Copilot first — there is no relay to upload to yet.', 'w', 8000);
            return;
        }
        const was = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Uploading…';

        // Distinctive enough that it cannot be guessed, and cannot be matched by accident
        // against the instructions: a model that invents an answer here has to invent these.
        const tag = () => 'QA-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const marks = [tag(), tag(), tag()];
        /* Padding that looks like what this tool really sends — dated, sided, delimited feed
         * posts — rather than a repeated character. A site that treats an upload differently
         * by shape would pass a lorem-ipsum test and fail a case. Sized past attachMinChars
         * with room to spare, so the provider chooses the file path for the same reason it
         * would on a real case. */
        const filler = (n) => Array.from({ length: n }, (_, k) =>
            `[12 March 2026, 09:${String(k % 60).padStart(2, '0')}] [EMAIL] [CUSTOMER] Customer 1:\n`
            + `Enrolment still fails after the certificate was replaced. Reference line ${k + 1}.`).join('\n\n');

        const material = `[CASE FACTS]\nCase number: UPLOAD-SELF-TEST\nSubject: does the attachment path work\n\n`
            + `[CASE TRANSCRIPT — OLDEST FIRST]\nMARKER ONE IS ${marks[0]}\n\n${filler(300)}\n\n`
            + `MARKER TWO IS ${marks[1]}\n\n${filler(300)}\n\nMARKER THREE IS ${marks[2]}\n`;

        const prompt = E.splitPrompt(
            'You are checking that a file transfer worked. The case material for this request is either attached to '
            + 'this message as a file or written out below. Somewhere in it are three lines reading "MARKER ONE IS …", '
            + '"MARKER TWO IS …" and "MARKER THREE IS …".\n\n'
            + 'RULES:\n'
            + '- Reply with exactly three lines and nothing else: the three marker codes, one per line, in order.\n'
            + '- Copy each code exactly as it is written. Do not guess one, and do not invent one.\n'
            + '- If you cannot find a marker, write MISSING on its line instead.',
            material,
            'Read the three marker codes out of the case material and reply with them, one per line, and nothing else.');

        try {
            const out = {};
            const said = await askAi(prompt, 'QA Tool upload test', out);
            const how = out.delivery;
            const WHERE = ['start', 'middle', 'end'];
            const found = marks.map(m => said.includes(m));
            const got = found.filter(Boolean).length;
            const missing = WHERE.filter((_, i) => !found[i]);

            if (how && how.mode !== 'file') {
                toast(`The case did NOT go as a file — ${deliveryLine(how)}. Reviews will still be written, `
                    + 'but large cases will be trimmed to fit the chat box.', 'e', 16000);
            } else if (got === 3) {
                toast(`✓ Upload works end to end. All three markers came back out of ${(how && how.file) || 'the attached file'} `
                    + `(${((how && how.chars) || 0).toLocaleString()} characters), including the one at the very end.`, 's', 12000);
            } else if (got) {
                /* NAME THE MARKER THAT WENT MISSING, because which one it was is the finding.
                 * A missing END marker means the file arrived and was read only part-way,
                 * which is the failure that would silently halve a long case; a missing
                 * MIDDLE one means something stranger and is worth reporting as such. */
                toast(`The file was attached, but the marker at the ${missing.join(' and the ')} did not come back. `
                    + (missing.indexOf('end') >= 0
                        ? 'That means the file reached the site but was not read to its end — long cases will lose their newest messages.'
                        : 'The upload works; treat long cases with caution until this is understood.'), 'w', 18000);
            } else {
                toast('The file was attached but none of the three markers came back. Copilot answered: "'
                    + said.trim().replace(/\s+/g, ' ').slice(0, 120) + '"', 'e', 16000);
            }
            logLine(`Upload self-test: ${got}/3 markers returned`
                + (missing.length ? ` (missing at the ${missing.join(', ')})` : '')
                + ` — ${deliveryLine(how) || 'delivery not recorded'}`,
                got === 3 && how && how.mode === 'file' ? 'ok' : 'warn');
        } catch (e) {
            toast('Upload test failed: ' + ((e && e.message) || e), 'e', 16000);
        } finally {
            btn.disabled = false;
            btn.textContent = was;
            refreshAiStatus();
        }
    }

    function coachRows() {
        const agents = agentsWithReviews().filter(a => a.reviews.length);
        return agents.map(a => {
            const written = COACHING.find(c => c.agent.toLowerCase() === a.name.toLowerCase());
            const row = {};
            for (const col of COACH_COLUMNS) row[col] = (written && written.fields && written.fields[col]) || '';
            row['Agent'] = a.name;
            return row;
        });
    }

    // Everything, in one file, so a month's QA can be handed over as one attachment.
    function exportEverything() {
        const sheet = sheetRows();
        const coach = coachRows();
        if (!sheet.length && !coach.length) { toast('Nothing to export yet.', 'w'); return; }
        const parts = [];
        if (sheet.length) parts.push(`QA SHEET — ${SHEET_MONTH}\r\n` + E.toCsv(SHEET_COLUMNS, sheet).replace(/^﻿/, ''));
        if (coach.length) parts.push(`COACHING SUMMARY — ${SHEET_MONTH}\r\n` + E.toCsv(COACH_COLUMNS, coach).replace(/^﻿/, ''));
        download(`QA export ${stamp()}.csv`, '﻿' + parts.join('\r\n\r\n'));
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
