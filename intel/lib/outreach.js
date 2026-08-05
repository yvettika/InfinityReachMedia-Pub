'use strict';

const { observedFacts } = require('./brief');

/**
 * Outreach composer.
 *
 * Turns the research into a short email sequence, using the same rule the
 * brief runs on: **only observed facts get asserted**. An email that opens
 * "I noticed you don't have after-hours coverage" to a company that does is
 * worse than no email at all — it proves in one line that nobody looked.
 *
 * So the composer works from `observedFacts()`, the same receipts-carrying
 * list the call brief prints under "Say this". If there is nothing verified to
 * open with, it does not invent one; it opens with a question instead and says
 * so in `blockers` for anyone reviewing.
 *
 * Deliberately not an LLM. A template seeded with real observations is more
 * reliable than a model asked to be clever about a business it cannot see, and
 * it means every sentence in every email can be traced to a fetch. When an LLM
 * does go in, it belongs here — rewriting a line whose facts are already
 * fixed — not choosing what to claim.
 *
 * Nothing here sends anything. It writes drafts. Sending is a separate,
 * explicit act, which is also what the site promises: "You approve the list
 * first; one-click unsubscribe on every message."
 */

const SENDER = () => ({
  name: process.env.OUTREACH_FROM_NAME || 'Yvette Kahn',
  company: process.env.OUTREACH_COMPANY || 'Infinity Reach Media',
  // CAN-SPAM requires a real physical postal address in every commercial
  // email. Left unset on purpose: the GHL business address is a home address,
  // and that should not go on thousands of cold emails. Set this to a PO box
  // or virtual office and the composer stops blocking.
  address: process.env.OUTREACH_POSTAL_ADDRESS || null,
  bookingUrl: process.env.OUTREACH_BOOKING_URL || 'https://infinityreachmedia.com/book',
});

/** Pick the single strongest thing we can actually prove about them. */
function openingObservation(record, analysis) {
  const s = record.signals || {};
  const p = record.places && record.places.matched ? record.places : null;

  // Ordered by how specific and how checkable each one is. A review count is
  // the best opener there is: it is public, it is flattering, and it proves
  // we looked at them rather than at a list.
  if (p && typeof p.reviewCount === 'number' && p.reviewCount >= 40) {
    return {
      text: `You've got ${p.reviewCount} Google reviews${p.rating ? ` at ${p.rating} stars` : ''}`,
      source: 'Google Places',
    };
  }
  if (s.adPixels?.present) {
    return {
      text: `I can see you're running ${s.adPixels.vendor}, so you're paying for traffic`,
      source: `${s.adPixels.vendor} on the site`,
    };
  }
  if (s.booking?.present) {
    return {
      text: `You've got ${s.booking.vendor} set up for booking, which puts you ahead of most`,
      source: `${s.booking.vendor} on the site`,
    };
  }
  if (s.claims?.afterHours?.present) {
    return { text: `Your site advertises 24/7 service`, source: 'site copy' };
  }
  if (s.platform?.present && s.performance?.heavy) {
    return {
      text: `Your homepage is running ${s.performance.scriptCount} scripts, which is a lot to load on a phone`,
      source: 'measured on fetch',
    };
  }
  return null;
}

/**
 * The question. Derived from the top leak, phrased as something only they can
 * answer — never as a claim about what they lack.
 */
const QUESTION_BY_LEAK = {
  missed: 'when a call comes in after hours and nobody picks up, where does it go?',
  speed: 'when a form comes in at 7pm on a Saturday, when does that person actually hear back?',
  noshow: 'out of ten booked appointments, how many actually show up?',
  nurture: 'if someone asks for a quote and goes quiet, how many times do you chase them?',
  reactivate: 'when was the last time you deliberately reached back out to customers from two years ago?',
  reviews: 'how do you ask for reviews right now — is it a system, or does someone have to remember?',
};

function topLeakKey(analysis) {
  return analysis?.leaks?.items?.find(i => i.monthly > 0)?.key || 'missed';
}

function footer(sender, { includeUnsubscribe = true } = {}) {
  const lines = [
    '',
    '—',
    `${sender.name}, ${sender.company}`,
  ];
  if (sender.address) lines.push(sender.address);
  if (includeUnsubscribe) {
    // GHL substitutes this token at send time. Keeping the token rather than a
    // URL means the link is always the live one for that contact.
    lines.push('', 'Not interested? {{unsubscribe_link}} and I won\'t write again.');
  }
  return lines.join('\n');
}

/**
 * Compose the sequence.
 *
 * @param {object} record    collector output (needed for the observed facts)
 * @param {object} analysis  model output
 * @param {object} prospect  the flat prospect record (name, niche, city…)
 * @returns {{ steps: Array, blockers: string[], evidence: string[], canSend: boolean }}
 */
function composeSequence(record, analysis, prospect = {}) {
  const sender = SENDER();
  // blockers stop a send (compliance, missing data). notes are things a
  // reviewer should know that are not reasons to hold the email.
  const blockers = [];
  const notes = [];
  const business = prospect.name || record.places?.name || record.domain;

  if (!sender.address) {
    blockers.push(
      'No OUTREACH_POSTAL_ADDRESS set. CAN-SPAM requires a physical postal address in ' +
      'every commercial email — set a PO box or virtual office, not a home address.'
    );
  }
  if (!prospect.email) {
    blockers.push('No email address for this prospect — contact discovery is not built yet.');
  }

  const observation = openingObservation(record, analysis);
  if (!observation) {
    notes.push('Nothing verifiable to open with — falling back to a question-only opener.');
  }

  const facts = observedFacts(record, analysis);
  const evidence = facts.map(f => `${f.fact} (${f.source})`);
  const leakKey = topLeakKey(analysis);
  const question = QUESTION_BY_LEAK[leakKey] || QUESTION_BY_LEAK.missed;
  const firstName = prospect.ownerFirstName || null;
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

  // --- step 1: one observation, one question -----------------------------
  const step1Body = [
    greeting,
    '',
    observation
      ? `${observation.text} — so people are clearly finding you.`
      : `I had a look at ${business} before writing.`,
    '',
    `Quick question, and I'm genuinely asking rather than pitching: ${question}`,
    '',
    'If the answer is "it goes to voicemail and we call back when we can", that\'s the ' +
    'normal answer and it\'s usually the most expensive one in the business.',
    footer(sender),
  ].join('\n');

  // --- step 2: the cost, quantified but honest ---------------------------
  const recoverable = analysis?.leaks?.annualRecover;
  const leakLabel = analysis?.leaks?.items?.find(i => i.monthly > 0)?.label || 'the gap';

  // Only quote a dollar figure when the lead volume behind it was actually
  // observed. On the unit basis the model runs at 100 leads/month as a
  // placeholder, so that number describes a hypothetical business, not this
  // one — putting it in an email as "for a business your size" would be
  // inventing a fact, which is the one thing this system does not do.
  const quotable = recoverable != null && analysis?.unitBasis !== true;
  if (!quotable && recoverable != null) {
    notes.push(
      'Lead volume unknown, so the recoverable figure is a per-100-leads placeholder. ' +
      'Step 2 asks for their number instead of quoting one.'
    );
  }

  const step2Body = [
    greeting,
    '',
    `Following up on the note about ${leakLabel.toLowerCase()}.`,
    '',
    quotable
      ? `Rough maths for a business your size: that gap is usually worth somewhere around ` +
        `${'$' + Math.round(recoverable).toLocaleString('en-US')} a year. That number is an ` +
        `estimate built from the outside — I'd expect to be wrong about it until you tell me ` +
        `your actual lead volume.`
      : `I can't put a number on it without knowing roughly how many enquiries you get in a ` +
        `month — that one figure decides whether this is worth your time or a rounding error. ` +
        `If you tell me, I'll do the maths and send it over either way.`,
    '',
    'If it\'s worth ten minutes to find out, my calendar is here: ' + sender.bookingUrl,
    footer(sender),
  ].join('\n');

  // --- step 3: close the file --------------------------------------------
  const step3Body = [
    greeting,
    '',
    `Last one from me — I don't want to be the person who keeps emailing.`,
    '',
    `If this isn't a priority, just say "not now" and I'll close the file. ` +
    `If it is, the calendar link is ${sender.bookingUrl}.`,
    '',
    'Either way, good luck with the rest of the year.',
    footer(sender),
  ].join('\n');

  const steps = [
    {
      n: 1,
      sendAfterDays: 0,
      subject: observation
        ? `Question about ${business}`
        : `Quick question about ${business}`,
      body: step1Body,
    },
    {
      n: 2,
      sendAfterDays: 3,
      subject: `Re: Question about ${business}`,
      body: step2Body,
    },
    {
      n: 3,
      sendAfterDays: 7,
      subject: `Closing the file on this`,
      body: step3Body,
    },
  ];

  return {
    steps,
    evidence,
    blockers,
    notes,
    // canSend is about compliance and data, not about whether the copy is good.
    // A human still approves every list — this only says nothing is missing.
    canSend: blockers.length === 0,
    observation: observation ? observation.text : null,
    leakKey,
  };
}

module.exports = { composeSequence, openingObservation, QUESTION_BY_LEAK, SENDER, footer };
