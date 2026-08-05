'use strict';

/**
 * GoHighLevel client — contacts and opportunities.
 *
 * Uses the REST API rather than the MCP connector for one specific reason:
 * the connector exposes no create-opportunity capability, only update, which
 * needs an opportunity that already exists. Putting a prospect "under New
 * Leads" means creating one. The REST API can; the connector cannot.
 *
 *   export GHL_API_KEY=...          Private Integration token
 *   export GHL_LOCATION_ID=rvvmN3bJOUZYfpydfLy8
 *
 * Create the token in GHL under Settings → Private Integrations with scopes:
 * contacts.readonly, contacts.write, opportunities.readonly,
 * opportunities.write.
 *
 * Everything here is idempotent on the prospect's domain. A daily sync must be
 * safe to run twice in a row — this is a live CRM, and duplicate contacts are
 * far more annoying to clean up than a missed row.
 */

const API = () => process.env.GHL_ENDPOINT || 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

function requireConfig(opts = {}) {
  const apiKey = opts.apiKey || process.env.GHL_API_KEY;
  const locationId = opts.locationId || process.env.GHL_LOCATION_ID;
  if (!apiKey) throw new Error('GHL_API_KEY is not set');
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');
  return { apiKey, locationId };
}

async function call(path, { apiKey, method = 'GET', body, query } = {}) {
  const url = new URL(API() + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      version: VERSION,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    throw new Error(`GHL ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

/**
 * Create or update a contact, keyed on email when we have one and on the
 * business phone otherwise. GHL's own upsert handles the dedupe; we pass
 * whatever identifier we actually hold.
 */
async function upsertContact(prospect, opts = {}) {
  const { apiKey, locationId } = requireConfig(opts);

  const body = {
    locationId,
    name: prospect.name,
    companyName: prospect.name,
    website: prospect.website || `https://${prospect.domain}`,
    source: 'Prospect Intel (outbound)',
    tags: [
      'outbound-prospect',
      `niche-${prospect.niche}`,
      `leak-band-${String(prospect.band || 'unknown').toLowerCase().replace(/\s+/g, '-')}`,
    ],
  };
  if (prospect.email) body.email = prospect.email;
  if (prospect.phone) body.phone = prospect.phone;
  if (prospect.city) body.city = prospect.city;
  if (prospect.address) body.address1 = prospect.address;

  const res = await call('/contacts/upsert', { apiKey, method: 'POST', body });
  const contact = res?.contact || res;
  return {
    id: contact?.id,
    isNew: res?.new ?? null,
    raw: contact,
  };
}

/** Find an existing opportunity for this contact so a re-run doesn't duplicate it. */
async function findOpportunity(contactId, opts = {}) {
  const { apiKey, locationId } = requireConfig(opts);
  const res = await call('/opportunities/search', {
    apiKey,
    query: { location_id: locationId, contact_id: contactId, limit: 20 },
  });
  const list = res?.opportunities || [];
  return list[0] || null;
}

/**
 * Put the prospect in a pipeline stage — "New Lead" by default.
 * Returns { id, created:boolean }.
 */
async function ensureOpportunity(contactId, prospect, opts = {}) {
  const { apiKey, locationId } = requireConfig(opts);
  const pipelineId = opts.pipelineId || process.env.GHL_PIPELINE_ID;
  const stageId = opts.stageId || process.env.GHL_STAGE_ID;
  if (!pipelineId || !stageId) {
    throw new Error('GHL_PIPELINE_ID and GHL_STAGE_ID must be set to create opportunities');
  }

  const existing = await findOpportunity(contactId, opts);
  if (existing) return { id: existing.id, created: false };

  const res = await call('/opportunities/', {
    apiKey,
    method: 'POST',
    body: {
      pipelineId,
      locationId,
      contactId,
      pipelineStageId: stageId,
      name: prospect.name,
      status: 'open',
      // The estimated recoverable revenue is the honest value of the deal to
      // *them*, not our fee. It is the number the whole call is built around,
      // so it belongs on the opportunity where a rep will see it.
      monetaryValue: Math.round(prospect.recoverableAnnual || 0),
    },
  });
  return { id: (res?.opportunity || res)?.id, created: true };
}

/** Push one prospect all the way into the CRM. */
async function syncProspect(prospect, opts = {}) {
  const contact = await upsertContact(prospect, opts);
  if (!contact.id) throw new Error(`No contact id returned for ${prospect.domain}`);

  let opportunity = { id: null, created: false, skipped: true };
  if (!opts.contactsOnly) {
    opportunity = { ...(await ensureOpportunity(contact.id, prospect, opts)), skipped: false };
  }
  return { domain: prospect.domain, contact, opportunity };
}

module.exports = { upsertContact, ensureOpportunity, findOpportunity, syncProspect, requireConfig };
