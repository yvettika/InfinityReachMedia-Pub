#!/usr/bin/env node
'use strict';

/**
 * Preview the outreach a prospect would receive.
 *
 *   node intel/outreach.js baxterheating.com --industry hvac
 *
 * Writes nothing anywhere and sends nothing. This exists so the words can be
 * read — and argued with — before a single message reaches a real business.
 */

const { collect } = require('./lib/collect');
const { analyze, INDUSTRIES } = require('./lib/model');
const { composeSequence } = require('./lib/outreach');
const { toProspect } = require('./lib/rows');

const USAGE = `
Preview outreach for one prospect

  node intel/outreach.js <domain> [--industry <key>]

  --industry   ${Object.keys(INDUSTRIES).filter(k => !k.startsWith('_')).join(' | ')}
`;

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(args.length ? 0 : 2);
  }

  let domain = null, industry = 'default';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--industry') industry = args[++i];
    else domain = args[i];
  }

  const record = await collect(domain, { placesKey: process.env.GOOGLE_PLACES_API_KEY });
  if (!record.signals) {
    console.error(`Could not research ${domain}: ${record.errors[0] || 'unknown error'}`);
    process.exit(1);
  }

  const analysis = analyze(record, industry);
  const prospect = toProspect({ domain: record.domain, name: record.places?.name }, analysis);
  const seq = composeSequence(record, analysis, prospect);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${prospect.name || record.domain} — ${analysis.pct}/100 ${analysis.band}`);
  console.log('='.repeat(72));

  if (seq.evidence.length) {
    console.log('\nVerified facts available to this sequence:');
    for (const e of seq.evidence) console.log(`  · ${e}`);
  } else {
    console.log('\nNo verified facts — the opener falls back to a question.');
  }

  if (seq.blockers.length) {
    console.log('\nBlockers (nothing can send until these clear):');
    for (const b of seq.blockers) console.log(`  ! ${b}`);
  }

  for (const step of seq.steps) {
    console.log(`\n${'-'.repeat(72)}`);
    console.log(`STEP ${step.n}${step.sendAfterDays ? ` — day ${step.sendAfterDays}` : ' — immediately'}`);
    console.log(`Subject: ${step.subject}`);
    console.log('-'.repeat(72));
    console.log(step.body);
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log(seq.canSend
    ? 'Ready to draft into GHL. A human still approves before anything sends.'
    : 'NOT sendable yet — see blockers above.');
  console.log('');
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
