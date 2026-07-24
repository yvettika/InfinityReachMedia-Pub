/* ==========================================================================
   lp.js — shared behavior for paid-traffic landing pages
   1. track()      : one call fans out to GA4 / Meta Pixel / GTM if loaded
   2. lead form    : posts to the existing Speed-to-Lead endpoint
   3. sticky CTA   : mobile-only bar after the hero scrolls away
   Every piece degrades to a no-op when its dependency is absent, so this file
   is safe to ship before the ad pixels are installed.
   ========================================================================== */
(function () {
  'use strict';

  var LEAD_URL = 'https://speed-to-lead-agent-two.vercel.app/api/lead';
  var CALENDLY = 'https://calendly.com/yvettekahn/30min';

  /* ---------- 1. Tracking ---------- */
  // Meta's standard event names differ from GA4's; map ours onto both.
  var META_EVENT = { generate_lead: 'Lead', schedule_click: 'Schedule', scorecard_click: 'Lead', demo_click: 'ViewContent' };
  var SOURCE_LABEL = { hvac: 'HVAC Landing Page', salon: 'Salon Landing Page', insurance: 'Insurance Landing Page' };

  function track(event, params) {
    params = params || {};
    params.page_vertical = document.body.getAttribute('data-vertical') || 'general';
    try { if (typeof window.gtag === 'function') window.gtag('event', event, params); } catch (e) {}
    try { if (typeof window.fbq === 'function') window.fbq('track', META_EVENT[event] || 'CustomEvent', params); } catch (e) {}
    try { (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: event }, params)); } catch (e) {}
  }
  window.irmTrack = track;

  /* Attribute CTA clicks without hand-wiring every link. */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var label = (a.textContent || '').trim().slice(0, 60);
    if (href.indexOf('calendly.com') > -1) track('schedule_click', { cta_text: label });
    else if (href.indexOf('/scorecard') > -1) track('scorecard_click', { cta_text: label });
    else if (href.indexOf('/agentic-flows') > -1) track('demo_click', { cta_text: label });
  }, true);

  /* ---------- 2. Lead form ---------- */
  var form = document.getElementById('lpForm');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = document.getElementById('lpErr');
      var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };

      if (val('lp_hp')) return;                        // honeypot tripped — silently drop

      var name = val('lp_name'), email = val('lp_email'), phone = val('lp_phone'), biz = val('lp_biz');
      var consent = document.getElementById('lp_consent');

      function fail(msg) { err.textContent = msg; err.style.display = 'block'; }

      if (!name) return fail('Please add your name.');
      if (!/.+@.+\..+/.test(email)) return fail('Please add a valid email address.');
      if (phone && phone.replace(/\D/g, '').length < 10) return fail('Please enter a 10-digit phone number, or leave it blank.');
      if (phone && consent && !consent.checked) return fail('Please agree to be contacted so we know how to reach you.');
      err.style.display = 'none';

      var vertical = document.body.getAttribute('data-vertical') || 'general';
      var btn = form.querySelector('button[type=submit]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      fetch(LEAD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          email: email,
          phone: phone,
          source: SOURCE_LABEL[vertical] || 'Landing Page',
          message: 'Requested the 60-second agent walkthrough. Business: ' + (biz || 'n/a') + '. SMS consent: ' + (consent && consent.checked ? 'yes' : 'no') + '.',
          company_website: ''
        })
      }).catch(function () { /* never block the confirmation on a network hiccup */ })
        .finally(function () {
          track('generate_lead', { form_location: 'landing_inline' });
          form.style.display = 'none';
          var done = document.getElementById('lpDone');
          if (done) { done.style.display = 'block'; done.focus && done.focus(); }
        });
    });
  }

  /* ---------- 3. Count-up money stat ----------
     The final figure is what ships in the HTML, so no-JS, an old browser, or an
     IntersectionObserver that never fires all still show the real number. The
     animation is a progressive enhancement that can only ever run on top of it. */
  Array.prototype.forEach.call(document.querySelectorAll('[data-countup]'), function (el) {
    var target = parseFloat(el.getAttribute('data-countup'));
    if (!isFinite(target)) return;
    var fmt = function (n) { return '$' + Math.round(n).toLocaleString('en-US'); };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        typeof IntersectionObserver !== 'function' ||
        typeof requestAnimationFrame !== 'function') { el.textContent = fmt(target); return; }

    var done = false;
    function run() {
      if (done) return;
      done = true;
      var dur = 1800, t0 = null;
      (function tick(ts) {
        if (!t0) t0 = ts;
        var p = Math.min((ts - t0) / dur, 1);
        el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(tick); else el.textContent = fmt(target);
      })();
    }

    el.textContent = fmt(0);                                  // only zero it once we know we can animate
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); run(); } });
    }, { threshold: 0.4 });
    io.observe(el);

    // Safety net: if the observer never delivers, show the real figure anyway.
    setTimeout(function () { if (!done) { io.disconnect(); el.textContent = fmt(target); done = true; } }, 4000);
  });

  /* ---------- 4. Mobile sticky CTA ---------- */
  var hero = document.querySelector('.hero');
  if (hero && !window.matchMedia('(min-width:821px)').matches) {
    var bar = document.createElement('div');
    bar.className = 'lp-sticky';
    bar.innerHTML =
      '<a class="s-ghost" href="#get-started">Get the Walkthrough</a>' +
      '<a class="s-primary" href="' + CALENDLY + '">Book a Free Call</a>';
    document.body.appendChild(bar);
    document.body.classList.add('has-sticky');

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { bar.classList.toggle('on', !en.isIntersecting); });
    }, { threshold: 0 });
    io.observe(hero);
  }
})();
