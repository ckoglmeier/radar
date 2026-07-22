#!/usr/bin/env node

// Integration tests for upsertInvestment and createValuationSnapshot.
// Hits the real DATABASE_URL — uses unique company names per run and cleans up
// in a finally block so re-running is safe and parallel runs don't collide.
//
// Run: node src/models/test-investments.js

import { query } from '../db/index.js';
import { portfolioList } from '../reports/portfolio.js';
import {
  upsertInvestment,
  createValuationSnapshot,
  addPositionManual,
  tagInvestment,
  untagInvestment,
  setConviction,
  inferAssetClass,
} from './investments.js';

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

  await test('asset class inference recognizes whole-word Fund names', async () => {
    eq(inferAssetClass('EquityZen Future of Food Fund'), 'fund');
    eq(inferAssetClass('Calm Company Fund II'), 'fund');
    eq(inferAssetClass('Fundamental Labs'), 'direct');
    eq(inferAssetClass('Acme Fund', 'direct'), 'direct', 'explicit class should win');
  });

  await test('fund-named imports persist as fund positions', async () => {
    const company = `Test Access Fund ${stamp}`;
    try {
      const { id } = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2026-01-15',
      });
      const rows = await query(`SELECT asset_class FROM investments WHERE id = $1`, [id]);
      eq(rows[0].asset_class, 'fund');
    } finally {
      await cleanupCompany(company);
    }
  });

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

  await test('addPositionManual creates an investment row, manual snapshot, and list entry', async () => {
    const company = `Test Manual Position ${stamp}-5`;
    try {
      const added = await addPositionManual({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2026-02-03',
        invested: 12000,
        unrealized_value: 15000,
        realized_value: 1000,
        net_value: 16000,
        multiple: 1.333333,
      });

      const rows = await query(
        `SELECT source, invested, net_value FROM investments WHERE id = $1`,
        [added.id]
      );
      eq(rows.length, 1, 'manual add should create one investment row');
      eq(rows[0].source, 'manual', 'manual add should stamp investment source');
      eq(Number(rows[0].invested), 12000, 'invested should round-trip');
      eq(Number(rows[0].net_value), 16000, 'net value should round-trip');

      const snapshots = await query(
        `SELECT source, net_value FROM valuations WHERE investment_id = $1 AND snapshot_date = CURRENT_DATE`,
        [added.id]
      );
      eq(snapshots.length, 1, 'manual add should create one valuation snapshot');
      eq(snapshots[0].source, 'manual_position', 'manual snapshot should use manual source');
      eq(Number(snapshots[0].net_value), 16000, 'snapshot net value should round-trip');

      const listed = await portfolioList('company_name', {
        since: '2026-02-03',
        until: '2026-02-03',
      });
      const row = listed.find(r => r.id === added.id);
      if (!row) throw new Error('manual add should appear in portfolioList');
      eq(row.company_name, company, 'portfolio list company');
      eq(Number(row.net_value), 16000, 'portfolio list net value');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('tagInvestment and untagInvestment round-trip thesis links', async () => {
    const company = `Test Thesis Tag ${stamp}-6`;
    try {
      const { id } = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2026-02-04',
      });
      const theses = await query(`SELECT id FROM theses ORDER BY id LIMIT 1`);
      if (theses.length === 0) throw new Error('expected at least one thesis');

      const tagged = await tagInvestment(id, theses[0].id, {
        isPrimary: true,
        confidence: 'manual',
        taggedBy: 'test',
        weight: 75,
      });
      if (!tagged) throw new Error('tagInvestment should insert a row');

      const links = await query(
        `SELECT is_primary, confidence, tagged_by, weight
         FROM investment_theses
         WHERE investment_id = $1 AND thesis_id = $2`,
        [id, theses[0].id]
      );
      eq(links.length, 1, 'expected thesis link to exist');
      eq(links[0].is_primary, true, 'is_primary should round-trip');
      eq(links[0].confidence, 'manual', 'confidence should round-trip');
      eq(links[0].tagged_by, 'test', 'tagged_by should round-trip');
      eq(Number(links[0].weight), 75, 'weight should round-trip');

      const removed = await untagInvestment(id, theses[0].id);
      if (!removed) throw new Error('untagInvestment should delete the row');

      const after = await query(
        `SELECT COUNT(*)::int AS n FROM investment_theses WHERE investment_id = $1 AND thesis_id = $2`,
        [id, theses[0].id]
      );
      eq(after[0].n, 0, 'thesis link should be removed');
    } finally {
      await cleanupCompany(company);
    }
  });

  await test('setConviction updates conviction_now and conviction_entry', async () => {
    const company = `Test Conviction ${stamp}-7`;
    try {
      const { id } = await upsertInvestment({
        ...BASE_FIELDS,
        status: 'Live',
        company_name: company,
        invest_date: '2026-02-05',
      });

      const updated = await setConviction(id, { now: 4.5, entry: 3.5 });
      if (!updated) throw new Error('setConviction should update the investment');
      eq(Number(updated.conviction_now), 4.5, 'conviction_now should round-trip');
      eq(Number(updated.conviction_entry), 3.5, 'conviction_entry should round-trip');

      const rows = await query(
        `SELECT conviction_now, conviction_entry FROM investments WHERE id = $1`,
        [id]
      );
      eq(Number(rows[0].conviction_now), 4.5, 'stored conviction_now');
      eq(Number(rows[0].conviction_entry), 3.5, 'stored conviction_entry');
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
