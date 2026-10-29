/* ============================================================================
 * QA Tool — BACK UP AND RESTORE
 * ============================================================================
 * Everything this tool keeps — every review, chat, coaching row and setting —
 * written to one JSON file, and read back in from one.
 *
 * This used to share a file with the GitHub update check. That check is gone,
 * along with its button, its dot, its dialog and its permission for
 * api.github.com: a new build arrives by replacing the folder, as the SOTI AI
 * Analyser's does, and nothing in this tool asks the internet whether there is
 * one. The backup stays because the moment it matters is the same moment —
 * a profile being rebuilt, or a move to another laptop.
 *
 * WHY THE REVIEWS SURVIVE A NEW FOLDER. The manifest carries a `key`, which pins
 * the extension ID. Without one, Chrome derives an unpacked extension's ID from
 * its folder path — and this folder is named for its version, so every release
 * would hand the new build an empty chrome.storage. The key keeps the ID the
 * same across every rename; this file is the belt to those braces.
 * ========================================================================== */
(function () {
    'use strict';

    function isExt() {
        return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
    }

    function say(msg, kind, ms) {
        // The panel owns the toast; asked for rather than assumed, so load order is free.
        if (typeof window.qaToast === 'function') window.qaToast(msg, kind, ms);
        else console.log('[Backup]', msg);
    }

    function installedVersion() {
        try {
            if (isExt() && chrome.runtime.getManifest) return chrome.runtime.getManifest().version || '';
        } catch (e) { /* no manifest outside the extension */ }
        return '';
    }

    /* EVERYTHING, read with `null`, rather than a list of keys. A named list is a list
     * somebody has to remember to add to, and the one time it matters is the one time it was
     * forgotten — a backup that silently omits the chats is worse than no backup, because it
     * is trusted. */
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
            const keys = Object.keys(payload.local || {}).length;
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
            say(`Backup written — ${keys} stored key(s), including every review and chat.`, 's', 9000);
        } catch (e) {
            say('Could not write the backup: ' + ((e && e.message) || e), 'e', 10000);
        }
    }

    /* RESTORING IS ADDITIVE AND IT SAYS SO. It writes the keys the file holds and leaves
     * everything else alone, so restoring an old backup cannot silently delete work done
     * since. Nothing is merged INSIDE a key — a restored review list replaces the review
     * list — because half-merging two lists of reviews would produce a third list that
     * matches neither and nobody could audit. Resolves true when something was restored. */
    async function restoreBackupFromFile(file) {
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data || data.kind !== 'qa-tool-backup') {
                say('That is not a QA Tool backup file.', 'e', 8000);
                return false;
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
            say(`Restored ${n} key(s) from ${data.at ? new Date(data.at).toLocaleString() : 'the backup'}. Reloading…`, 's', 6000);
            return n > 0;
        } catch (e) {
            say('Could not read that backup: ' + ((e && e.message) || e), 'e', 10000);
            return false;
        }
    }

    window.QaBackup = {
        backup: backupAllData,
        restore: restoreBackupFromFile
    };
})();
