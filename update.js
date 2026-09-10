/* ============================================================================
 * QA Tool — THE UPDATE CHECK
 * ============================================================================
 * The button beside the version number. It asks GitHub what has been published,
 * shows the dot when that is newer than what is installed, and hands the zip to
 * Chrome's downloads.
 *
 * NOTHING HERE INSTALLS ANYTHING, and that is a platform limit rather than a
 * shortcut: an extension cannot rewrite its own folder on disk. No API exists
 * for it and none should — a program that can silently replace its own code is
 * a program you cannot reason about. So the download is a zip and the last step
 * is a person's.
 *
 * ONE HOST, AND ONLY WITH PERMISSION. Everything is read from api.github.com,
 * which hands file contents back base64-encoded — so raw.githubusercontent.com
 * is deliberately not used and is not on the allow-list. The permission is
 * OPTIONAL and is asked for on the first press of the button, never at start-up:
 * an extension that quietly acquires a network host on install is one nobody
 * should trust. The automatic check runs only AFTER that permission exists,
 * which is what makes the dot honest rather than something that appears for no
 * reason.
 *
 * WHY THE REVIEWS SURVIVE AN UPDATE. This extension's manifest carries a `key`,
 * which pins its extension ID. Without one, Chrome derives the ID of an unpacked
 * extension from its FOLDER PATH — and this folder is named for its version, so
 * every release would rename it, change the ID, and hand the new build an empty
 * chrome.storage: every review, chat and setting gone, with nothing on screen
 * saying why. The key makes the ID the same on every machine and across every
 * rename. The backup below is the belt to that pair of braces, for a profile
 * being rebuilt or a move to another laptop.
 * ========================================================================== */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const UPDATE_REPO = 'DejiA123/QA-Tool';
    const UPDATE_BRANCH = 'main';
    const UPDATE_API = 'https://api.github.com/repos/' + UPDATE_REPO;
    const UPDATE_PAGE = 'https://github.com/' + UPDATE_REPO;
    const UPDATE_ORIGIN = { origins: ['https://api.github.com/*'] };
    const UPDATE_STATE_KEY = 'qa_update_state';
    /* SIX HOURS. The check is one small request and could run far more often; it should
     * not. A new build lands every few weeks at most, so anything faster is traffic spent
     * to learn the same answer — and a dot that could appear at any moment is one people
     * stop looking at. Pressing the button ignores this and always asks. */
    const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
    /* A FAILED CHECK COMES BACK SOONER THAN A GOOD ONE. The usual failure is GitHub's rate
     * limit on unauthenticated requests, which is counted per hour and clears on its own —
     * so waiting the full six to try again turns a twenty-minute problem into a six-hour
     * one, on the day somebody is actually waiting for a build. */
    const UPDATE_RETRY_EVERY_MS = 30 * 60 * 1000;

    let updateState = null;   // { at, version, notes, zipUrl, pageUrl, from }

    function isExt() {
        return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    }

    function say(msg, kind, ms) {
        // The panel owns the toast; this file is loaded before it in one build and after it
        // in another, so it is asked for rather than assumed.
        if (typeof window.qaToast === 'function') window.qaToast(msg, kind, ms);
        else console.log('[Update]', msg);
    }

    function installedVersion() {
        try {
            if (isExt() && chrome.runtime.getManifest) return chrome.runtime.getManifest().version || '';
        } catch (e) { /* no manifest outside the extension */ }
        return '';
    }

    /* "1.0.0", "v1.0.0", "QA Tool v1.0.0" and "1.0.0-beta" all have to answer the same
     * number, because all four are how a version arrives here — a manifest field, a git tag,
     * a folder name and a release title. Anything with no digits in it is not a version and
     * comes back null rather than as [0]. */
    function parseVersion(raw) {
        const m = String(raw || '').match(/(\d+(?:\.\d+)*)/);
        return m ? m[1].split('.').map(n => parseInt(n, 10) || 0) : null;
    }

    // Part by part, a missing part counting as 0 — so 1.1 and 1.1.0 are the same build and
    // 1.1.1 is newer than both.
    function compareVersions(a, b) {
        const x = a || [], y = b || [];
        for (let i = 0; i < Math.max(x.length, y.length); i++) {
            const d = (x[i] || 0) - (y[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    }

    function isNewer(state) {
        const have = parseVersion(installedVersion());
        const want = parseVersion(state && state.version);
        return !!(have && want && compareVersions(want, have) > 0);
    }

    async function githubJson(url) {
        const res = await fetch(url, {
            // A safelisted value, so this stays a simple request and needs no preflight.
            headers: { 'Accept': 'application/vnd.github+json' },
            // A cached answer is the one thing this must never take: the whole question is
            // "what is there NOW", and a 304 from an hour ago answers a different one.
            cache: 'no-store'
        });
        if (!res.ok) {
            const err = new Error('GitHub answered ' + res.status);
            err.status = res.status;
            throw err;
        }
        return res.json();
    }

    // The contents API hands back base64 with newlines in it, and the bytes inside are UTF-8
    // — atob alone would mangle any non-ASCII character in a description field.
    function decodeContent(node) {
        const raw = String((node && node.content) || '').replace(/\s+/g, '');
        if (!raw) return '';
        const bin = atob(raw);
        const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        return new TextDecoder('utf-8').decode(bytes);
    }

    const branchZip = () => UPDATE_PAGE + '/archive/refs/heads/' + UPDATE_BRANCH + '.zip';

    /* WHAT IS PUBLISHED, ASKED THREE WAYS.
     *
     * A RELEASE FIRST, because a release is a deliberate statement that a build is ready,
     * and it is the only one of the three that can carry notes saying what changed.
     *
     * THEN A TAG, which is the same statement without the paperwork.
     *
     * THEN THE MANIFEST IN THE TREE, which is the route that works on a repository with
     * neither — and the only one of the three that cannot be wrong: a tag can be forgotten
     * and a release can be drafted and never published, but the manifest is the file being
     * shipped, and its version is the one Chrome actually reads.
     *
     * The folder holding the extension is named for its version ("QA Tool v1.0.0") and is
     * renamed on every bump, so the tree is SEARCHED rather than a path guessed — a
     * hard-coded folder name would break on the very next release, which is precisely the
     * event this exists to detect.
     */
    async function fetchLatestBuild() {
        // 1. A published release.
        try {
            const rel = await githubJson(UPDATE_API + '/releases/latest');
            const v = parseVersion(rel && (rel.tag_name || rel.name));
            if (v) {
                const asset = (rel.assets || []).find(a => /\.zip$/i.test((a && a.name) || ''));
                return {
                    version: v.join('.'),
                    notes: String(rel.body || '').trim(),
                    zipUrl: (asset && asset.browser_download_url) || rel.zipball_url || branchZip(),
                    pageUrl: rel.html_url || UPDATE_PAGE,
                    from: 'release'
                };
            }
        } catch (e) {
            /* 404 means "no releases yet", which is not a failure — it is one of the three
             * expected shapes this repository can be in. Anything else (a rate limit, a
             * network error, a repository that has moved) is real and must not be swallowed
             * into the next attempt, which would report it as a missing version rather than
             * as an error. */
            if (!(e && e.status === 404)) throw e;
        }

        // 2. A tag.
        try {
            const tags = await githubJson(UPDATE_API + '/tags?per_page=100');
            let best = null;
            for (const t of (Array.isArray(tags) ? tags : [])) {
                const v = parseVersion(t && t.name);
                if (v && (!best || compareVersions(v, best.v) > 0)) best = { v, t };
            }
            if (best) {
                return {
                    version: best.v.join('.'),
                    notes: '',
                    zipUrl: best.t.zipball_url || branchZip(),
                    pageUrl: UPDATE_PAGE + '/releases/tag/' + encodeURIComponent(best.t.name),
                    from: 'tag'
                };
            }
        } catch (e) {
            if (!(e && e.status === 404)) throw e;
        }

        // 3. The manifest in the tree.
        const tree = await githubJson(UPDATE_API + '/git/trees/' + UPDATE_BRANCH + '?recursive=1');
        const manifests = ((tree && tree.tree) || [])
            .filter(n => n && n.type === 'blob' && /(^|\/)manifest\.json$/.test(n.path || ''))
            // Depth 2 at most: "manifest.json" or "<folder>/manifest.json". Anything deeper
            // is a library's own manifest, not the extension's.
            .filter(n => n.path.split('/').length <= 2);
        if (!manifests.length) throw new Error('No manifest.json in the repository to read a version from.');

        /* MORE THAN ONE FOLDER CAN HOLD ONE, if older builds are kept beside the current
         * one. The newest is picked by the version in the FOLDER NAME first — which is what
         * that naming convention is for — and only the top few are actually read, because
         * each one is a request. */
        manifests.sort((a, b) => {
            const va = parseVersion(a.path.split('/')[0]);
            const vb = parseVersion(b.path.split('/')[0]);
            if (va && vb) return compareVersions(vb, va);
            if (va) return -1;
            if (vb) return 1;
            return 0;
        });

        let best = null;
        for (const node of manifests.slice(0, 3)) {
            try {
                const file = await githubJson(UPDATE_API + '/contents/'
                    + node.path.split('/').map(encodeURIComponent).join('/')
                    + '?ref=' + encodeURIComponent(UPDATE_BRANCH));
                const parsed = JSON.parse(decodeContent(file));
                const v = parseVersion(parsed && parsed.version);
                if (v && (!best || compareVersions(v, best.v) > 0)) best = { v, path: node.path };
            } catch (e) {
                // One unreadable manifest is not the end of the search — the next candidate
                // may well be the current build. Only an empty result after all of them is a
                // failure.
                console.warn('[Update] could not read', node.path, e);
            }
        }
        if (!best) throw new Error('Found a manifest.json but could not read a version out of it.');

        return {
            version: best.v.join('.'),
            notes: '',
            zipUrl: branchZip(),
            pageUrl: UPDATE_PAGE,
            folder: best.path.split('/').length > 1 ? best.path.split('/')[0] : '',
            from: 'manifest'
        };
    }

    /* ---------------------------------------------------------------------
     * THE PERMISSION
     * ---------------------------------------------------------------------
     * request() IS CALLED STRAIGHT OFF THE CLICK, never after an await, and that is not a
     * style choice: Chrome requires permissions.request to happen inside a user gesture, and
     * awaiting a callback API first loses it — the prompt then never appears and the call
     * resolves false, which looks exactly like the user pressing Deny. Asking for a
     * permission that is already held is free and shows no prompt, so there is nothing to
     * check first anyway.
     *
     * contains() is for the automatic check, which has no gesture behind it and must never
     * put a prompt on screen for something nobody pressed.
     * ------------------------------------------------------------------- */
    function requestPermission() {
        return new Promise((res) => {
            try { chrome.permissions.request(UPDATE_ORIGIN, (ok) => { void chrome.runtime.lastError; res(!!ok); }); }
            catch (e) { res(false); }
        });
    }

    function hasPermission() {
        return new Promise((res) => {
            try { chrome.permissions.contains(UPDATE_ORIGIN, (ok) => { void chrome.runtime.lastError; res(!!ok); }); }
            catch (e) { res(false); }
        });
    }

    async function loadState() {
        try {
            if (isExt() && chrome.storage && chrome.storage.local) {
                const got = await chrome.storage.local.get(UPDATE_STATE_KEY);
                updateState = (got && got[UPDATE_STATE_KEY]) || null;
            } else {
                const raw = localStorage.getItem(UPDATE_STATE_KEY);
                updateState = raw ? JSON.parse(raw) : null;
            }
        } catch (e) { updateState = null; }
        paintBadge();
    }

    function saveState() {
        try {
            if (isExt() && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ [UPDATE_STATE_KEY]: updateState });
                return;
            }
        } catch (e) { /* fall through */ }
        try { localStorage.setItem(UPDATE_STATE_KEY, JSON.stringify(updateState)); } catch (e) { /* best effort */ }
    }

    /* THE DOT, AND THE ONLY THING IT IS ALLOWED TO MEAN.
     *
     * It is on when a version STRICTLY GREATER than the installed one has been seen. Not
     * "different" — somebody running a build ahead of the repository, which is what the
     * person cutting the release is doing all afternoon, must not be told to downgrade. And
     * not "unknown": before the first successful check there is no dot at all, because a
     * badge that appears on install and means nothing teaches people that badges on this
     * button mean nothing. */
    function paintBadge() {
        const btn = $('btnUpdate');
        if (!btn) return;
        const have = installedVersion();
        const newer = isNewer(updateState);
        const dot = $('updDot');
        if (dot) dot.hidden = !newer;
        btn.classList.toggle('has-update', newer);
        btn.title = newer
            ? `Version ${updateState.version} is available — this is v${have}. Click to see what to do.`
            : (updateState && updateState.version
                ? `Up to date — v${have} is the newest build on GitHub. Click to check again.`
                : 'Check GitHub for a newer version of the QA Tool');
        btn.setAttribute('aria-label', newer
            ? `Update available — version ${updateState.version}`
            : 'Check for a newer version');
    }

    async function checkForUpdate(opts = {}) {
        const interactive = !!opts.interactive;
        if (!isExt()) {
            if (interactive) openModal({ error: 'Update checking needs the Chrome extension — this page has no way to reach GitHub.' });
            // 'blocked' rather than nothing: outside the extension this can never succeed, and
            // an undefined outcome would have the scheduler re-arm itself every minute for as
            // long as the page was open, asking a question with a permanent answer.
            return 'blocked';
        }

        const ok = interactive ? await requestPermission() : await hasPermission();
        if (!ok) {
            if (interactive) {
                openModal({
                    error: 'This panel cannot see what has been published without permission to reach '
                        + 'api.github.com. Press the button again and choose Allow — it is used for the '
                        + 'version check and nothing else, and the download goes through Chrome’s own '
                        + 'downloads rather than through this page.'
                });
            }
            return 'blocked';
        }

        if (interactive) openModal({ busy: true });
        try {
            const info = await fetchLatestBuild();
            updateState = Object.assign({ at: Date.now() }, info);
            saveState();
            paintBadge();
            /* THE NEW BUILD ANNOUNCES ITSELF. A dot on a button is enough when somebody is
             * looking at the button; a background check that finds a build while the
             * reviewer is working through a queue has to say so once, or the whole point of
             * checking without being asked is lost. Once per version, not once per check —
             * six-hourly nagging is how a notice gets ignored. */
            if (!interactive && isNewer(updateState) && announcedFor !== updateState.version) {
                announcedFor = updateState.version;
                say(`Version ${updateState.version} of the QA Tool is available — press the update button beside the version number.`, 'i', 12000);
            }
            if (interactive) openModal({});
            return 'ok';
        } catch (e) {
            console.warn('[Update] check failed', e);
            if (interactive) {
                openModal({
                    /* SAY WHAT TO DO, not where to go instead. The old wording sent people to
                     * a GitHub link that is no longer on this dialog — and "try again in a few
                     * minutes" is the honest advice anyway: the overwhelmingly likely cause is
                     * GitHub's rate limit on unauthenticated requests, which clears on its own. */
                    error: 'Could not read the published version — ' + ((e && e.message) || 'the request failed')
                        + '. There is a limit on how often this can be asked, so it usually just means '
                        + '"try again in a few minutes". Nothing on this panel is affected either way.'
                });
            }
            return 'fail';
        }
    }

    // Which version the panel has already announced, so a build is mentioned once rather
    // than at every check for as long as it goes uninstalled.
    let announcedFor = '';

    /* ---------------------------------------------------------------------
     * THE BACKUP
     * ---------------------------------------------------------------------
     * EVERYTHING, read with `null`, rather than a list of keys. A named list is a list
     * somebody has to remember to add to, and the one time it matters is the one time it was
     * forgotten — a backup that silently omits the chats is worse than no backup, because it
     * is trusted.
     *
     * It lives in the update dialog because updating is when it is needed: the manifest key
     * means a same-machine upgrade keeps everything, but a profile being rebuilt or a move
     * to another laptop does not, and this is the only moment anyone thinks about that.
     * ------------------------------------------------------------------- */
    async function collectBackup() {
        const payload = {
            app: 'QA Tool',
            kind: 'qa-tool-backup',
            format: 1,
            version: installedVersion(),
            at: new Date().toISOString(),
            local: {},
            localStorage: {}
        };
        try {
            if (isExt() && chrome.storage && chrome.storage.local) payload.local = await chrome.storage.local.get(null);
        } catch (e) { console.warn('[Backup] chrome.storage read failed', e); }
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k) payload.localStorage[k] = localStorage.getItem(k);
            }
        } catch (e) { console.warn('[Backup] localStorage read failed', e); }
        return payload;
    }

    async function backupAllData() {
        try {
            const payload = await collectBackup();
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            const name = `QA Tool backup ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
            const reviews = Object.keys(payload.local || {}).length;
            const done = () => setTimeout(() => URL.revokeObjectURL(url), 20000);
            if (isExt() && chrome.downloads && chrome.downloads.download) {
                chrome.downloads.download({ url, filename: name, saveAs: true }, () => {
                    void chrome.runtime.lastError;
                    done();
                });
            } else {
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
                done();
            }
            say(`Backup written — ${reviews} stored key(s), including every review and chat.`, 's', 9000);
        } catch (e) {
            say('Could not write the backup: ' + ((e && e.message) || e), 'e', 10000);
        }
    }

    /* RESTORING IS ADDITIVE AND IT SAYS SO. It writes the keys the file holds and leaves
     * everything else alone, so restoring an old backup cannot silently delete work done
     * since. Nothing is merged INSIDE a key — a restored review list replaces the review
     * list — because half-merging two lists of reviews would produce a third list that
     * matches neither and nobody could audit. */
    async function restoreBackupFromFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || data.kind !== 'qa-tool-backup') {
                say('That is not a QA Tool backup file.', 'e', 8000);
                return;
            }
            let n = 0;
            if (data.local && isExt() && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set(data.local);
                n += Object.keys(data.local).length;
            }
            if (data.localStorage) {
                for (const [k, v] of Object.entries(data.localStorage)) {
                    try { localStorage.setItem(k, v); n++; } catch (e) { /* quota, or a key we cannot write */ }
                }
            }
            say(`Restored ${n} key(s) from ${data.at ? new Date(data.at).toLocaleString() : 'the backup'}. Reload the panel to see them.`, 's', 12000);
        } catch (e) {
            say('Could not read that backup: ' + ((e && e.message) || e), 'e', 10000);
        }
    }

    /* ---------------------------------------------------------------------
     * THE DIALOG
     * ---------------------------------------------------------------------
     * Built in JavaScript rather than sitting in the HTML, because it is shown a handful of
     * times in a tool's life and its content is entirely derived from `updateState` — a
     * static skeleton would be four states' worth of hidden elements to keep in step.
     * ------------------------------------------------------------------- */
    let modal = null;

    function closeModal() {
        if (modal) { modal.remove(); modal = null; }
    }

    function openModal(opts) {
        closeModal();
        const have = installedVersion();
        const newer = isNewer(updateState);

        const back = document.createElement('div');
        back.className = 'qa-modal-back';
        const box = document.createElement('div');
        box.className = 'qa-modal qa-upd-modal';

        const title = document.createElement('div');
        title.className = 'qa-modal-title';
        title.textContent = opts.busy ? 'Checking for an update…'
            : opts.error ? 'Could not check for an update'
            : newer ? `Version ${updateState.version} is available`
            : 'You are up to date';
        box.appendChild(title);

        const note = document.createElement('div');
        note.className = 'qa-modal-note';
        if (opts.busy) {
            /* NOT "Asking <owner>/<repo>…". Where the build comes from is the maintainer's
             * business, not the reviewer's — naming it here only invites somebody to go and
             * poke at it, and it tells them nothing they can act on. */
            note.textContent = 'Checking what has been published…';
        } else if (opts.error) {
            note.textContent = opts.error;
        } else if (newer) {
            note.textContent = `You are running v${have}. `
                + `${updateState.version} is published on GitHub`
                + (updateState.from === 'manifest' ? ' (read from the manifest on the main branch).' : '.');
        } else {
            note.textContent = updateState && updateState.version
                ? `v${have} is the newest build on GitHub, checked ${new Date(updateState.at).toLocaleString()}.`
                : `You are running v${have}.`;
        }
        box.appendChild(note);

        // The release notes, when a release carried any. Scrolled rather than truncated —
        // the one place this dialog has something worth reading in full.
        if (!opts.busy && !opts.error && newer && updateState.notes) {
            const notes = document.createElement('div');
            notes.className = 'qa-upd-notes';
            notes.textContent = updateState.notes;
            box.appendChild(notes);
        }

        /* WHAT TO ACTUALLY DO WITH THE ZIP. This is the step people get wrong, and getting it
         * wrong on THIS extension used to mean losing every review — so it is written out
         * rather than left as "install the update". It no longer costs the data (the manifest
         * key pins the extension ID across a folder rename) and the instructions say so, but
         * the order still matters: unzip first, replace, then Reload. */
        if (!opts.busy && !opts.error && newer) {
            const how = document.createElement('div');
            how.className = 'qa-upd-how';
            how.innerHTML =
                '<b>How to install it</b>'
                + '<ol>'
                + '<li>Download the zip below and unzip it.</li>'
                + '<li>Copy everything from inside the unzipped folder over this extension’s folder, '
                + 'replacing what is there.</li>'
                + '<li>Go to <code>chrome://extensions</code> and press <b>Reload</b> on the QA Tool.</li>'
                + '</ol>'
                + '<div class="qa-upd-safe">Your reviews, chats and settings are kept: this extension pins its own ID '
                + 'in the manifest, so it keeps its storage even if the folder is renamed or moved. '
                + 'Back up anyway if you are rebuilding the profile or moving to another machine.</div>';
            box.appendChild(how);
        }

        const acts = document.createElement('div');
        acts.className = 'qa-modal-acts qa-upd-acts';

        if (!opts.busy && newer && updateState && updateState.zipUrl) {
            const get = document.createElement('button');
            get.className = 'btn qa-btn-primary';
            get.textContent = 'Download the update';
            get.onclick = () => {
                const url = updateState.zipUrl;
                /* THROUGH chrome.downloads, which is why the download needs no host
                 * permission of its own: the page never fetches the zip, it asks Chrome to.
                 * The fallback is a plain tab, where GitHub serves the file to the browser
                 * anyway. */
                try {
                    if (isExt() && chrome.downloads && chrome.downloads.download) {
                        chrome.downloads.download({ url, saveAs: true }, () => {
                            void chrome.runtime.lastError;
                            say('Saving the update — unzip it, replace this extension’s folder, then press Reload on chrome://extensions.', 'i', 13000);
                        });
                    } else {
                        window.open(url, '_blank', 'noopener');
                    }
                } catch (err) {
                    say('Could not start the download — try again, and if it keeps failing ask for the build directly.', 'e', 10000);
                }
            };
            acts.appendChild(get);
        }

        const backup = document.createElement('button');
        backup.className = 'btn';
        backup.textContent = 'Back up my data';
        backup.title = 'Write every review, chat and setting to a JSON file.';
        backup.onclick = () => backupAllData();
        acts.appendChild(backup);

        const restore = document.createElement('button');
        restore.className = 'btn';
        restore.textContent = 'Restore';
        restore.title = 'Read a QA Tool backup file back in. It adds to what is here rather than replacing it.';
        const file = document.createElement('input');
        file.type = 'file';
        file.accept = 'application/json,.json';
        file.style.display = 'none';
        file.onchange = () => {
            const f = file.files && file.files[0];
            file.value = '';                    // so picking the same file twice still fires
            if (f) restoreBackupFromFile(f);
        };
        restore.onclick = () => { file.value = ''; file.click(); };
        acts.appendChild(restore);
        box.appendChild(file);

        /* "Open on GitHub" USED TO SIT HERE, and it is gone deliberately.
         *
         * It was a fourth way to do the one thing this dialog already does — Download the
         * update — reached by sending somebody to a page full of source they have no reason
         * to read and a Code button that produces the same zip. The only question it
         * answered that the dialog does not is "where does this come from", which is the
         * maintainer's business rather than the reviewer's. */
        const close = document.createElement('button');
        close.className = 'btn';
        close.textContent = 'Close';
        close.onclick = () => closeModal();
        acts.appendChild(close);

        box.appendChild(acts);
        back.appendChild(box);
        document.body.appendChild(back);
        modal = back;

        // Click-outside and Escape both close: this dialog holds nothing anybody typed, so
        // there is nothing a stray click can lose.
        back.onclick = (e) => { if (e.target === back) closeModal(); };
        close.focus();
    }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal) closeModal();
    });

    /* ---------------------------------------------------------------------
     * WIRING
     * ------------------------------------------------------------------- */
    function start() {
        const btn = $('btnUpdate');
        if (btn) {
            btn.onclick = (e) => {
                e.stopPropagation();
                /* ALWAYS RE-CHECKS. The dot may be six hours old and the person pressing the
                 * button is asking the question now — showing them a remembered answer and
                 * calling it a check would be the one thing this control must not do. */
                checkForUpdate({ interactive: true });
            };
        }

        /* THE AUTOMATIC CHECK — see scheduleUpdateCheck. Delayed past boot: nothing here is
         * urgent, and start-up is competing for the same few hundred milliseconds as
         * restoring the case list and the reviews. */
        loadState().then(() => scheduleUpdateCheck(6000));
    }

    /* -------------------------------------------------------------------------
     * KEEPING THE ANSWER FRESH WITHOUT BEING ASKED
     * -------------------------------------------------------------------------
     * The old version checked ONCE, six seconds after the panel booted, and then never
     * again. A side panel that stays open all day therefore learnt about a new build the
     * next time Chrome tore the document down and rebuilt it, which on a good day is
     * tomorrow — so in practice the only way to find out was to press the button, which is
     * exactly what the dot exists to make unnecessary.
     *
     * EVERY WAKE-UP RE-READS THE CLOCK INSTEAD OF TRUSTING THE TIMER. A timer set for six
     * hours on a laptop that then sleeps for eight does not fire late — depending on how
     * the panel was suspended it may not fire at all, and if it does, the interval it
     * measured is fiction. So each firing asks updateDueIn() whether the moment has
     * actually arrived and re-arms itself if it has not, which also means pressing the
     * button in the meantime silently pushes the next background check out.
     * ----------------------------------------------------------------------- */
    let updTimer = null;
    let updBusy = false;
    let updLastTry = 0;

    const updateDueIn = () => {
        const at = (updateState && updateState.at) || 0;
        return Math.max(0, (at + UPDATE_CHECK_EVERY_MS) - Date.now());
    };

    function scheduleUpdateCheck(delay) {
        if (updTimer) clearTimeout(updTimer);
        updTimer = setTimeout(() => {
            updTimer = null;
            if (updBusy) { scheduleUpdateCheck(60 * 1000); return; }
            const wait = updateDueIn();
            if (wait > 0) { scheduleUpdateCheck(wait); return; }
            updBusy = true;
            updLastTry = Date.now();
            Promise.resolve(checkForUpdate({ interactive: false }))
                .catch(() => 'fail')
                .then((outcome) => {
                    updBusy = false;
                    /* A 'BLOCKED' OUTCOME IS NOT A FAILURE AND MUST NOT BE RETRIED LIKE ONE.
                     * Nothing about a missing permission changes on its own, and because a
                     * blocked check leaves `at` untouched, every re-arm would come back due
                     * immediately — a permission-less panel would sit in a tight poll of
                     * chrome.permissions.contains for as long as it was open. It waits the
                     * full interval instead; the moment somebody presses the button and
                     * allows it, that check writes `at` and this loop picks the answer up
                     * through updateDueIn(). */
                    const next = outcome === 'fail' ? UPDATE_RETRY_EVERY_MS
                        : outcome === 'blocked' ? UPDATE_CHECK_EVERY_MS
                        : Math.max(updateDueIn(), 60 * 1000);
                    scheduleUpdateCheck(next);
                });
        }, Math.max(0, delay || 0));
    }

    /* The panel coming back into view is the moment to notice the clock moved — the
     * sleeping-laptop case above. The five-minute floor is there so tabbing in and out of a
     * panel whose last check FAILED cannot turn every switch into another request. */
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        if (updateDueIn() > 0) return;
        if (Date.now() - updLastTry < 5 * 60 * 1000) return;
        scheduleUpdateCheck(1500);
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    /* Exposed so the version rules can be checked without a browser, and so Settings can say
     * when the last check happened.
     *
     * UPDATE_REPO AND UPDATE_PAGE ARE NOT EXPORTED, and that is the point rather than an
     * omission: the panel used to read UPDATE_REPO to print it in Settings, and the only way
     * to be sure a name is not shown is for the code that draws the screen to have no way of
     * getting at it. */
    window.QaUpdate = {
        parseVersion, compareVersions, isNewer,
        // Exposed so the scheduling can be checked without waiting six hours for it.
        dueIn: updateDueIn,
        check: checkForUpdate,
        backup: backupAllData,
        installedVersion,
        get state() { return updateState; }
    };
})();
