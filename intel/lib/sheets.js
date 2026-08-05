'use strict';

const crypto = require('crypto');

/**
 * Minimal Google Sheets client — service account auth, no dependencies.
 *
 * A service account is used rather than OAuth because this has to run on a
 * schedule with nobody sitting there to click a consent screen. The account
 * needs no special powers: create one in Google Cloud, download the JSON key,
 * then share the spreadsheet with the account's email address as an Editor.
 * That share is the entire permission grant — it can touch that one sheet and
 * nothing else in the Drive.
 *
 *   export GOOGLE_SERVICE_ACCOUNT_JSON=/path/to/key.json
 *   export PROSPECT_SHEET_ID=1DuJK...
 */

const base64url = buf =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const tokenEndpoint = () => process.env.GOOGLE_TOKEN_ENDPOINT || 'https://oauth2.googleapis.com/token';
const sheetsBase = () => process.env.SHEETS_ENDPOINT || 'https://sheets.googleapis.com/v4/spreadsheets';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let cached = null;

/**
 * Exchange the service account key for an access token.
 * `nowSeconds` is injectable so tests don't depend on the clock.
 */
async function getAccessToken(credentials, { nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  const now = nowSeconds();
  if (cached && cached.expiresAt > now + 60 && cached.email === credentials.client_email) {
    return cached.token;
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: credentials.client_email,
    scope: SCOPE,
    aud: credentials.token_uri || tokenEndpoint(),
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = base64url(
    crypto.createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key)
  );

  const res = await fetch(credentials.token_uri || tokenEndpoint(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  cached = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600),
    email: credentials.client_email,
  };
  return cached.token;
}

/** For tests and for long-running processes that switch credentials. */
function resetTokenCache() { cached = null; }

async function call(path, { token, method = 'GET', body, query } = {}) {
  const url = new URL(`${sheetsBase()}/${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Sheets API ${method} ${path} failed (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }
  return res.json();
}

async function getValues(spreadsheetId, range, token) {
  const data = await call(`${spreadsheetId}/values/${encodeURIComponent(range)}`, { token });
  return data.values || [];
}

async function updateValues(spreadsheetId, range, values, token) {
  return call(`${spreadsheetId}/values/${encodeURIComponent(range)}`, {
    token,
    method: 'PUT',
    query: { valueInputOption: 'USER_ENTERED' },
    body: { range, majorDimension: 'ROWS', values },
  });
}

module.exports = { getAccessToken, resetTokenCache, getValues, updateValues };
