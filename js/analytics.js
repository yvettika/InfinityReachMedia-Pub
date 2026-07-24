/* ==========================================================================
   analytics.js — GA4 + Meta Pixel bootstrap, loaded on EVERY page.

   ┌────────────────────────────────────────────────────────────────────┐
   │  PASTE YOUR TWO IDs BELOW. That is the only edit needed.           │
   │  Until they are filled in, this file makes zero network requests   │
   │  and every tracking call is a silent no-op — safe to ship as-is.   │
   └────────────────────────────────────────────────────────────────────┘

   GA4_ID        Google Analytics 4 Measurement ID, looks like "G-XXXXXXXXXX".
                 Find it: analytics.google.com → Admin → Data Streams → your
                 web stream → "Measurement ID" (top right).

   META_PIXEL_ID Meta Pixel ID, a ~15-digit number like "1234567890123456".
                 Find it: business.facebook.com → Events Manager → Data
                 Sources → your pixel → the ID under its name.

   Privacy: this respects Global Privacy Control, which our Privacy Policy
   (/privacy §9) commits to honoring. When a visitor's browser sends GPC, the
   advertising pixel is not loaded at all and GA4 ad-personalisation consent
   is denied — plain traffic analytics still runs.
   ========================================================================== */
(function () {
  'use strict';

  var GA4_ID        = '';   // ← paste "G-XXXXXXXXXX" here
  var META_PIXEL_ID = '';   // ← paste your numeric Pixel ID here

  /* ---------- Global Privacy Control ---------- */
  // navigator.globalPrivacyControl is true when the visitor has GPC enabled
  // (built into Firefox, Brave, DuckDuckGo, and several extensions).
  var gpc = (navigator.globalPrivacyControl === true);

  /* ---------- GA4 ---------- */
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  if (GA4_ID) {
    // Consent Mode v2 defaults must be set BEFORE config.
    gtag('consent', 'default', {
      analytics_storage:  'granted',
      ad_storage:         gpc ? 'denied' : 'granted',
      ad_user_data:       gpc ? 'denied' : 'granted',
      ad_personalization: gpc ? 'denied' : 'granted'
    });

    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA4_ID);
    document.head.appendChild(g);

    gtag('js', new Date());
    gtag('config', GA4_ID);
  }

  /* ---------- Meta Pixel ---------- */
  // Skipped entirely under GPC: the pixel exists for ads and remarketing,
  // which is exactly what a GPC signal opts out of.
  if (META_PIXEL_ID && !gpc) {
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }

  /* ---------- Unified event helper ---------- */
  // One irmTrack() call fans out to GA4, Meta, and the dataLayer (for GTM,
  // if it is ever added). Meta's standard event names differ from GA4's, so
  // ours are mapped onto both vocabularies.
  var META_EVENT = {
    generate_lead:   'Lead',
    schedule_click:  'Schedule',
    scorecard_click: 'Lead',
    scorecard_complete: 'CompleteRegistration',
    demo_click:      'ViewContent',
    community_click: 'ViewContent'
  };

  function track(event, params) {
    params = params || {};
    params.page_vertical = (document.body && document.body.getAttribute('data-vertical')) || 'general';
    try { if (typeof window.gtag === 'function') window.gtag('event', event, params); } catch (e) {}
    try { if (typeof window.fbq === 'function') window.fbq('track', META_EVENT[event] || 'CustomEvent', params); } catch (e) {}
    try { window.dataLayer.push(Object.assign({ event: event }, params)); } catch (e) {}
  }
  window.irmTrack = track;

  /* ---------- Automatic CTA attribution ---------- */
  // Catches outbound/intent clicks site-wide without hand-wiring every link.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href  = a.getAttribute('href') || '';
    var label = (a.textContent || '').trim().slice(0, 60);
    if (href.indexOf('calendly.com') > -1)   track('schedule_click',  { cta_text: label });
    else if (href.indexOf('/scorecard') > -1) track('scorecard_click', { cta_text: label });
    else if (href.indexOf('/agentic-flows') > -1) track('demo_click',  { cta_text: label });
    else if (href.indexOf('skool.com') > -1)  track('community_click', { cta_text: label });
  }, true);
})();
