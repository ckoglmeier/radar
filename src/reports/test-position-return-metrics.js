#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { positionReturnMetrics } from './portfolio.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-position-return-metrics-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [alpha] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, carry, source, asset_class, stage_bucket)
      VALUES ('Alpha', 'Live', '2022-01-01', 100, '20%', 'test', 'direct', 'seed') RETURNING id
    `);
    const [beta] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, source, asset_class, stage_bucket)
      VALUES ('Beta', 'Live', '2023-01-01', 100, 'test', 'direct', 'seed') RETURNING id
    `);
    await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, realized_value, net_value, multiple, source)
      VALUES ($1, '2026-06-30', 180, 0, 180, 1.8, 'private_mark_research')
    `, [alpha.id]);
    await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, realized_value, net_value, multiple, source)
      VALUES ($1, '2026-06-30', 300, 0, 300, 3, 'company_report')
    `, [beta.id]);

    const report = await positionReturnMetrics({
      asOf: '2026-08-24', filters: { assetType: 'direct', stage: 'seed' }, limit: 2,
    });
    assert.deepEqual(report.positions.map(row => row.company_name), ['Beta', 'Alpha']);
    assert.equal(report.positions[0].net_moic, 3);
    assert.equal(report.positions[0].current_gross_value, 300);
    assert.equal(report.positions[1].net_moic, 1.8);
    assert.equal(report.positions[1].current_gross_value, 200);
    assert.deepEqual(report.positions[1].economics, {
      carry_percent: 20, carry_application: 'profit_only',
    });
    assert.deepEqual(report.positions[1].assumptions.at(-1), {
      field: 'current_gross_value', state: 'estimated', source: 'net_value_and_recorded_carry',
    });
  });
  console.log('position return metrics: ranking, marks, and carry assumptions passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
