'use strict';

/**
 * Optional Google Places enrichment.
 *
 * Gated on GOOGLE_PLACES_API_KEY. With no key the whole system still runs —
 * review volume just moves from "observed" to "ask on the call", which the
 * brief handles explicitly.
 *
 * Two things worth knowing before anyone builds on this:
 *
 *   1. Places does NOT expose owner responses to reviews. There is no
 *      "did the owner reply" field. Review-response rate is a real buying
 *      signal, but it is not automatically observable here — the Business
 *      Profile API needs the business to grant us access, which a prospect
 *      obviously has not. So we route it to the call as a question and, if a
 *      rep wants it, they eyeball the listing in ten seconds. We do not
 *      pretend to have measured it.
 *
 *   2. Places terms allow storing place IDs indefinitely but not other
 *      content long-term. Every record is stamped with `cachedAt` so a
 *      retention job can expire the rest. Do not build a permanent local
 *      mirror of Places content.
 */

// Read at call time, not module load, so tests can point it at a local mock
// after requiring. Never set PLACES_ENDPOINT to anything but Google in
// production.
const endpoint = () => process.env.PLACES_ENDPOINT || 'https://places.googleapis.com/v1/places:searchText';

/**
 * Two field masks, because Places bills by what you ask for.
 *
 * Discovery sweeps hundreds of businesses and only needs enough to decide
 * whether one is worth researching — no reviews, which is what pushes a
 * request into the pricier SKU. Enrichment then asks for reviews on the much
 * smaller set that survived. Cheap wide sweep, expensive narrow follow-up.
 *
 * Check current Places pricing before running at volume; the tiers move.
 */
const DISCOVERY_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.businessStatus',
  'places.primaryTypeDisplayName',
].join(',');

const FIELD_MASK = [
  DISCOVERY_FIELDS,
  'places.regularOpeningHours.openNow',
  'places.regularOpeningHours.weekdayDescriptions',
  'places.reviews',
].join(',');

/**
 * Raw text search against Places, with paging.
 * Returns up to `max` place objects (Places caps a paged run at 60).
 */
async function searchText(textQuery, { key, fieldMask, max = 20, timeoutMs = 15000 } = {}) {
  const apiKey = key || process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY is not set');

  const out = [];
  let pageToken = null;

  while (out.length < max) {
    const body = { textQuery, maxResultCount: Math.min(20, max - out.length) };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': (fieldMask || DISCOVERY_FIELDS) + ',nextPageToken',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Places HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    }

    const data = await res.json();
    out.push(...(data.places || []));
    pageToken = data.nextPageToken || null;
    if (!pageToken || !(data.places || []).length) break;
  }

  return out.slice(0, max);
}

/**
 * Estimate review velocity from the handful of recent reviews Places returns.
 *
 * Places gives at most five, so this is a small sample and the brief labels it
 * as an estimate. It is still far better than the cumulative count, which says
 * nothing about whether a business is growing or coasting.
 */
function reviewVelocity(reviews) {
  const times = (reviews || [])
    .map(r => Date.parse(r.publishTime))
    .filter(t => Number.isFinite(t))
    .sort((a, b) => b - a);
  if (times.length < 2) return null;
  const spanDays = (times[0] - times[times.length - 1]) / 86400000;
  if (spanDays < 1) return null;
  return ((times.length - 1) / spanDays) * 30.44;
}

function sameDomain(a, b) {
  const norm = s => String(s || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  return norm(a) === norm(b);
}

async function fetchPlaces(domain, siteTitle, opts = {}) {
  const key = opts.placesKey || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  // Search by the site title plus the bare domain — the title is usually the
  // business name and the domain disambiguates chains with common names.
  const query = [siteTitle, domain].filter(Boolean).join(' ').slice(0, 200);

  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 5 }),
    signal: AbortSignal.timeout(opts.timeoutMs || 15000),
  });

  if (!res.ok) {
    throw new Error(`Places returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const candidates = data.places || [];
  if (!candidates.length) return { matched: false, cachedAt: new Date().toISOString() };

  // Only accept a match whose website matches the domain we researched.
  // A near-miss here is worse than nothing: it puts another business's review
  // count in front of a rep who is about to quote it out loud.
  const hit = candidates.find(p => sameDomain(p.websiteUri, domain));
  if (!hit) {
    return {
      matched: false,
      reason: 'Found listings but none whose website matched this domain — not safe to attribute.',
      cachedAt: new Date().toISOString(),
    };
  }

  return {
    matched: true,
    placeId: hit.id,
    name: hit.displayName?.text || null,
    address: hit.formattedAddress || null,
    rating: hit.rating ?? null,
    reviewCount: hit.userRatingCount ?? null,
    phone: hit.nationalPhoneNumber || null,
    category: hit.primaryTypeDisplayName?.text || null,
    businessStatus: hit.businessStatus || null,
    hours: hit.regularOpeningHours?.weekdayDescriptions || null,
    reviewVelocityPerMonth: reviewVelocity(hit.reviews),
    recentReviews: (hit.reviews || []).slice(0, 3).map(r => ({
      rating: r.rating,
      when: r.relativePublishTimeDescription || r.publishTime,
      text: (r.text?.text || '').slice(0, 300),
    })),
    // Places exposes no owner-response field. Left null on purpose so nobody
    // downstream mistakes "not available" for "they don't reply".
    ownerResponseRate: null,
    source: 'Google Places API (searchText)',
    cachedAt: new Date().toISOString(),
  };
}

module.exports = { fetchPlaces, searchText, sameDomain, DISCOVERY_FIELDS, FIELD_MASK };
