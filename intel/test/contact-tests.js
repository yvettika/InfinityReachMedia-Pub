'use strict';

/**
 * Contact discovery tests.
 *
 * The expensive failure here is not missing an address — it is finding the
 * wrong one. Writing to the web designer whose email sits in the footer, or to
 * a `noreply@`, burns the prospect and the sending domain at once. So most of
 * these assert what gets rejected.
 *
 *   node intel/test/contact-tests.js
 */

const assert = require('assert');
const {
  extractEmails, pickBest, decodeCloudflare, deobfuscate, relatedDomain,
} = require('../lib/contacts');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

const emailsOf = (html, domain) => extractEmails(html, domain).map(c => c.email);

(async () => {
  console.log('\nfinding the address');
  {
    test('a plain mailto link is found', () => {
      const html = '<a href="mailto:office@baxterheating.com">Email us</a>';
      assert.deepStrictEqual(emailsOf(html, 'baxterheating.com'), ['office@baxterheating.com']);
    });

    test('an address written as plain text is found', () => {
      const html = '<p>Reach us at service@baxterheating.com any time.</p>';
      assert.ok(emailsOf(html, 'baxterheating.com').includes('service@baxterheating.com'));
    });

    test('human obfuscation is undone', () => {
      for (const raw of [
        'office [at] baxterheating [dot] com',
        'office(at)baxterheating(dot)com',
        'office at baxterheating dot com',
      ]) {
        const got = emailsOf(`<p>${raw}</p>`, 'baxterheating.com');
        assert.ok(got.includes('office@baxterheating.com'), `failed on: ${raw}`);
      }
    });

    test('HTML entity encoding is undone', () => {
      const html = '<p>office&#64;baxterheating&#46;com</p>';
      assert.ok(emailsOf(html, 'baxterheating.com').includes('office@baxterheating.com'));
    });

    test('Cloudflare email protection is decoded', () => {
      // Encode office@baxterheating.com with key 0x2a the way Cloudflare does.
      const plain = 'office@baxterheating.com';
      const key = 0x2a;
      let hex = key.toString(16).padStart(2, '0');
      for (const ch of plain) hex += (ch.charCodeAt(0) ^ key).toString(16).padStart(2, '0');

      assert.strictEqual(decodeCloudflare(hex), plain, 'decoder is wrong');

      const html = `<a href="/cdn-cgi/l/email-protection#${hex}">[email&#160;protected]</a>`;
      assert.ok(emailsOf(html, 'baxterheating.com').includes(plain),
        'a Cloudflare-protected site would have looked like it has no email at all');
    });

    test('garbage in gives nothing out, not a crash', () => {
      assert.strictEqual(decodeCloudflare('zzzz'), null);
      assert.strictEqual(decodeCloudflare('2a4'), null);
      assert.deepStrictEqual(extractEmails('', 'x.com'), []);
      assert.deepStrictEqual(extractEmails('<p>no emails here</p>', 'x.com'), []);
    });
  }

  console.log('\nwhat it refuses to write to');
  {
    const html = `
      <a href="mailto:office@baxterheating.com">Us</a>
      <a href="mailto:hello@somewebshop.com">Site by Some Web Shop</a>
      <a href="mailto:noreply@baxterheating.com">noreply</a>
      <a href="mailto:webmaster@baxterheating.com">webmaster</a>
      <a href="mailto:support@wixsite.com">platform</a>
      <img src="logo@2x.png">
    `;
    const got = emailsOf(html, 'baxterheating.com');

    test("the web designer's address is rejected", () => {
      assert.ok(!got.includes('hello@somewebshop.com'),
        'would have emailed the web designer instead of the prospect');
    });
    test('noreply and webmaster are rejected', () => {
      assert.ok(!got.some(e => /^(noreply|webmaster)@/.test(e)));
    });
    test('platform and third-party domains are rejected', () => {
      assert.ok(!got.some(e => /wixsite\.com$/.test(e)));
    });
    test('the real address survives all of that', () => {
      assert.deepStrictEqual(got, ['office@baxterheating.com']);
    });
    test('asset filenames are not mistaken for addresses', () => {
      assert.ok(!got.some(e => /\.png$/.test(e)));
    });
  }

  console.log('\nranking');
  {
    test('an owner address outranks a general inbox', () => {
      const html = `
        <a href="mailto:info@baxterheating.com">info</a>
        <a href="mailto:owner@baxterheating.com">owner</a>`;
      assert.strictEqual(extractEmails(html, 'baxterheating.com')[0].email,
        'owner@baxterheating.com');
    });

    test('back-office addresses rank last', () => {
      const html = `
        <a href="mailto:accounts@baxterheating.com">billing</a>
        <a href="mailto:info@baxterheating.com">info</a>`;
      const ranked = extractEmails(html, 'baxterheating.com');
      assert.strictEqual(ranked[0].email, 'info@baxterheating.com',
        'would have pitched the accounts payable inbox');
      assert.ok(ranked[ranked.length - 1].email.startsWith('accounts@'));
    });

    test('their own domain outranks a free provider', () => {
      const html = `
        <a href="mailto:baxterheating@gmail.com">gmail</a>
        <a href="mailto:office@baxterheating.com">domain</a>`;
      assert.strictEqual(extractEmails(html, 'baxterheating.com')[0].email,
        'office@baxterheating.com');
    });

    test('a free-provider address is still kept — local trades really use them', () => {
      const html = '<a href="mailto:baxterheatingair@gmail.com">Email</a>';
      const ranked = extractEmails(html, 'baxterheating.com');
      assert.strictEqual(ranked.length, 1);
      assert.strictEqual(ranked[0].freeProvider, true);
      assert.strictEqual(ranked[0].sameDomain, false);
    });

    test('every candidate explains itself and admits it is unverified', () => {
      const ranked = extractEmails('<a href="mailto:office@baxterheating.com">x</a>', 'baxterheating.com');
      const c = ranked[0];
      assert.ok(c.why && c.why.length > 3, 'no explanation of why this address');
      assert.ok(c.sources.length > 0, 'no source recorded');
      assert.strictEqual(c.verified, null,
        'verified must be null — "not checked" is not the same as "checked and fine"');
      assert.ok(c.score > 0 && c.score <= 100);
    });

    test('subdomains count as the same company', () => {
      assert.ok(relatedDomain('mail.baxterheating.com', 'baxterheating.com'));
      assert.ok(relatedDomain('www.baxterheating.com', 'baxterheating.com'));
      assert.ok(!relatedDomain('baxterheating.com.evil.com', 'baxterheating.com'));
    });
  }

  console.log('\npicking one');
  {
    test('picks the top candidate above the bar', () => {
      const ranked = extractEmails('<a href="mailto:office@x.com">x</a>', 'x.com');
      assert.strictEqual(pickBest(ranked).email, 'office@x.com');
    });

    test('returns null rather than guessing when nothing clears the bar', () => {
      assert.strictEqual(pickBest([]), null);
      assert.strictEqual(pickBest([{ email: 'a@b.com', score: 10 }]), null);
    });
  }

  console.log('\nagainst the real fixture');
  {
    const fs = require('fs'), path = require('path');
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'fixtures', 'neglected-hvac.html'), 'utf8');
    const ranked = extractEmails(html, 'baxterheatingair.com');

    test('picks the office address off a real page', () => {
      assert.strictEqual(pickBest(ranked).email, 'office@baxterheatingair.com');
    });
    test('the obfuscated billing address is found but ranked below it', () => {
      const accounts = ranked.find(c => c.email.startsWith('accounts@'));
      assert.ok(accounts, 'obfuscated address was missed entirely');
      assert.ok(accounts.score < ranked[0].score);
    });
    test("the site builder's address never makes the list", () => {
      assert.ok(!ranked.some(c => /somewebshop\.com$/.test(c.email)));
    });
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
