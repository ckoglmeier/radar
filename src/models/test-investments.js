#!/usr/bin/env node

// Integration tests for upsertInvestment and createValuationSnapshot.
// Hits the real DATABASE_URL — uses unique company names per run and cleans up
// in a finally block so re-running is safe and parallel runs don't collide.
//
// Run: node src/models/test-investments.js

import { query } from '../db/index.js';
import { upsertInvestment, createValuationSnapshot } from './investments.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Cleanup helper — wipe rows for any company name we created.
async function cleanupCompany(company) {
  const rows = await query(`SELECT id FROM investments WHERE company_name = $1`, [company]);
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  // valuations is append-only — disable trigger to clean test rows.
  let triggerDisabled = false;
  try {
    await query(`ALTER TABLE valuations DISABLE TRIGGER valuations_immutable`);
    triggerDisabled = true;
    await query(`DELETE FROM valuations WHERE investment_id = ANY($1::int[])`, [ids]);
  } finally {
    if (triggerDisabled) {
      await query(`ALTER TABLE valuations ENABLE TRIGGER valuations_immutable`);
    }
  }
  await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [ids]);
}

const BASE_FIELDS = {
  status: 'Closing',
  invested: 5000,
  unrealized_value: null,
  realized_value: null,
  net_value: null,
  multiple: null,
  investment_entity: null,
  lead: 'Apex Syndicate',
  investment_type: null,
  round: 'Series A+',
  stage_bucket: null,
  market: null,
  fund_name: null,
  allocation: null,
  instrument: null,
  round_size: null,
  valuation_cap_type: null,
  valuation_cap: null,
  discount: null,
  carry: null,
  share_class: null,
  source: 'angellist',
};

async function run() {
  const stamp = Date.now();

  // Test 1: Closing-status upsert with drifting invest_date hits the same row.
  await test('Closing rows with drifting invest_date update in place', async () => {
    const company = `Test Closing Drift ${stamp}-1`;
    try {
      const first = await upsertInvestment({
        ...BASE_FIELDS,
        company_name: company,
        invest_date: '2026-03-15',
      });
      eq(first.isNew, true, 'first insert should be new');

      const second = await upsertInvestment({
        ...BASE_FIELDS,
        company_name: company,
        invest_date: '2026-04-09',
      });
      eq(second.isNew, false, 'second insert should hit Closing match path');
      eq(second.id, first.id, 'should return same id');

      const rows = await query(`SELECT id, invest_date FROM investments WHERE company_name = $1`, [company]);
      eq(rows.length, 1, 'should be exactly one row');
      const date = rows[0].invest_date instanceof Date
        ? rows[0].invest_date.toISOString().slice(0, 10)
        : String(rows[0].invest_date).slice(0, 10);
      eq(date, '2026-04-09', 'invest_date should be updated to the latest');
    } finally {
      await cleanupCompany(company);
    }
  });

  // Test 2: Non-Closing rows with different dates produce two rows.
  await test('Non-Closing rows with different invest_dates do not collide', async () => {
    const company = `Test Live Two-Lot ${stamp}-2`;
    try {
      const first = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2025-01-10',
      });
      const second = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2025-08-20',
      });
      eq(first.isNew, true);
      eq(second.isNew, true);
      const rows = await query(`SELECT id FROM investments WHERE company_name = $1`, [company]);
      eq(rows.length, 2, 'should be two distinct rows');
    } finally {
      await cleanupCompany(company);
    }
  });

  // Test 3: Closing rows with different invested amounts do NOT collide.
  // Protects the follow-on SPV case (same company, same lead, different SPV size).
  await test('Closing rows with different invested amounts do not collide', async () => {
    const company = `Test Closing Multi-SPV ${stamp}-3`;
    try {
      const first = await upsertInvestment({
        ...BASE_FIELDS,
        company_name: company,
        invested: 4954,
        invest_date: '2025-03-27',
      });
      const second = await upsertInvestment({
        ...BASE_FIELDS,
        company_name: company,
        invested: 2303,
        invest_date: '2025-12-17',
      });
      eq(first.isNew, true);
      eq(second.isNew, true, 'different invested amount should not match');
      const rows = await query(`SELECT id, invested FROM investments WHERE company_name = $1 ORDER BY invest_date`, [company]);
      eq(rows.length, 2, 'should be two distinct rows');
    } finally {
      await cleanupCompany(company);
    }
  });

  // Test 4: createValuationSnapshot dedups on (investment_id, snapshot_date).
  await test('createValuationSnapshot is idempotent for same day', async () => {
    const company = `Test Snapshot Dedup ${stamp}-4`;
    try {
      const { id } = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2025-01-10',
      });
      await createValuationSnapshot(id, {
        unrealized_value: 1000, realized_value: null, net_value: 1000, multiple: 1.0,
      });
      await createValuationSnapshot(id, {
        unrealized_value: 1500, realized_value: null, net_value: 1500, multiple: 1.5,
      });
      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM valuations WHERE investment_id = $1 AND snapshot_date = CURRENT_DATE`,
        [id]
      );
      eq(rows[0].n, 1, 'second insert should be a no-op due to unique constraint');
    } finally {
      await cleanupCompany(company);
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
