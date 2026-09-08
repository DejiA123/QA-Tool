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
        month: 'qa_sheet_month',
        // The per-case chats, and the material they stand on. Separate keys because they
        // have different lifetimes: a chat is the reviewer's own work and is only ever
        // deleted deliberately, while a context is a cache of a scrape and is pruned.
        chats: 'qa_chats',
        context: 'qa_context'
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
    let SHEET_MONTH = '';
    let SELECTED = new Set();
    let VIEW = 'cases';
    let FILTER = 'all';

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

    // How much of a case transcript is kept for the chat to stand on. Enough for a long
    // case; small enough that a hundred reviewed cases is tens of megabytes rather than
    // hundreds. Whatever is dropped is declared inside the transcript itself.
    const CONTEXT_MAX_CHARS = 60000;
    // How many cases keep a stored transcript. The oldest fall off; their chats survive and
    // say so, and the case can be re-read from the chat screen in one press.
    const CONTEXT_KEEP = 80;
    // How many turns of a conversation travel with each new question. The material is the
    // expensive part of the prompt and it goes every time regardless, so this only bounds
    // the history — and a chat that has run past twenty turns has stopped being about one
    // question anyway.
    const CHAT_HISTORY_TURNS = 12;
    // Per-case run state, keyed the same way SELECTED is. Never persisted: a run
    // does not survive the panel closing, and a row still saying "reading…" after
    // a reload would be a lie the panel had no way to correct.
    const ROW_STATE = new Map();

    const RUN = { active: false, stop: false, total: 0, done: 0, failed: 0, kind: 'qa', note: '' };

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
    /* SHARED WITH update.js, which is a separate file and has no way into this closure.
     * Exposed rather than duplicated: two toast implementations means two places to fix when
     * the timer or the class names change, and the second one is always the one that gets
     * missed. update.js falls back to console.log if this is missing, so load order between
     * the two files does not matter. */
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
            if (input) input.focus(); else box.querySelector('.qa-modal-ok').focus();
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
    async function askAi(prompt, label) {
        if (!window.SotiAI) {
            throw new Error('ai-provider.js did not load, so there is nothing to send this to. Check it sits next to qa-panel.js and reload the extension at chrome://extensions.');
        }
        if (label) window.SotiAI.setConversationLabel(label);
        const res = await window.SotiAI.chat({
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            // Low, not zero. A QA write-up is prose and needs to read like it; the facts
            // it is allowed to use are pinned by the prompt rather than by the temperature.
            options: { temperature: 0.2 }
        }, {});
        if (!res || !res.ok) {
            const why = res ? await res.text() : 'no answer';
            throw new Error(String(why).slice(0, 400));
        }
        const data = await res.json();
        const text = (data && data.message && data.message.content) || '';
        if (!text.trim()) throw new Error('The relay came back with an empty answer.');
        return text;
    }

    /* ---------------------------------------------------------------------
     * BOOT
     * ------------------------------------------------------------------- */
    async function boot() {
        const got = await load([K.cases, K.reviews, K.coaching, K.rules, K.roster, K.lastList,
                                K.month, K.chats, K.context]);
        if (got[K.cases] && Array.isArray(got[K.cases].cases)) CASES = got[K.cases];
        if (Array.isArray(got[K.reviews])) REVIEWS = got[K.reviews];
        if (Array.isArray(got[K.coaching])) COACHING = got[K.coaching];
        if (got[K.rules]) RULES = Object.assign(RULES, got[K.rules]);
        if (Array.isArray(got[K.roster]) && got[K.roster].length) ROSTER = got[K.roster];
        if (got[K.lastList]) LAST_LIST = got[K.lastList];
        SHEET_MONTH = got[K.month] || defaultMonth();
        if (got[K.chats] && typeof got[K.chats] === 'object') CHATS = got[K.chats];
        if (got[K.context] && typeof got[K.context] === 'object') CONTEXT = got[K.context];

        if (window.SotiAI) { try { await window.SotiAI.load(); } catch (e) { /* defaults */ } }

        applyVersion();
        wire();
        fillSettings();
        renderAll();
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
        /* RE-READ ON EVERY VISIT, not once at boot.
         *
         * update.js loads its remembered check asynchronously and runs its own check six
         * seconds after start-up, both of which finish long after fillSettings() has run —
         * so a status painted at boot says "never checked" for the rest of the session on a
         * panel that checked a minute ago. Settings is opened rarely enough that repainting
         * two lines on each visit costs nothing. */
        if (name === 'settings') fillUpdateStatus();
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
        const r = $('tabReviewsCount');
        if (r) r.textContent = REVIEWS.length ? String(REVIEWS.length) : '';
        const ch = $('tabChatCount');
        if (ch) {
            const live = Object.values(CHATS).filter(c => c && c.msgs && c.msgs.length).length;
            ch.textContent = live ? String(live) : '';
        }
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

    function visibleCases() {
        const q = ($('ocSearch').value || '').trim().toLowerCase();
        const owner = ($('ocOwner').value || '').trim().toLowerCase();
        const sort = $('ocSort').value || 'age-desc';

        let list = CASES.cases.slice();

        if (owner) {
            list = list.filter(c => {
                const who = String(c.owner || c.lastModifiedBy || '').toLowerCase();
                return who === owner;
            });
        }
        if (q) {
            list = list.filter(c => [c.caseNum, c.subject, c.account, c.owner, c.lastModifiedBy, c.status, c.jira]
                .some(v => String(v || '').toLowerCase().includes(q)));
        }
        if (FILTER !== 'all') {
            list = list.filter(c => {
                const ms = milestoneOf(c);
                if (FILTER === 'milestone') return ms !== null;
                if (FILTER === 'unreviewed') return !qaReviewFor(c);
                if (FILTER === 'reviewed') return !!qaReviewFor(c);
                return String(ms) === FILTER;
            });
        }

        const age = (c) => {
            const n = E.ageDaysOf(c.ageDays);
            return n === null ? -1 : n;
        };
        list.sort((a, b) => {
            if (sort === 'age-asc') return age(a) - age(b);
            if (sort === 'case') return String(a.caseNum || '').localeCompare(String(b.caseNum || ''));
            if (sort === 'owner') return String(a.owner || a.lastModifiedBy || '').localeCompare(String(b.owner || b.lastModifiedBy || ''));
            if (sort === 'score') {
                const s = (c) => {
                    const r = qaReviewFor(c);
                    return r && r.score && r.score.value !== null ? r.score.value : 1000;
                };
                return s(a) - s(b);
            }
            return age(b) - age(a);            // oldest first — the default a QA queue wants
        });
        return list;
    }

    function renderCases() {
        const list = $('ocList');
        if (!list) return;
        list.textContent = '';

        const shown = visibleCases();
        const meta = $('ocMeta');
        if (meta) {
            const when = CASES.scrapedAt ? `, read ${E.fmtDateTime(CASES.scrapedAt)}` : '';
            const name = CASES.listName ? `${CASES.listName} — ` : '';
            meta.textContent = CASES.cases.length
                ? `${name}${shown.length} of ${CASES.cases.length} case${CASES.cases.length === 1 ? '' : 's'}${when}`
                : '';
        }
        fillOwnerSelect();

        if (!CASES.cases.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-empty';
            hint.innerHTML = 'Nothing to review yet.<br><br>Open a Salesforce case <b>list view</b> — Cases &rarr; whichever queue you QA from — and press <b>Sync case list</b>. '
                + 'After the first sync this tool remembers the list and can go back to it on its own.';
            list.appendChild(hint);
            renderSelection();
            renderCounts();
            return;
        }
        if (!shown.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-empty';
            hint.textContent = 'No case matches this filter.';
            list.appendChild(hint);
            renderSelection();
            return;
        }

        for (const rec of shown) list.appendChild(caseRow(rec));
        renderSelection();
        renderCounts();
    }

    function caseRow(rec) {
        const key = keyOf(rec);
        const row = document.createElement('div');
        row.className = 'oc-row';
        row.dataset.key = key;

        const state = ROW_STATE.get(key);
        if (state) row.classList.add('qa-' + state);

        /* THE TICK BOX, FIRST ON THE ROW.
         *
         * In its own padded box and outside .oc-row-main, which is the half that opens the
         * case in Salesforce. A click a few pixels wide of a checkbox that then navigates
         * away is the most annoying miss an interface has, and putting the box inside the
         * clickable region would produce exactly that. */
        const checkWrap = document.createElement('label');
        checkWrap.className = 'qa-row-check';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'qa-check';
        check.checked = SELECTED.has(key);
        // Set HERE as well as in renderSelection, because a row repainted mid-run (see
        // updateRow) builds a brand-new checkbox that renderSelection's sweep has already
        // been past — so without this the one row that is actually being read is the one
        // row whose tick can still be changed underneath the run.
        check.disabled = RUN.active;
        check.title = 'Include this case in the next QA run';
        check.onclick = (e) => e.stopPropagation();
        check.onchange = () => {
            if (check.checked) SELECTED.add(key); else SELECTED.delete(key);
            renderSelection();
        };
        checkWrap.appendChild(check);
        row.appendChild(checkWrap);

        const main = document.createElement('div');
        main.className = 'oc-row-main';
        main.title = 'Open this case in Salesforce';
        main.onclick = () => openInSalesforce(rec);

        const num = document.createElement('span');
        num.className = 'oc-num';
        num.textContent = rec.caseNum || '(no number)';
        main.appendChild(num);

        const subject = document.createElement('span');
        subject.className = 'oc-subject';
        subject.textContent = rec.subject || '(no subject)';
        subject.title = rec.subject || '';
        main.appendChild(subject);

        // THE 30/60/90 FLAG. Computed from the age, never guessed — see
        // QaEngine.milestoneFor. It is the whole reason the age is on the row.
        const ms = milestoneOf(rec);
        if (ms) {
            const flag = document.createElement('span');
            flag.className = 'qa-ms qa-ms-' + ms;
            flag.textContent = ms + 'd';
            flag.title = `This case is ${Math.round(E.ageDaysOf(rec.ageDays))} days old — it is due its ${ms}-day management review.`;
            main.appendChild(flag);
        }

        const owner = document.createElement('span');
        owner.className = 'qa-owner-cell';
        owner.textContent = rec.owner || rec.lastModifiedBy || '—';
        owner.title = rec.owner ? `Case owner: ${rec.owner}` : rec.lastModifiedBy ? `Last modified by: ${rec.lastModifiedBy}` : 'No owner on the list view';
        main.appendChild(owner);

        const age = document.createElement('span');
        age.className = 'qa-age-cell';
        const ageN = E.ageDaysOf(rec.ageDays);
        age.textContent = ageN === null ? '—' : `${Math.round(ageN)}d`;
        age.title = 'Case age in days';
        main.appendChild(age);

        // ALREADY REVIEWED, and how it went. The band rather than the bare number: a
        // colour and a word are readable running down a list, and "72" alone is not.
        const rev = qaReviewFor(rec);
        if (rev && rev.score && rev.score.value !== null) {
            const score = document.createElement('span');
            score.className = 'qa-score band-' + scoreBand(rev.score);
            score.textContent = `${rev.score.value}`;
            score.title = `QA score ${rev.score.value}/100 — ${rev.score.band}. Reviewed ${E.fmtDateTime(rev.at)}.`;
            main.appendChild(score);
        } else if (rev) {
            const score = document.createElement('span');
            score.className = 'qa-score';
            score.textContent = 'QA’d';
            score.title = `Reviewed ${E.fmtDateTime(rev.at)}, but the write-up carried no score.`;
            main.appendChild(score);
        }

        if (state) {
            const st = document.createElement('span');
            st.className = 'qa-row-state';
            st.textContent = state === 'working' ? 'reading…' : state === 'queued' ? 'queued' : 'failed';
            main.appendChild(st);
        }

        row.appendChild(main);

        /* THE WAY INTO THIS CASE'S CHAT. Outside .oc-row-main, like the tick box, because
         * the row itself opens Salesforce — and "I meant to ask a question and it navigated
         * away" is the same mis-click the tick box is kept out of that region to avoid.
         * A speech bubble rather than the word "Chat": the row is already carrying six
         * things and a seventh word would push the subject off it. */
        const chat = document.createElement('button');
        chat.className = 'qa-row-chat';
        chat.type = 'button';
        const existing = CHATS[key];
        const n = existing && existing.msgs ? existing.msgs.filter(m => m.role === 'user').length : 0;
        chat.title = n
            ? `Chat about this case (${n} question${n === 1 ? '' : 's'} asked so far)`
            : 'Chat about this case';
        chat.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>';
        if (n) chat.classList.add('has-chat');
        chat.onclick = (e) => { e.stopPropagation(); openChat(key); };
        row.appendChild(chat);

        return row;
    }

    function fillOwnerSelect() {
        const sel = $('ocOwner');
        if (!sel) return;
        const chosen = sel.value;
        const names = new Map();
        for (const c of CASES.cases) {
            const who = String(c.owner || c.lastModifiedBy || '').trim();
            if (!who) continue;
            names.set(who.toLowerCase(), who);
        }
        const sorted = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
        sel.textContent = '';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = `All case owners (${sorted.length})`;
        sel.appendChild(all);
        for (const [low, name] of sorted) {
            const count = CASES.cases.filter(c => String(c.owner || c.lastModifiedBy || '').toLowerCase() === low).length;
            const o = document.createElement('option');
            o.value = low;
            o.textContent = `${name} (${count})`;
            sel.appendChild(o);
        }
        if (chosen && names.has(chosen)) sel.value = chosen;
    }

    /* THE COUNT ON THE BUTTON, not beside it. Pressing "QA selected" should never be a
     * guess about what it is going to act on — especially when a filter is narrowing the
     * list, because a tick made under one filter stays ticked under the next. */
    function renderSelection() {
        const shown = visibleCases();
        const shownKeys = shown.map(keyOf);
        const n = SELECTED.size;
        const countEl = $('ocSelCount');
        if (countEl) {
            const hiddenSelected = [...SELECTED].filter(k => !shownKeys.includes(k)).length;
            countEl.textContent = n
                ? `${n} selected${hiddenSelected ? ` (${hiddenSelected} not shown by this filter)` : ''}`
                : '0 selected';
        }
        const all = $('ocSelectAll');
        if (all) {
            const on = shownKeys.filter(k => SELECTED.has(k)).length;
            all.checked = shownKeys.length > 0 && on === shownKeys.length;
            all.indeterminate = on > 0 && on < shownKeys.length;
        }
        const busy = RUN.active;
        const btnQa = $('btnRunQa');
        const btn369 = $('btnRun306090');
        if (btnQa) { btnQa.disabled = !n || busy; btnQa.textContent = n ? `QA ${n} case${n === 1 ? '' : 's'}` : 'QA selected'; }
        if (btn369) btn369.disabled = !n || busy;
        for (const el of document.querySelectorAll('.oc-row .qa-check')) {
            el.disabled = busy;
        }
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
        try { return /\/lightning\/o\/[^/]+\/(list|home)\b/i.test(new URL(url).pathname); }
        catch (e) { return false; }
    }

    // Two list-view addresses are THE SAME LIST when they agree on path and filter.
    // Salesforce rewrites its own query string as the grid is used, so a whole-URL match
    // would fail against the very tab it is looking for.
    function sameList(a, b) {
        if (!a || !b) return false;
        try {
            const x = new URL(a), y = new URL(b);
            if (x.hostname !== y.hostname || x.pathname !== y.pathname) return false;
            return (x.searchParams.get('filterName') || '') === (y.searchParams.get('filterName') || '');
        } catch (e) { return false; }
    }

    function listLabel(url) {
        try {
            const u = new URL(url);
            const f = u.searchParams.get('filterName');
            if (f) return f.replace(/[_-]+/g, ' ').trim();
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
        if (!LAST_LIST && activeOk && sfUrl(active.url)) return { tab: active };
        if (LAST_LIST) {
            const opened = await new Promise((res) => {
                try { window.QaReader.createTab({ url: LAST_LIST.url, active: true }, (t) => res(t || null)); }
                catch (e) { res(null); }
            });
            if (opened && opened.id != null) return { openedTabId: opened.id };
            return { why: `Could not open ${LAST_LIST.name} in a new tab.` };
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

    async function syncCaseList() {
        if (!isExt()) { toast('Syncing needs the Chrome extension.', 'e'); return; }
        const btn = $('btnSyncCaseList');
        const label = $('ocSyncLabel');
        const was = label ? label.textContent : '';
        if (btn) btn.disabled = true;
        if (label) label.textContent = 'Syncing…';
        try {
            const found = await resolveListTab();
            let tab = found.tab;
            if (found.openedTabId != null) {
                toast(`${(LAST_LIST && LAST_LIST.name) || 'The case list'} was not open — opening it and syncing once the grid has loaded…`, 'i', 9000);
                const ok = await waitForGrid(found.openedTabId, Date.now() + 60000);
                if (!ok) { toast('The list view did not finish loading. Press Sync again once it has.', 'w', 9000); return; }
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
                toast('No case rows found. Open a case LIST view (e.g. My Open Cases) and try again.', 'e', 10000);
                return;
            }

            mergeCases(data);
            LAST_LIST = { url: sfUrl(tab.url), name: listLabel(tab.url), at: Date.now() };
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
            if (label) label.textContent = was || 'Sync case list';
        }
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
        CASES = {
            listName: data.listName || CASES.listName || '',
            origin: data.origin || CASES.origin || '',
            scrapedAt: data.scrapedAt || Date.now(),
            cases: data.cases.slice()
        };
        const live = new Set(CASES.cases.map(keyOf));
        for (const k of [...SELECTED]) if (!live.has(k)) SELECTED.delete(k);
    }

    async function addByUrl() {
        const url = await ask({
            title: 'Add a case by its link',
            note: 'Paste the Salesforce address of one case. It is added to the list below and can then be ticked and reviewed like any other.',
            placeholder: 'https://your-org.lightning.force.com/lightning/r/Case/500…/view',
            ok: 'Add case',
            validate: (v) => {
                if (!v) return 'Paste the case link.';
                if (!sfUrl(v)) return 'That is not an https Salesforce address.';
                if (!/\/lightning\/r\/(?:[^/]+\/)?500[A-Za-z0-9]{12,15}\//.test(v) && !/[?&]id=500/i.test(v)) {
                    return 'That link does not point at a case record.';
                }
                return '';
            }
        });
        if (!url) return;
        const clean = sfUrl(url);
        const recordId = (clean.match(/\/(500[A-Za-z0-9]{12,15})\//) || [])[1] || '';
        if (CASES.cases.some(c => c.url === clean || (recordId && c.recordId === recordId))) {
            toast('That case is already in the list.', 'w');
            return;
        }
        /* ADDED BLANK, and honestly so: a link carries a record id and nothing else, so the
         * row has no subject, no owner and no age until it is read. Everything on it fills in
         * from the case itself the first time it is reviewed — see applyReadToRecord. */
        CASES.cases.push({ recordId, url: clean, caseNum: '', subject: '(not read yet)', owner: '', ageDays: '', status: '' });
        if (!CASES.origin) { try { CASES.origin = new URL(clean).origin; } catch (e) {} }
        await store({ [K.cases]: CASES });
        renderCases();
        toast('Case added. Tick it and press QA to read it in.', 's');
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
        if (!rec.url && data.caseUrl) set('url', data.caseUrl);
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
    async function startRun(kind) {
        if (RUN.active) { toast('A run is already going — wait for it or press Stop.', 'w'); return; }
        const recs = selectedRecords();
        if (!recs.length) { toast('Tick some cases first.', 'w'); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open Settings and press Grant site access.', 'e', 10000);
            switchView('settings');
            return;
        }

        RUN.active = true;
        RUN.stop = false;
        RUN.kind = kind;
        RUN.total = recs.length;
        RUN.done = 0;
        RUN.failed = 0;

        for (const r of recs) ROW_STATE.set(keyOf(r), 'queued');
        renderCases();
        renderSelection();
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

                let read;
                try {
                    read = await window.QaReader.readCase(urlOf(rec));
                } catch (e) {
                    read = { ok: false, error: (e && e.message) || String(e) };
                }

                if (!read.ok) {
                    ROW_STATE.set(key, 'failed');
                    updateRow(key);
                    RUN.failed++;
                    RUN.done++;
                    logLine(`${rec.caseNum || key}: ${read.error}`, 'fail');
                    await saveReview(failedReview(rec, kind, read.error));
                    setRunNote(`${RUN.done}/${RUN.total} done, ${RUN.failed} failed`);
                    continue;
                }

                applyReadToRecord(rec, read.data);
                migrateKey(key, keyOf(rec));
                const metrics = E.measureCase(read.data, RULES);
                /* KEEP WHAT THE CASE SAID, not just what the review concluded.
                 *
                 * The read is the expensive part — a page load and a scroll to the end of a
                 * feed — and the review that comes out of it is a summary. Every question a
                 * reviewer asks afterwards ("show me where", "quote the chase") is a
                 * question about the material, so the material is kept and the per-case chat
                 * stands on it. Without this, opening a chat would mean reading the case
                 * again, days later, on a record that has since moved on. */
                await saveContext(rec, read.data, metrics);
                logLine(`${read.data.caseNumber || rec.caseNum || key}: read ${metrics.itemsSeen} post(s), ${metrics.itemsDated} dated. ${describeMeasure(metrics)}`,
                    metrics.readable ? 'ok' : 'warn');

                /* The AI half, one at a time — see the header above.
                 *
                 * A case whose write-up did not come back COUNTS AS A FAILURE, even though it
                 * was read and measured successfully and its findings are saved. The tally at
                 * the end of a run is what a reviewer decides whether to re-run on, and
                 * counting a review with no review in it as "reviewed" would hide exactly the
                 * cases that need going back to. */
                const wrote = await (aiChain = aiChain.then(() => writeUp(rec, read.data, metrics, kind)).catch((e) => {
                    logLine(`${rec.caseNum || key}: the write-up failed — ${(e && e.message) || e}`, 'fail');
                    return false;
                }));
                if (!wrote) RUN.failed++;

                ROW_STATE.delete(keyOf(rec));
                updateRow(keyOf(rec));
                RUN.done++;
                setRunNote(`${RUN.done}/${RUN.total} done${RUN.failed ? `, ${RUN.failed} failed` : ''}`);
            }
        };

        const workers = Math.max(1, Math.min(4, Number(RULES.workers) || 2));
        try {
            await Promise.all(Array.from({ length: Math.min(workers, recs.length) }, worker));
        } finally {
            // Whatever happened, nothing is left saying "reading…" — a row stuck in that
            // state after a run is the panel lying about work that is not happening.
            for (const r of recs) if (ROW_STATE.get(keyOf(r)) === 'working' || ROW_STATE.get(keyOf(r)) === 'queued') ROW_STATE.delete(keyOf(r));
            RUN.active = false;
            await store({ [K.cases]: CASES });
            renderAll();
            showRunPill(false);
            const stopped = RUN.stop ? ' (stopped early)' : '';
            logLine(`Run finished: ${RUN.done - RUN.failed} reviewed, ${RUN.failed} failed${stopped}.`, RUN.failed ? 'warn' : 'ok');
            toast(`Run finished — ${RUN.done - RUN.failed} reviewed${RUN.failed ? `, ${RUN.failed} failed` : ''}${stopped}`, RUN.failed ? 'w' : 's', 8000);
        }
    }

    // One line of the run log, from the measured half, so the log says something about the
    // case rather than only that it was read.
    function describeMeasure(m) {
        const bits = [];
        if (m.frtMet === true) bits.push('first response met');
        else if (m.frtMet === false) bits.push('FIRST RESPONSE MISSED');
        if (m.gaps.length) bits.push(`${m.gaps.length} gap(s)`);
        if (m.meetingsUndocumented) bits.push(`${m.meetingsUndocumented} meeting(s) not written up`);
        if (m.openWaitMs !== null) bits.push('waiting on us');
        return bits.length ? bits.join(', ') + '.' : 'nothing flagged.';
    }

    async function writeUp(rec, data, metrics, kind) {
        const caseNo = data.caseNumber || rec.caseNum || keyOf(rec);
        setRunNote(`Writing up ${caseNo}…`);
        const prompt = kind === '306090'
            ? E.build306090Prompt(rec, data, metrics, RULES)
            : E.buildQaPrompt(rec, data, metrics, RULES);

        let text = '';
        let error = '';
        try {
            text = await askAi(prompt, caseNo);
        } catch (e) {
            error = (e && e.message) || String(e);
        }

        /* A FAILED WRITE-UP STILL SAVES THE MEASUREMENT.
         *
         * The expensive half of a review is opening the case and reading its feed to the end;
         * the relay failing afterwards must not throw that away and make the reviewer do it
         * again. The record is saved with its findings and its error, the card says the
         * write-up is missing, and re-running that one case is a tick and a button. */
        // The 30/60/90 is read as a whole document, not as sheet columns — it has its own
        // template and no row on the QA sheet — so only a QA review is parsed into fields.
        const parsed = kind === 'qa' ? E.parseQaAnswer(text) : null;

        const review = {
            id: `${keyOf(rec)}|${kind}`,
            key: keyOf(rec),
            kind,
            at: Date.now(),
            caseNum: caseNo,
            subject: data.subject || rec.subject || '',
            account: data.accountName || rec.account || '',
            status: data.caseStatus || rec.status || '',
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
        await saveReview(review);
        const said = error ? 'write-up FAILED — ' + error
            : kind === '306090' ? '30/60/90 written'
            : review.score && review.score.value !== null ? `reviewed — ${review.score.value}/100 (${review.score.band})`
            : 'reviewed, but the write-up carried no score';
        logLine(`${caseNo}: ${said}`, error ? 'fail' : 'ok');
        return !error;
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
        if (on) {
            pill.style.display = '';
            pill.classList.remove('done', 'failed');
            return;
        }
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
            metrics: slimMetrics(metrics)
        };
        const keys = Object.keys(CONTEXT).sort((a, b) => (CONTEXT[b].at || 0) - (CONTEXT[a].at || 0));
        for (const gone of keys.slice(CONTEXT_KEEP)) delete CONTEXT[gone];
        await store({ [K.context]: CONTEXT });
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
        const add = (key, obj, at) => {
            if (!key) return;
            const prev = seen.get(key);
            if (!prev || (at || 0) > (prev.at || 0)) seen.set(key, Object.assign({ key, at: at || 0 }, obj));
        };
        for (const c of CASES.cases) {
            add(keyOf(c), { caseNum: c.caseNum, subject: c.subject, agent: c.owner || c.lastModifiedBy, inQueue: true }, 0);
        }
        for (const r of REVIEWS) {
            if (r.kind !== 'qa') continue;
            add(r.key, { caseNum: r.caseNum, subject: r.subject, agent: r.agent, reviewed: true }, r.at);
        }
        for (const c of Object.values(CONTEXT)) {
            const hit = seen.get(c.key) || {};
            add(c.key, Object.assign({}, hit, { caseNum: c.caseNum, subject: c.subject, agent: c.agent, grounded: true }), c.at);
        }
        for (const c of Object.values(CHATS)) {
            if (!c.msgs || !c.msgs.length) continue;
            const hit = seen.get(c.key) || {};
            const last = c.msgs[c.msgs.length - 1];
            add(c.key, Object.assign({}, hit, { caseNum: c.caseNum, subject: c.subject, agent: c.agent, chatted: c.msgs.length }), last.at);
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
        if (rev && !rev.error) bits.push(`and its QA review${rev.score && rev.score.value !== null ? ` (${rev.score.value}/100)` : ''}`);
        el.appendChild(document.createTextNode(bits.join(' ') + '. '));
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

    async function sendChat(question) {
        const text = String(question || '').trim();
        if (!text || CHAT_BUSY || !CHAT_KEY) return;
        const ctx = CONTEXT[CHAT_KEY];
        if (!ctx) { toast('Read the case first — there is nothing to ground an answer in.', 'w', 8000); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open Settings and press Grant site access.', 'e', 9000);
            switchView('settings');
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
        const messages = [{ role: 'system', content: E.buildChatSystem(ctx, rev) }];
        const history = chat.msgs.slice(0, -1).slice(-CHAT_HISTORY_TURNS * 2);
        for (const m of history) {
            if (!m.content) continue;
            messages.push({ role: m.role, content: m.content });
        }

        const msgsEl = $('chatMsgs');
        const paint = () => {
            const bubbles = msgsEl.querySelectorAll('.qa-msg-ai .qa-msg-body');
            const last = bubbles[bubbles.length - 1];
            if (last) last.innerHTML = renderRich(reply.content || '…');
            msgsEl.scrollTop = msgsEl.scrollHeight;
        };

        CHAT_ABORT = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        try {
            reply.content = await streamAi(messages, chat.caseNum ? `QA chat — ${chat.caseNum}` : 'QA chat',
                (soFar) => { reply.content = soFar; paint(); },
                CHAT_ABORT ? CHAT_ABORT.signal : undefined);
        } catch (e) {
            const why = (e && e.message) || String(e);
            reply.error = /abort/i.test(why) ? 'Stopped.' : why;
        } finally {
            reply.streaming = false;
            CHAT_BUSY = false;
            CHAT_ABORT = null;
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
    async function streamAi(messages, label, onDelta, signal) {
        if (!window.SotiAI) {
            throw new Error('ai-provider.js did not load, so there is nothing to send this to.');
        }
        if (label) window.SotiAI.setConversationLabel(label);
        const res = await window.SotiAI.chat({
            messages,
            stream: true,
            options: { temperature: 0.3 }
        }, signal ? { signal } : {});
        if (!res || !res.ok) throw new Error(String(res ? await res.text() : 'no answer').slice(0, 400));

        let out = '';
        const eat = (line) => {
            let frame;
            try { frame = JSON.parse(line); } catch (e) { return; }
            if (frame.error) throw new Error(String(frame.error));
            const bit = (frame.message && frame.message.content) || '';
            if (bit) { out += bit; onDelta(out); }
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
    function renderReviews() {
        const list = $('revList');
        if (!list) return;
        list.textContent = '';

        const q = ($('revSearch').value || '').trim().toLowerCase();
        const filter = $('revFilter').value || '';
        let shown = REVIEWS.slice().sort((a, b) => b.at - a.at);
        if (filter === 'qa') shown = shown.filter(r => r.kind === 'qa' && !r.error);
        if (filter === 'milestone') shown = shown.filter(r => r.kind === '306090');
        if (filter === 'failed') shown = shown.filter(r => !!r.error);
        if (q) {
            shown = shown.filter(r => [r.caseNum, r.subject, r.account, r.agent, r.raw]
                .some(v => String(v || '').toLowerCase().includes(q)));
        }

        const meta = $('revMeta');
        if (meta) {
            const failed = REVIEWS.filter(r => r.error).length;
            meta.textContent = REVIEWS.length
                ? `${shown.length} of ${REVIEWS.length} review${REVIEWS.length === 1 ? '' : 's'}${failed ? `, ${failed} with a problem` : ''}`
                : '';
        }

        if (!shown.length) {
            const hint = document.createElement('div');
            hint.className = 'qa-empty';
            hint.innerHTML = REVIEWS.length
                ? 'No review matches this filter.'
                : 'No reviews yet.<br><br>Go to <b>Cases</b>, tick the ones you want reviewed, and press <b>QA selected</b>. '
                  + 'Each case is opened in a background window, read to the end of its feed, and written up here.';
            list.appendChild(hint);
            return;
        }
        for (const r of shown) list.appendChild(reviewCard(r));
    }

    function reviewCard(r) {
        const card = document.createElement('div');
        card.className = 'qa-rev';
        if (r.error) card.classList.add('qa-rev-failed');
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

        if (r.score && r.score.value !== null) {
            const s = document.createElement('span');
            s.className = 'qa-score band-' + scoreBand(r.score);
            s.textContent = String(r.score.value);
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
        } else if (r.raw) {
            const f = document.createElement('div');
            f.className = 'qa-field';
            f.innerHTML = `<div class="qa-field-k">30/60/90 analysis</div><div class="qa-field-v">${esc(r.raw)}</div>`;
            body.appendChild(f);
        }

        const acts = document.createElement('div');
        acts.className = 'qa-rev-acts';
        /* FIRST, and the primary. A review is read in order to disagree with it or to act on
         * it, and both of those are questions — so the control that lets you ask one belongs
         * at the front of this row rather than after Copy and Delete. */
        const talk = document.createElement('button');
        talk.className = 'btn qa-btn-primary';
        talk.textContent = 'Ask about this case';
        talk.onclick = () => openChat(r.key);
        acts.appendChild(talk);
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
            REVIEWS = REVIEWS.filter(x => x.id !== r.id);
            await store({ [K.reviews]: REVIEWS });
            renderAll();
        };
        acts.appendChild(del);
        body.appendChild(acts);

        return card;
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
            .filter(r => r.kind === 'qa' && !r.error)
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
            for (const col of SHEET_COLUMNS) {
                const td = document.createElement('td');
                if (col === 'Case Number') td.className = 'qa-cell-num';
                if (col === 'Date Reviewed') td.className = 'qa-cell-date';
                td.textContent = row[col] || '';
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
            if (r.kind !== 'qa' || r.error) continue;
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
        const agents = agentsWithReviews().filter(a => a.reviews.length);
        if (!agents.length) { toast('No reviewed cases to summarise yet.', 'w'); return; }
        if (!window.SotiAI || !window.SotiAI.isConfigured()) {
            toast('The AI relay is not set up yet — open Settings and press Grant site access.', 'e', 9000);
            return;
        }
        const btn = $('btnBuildCoaching');
        if (btn) btn.disabled = true;
        // The pill reads RUN.failed to decide whether it ends green or red, and that count
        // belongs to whatever ran last. Cleared, or a clean coaching pass inherits the
        // failures of the QA run before it.
        RUN.failed = 0;
        showRunPill(true);
        try {
            for (let i = 0; i < agents.length; i++) {
                const a = agents[i];
                setRunNote(`Coaching summary ${i + 1}/${agents.length} — ${a.name}…`);
                try {
                    const text = await askAi(E.buildCoachingPrompt(a.name, a.reviews), `Coaching — ${a.name}`);
                    const parsed = E.parseCoachingAnswer(text);
                    parsed.fields['Agent'] = a.name;          // ours, not the model's
                    const row = { agent: a.name, at: Date.now(), fields: parsed.fields, raw: text, cases: a.reviews.length };
                    const at = COACHING.findIndex(c => c.agent.toLowerCase() === a.name.toLowerCase());
                    if (at >= 0) COACHING[at] = row; else COACHING.push(row);
                    await store({ [K.coaching]: COACHING });
                    renderCoaching();
                } catch (e) {
                    toast(`${a.name}: ${(e && e.message) || e}`, 'e', 9000);
                }
            }
            toast(`Coaching rows written for ${agents.length} agent${agents.length === 1 ? '' : 's'}.`, 's');
        } finally {
            if (btn) btn.disabled = false;
            showRunPill(false);
        }
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
        refreshAiStatus();
        fillUpdateStatus();
    }

    /* WHICH REPOSITORY THIS BUILD WATCHES, and when it last looked.
     *
     * update.js is a separate file with its own closure, so this reads the small surface it
     * exposes rather than duplicating the constants — a second copy of the repository name
     * is a second thing to change on a rename, and the one that gets missed is the one
     * nobody notices, because a tool pointed at the wrong repository reports "up to date"
     * forever and cheerfully. */
    function fillUpdateStatus() {
        const repo = $('updRepo');
        const when = $('updWhen');
        const U = window.QaUpdate;
        if (repo) {
            repo.textContent = U ? U.UPDATE_REPO : 'update.js did not load';
            repo.className = 'qa-set-status' + (U ? '' : ' bad');
        }
        if (when) {
            const s = U && U.state;
            when.textContent = s && s.at
                ? `${E.fmtDateTime(s.at)}${s.version ? ` — latest published is v${s.version}` : ''}`
                : 'never';
            when.className = 'qa-set-status';
        }
    }

    async function refreshAiStatus() {
        const el = $('aiStatus');
        if (!el) return;
        if (!window.SotiAI) {
            el.textContent = 'ai-provider.js did not load';
            el.className = 'qa-set-status bad';
            return;
        }
        let granted = false;
        try { granted = await window.SotiAI.bridgeAccessGranted(); } catch (e) { granted = false; }
        const origin = window.SotiAI.bridgeOrigin ? window.SotiAI.bridgeOrigin() : '';
        el.textContent = granted ? `Ready — ${origin}` : `Chrome has not granted access to ${origin || 'the relay'}`;
        el.className = 'qa-set-status ' + (granted ? 'ok' : 'bad');
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
            const ok = await confirmAsk('Clear every review?',
                `This deletes all ${REVIEWS.length} review(s), ${COACHING.length} coaching row(s)`
                + `${chats ? `, ${chats} case conversation(s)` : ''} and the stored case material from this tool. `
                + 'The cases in Salesforce are untouched. This cannot be undone.',
                'Delete them');
            if (!ok) return;
            REVIEWS = [];
            COACHING = [];
            CHATS = {};
            CONTEXT = {};
            CHAT_KEY = '';
            await store({ [K.reviews]: REVIEWS, [K.coaching]: COACHING, [K.chats]: CHATS, [K.context]: CONTEXT });
            renderAll();
            toast('Reviews, chats and stored case material cleared.', 's');
        };

        $('btnSyncCaseList').onclick = syncCaseList;
        $('btnAddByUrl').onclick = addByUrl;
        $('btnClearList').onclick = async () => {
            const ok = await confirmAsk('Empty the case list?',
                'The list is rebuilt from Salesforce the next time you sync. Reviews already written are kept.',
                'Empty it');
            if (!ok) return;
            CASES = { listName: '', origin: CASES.origin, scrapedAt: 0, cases: [] };
            SELECTED.clear();
            await store({ [K.cases]: CASES });
            renderAll();
        };

        $('ocSearch').oninput = () => { renderCases(); };
        $('ocSort').onchange = () => renderCases();
        $('ocOwner').onchange = () => renderCases();
        for (const chip of document.querySelectorAll('#ocChips .oc-chip')) {
            chip.onclick = () => {
                FILTER = chip.dataset.filter;
                for (const c of document.querySelectorAll('#ocChips .oc-chip')) c.classList.toggle('active', c === chip);
                renderCases();
            };
        }

        $('ocSelectAll').onchange = () => {
            const shown = visibleCases().map(keyOf);
            if ($('ocSelectAll').checked) for (const k of shown) SELECTED.add(k);
            else for (const k of shown) SELECTED.delete(k);
            renderCases();
        };

        /* SELECT THIS OWNER'S CASES — the second way a reviewer picks work.
         *
         * It ticks every case belonging to the chosen agent ACROSS THE WHOLE QUEUE, not just
         * the ones the current search happens to be showing: "QA everything Imran touched" is
         * the request, and honouring a stray search box on top of it would silently review
         * six of his eleven cases. The other filters are left alone; the ticks are what the
         * run acts on. */
        $('btnSelectOwner').onclick = () => {
            const owner = ($('ocOwner').value || '').trim().toLowerCase();
            if (!owner) { toast('Choose a case owner first.', 'w'); return; }
            let n = 0;
            for (const c of CASES.cases) {
                if (String(c.owner || c.lastModifiedBy || '').toLowerCase() !== owner) continue;
                SELECTED.add(keyOf(c));
                n++;
            }
            renderCases();
            toast(`${n} case${n === 1 ? '' : 's'} ticked for this owner.`, 's');
        };

        $('btnRunQa').onclick = () => startRun('qa');
        $('btnRun306090').onclick = async () => {
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

        $('btnCheckUpdate').onclick = async () => {
            if (!window.QaUpdate) { toast('update.js did not load — check it sits next to qa-panel.js.', 'e', 9000); return; }
            // Interactive, so it asks Chrome for the host permission from inside this click —
            // which is the only moment Chrome will grant one. See update.js.
            await window.QaUpdate.check({ interactive: true });
            fillUpdateStatus();
        };
        $('btnBackupNow').onclick = () => {
            if (!window.QaUpdate) { toast('update.js did not load.', 'e'); return; }
            window.QaUpdate.backup();
        };

        $('btnGrantAi').onclick = async () => {
            if (!window.SotiAI) { toast('ai-provider.js did not load.', 'e'); return; }
            // Chrome only grants optional host permissions from inside a user gesture, and
            // this click is one. Asking at the first review instead would surface a
            // permission prompt in the middle of a run, or fail silently because the
            // gesture had expired.
            const ok = await window.SotiAI.ensurePermissions();
            toast(ok ? 'Access granted — the relay can be used now.' : 'Chrome did not grant access. Reviews will fail until you allow it.', ok ? 's' : 'e', 9000);
            refreshAiStatus();
        };
        $('btnTestAi').onclick = async () => {
            const btn = $('btnTestAi');
            const was = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Testing…';
            try {
                /* TWO STAGES, on purpose. The relay has three failure modes that look
                 * identical from outside — no permission, no injection, or injected but
                 * unable to find the message box — and a single end-to-end test cannot tell
                 * them apart. The ping proves the relay is alive and names what it found;
                 * only then is a real prompt worth sending. */
                const ping = await window.SotiAI.pingBridge();
                toast(`Relay alive on ${ping.host} — message box: ${ping.composer}. Sending a test…`, 'i', 5000);
                const said = await askAi('Reply with exactly: QA TOOL OK', 'QA Tool test');
                toast(`✓ The relay works. It replied: "${said.trim().slice(0, 60)}"`, 's', 8000);
            } catch (e) {
                toast('Relay test failed: ' + ((e && e.message) || e), 'e', 14000);
            } finally {
                btn.disabled = false;
                btn.textContent = was;
                refreshAiStatus();
            }
        };
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
