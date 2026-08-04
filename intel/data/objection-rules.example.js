'use strict';

/**
 * PLACEHOLDER objection rules.
 *
 * Copy this file to `objection-rules.js` (gitignored) and replace it with how
 * your team actually handles pushback. What is here is deliberately generic —
 * it demonstrates the shape and keeps the tests running on a fresh clone. It
 * is not a playbook and should not be used on a live call.
 *
 * Each rule:
 *   id        stable identifier
 *   when      (signals, ctx) => boolean   — ctx is { places, analysis }
 *   objection string, or (signals, ctx) => string
 *   why       string, or (signals, ctx) => string   — why it's coming
 *   response  string[]                    — what the rep does about it
 */

module.exports = [
  {
    id: 'already-have-tooling',
    when: s => s.chat?.present || s.crm?.present || s.booking?.present,
    objection: '"We already have something for that."',
    why: s =>
      `Tooling was detected on the site (${[s.chat?.vendor, s.crm?.vendor, s.booking?.vendor]
        .filter(Boolean).join(', ')}), so expect them to say it is handled.`,
    response: [
      'Concede the tool exists rather than arguing about it.',
      'Ask what happens to an inquiry that arrives outside business hours.',
      'The gap is usually between capture and response, not the tool itself.',
    ],
  },
  {
    id: 'already-spending',
    when: s => s.adPixels?.present,
    objection: '"We already spend on marketing."',
    why: 'Ad tracking pixels are firing, so there is real budget moving already.',
    response: [
      'Separate traffic from conversion — you are not asking for ad budget.',
      'Ask what share of the leads they already pay for get answered same-day.',
    ],
  },
  {
    id: 'budget',
    when: s => /GoDaddy|Wix/i.test(s.platform?.vendor || ''),
    objection: '"That is more than we want to spend."',
    why: s => `Site is built on ${s.platform.vendor}, which usually means a cost-conscious operator.`,
    response: [
      'Reduce scope rather than price.',
      'Ask what result in the first 30 days would make the cost a non-issue.',
    ],
  },
  {
    id: 'cold-call-default',
    when: () => true,
    objection: '"What is this about / how did you get my details?"',
    why: 'Every outbound call gets some version of this in the first fifteen seconds.',
    response: [
      'Answer it plainly — the research came from their public website.',
      'Give one specific observation, then ask one question and stop talking.',
    ],
  },
];
