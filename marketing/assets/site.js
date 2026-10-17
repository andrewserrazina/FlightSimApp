// Turnline marketing site V2. Progressive enhancement only: every section is readable without JS.
// The waitlist contract is unchanged from V1 (see supabase/functions/turnline-waitlist):
//   POST cfg.apiUrl  {email, consent:true, captcha, source:'turnline_waitlist', utm_source, utm_medium, utm_campaign}
//   redirects back with ?waitlist=confirmed|unsubscribed|invalid|error#early-access
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());

  // ---------- mobile navigation ----------
  const toggle = $('.menu-toggle');
  const menu = $('#nav-menu');
  const closeMenu = (focusToggle) => {
    if (!toggle || toggle.getAttribute('aria-expanded') !== 'true') return;
    toggle.setAttribute('aria-expanded', 'false');
    menu.classList.remove('open');
    if (focusToggle) toggle.focus();
  };
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      menu.classList.toggle('open', open);
      if (open) $('a', menu)?.focus();
    });
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(true); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) closeMenu(false); });
    window.matchMedia('(min-width: 961px)').addEventListener('change', (m) => { if (m.matches) closeMenu(false); });
  }

  // "Join" links: after the jump, put the cursor in the email field.
  $$('[data-focus-email]').forEach((link) => link.addEventListener('click', () => {
    window.setTimeout(() => $('#email')?.focus({ preventScroll: true }), reduceMotion ? 0 : 450);
  }));

  // ---------- feature explorer tabs (WAI-ARIA tabs pattern) ----------
  const tabs = $$('[role="tab"]');
  const select = (tab, focus) => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  };
  if (tabs.length) {
    select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0], false);
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
        let next = null;
        if (e.key in keys) next = tabs[(i + keys[e.key] + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
  }

  // ---------- scenario: as planned / as operated ----------
  const card = $('#scenario-card');
  $$('.view-toggle button').forEach((btn, _, all) => btn.addEventListener('click', () => {
    card.dataset.view = btn.dataset.view;
    all.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  }));

  // ---------- reveal on scroll (skipped when reduced motion is requested) ----------
  const reveals = $$('.reveal');
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('is-visible'));
  }

  // ---------- screenshot lightbox (links open the image directly without JS or <dialog>) ----------
  const lightbox = $('#lightbox');
  if (lightbox && typeof lightbox.showModal === 'function') {
    const img = $('img', lightbox);
    const title = $('#lightbox-title');
    $$('[data-lightbox]').forEach((link) => link.addEventListener('click', (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // keep new-tab behaviour
      e.preventDefault();
      const shown = $('img', link);
      img.src = link.getAttribute('href');
      img.alt = shown ? shown.alt : '';
      title.textContent = link.closest('figure')?.querySelector('h3')?.textContent || 'Live Flight';
      lightbox.showModal();
      $('.lightbox-close', lightbox).focus();
    }));
    $('.lightbox-close', lightbox).addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.close(); });
    lightbox.addEventListener('close', () => { img.removeAttribute('src'); });
  }

  // ---------- waitlist ----------
  const cfg = window.TURNLINE_CONFIG || {};
  const form = $('#signup');
  const status = $('#status');
  const submit = $('#submit');
  const emailInput = $('#email');
  const submitLabel = submit ? submit.textContent : '';
  const say = (text, tone) => { status.textContent = text; if (tone) status.dataset.tone = tone; else delete status.dataset.tone; };

  const RESULT_MESSAGES = {
    confirmed: ['Your email is confirmed. You are on the Turnline update list.', 'ok'],
    unsubscribed: ['You have been unsubscribed from Turnline updates.', 'ok'],
    invalid: ['That link is invalid or expired. You can submit the form again.', 'warn'],
    error: ['We could not complete that request. Please try the link again, or contact support@turnlineops.com.', 'error'],
  };
  const result = new URLSearchParams(location.search).get('waitlist');
  if (result && Object.prototype.hasOwnProperty.call(RESULT_MESSAGES, result)) say(...RESULT_MESSAGES[result]);

  const signupsOpen = Boolean(cfg.turnstileSiteKey) && /^https:\/\//.test(cfg.apiUrl || '');
  if (signupsOpen) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.onload = () => window.turnstile?.render('#turnstile', { sitekey: cfg.turnstileSiteKey });
    document.head.appendChild(script);
  }

  let submitting = false;
  emailInput?.addEventListener('input', () => emailInput.removeAttribute('aria-invalid'));
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return; // duplicate-submission guard (the server also de-duplicates)
    say('');
    const email = emailInput.value.trim();
    if (!emailInput.reportValidity()) { emailInput.setAttribute('aria-invalid', 'true'); return; }
    const consent = $('#consent');
    if (!consent.checked) { say('Please agree to receive these emails.', 'warn'); consent.focus(); return; }
    if (!cfg.apiUrl || !cfg.turnstileSiteKey) { say('Signups are not open yet. Please check back soon.', 'warn'); return; }
    const captcha = form.querySelector('[name="cf-turnstile-response"]')?.value;
    if (!captcha) { say('Please complete the verification check.', 'warn'); return; }
    submitting = true;
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      const params = new URLSearchParams(location.search);
      const response = await fetch(cfg.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          consent: true,
          captcha,
          source: 'turnline_waitlist',
          utm_source: (params.get('utm_source') || '').slice(0, 100),
          utm_medium: (params.get('utm_medium') || '').slice(0, 100),
          utm_campaign: (params.get('utm_campaign') || '').slice(0, 100),
        }),
      });
      if (response.status === 429) { say('Too many sign-up attempts right now. Please wait a while and try again.', 'warn'); return; }
      if (response.status === 400) { say('Please check your email address and complete the verification check again.', 'warn'); return; }
      if (!response.ok) throw Error('unavailable');
      say('If this address needs confirmation, you will receive an email shortly. Check your inbox.', 'ok');
      form.reset();
    } catch {
      say('We could not submit your request. Please try again later.', 'error');
    } finally {
      submitting = false;
      submit.disabled = false;
      submit.textContent = submitLabel;
      window.turnstile?.reset();
    }
  });
})();
