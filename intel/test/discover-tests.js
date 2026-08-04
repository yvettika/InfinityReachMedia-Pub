'use strict';

/**
 * Discovery tests against a mock Places server.
 *
 * Discovery is the one part of the system that spends money on every run, and
 * the filters are the only thing standing between a sweep and a list full of
 * franchises, directory sites and twelve storefronts of the same company. So
 * they get tested against a fixture that contains exactly those hazards.
 *
 *   node intel/test/discover-tests.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

const place = (id, name, website, reviews, extra = {}) => ({
  id,
  displayName: { text: name },
  websiteUri: website,
  userRatingCount: reviews,
  rating: 4.5,
  formattedAddress: '123 Example St, Orange, CA',
  nationalPhoneNumber: '(714) 555-0100',
  businessStatus: 'OPERATIONAL',
  primaryTypeDisplayName: { text: 'Contractor' },
  ...extra,
});

/**
 * Returns different fixtures per query so the sweep sees realistic overlap:
 * the same company surfacing in several cities and under several categories.
 */
const FIXTURE = [
  // A normal, well-sized prospect. Appears under two queries — must dedupe.
  place('p_baxter', 'Baxter Heating & Air', 'https://www.baxterheating.com', 180),
  // Same company, second storefront, same domain — one prospect, not two.
  place('p_baxter2', 'Baxter Heating & Air - Tustin', 'https://baxterheating.com', 95),
  // Too few reviews.
  place('p_new', 'Brand New HVAC', 'https://brandnewhvac.com', 3),
  // Too many reviews — regional player with staff.
  place('p_big', 'Giant Regional Air', 'https://giantregional.com', 4200),
  // Directory listing, never a prospect.
  place('p_yelp', 'HVAC Near You', 'https://www.yelp.com/biz/hvac', 500),
  // National franchise.
  place('p_roto', 'Roto-Rooter Plumbing', 'https://www.rotorooter.com/orange', 300),
  // No website — can't research it, so it can't be a prospect.
  place('p_nosite', 'Phone Only Plumbing', null, 120),
  // Permanently closed.
  place('p_closed', 'Closed Heating Co', 'https://closedheating.com', 200,
    { businessStatus: 'CLOSED_PERMANENTLY' }),
  // A second genuine prospect, fewer reviews than Baxter — checks sort order.
  place('p_meridian', 'Meridian Climate', 'https://meridianclimate.com', 140),
];

function startMockPlaces() {
  let requests = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      requests++;
      const { textQuery } = JSON.parse(body || '{}');
      // Only return plumbing-ish results for plumbing queries so the niche
      // attribution can be checked.
      const isPlumbing = /plumb/i.test(textQuery || '');
      const places = isPlumbing
        ? FIXTURE.filter(p => /Plumbing|Roto/i.test(p.displayName.text))
        : FIXTURE.filter(p => !/Plumbing|Roto/i.test(p.displayName.text));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ places }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, count: () => requests }));
  });
}

(async () => {
  const mock = await startMockPlaces();
  process.env.PLACES_ENDPOINT = `http://127.0.0.1:${mock.port}/`;
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';

  const { discover, normalizeDomain, isNeverProspect, resolveNiches, resolveAreas } =
    require('../lib/discover');

  console.log('\nfilters and normalisation');
  {
    test('domains normalise to a bare host', () => {
      assert.strictEqual(normalizeDomain('https://www.Baxter.com/contact'), 'baxter.com');
      assert.strictEqual(normalizeDomain('baxter.com'), 'baxter.com');
      assert.strictEqual(normalizeDomain(null), null);
      assert.strictEqual(normalizeDomain('not a url'), null);
    });
    test('directories and franchises are never prospects', () => {
      for (const d of ['yelp.com', 'www.rotorooter.com', 'statefarm.com', 'greatclips.com']) {
        assert.ok(isNeverProspect(d), `${d} should be excluded`);
      }
      assert.ok(!isNeverProspect('baxterheating.com'));
    });
    test('niche selection resolves core, all and explicit keys', () => {
      assert.ok(resolveNiches('core').every(n => n.tier === 'core'));
      assert.ok(resolveNiches('all').length >= resolveNiches('core').length);
      assert.deepStrictEqual(resolveNiches('hvac,plumbing').map(n => n.key), ['hvac', 'plumbing']);
      assert.throws(() => resolveNiches('nonsense'), /Unknown niche/);
    });
    test('area presets expand, explicit areas split on pipe', () => {
      assert.ok(resolveAreas('orange-county').length > 5);
      assert.deepStrictEqual(resolveAreas('Tustin, CA|Orange, CA'), ['Tustin, CA', 'Orange, CA']);
      assert.throws(() => resolveAreas(null), /--area is required/);
    });
  }

  console.log('\nsweep');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-disc-'));
  const seenFile = path.join(tmp, 'seen.json');

  const run = await discover({
    area: 'Orange, CA|Tustin, CA',
    niches: 'hvac,plumbing',
    seenFile,
    politenessMs: 0,
  });

  {
    const byDomain = new Map(run.candidates.map(c => [c.domain, c]));

    test('keeps the genuine prospects', () => {
      assert.ok(byDomain.has('baxterheating.com'), 'Baxter missing');
      assert.ok(byDomain.has('meridianclimate.com'), 'Meridian missing');
    });
    test('one prospect per company, not one per storefront', () => {
      const baxters = run.candidates.filter(c => c.domain === 'baxterheating.com');
      assert.strictEqual(baxters.length, 1, `got ${baxters.length} Baxter rows`);
      assert.ok(run.stats.rejected.duplicateDomain > 0, 'duplicate domains were never counted');
    });
    test('rejects directories, franchises, closed, tiny, huge and website-less', () => {
      for (const d of ['yelp.com', 'rotorooter.com', 'closedheating.com',
                       'brandnewhvac.com', 'giantregional.com']) {
        assert.ok(!byDomain.has(d), `${d} should have been filtered`);
      }
      assert.ok(!run.candidates.some(c => c.name === 'Phone Only Plumbing'));
      const r = run.stats.rejected;
      assert.ok(r.chainOrDirectory >= 2, 'chains/directories not counted');
      assert.ok(r.tooSmall >= 1 && r.tooBig >= 1 && r.closed >= 1 && r.noWebsite >= 1);
    });
    test('ranks by review count — most demand flowing in, most to lose', () => {
      for (let i = 1; i < run.candidates.length; i++) {
        assert.ok(run.candidates[i - 1].reviewCount >= run.candidates[i].reviewCount);
      }
    });
    test('carries niche, industry and provenance on every candidate', () => {
      for (const c of run.candidates) {
        assert.ok(c.niche && c.industry, `missing niche/industry on ${c.domain}`);
        assert.ok(c.foundVia && c.area, `missing provenance on ${c.domain}`);
        assert.ok(c.discoveredAt, `missing timestamp on ${c.domain}`);
      }
    });
    test('every candidate maps to a real prior set', () => {
      const industries = require('../data/industries.json');
      for (const c of run.candidates) {
        assert.ok(industries[c.industry], `${c.industry} has no priors`);
      }
    });
    test('reports request count so a run can be costed', () => {
      assert.strictEqual(run.stats.requests, mock.count());
      assert.strictEqual(run.stats.requests, run.stats.queriesPlanned);
    });
  }

  console.log('\nseen-store');
  {
    test('seen-store persists only place IDs, never Places content', () => {
      const saved = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
      assert.ok(Array.isArray(saved.placeIds) && saved.placeIds.length > 0);
      const blob = JSON.stringify(saved);
      assert.ok(!blob.includes('baxterheating.com'), 'domain leaked into the seen-store');
      assert.ok(!blob.includes('Baxter'), 'business name leaked into the seen-store');
    });

    const second = await discover({
      area: 'Orange, CA|Tustin, CA', niches: 'hvac,plumbing', seenFile, politenessMs: 0,
    });
    test('repeat run returns no duplicates of the first', () => {
      assert.strictEqual(second.candidates.length, 0,
        `expected 0 new, got ${second.candidates.map(c => c.domain).join(', ')}`);
      assert.ok(second.stats.rejected.alreadySeen > 0);
    });

    const fresh = await discover({
      area: 'Orange, CA', niches: 'hvac', seenFile: null, politenessMs: 0,
    });
    test('--fresh equivalent (no seen file) re-surfaces everything', () => {
      assert.ok(fresh.candidates.length > 0);
    });
  }

  console.log('\nfailure handling');
  {
    const dead = http.createServer((req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"API key not valid"}}');
    });
    await new Promise(r => dead.listen(0, '127.0.0.1', r));
    process.env.PLACES_ENDPOINT = `http://127.0.0.1:${dead.address().port}/`;

    const failedRun = await discover({
      area: 'Orange, CA|Tustin, CA', niches: 'hvac,plumbing', seenFile: null, politenessMs: 0,
    });

    test('aborts the sweep on an auth failure instead of burning every query', () => {
      assert.strictEqual(failedRun.candidates.length, 0);
      assert.ok(failedRun.errors.some(e => /API key|403/i.test(e)));
      assert.ok(failedRun.errors.some(e => /Aborting sweep/i.test(e)));
      assert.ok(failedRun.stats.requests < failedRun.stats.queriesPlanned,
        'kept querying after a key failure');
    });
    dead.close();
  }

  mock.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
