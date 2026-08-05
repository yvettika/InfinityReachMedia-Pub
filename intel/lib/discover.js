'use strict';

const fs = require('fs');
const path = require('path');
const { searchText, DISCOVERY_FIELDS } = require('./places');

/**
 * Discovery — find businesses worth researching.
 *
 * The research engine takes a domain and produces a call brief. This produces
 * the domains. It sweeps Google Places across a set of business categories and
 * a set of cities, then filters down to companies that are actually sellable
 * to: real websites, operating, big enough to have the problem and small
 * enough to make the decision without a committee.
 *
 * Deliberately niche-agnostic. The leak model doesn't care whether a business
 * fixes furnaces or teeth — it cares whether a missed call costs them money and
 * whether anything on their site catches a lead after hours. So the category
 * list is just "appointment-driven local service business", and the Revenue
 * Leak Score does the actual ranking afterwards.
 *
 * Cost note: every query is a billed Places request returning up to 20 results,
 * paged to 60. The sweep uses the cheaper field mask (no reviews) because at
 * this stage we only need enough to decide who is worth a closer look. Reviews
 * get fetched later, per prospect, during research.
 */

const NICHES = require('../data/niches.json');

const DEFAULTS = {
  minReviews: 10,        // below this they're too new or too small to have the problem
  maxReviews: 1500,      // above this it's usually a franchise or a regional player with staff
  maxLocations: 8,       // a domain appearing at more locations than this reads as a chain
  perQuery: 20,          // Places returns 20 per page; 60 max if paged
  politenessMs: 200,
};

/** Chains and directory sites that show up in local results and are never prospects. */
const NEVER_PROSPECTS = [
  /(^|\.)yelp\./i, /(^|\.)angi\./i, /(^|\.)homeadvisor\./i, /(^|\.)thumbtack\./i,
  /(^|\.)bbb\.org/i, /(^|\.)facebook\./i, /(^|\.)instagram\./i, /(^|\.)google\./i,
  /(^|\.)nextdoor\./i, /(^|\.)mapquest\./i, /(^|\.)tripadvisor\./i,
  /servicetitan\.com/i, /housecallpro\.com/i,
  // national franchises — they buy at corporate, not from a local agency
  /rotorooter\.com/i, /mrrooter\.com/i, /rescuerooter\.com/i, /arsservice\.com/i,
  /terminix\.com/i, /orkin\.com/i, /(^|\.)aptive\./i,
  /statefarm\.com/i, /allstate\.com/i, /farmers\.com/i, /geico\.com/i,
  /supercuts\.com/i, /greatclips\.com/i, /sportclips\.com/i,
  /midas\.com/i, /jiffylube\.com/i, /aamco\.com/i, /firestonecompleteautocare\.com/i,
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function isNeverProspect(domain) {
  return !domain || NEVER_PROSPECTS.some(re => re.test(domain));
}

/** Persisted set of place IDs already discovered, so repeat runs surface new ones. */
function loadSeen(file) {
  if (!file || !fs.existsSync(file)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(file, 'utf8')).placeIds || []);
  } catch {
    return new Set();
  }
}

function saveSeen(file, seen) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    // Place IDs are the one Places field that may be stored indefinitely.
    // Nothing else from the API goes in here on purpose.
    note: 'Place IDs already discovered. Storable long-term under Places terms; other Places content is not.',
    placeIds: [...seen],
  }, null, 2));
}

function resolveNiches(spec) {
  const all = NICHES.niches;
  if (!spec || spec === 'all') return all;
  if (spec === 'core') return all.filter(n => n.tier === 'core');
  const keys = String(spec).split(',').map(s => s.trim()).filter(Boolean);
  const picked = all.filter(n => keys.includes(n.key));
  const unknown = keys.filter(k => !all.some(n => n.key === k));
  if (unknown.length) throw new Error(`Unknown niche(s): ${unknown.join(', ')}`);
  return picked;
}

function resolveAreas(spec) {
  if (!spec) throw new Error('An --area is required');
  const preset = NICHES.areas[String(spec).toLowerCase()];
  if (preset) return preset;
  return String(spec).split('|').map(s => s.trim()).filter(Boolean);
}

/**
 * @param {object} opts
 *   area      preset key ("orange-county") or "City, ST|City, ST"
 *   niches    "core" | "all" | comma-separated keys
 *   seenFile  path to the dedupe store
 *   onProgress(msg)
 */
async function discover(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const niches = resolveNiches(cfg.niches);
  const areas = resolveAreas(cfg.area);
  // `seenPlaceIds` is how the sheet-backed state store passes dedupe info in;
  // `seenFile` is the local-file path. Either works, neither is required.
  const seen = cfg.seenPlaceIds instanceof Set ? new Set(cfg.seenPlaceIds) : loadSeen(cfg.seenFile);
  const report = msg => cfg.onProgress && cfg.onProgress(msg);

  const byPlaceId = new Map();
  const errors = [];
  let requests = 0;

  for (const niche of niches) {
    for (const area of areas) {
      for (const q of niche.queries) {
        const textQuery = `${q} in ${area}`;
        try {
          const places = await searchText(textQuery, {
            key: cfg.placesKey,
            fieldMask: DISCOVERY_FIELDS,
            max: cfg.perQuery,
          });
          requests++;
          for (const p of places) {
            if (!p.id || byPlaceId.has(p.id)) continue;
            byPlaceId.set(p.id, { place: p, niche, area, foundVia: textQuery });
          }
          report(`${textQuery} → ${places.length}`);
        } catch (err) {
          requests++;
          errors.push(`${textQuery}: ${err.message}`);
          report(`${textQuery} → FAILED (${err.message})`);
          // A hard auth/quota failure will hit every subsequent query too.
          if (/HTTP 40[13]|API key|quota/i.test(err.message)) {
            errors.push('Aborting sweep — this looks like a key or quota problem, not a bad query.');
            return finalize();
          }
        }
        if (cfg.politenessMs) await sleep(cfg.politenessMs);
      }
    }
  }

  return finalize();

  function finalize() {
    // Count locations per domain before filtering — that's how a chain reveals
    // itself, and it's only visible across the whole sweep.
    const locationsByDomain = new Map();
    for (const { place } of byPlaceId.values()) {
      const d = normalizeDomain(place.websiteUri);
      if (d) locationsByDomain.set(d, (locationsByDomain.get(d) || 0) + 1);
    }

    // Every place ID we saw, grouped by domain. Needed because one company can
    // surface as several storefronts: we keep one, and all of its siblings have
    // to be marked seen too. Otherwise the next sweep skips the storefront we
    // kept, lets a sibling through, and hands the rep the same company again.
    const placeIdsByDomain = new Map();
    for (const [placeId, { place }] of byPlaceId) {
      const d = normalizeDomain(place.websiteUri);
      if (!d) continue;
      if (!placeIdsByDomain.has(d)) placeIdsByDomain.set(d, []);
      placeIdsByDomain.get(d).push(placeId);
    }

    const candidates = [];
    const rejected = { noWebsite: 0, chainOrDirectory: 0, closed: 0, tooSmall: 0, tooBig: 0, multiLocation: 0, alreadySeen: 0, duplicateDomain: 0 };
    const keptDomains = new Set();

    for (const [placeId, entry] of byPlaceId) {
      const p = entry.place;
      const domain = normalizeDomain(p.websiteUri);
      const reviews = p.userRatingCount ?? 0;

      if (seen.has(placeId)) { rejected.alreadySeen++; continue; }
      if (!domain) { rejected.noWebsite++; continue; }
      if (isNeverProspect(domain)) { rejected.chainOrDirectory++; continue; }
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') { rejected.closed++; continue; }
      if (reviews < cfg.minReviews) { rejected.tooSmall++; continue; }
      if (reviews > cfg.maxReviews) { rejected.tooBig++; continue; }
      if ((locationsByDomain.get(domain) || 1) > cfg.maxLocations) { rejected.multiLocation++; continue; }
      // One prospect per company, not one per storefront.
      if (keptDomains.has(domain)) { rejected.duplicateDomain++; continue; }

      keptDomains.add(domain);
      candidates.push({
        placeId,
        // Every storefront of this company, so the state store can mark the
        // whole company seen rather than just the one we picked.
        placeIds: (placeIdsByDomain.get(domain) || [placeId]).join(' '),
        domain,
        name: p.displayName?.text || domain,
        website: p.websiteUri,
        address: p.formattedAddress || null,
        phone: p.nationalPhoneNumber || null,
        rating: p.rating ?? null,
        reviewCount: reviews,
        category: p.primaryTypeDisplayName?.text || null,
        locations: locationsByDomain.get(domain) || 1,
        niche: entry.niche.key,
        industry: entry.niche.industry,
        area: entry.area,
        foundVia: entry.foundVia,
        discoveredAt: new Date().toISOString(),
      });
    }

    // Most reviews first: they have the most demand flowing in, so they have
    // the most to lose from the leaks — and the most to pay to fix them.
    candidates.sort((a, b) => b.reviewCount - a.reviewCount);

    if (cfg.seenFile) {
      for (const c of candidates) {
        // Mark the whole company seen, not just the storefront we picked.
        for (const id of placeIdsByDomain.get(c.domain) || [c.placeId]) seen.add(id);
      }
      saveSeen(cfg.seenFile, seen);
    }

    return {
      candidates,
      stats: {
        requests,
        queriesPlanned: niches.reduce((n, x) => n + x.queries.length, 0) * areas.length,
        uniquePlaces: byPlaceId.size,
        kept: candidates.length,
        rejected,
        niches: niches.map(n => n.key),
        areas,
      },
      errors,
    };
  }
}

module.exports = { discover, normalizeDomain, isNeverProspect, resolveNiches, resolveAreas, NICHES };
