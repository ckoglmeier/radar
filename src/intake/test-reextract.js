#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { query, closeDb } from '../db/index.js';
import { createDocument } from '../models/documents.js';
import { reextractIntake } from './reextract.js';

const company = `ZZREEXTRACT ${Date.now()}`;
let inviteId;

const html = Buffer.from(`<!doctype html><html><head><title>${company} | AngelList</title></head><body>
  <h2>Note from Parsed Syndicate</h2>
  <dl><dt>Round</dt><dd>Series B</dd><dt>Post-money valuation</dt><dd>$80M USD</dd>
  <dt>Allocation</dt><dd>$300k USD</dd><dt>Gross carry</dt><dd>15%</dd>
  <dt>Min. investment</dt><dd>$10k USD</dd><dt>Markets</dt><dd>Aerospace</dd></dl>
  <p>Confidential: Disclosing deal information will result in removal from AngelList</p>
</body></html>`);

try {
  const inserted = await query(`
    INSERT INTO pipeline_invites (company_name, source, deal_slug, lead, status)
    VALUES ($1, 'intake', $2, 'User-entered Lead', 'invite')
    RETURNING id
  `, [company, `zz-reextract-${Date.now()}`]);
  inviteId = inserted[0].id;
  await createDocument({
    entity_type: 'pipeline_invite',
    entity_id: inviteId,
    filename: 'synthetic-angellist.html',
    mime: 'text/html',
    content: html,
    source: 'intake',
  });

  const dryRun = await reextractIntake({ dryRun: true, inviteIds: [inviteId] });
  assert.equal(dryRun.length, 1);
  assert.equal(dryRun[0].company_name, company);
  assert.equal(dryRun[0].changes.lead, undefined, 'non-null lead must never be proposed');
  assert.equal(dryRun[0].changes.round.to, 'Series B');
  assert.equal(dryRun[0].changes.allocation_usd.to, 300000);
  let row = (await query(`SELECT * FROM pipeline_invites WHERE id = $1`, [inviteId]))[0];
  assert.equal(row.round, null, 'dry run must not write');

  const applied = await reextractIntake({ dryRun: false, inviteIds: [inviteId] });
  assert.equal(applied.length, 1);
  row = (await query(`SELECT * FROM pipeline_invites WHERE id = $1`, [inviteId]))[0];
  assert.equal(row.lead, 'User-entered Lead', 'existing value preserved');
  assert.equal(row.round, 'Series B');
  assert.equal(Number(row.allocation_usd), 300000);
  assert.equal(Number(row.min_investment_usd), 10000);
  assert.equal(Number(row.carry_pct), 15);
  assert.equal(Number(row.valuation_usd), 80000000);
  assert.equal(row.market, 'Aerospace');

  const replay = await reextractIntake({ dryRun: false, inviteIds: [inviteId] });
  assert.equal(replay.length, 0, 'second run is idempotent');

  console.log('  ✓ dry-run reports without writing');
  console.log('  ✓ fill-only update preserves user-entered values');
  console.log('  ✓ second run is idempotent');
  console.log('\n  3 passed, 0 failed\n');
} finally {
  if (inviteId) {
    await query(`DELETE FROM documents WHERE entity_type = 'pipeline_invite' AND entity_id = $1`, [inviteId]);
    await query(`DELETE FROM pipeline_events WHERE invite_id = $1`, [inviteId]);
    await query(`DELETE FROM pipeline_invites WHERE id = $1`, [inviteId]);
  }
  await closeDb();
}
