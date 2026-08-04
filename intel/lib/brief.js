'use strict';

const { load, usingExamples, whichLoaded } = require('./playbook');
const { predictObjections } = require('./objections');

// Private playbook file — real one if present, committed placeholders if not.
const PROOF = load('data/proof.json');

/**
 * Renders the call brief.
 *
 * The organising idea: a rep on a call needs to know three things in the first
 * ten seconds of looking at this page —
 *
 *   what am I allowed to say out loud,
 *   what do I have to ask,
 *   and what do I lead with.
 *
 * So the brief is ordered that way, and the single hardest rule it enforces is
 * the split between observed and assumed. An assumption read aloud as a fact
 * is how you lose a call in the first minute: the prospect knows their own
 * business and you have just proved you don't.
 */

const money = n => '$' + Math.round(n).toLocaleString('en-US');

function scaleNote(analysis) {
  return analysis.unitBasis
    ? '_Dollar figures below are **per 100 monthly leads** — we could not observe their real lead volume. Multiply once they tell you._'
    : '_Dollar figures assume the inferred lead volume in the appendix. Confirm it on the call before quoting anything._';
}

/** Facts we can defend with a receipt. These are the only quotable ones. */
function observedFacts(record, analysis) {
  const s = record.signals || {};
  const p = record.places;
  const facts = [];

  if (p && p.matched) {
    if (typeof p.reviewCount === 'number') {
      facts.push({
        fact: `${p.reviewCount} Google reviews at ${p.rating ?? '?'}★`,
        source: 'Google Places',
      });
    }
    if (p.reviewVelocityPerMonth != null) {
      facts.push({
        fact: `roughly ${p.reviewVelocityPerMonth.toFixed(1)} new reviews a month`,
        source: 'Google Places (estimated from the 5 most recent reviews)',
      });
    }
  }

  const vendorFacts = [
    ['chat', 'chat widget'], ['booking', 'online booking'], ['crm', 'CRM / email platform'],
    ['adPixels', 'ad tracking pixel'], ['callTracking', 'call tracking'],
    ['reviewWidget', 'review widget'], ['platform', 'website platform'],
  ];
  for (const [key, label] of vendorFacts) {
    if (s[key]?.present) {
      facts.push({ fact: `${label}: ${s[key].vendor}`, source: `found in page source — \`${s[key].evidence}\`` });
    }
  }

  if (s.social?.profiles?.length) {
    facts.push({ fact: `social profiles linked: ${s.social.profiles.join(', ')}`, source: 'links in page source' });
  }
  if (s.claims?.afterHours?.present) {
    facts.push({ fact: 'advertises 24/7 or emergency service', source: 'site copy' });
  }
  if (s.claims?.financing?.present) {
    facts.push({ fact: 'offers financing — bigger ticket sizes, worth asking about', source: 'site copy' });
  }
  if (s.claims?.hiring?.present) {
    facts.push({
      fact: s.claims.hiringSalesOrCSR?.present
        ? 'hiring — and the roles include front-office/CSR-type work'
        : 'currently hiring',
      source: 'careers copy on site',
    });
  }
  if (s.performance?.heavy) {
    facts.push({
      fact: `heavy homepage: ${Math.round(s.performance.bytes / 1024)}KB, ${s.performance.scriptCount} scripts, ${s.performance.ttfbMs}ms to first byte`,
      source: 'measured on fetch',
    });
  }
  if (s.performance && s.performance.hasViewport === false) {
    facts.push({ fact: 'no mobile viewport tag — the site is not built for phones', source: 'page <head>' });
  }
  return facts;
}

/** Things we did NOT see. Phrased as absence of evidence, never as fact. */
function absences(record) {
  const s = record.signals || {};
  const out = [];
  const check = [
    ['chat', 'No chat widget found', 'so after-hours web visitors have no way to get an answer'],
    ['booking', 'No online booking found', 'so every appointment goes through a person'],
    ['crm', 'No CRM or email platform found', 'so follow-up and reactivation are manual'],
    ['reviewWidget', 'No review tooling found', 'so review collection depends on someone remembering'],
    ['callTracking', 'No call tracking found', 'so they likely cannot tell you their own missed-call rate'],
  ];
  for (const [key, headline, consequence] of check) {
    if (!s[key]?.present) out.push({ headline, consequence });
  }
  if (!s.claims?.textUs?.present) {
    out.push({ headline: 'No "text us" option found', consequence: 'so a missed call has no fallback channel' });
  }
  return out;
}

function openingLine(record, analysis, facts) {
  const p = record.places;
  const s = record.signals || {};
  const name = (p && p.name) || record.domain;

  // Build from a verified fact only. If we have nothing verified, say so and
  // fall back to a question — a wrong "I noticed" is worse than no opener.
  if (p?.matched && typeof p.reviewCount === 'number' && p.reviewCount >= 50 && !s.chat?.present) {
    return `"You've got ${p.reviewCount} reviews${p.rating ? ` at ${p.rating} stars` : ''}, so people clearly find you and like you. I couldn't find anything on the site that answers someone after hours though — when a call comes in at 8pm, where does it go?"`;
  }
  if (s.adPixels?.present && !s.chat?.present) {
    return `"I can see you're running ${s.adPixels.vendor} — so you're paying for traffic. I couldn't find anything on the site that catches those people after hours. What happens to a form that comes in on a Saturday night?"`;
  }
  if (s.booking?.present) {
    return `"I saw you've got ${s.booking.vendor} booking set up, which puts you ahead of most. Booking isn't the question I had — of ten people who book, how many actually show?"`;
  }
  if (!s.form?.present && s.phone?.present) {
    return `"Your site's phone-first — there's no form on it at all, which I'd guess is deliberate. What happens to the people who call while the team's out on a job?"`;
  }
  return `"I had a look at your site before calling. Rather than guess — when a new inquiry comes in, what actually happens to it in the first hour?"`;
}

function recommendOffer(analysis) {
  const top = analysis.leaks.items[0];
  const meaningful = analysis.leaks.items.filter(i => i.monthly > analysis.leaks.monthlyRecover * 0.12).length;
  const reactivateHigh = analysis.leaks.items.slice(0, 2).some(i => i.key === 'reactivate');

  if (reactivateHigh || analysis.pct < 60) {
    return {
      ...PROOF.offers.first10,
      because: reactivateHigh
        ? 'Reactivation is one of their two biggest leaks, and it is the one that needs no ad spend and no new traffic — which makes it the easiest yes.'
        : `Score of ${analysis.pct} puts them in "${analysis.band}". They need a bounded, provable first win before they will buy a system.`,
    };
  }
  if (meaningful >= 3) {
    return {
      ...PROOF.offers.suite,
      because: `${meaningful} separate leaks are live at once. Fixing one and leaving the rest will underdeliver and they will blame the agent.`,
    };
  }
  return {
    ...PROOF.offers.singleAgent,
    because: `${top.label} alone is ${Math.round((top.monthly / analysis.leaks.monthlyRecover) * 100)}% of everything recoverable. Sell that one thing.`,
  };
}

function pickProof(record, analysis, industryKey) {
  const s = record.signals || {};
  const tags = new Set([industryKey]);
  if (/GoDaddy|Wix|Squarespace/i.test(s.platform?.vendor || '')) tags.add('not-technical');
  if (s.adPixels?.present) tags.add('already-doing-marketing');
  if (!s.crm?.present) tags.add('tried-it-themselves');
  const scored = PROOF.testimonials
    .map(t => ({ t, hits: t.bestFor.filter(b => tags.has(b)).length }))
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 2).map(x => x.t);
}

function renderMarkdown(record, analysis, industryKey) {
  const L = [];
  const facts = observedFacts(record, analysis);
  const gaps = absences(record);
  const objections = predictObjections(record, analysis);
  const offer = recommendOffer(analysis);
  const proof = pickProof(record, analysis, industryKey);
  const name = (record.places && record.places.name) || record.domain;

  L.push(`# Call brief — ${name}`);
  L.push('');
  L.push(`**${record.domain}** · ${analysis.industryLabel} · researched ${new Date(record.observedAt).toLocaleString('en-US')}`);
  if (record.places?.matched && record.places.address) L.push(`· ${record.places.address}`);
  L.push('');

  // A brief built on placeholder playbook files looks exactly as authoritative
  // as a real one. Say so at the top, before anything else, or someone will
  // read example testimonials onto a live call.
  if (usingExamples()) {
    L.push('> ⚠️ **Placeholder playbook in use — do not take this onto a live call.**');
    L.push('> ' + JSON.stringify(whichLoaded()) + '. Copy the `.example` files to their real');
    L.push('> names in `intel/data/` and fill them in. Testimonials and objection');
    L.push('> handling below are illustrative, not ours.');
    L.push('');
  }

  // ---- the number -------------------------------------------------------
  L.push('## Revenue Leak Score (estimated, outside-in)');
  L.push('');
  L.push(`### ${analysis.pct}/100 — ${analysis.band}`);
  L.push('');
  L.push(analysis.head);
  L.push('');
  L.push(`Estimated recoverable: **${money(analysis.leaks.annualRecover)}/yr** (${money(analysis.leaks.monthlyRecover)}/mo)`);
  L.push('');
  L.push(scaleNote(analysis));
  L.push('');
  L.push('> The score itself does not depend on lead volume or customer value — those cancel out of the ratio. ' +
         'So the **score is defensible before they tell you anything**; the **dollars are not**. Lead with the score.');
  L.push('');

  // ---- say this ---------------------------------------------------------
  L.push('## Say this — verified, with receipts');
  L.push('');
  if (!facts.length) {
    L.push('_Nothing verified beyond the site loading. Do not assert anything — open with a question._');
  } else {
    for (const f of facts) L.push(`- **${f.fact}** — _${f.source}_`);
  }
  L.push('');
  L.push('**Opening line:**');
  L.push('');
  L.push('> ' + openingLine(record, analysis, facts));
  L.push('');

  // ---- ask this ---------------------------------------------------------
  L.push('## Ask this first — ordered by how much the answer moves the number');
  L.push('');
  L.push('Ranked by sensitivity analysis, not by convention: the top question is the one where being wrong costs the most.');
  L.push('');
  const diagnostic = analysis.sensitivity.diagnostic || analysis.sensitivity;
  diagnostic.slice(0, 4).forEach((row, i) => {
    L.push(`${i + 1}. **${row.question}**`);
    L.push(`   _Currently ${row.basis}. Their answer moves the score by up to ${Math.round(row.scoreSwing)} points._`);
  });
  L.push('');

  const scaling = analysis.sensitivity.scaling || [];
  if (scaling.length) {
    L.push('**Before you quote any dollar figure, you also need these two.** They do not change the score at all — ' +
           'they are pure multipliers on it — but every number in the table below is wrong until you have them:');
    L.push('');
    for (const row of scaling) L.push(`- ${row.question}`);
    L.push('');
  }

  // ---- don't say --------------------------------------------------------
  L.push('## Do not say — assumed, not observed');
  L.push('');
  L.push('Every one of these is a placeholder from the industry prior. Saying any of it as fact hands them an easy way to dismiss the whole call.');
  L.push('');
  for (const [key, meta] of Object.entries(analysis.inputs)) {
    if (meta.basis !== 'assumed') continue;
    L.push(`- \`${key}\` = ${meta.display} — **assumed**. Ask, don't assert.`);
  }
  L.push('');
  if (gaps.length) {
    L.push('And phrase absences carefully. We know what we _did not find_, which is not the same as what they _do not have_:');
    L.push('');
    for (const g of gaps) L.push(`- ${g.headline} — ${g.consequence}. Say "I couldn't find…", not "you don't have…".`);
    L.push('');
  }

  // ---- leaks ------------------------------------------------------------
  L.push('## Where the money is going');
  L.push('');
  L.push('| Leak | Est. monthly | Share | Closed by | Confidence |');
  L.push('|---|---:|---:|---|---|');
  for (const item of analysis.leaks.items) {
    if (item.monthly <= 0) continue;
    const share = Math.round((item.monthly / analysis.leaks.monthlyRecover) * 100);
    const inputKey = { missed: 'missedCallPct', speed: 'responseTime', noshow: 'noShowPct', nurture: 'followUps', reactivate: 'reactivation', reviews: 'reviews' }[item.key];
    L.push(`| ${item.label} | ${money(item.monthly)} | ${share}% | ${item.agent} | ${analysis.inputs[inputKey]?.basis || '—'} |`);
  }
  L.push('');

  // ---- lead with --------------------------------------------------------
  const leadAgent = analysis.agents[0];
  L.push('## Lead with');
  L.push('');
  L.push(`### ${leadAgent.agent} — ${leadAgent.sharePct}% of everything recoverable`);
  L.push('');
  L.push(`Driven by: ${leadAgent.drivers.join(', ')}.`);
  L.push('');
  // The framing line has to come from a leak this agent actually closes. The
  // biggest single leak is not always inside the biggest agent bucket — an
  // agent that closes two medium leaks can outrank the one large one.
  const topLeak = analysis.leaks.items.find(i => i.agent === leadAgent.agent) || analysis.leaks.items[0];
  L.push(`One-sentence framing: _"${topLeak.statement}"_`);
  L.push('');
  L.push('**Why this agent and not another:** it is the largest single block of recoverable revenue in this profile. ' +
         'If they push back on it, fall to ' + (analysis.agents[1] ? `**${analysis.agents[1].agent}** (${analysis.agents[1].sharePct}%)` : 'discovery') + ' rather than defending.');
  L.push('');

  // ---- objections -------------------------------------------------------
  L.push('## Objections you should expect');
  L.push('');
  for (const o of objections) {
    L.push(`### ${o.objection}`);
    L.push('');
    L.push(`_Why it's coming:_ ${o.why}`);
    L.push('');
    for (const r of o.response) L.push(`- ${r}`);
    L.push('');
  }

  // ---- proof ------------------------------------------------------------
  L.push('## Proof to cite');
  L.push('');
  for (const t of proof) {
    L.push(`> "${t.quote}"`);
    L.push(`> — **${t.name}**, ${t.role}`);
    L.push('');
  }
  L.push('_Verbatim only. Do not paraphrase a testimonial into a stronger claim than the client made._');
  L.push('');

  // ---- close ------------------------------------------------------------
  L.push('## Recommended offer & next step');
  L.push('');
  L.push(`### ${offer.name}`);
  L.push('');
  L.push(offer.promise);
  L.push('');
  L.push(`**Why this one here:** ${offer.because}`);
  L.push('');
  L.push(`Page to send: \`${offer.url}\``);
  L.push('');
  L.push('**If they stall:** send them the scorecard at `/scorecard` and let them produce their own number. ' +
         'A score they generated themselves is much harder for them to argue with than one you brought.');
  L.push('');
  L.push(`**House constraints, stated honestly:** ${PROOF.constraints.terms} ${PROOF.constraints.setup} ${PROOF.constraints.capacity}`);
  L.push('');

  // ---- appendix ---------------------------------------------------------
  L.push('---');
  L.push('');
  L.push('## Appendix — how every number here was derived');
  L.push('');
  L.push('| Input | Value | Basis | Evidence |');
  L.push('|---|---|---|---|');
  for (const [key, meta] of Object.entries(analysis.inputs)) {
    const ev = (meta.evidence || []).join('; ') || '—';
    L.push(`| \`${key}\` | ${meta.display ?? meta.value} | ${meta.basis} | ${ev} |`);
  }
  L.push('');
  L.push('**Pages read:**');
  L.push('');
  for (const p of record.pages) {
    L.push(`- \`${p.url}\` — HTTP ${p.status ?? 'error'}${p.error ? ` (${p.error})` : ''}, ${p.bytes} bytes, ${p.elapsedMs}ms`);
  }
  if (record.robots?.disallow?.length) {
    L.push('');
    L.push(`**robots.txt disallowed** (respected, not fetched): ${record.robots.disallow.join(', ')}`);
  }
  if (record.errors?.length) {
    L.push('');
    L.push('**Collection problems:**');
    L.push('');
    for (const e of record.errors) L.push(`- ${e}`);
  }
  L.push('');
  L.push('_Not automatically observable, by design: review-response rate (Google exposes no owner-reply field), ' +
         'revenue, employee count, and ad spend. If a brief ever shows those as observed, something is fabricating them._');
  L.push('');

  return L.join('\n');
}

module.exports = { renderMarkdown, observedFacts, absences, openingLine, recommendOffer };
