'use strict';

/**
 * Signal detection over a fetched page.
 *
 * Everything in here is a pure function of text we already downloaded — no
 * network, no model. That is deliberate: these are the facts the rep is
 * allowed to say out loud on the call, so they have to be reproducible and
 * checkable. If a detector fires, we can point at the exact string that made
 * it fire.
 *
 * A detector returns `present: true` only on a positive match. It never
 * returns `false` on a hunch — absence of a fingerprint means "we did not see
 * it", which is a weaker claim than "they do not have it". The model treats
 * those differently and the brief prints them differently.
 */

/** Vendor fingerprints. Order matters only for which vendor name we report. */
const FINGERPRINTS = {
  chat: [
    ['Intercom', /widget\.intercom\.io|intercomSettings/i],
    ['Drift', /js\.driftt\.com|drift\.com\/include/i],
    ['Tidio', /code\.tidio\.co/i],
    ['Tawk.to', /embed\.tawk\.to/i],
    ['Podium', /connect\.podium\.com|podium\.com\/widget/i],
    ['Birdeye', /birdeye\.com\/widget|bir\.dev/i],
    ['HubSpot Chat', /js\.hs-scripts\.com|js\.usemessages\.com/i],
    ['LiveChat', /cdn\.livechatinc\.com/i],
    ['Olark', /static\.olark\.com/i],
    ['Crisp', /client\.crisp\.chat/i],
    ['Zendesk', /static\.zdassets\.com|zopim/i],
    ['ManyChat', /manychat\.com\/.*widget|mcwidget/i],
    ['Elfsight', /elfsight\.com\/.*chat/i],
    ['Chatway', /cdn\.chatway\.app/i],
    ['Gorgias', /config\.gorgias\.chat/i],
    ['Generic chat widget', /id=["']?(chat-widget|livechat|chatbot)/i],
  ],

  booking: [
    ['Calendly', /calendly\.com/i],
    ['Acuity', /acuityscheduling\.com|squarespacescheduling\.com/i],
    ['Housecall Pro', /housecallpro\.com|hcpapp\.com/i],
    ['ServiceTitan', /servicetitan\.com/i],
    ['Jobber', /getjobber\.com|jobber\.com\/online-booking/i],
    ['Booksy', /booksy\.com/i],
    ['Vagaro', /vagaro\.com/i],
    ['Square Appointments', /squareup\.com\/appointments|square\.site\/book/i],
    ['Setmore', /setmore\.com/i],
    ['Schedulicity', /schedulicity\.com/i],
    ['Mindbody', /mindbodyonline\.com/i],
    ['GoHighLevel Calendar', /msgsndr\.com\/widget\/booking|leadconnectorhq\.com\/widget\/booking/i],
  ],

  crm: [
    ['HubSpot', /js\.hs-scripts\.com|hs-analytics\.net/i],
    ['GoHighLevel', /msgsndr\.com|leadconnectorhq\.com/i],
    ['ActiveCampaign', /prism\.app-us1\.com|activehosted\.com/i],
    ['Klaviyo', /static\.klaviyo\.com/i],
    ['Mailchimp', /chimpstatic\.com|list-manage\.com/i],
    ['Keap / Infusionsoft', /infusionsoft\.com|keap\.com/i],
    ['Constant Contact', /constantcontact\.com/i],
    ['Salesforce / Pardot', /pardot\.com|force\.com/i],
    ['Zoho', /zohopublic\.com|zoho\.com\/crm/i],
  ],

  adPixels: [
    ['Meta Pixel', /connect\.facebook\.net\/.*fbevents|fbq\(['"]init/i],
    ['Google Ads', /gtag\(['"]config['"],\s*['"]AW-|googleadservices\.com/i],
    ['TikTok Pixel', /analytics\.tiktok\.com/i],
    ['LinkedIn Insight', /snap\.licdn\.com/i],
    ['Microsoft / Bing UET', /bat\.bing\.com/i],
  ],

  analytics: [
    ['GA4', /gtag\(['"]config['"],\s*['"]G-|googletagmanager\.com\/gtag/i],
    ['Google Tag Manager', /googletagmanager\.com\/gtm/i],
  ],

  callTracking: [
    ['CallRail', /callrail\.com|cdn\.callrail\.com/i],
    ['CallTrackingMetrics', /tctm\.co|calltrackingmetrics\.com/i],
    ['WhatConverts', /whatconverts\.com/i],
  ],

  reviewWidget: [
    ['Birdeye', /birdeye\.com/i],
    ['Podium Reviews', /podium\.com/i],
    ['NiceJob', /nicejob\.co/i],
    ['Trustpilot', /trustpilot\.com\/.*bootstrap|widget\.trustpilot/i],
    ['Yotpo', /yotpo\.com/i],
    ['Grade.us', /grade\.us/i],
    ['Google Reviews embed', /elfsight\.com\/google-reviews|reviewsonmywebsite/i],
  ],

  platform: [
    ['WordPress', /wp-content|wp-includes|wp-json/i],
    ['Wix', /static\.parastorage\.com|wix\.com/i],
    ['Squarespace', /squarespace\.com|static1\.squarespace/i],
    ['Shopify', /cdn\.shopify\.com/i],
    ['Webflow', /assets\.website-files\.com|webflow\.com/i],
    ['GoDaddy Website Builder', /img1\.wsimg\.com|godaddysites\.com/i],
    ['Duda', /dudamobile\.com|multiscreensite\.com/i],
    ['HubSpot CMS', /hs-sites\.com/i],
  ],

  social: [
    ['Facebook', /facebook\.com\/(?!tr\?|plugins|sharer)[A-Za-z0-9._-]+/i],
    ['Instagram', /instagram\.com\/[A-Za-z0-9._-]+/i],
    ['YouTube', /youtube\.com\/(channel|c|user|@)/i],
    ['LinkedIn', /linkedin\.com\/(company|in)\//i],
    ['TikTok', /tiktok\.com\/@/i],
    ['Yelp', /yelp\.com\/biz\//i],
  ],
};

/** Text claims worth catching — these become talk track, not just score input. */
const CLAIMS = [
  ['afterHours', /24\s*\/\s*7|24-7|24 hours a day|around the clock|emergency service|after[- ]hours/i],
  ['sameDay', /same[- ]day (service|appointment)/i],
  ['financing', /financing available|0% apr|payment plans?\b/i],
  ['membership', /membership plan|maintenance plan|service (club|agreement)/i],
  ['textUs', /text us|send us a text|sms us/i],
  ['freeEstimate', /free (estimate|quote|consultation|inspection)/i],
  ['hiring', /we'?re hiring|now hiring|join our team|careers?\b/i],
  ['hiringSalesOrCSR', /customer service rep|csr\b|dispatcher|call center|sales representative|appointment setter/i],
];

function matchTable(html, table) {
  for (const [vendor, re] of table) {
    const m = html.match(re);
    if (m) return { vendor, evidence: snippet(html, m.index) };
  }
  return null;
}

/**
 * A short, quotable slice of source around a match — this is the receipt.
 * Snaps back to the nearest tag boundary so a rep never sees a fragment that
 * starts mid-word ("heet\" href=..."), which reads like a bug and undermines
 * the one thing this field exists to do: look checkable.
 */
function snippet(html, index, len = 90) {
  if (typeof index !== 'number') return '';
  const lookback = html.lastIndexOf('<', index);
  const start = lookback >= 0 && index - lookback <= 120 ? lookback : index;
  return html.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

function countMatches(html, re) {
  const m = html.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return m ? m.length : 0;
}

/**
 * @param {string} html  raw page source
 * @param {object} ctx   { url, status, headers, elapsedMs, bytes }
 */
function detect(html, ctx = {}) {
  const out = {};
  const lower = html;

  // --- vendor-class detections ------------------------------------------
  for (const [key, table] of Object.entries(FINGERPRINTS)) {
    if (key === 'social') continue; // handled below, we want all of them
    const hit = matchTable(lower, table);
    out[key] = hit
      ? { present: true, vendor: hit.vendor, evidence: hit.evidence }
      : { present: false, vendor: null, evidence: null };
  }

  // Social is multi-value: we want the full set, not the first hit.
  out.social = {
    present: false,
    profiles: [],
    evidence: null,
  };
  for (const [name, re] of FINGERPRINTS.social) {
    const m = lower.match(re);
    if (m) {
      out.social.profiles.push(name);
      out.social.present = true;
      if (!out.social.evidence) out.social.evidence = snippet(lower, m.index);
    }
  }

  // --- contactability ----------------------------------------------------
  const telMatches = lower.match(/tel:\+?[0-9()\-.\s]{7,}/gi) || [];
  out.phone = {
    present: telMatches.length > 0,
    numbers: [...new Set(telMatches.map(t => t.replace(/^tel:/i, '').trim()))].slice(0, 3),
    evidence: telMatches[0] || null,
  };

  const formCount = countMatches(lower, /<form\b/i);
  out.form = {
    present: formCount > 0,
    count: formCount,
    evidence: formCount ? `${formCount} <form> element(s)` : null,
  };

  const mailtos = lower.match(/mailto:[^"'\s>]+/gi) || [];
  out.mailtoOnly = {
    present: mailtos.length > 0 && formCount === 0,
    addresses: [...new Set(mailtos.map(m => m.replace(/^mailto:/i, '')))].slice(0, 3),
    evidence: mailtos[0] || null,
  };

  // --- claims ------------------------------------------------------------
  out.claims = {};
  for (const [key, re] of CLAIMS) {
    const m = lower.match(re);
    out.claims[key] = m
      ? { present: true, evidence: snippet(lower, m.index) }
      : { present: false, evidence: null };
  }

  // --- structured data ---------------------------------------------------
  out.localBusinessSchema = {
    present: /"@type"\s*:\s*"(LocalBusiness|HVACBusiness|HomeAndConstructionBusiness|HealthAndBeautyBusiness|InsuranceAgency|ProfessionalService|Plumber|Electrician|BeautySalon|DaySpa)"/i.test(lower),
    evidence: null,
  };
  const hoursMatch = lower.match(/"openingHours(?:Specification)?"\s*:/i);
  out.publishedHours = {
    present: !!hoursMatch,
    evidence: hoursMatch ? snippet(lower, hoursMatch.index) : null,
  };

  // --- delivery quality (rough, honest proxies — not Lighthouse) ---------
  const scriptCount = countMatches(lower, /<script\b/i);
  const imgCount = countMatches(lower, /<img\b/i);
  const lazyCount = countMatches(lower, /loading=["']lazy["']/i);
  out.performance = {
    bytes: ctx.bytes ?? html.length,
    ttfbMs: ctx.elapsedMs ?? null,
    scriptCount,
    imgCount,
    lazyImgCount: lazyCount,
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(lower),
    https: typeof ctx.url === 'string' ? ctx.url.startsWith('https://') : null,
    // "Heavy" is a judgement call, so we state the threshold rather than hide it.
    heavy: (ctx.bytes ?? html.length) > 900000 || scriptCount > 35,
  };

  out.title = (lower.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [, ''])[1].trim();
  const desc = lower.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i);
  out.metaDescription = desc ? desc[1].trim() : null;

  return out;
}

module.exports = { detect, FINGERPRINTS, CLAIMS };
