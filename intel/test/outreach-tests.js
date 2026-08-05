'use strict';

/**
 * Outreach tests.
 *
 * The failure mode that matters here is not a crash — it is an email that
 * confidently tells a business something untrue about itself. One line of
 * "I noticed you don't have X" to a company that has X, and the whole
 * campaign reads as spam. So most of these tests are about what the composer
 * refuses to say.
 *
 *   node intel/test/outreach-tests.js
 */

const assert = require('assert');
const { composeSequence, openingObservation } = require('../lib/outreach');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

const signals = (over = {}) => ({
  chat: { present: false }, booking: { present: false }, crm: { present: false },
  adPixels: { present: false }, callTracking: { present: false },
  reviewWidget: { present: false }, platform: { present: false },
  form: { present: false }, phone: { present: false }, social: { profiles: [] },
  claims: {}, performance: { heavy: false, scriptCount: 8, hasViewport: true },
  ...over,
});

const record = (over = {}) => ({
  domain: 'example.com', observedAt: new Date().toISOString(),
  pages: [], errors: [], places: null, signals: signals(over.signals),
  ...over,
});

const analysis = (over = {}) => ({
  pct: 55, band: 'Heavy loss',
  leaks: { annualRecover: 348998, items: [{ key: 'missed', label: 'Missed & unanswered calls', monthly: 7603 }] },
  agents: [{ agent: 'AI Receptionist' }],
  inputs: {}, sensitivity: [],
  ...over,
});

(async () => {
  const savedAddr = process.env.OUTREACH_POSTAL_ADDRESS;
  const savedEmail = process.env.OUTREACH_FROM_NAME;

  console.log('\nwhat it refuses to say');
  {
    test('never asserts an absence — no "you don\'t have" anywhere', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const all = seq.steps.map(s => `${s.subject}\n${s.body}`).join('\n').toLowerCase();
      for (const phrase of ["you don't have", 'you do not have', "you're missing",
                            'you lack', 'i noticed you don']) {
        assert.ok(!all.includes(phrase), `email asserts an absence: "${phrase}"`);
      }
    });

    test('with nothing verifiable, it opens with a question and flags it', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.observation, null);
      assert.ok(seq.notes.some(n => /nothing verifiable/i.test(n)));
      assert.match(seq.steps[0].body, /Quick question/);
    });

    test('an observation is only used when it came from a real signal', () => {
      const withReviews = record({ places: { matched: true, reviewCount: 312, rating: 4.8 } });
      const seq = composeSequence(withReviews, analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.match(seq.observation, /312 Google reviews/);
      assert.match(seq.steps[0].body, /312 Google reviews at 4\.8 stars/);
    });

    test('a thin review count is not used as an opener', () => {
      const thin = record({ places: { matched: true, reviewCount: 6, rating: 4.1 } });
      const seq = composeSequence(thin, analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.ok(!/6 Google reviews/.test(JSON.stringify(seq.steps)),
        'opened with a review count too small to be flattering');
    });

    test('the dollar estimate is always labelled as an estimate', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const step2 = seq.steps[1].body;
      assert.match(step2, /\$348,998/);
      assert.match(step2, /estimate/i, 'quoted a number without calling it an estimate');
      assert.match(step2, /expect to be wrong/i);
    });

    test('never quotes dollars off the per-100-leads placeholder', () => {
      // unitBasis means lead volume was never observed, so the recoverable
      // figure describes a hypothetical business — quoting it would be
      // inventing a fact about this one.
      process.env.OUTREACH_POSTAL_ADDRESS = 'PO Box 123, Orange, CA 92869';
      const seq = composeSequence(record(), analysis({ unitBasis: true }),
        { name: 'Acme', email: 'a@b.com' });
      const all = seq.steps.map(s => s.body).join('\n');
      assert.ok(!/348,998/.test(all), 'quoted a placeholder figure as if it were real');
      assert.match(seq.steps[1].body, /how many enquiries/i, 'did not ask for the missing number');
      assert.ok(seq.notes.some(n => /placeholder/i.test(n)));
      // …and it is a note, not a reason to hold the email.
      assert.strictEqual(seq.canSend, true, seq.blockers.join('; '));
    });
  }

  console.log('\ncompliance gates');
  {
    test('no postal address configured blocks sending', () => {
      delete process.env.OUTREACH_POSTAL_ADDRESS;  // set by an earlier block
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.canSend, false);
      assert.ok(seq.blockers.some(b => /CAN-SPAM/.test(b)));
    });

    test('with an address and an email, it clears', () => {
      process.env.OUTREACH_POSTAL_ADDRESS = 'PO Box 123, Orange, CA 92869';
      const seq = composeSequence(record({ places: { matched: true, reviewCount: 200, rating: 4.7 } }),
        analysis(), { name: 'Acme', email: 'owner@acme.com' });
      assert.strictEqual(seq.canSend, true, seq.blockers.join('; '));
    });

    test('a missing email address blocks sending', () => {
      process.env.OUTREACH_POSTAL_ADDRESS = 'PO Box 123, Orange, CA 92869';
      const seq = composeSequence(record(), analysis(), { name: 'Acme' });
      assert.strictEqual(seq.canSend, false);
      assert.ok(seq.blockers.some(b => /No email address/.test(b)));
    });

    test('every step carries an unsubscribe token and the address', () => {
      process.env.OUTREACH_POSTAL_ADDRESS = 'PO Box 123, Orange, CA 92869';
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      for (const step of seq.steps) {
        assert.match(step.body, /\{\{unsubscribe_link\}\}/, `step ${step.n} has no unsubscribe`);
        assert.match(step.body, /PO Box 123/, `step ${step.n} has no postal address`);
      }
    });
  }

  console.log('\nsequence shape');
  {
    process.env.OUTREACH_POSTAL_ADDRESS = 'PO Box 123, Orange, CA 92869';

    test('three steps, spaced, with the last one closing the file', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.steps.length, 3);
      assert.deepStrictEqual(seq.steps.map(s => s.sendAfterDays), [0, 3, 7]);
      assert.match(seq.steps[2].body, /close the file/i);
    });

    test('the question is chosen by the top leak, not fixed', () => {
      const noshow = analysis({
        leaks: { annualRecover: 1000, items: [{ key: 'noshow', label: 'No-shows & cancellations', monthly: 900 }] },
      });
      const seq = composeSequence(record(), noshow, { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.leakKey, 'noshow');
      assert.match(seq.steps[0].body, /how many actually show up/);

      const reviews = analysis({
        leaks: { annualRecover: 1000, items: [{ key: 'reviews', label: 'Weak reviews & reputation', monthly: 500 }] },
      });
      const seq2 = composeSequence(record(), reviews, { name: 'Acme', email: 'a@b.com' });
      assert.match(seq2.steps[0].body, /how do you ask for reviews/);
    });

    test('no "we helped another company like you" boilerplate', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const all = seq.steps.map(s => s.body).join('\n').toLowerCase();
      for (const phrase of ['we recently helped', 'another hvac company', 'case study',
                            'we work with businesses like']) {
        assert.ok(!all.includes(phrase), `boilerplate crept in: "${phrase}"`);
      }
    });

    test('emails stay short — under 900 characters of body each', () => {
      const seq = composeSequence(record({ places: { matched: true, reviewCount: 200, rating: 4.7 } }),
        analysis(), { name: 'Acme', email: 'a@b.com' });
      for (const step of seq.steps) {
        assert.ok(step.body.length < 900, `step ${step.n} is ${step.body.length} chars — too long to read`);
      }
    });

    test('addresses the owner by name only when we actually have one', () => {
      const anon = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.match(anon.steps[0].body, /^Hi,/m);
      const named = composeSequence(record(), analysis(),
        { name: 'Acme', email: 'a@b.com', ownerFirstName: 'Dave' });
      assert.match(named.steps[0].body, /^Hi Dave,/m);
    });

    test('evidence is attached so a reviewer can check every claim', () => {
      const seq = composeSequence(
        record({ places: { matched: true, reviewCount: 200, rating: 4.7 },
                 signals: { adPixels: { present: true, vendor: 'Meta Pixel', evidence: 'fbq(' } } }),
        analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.ok(seq.evidence.length > 0);
      assert.ok(seq.evidence.some(e => /Google Places|Meta Pixel/.test(e)));
    });
  }

  console.log('\nopener priority');
  {
    test('reviews beat ad pixels beat booking', () => {
      const both = record({
        places: { matched: true, reviewCount: 150, rating: 4.5 },
        signals: { adPixels: { present: true, vendor: 'Meta Pixel' }, booking: { present: true, vendor: 'Calendly' } },
      });
      assert.match(openingObservation(both, analysis()).text, /150 Google reviews/);

      const noReviews = record({
        signals: { adPixels: { present: true, vendor: 'Meta Pixel' }, booking: { present: true, vendor: 'Calendly' } },
      });
      assert.match(openingObservation(noReviews, analysis()).text, /Meta Pixel/);
    });
  }

  if (savedAddr === undefined) delete process.env.OUTREACH_POSTAL_ADDRESS;
  else process.env.OUTREACH_POSTAL_ADDRESS = savedAddr;
  if (savedEmail === undefined) delete process.env.OUTREACH_FROM_NAME;

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
