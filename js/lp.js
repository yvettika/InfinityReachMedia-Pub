/* ==========================================================================
   lp.js — shared behavior for paid-traffic landing pages
   1. lead form    : posts to the existing Speed-to-Lead endpoint
   2. count-up     : the money stat, with a guaranteed-correct fallback
   3. sticky CTA   : mobile-only bar after the hero scrolls away
   Pixel setup and CTA-click attribution live in analytics.js, which loads on
   every page; this file only fires events through window.irmTrack.
   ========================================================================== */
(function () {
  'use strict';

  var LEAD_URL = 'https://speed-to-lead-agent-two.vercel.app/api/lead';
  var CALENDLY = 'https://calendly.com/yvettekahn/30min';

  var SOURCE_LABEL = {
    hvac:      'HVAC Landing Page',
    salon:     'Salon Landing Page',
    insurance: 'Insurance Landing Page',
    smallbiz:  'Small Business Landing Page'
  };

  // analytics.js owns irmTrack; fall back to a no-op so the form still works
  // if that file ever fails to load.
  function track(event, params) {
    if (typeof window.irmTrack === 'function') window.irmTrack(event, params);
  }

  /* ---------- 1. Lead form ---------- */
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

  /* ---------- 2. Count-up money stat ----------
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

  /* ---------- 3. Mobile sticky CTA ---------- */
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
