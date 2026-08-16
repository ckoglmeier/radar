import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { recordDirectValuation } from './investments.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-direct-valuations-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [investment] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, realized_value,
         computed_net_invested, source, asset_class)
      VALUES ('Direct Mark Fixture', 'Live', '2024-01-01', 1000, 25,
              900, 'manual', 'direct')
      RETURNING *
    `);
    await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, source, external_hash,
         reconciliation_status, reconciled_at)
      VALUES ($1, '2025-01-01', 'distribution', 200, 'test',
              'direct-mark-distribution', 'matched', NOW())
    `, [investment.id]);

    const first = await recordDirectValuation(investment.id, {
      date: '2025-06-30', unrealizedValue: 1_600, proposalId: 'proposal-fixture',
    });
    assert.equal(Number(first.valuation.realized_value), 200);
    assert.equal(Number(first.valuation.net_value), 1_800);
    assert.equal(Number(first.valuation.multiple), 2);
    assert.equal((await recordDirectValuation(investment.id, {
      date: '2025-06-30', unrealizedValue: 1_600,
    })).idempotent_replay, true);

    const [current] = await query(`SELECT * FROM investments WHERE id = $1`, [investment.id]);
    assert.equal(Number(current.unrealized_value), 1_600);
    assert.equal(Number(current.computed_realized), 200);
    assert.equal(Number(current.computed_total_value), 1_800);
    assert.equal(Number(current.computed_multiple), 2);
    const [effective] = await query(`SELECT * FROM investments_effective WHERE id = $1`, [investment.id]);
    assert.equal(Number(effective.best_total_value), 1_800);
    assert.equal(Number(effective.best_multiple), 2);

    await assert.rejects(
      () => recordDirectValuation(investment.id, {
        date: '2025-06-30', unrealizedValue: 1_700,
      }),
      /Correction reason/,
    );
    const corrected = await recordDirectValuation(investment.id, {
      date: '2025-06-30', unrealizedValue: 1_700,
      correctionReason: 'Updated company report', proposalId: 'proposal-correction',
    });
    assert.equal(corrected.corrected, true);
    assert.equal(Number(corrected.valuation.net_value), 1_900);

    await recordDirectValuation(investment.id, {
      date: '2024-12-31', unrealizedValue: 700,
    });
    const [afterHistory] = await query(`SELECT * FROM investments WHERE id = $1`, [investment.id]);
    assert.equal(Number(afterHistory.unrealized_value), 1_700, 'historical mark cannot replace current summary');
    assert.equal(Number(afterHistory.computed_total_value), 1_900);

    await assert.rejects(
      () => recordDirectValuation(investment.id, {
        date: '2999-01-01', unrealizedValue: 1,
      }),
      /future/,
    );
    const [fund] = await query(`
      INSERT INTO investments (company_name, source, asset_class)
      VALUES ('Wrong Target Fund', 'fund_manual', 'fund') RETURNING id
    `);
    await assert.rejects(
      () => recordDirectValuation(fund.id, {
        date: '2025-01-01', unrealizedValue: 1,
      }),
      /Direct investment/,
    );

    const [correctionEvent] = await query(`
      SELECT notes FROM investment_events
       WHERE investment_id = $1 AND event_type = 'direct_valuation_corrected'
    `, [investment.id]);
    assert.match(correctionEvent.notes, /proposal-correction/);
  });
  console.log('Direct valuation tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
