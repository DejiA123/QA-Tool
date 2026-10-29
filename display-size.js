/* ============================================================================
 * QA Tool — DISPLAY SIZE (the zoom)
 * ============================================================================
 * Settings → Display size, and Ctrl + / Ctrl − / Ctrl 0 from anywhere in the
 * panel. The SOTI AI Analyser's setting, done the same way and for the same
 * reason: a small laptop screen gets a side panel too narrow for the case
 * columns, so the whole tool can be drawn smaller (or larger) — text, buttons,
 * gaps and column widths together — by CSS `zoom` on the root. One number
 * scales everything in proportion, which is what "see more on one screen"
 * means; shrinking only the font would leave every fixed-width column exactly
 * as wide as it was.
 *
 * WHAT ZOOM CHANGES (measured in the analyser, and true here):
 *   - percentages still fill the panel — the layout is fine at any size;
 *   - getBoundingClientRect and pointer clientX/Y are SCREEN pixels, while
 *     style.left/top and a stored column width are the page's own and get
 *     scaled. qa-panel.js divides by zoom() wherever a screen measurement is
 *     written back as a length — the column drag and the right-click menus;
 *   - 100vw / 100vh are not adjusted, so styles.css divides them by --ui-zoom,
 *     which is set here alongside the zoom.
 *
 * LOADED IN THE <head>, BEFORE THE FIRST PAINT. localStorage keeps a copy that
 * is read synchronously right here, so a panel opened at 80% is drawn at 80%
 * rather than at 100% and then shrunk; chrome.storage.local holds the real
 * value, and every open panel follows a change made in another.
 * ========================================================================== */
(function () {
    'use strict';

    const KEY = 'qa_ui_scale';          // chrome.storage.local — the value that is kept
    const LOCAL = 'qa_ui_scale';        // localStorage — the copy read before first paint
    const SCALES = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2, 1.3];
    let scale = 1;

    function norm(v) {
        const n = Number(v);
        return SCALES.find(s => Math.abs(s - n) < 0.001) || 1;
    }

    function paintControls() {
        const sel = document.getElementById('uiScaleSel');
        if (sel) sel.value = String(scale);
        const out = document.getElementById('btnZoomOut');
        const inn = document.getElementById('btnZoomIn');
        if (out) out.disabled = scale <= SCALES[0];
        if (inn) inn.disabled = scale >= SCALES[SCALES.length - 1];
    }

    function apply(v) {
        scale = norm(v);
        const root = document.documentElement;
        if (scale === 1) { root.style.removeProperty('zoom'); root.style.removeProperty('--ui-zoom'); }
        else { root.style.zoom = String(scale); root.style.setProperty('--ui-zoom', String(scale)); }
        paintControls();
        try { localStorage.setItem(LOCAL, String(scale)); } catch (e) { /* blocked — chrome.storage still has it */ }
    }

    function set(v) {
        apply(v);
        try { chrome.storage.local.set({ [KEY]: scale }); } catch (e) { /* not in the extension */ }
    }

    // One notch smaller or larger, along the same list the menu offers.
    function step(dir) {
        const i = SCALES.indexOf(scale);
        const next = SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? SCALES.indexOf(1) : i) + dir))];
        if (next !== scale) {
            set(next);
            if (typeof window.qaToast === 'function') window.qaToast(`Display size ${Math.round(next * 100)}%`, 'i', 1600);
        }
    }

    try { apply(localStorage.getItem(LOCAL) || 1); } catch (e) { /* no localStorage */ }
    try {
        chrome.storage.local.get(KEY, (got) => {
            if (got && got[KEY] != null && norm(got[KEY]) !== scale) apply(got[KEY]);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue == null ? 1 : changes[KEY].newValue);
        });
    } catch (e) { /* not in the extension — the localStorage copy is all there is */ }

    /* CTRL + / CTRL − / CTRL 0, inside the panel. Taken before Chrome's own page zoom, which
     * in a side panel scales the page without telling it — the column drag and the menus
     * would then land off the pointer. The numeric keypad's keys count too. */
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const k = e.key;
        if (k === '+' || k === '=' || e.code === 'NumpadAdd') { e.preventDefault(); step(1); }
        else if (k === '-' || k === '_' || e.code === 'NumpadSubtract') { e.preventDefault(); step(-1); }
        else if (k === '0' || e.code === 'Numpad0') { e.preventDefault(); set(1); }
    }, true);

    function wire() {
        const sel = document.getElementById('uiScaleSel');
        if (sel) sel.onchange = () => set(sel.value);
        const out = document.getElementById('btnZoomOut');
        const inn = document.getElementById('btnZoomIn');
        if (out) out.onclick = () => step(-1);
        if (inn) inn.onclick = () => step(1);
        paintControls();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();

    window.QaDisplay = { zoom: () => scale || 1, set, step, SCALES };
})();
