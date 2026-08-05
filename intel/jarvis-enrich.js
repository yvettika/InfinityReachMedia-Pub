#!/usr/bin/env node
'use strict';

/**
 * Enrich Jarvis's prospects with this repo's research.
 *
 *   node intel/jarvis-enrich.js --dry-run
 *   node intel/jarvis-enrich.js --limit 15
 *   node intel/jarvis-enrich.js --refresh          # re-research even if intel exists
 *
 * For each prospect Jarvis sourced (Apify → ICP score) that has a website:
 * fetch the site, run the leak model, find a verified opener and a contact
 * email, and write it all under `prospects.signals.intel`. Jarvis's draft
 * prompt receives `signals` verbatim as facts-to-reference, so the next draft
 * it composes for that prospect opens with something we can prove instead of
 * something scraped.
 *
 * What gets written (the contract, also documented in intel/JARVIS.md):
 *
 *   signals.intel = {
 *     source: 'prospect-intel',
 *     researched_at: ISO timestamp,
 *     leak_score:  0-100 (lower = leakier; same scale as the site's scorecard),
 *     leak_band:   'Critical' | 'Heavy loss' | 'Leaking' | 'Minor seepage' | 'Sealed',
 *     top_leak:    the single biggest revenue leak observed,
 *     lead_agent:  which IRM agent closes it,
 *     recoverable_estimate: dollar figure — PER 100 LEADS/MONTH when
 *                  unit_basis is true, which it almost always is pre-contact,
 *     unit_basis:  boolean — when true the dollar figure is a scale
 *                  illustration, not a claim about this business,
 *     verified_opener: one observation safe to state as fact, or null,
 *     verified_facts:  [ 'fact (source)', ... ]  — each traceable to a fetch,
 *     absences: [ 'No chat widget found', ... ] — phrased as absence of
 *                  evidence; the draft model may ask about these, never assert
 *   }
 *
 * Never touched: any other key in signals, icp_score, icp_reason, status, or
 * an email Jarvis already has.
 */

const { collect } = require('./lib/collect');
const { analyze } = require('./lib/model');
const { openingObservation } = require('./lib/outreach');
const { observedFacts, absences } = require('./lib/brief');
const jarvis = require('./lib/jarvis');

const USAGE = `
Enrich Jarvis prospects with verified research

  node intel/jarvis-enrich.js [options]

Options
  --limit <n>     max prospects to research this run (default 15)
  --refresh       re-research prospects that already carry intel
  --statuses <s>  comma list (default: new,queued)
  --dry-run       research, but write nothing back

Environment
  JARVIS_SUPABASE_URL / JARVIS_SUPABASE_KEY   Jarvis's Supabase (required)
  GOOGLE_PLACES_API_KEY                       optional review enrichment
`;

/** Map Jarvis's scraped Google category onto this repo's industry priors. */
function industryFor(category) {
  const c = String(category || '').toLowerCase();
  if (/hvac|heating|air condition|plumb|electric|roof|garage|pest|contractor|restoration|solar|landscap/.test(c)) return 'hvac';
  if (/insurance/.test(c)) return 'insurance';
  if (/salon|spa|beauty|nail|barber/.test(c)) return 'salon';
  return 'default';
}

function buildIntel(record, analysis) {
  const facts = observedFacts(record, analysis).map(f => `${f.fact} (${f.source})`);
  const gaps = absences(record).map(g => g.headline);
  const opener = openingObservation(record, analysis);

  return {
    source: 'prospect-intel',
    researched_at: new Date().toISOString(),
    leak_score: analysis.pct,
    leak_band: analysis.band,
    top_leak: analysis.leaks.items.find(i => i.monthly > 0)?.label || null,
    lead_agent: analysis.agents[0]?.agent || null,
    recoverable_estimate: Math.round(analysis.leaks.annualRecover),
    unit_basis: analysis.unitBasis === true,
    verified_opener: opener ? opener.text : null,
    verified_facts: facts.slice(0, 8),
    absences: gaps.slice(0, 6),
  };
}

function parseArgs(argv) {
  const o = { limit: 15, statuses: ['new', 'queued'], refresh: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--statuses') o.statuses = String(argv[++i]).split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const log = m => process.stderr.write(m + '\n');

async function enrichProspects(o = {}) {
  const limit = o.limit ?? 15;
  const prospects = await jarvis.listProspects({ statuses: o.statuses || ['new', 'queued'], limit: 500 });

  const todo = prospects
    .filter(p => p.website)
    .filter(p => o.refresh || !(p.signals && p.signals.intel))
    .slice(0, limit);

  const skippedNoSite = prospects.filter(p => !p.website).length;
  const results = { researched: 0, failed: 0, emailsFilled: 0, skippedNoSite, considered: prospects.length, details: [] };

  for (const p of todo) {
    const domain = jarvis.normDomain(p.website);
    try {
      const record = await collect(p.website, {
        placesKey: process.env.GOOGLE_PLACES_API_KEY,
        contactDomain: domain,
      });
      if (!record.signals) {
        results.failed++;
        results.details.push({ id: p.id, name: p.business_name, ok: false, reason: record.errors[0] || 'unreadable' });
        continue;
      }

      const analysis = analyze(record, industryFor(p.category));
      const intel = buildIntel(record, analysis);
      const email = !p.email && record.email ? record.email.email : null;

      if (!o.dryRun) {
        const wrote = await jarvis.attachIntel(p, intel, { email });
        if (wrote.emailFilled) results.emailsFilled++;
      } else if (email) {
        results.emailsFilled++;
      }

      results.researched++;
      results.details.push({
        id: p.id, name: p.business_name, ok: true,
        score: intel.leak_score, band: intel.leak_band,
        opener: intel.verified_opener ? 'verified' : 'question-only',
        emailFilled: !!email,
      });
      log(`  ✓ ${p.business_name} — ${intel.leak_score}/100 ${intel.leak_band}` +
          `${intel.verified_opener ? '' : ' (no verifiable opener)'}${email ? ' +email' : ''}`);
    } catch (err) {
      results.failed++;
      results.details.push({ id: p.id, name: p.business_name, ok: false, reason: err.message.slice(0, 120) });
      log(`  ✗ ${p.business_name} — ${err.message}`);
    }
  }

  return results;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message + USAGE); process.exit(2); }
  if (o.help) { console.log(USAGE); return; }

  if (!jarvis.configured()) {
    console.error('Jarvis bridge not configured — set JARVIS_SUPABASE_URL and JARVIS_SUPABASE_KEY.');
    console.error('(Same values as the lead-generation-agent Vercel project uses.)');
    process.exit(2);
  }

  log(`Enriching Jarvis prospects (tenant: ${jarvis.TENANT()})${o.dryRun ? ' — DRY RUN' : ''}…`);
  const r = await enrichProspects(o);
  log(`\n${r.researched} researched, ${r.failed} failed, ${r.emailsFilled} emails filled` +
      (r.skippedNoSite ? `, ${r.skippedNoSite} had no website` : '') +
      `${o.dryRun ? ' (nothing written)' : ''}.`);
  log('Jarvis will use the intel on the next draft it composes for each prospect.');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { enrichProspects, buildIntel, industryFor, parseArgs };
