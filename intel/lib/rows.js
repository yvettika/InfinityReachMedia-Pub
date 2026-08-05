'use strict';

/**
 * The shared row shape.
 *
 * One definition drives the spreadsheet header, the sheet writer and the CRM
 * push, so the three cannot drift apart.
 *
 * `humanOwned` columns are the important part. Status and Owner Notes belong to
 * whoever is working the list — the sync reads them, carries them forward, and
 * never writes over them. A daily job that silently resets "Booked" back to
 * "Not contacted" would be worse than no automation at all, so the rule is
 * enforced here rather than left to the caller to remember.
 */

const COLUMNS = [
  { key: 'domain',      header: 'Domain',          from: p => p.domain },
  { key: 'name',        header: 'Business',        from: p => p.name },
  { key: 'niche',       header: 'Niche',           from: p => p.niche },
  { key: 'city',        header: 'City',            from: p => p.city || p.area || '' },
  { key: 'phone',       header: 'Phone',           from: p => p.phone || '' },
  { key: 'website',     header: 'Website',         from: p => p.website || `https://${p.domain}` },
  { key: 'score',       header: 'Score',           from: p => (p.score ?? '') },
  { key: 'band',        header: 'Band',            from: p => p.band || '' },
  { key: 'recoverable', header: 'Recoverable/yr',  from: p => p.recoverableAnnual != null ? `$${Math.round(p.recoverableAnnual).toLocaleString('en-US')}` : '' },
  { key: 'topLeak',     header: 'Top Leak',        from: p => p.topLeak || '' },
  { key: 'leadAgent',   header: 'Lead Agent',      from: p => p.leadAgent || '' },
  { key: 'reviews',     header: 'Reviews',         from: p => (p.reviewCount ?? '') },
  { key: 'rating',      header: 'Rating',          from: p => (p.rating ?? '') },
  { key: 'status',      header: 'Status',          from: p => 'Not contacted', humanOwned: true },
  { key: 'notes',       header: 'Owner Notes',     from: () => '',              humanOwned: true },
  { key: 'firstSeen',   header: 'First Seen',      from: p => p.firstSeen || today(), preserve: true },
  { key: 'lastUpdated', header: 'Last Updated',    from: () => today() },
];

const HEADER = COLUMNS.map(c => c.header);
const KEY_COLUMN = 0; // Domain — the identity of a row

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fold a discovery candidate and its research analysis into one flat prospect.
 * Either half may be missing: discovery can run without research, and research
 * can run on a domain that never came from discovery.
 */
function toProspect(candidate = {}, analysis = null) {
  const leadAgent = analysis?.agents?.[0]?.agent || null;
  const topLeak = analysis?.leaks?.items?.find(i => i.monthly > 0)?.label || null;

  return {
    domain: candidate.domain,
    name: candidate.name || candidate.domain,
    niche: candidate.niche || '',
    industry: candidate.industry || 'default',
    city: candidate.area || '',
    address: candidate.address || '',
    phone: candidate.phone || '',
    website: candidate.website || '',
    reviewCount: candidate.reviewCount ?? null,
    rating: candidate.rating ?? null,
    score: analysis?.pct ?? null,
    band: analysis?.band ?? null,
    recoverableAnnual: analysis?.leaks?.annualRecover ?? null,
    topLeak,
    leadAgent,
    // Only populated once contact discovery exists; the CRM push uses it when
    // present and falls back to phone as the identifier when it doesn't.
    email: candidate.email || null,
  };
}

function toRow(prospect, existingRow = null) {
  return COLUMNS.map((col, i) => {
    if (existingRow) {
      const current = existingRow[i];
      // Human-owned columns are never overwritten, only initialised.
      if (col.humanOwned) return current !== undefined && current !== '' ? current : col.from(prospect);
      // First Seen records when we first met them, so it survives every update.
      if (col.preserve && current) return current;
    }
    return col.from(prospect);
  });
}

/**
 * Merge prospects into whatever the sheet already holds.
 * Returns the full value grid (header + rows) plus a count of what changed.
 */
function mergeRows(existingValues, prospects) {
  const rows = existingValues.length ? existingValues.slice(1) : [];
  const index = new Map();
  rows.forEach((row, i) => {
    const domain = (row[KEY_COLUMN] || '').trim().toLowerCase();
    if (domain) index.set(domain, i);
  });

  let added = 0, updated = 0;
  for (const p of prospects) {
    if (!p.domain) continue;
    const key = p.domain.toLowerCase();
    const at = index.get(key);
    if (at === undefined) {
      rows.push(toRow(p));
      index.set(key, rows.length - 1);
      added++;
    } else {
      const before = JSON.stringify(rows[at]);
      const merged = toRow(p, rows[at]);
      // "Last Updated" changes on every run, so compare everything else —
      // otherwise every row looks modified every day and the count is useless.
      const lastIdx = COLUMNS.findIndex(c => c.key === 'lastUpdated');
      const strip = r => r.filter((_, i) => i !== lastIdx);
      if (JSON.stringify(strip(merged)) !== JSON.stringify(strip(JSON.parse(before)))) updated++;
      rows[at] = merged;
    }
  }

  return { values: [HEADER, ...rows], added, updated, total: rows.length };
}

module.exports = { COLUMNS, HEADER, KEY_COLUMN, toProspect, toRow, mergeRows, today };
