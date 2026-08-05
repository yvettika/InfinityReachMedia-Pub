'use strict';

/**
 * Contact discovery — finding an inbox on the company's own website.
 *
 * Everything here reads pages the business publishes publicly and puts an
 * address on. No paid database, no scraping of gated networks. For a
 * twelve-truck contractor the address on their own contact page usually
 * reaches the same person a purchased record would, and it is a fact rather
 * than a vendor's guess.
 *
 * Three things this handles that a naive regex does not:
 *
 *   1. Cloudflare email protection. Small-business sites sit behind Cloudflare
 *      constantly, and it rewrites addresses to `/cdn-cgi/l/email-protection#<hex>`.
 *      The obfuscation is a single-byte XOR — trivially reversible, and without
 *      it those sites look like they have no email at all.
 *   2. Human obfuscation — "info [at] example [dot] com" and its cousins.
 *   3. Other people's addresses. A page can easily carry the web designer's
 *      email, a stock-photo licence contact, or a schema.org URL. An address
 *      that isn't theirs is worse than none, so third parties are rejected and
 *      same-domain addresses always outrank everything else.
 *
 * What this deliberately does NOT do: guess a decision-maker's first name.
 * A wrong "Hi Mike," to a business run by Steve is precisely the failure this
 * whole system is built to avoid — it proves in one word that nobody looked.
 * The composer greets without a name until a name can be verified.
 */

/** Never write to these. */
const REJECT_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|abuse|privacy|webmaster|hostmaster|dmarc|spam|bounce|mailer-daemon|unsubscribe)$/i;

/** Addresses that belong to somebody else's business, not the prospect's. */
const THIRD_PARTY_DOMAINS = [
  /(^|\.)wix(site)?\.com$/i, /(^|\.)squarespace\.com$/i, /(^|\.)godaddy\.com$/i,
  /(^|\.)wordpress\.(com|org)$/i, /(^|\.)shopify\.com$/i, /(^|\.)webflow\.com$/i,
  /(^|\.)sentry\.io$/i, /(^|\.)schema\.org$/i, /(^|\.)example\.(com|org|net)$/i,
  /(^|\.)domain\.com$/i, /(^|\.)email\.com$/i, /(^|\.)yourdomain\./i,
  /(^|\.)sentry-next\./i, /(^|\.)cloudflare\.com$/i, /(^|\.)google\.com$/i,
  /(^|\.)facebook\.com$/i, /(^|\.)adobe\.com$/i, /(^|\.)jquery\.com$/i,
];

/**
 * Free providers. A local trade business legitimately runs on Gmail all the
 * time, so these are accepted — just ranked below an address on their own
 * domain, which is more certainly theirs.
 */
const FREE_PROVIDERS = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|sbcglobal|att|verizon|cox|charter|earthlink|protonmail|proton|gmx|mail)\./i;

/** Role prefixes worth having, best first. */
const ROLE_RANK = [
  { re: /^(owner|founder|president|principal)$/i, score: 95, label: 'owner-style role address' },
  { re: /^(office|frontdesk|front-desk|reception)$/i, score: 82, label: 'office address' },
  { re: /^(service|dispatch|scheduling|schedule|bookings?|appointments?)$/i, score: 78, label: 'service desk' },
  { re: /^(sales|newbusiness|estimates?|quotes?)$/i, score: 76, label: 'sales address' },
  { re: /^(contact|inquiries|enquiries|hello|hi)$/i, score: 70, label: 'general contact' },
  { re: /^(info|admin|team|mail|email|customerservice|support|help)$/i, score: 64, label: 'general inbox' },
  { re: /^(billing|accounts?|accounting|ap|ar|hr|careers?|jobs)$/i, score: 25, label: 'back-office — wrong department' },
];

/**
 * Decode Cloudflare's email protection.
 * First hex byte is the XOR key; the rest is the encoded address.
 */
function decodeCloudflare(hex) {
  if (!/^[0-9a-fA-F]{6,}$/.test(hex) || hex.length % 2) return null;
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Undo the common human obfuscations. */
function deobfuscate(text) {
  return text
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s*[\[({<]\s*(at|@)\s*[\])}>]\s*/gi, '@')
    .replace(/\s+(at)\s+/gi, '@')
    .replace(/\s*[\[({<]\s*dot\s*[\])}>]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

function emailDomain(email) {
  return String(email).split('@')[1]?.toLowerCase() || '';
}

function isThirdParty(domain) {
  return THIRD_PARTY_DOMAINS.some(re => re.test(domain));
}

/** Same registrable-ish domain: exact, or one is a subdomain of the other. */
function relatedDomain(a, b) {
  a = String(a || '').replace(/^www\./, '').toLowerCase();
  b = String(b || '').replace(/^www\./, '').toLowerCase();
  return !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a));
}

/**
 * Pull every plausible address out of a page and rank them.
 *
 * @param {string} html    combined page source
 * @param {string} domain  the prospect's domain, for the same-domain test
 * @returns {Array} ranked candidates, best first
 */
function extractEmails(html, domain) {
  const found = new Map(); // email → { sources:Set }

  const add = (raw, source) => {
    const email = String(raw).trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return;
    if (!found.has(email)) found.set(email, { sources: new Set() });
    found.get(email).sources.add(source);
  };

  // Cloudflare-protected addresses.
  for (const m of html.matchAll(/(?:data-cfemail=["']|email-protection#)([0-9a-fA-F]+)/g)) {
    const decoded = decodeCloudflare(m[1]);
    if (decoded) add(decoded, 'cloudflare-protected');
  }

  // mailto: links — the strongest signal, because it is a link they built.
  for (const m of html.matchAll(/mailto:([^"'\s>?]+)/gi)) add(m[1], 'mailto link');

  // Plain text, after undoing obfuscation.
  const plain = deobfuscate(html);
  for (const m of plain.matchAll(EMAIL_RE)) add(m[0], 'page text');

  const out = [];
  for (const [email, meta] of found) {
    const local = email.split('@')[0];
    const eDomain = emailDomain(email);

    if (REJECT_LOCAL.test(local)) continue;
    if (isThirdParty(eDomain)) continue;
    // An image or asset filename that happens to look like an address.
    if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(email)) continue;

    const sameDomain = relatedDomain(eDomain, domain);
    const free = FREE_PROVIDERS.test(eDomain + '.');

    // Neither theirs nor a free provider → almost certainly someone else's.
    if (!sameDomain && !free) continue;

    const role = ROLE_RANK.find(r => r.re.test(local));
    let score = role ? role.score : (sameDomain ? 60 : 40);
    let why = role ? role.label : 'address on their own domain';

    if (!sameDomain) {
      // Free-provider addresses are common and usable for local trades, but we
      // are less certain they belong to the business than a domain address.
      score -= 22;
      why = free ? 'free-provider address (common for local trades)' : why;
    }
    if (!role && sameDomain && !/^[a-z]+$/i.test(local)) {
      // Looks like a person: dave.baxter@, d.baxter@, dbaxter@
      score += 8;
      why = 'looks like a named person at the company';
    }
    if (meta.sources.has('mailto link')) score += 6;
    if (meta.sources.has('cloudflare-protected')) score += 4;

    out.push({
      email,
      score: Math.max(1, Math.min(100, score)),
      sameDomain,
      freeProvider: free,
      why,
      sources: [...meta.sources],
      // Deliverability is a separate paid step (ZeroBounce, NeverBounce…).
      // Null means "not checked", never "checked and fine".
      verified: null,
    });
  }

  return out.sort((a, b) => b.score - a.score || a.email.localeCompare(b.email));
}

/**
 * Choose the one address to write to.
 * Returns null rather than guessing when nothing clears the bar.
 */
function pickBest(candidates, { minScore = 40 } = {}) {
  const best = candidates.find(c => c.score >= minScore);
  return best || null;
}

module.exports = {
  extractEmails, pickBest, decodeCloudflare, deobfuscate,
  relatedDomain, isThirdParty, ROLE_RANK,
};
