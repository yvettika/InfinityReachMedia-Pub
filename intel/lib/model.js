'use strict';

const { load } = require('./playbook');

// Private playbook file — real one if present, committed placeholders if not.
const INDUSTRIES = load('data/industries.json');

/**
 * Outside-in Revenue Leak model.
 *
 * The scorecard at /scorecard asks the prospect ten questions and computes a
 * Revenue Leak Score from their answers. This module computes the same score
 * from the outside, before anyone has answered anything, using only what the
 * collector could observe — then says plainly which inputs it observed, which
 * it inferred from a signal, and which it simply assumed.
 *
 * The leak formulas below are ported verbatim from scorecard.html so a
 * pre-call estimate and the prospect's own scorecard result cannot disagree
 * for reasons of arithmetic. If the scorecard math changes, change it here in
 * the same commit.
 *
 * ---------------------------------------------------------------------------
 * A property worth understanding before you sell off this number:
 *
 * Every leak term is linear in lead volume (L) and in customer value (V), and
 * so is current revenue. They cancel in the ratio. That means the SCORE is
 * independent of both — we can compute it correctly without knowing how many
 * leads they get or what a customer is worth. Only the DOLLAR figures need
 * those two numbers.
 *
 * So: quote the score confidently, quote the dollars as an illustration until
 * the prospect gives you L and V on the call. The brief enforces that split.
 * ---------------------------------------------------------------------------
 */

const RESPONSE_MULT = [0, 0.08, 0.18, 0.30];   // <5min, <1hr, same day, next day+
const FOLLOWUP_MULT = [0, 0.015, 0.03, 0.05];  // 5+, 3-4, 1-2, rarely
const REVIEW_MULT = [0, 0.04, 0.08];           // consistently, sometimes, rarely

const RESPONSE_LABEL = ['within 5 minutes', 'within an hour', 'same day', 'next day or longer'];
const FOLLOWUP_LABEL = ['5 or more times', '3-4 times', '1-2 times', 'rarely follows up'];
const REVIEW_LABEL = ['collecting consistently', 'collecting sometimes', 'rarely or never'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** One model input, with its paper trail. */
function input(value, basis, { evidence = [], question = null, range = null, display = null } = {}) {
  return { value, basis, evidence, question, range, display };
}

/**
 * Turn observed signals into the ten scorecard inputs.
 * basis is one of:
 *   'observed' — we saw it directly and can say it out loud
 *   'inferred' — a signal implies it; say it as a hypothesis, confirm on the call
 *   'assumed'  — an industry prior; never say it as fact, just ask
 */
function deriveInputs(record, industryKey) {
  const ind = INDUSTRIES[industryKey] || INDUSTRIES.default;
  const s = record.signals || {};
  const places = record.places && record.places.matched ? record.places : null;
  const has = k => !!(s[k] && s[k].present);
  const ev = (k, text) => (s[k] && s[k].evidence ? `${text} — ${s[k].vendor || ''}`.trim() : text);

  const out = {};

  // --- customer value & close rate: pure priors -------------------------
  out.avgValue = input(ind.avgValue, 'assumed', {
    question: "What's a new customer actually worth to you on the first job?",
    range: [ind.avgValue * 0.4, ind.avgValue * 2.5],
    display: `$${ind.avgValue.toLocaleString('en-US')}`,
  });

  out.closeRate = input(ind.closeRate, 'assumed', {
    question: 'Of the people who reach out, roughly what share become customers?',
    range: [Math.max(0.05, ind.closeRate - 0.15), Math.min(0.85, ind.closeRate + 0.20)],
    display: `${Math.round(ind.closeRate * 100)}%`,
  });

  // --- lead volume: the weakest number in the system --------------------
  let leads = null, leadsBasis = 'assumed', leadsEv = [];
  if (places && places.reviewVelocityPerMonth > 0) {
    const monthlyCustomers = places.reviewVelocityPerMonth * ind.customersPerReview;
    leads = Math.round(monthlyCustomers / ind.closeRate);
    leadsBasis = 'inferred';
    leadsEv.push(
      `~${places.reviewVelocityPerMonth.toFixed(1)} new Google reviews/month × ` +
      `${ind.customersPerReview} customers per review ÷ ${Math.round(ind.closeRate * 100)}% close rate`
    );
  }
  out.leads = input(leads ?? 100, leadsBasis, {
    evidence: leadsEv,
    question: 'How many new inquiries do you get in a month — calls, forms, DMs, walk-ins, everything?',
    range: leads ? [leads * 0.35, leads * 2.5] : [30, 400],
    display: leads ? `~${leads}/mo (inferred)` : 'unknown — dollars shown per 100 leads/mo',
  });
  out.leads.isUnitBasis = leads === null;

  // --- missed calls -----------------------------------------------------
  let mc = ind.missedCallPct;
  const mcEv = [];
  if (has('chat')) {
    mc -= 8;
    mcEv.push(`${s.chat.vendor} chat widget on the site — some after-hours capture already`);
  } else {
    mc += 5;
    mcEv.push('No chat widget found — after-hours web visitors have no way to self-serve');
  }
  if (has('callTracking')) {
    mc -= 3;
    mcEv.push(`${s.callTracking.vendor} call tracking — they measure calls, so they likely manage them`);
  }
  if (ind.afterHoursMatters && !s.claims?.afterHours?.present) {
    mc += 8;
    mcEv.push('No 24/7 or emergency-service claim anywhere on the site');
  }
  if (!s.claims?.textUs?.present) {
    mc += 3;
    mcEv.push('No "text us" option — callers who hit voicemail have no fallback');
  }
  out.missedCallPct = input(clamp(Math.round(mc), 5, 60), 'inferred', {
    evidence: mcEv,
    question: 'When someone calls and nobody picks up — after hours, or when the team is on a job — where does that call go?',
    range: [clamp(mc - 15, 3, 60), clamp(mc + 15, 5, 70)],
    display: `${clamp(Math.round(mc), 5, 60)}% of calls unanswered`,
  });

  // --- speed to lead ----------------------------------------------------
  let rt = 2; // same day is the honest default for a business with no automation
  const rtEv = [];
  if (has('chat')) { rt -= 1; rtEv.push(`${s.chat.vendor} chat can catch inbound instantly`); }
  if (has('crm')) { rt -= 1; rtEv.push(`${s.crm.vendor} present — likely some auto-response`); }
  if (!has('form') && !has('chat')) { rt += 1; rtEv.push('No contact form and no chat — inbound is phone-only'); }
  if (!rtEv.length) rtEv.push('No automation found that would answer a lead faster than a human can');
  rt = clamp(rt, 0, 3);
  out.responseTime = input(rt, has('chat') || has('crm') ? 'inferred' : 'assumed', {
    evidence: rtEv,
    question: 'When a form comes in at 7pm on a Saturday, when does that person actually hear back?',
    range: [clamp(rt - 1, 0, 3), clamp(rt + 1, 0, 3)],
    display: RESPONSE_LABEL[rt],
  });

  // --- no-shows ---------------------------------------------------------
  let ns = ind.noShowPct;
  const nsEv = [];
  if (has('booking')) {
    ns -= 5;
    nsEv.push(`${s.booking.vendor} online booking — bookings are at least captured in a system`);
  } else {
    ns += 5;
    nsEv.push('No online booking found — appointments are set by phone and live in someone\'s head');
  }
  if (has('crm')) { ns -= 3; nsEv.push(`${s.crm.vendor} could be sending reminders`); }
  out.noShowPct = input(clamp(Math.round(ns), 3, 50), 'inferred', {
    evidence: nsEv,
    question: 'Out of ten booked appointments, how many actually show?',
    range: [clamp(ns - 10, 3, 50), clamp(ns + 12, 5, 60)],
    display: `${clamp(Math.round(ns), 3, 50)}% no-show or cancel`,
  });

  // --- follow-up persistence --------------------------------------------
  let fu = 2;
  const fuEv = [];
  if (has('crm')) { fu = 1; fuEv.push(`${s.crm.vendor} in place — some sequenced follow-up is plausible`); }
  if (!has('crm') && !has('form')) { fu = 3; fuEv.push('No CRM and no form — nothing is capturing a lead to follow up with'); }
  if (!fuEv.length) fuEv.push('No marketing automation found — follow-up depends on someone remembering');
  out.followUps = input(fu, has('crm') ? 'inferred' : 'assumed', {
    evidence: fuEv,
    question: 'If someone asks for a quote and goes quiet, how many times do you chase them before you let it go?',
    range: [clamp(fu - 1, 0, 3), 3],
    display: FOLLOWUP_LABEL[fu],
  });

  // --- reactivation -----------------------------------------------------
  const react = has('crm') ? 0 : 1;
  out.reactivation = input(react, 'inferred', {
    evidence: has('crm')
      ? [`${s.crm.vendor} found — they have the tooling, though tooling isn't a campaign`]
      : ['No email or CRM platform found — past customers almost certainly go quiet and stay quiet'],
    question: 'When was the last time you deliberately reached back out to customers from two years ago?',
    range: [0, 1],
    display: react === 0 ? 'has the tooling' : 'no reactivation system',
  });

  // --- reviews ----------------------------------------------------------
  let rv = 1;
  const rvEv = [];
  let rvBasis = 'assumed';
  if (places && typeof places.reviewCount === 'number') {
    rvBasis = 'observed';
    rvEv.push(`${places.reviewCount} Google reviews at ${places.rating ?? '?'}★`);
    if (places.reviewVelocityPerMonth != null) {
      rvEv.push(`~${places.reviewVelocityPerMonth.toFixed(1)} new reviews/month`);
      rv = places.reviewVelocityPerMonth >= 4 ? 0 : places.reviewVelocityPerMonth >= 1 ? 1 : 2;
    } else {
      rv = places.reviewCount >= 150 ? 1 : 2;
    }
  }
  if (has('reviewWidget')) {
    rvEv.push(`${s.reviewWidget.vendor} review widget on the site`);
    rv = Math.min(rv, 1);
    if (rvBasis === 'assumed') rvBasis = 'inferred';
  }
  if (!rvEv.length) rvEv.push('No review tooling on the site and no Places data — unknown, ask.');
  out.reviews = input(rv, rvBasis, {
    evidence: rvEv,
    question: 'How do you ask for reviews right now — is it a system, or does someone remember to ask?',
    range: [Math.max(0, rv - 1), Math.min(2, rv + 1)],
    display: REVIEW_LABEL[rv],
  });

  return out;
}

/** The scorecard's leak math. Ported from scorecard.html — keep in sync. */
function computeLeaks(vals) {
  const V = vals.avgValue, L = vals.leads, C = vals.closeRate;
  const base = L * C;
  const unclosed = L * (1 - C);

  const items = [
    {
      key: 'missed', label: 'Missed & unanswered calls', agent: 'AI Receptionist',
      monthly: L * 0.6 * (vals.missedCallPct / 100) * C * V * 0.8,
      statement: 'After-hours and missed calls still get answered — nothing goes to voicemail.',
    },
    {
      key: 'speed', label: 'Slow lead response', agent: 'Speed to Lead',
      monthly: base * RESPONSE_MULT[vals.responseTime] * V * 0.7,
      statement: 'New leads hear back within a minute — automatically, day or night.',
    },
    {
      key: 'noshow', label: 'No-shows & cancellations', agent: 'Show-Rate',
      monthly: base * (vals.noShowPct / 100) * V * 0.55,
      statement: 'Booked appointments actually show up — reminders go out automatically.',
    },
    {
      key: 'nurture', label: 'Leads that never get worked', agent: 'Speed to Lead',
      monthly: unclosed * FOLLOWUP_MULT[vals.followUps] * V,
      statement: 'If a lead doesn\'t reply, they hear from us again automatically.',
    },
    {
      key: 'reactivate', label: 'Past customers never brought back', agent: 'Database Reactivation',
      monthly: vals.reactivation === 1 ? base * 0.12 * V : 0,
      statement: 'We regularly reach back out to old leads and past customers who went quiet.',
    },
    {
      key: 'reviews', label: 'Weak reviews & reputation', agent: 'Review Machine',
      monthly: base * REVIEW_MULT[vals.reviews] * V,
      statement: 'We steadily collect new 5-star reviews and reply to them.',
    },
  ].map(i => ({ ...i, monthly: Math.max(0, i.monthly || 0) }));

  const monthlyRev = base * V;
  const monthlyRecover = items.reduce((a, i) => a + i.monthly, 0);
  const currentAnnual = monthlyRev * 12;
  const annualRecover = monthlyRecover * 12;
  const potentialAnnual = currentAnnual + annualRecover;
  const pct = potentialAnnual > 0 ? Math.round((currentAnnual / potentialAnnual) * 100) : 100;

  return {
    items: items.sort((a, b) => b.monthly - a.monthly),
    monthlyRev, monthlyRecover, currentAnnual, annualRecover, potentialAnnual, pct,
  };
}

/** Bands must stay identical to scorecard.html. */
function band(pct) {
  if (pct < 40) return { band: 'Critical', head: 'Most of their reachable revenue is leaking.' };
  if (pct < 60) return { band: 'Heavy loss', head: 'They are losing a large share of what they already generate.' };
  if (pct < 75) return { band: 'Leaking', head: 'Real foundation, named gaps.' };
  if (pct < 90) return { band: 'Minor seepage', head: 'Tighter than most businesses their size.' };
  return { band: 'Sealed', head: 'At the practical ceiling — sell demand generation, not leak repair.' };
}

const valuesOf = inputs => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));

/**
 * Sensitivity: for each input we did not observe, how much does the answer
 * move if we are wrong at either end of its plausible range?
 *
 * This is what orders the discovery questions. Ask the question whose answer
 * moves the number most — not the question that comes first on a form.
 */
function sensitivity(inputs) {
  const baseVals = valuesOf(inputs);
  const baseline = computeLeaks(baseVals);
  const rows = [];

  for (const [key, meta] of Object.entries(inputs)) {
    if (meta.basis === 'observed' || !meta.range) continue;
    const [lo, hi] = meta.range;
    const isInt = ['responseTime', 'followUps', 'reviews', 'reactivation'].includes(key);
    const at = v => computeLeaks({ ...baseVals, [key]: isInt ? Math.round(v) : v });
    const loRes = at(lo), hiRes = at(hi);

    rows.push({
      key,
      question: meta.question,
      basis: meta.basis,
      dollarSwing: Math.abs(hiRes.annualRecover - loRes.annualRecover),
      scoreSwing: Math.abs(hiRes.pct - loRes.pct),
      baselineDollars: baseline.annualRecover,
    });
  }

  // Lead volume and customer value are pure scale factors — they multiply every
  // dollar figure but cancel out of the score entirely (see the note at the top
  // of this file). Ranking them by dollar swing would put them permanently at
  // the top of the discovery list, ahead of questions that actually change the
  // diagnosis, which is exactly backwards.
  //
  // So we split on the empirical test rather than hardcoding a list: if moving
  // an input across its whole plausible range doesn't move the score, it's a
  // scaling question, not a diagnostic one. Both get asked; they get asked for
  // different reasons and the brief says which is which.
  const maxD = Math.max(1, ...rows.map(r => r.dollarSwing));
  rows.forEach(r => {
    r.kind = r.scoreSwing === 0 ? 'scaling' : 'diagnostic';
    r.impact = (r.scoreSwing / 100) * 0.65 + (r.dollarSwing / maxD) * 0.35;
  });

  const byImpact = (a, b) => (b.scoreSwing - a.scoreSwing) || (b.dollarSwing - a.dollarSwing);
  const diagnostic = rows.filter(r => r.kind === 'diagnostic').sort(byImpact);
  const scaling = rows.filter(r => r.kind === 'scaling').sort((a, b) => b.dollarSwing - a.dollarSwing);

  const all = [...diagnostic, ...scaling];
  all.diagnostic = diagnostic;
  all.scaling = scaling;
  return all;
}

/** Which agent to lead with, and how much of the recoverable money it unlocks. */
function agentFit(leaks) {
  const byAgent = new Map();
  for (const item of leaks.items) {
    const cur = byAgent.get(item.agent) || { agent: item.agent, monthly: 0, drivers: [] };
    cur.monthly += item.monthly;
    if (item.monthly > 0) cur.drivers.push(item.label);
    byAgent.set(item.agent, cur);
  }
  const total = leaks.monthlyRecover || 1;
  return [...byAgent.values()]
    .map(a => ({ ...a, sharePct: Math.round((a.monthly / total) * 100) }))
    .sort((a, b) => b.monthly - a.monthly);
}

function analyze(record, industryKey = 'default') {
  const inputs = deriveInputs(record, industryKey);
  const leaks = computeLeaks(valuesOf(inputs));
  return {
    industry: INDUSTRIES[industryKey] ? industryKey : 'default',
    industryLabel: (INDUSTRIES[industryKey] || INDUSTRIES.default).label,
    inputs,
    leaks,
    pct: leaks.pct,
    ...band(leaks.pct),
    agents: agentFit(leaks),
    sensitivity: sensitivity(inputs),
    unitBasis: inputs.leads.isUnitBasis,
  };
}

module.exports = {
  analyze, deriveInputs, computeLeaks, band, sensitivity, agentFit,
  RESPONSE_LABEL, FOLLOWUP_LABEL, REVIEW_LABEL, INDUSTRIES,
};
