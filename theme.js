/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
/* ============================================================================
 * THE COLOUR THEME — Dark or Soft Slate (Beta 9.6.2)
 * ============================================================================
 * QA Tool: the SOTI AI Analyser's theme.js (Beta 9.8.6), with three changes marked (QA Tool): it recolours BOTH of the
 * QA Tool's stylesheets (styles.css and qa-styles.css), keeps its choice under 'qa_theme', and is switched in
 * Settings → Theme. Soft Slate is the default, as in the analyser.
 * -------------------------------------------------------------------------
 * The maintainer (2026-11-07): "Add the Soft Slate theme colour toggle in the AI Settings, user can select either the
 * dark mode or the light mode". Dark is the panel as it has always been: a deep navy (page #0D1321, cards #111827 and
 * #172035, the Case Info drawer #16203B) with an indigo accent. Soft Slate is the light theme shown in the design
 * proposal: a cool light-grey page (#E6EAF0), near-white cards (#F8FAFC), panels #EEF2F7, text #0F172A, the same indigo.
 *
 * NOT A SECOND STYLESHEET. Soft Slate is styles.css itself, recoloured colour by colour as the page loads (the same
 * mapping the design proposal's screenshots were made with): every layout rule stays exactly as it is, so a change to
 * styles.css is in both themes at once and the two can never drift. Light text on dark becomes dark text on light,
 * the darker a background was the lighter it becomes, tints stay tints, white on a coloured button stays white, and
 * the tier colours, the red wash, the teal Temporary card and amber Focus keep their hues, darkened where they need to
 * be read on a light ground. Colours the panel sets on elements as it runs (style="") are recoloured the same way.
 *
 * Loaded straight after styles.css (the stylesheet is in by then), so the chosen theme is on before the first paint.
 * Kept on this computer (localStorage 'qa_theme'); switched in Settings → Theme, at once and both ways.
 * Exposes window.QaTheme (and SotiTheme) { get, set }.
 * ========================================================================== */
(function () {
    'use strict';
    const KEY = 'qa_theme';
    const THEMES = ['dark', 'slate'];

    // The Soft Slate palette, as in the design proposal.
    const VARS = { bg0: '#e6eaf0', bg1: '#f8fafc', bg2: '#eef2f7', bg3: '#dfe5ee', border: 'rgba(15, 23, 42, .10)', border2: 'rgba(15, 23, 42, .17)',
        txt1: '#0f172a', txt2: '#334155', txt3: '#475569', txt4: '#748094', blue: '#4f46e5', blue2: '#4338ca', accent: '#4f46e5', green: '#15803d', warn: '#b45309' };
    const P = { ink: '15, 23, 42', shadowInk: '15, 23, 42', neutralHue: 215, neutralSat: 0.22, bgTop: 0.975, bgSpread: 0.07, textDark: 0.09, textSpread: 0.6, textOnPill: 0.97 };
    const ROOT = `:root{color-scheme:light;${Object.entries(VARS).map(([k, v]) => `--${k}:${v}`).join(';')};--green-pill:rgba(22,163,74,.12)}`
        + `html,body{background:var(--bg0)}select{color-scheme:light}select option,select optgroup{background-color:#ffffff;color:${VARS.txt1}}`;

    /* ---- one colour, dark theme → Soft Slate ---- */
    function parseColor(s) {
        s = String(s).trim().toLowerCase();
        let m;
        if ((m = /^#([0-9a-f]{3})$/.exec(s))) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
        if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s))) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
        if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(s))) {
            const a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
            return { r: +m[1], g: +m[2], b: +m[3], a };
        }
        return null;
    }
    function toHsl({ r, g, b }) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h = 0, s = 0;
        const l = (max + min) / 2;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h /= 6;
        }
        return { h: h * 360, s, l };
    }
    function fromHsl(h, s, l) {
        h = ((h % 360) + 360) % 360 / 360;
        const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
        let r, g, b;
        if (s === 0) r = g = b = l;
        else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3); }
        return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }
    const fmt = (c, a) => (a == null || a >= 1) ? `#${[c.r, c.g, c.b].map(x => x.toString(16).padStart(2, '0')).join('')}` : `rgba(${c.r}, ${c.g}, ${c.b}, ${+a.toFixed(3)})`;

    // role: 'text' (color), 'bg' (background*), 'border', 'shadow', 'other'.
    function mapColor(str, role, ctx) {
        const c = parseColor(str);
        if (!c) return str;
        const { h, s, l } = toHsl(c);
        const neutral = s < 0.22 || (l < 0.26 && s < 0.7);   // the dark navy panels are this UI's neutrals
        // White and black veils: a light veil on dark becomes a dark veil on light.
        if (c.r >= 250 && c.g >= 250 && c.b >= 250 && c.a < 1) return `rgba(${P.ink}, ${+(Math.min(1, c.a * (role === 'text' ? 1 : 0.85))).toFixed(3)})`;
        if (c.r <= 5 && c.g <= 5 && c.b <= 5 && c.a < 1) return role === 'shadow' ? `rgba(${P.shadowInk}, ${+(c.a * 0.28).toFixed(3)})` : `rgba(${P.ink}, ${+(c.a * 0.35).toFixed(3)})`;
        if (role === 'shadow') return c.a < 1 ? `rgba(${P.shadowInk}, ${+(c.a * 0.3).toFixed(3)})` : fmt(c);
        if (neutral) {
            if (role === 'text') {
                if (l > 0.94 && ctx.onSolid) return fmt(c, c.a);                 // white text on a coloured button stays white
                const L = l > 0.55 ? P.textDark + (1 - l) * P.textSpread : (l < 0.3 ? P.textOnPill : P.textDark + 0.25);
                return fmt(fromHsl(P.neutralHue, P.neutralSat * 1.6, Math.min(0.62, L)), c.a);
            }
            const L = l < 0.5 ? P.bgTop - (l / 0.5) * P.bgSpread : Math.max(0.8, 1 - (l - 0.5) * 0.4);
            return fmt(fromHsl(P.neutralHue, P.neutralSat, L), c.a);
        }
        if (role === 'text') {
            if (ctx.onSolid && l < 0.3) return fmt(c, c.a);                     // dark text on a bright pill stays
            if (l > 0.5) return fmt(fromHsl(h, Math.min(1, s * 1.05 + 0.1), Math.max(0.26, Math.min(0.4, 0.82 - l * 0.55))), c.a);
            return fmt(c, c.a);
        }
        if (role === 'bg' || role === 'border') {
            if (c.a < 1) return fmt(c, Math.min(1, c.a * (role === 'bg' ? 0.9 : 1.1)));   // tints stay tints
            if (l < 0.3) return fmt(fromHsl(h, Math.min(1, s * 0.5), 0.965 - l * 0.15)); // a dark coloured panel → a pale tint of it
            return fmt(c);
        }
        return fmt(c, c.a);
    }
    const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
    const LONE_COLOR = /^\s*(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*$/;
    function roleOf(prop) {
        prop = prop.trim().toLowerCase();
        // A colour kept in a variable: a text tint by its name (--qg-t, --temp-fg), otherwise an accent or a fill.
        if (prop.startsWith('--')) return /(?:-t|fg|txt\d*|text|ink)$/.test(prop) ? 'text' : 'border';
        if (prop === 'color' || prop === 'caret-color' || prop === 'fill' || prop === 'stroke' || prop === '-webkit-text-fill-color' || prop === 'accent-color') return 'text';
        if (prop.startsWith('background')) return 'bg';
        if (prop.includes('shadow')) return 'shadow';
        if (prop.startsWith('border') || prop.startsWith('outline')) return 'border';
        return 'other';
    }
    const SOLID_BG = /background(?:-color)?\s*:\s*(?!transparent|none|var\(--bg|rgba?\([^)]*,\s*0?\.\d+\))(#[0-9a-f]{6}|#[0-9a-f]{3}|rgb\(\s*\d+,\s*\d+,\s*\d+\s*\)|var\(--(?:blue|green|red|warn|accent)\)|linear-gradient\(\s*135deg,\s*var\(--blue)/i;
    const mapDecl = (prop, val, onSolid) => {
        if (prop.startsWith('--') && !LONE_COLOR.test(val)) return val;        // a variable that is not one colour
        const role = roleOf(prop);
        return val.replace(COLOR_RE, (col) => mapColor(col, role, { onSolid }));
    };

    // The whole stylesheet, rule by rule (innermost blocks), so "is this text on a solid coloured background?" is asked
    // of the rule it is in.
    function lightenCss(css) {
        return css.replace(/([^{}]*)\{([^{}]*)\}/g, (all, sel, body) => {
            // A rule written for Soft Slate itself (its selector names [data-theme="slate"]) is taken exactly as written:
            // it is there because the recolouring cannot see what a colour sits on (see styles.css, SOFT SLATE EXCEPTIONS).
            if (/\[data-theme=["']?slate["']?\]/.test(sel)) return all;
            const onSolid = SOLID_BG.test(body) && !/var\(--bg/.test((/background[^;]*/.exec(body) || [''])[0]);
            const mapped = body.replace(/([a-zA-Z-]+)\s*:\s*([^;]+)/g, (d, prop, val) => `${prop}: ${mapDecl(prop, val, onSolid)}`);
            return `${sel}{${mapped}}`;
        });
    }

    /* ---- the page ---- */
    let current = 'dark', styleEl = null, observer = null;
    const touched = new Set();              // elements whose style="" colours were recoloured
    const recs = new WeakMap();             // element → { prop: { from, to } }
    // (QA Tool) BOTH stylesheets, in the order the page has them: the analyser's styles.css, then qa-styles.css, which is
    // only ever additions to it. Recoloured together into one sheet, so the QA Tool's own rules still win where they did.
    const mainSheets = () => [...document.styleSheets].filter(s => s.href && /\/(?:qa-)?styles\.css(?:\?|$)/.test(s.href));
    const mainSheet = () => mainSheets()[0] || null;

    function slateCss() {
        const sheets = mainSheets();
        if (!sheets.length) return null;
        let text = '';
        try { text = sheets.map(sh => [...sh.cssRules].map(r => r.cssText).join('\n')).join('\n'); } catch (e) { return null; }
        return lightenCss(text) + '\n' + ROOT;
    }

    // One element's own colours (style=""), each from what the panel set, never from what was already recoloured.
    function mapInline(el) {
        const st = el.style;
        if (!st || !st.length) return;
        // A feed story's page is the document's own, white, in the document's colours (see THE RSS FEED IN SOFT SLATE).
        if (el.closest && el.closest('.fn-paper')) return;
        let rec = recs.get(el);
        const onSolid = SOLID_BG.test(el.getAttribute('style') || '');
        for (let i = 0; i < st.length; i++) {
            const prop = st[i];
            const val = st.getPropertyValue(prop);
            if (!val || !/#|rgb/i.test(val)) continue;
            if (rec && rec[prop] && rec[prop].to === val) continue;           // ours already
            const to = mapDecl(prop, val, onSolid);
            if (to === val) continue;
            if (!rec) { rec = {}; recs.set(el, rec); }
            rec[prop] = { from: val, to };
            st.setProperty(prop, to, st.getPropertyPriority(prop));
            rec[prop].to = st.getPropertyValue(prop);                         // as the browser writes it back
            touched.add(el);
        }
    }
    function mapTree(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.hasAttribute('style')) mapInline(root);
        root.querySelectorAll('[style]').forEach(mapInline);
    }
    function startInline() {
        mapTree(document.documentElement);
        if (observer) return;
        observer = new MutationObserver((list) => {
            if (current !== 'slate') return;
            for (const m of list) {
                if (m.type === 'attributes') mapInline(m.target);
                else m.addedNodes.forEach(mapTree);
            }
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    }
    function stopInline() {
        if (observer) { observer.disconnect(); observer = null; }
        for (const el of touched) {
            const rec = recs.get(el);
            if (!rec || !el.style) continue;
            for (const [prop, { from, to }] of Object.entries(rec)) {
                if (el.style.getPropertyValue(prop) === to) el.style.setProperty(prop, from, el.style.getPropertyPriority(prop));
            }
            recs.delete(el);
        }
        touched.clear();
    }

    function apply(theme) {
        theme = THEMES.includes(theme) ? theme : 'dark';
        const sheets = mainSheets();
        if (theme === 'slate') {
            if (!styleEl) {
                const css = slateCss();
                if (css === null) { current = 'dark'; return 'dark'; }        // the stylesheet could not be read: stay dark
                styleEl = document.createElement('style');
                styleEl.id = 'sotiThemeSlate';
                styleEl.textContent = css;
                (document.head || document.documentElement).appendChild(styleEl);
            }
            styleEl.disabled = false;
            if (styleEl.sheet) styleEl.sheet.disabled = false;
            for (const sh of sheets) sh.disabled = true;
            current = 'slate';
            startInline();
        } else {
            if (styleEl && styleEl.sheet) styleEl.sheet.disabled = true;
            for (const sh of sheets) sh.disabled = false;
            current = 'dark';
            stopInline();
        }
        document.documentElement.dataset.theme = current;
        return current;
    }

    function get() {
        // Soft Slate (light) is the default since 9.7.0 (the maintainer, 2026-11-09: "Let the light mode be the default").
        // Dark stays for whoever chose it.
        try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'slate'; } catch (e) { return 'slate'; }
    }
    function set(theme) {
        const now = apply(theme);
        try { localStorage.setItem(KEY, now); } catch (e) { /* this session only */ }
        return now;
    }

    window.SotiTheme = window.QaTheme = { get, set, current: () => current };
    apply(get());
    // Anything the page draws before the observer existed (it starts here, before the body).
    if (current === 'slate') document.addEventListener('DOMContentLoaded', () => mapTree(document.documentElement));
})();
