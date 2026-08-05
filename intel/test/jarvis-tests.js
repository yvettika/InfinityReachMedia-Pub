'use strict';

/**
 * Jarvis bridge tests — against a mock Supabase REST server.
 *
 * The bridge writes into a live production database owned by another system
 * that is actively sending email. The failure modes worth testing are all
 * "quietly damaged Jarvis's data": stomping signals its sourcing wrote,
 * overwriting an email a human corrected, or letting both pipelines claim the
 * same business.
 *
 *   node intel/test/jarvis-tests.js
 */

const http = require('http');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

(async () => {
  // ---- mock Supabase ------------------------------------------------------
  const db = {
    prospects: [
      { id: 'p1', tenant_slug: 'infinity-reach-media', business_name: 'Fenco A Heating And Air Conditioning',
        email: null, website: 'https://www.fencoair.com', city: 'Orange', category: 'HVAC contractor',
        signals: { rating: 4.7, reviews: 212, from_sourcing: true }, icp_score: 78, status: 'new' },
      { id: 'p2', tenant_slug: 'infinity-reach-media', business_name: 'Pure AIR',
        email: 'tom@pureairzones.com', website: 'https://pureairzones.com', city: 'Irvine', category: 'HVAC contractor',
        signals: {}, icp_score: 76, status: 'queued' },
      { id: 'p3', tenant_slug: 'infinity-reach-media', business_name: 'No Website LLC',
        email: null, website: null, city: 'Tustin', category: 'HVAC contractor',
        signals: {}, icp_score: 81, status: 'new' },
    ],
    suppression: [{ email: 'optedout@example.com' }],
    patches: [],
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(obj === null ? '' : JSON.stringify(obj));
      };

      if (!req.headers.apikey || !req.headers.authorization) return send(401, { message: 'no key' });

      if (url.pathname === '/rest/v1/prospects' && req.method === 'GET') {
        let rows = db.prospects;
        const idEq = url.searchParams.get('id');
        if (idEq) rows = rows.filter(p => `eq.${p.id}` === idEq);
        const statusIn = url.searchParams.get('status');
        if (statusIn) {
          const list = statusIn.replace(/^in\.\(|\)$/g, '').split(',');
          rows = rows.filter(p => list.includes(p.status));
        }
        const select = url.searchParams.get('select') || '';
        if (select && select !== '*') {
          const cols = select.split(',');
          rows = rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]])));
        }
        return send(200, rows);
      }

      if (url.pathname === '/rest/v1/prospects' && req.method === 'PATCH') {
        const idEq = url.searchParams.get('id');
        const target = db.prospects.find(p => `eq.${p.id}` === idEq);
        if (!target) return send(404, { message: 'not found' });
        const patch = JSON.parse(body);
        db.patches.push({ id: target.id, patch });
        Object.assign(target, patch);
        return send(204, null);
      }

      if (url.pathname === '/rest/v1/outbound_suppression' && req.method === 'GET') {
        return send(200, db.suppression);
      }

      send(404, { message: `unhandled ${req.method} ${url.pathname}` });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  process.env.JARVIS_SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.JARVIS_SUPABASE_KEY = 'service-key-test';

  const jarvis = require('../lib/jarvis');

  console.log('\nclient basics');
  {
    test('configured() reflects the env', () => {
      assert.strictEqual(jarvis.configured(), true);
      const saved = process.env.JARVIS_SUPABASE_KEY;
      delete process.env.JARVIS_SUPABASE_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      assert.strictEqual(jarvis.configured(), false);
      process.env.JARVIS_SUPABASE_KEY = saved;
    });

    const prospects = await jarvis.listProspects({ statuses: ['new', 'queued'] });
    test('lists prospects with the fields the enricher needs', () => {
      assert.strictEqual(prospects.length, 3);
      const fenco = prospects.find(p => p.id === 'p1');
      assert.ok(fenco.website && fenco.signals && 'email' in fenco);
    });

    const domains = await jarvis.knownDomains();
    test('known domains normalise www and case', () => {
      assert.ok(domains.has('fencoair.com'), 'www. was not stripped');
      assert.ok(domains.has('pureairzones.com'));
      assert.strictEqual(domains.has(''), false);
    });

    const suppressed = await jarvis.suppressedEmails();
    test('suppression list arrives as a lowercase set', () => {
      assert.ok(suppressed.has('optedout@example.com'));
    });
  }

  console.log('\nattachIntel — writing into a live system without damaging it');
  {
    const fenco = db.prospects[0];
    const intel = {
      source: 'prospect-intel', researched_at: '2026-08-05T23:00:00.000Z',
      leak_score: 55, leak_band: 'Heavy loss',
      top_leak: 'Missed & unanswered calls', lead_agent: 'AI Receptionist',
      recoverable_estimate: 348998, unit_basis: true,
      verified_opener: "You've got 212 Google reviews at 4.7 stars",
      verified_facts: ['212 Google reviews at 4.7★ (Google Places)'],
      absences: ['No chat widget found'],
    };

    await jarvis.attachIntel({ id: 'p1' }, intel, { email: 'office@fencoair.com' });

    test('intel lands under signals.intel', () => {
      assert.deepStrictEqual(fenco.signals.intel.leak_band, 'Heavy loss');
      assert.strictEqual(fenco.signals.intel.verified_opener,
        "You've got 212 Google reviews at 4.7 stars");
    });

    test("sourcing's own signal keys survive the write", () => {
      assert.strictEqual(fenco.signals.rating, 4.7, 'sourcing signals were stomped');
      assert.strictEqual(fenco.signals.from_sourcing, true);
    });

    test('an empty email is filled by the crawler', () => {
      assert.strictEqual(fenco.email, 'office@fencoair.com');
    });

    await jarvis.attachIntel({ id: 'p2' }, intel, { email: 'crawler-guess@pureairzones.com' });
    test("an email Jarvis already has is NEVER overwritten", () => {
      assert.strictEqual(db.prospects[1].email, 'tom@pureairzones.com',
        "a human-visible email was replaced by a crawler's guess");
    });

    test('the patch is read-merge-write, not blind replace', () => {
      // Each PATCH must have been preceded by a fresh read of signals — the
      // mock proves it indirectly: the merged object contains keys the caller
      // never passed (rating, from_sourcing), which it can only have gotten
      // by reading first.
      const patch = db.patches.find(x => x.id === 'p1').patch;
      assert.ok('rating' in patch.signals, 'merge did not include pre-existing keys');
      assert.ok('intel' in patch.signals);
    });
  }

  console.log('\ndedupe — one company, one owner');
  {
    const { dedupeAgainstJarvis } = jarvis;
    const candidates = [
      { domain: 'fencoair.com', name: 'Fenco' },          // Jarvis has it
      { domain: 'brandnewhvac.com', name: 'Brand New' },  // ours
      { domain: 'PUREAIRZONES.COM', name: 'Pure AIR' },   // Jarvis has it, case differs
    ];
    const jd = new Set(['fencoair.com', 'pureairzones.com']);
    const split = dedupeAgainstJarvis(candidates, jd);

    test('candidates Jarvis already owns are handed back, not kept', () => {
      assert.deepStrictEqual(split.theirs.map(c => c.name).sort(), ['Fenco', 'Pure AIR']);
      assert.deepStrictEqual(split.mine.map(c => c.name), ['Brand New']);
    });

    test('domain comparison is case-insensitive', () => {
      assert.ok(split.theirs.some(c => c.domain === 'PUREAIRZONES.COM'));
    });
  }

  console.log('\nenricher — the full handoff against the mock');
  {
    // Serve a tiny site for Fenco so collect() has something real to read.
    const site = http.createServer((q, r) => {
      if (q.url === '/robots.txt') { r.writeHead(200); return r.end('User-agent: *\nDisallow:\n'); }
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(`<html><head><title>Brand New HVAC</title></head><body>
        <a href="tel:+17145550100">(714) 555-0100</a>
        <a href="mailto:office@brandnewhvac.com">Email us</a>
        </body></html>`);
    });
    await new Promise(r => site.listen(0, '127.0.0.1', r));

    // Point the remaining unresearched prospect at the tiny site.
    db.prospects[2].website = `http://127.0.0.1:${site.address().port}`;
    db.patches.length = 0;

    const { enrichProspects } = require('../jarvis-enrich');
    const result = await enrichProspects({ limit: 10 });

    test('researches only prospects with a website and no intel yet', () => {
      // p1 and p2 already carry intel from the block above; p3 now has a site.
      assert.strictEqual(result.researched, 1, JSON.stringify(result.details));
      assert.strictEqual(result.failed, 0);
    });

    test('the written intel is honest about its basis', () => {
      const patch = db.patches.find(x => x.id === 'p3').patch;
      const intel = patch.signals.intel;
      assert.strictEqual(intel.unit_basis, true, 'dollar figure not flagged as per-100-leads');
      assert.ok(intel.leak_score >= 0 && intel.leak_score <= 100);
      assert.ok(Array.isArray(intel.verified_facts));
      assert.ok(Array.isArray(intel.absences));
      assert.strictEqual(intel.source, 'prospect-intel');
    });

    const again = await enrichProspects({ limit: 10 });
    test('re-running the enricher is a no-op', () => {
      assert.strictEqual(again.researched, 0, 'reprocessed prospects that already carry intel');
    });

    site.close();
  }

  server.close();
  delete process.env.JARVIS_SUPABASE_URL;
  delete process.env.JARVIS_SUPABASE_KEY;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
