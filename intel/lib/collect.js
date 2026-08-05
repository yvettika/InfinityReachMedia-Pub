'use strict';

const { detect } = require('./detect');
const { fetchPlaces } = require('./places');
const { extractEmails, pickBest } = require('./contacts');

/**
 * Collection layer: fetch what is public, record where every fact came from.
 *
 * Rules this module holds to, because the whole system is worthless without
 * them:
 *   1. Only pages the site serves publicly over plain HTTP. No logged-in
 *      surfaces, no gated APIs, nothing behind a ToS that forbids it.
 *   2. robots.txt is honoured. If they ask us not to read a path, we don't.
 *   3. Every returned fact carries its source URL and the time we saw it.
 *      A fact with no provenance never reaches the brief.
 *   4. Failures are recorded, not swallowed. "We couldn't check" and "we
 *      checked and it wasn't there" are different claims on a sales call.
 */

const UA =
  'InfinityReachMediaBot/1.0 (+https://infinityreachmedia.com; prospect research; contact yvette@infinityreachmedia.com)';

const DEFAULTS = {
  timeoutMs: 15000,
  politenessMs: 1200, // gap between requests to the same host
  maxPages: 5,
};

/** Extra pages worth a look. Cheap, and each one answers a real question. */
const CANDIDATE_PATHS = [
  { path: '/contact', why: 'contact options, hours, form vs phone only' },
  { path: '/about', why: 'owner and leadership names' },
  { path: '/careers', why: 'hiring signal' },
  { path: '/jobs', why: 'hiring signal' },
  { path: '/book', why: 'online booking' },
  { path: '/schedule', why: 'online booking' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new Error('No URL supplied');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const parsed = new URL(u);
  parsed.hash = '';
  return parsed;
}

async function getPage(url, opts) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      html: body,
      bytes: Buffer.byteLength(body),
      elapsedMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      finalUrl: url,
      html: '',
      bytes: 0,
      elapsedMs: Date.now() - started,
      error: err.name === 'TimeoutError' ? `timeout after ${opts.timeoutMs}ms` : err.message,
    };
  }
}

/** Minimal robots.txt support: honour Disallow for our UA and for `*`. */
async function loadRobots(origin, opts) {
  const res = await getPage(origin + '/robots.txt', opts);
  const disallow = [];
  if (res.ok && res.html && !/<html/i.test(res.html.slice(0, 200))) {
    let applies = false;
    for (const raw of res.html.split(/\r?\n/)) {
      const line = raw.split('#')[0].trim();
      if (!line) continue;
      const [field, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const key = field.trim().toLowerCase();
      if (key === 'user-agent') {
        applies = value === '*' || /infinityreachmedia/i.test(value);
      } else if (key === 'disallow' && applies && value) {
        disallow.push(value);
      }
    }
  }
  return {
    fetched: res.ok,
    disallow,
    allows(path) {
      return !disallow.some(rule => rule !== '/' ? path.startsWith(rule) : true);
    },
  };
}

/**
 * Run collection for one prospect.
 * @param {string} input   domain or URL
 * @param {object} options { timeoutMs, maxPages, placesKey, skipExtraPages,
 *                            contactDomain }
 */
async function collect(input, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const base = normalizeUrl(input);
  const origin = base.origin;
  const observedAt = new Date().toISOString();

  const record = {
    input: String(input),
    domain: base.hostname.replace(/^www\./, ''),
    origin,
    observedAt,
    pages: [],
    errors: [],
    robots: null,
    signals: null,
    places: null,
  };

  const robots = await loadRobots(origin, opts);
  record.robots = { fetched: robots.fetched, disallow: robots.disallow };

  // Homepage is mandatory — without it there is no dossier.
  const home = await getPage(base.href, opts);
  record.pages.push({
    url: home.finalUrl,
    role: 'homepage',
    status: home.status,
    bytes: home.bytes,
    elapsedMs: home.elapsedMs,
    error: home.error,
  });

  if (!home.ok || !home.html) {
    record.errors.push(
      `Could not read the homepage (${home.error || 'HTTP ' + home.status}). ` +
      `Everything downstream would be a guess, so collection stopped here.`
    );
    return record;
  }

  let combined = home.html;

  // Extra pages are best-effort. One failing is not a problem worth reporting
  // to a salesperson — it just means that page did not exist.
  if (!opts.skipExtraPages) {
    let budget = Math.max(0, opts.maxPages - 1);
    for (const cand of CANDIDATE_PATHS) {
      if (budget <= 0) break;
      if (!robots.allows(cand.path)) continue;
      await sleep(opts.politenessMs);
      const res = await getPage(origin + cand.path, opts);
      if (res.ok && res.html && res.status === 200) {
        budget--;
        combined += '\n' + res.html;
        record.pages.push({
          url: res.finalUrl,
          role: cand.path.replace('/', ''),
          why: cand.why,
          status: res.status,
          bytes: res.bytes,
          elapsedMs: res.elapsedMs,
          error: null,
        });
      }
    }
  }

  // Detection runs over the homepage for delivery metrics (so byte counts and
  // timings describe one real page) and over the combined text for presence
  // checks (so a booking link on /contact still counts).
  const homeSignals = detect(home.html, {
    url: home.finalUrl,
    bytes: home.bytes,
    elapsedMs: home.elapsedMs,
  });
  const allSignals = detect(combined, {
    url: home.finalUrl,
    bytes: home.bytes,
    elapsedMs: home.elapsedMs,
  });
  allSignals.performance = homeSignals.performance;
  allSignals.title = homeSignals.title;
  allSignals.metaDescription = homeSignals.metaDescription;
  record.signals = allSignals;

  // Contact discovery runs over the same pages we already downloaded — the
  // /contact page is in `combined`, which is exactly where the address lives.
  // No extra requests.
  // The brand's own domain, which is not always the host we fetched — a
  // staging box, an agency's server, a redirect, a fixture. Both the contact
  // extractor and the Places website match test "does this belong to them?",
  // so they must agree on what "them" means.
  record.brandDomain = opts.contactDomain || record.domain;
  record.emailCandidates = extractEmails(combined, record.brandDomain);
  record.email = pickBest(record.emailCandidates);

  // Google Places is optional. Without a key the system still works; it just
  // has to ask about review volume on the call instead of knowing it.
  if (opts.placesKey) {
    try {
      record.places = await fetchPlaces(record.brandDomain, allSignals.title, opts);
    } catch (err) {
      record.errors.push(`Places lookup failed: ${err.message}`);
    }
  }

  return record;
}

module.exports = { collect, normalizeUrl, UA };
