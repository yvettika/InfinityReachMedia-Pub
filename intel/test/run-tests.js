'use strict';

/**
 * End-to-end tests against a local fixture server.
 *
 * These run the real collector over real HTTP — fetch, robots.txt, extra-page
 * discovery, detection, model, brief — rather than calling detect() on a
 * string. The bugs worth catching in this system live in the seams.
 *
 *   node intel/test/run-tests.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { collect } = require('../lib/collect');
const { analyze, computeLeaks } = require('../lib/model');
const { renderMarkdown } = require('../lib/brief');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** Serves one fixture as the homepage; /careers is disallowed via robots.txt. */
function startServer(fixtureFile) {
  const html = fs.readFileSync(path.join(FIXTURES, fixtureFile), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /careers\n');
    }
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (url === '/contact') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body><form><input name="q"></form></body></html>');
    }
    if (url === '/careers') {
      // Should never be requested — robots.txt disallows it. If a test sees
      // this flag flip, the crawler is ignoring robots.
      server.__careersHit = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>now hiring dispatcher</body></html>');
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('not found');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function research(fixture, industry) {
  const { server, port } = await startServer(fixture);
  try {
    const record = await collect(`http://127.0.0.1:${port}`, { politenessMs: 0, timeoutMs: 5000 });
    const analysis = record.signals ? analyze(record, industry) : null;
    return { record, analysis, server };
  } finally {
    server.close();
  }
}

(async () => {
  console.log('\nneglected-hvac.html — the classic underserved prospect');
  const neglected = await research('neglected-hvac.html', 'hvac');
  {
    const s = neglected.record.signals;
    const a = neglected.analysis;

    test('homepage fetched and parsed', () => {
      assert.strictEqual(neglected.record.pages[0].status, 200);
      assert.match(s.title, /Baxter Heating/);
    });
    test('no chat widget found', () => assert.strictEqual(s.chat.present, false));
    test('no booking system found', () => assert.strictEqual(s.booking.present, false));
    test('no CRM found', () => assert.strictEqual(s.crm.present, false));
    test('phone number extracted', () => {
      assert.strictEqual(s.phone.present, true);
      assert.ok(s.phone.numbers[0].includes('714'));
    });
    test('platform identified as GoDaddy', () => assert.match(s.platform.vendor, /GoDaddy/));
    test('no mobile viewport detected', () => assert.strictEqual(s.performance.hasViewport, false));
    test('robots.txt disallow was honoured (/careers never requested)', () => {
      assert.ok(!neglected.server.__careersHit, '/careers was fetched despite Disallow');
      assert.deepStrictEqual(neglected.record.robots.disallow, ['/careers']);
    });
    test('reactivation inferred as absent (no CRM)', () => {
      assert.strictEqual(a.inputs.reactivation.value, 1);
      assert.strictEqual(a.inputs.reactivation.basis, 'inferred');
    });
    test('score lands in a leaking band', () => {
      assert.ok(a.pct < 75, `expected a leaking score, got ${a.pct}`);
      assert.ok(['Critical', 'Heavy loss', 'Leaking'].includes(a.band));
    });
    test('lead volume unknown → unit basis flagged', () => {
      assert.strictEqual(a.unitBasis, true);
      assert.match(a.inputs.leads.display, /per 100 leads/);
    });
  }

  console.log('\nequipped-hvac.html — already has tooling, harder sale');
  const equipped = await research('equipped-hvac.html', 'hvac');
  {
    const s = equipped.record.signals;
    const a = equipped.analysis;

    test('Podium chat detected', () => assert.match(s.chat.vendor, /Podium/));
    test('Housecall Pro booking detected', () => assert.match(s.booking.vendor, /Housecall/));
    test('HubSpot CRM detected', () => assert.match(s.crm.vendor, /HubSpot/));
    test('Meta Pixel detected', () => assert.match(s.adPixels.vendor, /Meta/));
    test('CallRail call tracking detected', () => assert.match(s.callTracking.vendor, /CallRail/));
    test('24/7 claim detected', () => assert.strictEqual(s.claims.afterHours.present, true));
    test('financing claim detected', () => assert.strictEqual(s.claims.financing.present, true));
    test('text-us option detected', () => assert.strictEqual(s.claims.textUs.present, true));
    test('CSR hiring signal detected', () => {
      assert.strictEqual(s.claims.hiring.present, true);
      assert.strictEqual(s.claims.hiringSalesOrCSR.present, true);
    });
    test('LocalBusiness schema detected', () => assert.strictEqual(s.localBusinessSchema.present, true));
    test('social profiles collected', () => {
      assert.ok(s.social.profiles.includes('Facebook'));
      assert.ok(s.social.profiles.includes('LinkedIn'));
    });
    test('reactivation inferred as present (CRM found)', () => assert.strictEqual(a.inputs.reactivation.value, 0));
    test('equipped prospect scores better than neglected one', () => {
      assert.ok(a.pct > neglected.analysis.pct,
        `equipped ${a.pct} should beat neglected ${neglected.analysis.pct}`);
    });
    test('predicts objections from the tooling it detected', () => {
      // Asserted structurally, not against exact wording: the real playbook is
      // gitignored and a fresh clone runs on placeholder rules. Both must
      // produce well-formed objections that reference what was actually found.
      const { predictObjections } = require('../lib/objections');
      const predicted = predictObjections(equipped.record, a);

      assert.ok(predicted.length >= 2, `expected multiple objections, got ${predicted.length}`);
      for (const o of predicted) {
        assert.ok(o.objection && o.objection.length > 5, `empty objection on ${o.id}`);
        assert.ok(o.why && o.why.length > 5, `empty rationale on ${o.id}`);
        assert.ok(Array.isArray(o.response) && o.response.length, `no response for ${o.id}`);
      }

      const vendors = ['Podium', 'HubSpot', 'Housecall', 'Meta'];
      const blob = predicted.map(o => `${o.objection} ${o.why}`).join(' ');
      assert.ok(vendors.some(v => blob.includes(v)),
        'no predicted objection referenced a detected vendor');
    });
  }

  console.log('\nmodel properties');
  {
    const a = neglected.analysis;
    const vals = Object.fromEntries(Object.entries(a.inputs).map(([k, v]) => [k, v.value]));

    test('score is invariant to lead volume', () => {
      const x = computeLeaks({ ...vals, leads: 40 });
      const y = computeLeaks({ ...vals, leads: 4000 });
      assert.strictEqual(x.pct, y.pct);
    });
    test('score is invariant to customer value', () => {
      const x = computeLeaks({ ...vals, avgValue: 200 });
      const y = computeLeaks({ ...vals, avgValue: 20000 });
      assert.strictEqual(x.pct, y.pct);
    });
    test('dollars scale linearly with lead volume', () => {
      const x = computeLeaks({ ...vals, leads: 100 });
      const y = computeLeaks({ ...vals, leads: 200 });
      assert.ok(Math.abs(y.annualRecover - x.annualRecover * 2) < 1);
    });

    test('leak math matches scorecard.html exactly', () => {
      // Independent re-implementation of the formulas in scorecard.html.
      // If someone edits one side without the other, this fails.
      const v = { avgValue: 1500, leads: 120, closeRate: 0.25, missedCallPct: 30,
                  responseTime: 2, noShowPct: 20, followUps: 2, reactivation: 1, reviews: 1 };
      const V = v.avgValue, L = v.leads, C = v.closeRate;
      const base = L * C, unclosed = L * (1 - C);
      const expected =
        L * 0.6 * (v.missedCallPct / 100) * C * V * 0.8 +
        base * [0, .08, .18, .30][v.responseTime] * V * 0.7 +
        base * (v.noShowPct / 100) * V * 0.55 +
        unclosed * [0, .015, .03, .05][v.followUps] * V +
        base * 0.12 * V +
        base * [0, .04, .08][v.reviews] * V;
      const got = computeLeaks(v);
      assert.ok(Math.abs(got.monthlyRecover - expected) < 0.001,
        `model ${got.monthlyRecover} vs scorecard ${expected}`);
      const pct = Math.round((base * V * 12) / (base * V * 12 + expected * 12) * 100);
      assert.strictEqual(got.pct, pct);
    });

    test('sensitivity covers unknowns only, never observed inputs', () => {
      assert.ok(a.sensitivity.length > 0);
      for (const row of a.sensitivity) assert.notStrictEqual(row.basis, 'observed');
    });

    test('pure scale factors are classed as scaling, not diagnostic', () => {
      // leads and avgValue multiply every dollar but cancel out of the score,
      // so they must never outrank a question that changes the diagnosis.
      const scalingKeys = a.sensitivity.scaling.map(r => r.key).sort();
      assert.deepStrictEqual(scalingKeys, ['avgValue', 'leads']);
      for (const row of a.sensitivity.scaling) assert.strictEqual(row.scoreSwing, 0);
      for (const row of a.sensitivity.diagnostic) assert.ok(row.scoreSwing > 0);
    });

    test('diagnostic questions sort by score swing, and come first overall', () => {
      const d = a.sensitivity.diagnostic;
      for (let i = 1; i < d.length; i++) {
        assert.ok(d[i - 1].scoreSwing >= d[i].scoreSwing, 'diagnostic not sorted by score swing');
      }
      assert.deepStrictEqual(
        a.sensitivity.slice(0, d.length).map(r => r.key),
        d.map(r => r.key),
        'scaling questions leaked into the top of the list'
      );
    });

    test('agent shares sum to ~100%', () => {
      const total = a.agents.reduce((s, x) => s + x.sharePct, 0);
      assert.ok(Math.abs(total - 100) <= 2, `got ${total}%`);
    });
  }

  console.log('\nbrief rendering');
  {
    const md = renderMarkdown(neglected.record, neglected.analysis, 'hvac');

    test('all required sections present', () => {
      for (const h of ['Revenue Leak Score', 'Say this', 'Ask this first',
                       'Do not say', 'Where the money is going', 'Lead with',
                       'Objections you should expect', 'Proof to cite',
                       'Recommended offer', 'Appendix']) {
        assert.ok(md.includes(h), `missing section: ${h}`);
      }
    });
    test('assumed inputs are listed under "Do not say"', () => {
      const section = md.split('## Do not say')[1].split('##')[0];
      assert.match(section, /avgValue/);
      assert.match(section, /closeRate/);
    });
    test('absences are phrased as "could not find", not as fact', () => {
      assert.match(md, /Say "I couldn't find…", not "you don't have…"/);
    });
    test('every appendix input carries a basis', () => {
      const appendix = md.split('## Appendix')[1];
      for (const key of Object.keys(neglected.analysis.inputs)) {
        const row = appendix.split('\n').find(l => l.includes('`' + key + '`'));
        assert.ok(row, `no appendix row for ${key}`);
        assert.ok(/observed|inferred|assumed/.test(row), `no basis for ${key}`);
      }
    });
    test('no fabricated proof — quotes match the loaded proof file verbatim', () => {
      const proof = require('../lib/playbook').load('data/proof.json');
      const quoted = [...md.matchAll(/^> "(.+)"$/gm)].map(m => m[1]);
      const known = proof.testimonials.map(t => t.quote);
      for (const q of quoted) {
        if (q.startsWith('You\'ve got') || q.startsWith('I ')) continue; // opening lines
        assert.ok(known.includes(q), `unrecognised quote in brief: ${q.slice(0, 40)}…`);
      }
    });
    test('proof attributions exist in data file', () => {
      const proof = require('../lib/playbook').load('data/proof.json');
      const names = proof.testimonials.map(t => t.name);
      const cited = [...md.matchAll(/^> — \*\*(.+?)\*\*/gm)].map(m => m[1]);
      assert.ok(cited.length > 0, 'no proof cited at all');
      for (const c of cited) assert.ok(names.includes(c), `unknown attribution: ${c}`);
    });
  }

  console.log('\nplaybook privacy');
  {
    const { execSync } = require('child_process');
    const PRIVATE = ['intel/data/objection-rules.js', 'intel/data/industries.json', 'intel/data/proof.json'];

    test('every private playbook file is gitignored', () => {
      // This repo is public. If one of these ever stops being ignored, the
      // objection handling and priors go public on the next commit.
      for (const f of PRIVATE) {
        const out = execSync(`git check-ignore ${f} || true`, {
          cwd: path.join(__dirname, '..', '..'), encoding: 'utf8',
        }).trim();
        assert.strictEqual(out, f, `${f} is NOT gitignored`);
      }
    });

    test('every private file has a committed .example sibling', () => {
      for (const f of PRIVATE) {
        const ext = path.extname(f);
        const ex = path.join(__dirname, '..', '..', f.slice(0, -ext.length) + '.example' + ext);
        assert.ok(fs.existsSync(ex), `missing example for ${f}`);
      }
    });

    test('example playbook exposes the same industry keys as the real one', () => {
      // A fresh clone must not blow up on `--industry hvac`. Only checkable
      // when both files exist — on a clean clone there is no real file yet.
      const realPath = path.join(__dirname, '..', 'data', 'industries.json');
      if (!fs.existsSync(realPath)) {
        assert.ok(require('../data/industries.example.json').hvac, 'example lacks hvac');
        return;
      }
      const keys = o => Object.keys(o).filter(k => !k.startsWith('_')).sort();
      assert.deepStrictEqual(
        keys(require('../data/industries.example.json')),
        keys(require(realPath))
      );
    });
  }

  console.log('\nfailure handling');
  {
    const record = await collect('http://127.0.0.1:1/', { politenessMs: 0, timeoutMs: 1500 });
    test('unreachable host fails loudly instead of inventing a brief', () => {
      assert.strictEqual(record.signals, null);
      assert.ok(record.errors.length > 0);
      assert.match(record.errors[0], /Could not read the homepage/);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
