'use strict';

/**
 * Bridge to Jarvis — the deployed lead-generation-agent.
 *
 * Decision (2026-08-05): Jarvis owns ALL outbound. It has the live delivery
 * stack — Resend sender on the warmed subdomain, approval links in Slack,
 * reply classification, a global suppression list. This repo is the
 * intelligence layer: it researches the businesses Jarvis found and hands the
 * findings over, so Jarvis's drafts open with verified facts instead of
 * scraped guesses.
 *
 * The integration surface is Jarvis's own Supabase, on a contract its code
 * already honours:
 *
 *   - `prospects.signals` is a JSONB column whose contents are passed verbatim
 *     into the draft prompt as "facts to reference, not instructions", with an
 *     explicit rule against inventing anything beyond them. We write our
 *     research under `signals.intel` — one namespaced key, so nothing Jarvis
 *     or its sourcing wrote is ever touched.
 *   - `outbound_suppression` is checked by Jarvis before every send. We read
 *     it (and the prospect list) so the discovery pipeline here never creates
 *     a duplicate path to a business Jarvis already owns.
 *
 * Requires the same Supabase project Jarvis uses:
 *   JARVIS_SUPABASE_URL   (falls back to SUPABASE_URL)
 *   JARVIS_SUPABASE_KEY   (falls back to SUPABASE_SERVICE_ROLE_KEY)
 *
 * The service-role key is powerful; it stays in env/secrets like every other
 * credential here and is never logged.
 */

const TENANT = () => process.env.JARVIS_TENANT || 'infinity-reach-media';

function config(opts = {}) {
  const url = opts.url || process.env.JARVIS_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = opts.key || process.env.JARVIS_SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

function configured(opts) {
  return config(opts) !== null;
}

async function rest(path, { method = 'GET', body, headers = {}, opts = {} } = {}) {
  const cfg = config(opts);
  if (!cfg) throw new Error('Jarvis bridge is not configured — set JARVIS_SUPABASE_URL and JARVIS_SUPABASE_KEY');

  const res = await fetch(`${cfg.url}/rest/v1${path}`, {
    method,
    headers: {
      apikey: cfg.key,
      authorization: `Bearer ${cfg.key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jarvis Supabase ${method} ${path.split('?')[0]} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
}

const normDomain = url => {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
};

/** Prospects that could use research: have a website, not suppressed-dead. */
async function listProspects({ statuses = ['new', 'queued'], limit = 200, opts } = {}) {
  const statusFilter = statuses.length ? `&status=in.(${statuses.map(encodeURIComponent).join(',')})` : '';
  const rows = await rest(
    `/prospects?tenant_slug=eq.${encodeURIComponent(TENANT())}${statusFilter}` +
    `&select=id,business_name,email,phone,website,city,category,signals,icp_score,status` +
    `&order=icp_score.desc.nullslast&limit=${limit}`,
    { opts }
  );
  return rows || [];
}

/**
 * Attach research to one prospect.
 *
 * Read-merge-write on `signals`, everything under the `intel` key. A concurrent
 * sourcing update that adds other signal keys can race this write; last writer
 * wins on the column, which is acceptable because we re-merge from a fresh read
 * and our key is namespaced — the worst case is re-running the enrich.
 *
 * The email is filled ONLY when Jarvis has none: theirs may have come from a
 * human edit, and stomping a human's correction with a crawler's guess is the
 * wrong trade.
 */
async function attachIntel(prospect, intel, { email = null, opts } = {}) {
  const fresh = await rest(`/prospects?id=eq.${encodeURIComponent(prospect.id)}&select=signals,email`, { opts });
  const current = (fresh && fresh[0]) || {};
  const signals = { ...(current.signals || {}), intel };

  const patch = { signals };
  if (email && !current.email) patch.email = email;

  await rest(`/prospects?id=eq.${encodeURIComponent(prospect.id)}`, {
    method: 'PATCH',
    body: patch,
    headers: { prefer: 'return=minimal' },
    opts,
  });
  return { emailFilled: !!(email && !current.email) };
}

/** Every domain Jarvis already has a prospect for — any status, any tenant. */
async function knownDomains({ opts } = {}) {
  const rows = await rest(`/prospects?select=website&limit=10000`, { opts });
  const out = new Set();
  for (const r of rows || []) {
    const d = normDomain(r.website);
    if (d) out.add(d);
  }
  return out;
}

/** The global do-not-contact list, as a lowercase Set. */
async function suppressedEmails({ opts } = {}) {
  const rows = await rest(`/outbound_suppression?select=email&limit=10000`, { opts });
  return new Set((rows || []).map(r => String(r.email || '').toLowerCase()).filter(Boolean));
}

/**
 * Split discovery candidates into ours vs Jarvis's.
 * Pure function so the dedupe rule is testable without a network.
 */
function dedupeAgainstJarvis(candidates, jarvisDomains) {
  const mine = [], theirs = [];
  for (const c of candidates) {
    (jarvisDomains.has(String(c.domain || '').toLowerCase()) ? theirs : mine).push(c);
  }
  return { mine, theirs };
}

module.exports = {
  configured, listProspects, attachIntel, knownDomains, suppressedEmails,
  dedupeAgainstJarvis, normDomain, TENANT,
};
