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
const http = require('http');
const { composeSequence, openingObservation, toHtml,
        verifySignatureImage, resetImageCheck } = require('../lib/outreach');

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
      assert.match(seq.steps[0].body, /how many actually show up/i);

      const reviews = analysis({
        leaks: { annualRecover: 1000, items: [{ key: 'reviews', label: 'Weak reviews & reputation', monthly: 500 }] },
      });
      const seq2 = composeSequence(record(), reviews, { name: 'Acme', email: 'a@b.com' });
      assert.match(seq2.steps[0].body, /how do you ask for reviews/i);
    });

    test('the call to action sits alone, with a blank line either side', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      for (const step of seq.steps) {
        const lines = step.body.split('\n');
        // Find the ask: a line ending in '?' that is not the greeting.
        const i = lines.findIndex(l => /\?\s*$/.test(l) && !/^Hi/.test(l));
        assert.ok(i > 0, `step ${step.n} has no question line at all`);
        assert.strictEqual(lines[i - 1].trim(), '',
          `step ${step.n}: no blank line above the ask`);
        assert.strictEqual((lines[i + 1] || '').trim(), '',
          `step ${step.n}: no blank line below the ask`);
        assert.ok(lines[i].trim().length < 120,
          `step ${step.n}: the ask is buried in a paragraph, not standing alone`);
      }
    });

    test('the isolated ask reads as a sentence, not a fragment', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const ask = seq.steps[0].body.split('\n').find(l => /\?\s*$/.test(l) && !/^Hi/.test(l));
      assert.match(ask, /^[A-Z]/, 'the ask starts lowercase on its own line');
    });

    test('the ask survives into the HTML part with its spacing', () => {
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      // A blank source line becomes a lone <br> — the visual gap in an inbox.
      assert.match(seq.steps[0].html, /<br>\n<br>\n/, 'blank lines were collapsed in the HTML');
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

  console.log('\nsignature image / GIF');
  {
    const IMG = 'https://infinityreachmedia.com/images/yvette.gif';
    const clearImageEnv = () => {
      delete process.env.OUTREACH_SIGNATURE_IMAGE_URL;
      delete process.env.OUTREACH_IMAGE_STEPS;
      delete process.env.OUTREACH_SIGNATURE_IMAGE_LINK;
      delete process.env.OUTREACH_SIGNATURE_IMAGE_ALT;
    };

    test('no image configured → clean HTML, no <img> anywhere', () => {
      clearImageEnv();
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      for (const step of seq.steps) {
        assert.strictEqual(step.hasImage, false);
        assert.ok(!/<img/.test(step.html), `step ${step.n} has an image it should not`);
      }
    });

    test('by default the image is off for step 1 and on for 2 and 3', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.steps[0].hasImage, false, 'step 1 carries an image by default');
      assert.strictEqual(seq.steps[1].hasImage, true);
      assert.strictEqual(seq.steps[2].hasImage, true);
      assert.match(seq.steps[1].html, /<img src="https:\/\/infinityreachmedia\.com\/images\/yvette\.gif"/);
    });

    test('enabling it on step 1 is allowed but flagged', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      process.env.OUTREACH_IMAGE_STEPS = '1,2,3';
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.strictEqual(seq.steps[0].hasImage, true, 'override was ignored');
      assert.ok(seq.notes.some(n => /step 1/i.test(n)), 'no warning about step 1');
      assert.strictEqual(seq.canSend, true, 'a warning should not block the send');
    });

    test('the image degrades when a client blocks it — alt text and a fixed width', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      process.env.OUTREACH_SIGNATURE_IMAGE_ALT = 'Yvette Kahn, Infinity Reach Media';
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const html = seq.steps[1].html;
      assert.match(html, /alt="Yvette Kahn, Infinity Reach Media"/, 'no alt text for blocked images');
      assert.match(html, /width="120"/, 'no width attribute — blocked images will shove the layout');
      assert.match(html, /max-width:100%/, 'not responsive on a phone');
    });

    test('a plain-text body always exists alongside the HTML', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      for (const step of seq.steps) {
        assert.ok(step.body && step.body.length > 100, `step ${step.n} has no text part`);
        assert.ok(!/<img|<div/.test(step.body), `step ${step.n} text part contains markup`);
      }
    });

    test('the email is never image-only — text carries the message', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      const html = seq.steps[1].html;
      const textLen = html.replace(/<[^>]+>/g, '').trim().length;
      assert.ok(textLen > 300, `only ${textLen} chars of text around the image — reads as an image-only send`);
    });

    test('the image can be made clickable', () => {
      clearImageEnv();
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = IMG;
      process.env.OUTREACH_SIGNATURE_IMAGE_LINK = 'https://infinityreachmedia.com/book';
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' });
      assert.match(seq.steps[1].html, /<a href="https:\/\/infinityreachmedia\.com\/book"><img/);
    });

    test('HTML conversion escapes content but keeps links and unsubscribe live', () => {
      const html = toHtml('Hi <script>alert(1)</script> & "co"\nSee https://example.com/x\n{{unsubscribe_link}}');
      assert.ok(!/<script>/.test(html), 'script tag survived escaping');
      assert.match(html, /&lt;script&gt;/);
      assert.match(html, /&amp;/);
      assert.match(html, /<a href="https:\/\/example\.com\/x"/, 'URL was not linkified');
      assert.match(html, /href="\{\{unsubscribe_link\}\}"/, 'unsubscribe token was destroyed');
      assert.match(html, /<br>/);
    });

    clearImageEnv();
  }

  console.log('\nimage preflight — a broken URL must never ship');
  {
    const srv = http.createServer((req, res) => {
      if (req.url === '/good.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '48000' });
        return res.end('x'.repeat(48000));
      }
      if (req.url === '/huge.gif') {
        res.writeHead(200, { 'content-type': 'image/gif', 'content-length': '3000000' });
        return res.end('x');
      }
      if (req.url === '/page.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html>not an image</html>');
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;

    resetImageCheck();
    const good = await verifySignatureImage(base + '/good.jpg');
    test('a real image passes and reports its size', () => {
      assert.strictEqual(good.ok, true);
      assert.match(good.type, /image\/jpeg/);
      assert.strictEqual(good.bytes, 48000);
      assert.ok(!good.warn);
    });

    resetImageCheck();
    const missing = await verifySignatureImage(base + '/nope.jpg');
    test('a missing file fails with a readable reason', () => {
      assert.strictEqual(missing.ok, false);
      assert.match(missing.reason, /HTTP 404/);
    });

    resetImageCheck();
    const notImage = await verifySignatureImage(base + '/page.html');
    test('a URL that serves HTML is rejected — a typo pointing at a page', () => {
      assert.strictEqual(notImage.ok, false);
      assert.match(notImage.reason, /not an image/);
    });

    resetImageCheck();
    const huge = await verifySignatureImage(base + '/huge.gif');
    test('a heavy image passes but warns', () => {
      assert.strictEqual(huge.ok, true);
      assert.match(huge.warn, /heavy/);
    });

    test('a failed preflight drops the image instead of shipping it broken', () => {
      process.env.OUTREACH_SIGNATURE_IMAGE_URL = base + '/nope.jpg';
      const seq = composeSequence(record(), analysis(), { name: 'Acme', email: 'a@b.com' },
        { imageVerified: false, imageReason: 'HTTP 404 — the file is not there' });
      for (const step of seq.steps) {
        assert.strictEqual(step.hasImage, false, `step ${step.n} still carries a broken image`);
        assert.ok(!/<img/.test(step.html));
      }
      assert.ok(seq.notes.some(n => /dropped/i.test(n) && /404/.test(n)));
      assert.strictEqual(seq.canSend, true, 'a bad image should not block the whole send');
      delete process.env.OUTREACH_SIGNATURE_IMAGE_URL;
    });

    let hits = 0;
    const counting = http.createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': '100' });
      res.end('x');
    });
    await new Promise(r => counting.listen(0, '127.0.0.1', r));
    resetImageCheck();
    const url = `http://127.0.0.1:${counting.address().port}/a.png`;
    await verifySignatureImage(url);
    await verifySignatureImage(url);
    await verifySignatureImage(url);
    test('repeat checks of the same URL hit the network once', () => {
      assert.strictEqual(hits, 1, `fetched ${hits} times — would be once per prospect`);
    });
    counting.close();
    srv.close();
    resetImageCheck();
  }

  console.log('\nheadshot helper — the checks that matter at 120px');
  {
    const { dimensions } = require('../add-headshot');
    const zlib = require('zlib');

    // Minimal but real encoders, so the header parsing is tested against
    // actual file bytes rather than a hand-written buffer.
    const png = (w, h) => {
      const raw = Buffer.alloc((w * 3 + 1) * h);
      const idat = zlib.deflateSync(raw);
      const chunk = (t, d) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t), d]);
        let c = ~0;
        for (const b of td) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
        const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
        return Buffer.concat([len, td, crc]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
      ]);
    };
    const jpeg = (w, h) => {
      const sof = Buffer.alloc(11);
      sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(9, 2); sof[4] = 8;
      sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), sof]);
    };
    const gif = (w, h) => {
      const b = Buffer.alloc(13);
      b.write('GIF89a', 0, 'ascii'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8);
      return b;
    };

    test('reads PNG dimensions from the header', () => {
      assert.deepStrictEqual(dimensions(png(400, 400)),
        { type: 'image/png', width: 400, height: 400 });
    });
    test('reads JPEG dimensions by walking to the start-of-frame', () => {
      const d = dimensions(jpeg(1130, 1966));
      assert.strictEqual(d.type, 'image/jpeg');
      assert.strictEqual(d.width, 1130);
      assert.strictEqual(d.height, 1966);
    });
    test('reads GIF dimensions (little-endian, unlike the others)', () => {
      assert.deepStrictEqual(dimensions(gif(320, 240)),
        { type: 'image/gif', width: 320, height: 240 });
    });
    test('a non-image returns null rather than a wrong guess', () => {
      assert.strictEqual(dimensions(Buffer.from('this is a text file')), null);
      assert.strictEqual(dimensions(Buffer.alloc(0)), null);
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
