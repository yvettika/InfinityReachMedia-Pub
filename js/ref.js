/* ==========================================================================
   ref.js — partner referral attribution, loaded on EVERY page.

   A promoter gets ONE link with their code on it:

       https://infinityreachmedia.com/jessica?ref=ted

   This file does three things with that code:

     1. Remembers it for 90 days (localStorage), so a visitor who lands on
        /jessica today and books next week is still credited to the partner.
     2. Stamps it onto every Calendly link and the inline booking widget as
        UTM parameters, so the booked event itself carries the partner code.
        That booking record is the SYSTEM OF RECORD for referral payouts —
        a prospect will never remember to type "referred by" in the notes.
     3. Exposes window.irmRef() so lead forms (js/lp.js) can include it.

   Deliberately NOT changed: the `source` field that lead forms post to
   api/lead. That string is what her lead reporting groups on, and splitting
   "Jessica Landing Page" into a new bucket per partner would fragment it.
   The referral shows up in the message body instead.

   No cookies, no third-party calls, nothing personal stored — just a short
   partner slug in the visitor's own browser.
   ========================================================================== */
(function () {
  'use strict';

  var KEY      = 'irm_ref';
  var MAX_AGE  = 90 * 24 * 60 * 60 * 1000;   // 90 days, matches the payout window
  var MAX_LEN  = 32;

  /* ---------- read + sanitise ----------
     Partner codes are lowercase letters, digits and hyphens. Anything else is
     someone probing the query string, so it gets dropped rather than stored. */
  function clean(raw) {
    if (!raw) return '';
    var s = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '');
    return s.slice(0, MAX_LEN);
  }

  function fromUrl() {
    try {
      return clean(new URLSearchParams(window.location.search).get('ref'));
    } catch (e) { return ''; }        // no URLSearchParams on an ancient browser
  }

  /* ---------- storage ----------
     Wrapped because localStorage throws in private mode on some browsers and
     is simply absent in others. A partner link must never break the page. */
  function save(code) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify({ v: code, t: Date.now() }));
    } catch (e) { /* attribution is best-effort, the page is not */ }
  }

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return '';
      var rec = JSON.parse(raw);
      if (!rec || !rec.v) return '';
      if (Date.now() - rec.t > MAX_AGE) {
        window.localStorage.removeItem(KEY);
        return '';
      }
      return clean(rec.v);
    } catch (e) { return ''; }
  }

  // A fresh ?ref= in the URL always wins — the most recent promoter to send
  // this visitor is the one who earned the click.
  var urlRef = fromUrl();
  if (urlRef) save(urlRef);

  var ref = urlRef || load();

  /* Public accessor. Always returns a string, never null. */
  window.irmRef = function () { return ref; };

  if (!ref) return;                   // nothing to stamp

  /* ---------- stamp Calendly ----------
     Calendly passes utm_* straight through onto the scheduled event, where it
     shows up in the booking details and the notification email. */
  function withUtm(url) {
    if (!url || url.indexOf('calendly.com') === -1) return url;
    if (url.indexOf('utm_campaign=') !== -1) return url;   // already stamped
    return url + (url.indexOf('?') === -1 ? '?' : '&') +
      'utm_source=partner&utm_medium=referral&utm_campaign=' + encodeURIComponent(ref);
  }

  // Every <a> pointing at Calendly, on every page.
  var links = document.querySelectorAll('a[href*="calendly.com"]');
  for (var i = 0; i < links.length; i++) {
    links[i].setAttribute('href', withUtm(links[i].getAttribute('href')));
  }

  // The inline widget on /book. Calendly's widget.js is async but only ever
  // initialises on or after DOMContentLoaded, and deferred scripts all run
  // before that — so rewriting data-url here lands before it is read.
  var widgets = document.querySelectorAll('.calendly-inline-widget[data-url]');
  for (var j = 0; j < widgets.length; j++) {
    widgets[j].setAttribute('data-url', withUtm(widgets[j].getAttribute('data-url')));
  }
})();
