/* ============================================================================
 * SOTI AI Analyser — AI Provider Layer
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * Everything valuable in this application happens BEFORE the model is called:
 * the Salesforce/JIRA scrape, the cross-log incident index, root-cause scoring,
 * the PulseKB retrieval, the prompt budgeter, the answer repair pass. The model
 * itself is the last, thinnest step — it consumes a prompt that has already been
 * assembled and sized.
 *
 * That means swapping the model should be a SETTING, not a rewrite. This file is
 * the seam that makes it one.
 *
 * THE CONTRACT (the whole trick)
 * ----------------------------------------------------------------------------
 * `SotiAI.chat(payload, init)` takes the EXACT request body that
 * sidepanel.js already builds, and returns something that quacks like the `fetch`
 * Response that sidepanel.js already knows how to consume:
 *
 *     .ok / .status / .text() / .json() / .body.getReader()
 *
 * ...and whose streamed body is ALWAYS the same NDJSON shape:
 *
 *     {"message":{"content":"…"},"done":false}
 *     {"message":{"thinking":"…"},"done":false}
 *     {"done":true,"done_reason":"stop","eval_count":123,"prompt_eval_count":456}
 *
 * So every consumer in sidepanel.js — the streaming pump, the thinking-field
 * fallback, the done_reason auto-continue, the performance instrumentation that
 * reads eval_count out of the terminal frame — keeps working untouched, against
 * any backend. Adding a provider means writing one adapter here and nothing else.
 *
 * THE PROVIDERS
 * ----------------------------------------------------------------------------
 *  • bridge    — NO API KEY, and what this build ships with. See below.
 *  • openai    — any OpenAI-compatible /chat/completions endpoint: Azure OpenAI,
 *                OpenAI, OpenRouter, vLLM, LM Studio, or a company gateway.
 *  • anthropic — the Claude Messages API directly.
 *  • bridge    — NO API KEY. Relays the prompt through a Copilot / Claude /
 *                ChatGPT web tab the user is already signed in to, and reads the
 *                answer back out of the page. See copilot-bridge.js.
 *
 * READ BEFORE CHANGING PROVIDER (this is a data-protection decision, not a perf one)
 * ----------------------------------------------------------------------------
 * There is no on-device provider any more. EVERY provider here sends the prompt —
 * which carries scraped case content and customer log text — to a service somewhere
 * else, and they differ only in which one and under whose contract. The relay rides
 * the seat the engineer already has; an API key is a new processor. Whoever turns one
 * on owns that decision and needs to re-run the assessment; SECURITY.md is where it
 * is written down.
 * ========================================================================== */
(function () {
    'use strict';

    /* ---------------------------------------------------------------------
     * Defaults
     * ------------------------------------------------------------------- */
    const DEFAULTS = Object.freeze({
        // THE RELAY. The panel no longer offers a choice — the picker is hidden and this is
        // the one provider it ships with, because the deployment it is built for has a
        // signed-in M365 Copilot. Everything below still works for the other adapters;
        // nothing in the UI selects them.
        provider: 'bridge',

        // REMOVED: the `openai` and `anthropic` config blocks, and the adapters that read
        // them. They configured hosted-API providers (Azure OpenAI / OpenAI-compatible, and
        // the Anthropic Messages API) that this build has not offered since the provider
        // picker was hidden. Keeping working code and an `apiKey` field for a destination
        // the tool must never reach meant "customer data only goes to Copilot" was true by
        // CONFIGURATION rather than by construction — a distinction that does not survive a
        // security review. The code, the manifest origins and the CSP `connect-src` entries
        // are gone together; re-adding any one of them without the others achieves nothing.

        bridge: {
            // m365, not copilot.microsoft.com. A work account typing into
            // copilot.microsoft.com is redirected to m365.cloud.microsoft anyway, so
            // starting there saves the redirect and the second host grant.
            target: 'm365',           // 'copilot' | 'm365' | 'claude' | 'chatgpt'
            url: '',                  // overrides the target's default URL
            // Start a fresh Copilot conversation when the CASE changes (or after
            // MAX_TURNS_PER_CHAT requests) — not on every call. One click is frequently
            // several calls: a long chain is condensed in batches of 20 before the summary
            // runs, which produced three conversations for a single "Case summary".
            newChatEachTime: true,
            quietMs: 1500,            // answer considered finished after this much silence
            timeoutMs: 240000,
            // How long the page may show NO sign of life before the relay is declared dead.
            // Not the answer's time budget — that is timeoutMs. This is the gap between
            // mutations, and a model thinking about a large attached case produces no
            // mutations at all while it reads. Raised from 60s after runs that were about to
            // succeed were killed and reported as "the relay tab navigated away".
            stallMs: 120000,
            // How much fits in the box AT ONCE. Not how much the model may be given — see
            // maxParts. It truncates silently rather than erroring, so the relay reads the box
            // back, measures what it actually held, and the cap re-tunes itself (learnedCap)
            // instead of leaving the user to guess.
            //
            // 90,000 rather than the 12,000 this shipped with. The old figure was where a chat
            // turn was KNOWN to fit; it is not a limit M365 Copilot has ever enforced on us —
            // its composer is a contenteditable with no maxlength, and the measurement path
            // below has never had to correct it downwards in practice. One message of 90,000
            // carries about what eight parts of 12,000 used to, which means the ordinary case
            // now goes over in ONE round trip instead of eight, and the multi-part machinery
            // is what happens when a case is genuinely enormous rather than routine.
            //
            // If a site DOES cap its box, nothing here is lost: the relay reports what it held,
            // the adapter re-splits to that size, retries once, and remembers the measurement,
            // which from then on outranks this number (see composerCap).
            maxPromptChars: 90000,
            // HOW MANY composer-fuls one conversation may carry. This is the number that
            // decides whether the model sees the case or a fragment of it.
            //
            // A message box caps a MESSAGE. A conversation caps nothing — so a case too big
            // to type at once is sent as consecutive messages, and only the last asks a
            // question. At the defaults that is 8 × 90,000 characters of case against the
            // ~5,400 a single-message prompt budget allowed, which is the difference between
            // a log analysis that reads the evidence and one that reads the first page of it.
            //
            // The ceiling below matters MORE now that one part carries 90,000 rather than
            // 12,000: the product is what has to fit the conversation, and this is the number
            // to bring down — not the one above — if a long case ever comes back answered as
            // though its opening had gone missing.
            //
            // Bounded, not unlimited, and the bound is about a risk that CANNOT BE SEEN: if
            // the conversation's own window overflows, the site drops the earliest turns and
            // the page looks exactly the same. 8 parts is ~35K tokens — around a quarter of
            // a frontier chat window, which leaves the margin that makes silent loss
            // unlikely. Every part is also a round trip, so this is roughly 10-15s each.
            maxParts: 8,
            // What the box demonstrably held, measured the first time it truncated one of
            // ours. 0 = never measured, use maxPromptChars.
            learnedCap: 0,
            // A case bigger than maxParts × maxPromptChars has to lose something. With this
            // on it is CONDENSED — the material is sent through the same relay, in a
            // scratch conversation, and asked to come back shorter — rather than cut off at
            // a character. Off, the tail is trimmed and the cut declared.
            condenseOverflow: true,
            // Where the relay lives. 'minimized' keeps it out of the way entirely — its own
            // window, minimized, never in your tab strip. 'window' is the same but visible,
            // and 'tab' is a background tab in the current window. Minimized is the default
            // because the relay is plumbing and should not look like browsing; if a page
            // refuses to render while minimized, the adapter restores the window and retries
            // rather than failing.
            relayMode: 'minimized',   // 'minimized' | 'window' | 'tab'
            // Delete each relayed conversation once its answer has been read. OFF by default:
            // now that each chat is titled with its case number, the history is a useful
            // record rather than clutter, and deleting it throws away the audit trail of what
            // was actually asked about which case. Turn it on if you would rather it left no
            // trace. Either way the sweep only ever removes conversations this tool created.
            cleanupChats: false,
            // HAND THE CASE OVER AS A FILE INSTEAD OF TYPING IT.
            //
            // Everything above — parts, condensing, trimming — exists because a composer has
            // a length limit. An UPLOAD does not, and a site that takes a file makes the whole
            // ladder unnecessary: a megabyte of log goes up as one attachment where the same
            // text was twelve messages and a condensation pass, and the model reads all of it.
            //
            // It matters most for ZIPs, which is where this came from. A bundle cannot be
            // handed over as a ZIP — M365 Copilot's upload control lists .txt, .log, .json and
            // .xml and lists neither .zip nor .har — so the panel's already-extracted inner
            // files are flattened into ONE .txt behind the "=== FILE: <path> ===" markers the
            // prompt already uses, and the model attributes its findings to the right inner
            // file from them.
            //
            // On by default, and safe to be: if the site has no usable upload control, or the
            // upload stalls, the relay falls back to the text layout it would have sent anyway
            // and says why. Nothing is lost by trying.
            attachData: true,
            // Below this the upload is not worth its own round trip (and its copy into the
            // user's OneDrive) — a case this small was never near the composer limit.
            attachMinChars: 8000,
            // The ceiling, and it is a MEASURED one rather than a guess. Against M365
            // Copilot, sentinel lines planted at the start, middle and end of the payload
            // were all quoted back correctly at 1.05 MB and again at 2.10 MB; 5 MB uploads
            // without complaint but its retrieval was never proven, so the supported figure
            // stops where the evidence stops. Past this the tail is trimmed and the cut is
            // declared in the file itself — the one thing worse than a trimmed case is a
            // trimmed case that reads as a whole one.
            attachMaxChars: 2000000,
            // SEND THE PRODUCT REFERENCE ALONGSIDE THE CASE.
            //
            // A hosted model knows nothing about SOTI's internals — which service owns which
            // log, that 5494 is the legacy device channel, that stopping MS takes the console
            // down while stopping one DS only strands that DS's devices. knowledge/*.md holds
            // exactly those facts, and at ~35 KB for the six curated profiles it costs a fraction of one
            // log bundle to send them whole.
            //
            // Only the seven PRODUCT files. PulseKnowledge.md is 24 MB — an order of magnitude
            // past what an upload will carry, never mind what the model will read back — and
            // it is what the offline RAG index exists to serve; its matches already travel
            // inside the case material as [DEEP RESEARCH].
            //
            // These are separate attachments rather than being pasted into the case file, so
            // reference material and case evidence never blur together: a finding must be
            // citable to a log, not to a product overview that happened to sit next to one.
            attachKnowledge: true,
            selectors: null           // null = use the built-in candidates in copilot-bridge.js
        },

        // Which one-time settings migrations have already run. Recorded so a migration
        // never re-applies and overrides a choice the user has since made deliberately.
        migrations: {}
    });

    // Context windows, in TOKENS, keyed by model name. This feeds the existing prompt
    // budgeter (getModelContextLength → getSessionCtx → maxAllowedChars) so a 200K model
    // stops being trimmed to the 16K fallback the panel uses when a provider will not say.
    const CTX_TABLE = [
        [/^claude-(opus|sonnet|fable)-5/i, 200000],
        [/^claude-haiku-4-5/i, 200000],
        [/^claude/i, 200000],
        [/gpt-5|gpt-4\.1|^o3|^o4/i, 200000],
        [/gpt-4o|gpt-4-turbo/i, 128000],
        [/gemini/i, 1000000],
        [/llama-?[34]/i, 128000],
        [/mistral|mixtral/i, 32768]
    ];
    const CLOUD_CTX_FALLBACK = 128000;

    // Origins that must be granted TOGETHER, because the site moves between them.
    //
    // Signing in to copilot.microsoft.com with a work account redirects to
    // m365.cloud.microsoft/chat?…&login_hint=… — so the tab the relay actually has to
    // read is on a DIFFERENT origin from the one configured. Granting only the
    // configured one leaves the request failing on a host the user never chose and
    // cannot see in the settings. Ask for the pair and the redirect stops mattering.
    // EMPTY, DELIBERATELY. This held one pair — copilot.microsoft.com and
    // m365.cloud.microsoft — because a work account signing in at the first is redirected to
    // the second, so granting only the configured one left the request failing on a host the
    // analyst never chose. copilot.microsoft.com is no longer a target, and the relay now
    // starts at m365 directly, which is the end of that redirect rather than its start.
    // The grouping mechanism is kept because relatedOrigins() is the single place the
    // permission flow asks "what else does this origin need", and a future target that
    // redirects would need it again.
    const ORIGIN_GROUPS = [];

    // A missing host permission is one click from fixed, but the error text lives in the
    // chat transcript where nothing is clickable — so the user reads "open Settings and
    // press Grant", and has to go and do it. Announce it instead and let the panel bring
    // the button to them. Fire-and-forget: nothing here depends on anyone listening.
    function needsPermission(origins) {
        try {
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('soti-ai-needs-permission', { detail: { origins } }));
            }
        } catch (e) { /* the error message still says what to do */ }
    }

    // Same segment rules as currentConversationId() in copilot-bridge.js: reject route
    // names, require length and a digit, and return '' when nothing qualifies — an empty
    // id aborts the delete rather than letting it hunt for a row it cannot identify.
    function conversationIdFromUrl(url) {
        let path = '';
        try { path = new URL(url).pathname; } catch (e) { return ''; }
        const ROUTE = /^(new|chat|chats|conversation|conversations|history|library|search|c|thread)$/i;
        const segs = path.split('/').filter(Boolean);
        for (let i = segs.length - 1; i >= 0; i--) {
            const s = segs[i];
            if (ROUTE.test(s)) continue;
            if (s.length < 8) continue;
            if (!/[0-9]/.test(s)) continue;
            if (!/^[A-Za-z0-9._-]+$/.test(s)) continue;
            return s;
        }
        return '';
    }

    function relatedOrigins(origin) {
        const pattern = origin.replace(/\/$/, '') + '/*';
        for (const group of ORIGIN_GROUPS) {
            if (group.includes(pattern)) return group.slice();
        }
        return [pattern];
    }

    /* THE ONLY DESTINATION CASE CONTENT CAN REACH.
     *
     * This table used to carry four: copilot.microsoft.com, m365.cloud.microsoft, claude.ai
     * and chatgpt.com. That was the live relay path — the one that carries the full,
     * unredacted case — with three alternative destinations available behind a single config
     * string, two of them consumer services outside the organisation's tenant entirely.
     * Nothing selected them and the UI could not reach them, but "it is pointed at Copilot"
     * is a statement about configuration, and the question a reviewer asks is what the code
     * MAKES POSSIBLE. Now: one entry, so the answer is the enterprise tenant or nothing.
     *
     * Adding an entry here is not a settings change. It widens where customer personal data
     * can go, and belongs with whoever signs off SECURITY.md §4.2.
     */
    const BRIDGE_TARGETS = Object.freeze({
        m365: { url: 'https://m365.cloud.microsoft/chat/', label: 'Microsoft 365 Copilot' }
    });

    let CONFIG = clone(DEFAULTS);

    // What to call the relayed conversation. The panel sets this from the open case, so
    // the chat names itself after the case number and the Copilot history becomes a record
    // you can navigate rather than noise to be deleted.
    let CONVERSATION_LABEL = '';

    // Last relay run's stage trail, for the settings "test" button to display.
    const LAST_BRIDGE_DIAG = [];

    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    function merge(base, patch) {
        const out = clone(base);
        for (const k of Object.keys(patch || {})) {
            const v = patch[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
                out[k] = merge(out[k], v);
            } else if (v !== undefined) {
                out[k] = v;
            }
        }
        return out;
    }

    /* ---------------------------------------------------------------------
     * Persistence
     * ------------------------------------------------------------------- */
    async function load() {
        try {
            let stored = null;
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                const d = await chrome.storage.local.get('aiProvider');
                stored = d.aiProvider;
            } else {
                const s = localStorage.getItem('soti_ai_provider');
                if (s) stored = JSON.parse(s);
            }
            if (stored && typeof stored === 'object') CONFIG = merge(DEFAULTS, stored);
            // An unknown provider name (older build, hand-edited storage) must fall back to
            // the shipped one rather than leaving the panel with no way to call anything.
            if (!ADAPTERS[CONFIG.provider]) CONFIG.provider = 'bridge';

            // MIGRATION — the panel used to let you pick the provider, the relay target and
            // the message size. It no longer shows any of those controls, so an install that
            // stored the OLD defaults (a local engine / copilot.microsoft.com / a smaller box) would
            // keep them forever with nothing in the UI able to correct them: a stored value
            // always beats a default. Rewrite them once, and record it, so this never fights
            // a later deliberate change made from storage or a future build.
            if (!CONFIG.migrations.bridgeOnlyDefaults) {
                CONFIG.provider = 'bridge';
                CONFIG.bridge.target = 'm365';
                CONFIG.bridge.relayMode = 'minimized';
                CONFIG.bridge.maxPromptChars = DEFAULTS.bridge.maxPromptChars;
                CONFIG.migrations.bridgeOnlyDefaults = true;
                await save();
                console.log('[SotiAI] Provider settings reset to the shipped relay: M365 Copilot, minimized window, '
                    + `${DEFAULTS.bridge.maxPromptChars.toLocaleString()} characters per message.`);
            }

            // MIGRATION — cleanupChats defaulted to TRUE in the build that introduced it,
            // before chats were titled by case number. Changing the default to false does
            // nothing for anyone who already has it: a stored value always wins over a
            // default, so those installs would go on deleting every conversation forever.
            // Clear it once, and record that it has been done, so someone who deliberately
            // switches deletion back on is not overruled the next time the panel loads.
            if (!CONFIG.migrations.cleanupDefaultOff) {
                CONFIG.bridge.cleanupChats = false;
                CONFIG.migrations.cleanupDefaultOff = true;
                await save();
                console.log('[SotiAI] Relay chats are now titled by case number and are kept, not deleted. Re-enable deletion in Settings if you want it.');
            }
        } catch (e) {
            console.warn('[SotiAI] Failed to load provider settings', e);
        }
        return CONFIG;
    }

    async function save(patch) {
        if (patch) CONFIG = merge(CONFIG, patch);
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set({ aiProvider: CONFIG });
            } else {
                localStorage.setItem('soti_ai_provider', JSON.stringify(CONFIG));
            }
        } catch (e) {
            console.warn('[SotiAI] Failed to save provider settings', e);
        }
        return CONFIG;
    }

    /* ---------------------------------------------------------------------
     * NDJSON plumbing — every adapter's output funnels through here
     * ------------------------------------------------------------------- */

    // Build a Response-like object around a pump function. `pump(emit)` writes frames
    // via emit(obj); returning normally closes the stream.
    function ndjsonResponse(pump) {
        const enc = new TextEncoder();
        let bodyUsed = false;

        const body = new ReadableStream({
            async start(controller) {
                const emit = (obj) => controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
                try {
                    await pump(emit);
                    controller.close();
                } catch (e) {
                    // controller.error() makes the consumer's read() reject with this exact
                    // error object, which is what keeps AbortError propagating as AbortError
                    // all the way up to the per-case cancel handling in sidepanel.js.
                    controller.error(e);
                }
            }
        });

        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            get bodyUsed() { return bodyUsed; },
            body: {
                getReader() { bodyUsed = true; return body.getReader(); }
            },
            async text() { bodyUsed = true; return ''; },
            async json() { bodyUsed = true; return {}; }
        };
    }

    // A non-streaming answer, shaped exactly like the streaming path's final frame, so the
    // callers that do `(await res.json()).message.content` need no branch.
    function jsonResponse(content, thinking, stats) {
        let used = false;
        const payload = Object.assign({
            message: { role: 'assistant', content: content || '', thinking: thinking || '' },
            done: true,
            done_reason: (stats && stats.done_reason) || 'stop'
        }, stats || {});
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            get bodyUsed() { return used; },
            body: null,
            async text() { used = true; return JSON.stringify(payload); },
            async json() { used = true; return payload; }
        };
    }

    function errorResponse(status, text) {
        let used = false;
        return {
            ok: false,
            status: status || 500,
            statusText: 'Error',
            get bodyUsed() { return used; },
            body: null,
            async text() { used = true; return text || ''; },
            async json() { used = true; try { return JSON.parse(text); } catch (e) { return { error: text }; } }
        };
    }

    // Turn a stream of {content, thinking} deltas into the NDJSON frames the panel expects.
    // `driver(push)` is the adapter's own loop; it returns the terminal stats.
    function streamAsNdjson(driver) {
        return ndjsonResponse(async (emit) => {
            const push = (delta) => {
                if (!delta) return;
                if (delta.content) emit({ message: { role: 'assistant', content: delta.content }, done: false });
                /* A REPLACEMENT, NOT AN ADDITION. `replace` carries the answer so far in full,
                 * and the flag is what tells the consumer to swap rather than append — see the
                 * SOTI_BRIDGE_REPLACE branch in runRelay. It rides in the same frame shape as a
                 * delta so every consumer that only understands `content` still receives the
                 * text; such a consumer would double it up, which is why the two that matter
                 * (the panel's stream pump and the buffering driver below) both read the flag. */
                if (typeof delta.replace === 'string') {
                    emit({ message: { role: 'assistant', content: delta.replace }, replace: true, done: false });
                }
                if (delta.thinking) emit({ message: { role: 'assistant', thinking: delta.thinking }, done: false });
            };
            const stats = (await driver(push)) || {};
            emit(Object.assign({
                message: { role: 'assistant', content: '' },
                done: true,
                done_reason: stats.done_reason || 'stop'
            }, stats));
        });
    }

    // Shared SSE line reader. Calls onEvent(dataString) for each `data:` payload,
    // buffering across chunk boundaries. Stops on the [DONE] sentinel.
    async function readSSE(res, onEvent) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const raw of lines) {
                const line = raw.trim();
                if (!line || line.startsWith(':')) continue;
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') return;
                onEvent(data);
            }
        }
        // A final partial line without its newline still carries a frame worth reading.
        const tail = buf.trim();
        if (tail.startsWith('data:')) {
            const data = tail.slice(5).trim();
            if (data && data !== '[DONE]') onEvent(data);
        }
    }

    /* ---------------------------------------------------------------------
     * Payload translation
     * ------------------------------------------------------------------- */

    // The panel's prompts are text-only by the time they reach here (AIEngine already
    // flattens multimodal content), but a defensive flatten costs nothing and keeps a
    // future image path from silently sending "[object Object]" to a cloud endpoint.
    function flattenMessages(messages) {
        return (messages || []).map(m => {
            if (Array.isArray(m.content)) {
                return { role: m.role, content: m.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n') };
            }
            return { role: m.role, content: String(m.content == null ? '' : m.content) };
        });
    }

    // REMOVED: optsOf(), which normalised temperature/top_p/max_tokens into the shape a
    // hosted chat API wants. Only the two deleted adapters called it — a relay types into a
    // composer and has no sampling parameters to send.

    /* THE ON-DEVICE ADAPTER USED TO SIT HERE.
     *
     * It was a literal passthrough: the same fetch to a chat endpoint on 127.0.0.1 that this
     * code made before any of this translation layer existed, kept as an adapter so the panel
     * had one code path instead of two. It is gone, and with it the local binding the panel
     * used to hand in at boot, the host permission for the local port, and the model picker in
     * Settings that listed what was installed on the machine.
     *
     * ONE adapter remains, and it reaches a service somewhere else. That is a data-protection
     * fact about this build, not an implementation detail — see SECURITY.md §4.2. */

    /* =====================================================================
     * ADAPTER: bridge  (no API key — relay through a signed-in web tab)
     * =================================================================== */
    // Which frame of the relay tab the chat actually lives in. Set by injectAndConfirm and
    // used to address every later message: with allFrames injection an unaddressed
    // sendMessage reaches every frame at once, and several relays typing into one page is
    // not a race worth having.
    const BRIDGE_FRAME = { id: undefined };

    // The id of the document_start content script registered for the duration of a
    // relay request — see registerWakeScript. A constant because it has to be
    // recognisable to the sweep that removes a stale one.
    const WAKE_SCRIPT_ID = 'soti-relay-wake';

    /* THE RELAY CLOCK'S STATE LIVES UP HERE WITH THE REST OF THE RELAY'S.
     *
     * Not beside swSleep and relayPump, which are function declarations and so are
     * hoisted to wherever they are needed. `let` is not: it sits in the temporal dead
     * zone until the module body reaches it, and a `let` declared BELOW the adapter
     * that reads it is a ReferenceError waiting for the first caller that runs before
     * the file has finished loading — the exact shape of bug `node --check` cannot see
     * and that has shipped in this project before. Declared above every reader instead,
     * where the ordering cannot be got wrong later. */
    // The tab the pump was last pointed at, so it can be switched off again
    // without the caller having to remember.
    let RELAY_PUMP_TAB = null;

    /* WHICH REQUEST THE CLOCK BELONGS TO.
     *
     * The relay is one shared window, so requests through it are serialised in
     * practice — but "in practice" is not a guarantee, and the failure if two ever
     * do overlap is nasty and silent: the first to finish switches the clock off
     * underneath the second, which then spends the rest of its life on Chrome's
     * clamped timers with nothing anywhere reporting it.
     *
     * A stamp rather than a count of holders, because a count can be LEAKED — one
     * path that throws between taking a hold and releasing it leaves the number
     * permanently above zero and no stop ever works again. A request whose stamp
     * has been superseded simply says nothing; the newest request's stop is always
     * the one that counts, whatever happened to the ones before it. */
    let RELAY_CLOCK_GEN = 0;


    // The relay's own window, reused across requests. Without this every request either
    // spawned another tab or hijacked whichever Copilot tab the user happened to have
    // open — navigating a tab out from under someone who is reading it.
    // The relay's window, plus what it is currently talking about. `label` is the case the
    // open conversation belongs to and `turns` is how many requests have gone into it —
    // together they decide when a FRESH conversation is warranted.
    // `used` is whether anything has been TYPED into the conversation that is open. Turn
    // counting cannot answer that: the condensation pass navigates to a fresh chat several
    // times and sends into each, so "we just navigated" and "this conversation is empty"
    // stopped being the same question.
    const RELAY_WINDOW = { id: undefined, label: undefined, turns: 0, used: false };

    /* =====================================================================
     * WHERE THE ENGINEER ACTUALLY IS — and putting them back there
     * =====================================================================
     * `focused: false` IS A REQUEST, NOT A GUARANTEE. On Windows a newly created window,
     * and a window taken out of the minimized state, are both routinely raised in front of
     * everything else whatever the flag says. The reader window in sidepanel.js has always
     * known this and puts the focus back straight afterwards (ocReaderRefocusHome); the
     * relay window asked politely and then did nothing about the answer, which is the
     * report: the Copilot window arrives in the FOREGROUND instead of behind.
     *
     * The window to go back to is remembered BEFORE any scaffolding exists, and it is never
     * one of ours. Asking `getLastFocused()` at the moment of the hand-back is how the relay
     * ends up being handed focus back to itself — `nudgeRelayWindow` skipped the hand-back
     * outright when the answer was the relay, and left it sitting in front of the engineer.
     * The background reader window is excluded for the same reason and by name: it is a real
     * Chrome window full of real Salesforce pages, it answers `getLastFocused()` like any
     * other, and treating it as somewhere to send the engineer is a mistake this codebase
     * has now made three times over.
     * =================================================================== */
    const HOME_WINDOW = { id: undefined };

    const isScaffoldingWindow = (id) => id == null
        || (RELAY_WINDOW.id != null && id === RELAY_WINDOW.id)
        // Optional, and guarded: ai-provider.js loads before sidepanel.js and must not
        // depend on it having run. See the reader-window notes in sidepanel.js.
        || (typeof ocReader !== 'undefined' && ocReader && ocReader.winId != null && id === ocReader.winId);

    async function noteHomeWindow() {
        try {
            const w = await chrome.windows.getLastFocused();
            if (!w || isScaffoldingWindow(w.id)) return;
            // A devtools window is not where the engineer was working either.
            if (w.type && w.type !== 'normal' && w.type !== 'popup') return;
            HOME_WINDOW.id = w.id;
        } catch (e) { /* no answer — the hand-back below simply does nothing */ }
    }

    async function refocusHomeWindow() {
        if (isScaffoldingWindow(HOME_WINDOW.id)) return false;
        try {
            await chrome.windows.update(HOME_WINDOW.id, { focused: true });
            return true;
        } catch (e) { return false; }
    }

    /* ---------------------------------------------------------------------
     * SPLITTING A CASE ACROSS A CONVERSATION
     * ---------------------------------------------------------------------
     * The composer's limit is per MESSAGE. The conversation has no such limit, so the
     * prompt is cut into parts that each fit the box and sent as consecutive messages;
     * only the last one asks a question. See the header of copilot-bridge.js.
     * ------------------------------------------------------------------- */

    // Room reserved in every part for its own header (the title line, the nonce, the
    // "this is part k of n, do not answer yet" instruction). Measured against the longest
    // header this file builds, with slack — a header that overflows the cap would be
    // truncated by the box, and the truncated thing would be the instruction.
    const PART_OVERHEAD = 460;

    // Above 12 the conversation window becomes the binding constraint instead of the box,
    // and overflowing THAT is invisible: the site drops its earliest turns and the page
    // looks identical. A ceiling here is a guard against a failure nobody can see.
    const MAX_PARTS_CEILING = 12;

    function partLimit() {
        const n = parseInt(CONFIG.bridge.maxParts, 10);
        return Math.max(1, Math.min(MAX_PARTS_CEILING, n || DEFAULTS.bridge.maxParts));
    }

    // The smallest measurement worth believing. No chat composer on earth caps a message at
    // a few hundred characters, so a reading below this describes a composer that did not
    // receive the text — not one that refused it.
    const CREDIBLE_COMPOSER_CAP = 2000;

    // What one message may carry. A measured limit always beats the configured one — the
    // box either held that much or it did not, and no setting outranks the evidence.
    //
    // An IMPLAUSIBLE measurement, though, outranks nothing. A stored learnedCap below the
    // credible floor is discarded here rather than obeyed, which also un-poisons a profile
    // that already recorded one: an earlier build floored this at 1,000 on a failed type and
    // wrote it to disk, and every later request was quietly cut to 8 × 1,000 characters with
    // no way to clear it from the UI. Ignoring it costs one re-measurement; obeying it costs
    // every answer.
    function composerCap() {
        const configured = CONFIG.bridge.maxPromptChars || DEFAULTS.bridge.maxPromptChars;
        const learned = parseInt(CONFIG.bridge.learnedCap, 10) || 0;
        return learned >= CREDIBLE_COMPOSER_CAP ? Math.min(configured, learned) : configured;
    }

    // Where a prompt's RULES stop and its DATA begins. Mirrors PROMPT_DATA_SECTION_RE in
    // sidepanel.js: every data section the panel builds opens a line with a bracketed
    // ALL-CAPS name, and the rules only ever mention those names mid-sentence — which is
    // why the match is anchored to the start of a line.
    const DATA_SECTION_RE = /^\[[A-Z][A-Z0-9 &/()'’,.…—-]{2,}/m;
    function dataSectionIdx(text) {
        const m = String(text || '').match(DATA_SECTION_RE);
        return m ? m.index : -1;
    }

    // CUT ON A BOUNDARY, NEVER MID-LINE.
    //
    // This is not tidiness. The material being split is log lines, JIRA fields and email
    // headers, and half a log line is not weaker evidence — it is FALSE evidence: a
    // timestamp severed from its message, or a citation whose line number lost its last
    // digit, reads to the model as a fact. Whole lines can be counted, quoted and cited;
    // fragments cannot. A blank line is preferred (it separates sections), then any line
    // break, then a space, and only an unbroken run longer than the budget is cut blind.
    function splitOnBoundaries(text, budget) {
        const out = [];
        const src = String(text || '');
        let i = 0;
        while (i < src.length) {
            if (src.length - i <= budget) { out.push(src.slice(i)); break; }
            const end = i + budget;
            let cut = src.lastIndexOf('\n\n', end);
            if (cut <= i + budget * 0.5) cut = src.lastIndexOf('\n', end);
            if (cut <= i) cut = src.lastIndexOf(' ', end);
            if (cut <= i) cut = end;                     // one unbroken run — nothing to aim at
            out.push(src.slice(i, cut));
            i = cut;
            while (src[i] === '\n') i++;                 // the seam itself is not content
        }
        return out.map(s => s.replace(/\s+$/, '')).filter(s => s.length);
    }

    // A stamp unique to one message of one run. The relay proves a part was accepted by
    // finding it echoed back on the page, and the first 40 characters cannot do that job
    // here: every part opens with the same case title, so part 3 would match part 1's
    // bubble and a dropped message would read as a delivered one.
    function partStamp(nonce, index, total) {
        return `⟦SOTI ${nonce} ${index}/${total}⟧`;
    }

    // The line every relayed message opens with. A chat names itself from the first words of
    // the first message, so leading with the case number makes the sidebar readable at a
    // glance — and the marker is what lets the cleanup sweep recognise its own work and
    // leave the engineer's real chats alone. Both halves matter; neither is decoration.
    function conversationTitle() {
        return CONVERSATION_LABEL
            ? `${CONVERSATION_LABEL} · SOTI AI Analyser`
            : 'SOTI AI Analyser — automated request.';
    }

    // What the uploaded case file is called. Named after the case for the same reason the
    // conversation is: this file lands in the engineer's own OneDrive ("Microsoft Copilot
    // Chat Files") and stays there, so "C01720260-case-material.txt" is something they can
    // recognise and clear out later, while "attachment.txt" is not.
    //
    // Windows/SharePoint reject " * : < > ? / \ | # % in a file name, and a case label is
    // free text, so everything outside a conservative set is replaced rather than trusted.
    function attachmentName() {
        const base = String(CONVERSATION_LABEL || '')
            .replace(/[^\w.-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);
        return (base ? `${base}-case-material` : 'soti-case-material') + '.txt';
    }

    /* THE PRODUCT REFERENCE FILES, READ ONCE PER SESSION.
     *
     * Deliberately NOT knowledge/PulseKnowledge.md: that one is 24 MB / 159,000 lines, which
     * is roughly twelve times the largest payload whose retrieval has actually been verified.
     * It is served by the offline RAG index instead, and its matches already reach the model
     * inside the case material.
     *
     * A file that will not load is skipped in silence. Reference material is an improvement
     * to an answer, never a precondition for one — failing a case analysis because a product
     * overview 404'd would be a poor trade.
     */
    const KNOWLEDGE_FILES = [
        'knowledge/MobiControl.md', 'knowledge/MobiControl_Knowledge.md',
        'knowledge/Connect.md', 'knowledge/Connect_Knowledge.md',
        'knowledge/XSight.md', 'knowledge/XSight_Knowledge.md',
        /* SOTI SNAP IS THE ODD ONE HERE, AND DELIBERATELY SO — SAY SO OUT LOUD.
         *
         * The six above are curated PROFILES: a page or two each of log signatures, port
         * matrices and domino patterns, ~35KB for the lot. This one is SOTI's published Snap
         * documentation scraped whole off Pulse — every release note back to 3.0.0, all 33
         * Pulse articles and all 266 help topics — and it is about 780KB on its own.
         *
         * WHY WHOLE RATHER THAN SUMMARISED. A Snap case has no log bundle to read signatures
         * out of; what decides it is what SOTI has published about the version in front of
         * you, and a summary of release notes is exactly the artefact that cannot answer "is
         * this already fixed". The upload has been measured at 1.05MB and 2.10MB with
         * sentinel lines quoted back from the start, middle and end, so retrieval at this
         * size is proven rather than hoped for — see attachMaxChars.
         *
         * WHAT IT COSTS. This file goes up with EVERY bridge request that attaches knowledge,
         * so the reference attachment is ~816KB instead of ~35KB. That is real transfer time
         * per request. The cheaper shape, if it ever matters, is the one the Salesforce
         * corpus already uses: send the INDEX (the head of this file is one, by construction)
         * and let the offline retriever put the handful of matching topics into the case
         * material — see kbIndexBlock. Snap.md is in PulseKB.KB_FILES too, so that retrieval
         * already works; only the decision to also send it whole would change. */
        'knowledge/Snap.md'
    ];
    let KNOWLEDGE_CACHE = null;

    // ONE file, not six. M365 Copilot refuses an upload of more than THREE files at a time
    // ("The number of files you are trying to add exceeds the maximum limit"), and it refuses
    // the whole batch rather than the surplus — so six reference files plus the case took the
    // case down with them. Merged behind the same "=== FILE: <name> ===" markers the case
    // material uses, which the model already attributes correctly per inner file.
    /* THE KNOWLEDGE BASE'S TABLE OF CONTENTS, WHICH IS THE PART THAT FITS.
     *
     * The articles themselves cannot go up. On a real org the corpus is 1,958 articles and
     * six megabytes, it grows every week, and M365 refuses more than three attachments — so
     * uploading it would be minutes of transfer per request for a file whose relevant page
     * the panel had already found. The panel sends the handful that answer THIS question
     * instead, which is right and is what makes the corpus usable as it grows.
     *
     * But that leaves the model unable to tell "support has never written this up" from "the
     * panel's search did not surface it", and it answers the first when it means the second.
     * The INDEX is the difference: every article's number, publication status and title, for
     * the whole base, in about 3% of the bytes. With it the model can say "there is an article
     * on this — 000012345 — ask the panel for it" rather than "no article exists".
     *
     * It is sliced out of the compiled corpus rather than rebuilt: the head runs to the first
     * article heading, and the compiler is the only thing that writes either. */
    function kbIndexBlock(md) {
        const text = String(md || '');
        const at = text.indexOf('## Index');
        if (at < 0) return '';
        // To the first article, which is the first "\n# " after the index heading.
        const end = text.indexOf('\n\n# ', at);
        const head = text.slice(0, text.indexOf('\n\n## Index'));      // origin + coverage line
        const index = end > at ? text.slice(at, end) : text.slice(at);
        if (!index.trim()) return '';
        return `${head}\n\n${index}`;
    }

    async function loadKbIndexAttachment() {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return '';
            const got = await chrome.storage.local.get('kbArticlesData');
            return kbIndexBlock(got && got.kbArticlesData);
        } catch (e) { return ''; }   // reference material is never a precondition — see above
    }

    async function loadKnowledgeAttachments() {
        if (KNOWLEDGE_CACHE) return KNOWLEDGE_CACHE;
        const parts = [];
        for (const path of KNOWLEDGE_FILES) {
            try {
                const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
                    ? chrome.runtime.getURL(path)
                    : path;
                const res = await fetch(url);
                if (!res.ok) continue;
                const text = await res.text();
                if (text && text.trim()) {
                    const name = path.split('/').pop();
                    parts.push(`=== FILE: ${name} ===\n${text.trim()}\n=== END: ${name} ===`);
                }
            } catch (e) { /* skipped — see the note above */ }
        }
        /* THE INDEX RIDES WITH THE PRODUCT REFERENCE rather than as a file of its own. M365's
         * ceiling is three attachments and it refuses the whole batch rather than the surplus,
         * so the case plus one merged reference is all the room there is — a third file would
         * take the case down with it. Same "=== FILE: ===" markers, which the model already
         * attributes correctly per inner file. */
        const index = await loadKbIndexAttachment();
        if (index) {
            parts.push(`=== FILE: soti-kb-index.md ===\n${index}\n=== END: soti-kb-index.md ===`);
        }
        KNOWLEDGE_CACHE = parts.length
            ? [{ name: 'soti-product-reference.md', text: parts.join('\n\n'), type: 'text/markdown' }]
            : [];
        return KNOWLEDGE_CACHE;
    }

    /* THE INDEX GOES STALE THE MOMENT A SYNC FINISHES, and the cache above is read once per
     * session — so an engineer who syncs and then asks a question would be sending yesterday's
     * catalogue for the rest of the day. Called by the panel after a sync or an import. */
    function clearKnowledgeCache() { KNOWLEDGE_CACHE = null; }

    // How many requests may share one Copilot conversation before a new one is started.
    // One user action is often several calls — a long case is condensed in batches of 20
    // before the summary itself runs — so a new chat per CALL produced three conversations
    // for a single "Case summary" click. Sharing one keeps the history readable; capping it
    // stops a day's work accumulating into a single unwieldy thread.
    const MAX_TURNS_PER_CHAT = 8;

    // Runs INSIDE each frame of the relay tab, so it must be a standalone FUNCTION
    // DECLARATION: executeScript serialises it with toString(), and an object-literal
    // method stringifies to something that will not re-parse on the other side.
    // Reports what could be typed into, so the right frame can be chosen and — when none
    // can — the failure can describe the page instead of blaming the user's sign-in.
    function surveyFrame() {
        // This test must stay IDENTICAL to typeable() in copilot-bridge.js. When the two
        // drifted apart, the survey found a box by one rule, picked that frame, and the
        // relay then failed to find anything by its own narrower rule — in the same frame —
        // and reported "no usable message box" on a page that plainly had one.
        // isContentEditable is the load-bearing part: it is true for
        // contenteditable="plaintext-only", which [contenteditable="true"] never matches.
        const sels = [
            '#prompt-textarea', 'textarea#userInput', 'textarea[data-testid="composer-input"]',
            '[contenteditable="plaintext-only"]', '[contenteditable="true"]',
            '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]',
            'textarea', 'input[type="text"]', 'input[type="search"]'
        ];
        const seen = [];
        const found = new Set();
        for (const sel of sels) {
            let nodes;
            try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
            for (const el of nodes) {
                if (found.has(el)) continue;
                found.add(el);
                const r = el.getBoundingClientRect();
                let cs;
                try { cs = getComputedStyle(el); } catch (e) { cs = {}; }
                const shown = (r.width > 1 || r.height > 1) && cs.display !== 'none' && cs.visibility !== 'hidden';
                const canType = el.tagName === 'TEXTAREA' ? true
                    : el.tagName === 'INPUT' ? /^(text|search|)$/i.test(el.type || '')
                    : !!el.isContentEditable;
                seen.push({
                    sel,
                    tag: el.tagName,
                    id: el.id || '',
                    label: (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').slice(0, 40),
                    visible: shown && canType && !el.disabled && !el.readOnly,
                    w: Math.round(r.width)
                });
                if (seen.length >= 14) break;
            }
        }
        return { url: location.href, title: document.title.slice(0, 60), seen };
    }

    // Every context part is a round trip — type, submit, echo, wait out the acknowledgement.
    // The whole-request timeout has to grow with them or an eight-part case times out while
    // it is still being loaded, which reads as "the site is broken" rather than "give it a
    // moment".
    const PART_TIMEOUT_MS = 45000;

    // ONE RELAY RUN. Extracted from chat() because the condensation pass needs exactly the
    // same machinery — same watchdogs, same cancellation, same error reporting — and a
    // second copy of it would be a second place for the abort handling to rot.
    function runRelay(o) {
        const tabId = o.tabId;
        const parts = o.parts;
        const signal = o.signal;
        const onDelta = o.onDelta || (() => {});
        const requestId = o.requestId;
        const DIAG = o.diag || [];
        const stats = { done_reason: 'stop' };

        return new Promise((resolve, reject) => {
            let settled = false;
            let capacity = null;
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(arg);
            };

            // STALL WATCHDOG. Every bounded wait inside the relay ends in an error
            // message, so silence does not mean "still working" — it means the relay
            // is gone (tab navigated, reloaded, or crashed). Without this the only
            // backstop is the whole-request timeout, which is minutes of a thinking
            // dot that will never resolve. Any sign of life resets it.
            //
            // 60s was too tight and it cost real answers. A large attached case is read
            // before a single token comes back, and on a big log bundle Copilot can think
            // for well over a minute with nothing on the page changing — no stream, no
            // spinner mutation, nothing for `beat()` to see. The watchdog fired on runs
            // that were about to succeed, and the engineer was told the tab had navigated
            // away when it had done nothing of the sort.
            //
            // Still bounded, and still well inside the whole-request timeout below it, so a
            // genuinely dead relay is caught rather than left hanging until that expires.
            const STALL_MS = parseInt(CONFIG.bridge.stallMs, 10) || DEFAULTS.bridge.stallMs;
            let stallTimer = null;

            /* A SILENT RELAY IS USUALLY ASLEEP, NOT DEAD.
             *
             * This used to reject on the first silence, and the commonest cause of that
             * silence is the one the engineer had been fixing by hand: the relay window is
             * behind another one, so Chrome has stopped painting it and the page has stopped
             * doing anything. Clicking it fixed the run every time — which means the run was
             * never broken, only paused.
             *
             * So silence now escalates before it gives up. Two revival rounds, the second
             * allowed to raise the window (the click, performed for them, with focus handed
             * straight back). Only if the relay is STILL silent after both is it treated as
             * gone — and the message then says what was tried, so "it went quiet" is never
             * again the whole story.
             */
            let revivals = 0;
            const MAX_REVIVALS = 2;

            /* AND THE CLOCK IS KEPT WOUND FOR AS LONG AS THE ANSWER TAKES.
             *
             * beat() runs on every sign of life, which during a streaming answer is
             * several times a second — so the re-assert is rate-limited to once a minute
             * rather than sent on each one. It covers the two things that can quietly end
             * the pump in the middle of a long answer: Chrome recycling the service worker
             * (which it may do whenever it likes, and which would put both sides back on
             * their clamped timers), and the pump's own fifteen-minute ceiling arriving
             * during a genuinely long run. One message a minute for either is cheap. */
            let pumpedAt = 0;
            const windUp = () => {
                if (Date.now() - pumpedAt < 60000) return;
                pumpedAt = Date.now();
                relayPump(tabId, true).catch(() => {});
            };

            const beat = () => {
                windUp();
                clearTimeout(stallTimer);
                stallTimer = setTimeout(async () => {
                    if (settled) return;
                    if (revivals < MAX_REVIVALS) {
                        revivals++;
                        // Re-armed FIRST, so a revival that takes several seconds cannot let
                        // the watchdog fire twice — and so the relay gets a fresh full window
                        // of silence to break before the next escalation.
                        beat();
                        try {
                            const r = await bridgeAdapter.reviveRelay(tabId, { allowRaise: revivals >= MAX_REVIVALS });
                            const what = (r.did || []).join(', ') || 'nothing to do';
                            DIAG.push(`stall ${revivals}: ${what}`);
                            console.warn(`[SotiAI bridge] no word for ${STALL_MS / 1000}s — revival ${revivals}/${MAX_REVIVALS}: ${what}`
                                + (r.probe ? ` (page ${r.probe.occluded ? 'was NOT being painted' : 'is being painted'}, `
                                    + `composer ${r.probe.composer || 'not found'})` : ' (no reply from the page)'));
                        } catch (e) {
                            console.warn('[SotiAI bridge] revival failed', e);
                        }
                        return;
                    }
                    finish(reject, new Error(
                        `${bridgeAdapter.model()} went silent for ${STALL_MS / 1000}s, and stayed silent through `
                        + `${MAX_REVIVALS} attempts to wake the relay window. The tab has most likely reloaded, `
                        + `navigated away, or been signed out mid-request — open it and check, then try again.`));
                }, STALL_MS);
            };

            const onTabRemoved = (closedId) => {
                if (closedId === tabId) finish(reject, new Error('The relay tab was closed before the answer finished.'));
            };

            const onMessage = (msg) => {
                if (!msg || msg.requestId !== requestId) return;
                beat();
                if (msg.type === 'SOTI_BRIDGE_DIAG') {
                    // What the relay actually latched onto. Kept so a failure can say
                    // "matched #prompt-textarea, sent via Enter, read by heuristic"
                    // instead of the useless "it didn't work".
                    DIAG.push(`${msg.stage}: ${msg.detail}`);
                    console.log('[SotiAI bridge]', msg.stage, '→', msg.detail);
                } else if (msg.type === 'SOTI_BRIDGE_PART') {
                    console.log(`[SotiAI bridge] context part ${msg.index}/${msg.total} loaded`);
                } else if (msg.type === 'SOTI_BRIDGE_CAPACITY') {
                    // The box measured itself. Carried out on the error so the caller can
                    // re-split to a size this site has actually demonstrated.
                    capacity = { accepted: msg.accepted, attempted: msg.attempted };
                } else if (msg.type === 'SOTI_BRIDGE_DELTA') {
                    onDelta({ content: msg.text || '' });
                } else if (msg.type === 'SOTI_BRIDGE_REPLACE') {
                    /* THE PAGE REWROTE WHAT IT HAD ALREADY SHOWN, so the panel replaces what it
                     * has already drawn — see the streaming loop in copilot-bridge.js.
                     *
                     * A rendered chat page is not a token stream: it re-flows a paragraph into
                     * a bullet, renumbers a list, reformats a code block the moment its closing
                     * fence lands, and swaps a "Gathering details…" placeholder for the real
                     * answer. Append-only could describe none of that, so the relay used to HOLD
                     * on divergence and the panel sat frozen while Copilot kept typing.
                     *
                     * `replace` carries the answer SO FAR in full, never a fragment. */
                    onDelta({ replace: msg.text || '' });
                } else if (msg.type === 'SOTI_BRIDGE_DONE') {
                    if (msg.truncated) stats.done_reason = 'length';
                    finish(resolve, stats);
                } else if (msg.type === 'SOTI_BRIDGE_ERROR') {
                    LAST_BRIDGE_DIAG.length = 0;
                    LAST_BRIDGE_DIAG.push(...DIAG);
                    const trail = DIAG.length ? `\n\nWhat the relay managed: ${DIAG.join(' · ')}` : '';
                    const err = new Error((msg.error || 'The browser bridge failed.') + trail);
                    if (capacity) err.capacity = capacity;
                    finish(reject, err);
                }
            };

            const onAbort = () => {
                try { chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_CANCEL', requestId }, { frameId: BRIDGE_FRAME.id }); } catch (e) { /* tab may be gone */ }
                const err = new Error('Aborted');
                err.name = 'AbortError';
                finish(reject, err);
            };

            // Loading the case costs real time before a single token is generated, so the
            // budget is the configured answer timeout PLUS an allowance per context part.
            const base = CONFIG.bridge.timeoutMs || DEFAULTS.bridge.timeoutMs;
            const budgetMs = base + Math.max(0, parts.length - 1) * PART_TIMEOUT_MS;
            const timer = setTimeout(() => {
                finish(reject, new Error(`The ${bridgeAdapter.model()} tab did not finish within ${Math.round(budgetMs / 1000)}s${parts.length > 1 ? ` (${parts.length} context parts)` : ''}.`));
            }, budgetMs);

            function cleanup() {
                clearTimeout(timer);
                clearTimeout(stallTimer);
                try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) {}
                try { chrome.tabs.onRemoved.removeListener(onTabRemoved); } catch (e) {}
                if (signal) signal.removeEventListener('abort', onAbort);
            }

            chrome.runtime.onMessage.addListener(onMessage);
            try { chrome.tabs.onRemoved.addListener(onTabRemoved); } catch (e) {}
            beat();
            if (signal) {
                if (signal.aborted) return onAbort();
                signal.addEventListener('abort', onAbort);
            }

            RELAY_WINDOW.used = true;
            chrome.tabs.sendMessage(tabId, {
                type: 'SOTI_BRIDGE_ASK',
                requestId,
                parts,
                // The single-message shape, for a relay from an older build that has not
                // been re-injected yet.
                prompt: parts.length === 1 ? parts[0].text : undefined,
                quietMs: CONFIG.bridge.quietMs || DEFAULTS.bridge.quietMs,
                selectors: CONFIG.bridge.selectors || null,
                // The case material as a file, and the text layout to fall back to if the
                // page will not take it. Both are omitted entirely when not attaching, so a
                // relay from an older build sees exactly the message it saw before.
                attachments: o.attachments || undefined,
                fallbackParts: o.fallbackParts || undefined,
                attachTimeoutMs: CONFIG.bridge.timeoutMs || DEFAULTS.bridge.timeoutMs
            }, { frameId: BRIDGE_FRAME.id }).catch(e => finish(reject, new Error(
                `Couldn't talk to the ${bridgeAdapter.model()} page: ${e && e.message ? e.message : e}. Open the tab, sign in, and try again.`
            )));
        });
    }

    /* ---------------------------------------------------------------------
     * Condensing a case that will not fit even a whole conversation
     * ---------------------------------------------------------------------
     * The relay is used on its own material: the case is sent through in chunks and asked
     * to come back shorter, then the shortened version is what gets analysed. It costs one
     * round trip per chunk, and it happens in a SCRATCH conversation — condensing in the
     * conversation that will hold the analysis would leave both the original and the
     * condensation in the window, which is the opposite of the point.
     * ------------------------------------------------------------------- */
    const MAX_CONDENSE_CHUNKS = 10;      // beyond this the wait is longer than the answer is worth
    const CONDENSE_CHUNKS_PER_CHAT = 3;  // scratch conversations are recycled before they fill
    const CONDENSE_OVERHEAD = 1400;      // room for the condensing instructions themselves

    function condensePrompt(chunk, want, index, total) {
        return `${conversationTitle()} · condensing case material ${index}/${total}\n` +
            `=== CONDENSE — DO NOT ANALYSE ===\n` +
            `Rewrite the case material below so it is at most ${want.toLocaleString()} characters. Another assistant will do the analysis and will see ONLY your rewrite, never this original.\n\n` +
            `Keep VERBATIM: log lines with their file name and line number, error codes, stack frames, timestamps, version and build numbers, device/profile/ticket identifiers, and any sentence someone actually wrote that carries a commitment, a request, or a symptom.\n` +
            `NEVER invent one. If a line number, a timestamp, a version or a quotation is not in the text below, it must not appear in your output — a plausible-looking citation that does not exist is worse than a missing one.\n` +
            `Remove: repetition, pleasantries, mail signatures, boilerplate, and narration that carries no fact.\n` +
            `Output ONLY the rewritten material — no preamble, no commentary, no description of what you changed.\n\n` +
            `=== MATERIAL ===\n${chunk}`;
    }

    // THE GUARD THAT MAKES CONDENSING LOGS SURVIVABLE.
    //
    // Condensing prose loses wording. Condensing LOG text can lose the only thing a forensic
    // answer is worth anything for — the exact citation — and a model asked to shorten a log
    // block will happily produce "setup.log:Line 103679" for a line that is not there. A
    // fabricated citation is indistinguishable from a real one downstream, so every line
    // reference that comes back is checked against the material it came from, and the ones
    // that cannot be found are NAMED rather than quietly deleted: an engineer who is told a
    // citation is unverified can go and look, and one who is told nothing cannot.
    function flagUnsupportedCitations(condensed, source) {
        const text = String(condensed || '');
        const src = String(source || '');
        const seen = new Set();
        const bad = [];
        const re = /\bline\s+(\d{1,9})\b/gi;
        let m;
        while ((m = re.exec(text))) {
            const n = m[1];
            if (seen.has(n)) continue;
            seen.add(n);
            if (!new RegExp('\\bline\\s+' + n + '\\b', 'i').test(src)) bad.push(n);
        }
        if (!bad.length) return text;
        return text + `\n[CONDENSED BLOCK — ${bad.length} line citation(s) (${bad.slice(0, 6).join(', ')}) could not be matched to the source material. Re-verify before quoting them.]`;
    }

    const bridgeAdapter = {
        id: 'bridge',
        label: 'Copilot browser bridge (no API key)',

        model() {
            const t = CONFIG.bridge.target;
            return (BRIDGE_TARGETS[t] && BRIDGE_TARGETS[t].label) || 'Browser bridge';
        },

        configured() {
            return typeof chrome !== 'undefined' && !!(chrome.tabs && chrome.scripting);
        },

        targetUrl() {
            const c = CONFIG.bridge;
            if (c.url) return c.url;
            // Falls back to m365 — the only entry — rather than to a named alternative,
            // because there is no longer an alternative to name. A stored target from an
            // older build ('copilot', 'claude', 'chatgpt') lands here and resolves to the
            // tenant service, which is the correct outcome: those destinations are gone.
            return (BRIDGE_TARGETS[c.target] || BRIDGE_TARGETS.m365).url;
        },

        // A chat UI has one input box, not a role-tagged message array. Flatten to a single
        // prompt that keeps the system rules visibly separated from the request — the panel's
        // system message IS the instruction set, so burying it would change every answer.
        // Flatten to one prompt, and FIT IT to the composer rather than refusing.
        //
        // Refusing was the first design: over the cap, return 413. But the panel has paths
        // that build their own prompts without passing through the chat trimmer, so a
        // perfectly ordinary case analysis came back as an error instead of an answer. A
        // hard refusal makes the provider unusable; a silent truncation analyses half a
        // case and looks fine. Trimming with the cut DECLARED — the same discipline the
        // panel's own trimmer uses — is the only honest option.
        //
        // Order of sacrifice mirrors the panel's: the conversation history goes first, then
        // the tail of the instructions (where case data and research sit, after the rules).
        // The request itself is never touched.
        flattenToPrompt(messages, cap) {
            const flat = flattenMessages(messages);
            const system = flat.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
            const turns = flat.filter(m => m.role !== 'system');
            const last = turns[turns.length - 1];

            // A chat titles itself from the opening words of the first message. Leading with
            // the case number means the sidebar reads "C01720260 · SOTI AI Ana…" — the case
            // is identifiable at a glance even after the title is truncated, which is what
            // makes keeping these conversations worth more than deleting them. The marker
            // stays in the line so the cleanup sweep can still recognise its own work.
            const TITLE = (CONVERSATION_LABEL
                ? `${CONVERSATION_LABEL} · SOTI AI Analyser`
                : 'SOTI AI Analyser — automated request.') + '\n\n';
            const HEAD = TITLE + '=== INSTRUCTIONS (follow these exactly) ===\n';
            const request = '=== REQUEST ===\n' + (last ? last.content : '');
            const history = turns.length > 1
                ? '=== CONVERSATION SO FAR ===\n' + turns.slice(0, -1)
                    .map(m => `${m.role === 'assistant' ? 'ASSISTANT' : 'ENGINEER'}: ${m.content}`).join('\n\n')
                : '';
            const NOTICE = '\n\n[Context trimmed to fit this chat input — everything above is complete. If something you need is missing, say so rather than guessing.]';

            const join = (sys, hist) => [sys ? HEAD + sys : '', hist, request].filter(Boolean).join('\n\n');

            let out = join(system, history);
            const before = out.length;
            if (!cap || out.length <= cap) return { prompt: out, trimmed: 0 };

            out = join(system, '');                       // 1. drop the conversation history
            if (out.length > cap) {                       // 2. trim the instructions' tail
                const overhead = out.length - system.length;
                const room = cap - overhead - NOTICE.length;
                if (room > 500) {
                    let cut = system.lastIndexOf('\n', room);
                    if (cut < room * 0.6) cut = room;     // no line break near the limit
                    out = join(system.slice(0, cut).replace(/\s+$/, '') + NOTICE, '');
                } else {
                    out = request.slice(0, Math.max(200, cap));  // nothing left but the question
                }
            }
            return { prompt: out, trimmed: before - out.length };
        },

        // The four things a relayed prompt is made of, in the order they may be sacrificed.
        // RULES and REQUEST are fixed — an answer given without its instructions is not a
        // shorter answer, it is a different one. DATA and HISTORY are what may be split
        // across parts, condensed, or (last of all) trimmed.
        decompose(messages) {
            const flat = flattenMessages(messages);
            const system = flat.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
            const turns = flat.filter(m => m.role !== 'system');
            const last = turns[turns.length - 1];
            const cut = dataSectionIdx(system);
            return {
                rules: (cut >= 0 ? system.slice(0, cut) : system).replace(/\s+$/, ''),
                data: cut >= 0 ? system.slice(cut) : '',
                history: turns.length > 1
                    ? turns.slice(0, -1).map(m => `${m.role === 'assistant' ? 'ASSISTANT' : 'ENGINEER'}: ${m.content}`).join('\n\n')
                    : '',
                request: last ? last.content : ''
            };
        },

        /* HAND THE CASE MATERIAL OVER AS A FILE.
         *
         * decompose() already draws the only line that matters here: RULES and REQUEST are
         * the question, DATA is the evidence. The evidence is what is large — a ZIP of logs
         * is megabytes and the instructions are kilobytes — so the evidence goes into the
         * attachment and the question stays in the message. That is also the split that
         * keeps the answer correct: instructions the model has to hunt for in an uploaded
         * file compete with everything else in it, whereas instructions in the message are
         * simply the message.
         *
         * Returns null when there is nothing worth attaching, and the caller then does
         * exactly what it did before. Every decision this makes is reversible at run time:
         * `fallbackParts` carries the full text layout, and the relay swaps to it if the
         * upload will not go.
         */
        buildAttachment(messages, opts) {
            const o = opts || {};
            if (!CONFIG.bridge.attachData) return null;

            const m = o.material || this.decompose(messages);
            let data = m.data || '';
            const min = o.min != null ? o.min : (parseInt(CONFIG.bridge.attachMinChars, 10) || DEFAULTS.bridge.attachMinChars);
            const knowledge = Array.isArray(o.knowledge) ? o.knowledge.filter(k => k && k.name && k.text) : [];

            // TWO DIFFERENT REASONS TO UPLOAD, and they are not the same question.
            //
            // The CASE goes up only when it is big enough to be worth a round trip — a short
            // case belongs inline, where it costs nothing and arrives instantly.
            //
            // The PRODUCT REFERENCE has no such threshold, because it is not about this
            // case's size at all. A "how do I configure Android Enterprise enrolment" question
            // carries almost no case material and is precisely where a model that has never
            // seen SOTI's architecture needs the port matrix and the service map most. Tying
            // the reference to the case's size withheld it exactly where it helps.
            const attachCase = data.length >= min;
            if (!attachCase && !knowledge.length) return null;

            // Past the measured ceiling the tail goes, and it goes VISIBLY — inside the file,
            // where whatever reads it will see the cut. A silent truncation here would be the
            // worst failure this whole path can produce: the model would answer from a
            // partial bundle with no way for anyone downstream to know it had done so.
            const max = o.max != null ? o.max : (parseInt(CONFIG.bridge.attachMaxChars, 10) || DEFAULTS.bridge.attachMaxChars);
            let attachTrimmed = 0;
            if (attachCase && data.length > max) {
                const notice = `\n\n[CASE MATERIAL TRUNCATED — the bundle was larger than this upload supports and ${(data.length - max).toLocaleString()} characters were removed from the END of the material above. Everything above this line is complete and verbatim. Say that the case was truncated rather than treating what remains as the whole of it.]\n`;
                let at = data.lastIndexOf('\n', max - notice.length);
                if (at < (max - notice.length) * 0.6) at = max - notice.length;
                attachTrimmed = data.length - at;
                data = data.slice(0, at).replace(/\s+$/, '') + notice;
            }

            const name = attachCase ? attachmentName() : '';

            // What replaces the data in the message. It has to do two jobs: tell the model
            // the evidence is in the file, and stop it answering "no logs were provided"
            // when the section it expected is not inline. The bracketed ALL-CAPS opener is
            // deliberate — it is the shape dataSectionIdx() looks for, so this pointer sits
            // where the data sat and the rules/request boundary does not move.
            // Product reference travels as its own attachment, and the pointer draws a hard
            // line between the two kinds of file. Without that line the model will happily
            // cite a product overview as though it were evidence from this customer's logs —
            // which reads exactly like a finding and is not one.
            const refNames = knowledge.map(k => `"${k.name}"`).join(', ');

            const casePointer = attachCase
                ? `[CASE MATERIAL — ATTACHED AS A FILE]\n` +
                  `The complete case material for this request is in the file "${name}" attached to this message. ` +
                  `It is the evidence for everything asked below — read it as though its contents appeared here in full.\n` +
                  `It holds ${data.length.toLocaleString()} characters. Where a log bundle was supplied, each inner file is delimited by ` +
                  `"=== FILE: <path> ===" and "=== END: <path> ===" lines; cite findings against those inner paths, not against "${name}".\n` +
                  `If you cannot read the attached file, say so plainly and stop — do not answer from the instructions alone, and do not guess what the logs contained.`
                : '';

            // The reference paragraph says the same thing either way, but what a finding must
            // be traced BACK to differs: the uploaded case file when there is one, the case
            // material in this message when there is not. Getting that wrong would point the
            // model at a file that does not exist.
            const refPointer = knowledge.length
                ? `[SOTI PRODUCT REFERENCE — ATTACHED AS A FILE]\n` +
                  `Also attached: ${refNames} — SOTI product reference (architecture, services, ports, log sources), ` +
                  `itself delimited by "=== FILE: <name> ===" markers. It is NOT this customer's data and it is NOT evidence about this case.\n` +
                  `Use it to interpret what you are given — what a log means, which service owns it, what a port is for, how a feature is meant to be configured. ` +
                  `You are FORBIDDEN from reporting anything found only in it as a finding about this case, and from citing it as evidence of what happened here. ` +
                  `Every statement about THIS case must be traceable to ${attachCase ? `"${name}"` : 'the case material in this message'}.\n` +
                  /* WHAT THE INDEX IS, AND WHAT IT IS NOT.
                   *
                   * It is a catalogue, not content: a list of every article in this engineer's
                   * Salesforce Knowledge with its number, publication status and title. Without
                   * saying so, a model that finds a promising title in it will answer FROM the
                   * title — inventing the resolution it implies, in the confident voice of an
                   * article number. Said plainly here, because a fabricated KB citation is
                   * worse than no citation: it is checkable, and it will be checked. */
                  `If "soti-kb-index.md" is among those files, it is the INDEX of this engineer's Salesforce Knowledge — ` +
                  `every article's number, publication status and title, and nothing else. The full text of the articles ` +
                  `that matter to this case is already in the request, under [SOTI SUPPORT KNOWLEDGE BASE] and ` +
                  `[OFFLINE KNOWLEDGE MATCHES]. Use the index ONLY to answer whether an article on a topic exists and to ` +
                  `name it — never to state what an article says. If the index lists something relevant whose text you were ` +
                  `not given, say so and give its number so the engineer can open it; do not infer its content from its title.`
                : '';

            const pointer = [casePointer, refPointer].filter(Boolean).join('\n\n');

            // Rebuild the prompt through the EXISTING path rather than assembling it here.
            // A synthetic message list means buildParts still owns capping, splitting and
            // trimming, so the short message cannot drift away from the rules the long one
            // obeys — and a rules block bigger than the composer still splits correctly.
            const flat = flattenMessages(messages);
            const turns = flat.filter(x => x.role !== 'system');
            // Reference-only: the case material was never large enough to upload, so it stays
            // in the message exactly where it was. Only the pointer is new, and it goes ahead
            // of the data so the instruction is read before the thing it governs.
            const systemContent = attachCase
                ? [m.rules, pointer].filter(Boolean).join('\n\n')
                : [m.rules, pointer, data].filter(Boolean).join('\n\n');
            const synthetic = [{ role: 'system', content: systemContent }].concat(turns);

            const built = this.buildParts(synthetic, { cap: o.cap, maxParts: o.maxParts, nonce: o.nonce });
            return {
                // Case material FIRST: it is the primary file, the one the upload control is
                // matched against, and the one every finding must cite.
                attachments: (attachCase ? [{ name, text: data, type: 'text/plain' }] : []).concat(knowledge),
                knowledgeChars: knowledge.reduce((n, k) => n + k.text.length, 0),
                // Whether the CASE went up as a file. The relay's ceiling trims from the end,
                // so this also says which file is first — and therefore which one survives.
                caseAttached: attachCase,
                parts: built.parts,
                chars: attachCase ? data.length : 0,
                // The message itself should now be small. Reported so a case where it is not
                // (an enormous rules block) is visible rather than merely slow.
                messageChars: built.chars || built.parts.reduce((n, p) => n + (p.text || '').length, 0),
                // What the MESSAGE lost, and separately what the FILE lost. Collapsing the
                // two would report a whole case as trimmed because a rules block wrapped.
                trimmed: built.trimmed,
                attachTrimmed
            };
        },

        // SPLIT THE CASE ACROSS THE CONVERSATION.
        //
        // flattenToPrompt above answers "what fits in the box". This answers the question
        // that actually matters, which is "what fits in the CHAT" — and those are different
        // numbers by an order of magnitude, because a conversation remembers. The prompt is
        // laid out as one ordered stream and cut into messages that each fit; every message
        // but the last says "this is reference material, do not answer yet".
        //
        // The stream is ordered case material → history → instructions → request, which is
        // NOT the single-message order. Two reasons: the request must land in the final part
        // (it is what makes that part the question), and the rules want to be as close to it
        // as possible, because instructions eight messages back compete with everything sent
        // since. Putting them last means they usually share the final message with the
        // request they govern.
        buildParts(messages, opts) {
            const o = opts || {};
            const cap = Math.max(1000, o.cap || composerCap());
            const maxParts = Math.max(1, o.maxParts || partLimit());
            const nonce = o.nonce || Math.random().toString(36).slice(2, 6);

            // One message is still one message. Below the cap — or with parts switched off —
            // nothing about this path changes, headers included: no part scaffolding is
            // added to a prompt that never needed splitting.
            const whole = this.flattenToPrompt(messages, 0).prompt;
            if (maxParts === 1 || whole.length <= cap) {
                const one = this.flattenToPrompt(messages, cap);
                return {
                    parts: [{ text: one.prompt, echoKey: '', final: true, index: 1, total: 1 }],
                    // Anything this path had to cut IS the overflow. Reporting 0 here would
                    // switch condensing off for anyone who set the part count to 1 — the
                    // configuration that needs it most, not least.
                    trimmed: one.trimmed, overflow: one.trimmed, chars: one.prompt.length
                };
            }

            const material = o.material || this.decompose(messages);
            const rules = material.rules;
            const request = material.request;
            const history = material.history;
            let data = material.data;

            const budget = cap - PART_OVERHEAD;
            const totalBudget = budget * maxParts;
            const NOTICE = '\n\n[Case material trimmed to fit this conversation — everything above is complete. If something you need is missing, say so rather than guessing.]';

            const assemble = (dataPart, historyPart) => [
                dataPart ? '=== CASE MATERIAL ===\n' + dataPart : '',
                historyPart ? '=== CONVERSATION SO FAR ===\n' + historyPart : '',
                rules ? '=== INSTRUCTIONS (follow these exactly) ===\n' + rules : '',
                '=== REQUEST ===\n' + request
            ].filter(Boolean).join('\n\n');

            const chunksFor = (b) => splitOnBoundaries(b, budget);

            let body = assemble(data, history);
            const before = body.length;
            let overflow = 0;
            // Counted where material is actually dropped, not derived from the total length
            // of the chunks: a split consumes the line break at every seam, and deriving it
            // reported four characters of loss on a case where nothing had been sacrificed.
            // "The case was trimmed" is a warning the engineer acts on — it has to be true.
            let lost = 0;
            let chunks = chunksFor(body);

            // Same order of sacrifice as everywhere else in this application: the
            // conversation history first, then the TAIL of the case material. The rules and
            // the request are never touched — an answer given without its instructions is
            // not a shorter answer, it is a different one.
            //
            // The test is the SPLIT, not the arithmetic. Comparing the body against
            // budget × parts looks equivalent and is not: a boundary-seeking split lands a
            // little under the budget on every chunk, and across several parts that
            // shortfall adds up to a whole extra message. A four-part budget duly produced
            // five parts — one more than the conversation was sized for, sent anyway.
            if (chunks.length > maxParts) {
                overflow = Math.max(1, before - totalBudget);
                body = assemble(data, '');                    // 1. the history goes first
                chunks = chunksFor(body);

                // 2. then the tail of the case material, shrunk until the split genuinely
                //    fits. Each pass removes at least what the surplus chunks are carrying,
                //    so it converges instead of creeping down by a line at a time.
                let keep = data.length;
                for (let guard = 0; guard < 10 && chunks.length > maxParts && keep > 0; guard++) {
                    const excess = chunks.slice(maxParts).reduce((n, c) => n + c.length + 1, 0);
                    keep = Math.max(0, keep - Math.max(excess, Math.ceil(budget * 0.05)) - NOTICE.length);
                    let at = keep > 0 ? data.lastIndexOf('\n', keep) : 0;
                    if (at < keep * 0.6) at = keep;
                    body = assemble(keep > 0 ? data.slice(0, at).replace(/\s+$/, '') + NOTICE : '', '');
                    chunks = chunksFor(body);
                }
                lost = Math.max(0, before - body.length);

                // Pathological, and reachable only when the rules and the request ALONE are
                // bigger than the whole conversation. Nothing that may be sacrificed is
                // left, so keep the END of the stream — the request, and as much of the
                // rules as fits — rather than the start, and say what happened. Slicing off
                // the tail instead would drop the question itself.
                if (chunks.length > maxParts) {
                    const shed = chunks.slice(0, chunks.length - maxParts);
                    lost += shed.reduce((n, c) => n + c.length, 0);
                    chunks = chunks.slice(chunks.length - maxParts);
                    chunks[0] = '[Earlier context did not fit this conversation and was dropped. Say so rather than filling the gap.]\n\n' + chunks[0];
                }
            }

            const total = chunks.length;
            const label = conversationTitle();

            const parts = chunks.map((chunk, i) => {
                const index = i + 1;
                const stamp = partStamp(nonce, index, total);
                const head = index < total
                    ? `${label} · part ${index}/${total}\n${stamp}\n` +
                      `=== CASE CONTEXT — PART ${index} OF ${total} ===\n` +
                      `Reference material for a request that arrives in part ${total}. Do not analyse it, do not summarise it, do not answer anything yet.\n` +
                      `Reply with exactly: READY ${index}/${total}\n\n`
                    : `${label} · part ${index}/${total}\n${stamp}\n` +
                      `=== FINAL PART ${index} OF ${total} — ANSWER NOW ===\n` +
                      `Parts 1-${total - 1} of this conversation are the case material for what follows. Use all of them.\n` +
                      `If any part is missing from this conversation, say so instead of answering around the gap.\n\n`;
                return { text: head + chunk, echoKey: stamp, final: index === total, index, total };
            });

            return {
                parts,
                trimmed: lost,
                overflow,
                chars: parts.reduce((n, p) => n + p.text.length, 0)
            };
        },

        /* =================================================================
         * TELL THE PAGE IT IS BEING WATCHED — BEFORE ANYTHING LOOKS AT IT
         * =================================================================
         * THIS IS THE FIX FOR "sometimes I have to click the relay window before the message
         * will send". The window opens behind everything the engineer has on screen, so Chrome
         * marks it OCCLUDED from the moment it is created: document.visibilityState is
         * 'hidden', animation frames never arrive, and M365 Copilot — an app shell that reads
         * exactly those two signals as "nobody is here" — does not finish mounting. It has no
         * composer, so injectAndConfirm's frame survey finds nothing typeable, and the run
         * fails with "No message box found" on a page that would have worked perfectly if
         * anybody had looked at it. Clicking the window un-occludes it and everything mounts
         * at once, which is precisely the behaviour that was reported.
         *
         * The liveness shim in copilot-bridge.js exists to stop all of that — but it used to
         * arrive TOO LATE TO PREVENT IT. It ships inside the bridge, and the bridge was only
         * injected into the frame that already held a visible composer. So the one thing that
         * could have made the composer appear was gated on the composer having appeared.
         *
         * So the bridge goes into EVERY frame first, for the shim rather than for the relay:
         * every frame is told it is visible and focused, the wake events are re-fired at an
         * app that had already torn itself down, and requestAnimationFrame gets its timer
         * backstop. Only then is anything asked where the message box is.
         *
         * Cheap and safe to repeat. The file guards its listener with __sotiBridgeInstalled,
         * so a second injection re-runs only the shim; and a frame the extension has no
         * permission for throws, which is caught — a cross-origin advert frame is not where
         * the composer is.
         * =============================================================== */
        async primeRelay(tabId) {
            let injected = false;
            try {
                await chrome.scripting.executeScript({
                    target: { tabId, allFrames: true },
                    files: ['copilot-bridge.js']
                });
                injected = true;
            } catch (e) {
                // Not fatal on its own: injectAndConfirm surveys next and reports a page it
                // genuinely cannot reach far better than this can.
                console.warn('[SotiAI bridge] could not pre-install the liveness shim', e && e.message);
            }

            /* AND THEN PING, WHICH IS WHAT ACTUALLY WAKES A PAGE THAT ALREADY HAD THE SHIM.
             *
             * The injection installs the shim on a document that has none. On one that has —
             * a window that has been sitting behind the engineer's since the last request, and
             * has had every chance to tear its composer down — re-running the file is very
             * nearly a no-op, because both the shim and the listener guard themselves against
             * being installed twice. The ping is the part that re-fires the wake events at it.
             *
             * Sent without a frameId so every frame that is listening answers; Chrome takes
             * the first reply and the rest still run their wake. Failure is expected and
             * ignored — on a page still loading there is nobody listening yet, which is
             * exactly the state the injection above has just started fixing. */
            try {
                await chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_PING' });
            } catch (e) { /* nothing listening yet — the survey is the real test */ }
            return injected;
        },

        /* THE CLICK, PERFORMED FOR THEM — for a window that is not minimized.
         *
         * unminimiseRelay only helps a window in the 'minimized' state. The relay's DEFAULT
         * mode opens a normal window behind the engineer's, which Chrome occludes just as
         * hard and which that function returns false for without doing anything — so the one
         * shape the report describes had no escalation at all beyond the shim.
         *
         * Focus is raised and handed straight back to the window that had it, within a couple
         * of hundred milliseconds. That is the whole of the intrusion, and it is the last
         * resort rather than the first: everything above it is invisible to the engineer.
         */
        async nudgeRelayWindow() {
            if (RELAY_WINDOW.id == null) return false;
            try {
                /* WHERE TO PUT THEM BACK, decided before the raise and never left to chance.
                 *
                 * This used to ask `getLastFocused()` here and hand focus back only if the
                 * answer was not the relay — so when the answer WAS the relay, which is what
                 * it is on the second nudge of a session and after any account read has been
                 * shuffling windows about, the hand-back was skipped altogether and the
                 * Copilot window was simply left in front of the engineer. That is the
                 * reported fault. A skipped hand-back is not a safe default: raising a window
                 * and then declining to lower it is the one outcome this whole dance exists
                 * to avoid. */
                await noteHomeWindow();
                const w = await chrome.windows.get(RELAY_WINDOW.id);
                if (w.state === 'minimized') {
                    await chrome.windows.update(RELAY_WINDOW.id, { state: 'normal', focused: false });
                }
                await chrome.windows.update(RELAY_WINDOW.id, { focused: true });
                // Long enough for Chrome to paint a frame and for the page's own
                // visibilitychange handlers to run; short enough not to interrupt typing.
                // Measured off the worker's clock — a throttled panel would hold the
                // engineer's focus hostage for a minute instead of a third of a second.
                await swSleep(350);
                await refocusHomeWindow();
                return true;
            } catch (e) { return false; }
        },

        /* =================================================================
         * THE SHIM, INSTALLED BEFORE THE PAGE HAS A CHANCE TO GIVE UP
         * =================================================================
         * primeRelay above is a cure; this is the prevention, and it is the
         * difference between an app shell that has to be revived and one that
         * never goes to sleep.
         *
         * executeScript cannot run at document_start — by the time a tab has
         * settled enough to inject into, M365 Copilot's own scripts have long
         * since booted, read visibilityState, found 'hidden', and decided
         * nobody is here. Everything after that is undoing a decision that has
         * already been taken, and undoing it works most of the time, which is
         * exactly the "sometimes" in the report.
         *
         * A REGISTERED content script can run at document_start, so the page's
         * very first look at visibilityState says 'visible' and the decision is
         * never taken. Registered only while a request is actually in flight
         * and unregistered when it ends, because the alternative is spoofing
         * visibility on Copilot tabs the engineer opened for themselves, where
         * a swallowed pagehide could cost them a draft.
         *
         * persistAcrossSessions:false so a browser that dies mid-request cannot
         * leave it installed forever, and the stale-id sweep covers the same
         * case within a session. A missing host permission throws here and is
         * caught: the run then behaves exactly as it did before this existed.
         * =============================================================== */
        async registerWakeScript() {
            if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.registerContentScripts) return false;
            let origin = '';
            try { origin = new URL(this.targetUrl()).origin; } catch (e) { return false; }
            const matches = relatedOrigins(origin);
            try {
                // Re-registering an existing id is an error, and the id survives a panel
                // reload that never reached the unregister below.
                await chrome.scripting.unregisterContentScripts({ ids: [WAKE_SCRIPT_ID] });
            } catch (e) { /* it was not registered, which is the normal case */ }
            try {
                await chrome.scripting.registerContentScripts([{
                    id: WAKE_SCRIPT_ID,
                    matches,
                    js: ['copilot-bridge.js'],
                    // The whole point. Anything later has already lost the race.
                    runAt: 'document_start',
                    // The composer is routinely in a child frame, and a child frame is
                    // hidden for the same reason its parent is.
                    allFrames: true,
                    persistAcrossSessions: false
                }]);
                return true;
            } catch (e) {
                // Almost always the optional host permission not being granted yet. The
                // injection path below still covers the page; it just arrives later.
                console.warn('[SotiAI bridge] could not pre-register the liveness shim for', matches.join(', '),
                    '—', e && e.message);
                return false;
            }
        },

        async unregisterWakeScript() {
            if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.unregisterContentScripts) return;
            try { await chrome.scripting.unregisterContentScripts({ ids: [WAKE_SCRIPT_ID] }); }
            catch (e) { /* never registered, or already gone */ }
        },

        // Everything the relay leaves running, put back. Called on every way OUT of a
        // request, including the ones that never reach a driver: a request that fails
        // while opening the tab has already started the pump and registered the shim.
        // Deliberately not awaited by its callers — it must never delay or mask a result.
        stopRelayClock(tabId, gen) {
            // A stop arriving from a request that has already been overtaken must not
            // switch off the clock the NEWER one is running on. No stamp means "I am
            // the current request" — the failure paths, which return immediately.
            if (gen != null && gen !== RELAY_CLOCK_GEN) return;
            try { relayPump(tabId, false).catch(() => {}); } catch (e) {}
            try { Promise.resolve(this.unregisterWakeScript()).catch(() => {}); } catch (e) {}
        },

        // The relay's tab, in the relay's own window. Deliberately does NOT adopt a Copilot
        // tab the user already has open: the previous version navigated whatever it found,
        // which meant a tab someone was reading would jump to a new conversation mid-read.
        // The session cookie is shared, so a window of our own is signed in just the same.
        async findOrOpenTab() {
            const url = this.targetUrl();
            const mode = CONFIG.bridge.relayMode || DEFAULTS.bridge.relayMode;

            // Stamped here because this is the one place every route into the relay
            // passes through. chat() reads it back and hands it to its own stop.
            RELAY_CLOCK_GEN++;

            // Before ANY navigation below, so the document that results from it carries the
            // shim from its first line rather than from whenever we can reach it.
            await this.registerWakeScript();

            // A NEW conversation is warranted when the case changes, or when this one has
            // taken enough turns. Not on every request: one click can be several calls, and
            // starting a chat for each is what filled the sidebar with three conversations
            // per case summary.
            const caseChanged = RELAY_WINDOW.label !== CONVERSATION_LABEL;
            const tooLong = RELAY_WINDOW.turns >= MAX_TURNS_PER_CHAT;
            const wantFresh = CONFIG.bridge.newChatEachTime && (caseChanged || tooLong);

            // Reuse the window we opened last time, if it is still there.
            if (RELAY_WINDOW.id != null) {
                try {
                    const w = await chrome.windows.get(RELAY_WINDOW.id, { populate: true });
                    const tab = w && w.tabs && w.tabs[0];
                    if (tab) {
                        // Started before anything waits on this tab, because everything
                        // that waits on it — here, and inside the page — is throttled
                        // until it is running.
                        await relayPump(tab.id, true);
                        if (wantFresh) {
                            await chrome.tabs.update(tab.id, { url });
                            await waitForTabSettled(tab.id);
                            RELAY_WINDOW.label = CONVERSATION_LABEL;
                            RELAY_WINDOW.turns = 0;
                            RELAY_WINDOW.used = false;
                        }
                        RELAY_WINDOW.turns++;
                        /* EVEN A REUSED WINDOW NEEDS THIS. A navigation gives the tab a fresh
                         * document with none of the shim on it, and a window that has sat
                         * behind the engineer's since the last request has spent that whole
                         * time being told nobody is watching. Both are the state the mount
                         * fails from. */
                        await this.primeRelay(tab.id);
                        return tab.id;
                    }
                } catch (e) { RELAY_WINDOW.id = undefined; }   // user closed it
            }

            if (mode === 'tab') {
                const tab = await chrome.tabs.create({ url, active: false });
                await relayPump(tab.id, true);
                await waitForTabSettled(tab.id);
                RELAY_WINDOW.label = CONVERSATION_LABEL;
                RELAY_WINDOW.turns = 1;
                RELAY_WINDOW.used = false;
                // A background tab is hidden for the same reason an occluded window is, and
                // the app shell reads it the same way.
                await this.primeRelay(tab.id);
                return tab.id;
            }

            // Remembered BEFORE the relay window exists, which is the only moment the answer
            // is certainly the engineer's own window — see HOME_WINDOW.
            await noteHomeWindow();

            // Chrome rejects a size alongside state:'minimized', so the two shapes are built
            // separately rather than merged.
            const win = await chrome.windows.create(mode === 'minimized'
                ? { url, focused: false, state: 'minimized' }
                : { url, focused: false, width: 1100, height: 900, top: 40, left: 40 });
            RELAY_WINDOW.id = win.id;
            /* AND STRAIGHT BACK. `focused: false` above is a request Windows does not honour
             * for a new window, so without this the Copilot window opens in front of whatever
             * the engineer was reading — which is the reported fault, and is exactly the
             * behaviour ocReaderRefocusHome exists to undo for the reader window. */
            await refocusHomeWindow();
            RELAY_WINDOW.label = CONVERSATION_LABEL;
            RELAY_WINDOW.turns = 1;
            RELAY_WINDOW.used = false;
            const tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
            if (tabId) {
                // The window was created behind the engineer's and is occluded from this
                // moment on, so the clock goes on before the first wait, not after it.
                await relayPump(tabId, true);
                await waitForTabSettled(tabId);
                // The moment that matters. This window was created behind the engineer's and
                // has been occluded for its entire load.
                await this.primeRelay(tabId);
            }
            return tabId;
        },

        // Start a conversation with nothing in it, in the tab that is already open.
        //
        // A multi-part request needs the whole conversation window to itself: sending 88,000
        // characters into a chat that already holds the last request's 88,000 is how the
        // site's own compaction gets triggered, and that failure is invisible from the DOM.
        // Also used between the condensation pass and the analysis, so the scratch material
        // is not sitting in the window the analysis needs.
        async startFreshConversation(tabId) {
            // Already empty — reloading it would cost a page load to arrive where we are.
            if (!RELAY_WINDOW.used) return true;
            try {
                await chrome.tabs.update(tabId, { url: this.targetUrl() });
                await waitForTabSettled(tabId);
                // The navigation replaced the document, so the shim went with the old one.
                await this.primeRelay(tabId);
                await this.injectAndConfirm(tabId);
                RELAY_WINDOW.label = CONVERSATION_LABEL;
                RELAY_WINDOW.turns = 1;
                RELAY_WINDOW.used = false;
                return true;
            } catch (e) {
                console.warn('[SotiAI bridge] could not start a fresh conversation', e);
                return false;
            }
        },

        // Send the case material through the relay to come back shorter, then hand the
        // shortened version to buildParts. Returns null when nothing needed doing.
        //
        // Every chunk that comes back is checked for citations that are not in the material
        // it was made from — see flagUnsupportedCitations. Shortening prose costs wording;
        // shortening log text can cost the exact line number the whole answer rests on, and
        // an invented one reads exactly like a real one.
        async condenseMaterial(tabId, messages, signal) {
            const m = this.decompose(messages);
            const cap = composerCap();
            const budget = (cap - PART_OVERHEAD) * partLimit();
            // What the fixed parts cost; the rest is what the material may occupy.
            const target = Math.max(2000, budget - m.rules.length - m.request.length - 600);
            let source = [m.data, m.history].filter(Boolean).join('\n\n');
            if (source.length <= target) return null;

            const chunkBudget = Math.max(800, cap - CONDENSE_OVERHEAD);
            const reach = chunkBudget * MAX_CONDENSE_CHUNKS;
            let dropped = 0;
            // Past a certain size the condensation itself takes longer than anyone will
            // wait, so the tail is cut BEFORE the passes rather than after ten of them.
            if (source.length > reach) {
                dropped = source.length - reach;
                const at = source.lastIndexOf('\n', reach);
                source = source.slice(0, at > reach * 0.6 ? at : reach);
            }

            const chunks = splitOnBoundaries(source, chunkBudget);
            const ratio = Math.min(1, target / source.length);
            const out = [];

            for (let i = 0; i < chunks.length; i++) {
                if (signal && signal.aborted) { const e = new Error('Aborted'); e.name = 'AbortError'; throw e; }
                // Recycled rather than reused: a scratch conversation that accumulates every
                // chunk starts hitting its own window on the later ones, which is exactly
                // where the material is least likely to survive.
                if (i % CONDENSE_CHUNKS_PER_CHAT === 0) await this.startFreshConversation(tabId);
                const want = Math.max(400, Math.floor(chunks[i].length * ratio));
                let text = '';
                await runRelay({
                    tabId,
                    parts: [{ text: condensePrompt(chunks[i], want, i + 1, chunks.length), echoKey: '', final: true, index: 1, total: 1 }],
                    signal,
                    requestId: 'soti-condense-' + Date.now() + '-' + i,
                    // `replace` carries the answer so far IN FULL, so it overwrites what has
                    // been buffered rather than being appended to it — see the push() helper.
                    // Appending it would give this pass the answer twice over.
                    onDelta: (d) => {
                        if (!d) return;
                        if (typeof d.replace === 'string') text = d.replace;
                        else if (d.content) text += d.content;
                    }
                });
                const got = text.trim();
                // A pass that came back EMPTY or LONGER than what went in has failed at its
                // one job. Keeping the original is the safe answer — it is at least true.
                out.push(got && got.length < chunks[i].length ? flagUnsupportedCitations(got, chunks[i]) : chunks[i]);
                console.log(`[SotiAI bridge] condensed chunk ${i + 1}/${chunks.length}: ${chunks[i].length.toLocaleString()} → ${out[i].length.toLocaleString()} chars`);
            }

            let condensed = out.join('\n\n');
            if (dropped > 0) {
                condensed += `\n\n[${dropped.toLocaleString()} characters of case material were beyond what this chat can carry and were not included. Say so rather than filling the gap.]`;
            }
            return { rules: m.rules, request: m.request, history: '', data: condensed, dropped };
        },

        // Bring the relay window back on screen. Some pages stop rendering while minimized
        // (document.hidden), which leaves every element zero-sized and the composer
        // undiscoverable — indistinguishable, from the outside, from "the site changed".
        async unminimiseRelay() {
            if (RELAY_WINDOW.id == null) return false;
            try {
                const w = await chrome.windows.get(RELAY_WINDOW.id);
                if (w.state !== 'minimized') return false;
                await noteHomeWindow();
                await chrome.windows.update(RELAY_WINDOW.id, { state: 'normal', focused: false });
                /* A window coming OUT of the minimized state is raised in front on Windows
                 * whatever `focused: false` says — the same thing that happens to a new one.
                 * This step is meant to cost the engineer nothing they can see, and without
                 * the hand-back it costs them the front of their screen. */
                await refocusHomeWindow();
                await swSleep(900);
                return true;
            } catch (e) { return false; }
        },

        /* =================================================================
         * WAKING A RELAY THAT HAS GONE QUIET
         * =================================================================
         * The reported symptom, exactly: the relay window sits doing nothing,
         * and clicking it makes everything happen at once. A window behind
         * another one is OCCLUDED — Chrome stops painting it, animation frames
         * stop arriving, and an app shell told it is hidden stops mounting and
         * rendering. Clicking un-occludes it and all of that reverses.
         *
         * copilot-bridge.js's liveness shim covers most of this from inside the
         * page. This is the escalation for what it cannot reach, and it is
         * deliberately ordered from free to intrusive:
         *
         *   1. Un-minimise, and make the relay the active tab in its own
         *      window. Costs the user nothing and cannot move their focus.
         *   2. Re-inject, which re-installs the shim on a document that was
         *      replaced (a sign-in redirect takes it with the old document) and
         *      re-fires the wake events on one that had already torn itself down.
         *   3. Raise the window for a moment and give focus straight back to
         *      where it was. This is the click the engineer has been doing by
         *      hand. It is LAST because it is the only step they can feel, and
         *      it is bounded: focus returns within a few hundred milliseconds,
         *      to the window that had it, not to a guess.
         *
         * Returns what it did, so the caller can say so rather than reporting a
         * silent relay as a dead one.
         * =============================================================== */
        async reviveRelay(tabId, { allowRaise = false } = {}) {
            const did = [];

            /* 0. THE CLOCK, FIRST AND FREE. A relay that has gone quiet is very often a
             * relay whose timers have been clamped to one a minute, and re-asserting the
             * pump both extends its deadline and restarts it if Chrome recycled the
             * service worker. It costs the engineer nothing and it is the only step here
             * that can fix a page that is merely waiting on its own throttled clock. */
            await relayPump(tabId, true);

            /* 1. On screen, and the tab in front within its OWN window.
             *
             * Both halves are guarded on the relay having a window of its own. In 'tab' mode
             * the relay is a background tab in the window the engineer is working in, and
             * activating it would yank their browser to a Copilot conversation mid-sentence —
             * a far worse interruption than the stall it is trying to fix. */
            const ownWindow = RELAY_WINDOW.id != null;
            try {
                if (ownWindow) {
                    const w = await chrome.windows.get(RELAY_WINDOW.id);
                    if (w.state === 'minimized') {
                        await chrome.windows.update(RELAY_WINDOW.id, { state: 'normal', focused: false });
                        did.push('un-minimised');
                    }
                    await chrome.tabs.update(tabId, { active: true });
                }
            } catch (e) { /* window or tab gone — the caller's own guards catch that */ }

            // 2. Re-assert the shim. The ping's reply says whether the page had lost it and
            //    whether Chrome is still refusing to paint the window.
            let probe = null;
            try {
                // frameIds and allFrames are mutually exclusive to this API — passing both,
                // even with one undefined, is rejected outright. Built as one or the other.
                const target = BRIDGE_FRAME.id != null
                    ? { tabId, frameIds: [BRIDGE_FRAME.id] }
                    : { tabId, allFrames: true };
                await chrome.scripting.executeScript({ target, files: ['copilot-bridge.js'] });
                probe = await chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_PING' },
                    BRIDGE_FRAME.id != null ? { frameId: BRIDGE_FRAME.id } : undefined);
                if (probe && probe.woke) did.push('re-installed the liveness shim');
            } catch (e) { /* an unreachable relay is reported by the caller */ }

            /* 3. THE CLICK, DONE FOR THEM — and only when the page says it is still not being
             *    painted. Raising a window is the one thing here the engineer can feel, so it
             *    is not spent on a relay that is merely thinking. */
            if (allowRaise && ownWindow && probe && probe.occluded) {
                // One implementation of the focus dance, shared with the startup escalation in
                // injectAndConfirm — two copies of "raise it and hand focus straight back"
                // is two places for the hand-back to be forgotten, and forgetting it means
                // yanking the engineer's browser to a Copilot window mid-sentence.
                if (await this.nudgeRelayWindow()) did.push('raised the relay window and gave focus back');
            }

            return { did, probe };
        },

        // Inject the relay and PROVE it is listening before trusting it with a prompt.
        //
        // executeScript resolving only means the file ran once. M365 Copilot arrives via a
        // redirect chain (fromCode=…&redirectId=…), so the document that was injected can be
        // replaced moments later — taking the message listener with it. The ASK then goes
        // nowhere: no DONE, no ERROR, and the panel sits on a thinking dot until the timeout.
        // A ping after injection turns that silent hang into a retry.
        // Find the frame that actually holds the chat, inject only into that one, and prove
        // it is listening.
        //
        // Two separate traps live here. executeScript resolving means the file ran once —
        // but a sign-in redirect can replace the document moments later, taking the message
        // listener with it, so the prompt goes nowhere and the panel hangs. And M365 Copilot
        // is an app shell: the composer is frequently in a CHILD FRAME, where a top-frame-only
        // injection can never see it, which surfaces as "no message box found" on a page that
        // visibly has one. Surveying every frame fixes the second and makes the first loud.
        /* HOW LONG TO KEEP LOOKING FOR THE COMPOSER.
         *
         * Five fixed attempts 1.5s apart was seven and a half seconds, and it was the second
         * half of the "I have to click the window" fault: a cold M365 Copilot load in a window
         * Chrome is not painting takes considerably longer than that to mount, so the survey
         * ran out while the page was still coming up and reported it as a page with no message
         * box on it. A deadline rather than a count, because what is being waited for is a
         * page load, not a fixed number of tries — and the escalations below are spent AT
         * points in it rather than at the end of it, so the free ones happen while there is
         * still time for them to work.
         *
         * 40 seconds is bounded well inside the whole-request timeout and is roughly three
         * times the slowest successful cold mount measured on a background window. */
        async injectAndConfirm(tabId, opts = {}) {
            const deadline = Date.now() + (opts.timeoutMs || 40000);
            let lastSurvey = null;
            let lastErr = null;
            // Escalations, cheapest first, spent once each. Both are no-ops in 'tab' mode,
            // where the relay lives in the engineer's own window and must never be raised.
            let unminimised = false;
            let nudged = false;
            let round = 0;

            while (Date.now() < deadline) {
                round++;
                /* AND THE CLOCK IS RE-ASSERTED EVERY ROUND TOO.
                 *
                 * This costs one message and it buys two things: it extends the pump's
                 * own deadline for as long as the startup is genuinely still going, and
                 * it starts it again if Chrome recycled the service worker between
                 * rounds — which it is entitled to do at any moment, and which would
                 * otherwise leave both sides back on their clamped timers for the rest
                 * of the request. */
                await relayPump(tabId, true);

                /* THE SHIM GOES IN BEFORE THE SURVEY, EVERY ROUND.
                 *
                 * Not only on the first: a page that redirected through a sign-in between
                 * rounds has a new document with none of it, and re-injecting also re-fires
                 * the wake events at an app that tore itself down while we were waiting. This
                 * is what makes the composer exist for the survey to find. */
                await this.primeRelay(tabId);

                let probes = [];
                try {
                    probes = await chrome.scripting.executeScript({
                        target: { tabId, allFrames: true },
                        func: surveyFrame
                    });
                } catch (e) {
                    if (/must request permission|Cannot access contents/i.test(e && e.message || '')) throw e;
                    lastErr = e;
                }

                // Best frame = the one with the widest visible typeable element. Width is the
                // discriminator that matters: a chat composer spans its column, while the
                // hidden search boxes and off-screen inputs an app shell carries do not.
                let best = null;
                for (const p of probes) {
                    const r = p && p.result;
                    if (!r || !r.seen) continue;
                    lastSurvey = lastSurvey || r;
                    for (const c of r.seen) {
                        if (!c.visible) continue;
                        if (!best || c.w > best.width) best = { frameId: p.frameId, width: c.w, info: c, frame: r };
                    }
                }

                if (best) {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId, frameIds: [best.frameId] },
                            files: ['copilot-bridge.js']
                        });
                    } catch (e) { lastErr = e; }

                    const pong = await chrome.tabs
                        .sendMessage(tabId, { type: 'SOTI_BRIDGE_PING' }, { frameId: best.frameId })
                        .catch(() => null);
                    if (pong && pong.ok) {
                        BRIDGE_FRAME.id = best.frameId;
                        console.log('[SotiAI bridge] relay frame', best.frameId, best.frame.url,
                            '· composer candidate', best.info,
                            `· found on round ${round}${pong.occluded ? ' (Chrome is NOT painting this window)' : ''}`);
                        return Object.assign({ frameId: best.frameId }, pong);
                    }
                }

                /* NOTHING TYPEABLE YET — ESCALATE RATHER THAN JUST WAITING AGAIN.
                 *
                 * Ordered by what the engineer can feel. Rounds 1-2 are the shim doing its
                 * work, which costs them nothing. Round 3 restores a minimized window, which
                 * they see only if they are looking at the taskbar. Round 5 is the click,
                 * performed for them and handed straight back — the thing they have been
                 * doing by hand, and the last thing tried rather than the first. */
                if (round >= 3 && !unminimised && RELAY_WINDOW.id != null) {
                    unminimised = true;
                    if (await this.unminimiseRelay()) {
                        console.warn('[SotiAI bridge] no composer yet — restored the minimized relay window');
                    }
                } else if (round >= 5 && !nudged && RELAY_WINDOW.id != null) {
                    nudged = true;
                    if (await this.nudgeRelayWindow()) {
                        console.warn('[SotiAI bridge] no composer yet — raised the relay window for a moment '
                            + 'and gave focus straight back, so Chrome paints it and the page mounts');
                    }
                }

                /* THE WAIT BETWEEN ROUNDS, ON A CLOCK THAT IS NOT THROTTLED.
                 *
                 * This was the last place the reported fault could still happen. The
                 * panel is hidden whenever the engineer is looking at another
                 * application, and a hidden page's timers are clamped to a second — to a
                 * MINUTE after five minutes hidden. A 1.5-second wait that really takes
                 * sixty seconds spends the whole 40-second deadline on round one, so the
                 * survey looked once at a page that had not finished loading and reported
                 * it as a page with no message box. */
                await swSleep(1500);
            }

            // Nothing typeable anywhere. Describe the page rather than guessing at a cause.
            const where = lastSurvey ? `${lastSurvey.url} ("${lastSurvey.title}")` : 'the tab';
            const found = (lastSurvey && lastSurvey.seen && lastSurvey.seen.length)
                ? lastSurvey.seen.map(c => `${c.tag}${c.id ? '#' + c.id : ''}${c.visible ? '' : ' (hidden)'}`).join(', ')
                : 'nothing typeable at all';
            // WHAT WAS TRIED, not just what was not found. Every one of these steps is
            // invisible from outside, so a failure that does not list them reads as "it gave
            // up straight away" — and sends the engineer to click the window by hand for a
            // problem that is no longer the window.
            const tried = ['waited ' + Math.round((opts.timeoutMs || 40000) / 1000) + 's while re-installing the liveness shim each round'];
            if (unminimised) tried.push('restored the minimized relay window');
            if (nudged) tried.push('raised the relay window briefly and handed focus back');
            throw new Error(
                `No message box found in any frame of ${where}${lastErr ? ` (${lastErr.message})` : ''}. ` +
                `What was there: ${found}. ` +
                `Tried: ${tried.join('; ')}. ` +
                `If the page shows a composer, you are most likely NOT SIGNED IN in that window — open it and check — or it is in a cross-origin frame this extension has not been granted, or the site needs a custom selector under Settings (⚙) → Bridge selectors.`);
        },

        async chat(payload, init) {
            if (!this.configured()) {
                return errorResponse(400, 'The browser bridge needs the Chrome extension (it cannot run on the standalone page).');
            }

            let tabId;
            // Which run of the relay clock this request owns — see RELAY_CLOCK_GEN.
            // Read after findOrOpenTab, which is what stamps it.
            let clockGen = null;
            try {
                tabId = await this.findOrOpenTab();
                clockGen = RELAY_CLOCK_GEN;
                // Check the permission against where the tab ACTUALLY ended up, which after
                // a sign-in redirect is not the origin that was configured. Doing it here,
                // before executeScript, turns Chrome's opaque "manifest must request
                // permission" into a message naming the host that is really missing.
                let landedOrigin = '';
                try { landedOrigin = new URL((await chrome.tabs.get(tabId)).url).origin; } catch (_) {}
                if (landedOrigin && chrome.permissions &&
                    !(await chrome.permissions.contains({ origins: [landedOrigin + '/*'] }))) {
                    needsPermission([landedOrigin + '/*']);
                    this.stopRelayClock(tabId);
                    // The old text here promised the grant would ask for copilot.microsoft.com
                    // and m365.cloud.microsoft together. It asks for m365 alone now, and the
                    // extension is not permitted to reach anywhere else — so a redirect to a
                    // host outside the tenant is not a grant the analyst can give.
                    return errorResponse(403,
                        `Signing in redirected the tab to ${landedOrigin}, which this extension has not been granted access to.\n\n` +
                        `The relay is only permitted to reach m365.cloud.microsoft. If that is where you landed, use Settings (⚙) → AI Provider → "Grant access". If it is not, sign in to Microsoft 365 in a normal tab first and try again — the relay will not follow a case to another host.`);
                }
                try {
                    await this.injectAndConfirm(tabId);
                } catch (hunt) {
                    /* ONE LAST LOOK, AFTER THE WINDOW HAS DEFINITELY BEEN PAINTED.
                     *
                     * injectAndConfirm now escalates on its own — it re-installs the shim
                     * every round, restores a minimized window, and raises the window for a
                     * moment. This is the backstop for the case where all of that ran and the
                     * page still had not mounted: raise it once more and give it a short,
                     * fresh window to come up in. Beyond this the fault is not occlusion —
                     * it is a sign-in wall, a redesign, or a frame we cannot reach — and the
                     * message from the first attempt says so. */
                    if (!/No message box found/i.test(hunt && hunt.message || '')) throw hunt;
                    const woke = (await this.unminimiseRelay()) || (await this.nudgeRelayWindow());
                    if (!woke) throw hunt;
                    console.warn('[SotiAI bridge] nothing found while the window was unpainted — brought it forward and retrying');
                    await this.injectAndConfirm(tabId, { timeoutMs: 20000 });
                }
            } catch (e) {
                const raw = (e && e.message) ? e.message : String(e);
                // Nothing below this point will reach a driver, so the pump and the
                // registered shim have to come off here or they run to their own ceiling.
                this.stopRelayClock(tabId);
                // Chrome's wording here ("Extension manifest must request permission to
                // access this host") describes the manifest, so it reads like a packaging
                // bug the user cannot fix. It is almost always just an ungranted OPTIONAL
                // permission — one button away. Say which host, and which button.
                if (/must request permission|Cannot access contents/i.test(raw)) {
                    let origin = '(unknown)';
                    try { origin = new URL(this.targetUrl()).origin; } catch (_) {}
                    needsPermission(relatedOrigins(origin));
                    return errorResponse(403,
                        `Chrome has not granted this extension access to ${origin}, so it cannot read that tab.\n\n` +
                        `Fix: Settings (⚙) → AI Provider → "Grant access to ${origin}" and accept Chrome's prompt. ` +
                        `If no prompt appears, the extension is running an older manifest.json — reload it at chrome://extensions and try again.`);
                }
                return errorResponse(502,
                    `Couldn't open the ${this.model()} tab for the bridge: ${raw}. ` +
                    `Check you are signed in to that site, then press "Grant access" in Settings (⚙).`);
            }

            const requestId = 'soti-bridge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const signal = init && init.signal;
            const DIAG = [];
            LAST_BRIDGE_DIAG.length = 0;

            /* ---- FIT THE CASE TO THE CONVERSATION ---------------------------------
             * Four tiers, cheapest first. ATTACH it as a file; failing that split it across
             * parts; if it is bigger than every part put together, condense it; if it is
             * bigger than the condenser can reach, trim the tail and say so. Each tier is
             * only reached when the one above it has genuinely run out of room.
             * -------------------------------------------------------------------- */

            // TIER ZERO — the upload. When this works none of the tiers below it apply: the
            // evidence is not competing for space in a message box, so there is nothing to
            // split, nothing to condense and nothing to cut.
            //
            // Condensation is deliberately NOT probed first when attaching. It costs several
            // extra relay round trips to shrink material that is about to be uploaded whole,
            // which is minutes spent solving a problem the attachment already solved.
            let attachment = null;
            try {
                // Read once per session and cached, so this costs nothing after the first run.
                const knowledge = CONFIG.bridge.attachKnowledge ? await loadKnowledgeAttachments() : [];
                attachment = this.buildAttachment(payload.messages, knowledge.length ? { knowledge } : {});
            } catch (e) {
                // Nothing here is load-bearing — the text path below is the original one.
                console.warn('[SotiAI bridge] could not build the case attachment — sending as text', e);
                attachment = null;
            }

            let material = null;
            let condensedFrom = 0;
            try {
                const probe = attachment ? { overflow: 0 } : this.buildParts(payload.messages, {});
                if (probe.overflow > 0 && CONFIG.bridge.condenseOverflow) {
                    const before = probe.overflow;
                    console.warn(`[SotiAI bridge] the case is ${before.toLocaleString()} chars past what this conversation holds — condensing it rather than cutting it`);
                    try {
                        if (typeof window !== 'undefined' && window.dispatchEvent) {
                            window.dispatchEvent(new CustomEvent('soti-ai-prompt-condensing', { detail: { over: before } }));
                        }
                    } catch (e) { /* the console line is enough */ }
                    material = await this.condenseMaterial(tabId, payload.messages, signal);
                    condensedFrom = before;
                }
            } catch (e) {
                if (e && e.name === 'AbortError') throw e;
                // A failed condensation is not a failed request: the trimming path below is
                // exactly what would have happened without it.
                console.warn('[SotiAI bridge] condensation failed — falling back to a declared trim', e);
                material = null;
            }

            // The text layout of the same case. When attaching, this is not what gets sent —
            // it is what the relay swaps to if the upload will not go, so it has to be built
            // BEFORE the request leaves, not after it has already failed in the page.
            const fallback = attachment ? this.buildParts(payload.messages, {}) : null;

            let built = attachment || this.buildParts(payload.messages, material ? { material } : {});
            if (attachment) {
                console.info(
                    `[SotiAI bridge] ` +
                    (attachment.caseAttached
                        ? `sending ${attachment.chars.toLocaleString()} chars of case material as "${attachment.attachments[0].name}" `
                        : `case material stays inline (under the upload threshold) — `) +
                    (attachment.knowledgeChars
                        ? `${attachment.caseAttached ? 'plus' : 'attaching'} product reference (${attachment.knowledgeChars.toLocaleString()} chars) `
                        : '') +
                    `with a ${attachment.messageChars.toLocaleString()}-char message (text layout would have been ${fallback.parts.length} part(s))`);
            }
            if (built.trimmed > 0 || condensedFrom > 0) {
                // Neither is an error, but neither is nothing either: the answer is now
                // built on less than the whole case, and the engineer reading it deserves
                // to know that before they act on it.
                console.warn(`[SotiAI bridge] ${condensedFrom > 0 ? 'condensed and ' : ''}trimmed by ${built.trimmed.toLocaleString()} chars to fit ${built.parts.length} × ${composerCap().toLocaleString()}`);
                try {
                    if (typeof window !== 'undefined' && window.dispatchEvent) {
                        window.dispatchEvent(new CustomEvent('soti-ai-prompt-trimmed', {
                            detail: {
                                trimmed: built.trimmed,
                                condensed: condensedFrom,
                                cap: composerCap(),
                                parts: built.parts.length,
                                kept: built.chars
                            }
                        }));
                    }
                } catch (e) { /* the in-prompt notice still tells the model */ }
            }

            // A multi-part request needs the conversation to itself — see
            // startFreshConversation. A single message can carry on in the one that is open.
            if (built.parts.length > 1) await this.startFreshConversation(tabId);
            console.log(`[SotiAI bridge] sending ${built.parts.length} part(s), ${built.chars.toLocaleString()} chars total`);

            let cleanupAfter = null;

            // Cleanup runs AFTER the answer has been read, never before: deleting the
            // conversation navigates the tab away, which would take the answer with it.
            cleanupAfter = async () => {
                if (!CONFIG.bridge.cleanupChats) return;
                // The conversation id lives in the TOP frame's URL. The relay may be
                // running in a child frame whose own pathname says nothing about it,
                // so read it from the tab and hand it over rather than making the
                // relay guess. Broadcast to every frame too — the sidebar is not
                // necessarily in the same frame as the composer, and a frame that
                // cannot find the row aborts without touching anything.
                let conversationId = '';
                try {
                    const t = await chrome.tabs.get(tabId);
                    conversationId = conversationIdFromUrl(t && t.url);
                } catch (e) { /* fall back to the relay's own derivation */ }

                chrome.tabs.sendMessage(tabId, { type: 'SOTI_BRIDGE_CLEANUP', requestId, conversationId, max: 3 })
                    .then(r => {
                        if (r && r.ok) console.log('[SotiAI bridge] removed its conversation', r.id);
                        else console.warn('[SotiAI bridge] left its conversation in place:', r && r.why);
                    })
                    .catch(() => { /* tab gone — nothing to tidy */ });
            };

            const runDriver = async (push) => {
                let stats;
                try {
                    stats = await runRelay({
                        tabId, parts: built.parts, signal, requestId, diag: DIAG, onDelta: push,
                        attachments: attachment ? attachment.attachments : null,
                        fallbackParts: fallback ? fallback.parts : null
                    });
                } catch (e) {
                    // THE BOX MEASURED ITSELF. A site whose real limit is below the
                    // configured one used to end the request with "lower Max prompt size in
                    // Settings" — a correct instruction that leaves the engineer to guess the
                    // number and run it again. The relay reports what the box actually held,
                    // so the case is re-split to that size and sent once more. Learned, so
                    // the next request starts from the measurement rather than the guess.
                    //
                    // Only ever retried once, and only when nothing has been streamed yet:
                    // the capacity check runs before a part is submitted, so a retry cannot
                    // duplicate text the panel has already been given.
                    if (!e || !e.capacity || !e.capacity.accepted) throw e;

                    // A MEASUREMENT HAS TO BE PLAUSIBLE BEFORE IT IS BELIEVED — and this one
                    // is written to disk, so believing a bad one is not a bad request, it is a
                    // bad EVERY request from here on.
                    //
                    // The old rule was Math.max(1000, accepted × 0.95). A composer that read
                    // back near-zero — not settled yet, cleared under us, or the wrong element
                    // — therefore taught the adapter that this site holds 1,000 characters,
                    // permanently. The observed result: a 55,000-char setting silently reduced
                    // to "8 chat messages of 1,000 characters", every case gutted to ~8K, and
                    // no way to undo it from the UI.
                    //
                    // No real chat composer has a 1,000-character limit. Below the floor this
                    // is not a length limit at all, it is a failed type, and the honest thing
                    // is to report that rather than to record it as a capacity.
                    if (e.capacity.accepted < CREDIBLE_COMPOSER_CAP) {
                        console.warn(`[SotiAI bridge] the composer reported only ${e.capacity.accepted} chars accepted — treating that as a failed type, NOT as a measured limit (nothing learned)`);
                        throw e;
                    }
                    const learned = Math.floor(e.capacity.accepted * 0.95);
                    console.warn(`[SotiAI bridge] the composer held ${e.capacity.accepted.toLocaleString()} of ${e.capacity.attempted.toLocaleString()} chars — re-splitting to ${learned.toLocaleString()} and retrying`);
                    await save({ bridge: { learnedCap: learned } });
                    // Re-split whichever layout is actually being sent. Rebuilding the TEXT
                    // layout while an attachment is in flight would send the case twice —
                    // once in the file and again as the message the file replaced.
                    built = attachment
                        ? (bridgeAdapter.buildAttachment(payload.messages, { cap: learned }) || bridgeAdapter.buildParts(payload.messages, { cap: learned }))
                        : bridgeAdapter.buildParts(payload.messages, material ? { material, cap: learned } : { cap: learned });
                    await bridgeAdapter.startFreshConversation(tabId);
                    stats = await runRelay({
                        tabId, parts: built.parts, signal, diag: DIAG, onDelta: push,
                        requestId: requestId + '-r',
                        // A fresh conversation does not clear a pending attachment on M365
                        // Copilot, but attachFiles removes what it finds before uploading,
                        // so re-sending these is a re-attach, not a duplicate.
                        attachments: attachment ? attachment.attachments : null,
                        fallbackParts: fallback ? fallback.parts : null
                    });
                }
                // The answer is in hand; the conversation can go.
                if (cleanupAfter) cleanupAfter();
                return stats;
            };

            /* THE CLOCK STOPS WITH THE ANSWER, WHICHEVER WAY THE ANSWER ENDS.
             *
             * A finally rather than a line at the bottom of runDriver: an aborted request,
             * a relay that could not be woken and a composer that refused the case all
             * leave by throwing, and a pump nobody switched off would go on ticking a tab
             * for its full fifteen-minute ceiling. The wake registration comes off here
             * too, so the engineer's own Copilot tabs are only ever affected while a
             * request is genuinely running. Both are best-effort — the worker enforces the
             * ceiling regardless — so neither may mask the real outcome. */
            const driver = async (push) => {
                try {
                    return await runDriver(push);
                } finally {
                    bridgeAdapter.stopRelayClock(tabId, clockGen);
                }
            };

            // The non-streaming callers still want one finished string, so buffer the same
            // driver rather than writing the relay twice.
            if (!payload.stream) {
                let out = '';
                let stats;
                try {
                    // Same rule as the condensation pass above: a replace overwrites the buffer,
                    // because it is the whole answer so far and not the next fragment of it.
                    stats = await driver((d) => {
                        if (!d) return;
                        if (typeof d.replace === 'string') out = d.replace;
                        else if (d.content) out += d.content;
                    });
                } catch (e) {
                    if (e && e.name === 'AbortError') throw e;
                    return errorResponse(502, e && e.message ? e.message : String(e));
                }
                return jsonResponse(out, '', stats);
            }
            return streamAsNdjson(driver);
        }
    };

    /* =====================================================================
     * THE PANEL'S HALF OF THE RELAY CLOCK
     * =====================================================================
     * The side panel is a page in the engineer's window, and the moment they
     * look at another application that window is occluded and this page's
     * timers are clamped exactly like the relay's — to a second, and to a
     * MINUTE once the window has been hidden for five of them. The startup
     * sequence below runs on a 40-second deadline made of 1.5-second waits, so
     * under intensive throttling the whole of it can be spent on one wait, and
     * the relay is reported as a page with no message box on it.
     *
     * So both directions of the clock live here: swSleep borrows the service
     * worker's unthrottled timer for the panel's own waits, and relayPump asks
     * it to tick the relay tab so the page's waits are accurate too. Neither is
     * load-bearing — a worker Chrome has recycled leaves the local timer as the
     * clock, which is the behaviour this build had before — but between them
     * they are what makes a background relay behave the same as one on screen.
     * =================================================================== */

    function swSleep(ms) {
        const local = new Promise(r => setTimeout(r, ms));
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return local;
        const worker = new Promise((resolve) => {
            let p;
            try { p = chrome.runtime.sendMessage({ type: 'SOTI_SW_SLEEP', ms }); }
            catch (e) { return; }        // deliberately never resolves; `local` is the clock
            if (p && typeof p.then === 'function') p.then(() => resolve(), () => { /* same */ });
        });
        // Whichever arrives first. Neither can arrive EARLY — both are real
        // timers of the same length — so this shortens nothing, it only stops a
        // throttled panel from stretching a 1.5-second wait into a minute.
        return Promise.race([worker, local]);
    }

    // Ask the service worker to start (or stop) ticking the relay tab. Re-asserting
    // is cheap and deliberate: it extends the pump's deadline and restarts it if
    // Chrome recycled the worker mid-request.
    async function relayPump(tabId, on) {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return false;
        RELAY_PUMP_TAB = on ? tabId : null;
        try {
            await chrome.runtime.sendMessage({ type: 'SOTI_RELAY_PUMP', on: !!on, tabId });
            return true;
        } catch (e) { return false; }    // no worker; the page's own timers carry on
    }

    // Wait for the tab to STOP MOVING, not merely to report 'complete' once.
    //
    // A first-party sign-in flow is a chain: m365.cloud.microsoft/chat →
    // ?fromCode=…&redirectId=… → the real chat. 'complete' fires on the intermediate
    // hops, so listening for the first one hands back a document that is about to be
    // thrown away — along with any relay injected into it. Polling until the URL has
    // been unchanged and complete for a beat is what actually means "settled".
    async function waitForTabSettled(tabId, timeoutMs = 30000) {
        const until = Date.now() + timeoutMs;
        const STABLE_MS = 1500;
        let lastUrl = null;
        let stableSince = Date.now();
        while (Date.now() < until) {
            let t;
            try { t = await chrome.tabs.get(tabId); } catch (e) { return; }  // tab gone; caller reports it
            const url = t.url || '';
            if (url !== lastUrl) {
                lastUrl = url;
                stableSince = Date.now();
            } else if (t.status === 'complete' && Date.now() - stableSince >= STABLE_MS) {
                return;
            }
            // swSleep, not setTimeout: a throttled panel turns this 300ms poll into a
            // minute, and the loop then abandons a tab that is still loading — silently,
            // because running out of time here looks exactly like settling.
            await swSleep(300);
        }
    }

    // ONE ENTRY. The openai and anthropic adapters that stood beside this one are deleted,
    // not disabled — see the note on DEFAULTS. active() still falls back to bridge for an
    // unrecognised stored provider name, which now means every value lands here.
    const ADAPTERS = {
        bridge: bridgeAdapter
    };

    /* ---------------------------------------------------------------------
     * Public surface
     * ------------------------------------------------------------------- */
    // The relay is the fallback because it is what this build ships with: an unknown or
    // hand-edited provider name must land on something that works, not on something that
    // needs an API key nobody has entered.
    function active() { return ADAPTERS[CONFIG.provider] || ADAPTERS.bridge; }

    // The panel's whole prompt budget hangs off this number, and this is the only place it
    // can be asked. Getting it wrong in either direction is expensive: too low and a 200K
    // model is fed a fraction of the case; too high and the request is rejected outright.
    function getContextWindow(model) {
        const a = active();
        if (a.id === 'bridge') {
            // Not a real context window — it is what the CONVERSATION will swallow, which
            // is the composer's limit multiplied by the number of messages the case is
            // allowed to arrive in. Reporting the single-message cap here is what starved
            // the panel: at 12,000 characters the budgeter derived 4,800 tokens, and a log
            // analysis was left with about 5,400 characters for the whole case — less than
            // the rules block, never mind the evidence. The number the panel needs is the
            // one the case actually has to fit in.
            //
            // Reported in tokens at the panel's own 2.5 chars/token, and deliberately NOT
            // grossed up for the answer reserve the budgeter subtracts: erring low costs a
            // few percent of the budget, while erring high sends more than the parts can
            // carry and puts the trimmer back to work.
            //
            // When the case is going up as a FILE the composer arithmetic stops describing
            // the limit at all — the evidence is not competing for room in a message box.
            // This number is what the panel budgets its log content against, so leaving it
            // at the composer figure would have the panel trim a bundle down to ~37K tokens
            // and then attach the trimmed remains: the upload would work perfectly and carry
            // a case that had already been cut to fit a constraint it no longer has.
            if (CONFIG.bridge.attachData) {
                // The composer's own room is deliberately NOT added in. The panel takes this
                // number, subtracts an answer reserve and multiplies back by 2.5 — and that
                // round trip is not symmetric, so adding the message's room here lands the
                // panel's budget just ABOVE attachMaxChars and every large case would come
                // back marked "truncated" for the sake of a few thousand characters.
                const room = parseInt(CONFIG.bridge.attachMaxChars, 10) || DEFAULTS.bridge.attachMaxChars;
                return Math.max(4096, Math.floor(room / 2.5));
            }
            const usable = (composerCap() - PART_OVERHEAD) * partLimit();
            return Math.max(4096, Math.floor(usable / 2.5));
        }
        const name = String(model || a.model() || '');
        for (const [re, len] of CTX_TABLE) if (re.test(name)) return len;
        return CLOUD_CTX_FALLBACK;
    }

    const SotiAI = {
        DEFAULTS,
        BRIDGE_TARGETS,

        load,
        save,
        get config() { return CONFIG; },
        set config(v) { CONFIG = merge(DEFAULTS, v || {}); },

        providerId() { return active().id; },
        // Does the case material leave as a FILE rather than as message text? The panel
        // budgets its prompt very differently when it does: an attachment is not competing
        // for room in a message box, so the composer-shaped limits stop applying to the
        // evidence. Asked of the provider rather than inferred, because only the provider
        // knows whether the attachment path is both selected and enabled.
        attachesCaseData() { return active().id === 'bridge' && !!CONFIG.bridge.attachData; },
        providerLabel() { return active().label; },
        isConfigured() { return !!active().configured(); },
        activeModel() { return active().model(); },
        getContextWindow,

        // The one call every AI path in sidepanel.js goes through.
        async chat(payload, init) {
            return active().chat(payload, init || {});
        },

        lastBridgeDiag() { return LAST_BRIDGE_DIAG.slice(); },

        // Sweep the relay's own conversations on demand — the same routine the automatic
        // cleanup uses, with a bigger allowance, so a backlog can be cleared in one go and
        // any failure is reported somewhere the user can actually see it.
        async cleanupBridgeChats(max) {
            if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
                throw new Error('The browser bridge needs the Chrome extension.');
            }
            const tabId = await bridgeAdapter.findOrOpenTab();
            await bridgeAdapter.injectAndConfirm(tabId);
            let conversationId = '';
            try {
                const t = await chrome.tabs.get(tabId);
                conversationId = conversationIdFromUrl(t && t.url);
            } catch (e) { /* the title anchor does not need it */ }
            const r = await chrome.tabs.sendMessage(tabId, {
                type: 'SOTI_BRIDGE_CLEANUP',
                requestId: 'manual-' + Date.now(),
                conversationId,
                max: max || 25
            });
            return r || { ok: false, removed: 0, why: 'the relay did not answer' };
        },

        // Exposed so the prompt-fitting rules can be checked without a browser.
        bridgeFlatten(messages, cap) { return bridgeAdapter.flattenToPrompt(messages, cap); },
        bridgeParts(messages, opts) { return bridgeAdapter.buildParts(messages, opts || {}); },
        bridgeAttachment(messages, opts) { return bridgeAdapter.buildAttachment(messages, opts || {}); },
        bridgeDecompose(messages) { return bridgeAdapter.decompose(messages); },
        // The reference attachment carries the Knowledge INDEX, which a sync rewrites. Both
        // exposed: the panel drops the cache after a sync, and the index slice is checkable
        // against a real corpus without a browser.
        clearKnowledgeCache,
        kbIndexBlock,
        bridgeSplit(text, budget) { return splitOnBoundaries(text, budget); },
        bridgeFlagCitations(condensed, source) { return flagUnsupportedCitations(condensed, source); },
        // What the case actually has to fit in, and what one message may carry.
        bridgeBudget() {
            const cap = composerCap();
            const parts = partLimit();
            return { cap, parts, overhead: PART_OVERHEAD, perPart: cap - PART_OVERHEAD, total: (cap - PART_OVERHEAD) * parts };
        },
        conversationIdFromUrl,

        // Set by the panel before each request, from the open case.
        setConversationLabel(label) { CONVERSATION_LABEL = String(label || '').trim().slice(0, 40); },
        conversationLabel() { return CONVERSATION_LABEL; },

        // The origin the bridge needs read access to, and whether Chrome has granted it.
        bridgeOrigin() {
            try { return new URL(bridgeAdapter.targetUrl()).origin; } catch (e) { return ''; }
        },
        async bridgeAccessGranted() {
            const origin = this.bridgeOrigin();
            if (!origin) return false;
            if (typeof chrome === 'undefined' || !chrome.permissions) return false;
            // Every origin in the redirect group, not just the configured one — reporting
            // "granted" while the origin the site actually lands on is missing is how the
            // settings panel ends up disagreeing with the error message.
            try { return await chrome.permissions.contains({ origins: relatedOrigins(origin) }); }
            catch (e) { return false; }
        },

        // Open the relay tab, inject, and ask it what it can see — WITHOUT sending a
        // prompt. This is what separates the three ways the bridge fails, which
        // otherwise all surface as the same silence: no host permission, no injection,
        // or an injected relay that cannot find the composer.
        async pingBridge() {
            if (typeof chrome === 'undefined' || !chrome.tabs || !chrome.scripting) {
                throw new Error('The browser bridge needs the Chrome extension (it cannot run on the standalone page).');
            }
            const url = bridgeAdapter.targetUrl();
            const origin = new URL(url).origin;
            if (chrome.permissions && !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) {
                throw new Error(`Chrome has not granted this extension access to ${origin}. Press Save in Settings and allow it when prompted.`);
            }
            const tabId = await bridgeAdapter.findOrOpenTab();
            // injectAndConfirm does the frame hunt and the liveness check, and throws with
            // a page description when there is nothing to type into — which is exactly what
            // this button needs to report.
            return await bridgeAdapter.injectAndConfirm(tabId);
        },

        // Chrome only lets an extension ask for optional host permissions from a user
        // gesture, so this is called straight from the settings Save/Grant click.
        async ensurePermissions() {
            if (typeof chrome === 'undefined' || !chrome.permissions) return true;
            // One branch, because there is one adapter. The openai and anthropic branches
            // that stood here asked Chrome for api.openai.com and api.anthropic.com; both
            // are deleted along with the adapters, so the only origin this build can ever
            // request is the relay's own.
            const origins = [];
            try { origins.push(...relatedOrigins(new URL(bridgeAdapter.targetUrl()).origin)); } catch (e) {}
            if (!origins.length) return true;
            try {
                if (await chrome.permissions.contains({ origins })) return true;
                return await chrome.permissions.request({ origins });
            } catch (e) {
                console.warn('[SotiAI] permission request failed', e);
                return false;
            }
        },

        // One line for the badge tooltip and the settings status strip.
        describe() {
            const a = active();
            if (!a.configured()) return `${a.label} — not configured`;
            return `${a.label} — ${a.model()}`;
        }
    };

    // Load marker. If this line is missing from the side panel's console, ai-provider.js did
    // not load at all — and there is then NO backend, because this file is the only path to
    // one. The panel warns about that on boot; this is how to confirm it.
    if (typeof window !== 'undefined') {
        console.log('%c[SOTI AI Analyser] ai-provider.js loaded — provider: bridge (Microsoft 365 Copilot) — the only one in this build', 'color:#22c55e');
        window.SotiAI = SotiAI;
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = SotiAI;
})();
