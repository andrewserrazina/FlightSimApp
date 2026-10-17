// Turnline email confirmation and unsubscribe pages (/confirm, /unsubscribe).
// Email links carry the id and token in the URL fragment (#id=…&token=…). Browsers never send a fragment to a
// server, so the token is not in any request line, server log or Referer header. This script reads it, removes it
// from the address bar straight away, and sends it only when the user presses the button: one JSON POST to the
// waitlist function (config.js apiUrl), which accepts it only from the Turnline origin.
// Opening the page changes nothing, so mail-scanner prefetches are harmless. No analytics, no third-party scripts.
(() => {
  'use strict';
  document.documentElement.classList.replace('no-js', 'js');
  const card = document.querySelector('[data-verify]');
  if (!card) return;
  const action = card.dataset.verify === 'unsubscribe' ? 'unsubscribe' : 'confirm';
  const button = document.getElementById('verify-button');
  const status = document.getElementById('verify-status');
  const cfg = window.TURNLINE_CONFIG || {};

  const params = new URLSearchParams(window.location.hash.slice(1));
  const id = params.get('id') || '';
  const token = params.get('token') || '';
  if (window.location.hash || window.location.search) {
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* keep going; the token is still never sent anywhere but the POST */ }
  }

  const home = '<a href="/#early-access">join the early-access list</a>';
  const support = '<a href="mailto:support@turnlineops.com">support@turnlineops.com</a>';
  const say = (html, tone) => { status.innerHTML = html; if (tone) status.dataset.tone = tone; else delete status.dataset.tone; };
  const done = (html, tone) => { say(html, tone); button.hidden = true; status.focus?.(); };

  const idOk = /^[0-9a-f-]{36}$/i.test(id);
  const tokenOk = action === 'confirm' ? token.length >= 32 && token.length <= 200 && /^[A-Za-z0-9-]+$/.test(token) : /^[0-9a-f]{64}$/.test(token);
  if (!idOk || !tokenOk) {
    done(`This link is incomplete or damaged, so nothing has been changed. Open the link from your email again (copying it by hand can cut it short). ${action === 'confirm' ? `If it has expired, ${home} again to get a new one.` : `Or email ${support} and we will unsubscribe you.`}`, 'warn');
    return;
  }
  if (!/^https:\/\//.test(cfg.apiUrl || '')) {
    done(`This service is temporarily unavailable, so nothing has been changed. Please try the link again later, or email ${support}.`, 'error');
    return;
  }
  status.setAttribute('tabindex', '-1');
  button.disabled = false;

  let busy = false;
  button.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = action === 'confirm' ? 'Confirming…' : 'Unsubscribing…';
    say('');
    try {
      const r = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id, token }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      let body = {};
      try { body = await r.json(); } catch { /* handled by the status code */ }
      if (r.ok && body.status === 'confirmed') return done('Your email is confirmed. You are on the Turnline update list. <a href="/">Back to Turnline</a>', 'ok');
      if (r.ok && body.status === 'already_confirmed') return done('This email was already confirmed. You are on the Turnline update list. <a href="/">Back to Turnline</a>', 'ok');
      if (r.ok && body.status === 'unsubscribed') return done('You are unsubscribed. Turnline will not send updates to this address. <a href="/">Back to Turnline</a>', 'ok');
      if (r.status === 400) return done(action === 'confirm' ? `This confirmation link is invalid or has expired, so nothing has been changed. Links expire after 48 hours; ${home} again to get a new one.` : `This unsubscribe link is not valid, so nothing has been changed. Email ${support} and we will unsubscribe you.`, 'warn');
      if (r.status === 429) throw Object.assign(new Error('limited'), { retry: 'Too many attempts right now. Please wait a few minutes and try again.' });
      throw new Error('unavailable');
    } catch (e) {
      say(`${e.retry || 'We could not complete that request, and nothing has been changed.'} You can try again${e.retry ? '' : ` or email ${support}`}.`, 'error');
      button.textContent = label;
      button.disabled = false;
    } finally {
      busy = false;
    }
  });
})();
