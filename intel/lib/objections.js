'use strict';

const { load } = require('./playbook');

/**
 * Objection prediction engine.
 *
 * The matching logic lives here, in git. The rules it matches against live in
 * `data/objection-rules.js`, which is gitignored — see lib/playbook.js for why
 * the seam falls there. A fresh clone falls back to the committed
 * `.example` rules and still works.
 *
 * The point of this is not to hand a rep a script. It is to remove the
 * surprise: if a prospect is running HubSpot, "we already have a system for
 * this" is coming, and it is much easier to answer when you knew it was
 * coming and you know exactly what they have.
 */

const RULES = load('data/objection-rules.js');

function predictObjections(record, analysis) {
  const s = record.signals || {};
  const ctx = { places: record.places, analysis };
  const out = [];

  for (const rule of RULES) {
    // A rule that throws is a broken rule, not a reason to lose the brief —
    // most `when` clauses reach into optional Places fields that may be absent.
    let fires = false;
    try {
      fires = !!rule.when(s, ctx);
    } catch {
      fires = false;
    }
    if (!fires) continue;

    out.push({
      id: rule.id,
      objection: typeof rule.objection === 'function' ? rule.objection(s, ctx) : rule.objection,
      why: typeof rule.why === 'function' ? rule.why(s, ctx) : rule.why,
      response: rule.response,
    });
  }
  return out;
}

module.exports = { predictObjections, RULES };
