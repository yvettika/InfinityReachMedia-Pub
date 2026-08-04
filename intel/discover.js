#!/usr/bin/env node
'use strict';

/**
 * Find businesses worth researching.
 *
 *   node intel/discover.js --area orange-county --niches core
 *   node intel/discover.js --area orange-county --niches all --out prospects/
 *   node intel/discover.js --area "Tustin, CA|Orange, CA" --niches hvac,plumbing
 *
 * Writes a domain list that `intel.js --batch` consumes, plus the full Places
 * records so research doesn't have to pay for that lookup twice.
 *
 * Requires GOOGLE_PLACES_API_KEY. Every query is billed — run --dry-run first
 * to see how many you're about to make.
 */

const fs = require('fs');
const path = require('path');
const { discover, resolveNiches, resolveAreas, NICHES } = require('./lib/discover');

const USAGE = `
Discovery — find businesses worth researching

  node intel/discover.js --area <area> [options]

Required
  --area <area>        preset (${Object.keys(NICHES.areas).filter(k => !k.startsWith('_')).join(', ')})
                       or "City, ST|City, ST"

Options
  --niches <spec>      core (default) | all | comma-separated keys
  --out <dir>          output directory (default: prospects/)
  --min-reviews <n>    skip businesses below this (default 10)
  --max-reviews <n>    skip businesses above this (default 1500)
  --fresh              ignore the seen-store and re-surface everything
  --dry-run            print the query plan and cost estimate, call nothing
  --list-niches        show available niches and exit

Environment
  GOOGLE_PLACES_API_KEY   required (except --dry-run / --list-niches)
`;

function parseArgs(argv) {
  const o = { area: null, niches: 'core', out: 'prospects', fresh: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--area') o.area = argv[++i];
    else if (a === '--niches') o.niches = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--min-reviews') o.minReviews = Number(argv[++i]);
    else if (a === '--max-reviews') o.maxReviews = Number(argv[++i]);
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--list-niches') o.listNiches = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message + '\n' + USAGE);
    process.exit(2);
  }

  if (o.help) { console.log(USAGE); return; }

  if (o.listNiches) {
    for (const n of NICHES.niches) {
      console.log(`  ${n.key.padEnd(20)} ${n.tier.padEnd(5)} ${n.label} → priors: ${n.industry}`);
    }
    return;
  }

  if (!o.area) { console.error('--area is required\n' + USAGE); process.exit(2); }

  let niches, areas;
  try {
    niches = resolveNiches(o.niches);
    areas = resolveAreas(o.area);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const queries = niches.reduce((n, x) => n + x.queries.length, 0) * areas.length;

  if (o.dryRun) {
    console.log(`\nQuery plan`);
    console.log(`  niches:  ${niches.length} (${niches.map(n => n.key).join(', ')})`);
    console.log(`  areas:   ${areas.length}`);
    console.log(`  queries: ${queries}  — each is one billed Places request returning up to 20 results`);
    console.log(`\nCheck current Google Places Text Search pricing for what ${queries} requests costs;`);
    console.log(`the sweep uses the reduced field mask (no reviews) to stay on the cheaper tier.`);
    console.log(`Expect well under ${queries * 20} unique businesses after dedupe — categories overlap`);
    console.log(`heavily between neighbouring cities, which is why dedupe happens across the whole run.\n`);
    return;
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.error('GOOGLE_PLACES_API_KEY is not set. Get a key from Google Cloud (Places API must be');
    console.error('enabled on a project with billing), then: export GOOGLE_PLACES_API_KEY=...');
    console.error('\nRun with --dry-run to see the query plan without a key.');
    process.exit(2);
  }

  const outDir = o.out;
  fs.mkdirSync(outDir, { recursive: true });
  const seenFile = path.join(outDir, 'seen-places.json');

  process.stderr.write(`Sweeping ${queries} queries across ${areas.length} areas…\n`);

  const result = await discover({
    area: o.area,
    niches: o.niches,
    minReviews: o.minReviews,
    maxReviews: o.maxReviews,
    seenFile: o.fresh ? null : seenFile,
    onProgress: msg => process.stderr.write(`  ${msg}\n`),
  });

  const jsonPath = path.join(outDir, 'discovered.json');
  const listPath = path.join(outDir, 'prospects.txt');

  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  fs.writeFileSync(
    listPath,
    result.candidates.map(c => c.domain).join('\n') + (result.candidates.length ? '\n' : '')
  );

  const s = result.stats;
  process.stderr.write(`\nFound ${s.uniquePlaces} unique businesses, kept ${s.kept}.\n`);
  process.stderr.write(`Filtered out: ${Object.entries(s.rejected)
    .filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ') || 'nothing'}\n`);
  if (result.errors.length) {
    process.stderr.write(`\n${result.errors.length} query error(s):\n`);
    for (const e of result.errors.slice(0, 10)) process.stderr.write(`  ${e}\n`);
  }
  process.stderr.write(`\n  → ${listPath}\n  → ${jsonPath}\n`);

  // Group by niche so it's obvious where the volume actually came from.
  const byNiche = {};
  for (const c of result.candidates) byNiche[c.niche] = (byNiche[c.niche] || 0) + 1;
  const spread = Object.entries(byNiche).sort((a, b) => b[1] - a[1]);
  if (spread.length) {
    process.stderr.write(`\nBy niche: ${spread.map(([k, n]) => `${k} ${n}`).join(', ')}\n`);
  }

  process.stderr.write(`\nNext:\n  node intel/intel.js --batch ${listPath} --out briefs/\n`);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { parseArgs };
