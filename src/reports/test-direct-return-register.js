#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { metricQuery } from '../metrics/registry.js';
import { directReturnRegister } from './portfolio.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-direct-return-register-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const asOf = '2026-08-21';

async function position({
  company,
  date,
  invested,
  realized = null,
  unrealized = null,
  net = null,
  assetClass = 'direct',
}) {
  const [row] = await query(`
    INSERT INTO investments
      (company_name, status, invest_date, invested, realized_value,
       unrealized_value, net_value, source, asset_class)
    VALUES ($1,'Live',$2,$3,$4,$5,$6,'test',$7)
    RETURNING id
  `, [company, date, invested, realized, unrealized, net, assetClass]);
  return Number(row.id);
}

async function flow(investmentId, date, type, amount) {
  await query(`
    INSERT INTO cash_flows (investment_id, flow_date, type, amount)
    VALUES ($1,$2,$3,$4)
  `, [investmentId, date, type, amount]);
}

function approx(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`);
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const linked = await position({ company: 'Linked Ledger', date: '2022-01-01', invested: 100 });
    await flow(linked, '2022-01-01', 'investment', -100);
    await flow(linked, '2024-01-01', 'distribution', 20);
    await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, realized_value, net_value, multiple, source)
      VALUES ($1,'2026-06-30',130,20,150,1.5,'test')
    `, [linked]);

    await position({ company: 'Basis Fallback', date: '2023-01-01', invested: 200 });

    const partial = await position({ company: 'Partial Ledger', date: '2024-01-01', invested: 300 });
    await flow(partial, '2024-01-01', 'investment', -100);

    const refunded = await position({ company: 'Refunded Basis', date: '2025-01-01', invested: 80 });
    await flow(refunded, '2025-01-01', 'investment', -100);
    await flow(refunded, '2025-02-01', 'refund', 20);

    const excludedFund = await position({
      company: 'Excluded Fund', date: '2023-01-01', invested: 5_000, assetClass: 'fund',
    });
    await flow(excludedFund, '2023-01-01', 'investment', -5_000);

    const register = await directReturnRegister({ asOf });
    assert.equal(register.as_of, asOf);
    assert.equal(register.scope, 'direct');
    assert.equal(register.invested_basis, 680);
    assert.equal(register.realized_value, 20);
    assert.equal(register.current_total_value, 730);
    assert.equal(register.unrealized_terminal_value, 710);
    approx(register.dpi, 20 / 680);
    approx(register.tvpi, 730 / 680);
    assert.notEqual(register.irr, null);
    assert.equal(register.coverage.irr.state, 'available');
    assert.deepEqual(register.coverage.irr.opening_flow_sources, {
      linked_ledger: 2,
      position_basis_fallback: 2,
    });
    assert.equal(register.coverage.irr.current_mark_positions, 1);
    assert.equal(register.coverage.irr.dated_positive_return_positions, 1);
    assert.equal(register.coverage.cash_activity.linked_flow_count, 5);
    assert.equal(register.coverage.cash_activity.linked_invested_amount, 300);
    assert.equal(register.coverage.cash_activity.linked_returned_amount, 40);
    assert.deepEqual(register.coverage.irr.unresolved_positions, []);

    for (const metric of ['dpi', 'tvpi', 'irr']) {
      const result = await metricQuery({ metric });
      const parityRegister = await directReturnRegister({ asOf: result.asOf });
      const row = result.rows[0];
      assert.equal(row.value, parityRegister[metric]);
      assert.equal(row.details.invested_basis, parityRegister.invested_basis);
      assert.equal(row.details.realized_value, parityRegister.realized_value);
      assert.equal(row.details.current_total_value, parityRegister.current_total_value);
      assert.equal(row.details.unrealized_terminal_value, parityRegister.unrealized_terminal_value);
      assert.deepEqual(row.coverage, parityRegister.coverage[metric]);
    }

    await position({
      company: 'Undated Proceeds', date: '2024-03-01', invested: 100, realized: 50,
    });
    const unavailable = await directReturnRegister({ asOf });
    assert.equal(unavailable.irr, null);
    assert.equal(unavailable.coverage.irr.state, 'unavailable');
    assert.deepEqual(unavailable.coverage.irr.unresolved_positions, [{
      id: 6,
      company_name: 'Undated Proceeds',
      reasons: ['realized_value_exceeds_dated_distributions'],
    }]);
    assert.equal(unavailable.current_total_value, 780);
    assert.equal(unavailable.unrealized_terminal_value, 710);
  });

  console.log('direct return register: canonical basis, parity, coverage, and fail-closed IRR passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
