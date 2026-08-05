'use strict';

/**
 * Sync tests — spreadsheet merge and CRM push, against mock servers.
 *
 * This is the only part of the system that writes to somewhere real. A bug here
 * doesn't produce a bad brief, it produces duplicate contacts in a live CRM or
 * a "Booked" status quietly reset to "Not contacted". So the rules that protect
 * against that get tested directly.
 *
 *   node intel/test/sync-tests.js
 */

const http = require('http');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`FAIL  ${name}\n      ${err.message}`); }
}

const { HEADER, COLUMNS, toProspect, fromRow, headerIndex, mergeRows } = require('../lib/rows');
const { colLetter } = require('../lib/state');

const prospect = (domain, over = {}) => ({
  domain, name: `${domain} Inc`, niche: 'hvac', city: 'Orange, CA',
  phone: '(714) 555-0100', website: `https://${domain}`,
  score: 55, band: 'Heavy loss', recoverableAnnual: 348998,
  topLeak: 'Missed & unanswered calls', leadAgent: 'Speed to Lead',
  reviewCount: 180, rating: 4.5, ...over,
});

(async () => {
  console.log('\nrow shape');
  {
    test('header matches the column definition', () => {
      assert.strictEqual(HEADER.length, COLUMNS.length);
      assert.strictEqual(HEADER[0], 'Domain', 'domain must be the key column');
      assert.ok(HEADER.includes('Status') && HEADER.includes('Owner Notes'));
    });

    test('toProspect folds discovery and analysis into one record', () => {
      const p = toProspect(
        { domain: 'x.com', name: 'X', niche: 'hvac', reviewCount: 12, area: 'Orange, CA' },
        { pct: 61, band: 'Leaking', leaks: { annualRecover: 1000, items: [{ label: 'Slow lead response', monthly: 50 }] },
          agents: [{ agent: 'Speed to Lead' }] }
      );
      assert.strictEqual(p.score, 61);
      assert.strictEqual(p.band, 'Leaking');
      assert.strictEqual(p.topLeak, 'Slow lead response');
      assert.strictEqual(p.leadAgent, 'Speed to Lead');
      assert.strictEqual(p.city, 'Orange, CA');
    });

    test('an unresearched prospect still produces a valid row', () => {
      const m = mergeRows([], [toProspect({ domain: 'y.com', name: 'Y', niche: 'salon' })]);
      const row = m.values[1];
      assert.strictEqual(row.length, HEADER.length);
      assert.strictEqual(row[0], 'y.com');
      assert.strictEqual(row[HEADER.indexOf('Score')], '');
    });

    test('a row survives the round trip through the sheet and back', () => {
      // The sheet is the state store now, so read-back fidelity is load-
      // bearing: what fromRow returns is what the next run knows.
      const p = prospect('roundtrip.com', {
        placeId: 'p_1 p_2', researchedAt: '2026-08-01T00:00:00.000Z', syncState: 'synced',
      });
      const m = mergeRows([], [p]);
      const back = fromRow(m.values[1], headerIndex(m.header));
      assert.strictEqual(back.domain, 'roundtrip.com');
      assert.strictEqual(back.score, 55);
      assert.strictEqual(back.recoverableAnnual, 348998, 'dollar formatting broke the number');
      assert.strictEqual(back.placeId, 'p_1 p_2');
      assert.strictEqual(back.researchedAt, '2026-08-01T00:00:00.000Z');
      assert.strictEqual(back.syncState, 'synced');
      assert.strictEqual(back.status, 'Not contacted');
    });

    test('columns the user adds to the sheet survive a sync', () => {
      const first = mergeRows([], [prospect('a.com')]);
      // She adds her own column and fills it in…
      first.header.push('My Column');
      first.values[0].push('My Column');
      first.values[1].push('her data');
      // …and the next sync keeps both the column and the value.
      const second = mergeRows(first.values, [prospect('a.com', { score: 40 })]);
      const mi = second.header.indexOf('My Column');
      assert.ok(mi >= 0, 'user column was dropped');
      assert.strictEqual(second.values[1][mi], 'her data', 'user data was destroyed');
      assert.strictEqual(second.values[1][second.header.indexOf('Score')], 40);
    });

    test('a blank value never erases a known one', () => {
      const first = mergeRows([], [prospect('a.com')]);
      // Research failed today: the prospect comes through with no score.
      const second = mergeRows(first.values, [prospect('a.com', {
        score: null, band: null, recoverableAnnual: null, topLeak: null, leadAgent: null,
      })]);
      assert.strictEqual(second.values[1][second.header.indexOf('Score')], 55,
        'a failed research pass erased yesterday\'s score');
      assert.strictEqual(second.values[1][second.header.indexOf('Band')], 'Heavy loss');
    });
  }

  console.log('\nsheet merge — the rules that protect a working list');
  {
    test('new prospects are appended under the header', () => {
      const m = mergeRows([], [prospect('a.com'), prospect('b.com')]);
      assert.strictEqual(m.added, 2);
      assert.strictEqual(m.total, 2);
      assert.deepStrictEqual(m.values[0], HEADER);
      assert.strictEqual(m.values[1][0], 'a.com');
    });

    test('re-running does not duplicate a row', () => {
      const first = mergeRows([], [prospect('a.com')]);
      const second = mergeRows(first.values, [prospect('a.com')]);
      assert.strictEqual(second.total, 1, 'row was duplicated on re-run');
      assert.strictEqual(second.added, 0);
    });

    test('Status and Owner Notes are never overwritten', () => {
      const first = mergeRows([], [prospect('a.com')]);
      const si = HEADER.indexOf('Status'), ni = HEADER.indexOf('Owner Notes');
      first.values[1][si] = 'Booked';
      first.values[1][ni] = 'Spoke to Dave, call back Tuesday';

      const second = mergeRows(first.values, [prospect('a.com', { score: 40, band: 'Critical' })]);
      assert.strictEqual(second.values[1][si], 'Booked', 'Status was reset by the sync');
      assert.strictEqual(second.values[1][ni], 'Spoke to Dave, call back Tuesday', 'Notes were destroyed');
      // ...while the researched columns did update.
      assert.strictEqual(second.values[1][HEADER.indexOf('Score')], 40);
      assert.strictEqual(second.values[1][HEADER.indexOf('Band')], 'Critical');
    });

    test('First Seen survives updates, Last Updated moves', () => {
      const first = mergeRows([], [prospect('a.com')]);
      const fi = HEADER.indexOf('First Seen');
      first.values[1][fi] = '2020-01-01';
      const second = mergeRows(first.values, [prospect('a.com', { score: 42 })]);
      assert.strictEqual(second.values[1][fi], '2020-01-01', 'First Seen was overwritten');
      assert.ok(second.values[1][HEADER.indexOf('Last Updated')]);
    });

    test('an unchanged prospect is not counted as updated', () => {
      const first = mergeRows([], [prospect('a.com')]);
      const second = mergeRows(first.values, [prospect('a.com')]);
      assert.strictEqual(second.updated, 0, 'identical data reported as a change');
    });

    test('domain matching is case-insensitive', () => {
      const first = mergeRows([], [prospect('Acme.com')]);
      const second = mergeRows(first.values, [prospect('acme.com')]);
      assert.strictEqual(second.total, 1, 'case difference created a duplicate row');
    });

    test('rows the sync no longer knows about are left alone', () => {
      const first = mergeRows([], [prospect('a.com'), prospect('manual.com')]);
      const second = mergeRows(first.values, [prospect('a.com')]);
      assert.strictEqual(second.total, 2, 'a hand-added row was dropped');
      assert.ok(second.values.some(r => r[0] === 'manual.com'));
    });

    test('column letters are right past Z', () => {
      assert.strictEqual(colLetter(1), 'A');
      assert.strictEqual(colLetter(17), 'Q');
      assert.strictEqual(colLetter(26), 'Z');
      assert.strictEqual(colLetter(27), 'AA');
      assert.strictEqual(colLetter(52), 'AZ');
    });
  }

  console.log('\nCRM push — idempotency against a mock GHL');
  {
    const state = { contacts: new Map(), opportunities: [], calls: [], customFields: [] };
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        state.calls.push(`${req.method} ${url.pathname}`);
        const json = body ? JSON.parse(body) : {};
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };

        if (/^\/locations\/[^/]+\/customFields$/.test(url.pathname)) {
          if (req.method === 'GET') return send(200, { customFields: state.customFields });
          const f = { id: `cf_${state.customFields.length + 1}`, ...json };
          state.customFields.push(f);
          return send(200, { customField: f });
        }
        if (url.pathname === '/opportunities/pipelines') {
          return send(200, { pipelines: [
            { id: 'pipe_course', name: 'AI Advantage Pipeline 1',
              stages: [{ id: 's1', name: 'New Lead' }, { id: 's2', name: 'Contacted' }] },
            { id: 'pipe_outbound', name: 'Outbound Prospecting',
              stages: [{ id: 'st_new', name: 'New Lead' }, { id: 'st_c', name: 'Contacted' }] },
          ] });
        }
        if (url.pathname === '/contacts/upsert') {
          const key = json.website || json.email || json.phone;
          const isNew = !state.contacts.has(key);
          if (isNew) state.contacts.set(key, { id: `c_${state.contacts.size + 1}`, ...json });
          return send(200, { contact: state.contacts.get(key), new: isNew });
        }
        if (url.pathname === '/opportunities/search') {
          const contactId = url.searchParams.get('contact_id');
          return send(200, { opportunities: state.opportunities.filter(o => o.contactId === contactId) });
        }
        if (url.pathname === '/opportunities/') {
          const opp = { id: `o_${state.opportunities.length + 1}`, ...json };
          state.opportunities.push(opp);
          return send(200, { opportunity: opp });
        }
        send(404, { error: 'not found' });
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    process.env.GHL_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
    process.env.GHL_API_KEY = 'test-key';
    process.env.GHL_LOCATION_ID = 'loc_test';
    process.env.GHL_PIPELINE_ID = 'pipe_test';
    process.env.GHL_STAGE_ID = 'stage_new_lead';

    const ghl = require('../lib/ghl');

    const first = await ghl.syncProspect(prospect('a.com'));
    const second = await ghl.syncProspect(prospect('a.com'));

    test('creates a contact and an opportunity on first sync', () => {
      assert.ok(first.contact.id);
      assert.strictEqual(first.opportunity.created, true);
      assert.strictEqual(state.opportunities.length, 1);
    });

    test('a second sync creates no duplicate contact or opportunity', () => {
      assert.strictEqual(second.contact.id, first.contact.id);
      assert.strictEqual(second.opportunity.created, false);
      assert.strictEqual(state.contacts.size, 1, 'duplicate contact created');
      assert.strictEqual(state.opportunities.length, 1, 'duplicate opportunity created');
    });

    test('the opportunity lands in the configured New Lead stage', () => {
      assert.strictEqual(state.opportunities[0].pipelineStageId, 'stage_new_lead');
      assert.strictEqual(state.opportunities[0].pipelineId, 'pipe_test');
      assert.strictEqual(state.opportunities[0].status, 'open');
    });

    test('deal value carries the recoverable revenue, not a guess at our fee', () => {
      assert.strictEqual(state.opportunities[0].monetaryValue, 348998);
    });

    test('contact is tagged so it can be found and worked as a segment', () => {
      const c = [...state.contacts.values()][0];
      assert.ok(c.tags.includes('outbound-prospect'));
      assert.ok(c.tags.includes('niche-hvac'));
      assert.ok(c.tags.some(t => t.startsWith('leak-band-')));
      assert.strictEqual(c.source, 'Prospect Intel (outbound)');
    });

    const contactsOnly = await ghl.syncProspect(prospect('b.com'), { contactsOnly: true });
    test('contacts-only mode skips the pipeline entirely', () => {
      assert.strictEqual(contactsOnly.opportunity.skipped, true);
      assert.strictEqual(state.opportunities.length, 1, 'opportunity created in contacts-only mode');
    });

    test('missing credentials fail loudly rather than silently no-oping', () => {
      const saved = process.env.GHL_API_KEY;
      delete process.env.GHL_API_KEY;
      assert.throws(() => ghl.requireConfig(), /GHL_API_KEY is not set/);
      process.env.GHL_API_KEY = saved;
    });

    console.log('\ncustom fields — the spreadsheet columns, on the contact record');
    {
      test('intel custom fields were created on first sync', () => {
        const names = state.customFields.map(f => f.name);
        for (const spec of ghl.CUSTOM_FIELDS) {
          assert.ok(names.includes(spec.name), `field "${spec.name}" was never created`);
        }
        assert.ok(state.customFields.every(f => f.model === 'contact'));
      });

      test('the contact carries the sheet values — score, band, top leak', () => {
        const c = [...state.contacts.values()][0];
        assert.ok(Array.isArray(c.customFields) && c.customFields.length >= 4,
          'no custom field values on the contact');
        const byId = new Map(state.customFields.map(f => [f.id, f.name]));
        const values = Object.fromEntries(c.customFields.map(v => [byId.get(v.id), v.field_value]));
        assert.strictEqual(values['Leak Score'], '55');
        assert.strictEqual(values['Leak Band'], 'Heavy loss');
        assert.strictEqual(values['Recoverable Revenue (est/yr)'], '348998');
        assert.strictEqual(values['Top Leak'], 'Missed & unanswered calls');
      });

      test('fields are created once, not once per prospect', () => {
        const creates = state.calls.filter(c => c.startsWith('POST /locations/')).length;
        assert.strictEqual(creates, ghl.CUSTOM_FIELDS.length,
          `expected ${ghl.CUSTOM_FIELDS.length} field creations, saw ${creates}`);
      });

      const before = state.customFields.length;
      const map = await ghl.ensureCustomFields({});
      test('ensureCustomFields is idempotent against existing fields', () => {
        assert.strictEqual(state.customFields.length, before, 'duplicate fields created');
        assert.ok(Object.values(map).every(Boolean));
      });
    }

    console.log('\npipeline resolution by name — because GHL has no create-pipeline API');
    {
      delete process.env.GHL_PIPELINE_ID;
      delete process.env.GHL_STAGE_ID;

      const byName = await ghl.resolvePipeline({ pipelineName: 'Outbound Prospecting' });
      test('resolves pipeline and default "New Lead" stage by name', () => {
        assert.strictEqual(byName.pipelineId, 'pipe_outbound');
        assert.strictEqual(byName.stageId, 'st_new');
        assert.strictEqual(byName.resolvedBy, 'name');
      });

      const caseWashed = await ghl.resolvePipeline({ pipelineName: '  outbound prospecting ' });
      test('name matching ignores case and whitespace', () => {
        assert.strictEqual(caseWashed.pipelineId, 'pipe_outbound');
      });

      let missingErr = null;
      try { await ghl.resolvePipeline({ pipelineName: 'Nonexistent Pipeline' }); }
      catch (err) { missingErr = err; }
      test('a missing pipeline names what it found and says the UI is the fix', () => {
        assert.ok(missingErr, 'no error thrown');
        assert.match(missingErr.message, /No GHL pipeline named "Nonexistent Pipeline"/);
        assert.match(missingErr.message, /Outbound Prospecting/, 'did not list what exists');
        assert.match(missingErr.message, /created in the GHL UI/);
      });

      let missingStage = null;
      try { await ghl.resolvePipeline({ pipelineName: 'Outbound Prospecting', stageName: 'Imaginary' }); }
      catch (err) { missingStage = err; }
      test('a missing stage lists the stages that do exist', () => {
        assert.ok(missingStage, 'no error thrown');
        assert.match(missingStage.message, /New Lead, Contacted/);
      });

      const byId = await ghl.resolvePipeline({ pipelineId: 'pipe_x', stageId: 'st_x' });
      test('explicit ID resolution short-circuits the lookup', () => {
        assert.strictEqual(byId.pipelineId, 'pipe_x');
        assert.strictEqual(byId.resolvedBy, 'id');
      });
    }

    server.close();
  }

  console.log('\nSlack digest — a signal, not a firehose');
  {
    const { buildDigest, postDigest } = require('../lib/slack');

    test('a run that did nothing posts nothing', () => {
      assert.strictEqual(buildDigest({ newLeads: [], researched: [], failures: [] }), null);
    });

    test('new leads produce one digest, worst score first, capped at five', () => {
      const leads = [72, 55, 38, 90, 61, 45, 83].map((score, i) =>
        prospect(`lead${i}.com`, { score, name: `Lead ${score}` }));
      const msg = buildDigest({ newLeads: leads, researched: leads, totals: { prospects: 7, synced: 7 } });
      assert.match(msg.text, /7 new leads/);
      const body = JSON.stringify(msg.blocks);
      assert.ok(body.includes('Lead 38'), 'worst lead missing');
      assert.ok(!body.includes('Lead 90'), 'list was not capped at the five worst');
      // Worst first: 38 must appear before 55 in the rendered rows.
      assert.ok(body.indexOf('Lead 38') < body.indexOf('Lead 55'));
    });

    test('the digest carries the sheet link and the leak details', () => {
      const msg = buildDigest({
        newLeads: [prospect('a.com')],
        totals: { prospects: 1, synced: 1 },
        sheetUrl: 'https://docs.google.com/spreadsheets/d/SHEET/edit',
      });
      const body = JSON.stringify(msg.blocks);
      assert.match(body, /55\/100 Heavy loss/);
      assert.match(body, /348,998/);
      assert.match(body, /Missed & unanswered calls/);
      assert.match(body, /docs.google.com\/spreadsheets\/d\/SHEET/);
    });

    test('failures always post, even with nothing new', () => {
      const msg = buildDigest({ newLeads: [], researched: [], failures: ['GHL x.com: HTTP 500'] });
      assert.ok(msg, 'failure run stayed silent');
      assert.match(msg.text, /1 problem/);
      assert.match(JSON.stringify(msg.blocks), /HTTP 500/);
    });

    // postDigest against a mock webhook.
    const posts = [];
    const hookSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => { posts.push(JSON.parse(body)); res.writeHead(200); res.end('ok'); });
    });
    await new Promise(r => hookSrv.listen(0, '127.0.0.1', r));

    delete process.env.SLACK_WEBHOOK_URL;
    const noHook = await postDigest({ newLeads: [prospect('a.com')] });
    test('no webhook configured → explicit skip, not an error', () => {
      assert.strictEqual(noHook, 'skipped-no-webhook');
    });

    process.env.SLACK_WEBHOOK_URL = `http://127.0.0.1:${hookSrv.address().port}/hook`;
    const posted = await postDigest({ newLeads: [prospect('a.com')], totals: { prospects: 1, synced: 1 } });
    const quiet = await postDigest({ newLeads: [], researched: [], failures: [] });
    test('posts to the webhook when there is news, stays quiet when not', () => {
      assert.strictEqual(posted, 'posted');
      assert.strictEqual(quiet, 'skipped-empty');
      assert.strictEqual(posts.length, 1, 'quiet run still posted');
      assert.ok(posts[0].blocks, 'no blocks in the payload');
    });
    hookSrv.close();
    delete process.env.SLACK_WEBHOOK_URL;
  }

  console.log('\nsheet as state store — end to end against a mock Sheets API');
  {
    const crypto = require('crypto');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    // A real RSA key so the JWT signing path runs for real.
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const grid = { values: [] }; // the "spreadsheet"
    let tokenRequests = 0;

    const mock = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const url = new URL(req.url, 'http://x');
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (url.pathname === '/token') {
          tokenRequests++;
          return send(200, { access_token: 'tok_test', expires_in: 3600 });
        }
        if (req.method === 'GET' && /\/values\//.test(url.pathname)) {
          return send(200, { values: grid.values });
        }
        if (req.method === 'PUT' && /\/values\//.test(url.pathname)) {
          grid.values = JSON.parse(body).values;
          return send(200, { updatedRange: 'ok' });
        }
        send(404, {});
      });
    });
    await new Promise(r => mock.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${mock.address().port}`;
    process.env.SHEETS_ENDPOINT = `${base}/sheets`;

    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intel-sa-')), 'key.json');
    fs.writeFileSync(keyFile, JSON.stringify({
      client_email: 'sync@test.iam.gserviceaccount.com',
      private_key: privateKey,
      token_uri: `${base}/token`,
    }));

    const { SheetState } = require('../lib/state');
    const { resetTokenCache } = require('../lib/sheets');
    resetTokenCache();

    const store = new SheetState({ sheetId: 'sheet_test', credentialsFile: keyFile });

    const empty = await store.load();
    test('an empty sheet loads as empty state, not an error', () => {
      assert.strictEqual(empty.prospects.length, 0);
      assert.strictEqual(empty.placeIds.size, 0);
    });

    await store.save([
      prospect('first.com', { placeId: 'p_a p_b', researchedAt: '2026-08-01T00:00:00.000Z' }),
      prospect('second.com', { placeId: 'p_c' }),
    ]);
    test('save writes header plus one row per prospect', () => {
      assert.strictEqual(grid.values.length, 3);
      assert.deepStrictEqual(grid.values[0], HEADER);
    });

    resetTokenCache(); // simulate a brand-new machine: no token, no local files
    const store2 = new SheetState({ sheetId: 'sheet_test', credentialsFile: keyFile });
    const reloaded = await store2.load();
    test('a fresh process recovers full state from the sheet alone', () => {
      assert.strictEqual(reloaded.prospects.length, 2);
      assert.ok(reloaded.byDomain.has('first.com'));
      // Place IDs — including multi-storefront siblings — survive the trip,
      // which is what keeps discovery from re-buying the same businesses.
      assert.ok(reloaded.placeIds.has('p_a'));
      assert.ok(reloaded.placeIds.has('p_b'));
      assert.ok(reloaded.placeIds.has('p_c'));
      assert.strictEqual(reloaded.byDomain.get('first.com').researchedAt, '2026-08-01T00:00:00.000Z');
    });

    const statusIdx = grid.values[0].indexOf('Status');
    grid.values[1][statusIdx] = 'Booked';
    const store3 = new SheetState({ sheetId: 'sheet_test', credentialsFile: keyFile });
    await store3.load();
    await store3.save([prospect('first.com', { score: 40, band: 'Critical' })]);
    test('the human\'s Status survives a full cloud round trip', () => {
      assert.strictEqual(grid.values[1][statusIdx], 'Booked');
      assert.strictEqual(grid.values[1][grid.values[0].indexOf('Score')], 40);
    });

    test('token exchange ran the real signing path', () => {
      assert.ok(tokenRequests >= 1, 'token endpoint never called');
    });

    mock.server?.close?.();
    mock.close();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
