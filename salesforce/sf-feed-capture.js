/* © 2026 Ayodeji Augustine. All rights reserved. SOTI AI Analyser is proprietary — see LICENSE.txt. Any change to this file breaks its signature, and the copy is then marked as modified on every screen. */
// HOW LIGHTNING ASKS FOR A FEED. Runs in the page's own world on Lightning pages, from the moment the page starts
// (registered by background.js). When Salesforce's own feed component fetches a record's feed from Salesforce's feed
// service, this notes how that request was made: the service's action, its parameters, and the page's request token.
// salesforce/sf-feed.js then asks the same service for a case's whole feed as DATA: every post's Id, its text, who it is
// visible to, and its replies. No page is drawn, scrolled or clicked for it, and no window is opened.
//
// It only watches: no request or response is changed, delayed or blocked. What it notes stays in this page's memory
// (window.__sotiFeedCapture) and is never stored or sent anywhere. A request the panel itself makes is not noted.
(() => {
  if (window.__sotiFeedCaptureInstalled) return;
  window.__sotiFeedCaptureInstalled = true;
  const keep = [];
  window.__sotiFeedCapture = keep;
  const FEEDISH = /feed|chatter/i;
  const POST_ID = /"0D5[A-Za-z0-9]{12}/;

  const json = (text) => {
    const s = String(text || '');
    const at = s.indexOf('{');
    if (at < 0) return null;
    try { return JSON.parse(s.slice(at)); } catch (e) { return null; }
  };
  const looksFeedish = (body) => {
    if (typeof body !== 'string' || !body.includes('message=')) return false;
    let head = body.slice(0, 6000);
    try { head = decodeURIComponent(head.replace(/\+/g, ' ')); } catch (e) { /* the raw text is enough */ }
    return FEEDISH.test(head);
  };

  // One finished request: keep the actions whose answer carries feed post Ids.
  function note(url, body, responseText) {
    try {
      if (window.__sotiReplaying) return;
      const form = new URLSearchParams(body);
      const message = JSON.parse(form.get('message') || '{}');
      const actions = (message.actions || []).filter((a) => a && FEEDISH.test(`${a.descriptor || ''} ${a.callingDescriptor || ''}`));
      if (!actions.length) return;
      const answer = json(responseText);
      for (const a of actions) {
        const r = ((answer && answer.actions) || []).find((x) => x && x.id === a.id);
        if (!r || r.state !== 'SUCCESS' || !POST_ID.test(JSON.stringify(r.returnValue || ''))) continue;
        keep.unshift({
          at: Date.now(),
          url: String(url),
          context: form.get('aura.context') || '',
          token: form.get('aura.token') || '',
          descriptor: a.descriptor,
          callingDescriptor: a.callingDescriptor || '',
          params: a.params || {},
        });
        if (keep.length > 6) keep.length = 6;
      }
    } catch (e) { /* never in the page's way */ }
  }

  const isAura = (url) => /\/aura(\?|$)/.test(String(url || ''));

  try {
    const X = XMLHttpRequest.prototype;
    const open = X.open;
    const send = X.send;
    X.open = function (method, url) {
      try { this.__sotiUrl = String(url || ''); } catch (e) { /* not ours to know */ }
      return open.apply(this, arguments);
    };
    X.send = function (body) {
      try {
        if (isAura(this.__sotiUrl) && looksFeedish(body) && !window.__sotiReplaying) {
          const url = this.__sotiUrl;
          const text = body;
          this.addEventListener('load', () => { try { note(url, text, this.responseText); } catch (e) { /* ignored */ } });
        }
      } catch (e) { /* the request goes on regardless */ }
      return send.apply(this, arguments);
    };
  } catch (e) { /* no XHR to watch */ }

  try {
    const f = window.fetch;
    if (typeof f === 'function') {
      window.fetch = function (input, init) {
        const p = f.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          const b = init && init.body;
          const text = typeof b === 'string' ? b : (typeof URLSearchParams !== 'undefined' && b instanceof URLSearchParams ? b.toString() : '');
          if (isAura(url) && looksFeedish(text) && !window.__sotiReplaying) {
            p.then((r) => r.clone().text()).then((t) => note(url, text, t)).catch(() => {});
          }
        } catch (e) { /* the request goes on regardless */ }
        return p;
      };
    }
  } catch (e) { /* no fetch to watch */ }
})();
