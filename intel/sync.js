#!/usr/bin/env node
'use strict';

/**
 * The daily job.
 *
 *   node intel/sync.js --dry-run
 *   node intel/sync.js --discover --area orange-county --niches core
 *   node intel/sync.js --sheet-only
 *
 * Finds new prospects, researches the ones not researched yet, refreshes stale
 * ones, then pushes everything to the Google Sheet and into GoHighLevel.
 *
 * Safe to run twice. Every write is keyed on the prospect's domain: the sheet
 * merges by domain and never overwrites the Status or Owner Notes columns, and
 * the CRM upserts the contact and reuses an existing opportunity instead of
 * creating a second one.
 *
 * Configuration (all via environment):
 *   GOOGLE_PLACES_API_KEY          discovery + review enrichment
 *   GOOGLE_SERVICE_ACCOUNT_JSON    path to the service account key file
 *   PROSPECT_SHEET_ID              the spreadsheet to write to
 *   GHL_API_KEY, GHL_LOCATION_ID   CRM credentials
 *   GHL_PIPELINE_ID, GHL_STAGE_ID  where new prospects land
 */

const fs = require('fs');
const path = require('path');

const { collect } = require('./lib/collect');
const { analyze } = require('./lib/model');
const { discover } = require('./lib/discover');
const { toProspect, mergeRows, HEADER } = require('./lib/rows');
const sheets = require('./lib/sheets');
const ghl = require('./lib/ghl');

const USAGE = `
Daily sync — find, research, and push prospects

  node intel/sync.js [options]

Options
  --discover           run a discovery sweep first (needs --area)
  --area <area>        area for discovery (e.g. orange-county)
  --niches <spec>      core (default) | all | comma-separated keys
  --dir <path>         working directory (default: prospects/)
  --limit <n>          cap how many prospects to research this run
  --refresh-after <n>  re-research prospects older than n days (default 30)
  --sheet-only         skip the CRM push
  --ghl-only           skip the spreadsheet
  --contacts-only      create CRM contacts but no opportunities
  --dry-run            do all the work, write nothing anywhere
`;

function parseArgs(argv) {
  const o = { dir: 'prospects', niches: 'core', refreshAfter: 30, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--discover') o.doDiscover = true;
    else if (a === '--area') o.area = argv[++i];
    else if (a === '--niches') o.niches = argv[++i];
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--refresh-after') o.refreshAfter = Number(argv[++i]);
    else if (a === '--sheet-only') o.sheetOnly = true;
    else if (a === '--ghl-only') o.ghlOnly = true;
    else if (a === '--contacts-only') o.contactsOnly = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const log = msg => process.stderr.write(msg + '\n');

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message + USAGE); process.exit(2); }
  if (o.help) { console.log(USAGE); return; }

  fs.mkdirSync(o.dir, { recursive: true });
  const discoveredFile = path.join(o.dir, 'discovered.json');
  const analyzedFile = path.join(o.dir, 'analyzed.json');

  // ---- 1. discovery -----------------------------------------------------
  if (o.doDiscover) {
    if (!o.area) { console.error('--discover requires --area'); process.exit(2); }
    log(`Discovering: ${o.niches} niches across ${o.area}…`);
    const found = await discover({
      area: o.area,
      niches: o.niches,
      seenFile: path.join(o.dir, 'seen-places.json'),
      onProgress: () => {},
    });
    const prior = readJson(discoveredFile, { candidates: [] });
    const byDomain = new Map(prior.candidates.map(c => [c.domain, c]));
    for (const c of found.candidates) if (!byDomain.has(c.domain)) byDomain.set(c.domain, c);
    fs.writeFileSync(discoveredFile, JSON.stringify(
      { candidates: [...byDomain.values()], stats: found.stats, errors: found.errors }, null, 2));
    log(`  ${found.candidates.length} new, ${byDomain.size} total known`);
    if (found.errors.length) log(`  ${found.errors.length} discovery error(s) — see ${discoveredFile}`);
  }

  const discovered = readJson(discoveredFile, { candidates: [] });
  if (!discovered.candidates.length) {
    log(`\nNothing to sync — ${discoveredFile} has no candidates.`);
    log(`Run discovery first:  node intel/discover.js --area orange-county --niches core`);
    log(`(that needs GOOGLE_PLACES_API_KEY set)\n`);
    return;
  }

  // ---- 2. research ------------------------------------------------------
  const analyzed = readJson(analyzedFile, {});
  const staleBefore = Date.now() - o.refreshAfter * 86400000;

  const needsWork = discovered.candidates.filter(c => {
    const prior = analyzed[c.domain];
    if (!prior) return true;
    return Date.parse(prior.researchedAt || 0) < staleBefore;
  });
  const todo = o.limit ? needsWork.slice(0, o.limit) : needsWork;

  log(`\n${discovered.candidates.length} known prospects · ${needsWork.length} need research` +
      (o.limit && needsWork.length > todo.length ? ` · capped at ${todo.length}` : ''));

  let researched = 0, researchFailed = 0;
  for (const c of todo) {
    try {
      const record = await collect(c.domain, {
        placesKey: process.env.GOOGLE_PLACES_API_KEY,
      });
      if (!record.signals) {
        researchFailed++;
        // Remember the failure so the next run doesn't retry a dead site daily.
        analyzed[c.domain] = {
          researchedAt: new Date().toISOString(),
          failed: true,
          reason: record.errors[0] || 'unreadable',
        };
        log(`  ✗ ${c.domain} — ${analyzed[c.domain].reason}`);
        continue;
      }
      const a = analyze(record, c.industry || 'default');
      analyzed[c.domain] = {
        researchedAt: new Date().toISOString(),
        failed: false,
        pct: a.pct,
        band: a.band,
        annualRecover: a.leaks.annualRecover,
        topLeak: a.leaks.items.find(i => i.monthly > 0)?.label || null,
        leadAgent: a.agents[0]?.agent || null,
      };
      researched++;
      log(`  ✓ ${c.domain} — ${a.pct}/100 ${a.band}`);
    } catch (err) {
      researchFailed++;
      log(`  ✗ ${c.domain} — ${err.message}`);
    }
  }

  if (!o.dryRun) fs.writeFileSync(analyzedFile, JSON.stringify(analyzed, null, 2));

  // ---- 3. build the rows ------------------------------------------------
  const prospects = discovered.candidates.map(c => {
    const a = analyzed[c.domain];
    const p = toProspect(c, null);
    if (a && !a.failed) {
      p.score = a.pct;
      p.band = a.band;
      p.recoverableAnnual = a.annualRecover;
      p.topLeak = a.topLeak;
      p.leadAgent = a.leadAgent;
    }
    return p;
  }).sort((x, y) => (x.score ?? 101) - (y.score ?? 101));

  log(`\nResearched ${researched}, failed ${researchFailed}, ${prospects.length} rows ready.`);

  // ---- 4. the spreadsheet ----------------------------------------------
  if (!o.ghlOnly) {
    const sheetId = process.env.PROSPECT_SHEET_ID;
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!sheetId || !keyFile) {
      log(`\nSheet: skipped — set PROSPECT_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.`);
    } else {
      try {
        const creds = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
        const token = await sheets.getAccessToken(creds);
        const existing = await sheets.getValues(sheetId, 'A:Z', token);
        const merged = mergeRows(existing, prospects);
        if (o.dryRun) {
          log(`\nSheet (dry run): would write ${merged.total} rows — ${merged.added} new, ${merged.updated} changed.`);
        } else {
          await sheets.updateValues(sheetId, `A1:${colLetter(HEADER.length)}${merged.values.length}`, merged.values, token);
          log(`\nSheet: ${merged.total} rows — ${merged.added} new, ${merged.updated} changed.`);
        }
      } catch (err) {
        log(`\nSheet: FAILED — ${err.message}`);
        process.exitCode = 1;
      }
    }
  }

  // ---- 5. the CRM -------------------------------------------------------
  if (!o.sheetOnly) {
    if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
      log(`GHL: skipped — set GHL_API_KEY and GHL_LOCATION_ID.`);
    } else if (o.dryRun) {
      log(`GHL (dry run): would upsert ${prospects.length} contacts` +
          (o.contactsOnly ? '.' : ' and ensure an opportunity for each.'));
    } else {
      let ok = 0, created = 0, failed = 0;
      for (const p of prospects) {
        try {
          const res = await ghl.syncProspect(p, { contactsOnly: o.contactsOnly });
          ok++;
          if (res.opportunity.created) created++;
        } catch (err) {
          failed++;
          log(`  ✗ ${p.domain} — ${err.message}`);
        }
      }
      log(`GHL: ${ok} contacts synced, ${created} new opportunities, ${failed} failed.`);
      if (failed) process.exitCode = 1;
    }
  }

  log('');
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { parseArgs, colLetter };
