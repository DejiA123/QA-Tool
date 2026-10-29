/* =============================================================================
 * QA Tool — UPDATES FROM THE SHARED FOLDER
 * =============================================================================
 * The SOTI AI Analyser's (Global 1.3.2) "Option A", the same rule in the same words. The QA
 * Tool is installed with Load unpacked from a OneDrive folder that is shared with the team and
 * kept in sync on every laptop. When a new release is put in that folder, OneDrive brings the
 * files down one by one; this file decides when the copy on disk is a COMPLETE, GENUINE new
 * release, so the extension can restart itself onto it (chrome.runtime.reload re-reads an
 * unpacked extension's folder).
 *
 * A release is applied only when ALL of these hold — otherwise nothing happens and the next
 * check looks again:
 *   1. the version in the folder's manifest.json differs from the one running (an older version
 *      counts too, so putting the previous release back is a rollback);
 *   2. integrity.json carries a valid signature by the owner's key — the same check the
 *      "✓ Verified original" line in Settings makes (INTEGRITY_PUBLIC_KEY in qa-panel.js) — so a
 *      file put in the folder by anyone else can never be pushed to every reviewer;
 *   3. integrity.json is the one made for that version, and every code file it lists matches;
 *   4. release.json, when the release carries one (it is itself covered by the signature), lists
 *      every other file of the release, and each one has arrived whole — so a half-synced folder
 *      is never loaded.
 *
 * Loaded by background.js (importScripts) and by the panel (a <script> tag): one copy of the
 * rule, used by both. It reads files only from the extension's own folder, and asks nothing of
 * the network.
 * ========================================================================== */
(function (root) {
    'use strict';
    const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgHZuCCqcKFGFujPwkocaDwObUx/bPnd17DCkJOIKIV5g0YAEnYCXLy7D+VJw9ta7OOpCMBuxNb1noBcbcvQLzQ==';
    const OWNER = 'Ayodeji Augustine';
    // What the panel shows after a restart onto a new release ("Updated to …").
    const APPLIED_KEY = 'qa_update_applied';

    const b64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const label = (m) => String((m && (m.version_name || m.version)) || '');
    // manifest.json is fingerprinted by its CONTENT, not its bytes: a browser installing the packed (.crx)
    // extension writes the file out again in its own layout. Keys sorted, no spacing — the same rule everywhere.
    const canonJson = (text) => { const c = (v) => Array.isArray(v) ? v.map(c) : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((o, k) => { o[k] = c(v[k]); return o; }, {}) : v; return JSON.stringify(c(JSON.parse(text))); };

    async function readFile(path) {
        const res = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
        if (!res.ok) throw new Error(path + ' ' + res.status);
        return res;
    }
    async function readJson(path) { return (await readFile(path)).json(); }

    // The bytes the owner signed — the same string the signing tool builds (see integrityPayload in qa-panel.js).
    function payload(rec) {
        const files = rec.files || {};
        return JSON.stringify([1, rec.by, rec.build, Object.keys(files).sort().map(k => [k, files[k]])]);
    }

    /* WHAT IS IN THE FOLDER, compared with what is running.
     * { state: 'current' | 'waiting' | 'unsigned' | 'ready' | 'unreadable', from, to, why, same }
     * `full`: also check every file when the version is the SAME as the one running — used once at
     * browser start, when the browser may have loaded the folder while OneDrive was still part-way
     * through a release (see background.js). Without it, an unchanged version is 'current' at once. */
    async function check(opts = {}) {
        const running = chrome.runtime.getManifest();
        let disk;
        try { disk = await readJson('manifest.json'); } catch (e) { return { state: 'unreadable', why: 'manifest.json could not be read' }; }
        const from = label(running), to = label(disk);
        const same = disk.version === running.version && to === from;
        if (same && !opts.full) return { state: 'current', from, to, same };
        const wait = (why) => ({ state: 'waiting', from, to, why, same });

        let rec;
        try { rec = await readJson('integrity.json'); } catch (e) { return wait('integrity.json has not arrived'); }
        if (!rec || !rec.files || !rec.sig) return wait('integrity.json is not complete');
        const subtle = crypto.subtle;
        try {
            const key = await subtle.importKey('spki', b64(PUBLIC_KEY), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const good = rec.by === OWNER && await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64(rec.sig), new TextEncoder().encode(payload(rec)));
            if (!good) return { state: 'unsigned', from, to, same, why: 'the release in the folder is not signed by ' + OWNER };
        } catch (e) { return { state: 'unsigned', from, to, same, why: 'the signature could not be checked' }; }
        // The signed list must be the one made for the version in manifest.json.
        if (String(rec.build || '') !== to) return wait('integrity.json is for ' + (rec.build || 'another build'));

        for (const [file, want] of Object.entries(rec.files)) {
            try {
                let text = (await (await readFile(file)).text()).replace(/^﻿/, '').replace(/\r\n/g, '\n');
                if (file === 'manifest.json') text = canonJson(text);
                if (hex(await subtle.digest('SHA-256', new TextEncoder().encode(text))) !== want) return wait(file + ' is still arriving');
            } catch (e) { return wait(file + ' has not arrived'); }
        }
        // Everything else in the release (icons…), byte for byte. release.json is itself in the
        // signed list above, so its contents are the owner's.
        if (rec.files['release.json']) {
            let rel;
            try { rel = await readJson('release.json'); } catch (e) { return wait('release.json has not arrived'); }
            if (String(rel.build || '') !== to) return wait('release.json is for ' + (rel.build || 'another build'));
            for (const [file, want] of Object.entries(rel.files || {})) {
                try {
                    const buf = file === 'manifest.json'
                        ? new TextEncoder().encode(canonJson((await (await readFile(file)).text()).replace(/^﻿/, '')))
                        : await (await readFile(file)).arrayBuffer();
                    if (hex(await subtle.digest('SHA-256', buf)) !== want) return wait(file + ' is still arriving');
                } catch (e) { return wait(file + ' has not arrived'); }
            }
        }
        return same ? { state: 'current', from, to, same, complete: true } : { state: 'ready', from, to };
    }

    // Restart onto the release in the folder, leaving a note for the panel to show afterwards
    // (not for a restart onto the same version, which only completes a release loaded part-way).
    async function apply(info) {
        if (info && info.from !== info.to) {
            try { await chrome.storage.local.set({ [APPLIED_KEY]: { from: info.from, to: info.to, at: Date.now() } }); } catch (e) { /* the restart still happens */ }
        }
        chrome.runtime.reload();
    }

    root.QaUpdater = { check, apply, APPLIED_KEY };
})(typeof self !== 'undefined' ? self : window);
