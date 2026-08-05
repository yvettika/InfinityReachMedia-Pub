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
 * The intel columns, mirrored onto the GHL contact as custom fields — so the
 * spreadsheet's key numbers are visible on the record a rep has open while
 * dialling, not in a separate tab.
 *
 * Fields are created via the API on first use (the location starts with
 * none). The name is the identity: renaming one in the GHL UI orphans it and
 * the sync will create a fresh one with the old name.
 */
const CUSTOM_FIELDS = [
  { name: 'Leak Score', dataType: 'NUMERICAL', value: p => p.score },
  { name: 'Leak Band', dataType: 'TEXT', value: p => p.band },
  { name: 'Recoverable Revenue (est/yr)', dataType: 'NUMERICAL', value: p => p.recoverableAnnual != null ? Math.round(p.recoverableAnnual) : null },
  { name: 'Top Leak', dataType: 'TEXT', value: p => p.topLeak },
  { name: 'Lead Agent', dataType: 'TEXT', value: p => p.leadAgent },
  { name: 'Prospect Niche', dataType: 'TEXT', value: p => p.niche },

  // The outreach draft lives on the contact so a GHL workflow can send it with
  // a merge tag. One template that renders {{contact.outreach_body}} beats a
  // template per prospect, and it means a human can read and edit the exact
  // words in the CRM before anything goes out.
  { name: 'Outreach Subject', dataType: 'TEXT', value: p => p.outreachSubject },
  { name: 'Outreach Body', dataType: 'LARGE_TEXT', value: p => p.outreachBody },
  { name: 'Outreach Evidence', dataType: 'LARGE_TEXT', value: p => p.outreachEvidence },
];

/**
 * Make sure the custom fields exist, returning { name → id }.
 * Cached on `opts` by the caller loop, same as pipeline resolution — a
 * 200-prospect run does this once.
 */
async function ensureCustomFields(opts = {}) {
  const { apiKey, locationId } = requireConfig(opts);

  const res = await call(`/locations/${locationId}/customFields`, {
    apiKey, query: { model: 'contact' },
  });
  const existing = new Map(
    (res?.customFields || []).map(f => [String(f.name || '').trim().toLowerCase(), f.id])
  );

  const map = {};
  for (const spec of CUSTOM_FIELDS) {
    const key = spec.name.toLowerCase();
    if (existing.has(key)) {
      map[spec.name] = existing.get(key);
      continue;
    }
    const created = await call(`/locations/${locationId}/customFields`, {
      apiKey,
      method: 'POST',
      body: { name: spec.name, dataType: spec.dataType, model: 'contact' },
    });
    map[spec.name] = (created?.customField || created)?.id;
  }
  return map;
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
      // The workflow trigger. `outreach-draft` means a draft exists and is
      // waiting for a human; `outreach-ready` is applied by a person after
      // approving, and that is the tag the sending workflow listens for.
      // The sync never applies `outreach-ready` — approval is not automatable.
      ...(prospect.outreachBody ? ['outreach-draft'] : []),
    ],
  };
  if (prospect.email) body.email = prospect.email;
  if (prospect.phone) body.phone = prospect.phone;
  if (prospect.city) body.city = prospect.city;
  if (prospect.address) body.address1 = prospect.address;

  if (opts.fieldMap) {
    body.customFields = CUSTOM_FIELDS
      .map(spec => {
        const id = opts.fieldMap[spec.name];
        const value = spec.value(prospect);
        if (!id || value === null || value === undefined || value === '') return null;
        // GHL's docs have shown both `field_value` and `value` for this
        // payload across versions; sending both is harmless (unknown props
        // are ignored) and works against either.
        return { id, field_value: String(value), value: String(value) };
      })
      .filter(Boolean);
  }

  const res = await call('/contacts/upsert', { apiKey, method: 'POST', body });
  const contact = res?.contact || res;
  return {
    id: contact?.id,
    isNew: res?.new ?? null,
    raw: contact,
  };
}

/**
 * Resolve a pipeline and stage by NAME.
 *
 * GoHighLevel has no API for creating a pipeline — not in the connector and
 * not in their public v2 REST API. Pipelines are made in the UI. So rather
 * than making someone copy two opaque IDs out of a URL bar and into env vars,
 * this looks them up by the names you can read on screen. Create the pipeline,
 * set the names, and the sync finds it on the next run.
 *
 * Explicit GHL_PIPELINE_ID / GHL_STAGE_ID still win if they are set.
 */
async function resolvePipeline(opts = {}) {
  const { apiKey, locationId } = requireConfig(opts);

  const explicitPipeline = opts.pipelineId || process.env.GHL_PIPELINE_ID;
  const explicitStage = opts.stageId || process.env.GHL_STAGE_ID;
  if (explicitPipeline && explicitStage) {
    return { pipelineId: explicitPipeline, stageId: explicitStage, resolvedBy: 'id' };
  }

  const wantPipeline = opts.pipelineName || process.env.GHL_PIPELINE_NAME;
  const wantStage = opts.stageName || process.env.GHL_STAGE_NAME || 'New Lead';
  if (!wantPipeline) {
    throw new Error('Set GHL_PIPELINE_NAME (or GHL_PIPELINE_ID and GHL_STAGE_ID)');
  }

  const res = await call('/opportunities/pipelines', { apiKey, query: { locationId } });
  const pipelines = res?.pipelines || [];
  const norm = s => String(s || '').trim().toLowerCase();

  const pipeline = pipelines.find(p => norm(p.name) === norm(wantPipeline));
  if (!pipeline) {
    throw new Error(
      `No GHL pipeline named "${wantPipeline}". Found: ${pipelines.map(p => p.name).join(', ') || 'none'}. ` +
      `Pipelines can only be created in the GHL UI.`
    );
  }

  const stage = (pipeline.stages || []).find(s => norm(s.name) === norm(wantStage));
  if (!stage) {
    throw new Error(
      `Pipeline "${pipeline.name}" has no stage named "${wantStage}". ` +
      `Stages: ${(pipeline.stages || []).map(s => s.name).join(', ') || 'none'}`
    );
  }

  return { pipelineId: pipeline.id, stageId: stage.id, resolvedBy: 'name', pipelineName: pipeline.name, stageName: stage.name };
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
  // Resolution is cached on opts by the caller loop so a 200-prospect run
  // resolves names once, not 200 times.
  if (!opts._resolved) opts._resolved = await resolvePipeline(opts);
  const { pipelineId, stageId } = opts._resolved;

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
  // Resolve (and if needed create) the intel custom fields once per run.
  if (!opts.fieldMap && !opts.skipCustomFields) {
    try {
      opts.fieldMap = await ensureCustomFields(opts);
    } catch (err) {
      // Fields are enrichment, not identity — a location that refuses field
      // creation still gets the contact, the tags and the opportunity.
      opts.skipCustomFields = true;
      opts.fieldMapError = err.message;
    }
  }

  const contact = await upsertContact(prospect, opts);
  if (!contact.id) throw new Error(`No contact id returned for ${prospect.domain}`);

  let opportunity = { id: null, created: false, skipped: true };
  if (!opts.contactsOnly) {
    opportunity = { ...(await ensureOpportunity(contact.id, prospect, opts)), skipped: false };
  }
  return { domain: prospect.domain, contact, opportunity };
}

module.exports = {
  upsertContact, ensureOpportunity, findOpportunity, syncProspect,
  resolvePipeline, ensureCustomFields, requireConfig, CUSTOM_FIELDS,
};
