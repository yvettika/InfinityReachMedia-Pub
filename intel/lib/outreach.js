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

/**
 * Signature image / GIF.
 *
 * Off for step 1 by default, and that default is the important part. In cold
 * email a first touch from a domain with no sending history is already under
 * scrutiny; an embedded image raises the image-to-text ratio, adds a remote
 * fetch, and many clients (Outlook especially) block remote images outright —
 * so the recipient's first impression of you becomes a grey broken-image box.
 * Plain-looking first touches also just read as a person writing, which is the
 * whole angle here.
 *
 * By step 2 they have seen your name once and the risk profile changes, which
 * is why the default is steps 2 and 3. Override with OUTREACH_IMAGE_STEPS if
 * you want to test otherwise — testing it is reasonable, defaulting to it is
 * not.
 *
 * A note on GIFs specifically: Outlook renders only the first frame, so any
 * animated GIF has to make sense as a still image. And keep it small — a
 * 3MB GIF is both a spam signal and a bad experience on a phone.
 */
const IMAGE = () => {
  const url = process.env.OUTREACH_SIGNATURE_IMAGE_URL || null;
  const steps = (process.env.OUTREACH_IMAGE_STEPS || '2,3')
    .split(',').map(s => Number(s.trim())).filter(Number.isFinite);
  return {
    url,
    alt: process.env.OUTREACH_SIGNATURE_IMAGE_ALT ||
      `${process.env.OUTREACH_FROM_NAME || 'Yvette Kahn'}, ${process.env.OUTREACH_COMPANY || 'Infinity Reach Media'}`,
    width: Number(process.env.OUTREACH_SIGNATURE_IMAGE_WIDTH || 120),
    steps,
    linkUrl: process.env.OUTREACH_SIGNATURE_IMAGE_LINK || null,
  };
};

/**
 * Preflight the signature image before it goes anywhere near a send.
 *
 * A wrong URL — a typo, a file that was never deployed, a rename — puts a grey
 * broken-image box in every email in the campaign. That is strictly worse than
 * sending no image at all, and it is invisible to whoever wrote the config
 * because their own client caches it. So the URL is fetched once per run and
 * the image is dropped if it does not resolve to an actual image.
 *
 * Cached at module level: a 200-prospect run checks once.
 */
let imageCheck = null;

async function verifySignatureImage(url, { timeoutMs = 8000 } = {}) {
  const target = url || IMAGE().url;
  if (!target) return { ok: false, reason: 'no image configured', checked: false };
  if (imageCheck && imageCheck.url === target) return imageCheck.result;

  let result;
  try {
    const res = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) {
      result = { ok: false, checked: true, reason: `HTTP ${res.status} — the file is not there` };
    } else if (!/^image\//i.test(type)) {
      result = { ok: false, checked: true, reason: `served as "${type}", not an image` };
    } else {
      const bytes = Number(res.headers.get('content-length')) || null;
      result = { ok: true, checked: true, type, bytes };
      // Not fatal, but a 3MB GIF is a spam signal and a bad phone experience.
      if (bytes && bytes > 1_500_000) {
        result.warn = `${Math.round(bytes / 1024)}KB is heavy for an email image`;
      }
    }
  } catch (err) {
    result = { ok: false, checked: true, reason: `could not be fetched (${err.message})` };
  }

  imageCheck = { url: target, result };
  return result;
}

function resetImageCheck() { imageCheck = null; }

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

/**
 * The ask gets its own line with blank lines either side.
 *
 * Buried at the end of a paragraph, the one question you want answered reads
 * as part of the pitch and gets skimmed past. On its own it is the thing the
 * eye lands on, and a reply becomes the obvious next action rather than an
 * effort. Every step's call to action goes through here so the treatment is
 * identical across the sequence.
 */
function callToAction(text) {
  return ['', text, ''];
}

/** Sentence-case a fragment written to sit mid-sentence. */
function asSentence(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

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

const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Plain text → HTML, keeping it deliberately plain.
 *
 * No layout tables, no branded header, no button. A cold email that looks like
 * a newsletter gets read as one. The only markup is what's needed for links,
 * line breaks, and the optional signature image.
 */
function toHtml(text, { image = null } = {}) {
  const linkify = str => str.replace(
    /(https?:\/\/[^\s<]+[^\s<.,;:)])/g,
    url => `<a href="${escapeHtml(url)}" style="color:#0b62d0">${escapeHtml(url)}</a>`
  );

  // Escape first, then restore the two things that must stay live: the
  // unsubscribe merge token and any URLs.
  const body = linkify(escapeHtml(text))
    .replace(/\{\{\s*unsubscribe_link\s*\}\}/g,
      '<a href="{{unsubscribe_link}}" style="color:#0b62d0">unsubscribe here</a>')
    .replace(/\n/g, '<br>\n');

  let imageHtml = '';
  if (image && image.url) {
    // width/height as attributes, not just CSS: when a client blocks the
    // image, a sized box with alt text degrades far better than a giant
    // placeholder shoving the signature around.
    const img =
      `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt)}" ` +
      `width="${image.width}" style="width:${image.width}px;max-width:100%;` +
      `border-radius:6px;display:block;margin-top:12px" />`;
    imageHtml = image.linkUrl
      ? `\n<a href="${escapeHtml(image.linkUrl)}">${img}</a>`
      : `\n${img}`;
  }

  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;` +
    `font-size:15px;line-height:1.5;color:#222">\n${body}${imageHtml}\n</div>`
  );
}

/**
 * Compose the sequence.
 *
 * @param {object} record    collector output (needed for the observed facts)
 * @param {object} analysis  model output
 * @param {object} prospect  the flat prospect record (name, niche, city…)
 * @returns {{ steps: Array, blockers: string[], notes: string[], evidence: string[], canSend: boolean }}
 */
function composeSequence(record, analysis, prospect = {}, opts = {}) {
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
    `Quick question, and I'm genuinely asking rather than pitching:`,
    ...callToAction(asSentence(question)),
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
    ...callToAction('Worth ten minutes to find out?'),
    'My calendar is here: ' + sender.bookingUrl,
    footer(sender),
  ].join('\n');

  // --- step 3: close the file --------------------------------------------
  const step3Body = [
    greeting,
    '',
    `Last one from me — I don't want to be the person who keeps emailing.`,
    ...callToAction('Is it a bad idea to look at this before the season turns?'),
    `If it is, just say "not now" and I'll close the file. If it isn't, the calendar ` +
    `link is ${sender.bookingUrl}.`,
    '',
    'Either way, good luck with the rest of the year.',
    footer(sender),
  ].join('\n');

  const image = IMAGE();

  // `imageVerified === false` means the preflight ran and the URL is bad. Drop
  // the image rather than shipping a broken box; a plain email is fine.
  if (image.url && opts.imageVerified === false) {
    notes.push(
      `Signature image dropped — ${opts.imageReason || 'the URL did not resolve to an image'}. ` +
      'The emails still send, without it.'
    );
    image.url = null;
  }

  if (image.url && image.steps.includes(1)) {
    notes.push(
      'Signature image is enabled on step 1. That is the riskiest touch to put ' +
      'an image on — no sending history, and blocked images render as a grey box. ' +
      'Worth A/B testing, not worth assuming.'
    );
  }

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
  ].map(step => {
    const withImage = !!image.url && image.steps.includes(step.n);
    return { ...step, hasImage: withImage, html: toHtml(step.body, { image: withImage ? image : null }) };
  });

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

module.exports = { composeSequence, openingObservation, QUESTION_BY_LEAK, SENDER, IMAGE, footer, toHtml, callToAction, asSentence, verifySignatureImage, resetImageCheck };
