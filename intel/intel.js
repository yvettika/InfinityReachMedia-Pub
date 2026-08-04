#!/usr/bin/env node
'use strict';

/**
 * Prospect intel — build a pre-call brief for one business.
 *
 *   node intel/intel.js acmehvac.com --industry hvac
 *   node intel/intel.js acmehvac.com --industry hvac --out briefs/acme.md
 *   node intel/intel.js acmehvac.com --json
 *   node intel/intel.js --batch prospects.txt --industry hvac --out briefs/
 *
 * Zero dependencies — Node 18+ for global fetch. Nothing to install.
 *
 * Google Places enrichment turns on if GOOGLE_PLACES_API_KEY is set. Without
 * it the brief still works; review volume just moves from "say this" to
 * "ask this".
 */

const fs = require('fs');
const path = require('path');
const { collect } = require('./lib/collect');
const { analyze, INDUSTRIES } = require('./lib/model');
const { renderMarkdown } = require('./lib/brief');

function parseArgs(argv) {
  const opts = { targets: [], industry: 'default', json: false, out: null, skipExtraPages: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--industry') opts.industry = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--batch') {
      const file = argv[++i];
      opts.targets.push(...fs.readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')));
    }
    else if (a === '--json') opts.json = true;
    else if (a === '--no-extra') opts.skipExtraPages = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
    else opts.targets.push(a);
  }
  return opts;
}

const USAGE = `
Prospect intel — pre-call brief generator

  node intel/intel.js <domain> [options]

Options
  --industry <key>   ${Object.keys(INDUSTRIES).filter(k => !k.startsWith('_')).join(' | ')}
  --batch <file>     newline-separated domains ('#' comments allowed)
  --out <path>       write to a file, or a directory when batching
  --json             emit the full structured record instead of the brief
  --no-extra         homepage only (faster, less complete)

Environment
  GOOGLE_PLACES_API_KEY   optional; adds review volume and velocity
`;

async function runOne(target, opts) {
  const record = await collect(target, {
    placesKey: process.env.GOOGLE_PLACES_API_KEY,
    skipExtraPages: opts.skipExtraPages,
  });

  if (!record.signals) {
    return {
      record,
      analysis: null,
      output: `# Call brief — ${record.domain}\n\n**Could not research this prospect.**\n\n` +
        record.errors.map(e => `- ${e}`).join('\n') +
        `\n\nDo not call from this brief. There is nothing in it.\n`,
    };
  }

  const analysis = analyze(record, opts.industry);
  const output = opts.json
    ? JSON.stringify({ record, analysis }, null, 2)
    : renderMarkdown(record, analysis, opts.industry);
  return { record, analysis, output };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }

  if (opts.help || !opts.targets.length) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 2);
  }

  if (!INDUSTRIES[opts.industry]) {
    console.error(`Unknown industry "${opts.industry}". Known: ${Object.keys(INDUSTRIES).filter(k => !k.startsWith('_')).join(', ')}`);
    process.exit(2);
  }

  const batching = opts.targets.length > 1;
  const results = [];

  for (const target of opts.targets) {
    if (batching) process.stderr.write(`… ${target}\n`);
    let res;
    try {
      res = await runOne(target, opts);
    } catch (err) {
      process.stderr.write(`  failed: ${err.message}\n`);
      continue;
    }
    results.push(res);

    if (opts.out) {
      const ext = opts.json ? '.json' : '.md';
      const dest = batching || opts.out.endsWith('/')
        ? path.join(opts.out, res.record.domain.replace(/[^a-z0-9.-]/gi, '_') + ext)
        : opts.out;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, res.output);
      process.stderr.write(`  → ${dest}\n`);
    } else {
      process.stdout.write(res.output + '\n');
    }
  }

  // A one-line ranking is the whole point when you research twenty at once:
  // it answers "who do I call first?" without opening twenty files.
  if (batching) {
    const ranked = results
      .filter(r => r.analysis)
      .sort((a, b) => a.analysis.pct - b.analysis.pct);
    process.stderr.write('\nCall order — worst leak first:\n');
    for (const r of ranked) {
      process.stderr.write(
        `  ${String(r.analysis.pct).padStart(3)}/100  ${r.analysis.band.padEnd(14)} ` +
        `${r.record.domain.padEnd(32)} lead with ${r.analysis.agents[0].agent}\n`
      );
    }
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runOne, parseArgs };
