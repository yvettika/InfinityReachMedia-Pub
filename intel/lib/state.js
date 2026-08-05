'use strict';

const fs = require('fs');
const path = require('path');
const sheets = require('./sheets');
const { fromRow, headerIndex, mergeRows, HEADER } = require('./rows');

/**
 * State store.
 *
 * The sheet IS the database. A run reads it, works out what is new and what has
 * gone stale, does the work, and writes it back — so nothing needs to persist
 * on the machine between runs and the job can live on an ephemeral cloud box.
 *
 * A local-file backend exists for working offline and for anyone who has not
 * set up a service account yet. Both expose the same interface, so `sync.js`
 * does not know or care which one it got.
 *
 * The sheet also happens to be the right home for this data on its own merits:
 * it is private, she already works out of it, and the state a human edits
 * (Status, Owner Notes) and the state the machine edits live in one place
 * instead of drifting apart in two.
 */

class SheetState {
  constructor({ sheetId, credentialsFile, range = 'A:ZZ' }) {
    this.sheetId = sheetId;
    this.credentialsFile = credentialsFile;
    this.range = range;
    this.label = `Google Sheet ${sheetId}`;
    this._token = null;
  }

  async token() {
    if (!this._token) {
      const creds = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      this._token = await sheets.getAccessToken(creds);
    }
    return this._token;
  }

  async load() {
    const values = await sheets.getValues(this.sheetId, this.range, await this.token());
    this.raw = values;

    if (!values.length) return emptyState();

    const header = values[0].map(h => String(h || '').trim());
    const idx = headerIndex(header);
    const prospects = values.slice(1)
      .filter(r => r && r.some(c => String(c ?? '').trim() !== ''))
      .map(r => fromRow(r, idx))
      .filter(p => p.domain);

    return indexState(prospects);
  }

  async save(prospects) {
    const merged = mergeRows(this.raw || [], prospects);
    const lastCol = colLetter(merged.header.length);
    await sheets.updateValues(
      this.sheetId,
      `A1:${lastCol}${merged.values.length}`,
      merged.values,
      await this.token()
    );
    return merged;
  }

  /** What a --dry-run would have written, without writing it. */
  preview(prospects) {
    return mergeRows(this.raw || [], prospects);
  }
}

class FileState {
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, 'prospects.json');
    this.label = `local file ${this.file}`;
  }

  async load() {
    let data = { prospects: [] };
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.raw = data.prospects || [];
    return indexState(this.raw);
  }

  async save(prospects) {
    const merged = this.preview(prospects);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ prospects: merged.merged }, null, 2));
    return merged;
  }

  preview(prospects) {
    const byDomain = new Map((this.raw || []).map(p => [p.domain, p]));
    let added = 0, updated = 0;
    for (const p of prospects) {
      const prior = byDomain.get(p.domain);
      if (!prior) { byDomain.set(p.domain, p); added++; continue; }
      // Same rule as the sheet: the human's columns win, and a blank never
      // overwrites a known value.
      const next = { ...prior };
      for (const [k, v] of Object.entries(p)) {
        if (k === 'status' || k === 'notes' || k === 'firstSeen') continue;
        if (v === null || v === '') continue;
        next[k] = v;
      }
      if (JSON.stringify(next) !== JSON.stringify(prior)) updated++;
      byDomain.set(p.domain, next);
    }
    const merged = [...byDomain.values()];
    return { merged, added, updated, total: merged.length, header: HEADER };
  }
}

function emptyState() {
  return indexState([]);
}

function indexState(prospects) {
  const byDomain = new Map();
  const placeIds = new Set();
  for (const p of prospects) {
    if (p.domain) byDomain.set(p.domain, p);
    if (p.placeId) {
      // One row can carry several place IDs when a company has multiple
      // storefronts, so they are stored space-separated.
      for (const id of String(p.placeId).split(/[\s,]+/).filter(Boolean)) placeIds.add(id);
    }
  }
  return { prospects, byDomain, placeIds };
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

/**
 * Pick a backend from the environment. The sheet wins when it is configured,
 * because that is the one that works in the cloud.
 */
function createState(opts = {}) {
  const sheetId = opts.sheetId || process.env.PROSPECT_SHEET_ID;
  const credentialsFile = opts.credentialsFile || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (sheetId && credentialsFile) {
    return new SheetState({ sheetId, credentialsFile });
  }
  return new FileState({ dir: opts.dir || 'prospects' });
}

module.exports = { createState, SheetState, FileState, indexState, colLetter };
