#!/usr/bin/env node
'use strict';

/**
 * The daily job — stateless by design.
 *
 *   node intel/sync.js --discover --area orange-county
 *   node intel/sync.js --dry-run
 *
 * The Google Sheet is the state store. A run reads it, works out what is new
 * and what has gone stale, discovers, researches, writes the sheet back, and
 * pushes to GoHighLevel. Nothing persists on the machine between runs, so this
 * can execute anywhere — a laptop, a cron box, GitHub Actions — and any number
 * of machines can take turns.
 *
 * With no sheet configured it falls back to a local prospects.json, same
 * interface, so everything still works offline.
 *
 * Idempotency rules (all tested):
 *   - the sheet merges by domain; re-runs update rows, never duplicate them
 *   - Status and Owner Notes belong to the human and are never overwritten
 *   - a failed research pass leaves yesterday's score in place
 *   - the CRM upserts contacts and reuses existing opportunities
 *
 * Configuration:
 *   GOOGLE_PLACES_API_KEY          discovery + review enrichment
 *   GOOGLE_SERVICE_ACCOUNT_JSON    service account key file
 *   PROSPECT_SHEET_ID              the spreadsheet that holds everything
 *   GHL_API_KEY, GHL_LOCATION_ID   CRM credentials
 *   GHL_PIPELINE_NAME              pipeline looked up by name (see below)
 *   GHL_STAGE_NAME                 stage name, default "New Lead"
 *   GHL_PIPELINE_ID / GHL_STAGE_ID explicit IDs, win over names if set
 *
 * GHL cannot create pipelines via API — create it once in the UI, then the
 * name lookup finds it. No ID copying.
 */

const { collect } = require('./lib/collect');
const { analyze } = require('./lib/model');
const { discover } = require('./lib/discover');
const { toProspect } = require('./lib/rows');
const { createState } = require('./lib/state');
const ghl = require('./lib/ghl');
const slack = require('./lib/slack');
const { composeSequence } = require('./lib/outreach');

const USAGE = `
Daily sync — find, research, and push prospects (sheet-backed, stateless)

  node intel/sync.js [options]

Options
  --discover           run a discovery sweep first (needs --area)
  --area <area>        area for discovery (e.g. orange-county)
  --niches <spec>      core (default) | all | comma-separated keys
  --limit <n>          cap prospects researched this run (default 25)
  --refresh-after <n>  re-research prospects older than n days (default 30)
  --sheet-only         skip the CRM push
  --contacts-only      create CRM contacts but no opportunities
  --dir <path>         local-state directory when no sheet is configured
  --dry-run            do the reads and the research, write nothing
`;

function parseArgs(argv) {
  const o = { niches: 'core', refreshAfter: 30, limit: 25, dir: 'prospects' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--discover') o.doDiscover = true;
    else if (a === '--area') o.area = argv[++i];
    else if (a === '--niches') o.niches = argv[++i];
    else if (a === '--limit') o.limit = Number(argv[++i]);
    else if (a === '--refresh-after') o.refreshAfter = Number(argv[++i]);
    else if (a === '--sheet-only') o.sheetOnly = true;
    else if (a === '--contacts-only') o.contactsOnly = true;
    else if (a === '--dir') o.dir = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

const log = msg => process.stderr.write(msg + '\n');

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); }
  catch (err) { console.error(err.message + USAGE); process.exit(2); }
  if (o.help) { console.log(USAGE); return; }

  // ---- 0. load state ------------------------------------------------------
  const state = createState({ dir: o.dir });
  log(`State: ${state.label}`);
  const { prospects: known, byDomain, placeIds } = await state.load();
  log(`Loaded ${known.length} known prospects, ${placeIds.size} place IDs seen.`);

  // Work on a map keyed by domain; everything below mutates this and the end
  // of the run writes it back through the state store's merge rules.
  const work = new Map(known.map(p => [p.domain, { ...p }]));

  // What this run actually did — feeds the Slack digest at the end.
  const newThisRun = [];
  const researchedThisRun = [];
  const failures = [];
  // Deduped: one missing postal address is one problem, not one per prospect.
  const outreachBlockers = new Set();

  // ---- 1. discovery -------------------------------------------------------
  if (o.doDiscover) {
    if (!o.area) { console.error('--discover requires --area'); process.exit(2); }
    if (!process.env.GOOGLE_PLACES_API_KEY) {
      log(`Discovery: skipped — GOOGLE_PLACES_API_KEY is not set.`);
    } else {
      log(`Discovering: ${o.niches} niches across ${o.area}…`);
      const found = await discover({
        area: o.area,
        niches: o.niches,
        seenPlaceIds: placeIds,
        onProgress: () => {},
      });
      for (const c of found.candidates) {
        if (work.has(c.domain)) continue;
        const p = toProspect({ ...c, placeId: c.placeIds || c.placeId });
        work.set(c.domain, p);
        newThisRun.push(p);
      }
      log(`  ${found.stats.requests} queries → ${found.candidates.length} candidates, ${newThisRun.length} genuinely new`);
      for (const e of found.errors.slice(0, 5)) { log(`  ! ${e}`); failures.push(`discovery: ${e}`); }
    }
  }

  // ---- 2. research --------------------------------------------------------
  const staleBefore = Date.now() - o.refreshAfter * 86400000;
  const needs = [...work.values()].filter(p => {
    if (!p.researchedAt) return true;
    const t = Date.parse(p.researchedAt);
    return !Number.isFinite(t) || t < staleBefore;
  });
  // Never-researched first, then oldest — new leads beat routine refreshes
  // when the per-run budget is tight.
  needs.sort((a, b) => (Date.parse(a.researchedAt || 0) || 0) - (Date.parse(b.researchedAt || 0) || 0));
  const todo = o.limit ? needs.slice(0, o.limit) : needs;

  log(`\n${work.size} prospects · ${needs.length} need research` +
      (todo.length < needs.length ? ` · doing ${todo.length} this run` : ''));

  let researched = 0, failed = 0;
  for (const p of todo) {
    try {
      const record = await collect(p.domain, { placesKey: process.env.GOOGLE_PLACES_API_KEY });
      p.researchedAt = new Date().toISOString();
      if (!record.signals) {
        failed++;
        p.syncState = `research-failed: ${(record.errors[0] || 'unreadable').slice(0, 80)}`;
        log(`  ✗ ${p.domain} — ${p.syncState}`);
        continue;
      }
      const a = analyze(record, p.industry || industryForNiche(p.niche));
      const fresh = toProspect(p, a);
      Object.assign(p, {
        score: fresh.score, band: fresh.band,
        recoverableAnnual: fresh.recoverableAnnual,
        topLeak: fresh.topLeak, leadAgent: fresh.leadAgent,
        syncState: 'researched',
      });
      // Compose the outreach draft here, while the full record is in hand —
      // the sheet only carries the summary, and the email needs the receipts.
      try {
        const seq = composeSequence(record, a, p);
        p.outreachSubject = seq.steps[0].subject;
        p.outreachBody = seq.steps[0].body;
        p.outreachBodyHtml = seq.steps[0].html;
        p.outreachEvidence = seq.evidence.join('\n');
        if (seq.blockers.length) outreachBlockers.add(seq.blockers[0]);
      } catch (err) {
        log(`  ! ${p.domain} — outreach draft failed: ${err.message}`);
      }

      researched++;
      researchedThisRun.push(p);
      log(`  ✓ ${p.domain} — ${p.score}/100 ${p.band}`);
    } catch (err) {
      failed++;
      p.syncState = `research-failed: ${err.message.slice(0, 80)}`;
      log(`  ✗ ${p.domain} — ${err.message}`);
    }
  }
  log(`Researched ${researched}, failed ${failed}.`);

  const all = [...work.values()].sort((x, y) => (x.score ?? 101) - (y.score ?? 101));

  // ---- 3. write state back ------------------------------------------------
  if (o.dryRun) {
    const preview = state.preview(all);
    log(`\nState (dry run): would write ${preview.total} rows — ${preview.added} new, ${preview.updated} changed.`);
  } else {
    try {
      const result = await state.save(all);
      log(`\nState: ${result.total} rows — ${result.added} new, ${result.updated} changed.`);
    } catch (err) {
      log(`\nState: FAILED — ${err.message}`);
      // The CRM push still runs: losing one day of sheet writes is annoying,
      // losing the day's leads out of the pipeline is worse.
      process.exitCode = 1;
    }
  }

  // ---- 4. the CRM ---------------------------------------------------------
  let synced = 0;
  if (!o.sheetOnly) {
    if (!process.env.GHL_API_KEY || !process.env.GHL_LOCATION_ID) {
      log(`GHL: skipped — set GHL_API_KEY and GHL_LOCATION_ID.`);
    } else {
      const ghlOpts = { contactsOnly: o.contactsOnly };
      if (!o.contactsOnly) {
        try {
          ghlOpts._resolved = await ghl.resolvePipeline(ghlOpts);
          const r = ghlOpts._resolved;
          log(`GHL: pipeline resolved ${r.resolvedBy === 'name' ? `"${r.pipelineName}" / "${r.stageName}"` : 'by explicit IDs'}.`);
        } catch (err) {
          log(`GHL: ${err.message}`);
          log(`GHL: falling back to contacts-only so the leads still land somewhere.`);
          failures.push(`GHL pipeline: ${err.message.slice(0, 120)}`);
          ghlOpts.contactsOnly = true;
        }
      }

      if (o.dryRun) {
        log(`GHL (dry run): would sync ${all.length} contacts${ghlOpts.contactsOnly ? '' : ' + opportunities'}.`);
      } else {
        let ok = 0, created = 0, ghlFailed = 0;
        for (const p of all) {
          // Only push prospects that have been researched — an unresearched
          // row has no score, no band and no deal value: CRM noise.
          if (p.score == null) continue;
          try {
            const res = await ghl.syncProspect(p, ghlOpts);
            ok++;
            if (res.opportunity.created) created++;
            p.syncState = 'synced';
          } catch (err) {
            ghlFailed++;
            p.syncState = `ghl-failed: ${err.message.slice(0, 80)}`;
            log(`  ✗ ${p.domain} — ${err.message}`);
            failures.push(`GHL ${p.domain}: ${err.message.slice(0, 100)}`);
          }
        }
        synced = ok;
        log(`GHL: ${ok} contacts synced, ${created} new opportunities, ${ghlFailed} failed.`);

        // Second save so syncState reflects what actually happened in the CRM.
        if (ok || ghlFailed) {
          try { await state.save(all); } catch { /* already reported above */ }
        }
        if (ghlFailed) process.exitCode = 1;
      }
    }
  }

  for (const b of outreachBlockers) {
    log(`Outreach: ${b}`);
    failures.push(`outreach: ${b}`);
  }

  // ---- 5. Slack digest ----------------------------------------------------
  // Posts only what is NEW this run; a run that did nothing posts nothing,
  // except failures, which always post — a job that breaks silently on a
  // Tuesday is still broken in March.
  const digest = {
    newLeads: newThisRun,
    researched: researchedThisRun,
    failures,
    totals: { prospects: work.size, synced },
    sheetUrl: process.env.PROSPECT_SHEET_ID
      ? `https://docs.google.com/spreadsheets/d/${process.env.PROSPECT_SHEET_ID}/edit`
      : null,
  };
  if (o.dryRun) {
    const would = slack.buildDigest(digest);
    log(`Slack (dry run): ${would ? `would post — "${would.text}"` : 'nothing to post'}.`);
  } else {
    try {
      const outcome = await slack.postDigest(digest);
      log(`Slack: ${outcome === 'posted' ? `posted — "${slack.buildDigest(digest).text}"`
        : outcome === 'skipped-empty' ? 'nothing new, stayed quiet'
        : 'skipped — SLACK_WEBHOOK_URL not set'}.`);
    } catch (err) {
      // Slack being down must never fail the run that just did the real work.
      log(`Slack: FAILED — ${err.message}`);
    }
  }
  log('');
}

/** Map a niche key back to a prior set when a row predates the industry column. */
function industryForNiche(niche) {
  try {
    const { NICHES } = require('./lib/discover');
    return NICHES.niches.find(n => n.key === niche)?.industry || 'default';
  } catch {
    return 'default';
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { parseArgs };
