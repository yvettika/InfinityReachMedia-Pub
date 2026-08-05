'use strict';

/**
 * The row model — and, since the sheet is the state store, the schema for
 * everything this system remembers between runs.
 *
 * There is no local database. A run reads the sheet, works out what is new and
 * what has gone stale, does the work, and writes the sheet back. That is what
 * lets it run on a stateless cloud box: the state travels with the data.
 *
 * Column semantics:
 *   humanOwned  belongs to whoever is working the list. Read, carried forward,
 *               never overwritten. A daily job that reset "Booked" to "Not
 *               contacted" would be worse than no automation.
 *   preserve    written once, then left alone (First Seen).
 *   state       machine-owned bookkeeping that replaces the old JSON files.
 *
 * Merging is by header NAME, not column position, so columns you add or
 * reorder in the sheet survive a sync untouched.
 */

const COLUMNS = [
  { key: 'domain',      header: 'Domain',          from: p => p.domain },
  { key: 'name',        header: 'Business',        from: p => p.name },
  { key: 'niche',       header: 'Niche',           from: p => p.niche },
  { key: 'city',        header: 'City',            from: p => p.city || '' },
  { key: 'phone',       header: 'Phone',           from: p => p.phone || '' },
  { key: 'website',     header: 'Website',         from: p => p.website || `https://${p.domain}` },
  { key: 'score',       header: 'Score',           from: p => (p.score ?? '') },
  { key: 'band',        header: 'Band',            from: p => p.band || '' },
  { key: 'recoverable', header: 'Recoverable/yr',  from: p => p.recoverableAnnual != null ? `$${Math.round(p.recoverableAnnual).toLocaleString('en-US')}` : '' },
  { key: 'topLeak',     header: 'Top Leak',        from: p => p.topLeak || '' },
  { key: 'leadAgent',   header: 'Lead Agent',      from: p => p.leadAgent || '' },
  { key: 'reviews',     header: 'Reviews',         from: p => (p.reviewCount ?? '') },
  { key: 'rating',      header: 'Rating',          from: p => (p.rating ?? '') },
  { key: 'status',      header: 'Status',          from: () => 'Not contacted', humanOwned: true },
  { key: 'notes',       header: 'Owner Notes',     from: () => '',              humanOwned: true },
  { key: 'firstSeen',   header: 'First Seen',      from: p => p.firstSeen || today(), preserve: true },
  { key: 'lastUpdated', header: 'Last Updated',    from: () => today() },
  // Human-owned: the sync writes "drafted" once, then a person moves it to
  // approved / sent / replied. Approval is the one step that is not automated.
  { key: 'outreach',    header: 'Outreach',        from: p => p.outreachBody ? 'drafted' : '', humanOwned: true },

  // --- state columns: the replacement for prospects/*.json ----------------
  // Place IDs are the one Places field storable indefinitely under their
  // terms, which is exactly why discovery dedupe is keyed on them.
  { key: 'placeId',     header: 'Place ID',        from: p => p.placeId || '', state: true },
  { key: 'researched',  header: 'Researched',      from: p => p.researchedAt || '', state: true },
  { key: 'syncState',   header: 'Sync State',      from: p => p.syncState || '', state: true },
];

const BY_KEY = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
const HEADER = COLUMNS.map(c => c.header);
const KEY_HEADER = 'Domain';

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fold a discovery candidate and its research analysis into one prospect.
 * Either half may be missing: discovery can run without research, and research
 * can run on a domain that never came from discovery.
 */
function toProspect(candidate = {}, analysis = null) {
  const p = {
    domain: candidate.domain,
    name: candidate.name || candidate.domain,
    niche: candidate.niche || '',
    industry: candidate.industry || 'default',
    city: candidate.city || candidate.area || '',
    address: candidate.address || '',
    phone: candidate.phone || '',
    website: candidate.website || '',
    reviewCount: candidate.reviewCount ?? null,
    rating: candidate.rating ?? null,
    placeId: candidate.placeId || '',
    firstSeen: candidate.firstSeen || null,
    researchedAt: candidate.researchedAt || null,
    syncState: candidate.syncState || '',
    outreachSubject: candidate.outreachSubject || null,
    outreachBody: candidate.outreachBody || null,
    outreachEvidence: candidate.outreachEvidence || null,
    score: null, band: null, recoverableAnnual: null, topLeak: null, leadAgent: null,
    // Populated once contact discovery exists; the CRM push falls back to
    // phone as the identifier until then.
    email: candidate.email || null,
  };

  if (analysis) {
    p.score = analysis.pct ?? null;
    p.band = analysis.band ?? null;
    p.recoverableAnnual = analysis.leaks?.annualRecover ?? null;
    p.topLeak = analysis.leaks?.items?.find(i => i.monthly > 0)?.label || null;
    p.leadAgent = analysis.agents?.[0]?.agent || null;
  }
  return p;
}

/** Header row → { headerName: index }, tolerant of blanks and stray spaces. */
function headerIndex(header) {
  const idx = {};
  header.forEach((h, i) => {
    const name = String(h || '').trim();
    if (name && !(name in idx)) idx[name] = i;
  });
  return idx;
}

/** Sheet row → prospect, for reading state back out. */
function fromRow(row, idx) {
  const get = h => {
    const i = idx[h];
    return i === undefined ? '' : (row[i] ?? '');
  };
  const num = h => {
    const v = String(get(h)).replace(/[$,]/g, '').trim();
    return v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  };

  return {
    domain: String(get('Domain')).trim().toLowerCase(),
    name: get('Business') || undefined,
    niche: get('Niche') || '',
    city: get('City') || '',
    phone: get('Phone') || '',
    website: get('Website') || '',
    score: num('Score'),
    band: get('Band') || null,
    recoverableAnnual: num('Recoverable/yr'),
    topLeak: get('Top Leak') || null,
    leadAgent: get('Lead Agent') || null,
    reviewCount: num('Reviews'),
    rating: num('Rating'),
    status: get('Status') || '',
    firstSeen: get('First Seen') || null,
    placeId: get('Place ID') || '',
    researchedAt: get('Researched') || null,
    syncState: get('Sync State') || '',
    outreach: get('Outreach') || '',
  };
}

/**
 * Merge prospects into the existing sheet grid.
 *
 * Returns the full value grid plus counts. Any column the sheet has that we do
 * not know about is carried through untouched, and any column we know about
 * that the sheet lacks is appended to the header.
 */
function mergeRows(existingValues, prospects) {
  const hasHeader = existingValues.length > 0 && existingValues[0].some(c => String(c || '').trim());
  const existingHeader = hasHeader ? existingValues[0].map(h => String(h || '').trim()) : [];

  // Preserve the sheet's own column order, then append anything missing.
  const header = [...existingHeader];
  for (const h of HEADER) if (!header.includes(h)) header.push(h);
  const idx = headerIndex(header);

  const rows = (hasHeader ? existingValues.slice(1) : existingValues)
    .filter(r => r && r.some(c => String(c ?? '').trim() !== ''))
    .map(r => {
      const padded = header.map((_, i) => r[i] ?? '');
      return padded;
    });

  const byDomain = new Map();
  rows.forEach((row, i) => {
    const d = String(row[idx[KEY_HEADER]] ?? '').trim().toLowerCase();
    if (d) byDomain.set(d, i);
  });

  let added = 0, updated = 0;
  const volatile = new Set([idx['Last Updated']]);

  for (const p of prospects) {
    if (!p.domain) continue;
    const key = String(p.domain).trim().toLowerCase();
    const at = byDomain.get(key);
    const existing = at === undefined ? null : rows[at];

    const next = header.map((h, i) => {
      const col = COLUMNS.find(c => c.header === h);
      if (!col) return existing ? existing[i] : '';        // a column we don't own
      const current = existing ? existing[i] : undefined;
      if (existing) {
        if (col.humanOwned) return current !== undefined && current !== '' ? current : col.from(p);
        if (col.preserve && current) return current;
      }
      const value = col.from(p);
      // Never blank out a known value with an empty one — a failed research
      // pass should leave yesterday's score in place, not erase it.
      if ((value === '' || value === null) && existing && current) return current;
      return value;
    });

    if (existing === null) {
      rows.push(next);
      byDomain.set(key, rows.length - 1);
      added++;
    } else {
      const strip = r => r.filter((_, i) => !volatile.has(i));
      if (JSON.stringify(strip(next)) !== JSON.stringify(strip(existing))) updated++;
      rows[at] = next;
    }
  }

  return { header, values: [header, ...rows], added, updated, total: rows.length };
}

module.exports = {
  COLUMNS, BY_KEY, HEADER, KEY_HEADER,
  toProspect, fromRow, headerIndex, mergeRows, today,
};
