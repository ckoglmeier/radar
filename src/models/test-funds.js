import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  archiveFund,
  createCapitalCallNotice,
  createFund,
  createFundProfile,
  fundMetrics,
  fundSummary,
  getFund,
  listFunds,
  recordFundDistribution,
  recordFundFee,
  recordFundValuation,
  restoreFund,
  settleCapitalCall,
  updateFund,
  updateFundCommitment,
  voidAndReplaceFundTransaction,
} from './funds.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-funds-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const created = await createFund({
      legalName: 'Range Fund Test I, LP',
      commitmentDate: '2024-01-15',
      ownershipEntity: 'Test Family LLC',
      manager: 'Range Test GP',
      strategy: 'Venture',
      vintageYear: 2024,
      commitment: 200,
      initialContribution: 100,
      initialContributionDate: '2024-02-01',
      initialNav: 125,
      initialNavDate: '2024-12-31',
      migrationKey: 'test:range-i',
    });
    const fundId = Number(created.investment.id);
    assert.equal(created.investment.asset_class, 'fund');
    assert.equal(created.profile.fund_status, 'active');

    let metrics = await fundMetrics(fundId);
    assert.deepEqual(metrics.coverage, {
      paid_in: 'complete',
      nav: 'complete',
      commitment: 'complete',
    });
    assert.equal(metrics.commitment, 200);
    assert.equal(metrics.paid_in, 100);
    assert.equal(metrics.distributed, 0);
    assert.equal(metrics.nav, 125);
    assert.equal(metrics.unfunded, 100);
    assert.equal(metrics.dpi, 0);
    assertClose(metrics.tvpi, 1.25);

    const call = await createCapitalCallNotice(fundId, {
      noticeDate: '2025-01-10',
      dueDate: '2025-01-31',
      amount: 50,
      description: 'Second call',
      externalHash: 'test:call:2',
    });
    const replayedCall = await createCapitalCallNotice(fundId, {
      noticeDate: '2025-01-10',
      dueDate: '2025-01-31',
      amount: 50,
      externalHash: 'test:call:2',
    });
    assert.equal(replayedCall.idempotent_replay, true);
    assert.equal(replayedCall.notice.id, call.notice.id);
    await assert.rejects(
      () => createCapitalCallNotice(fundId, {
        noticeDate: '2025-01-10',
        amount: 51,
        externalHash: 'test:call:2',
      }),
      /idempotency key conflicts/,
    );
    assert.equal((await fundMetrics(fundId)).paid_in, 100, 'open notice is not paid-in capital');

    const settlement = await settleCapitalCall(call.notice.id, {
      settlementDate: '2025-01-25',
      amount: 50,
      externalHash: 'test:call:2:settlement',
    });
    const replayedSettlement = await settleCapitalCall(call.notice.id, {
      settlementDate: '2025-01-25',
      amount: 50,
      externalHash: 'test:call:2:settlement',
    });
    assert.equal(replayedSettlement.idempotent_replay, true);
    assert.equal(replayedSettlement.transaction.id, settlement.transaction.id);
    await assert.rejects(
      () => recordFundFee(fundId, {
        date: '2025-01-26',
        amount: 1,
        externalHash: 'test:call:2:settlement',
      }),
      /idempotency key conflicts/,
    );

    const distribution = await recordFundDistribution(fundId, {
      date: '2025-02-15',
      amount: 25,
      description: 'First distribution',
      externalHash: 'test:distribution:1',
    });
    const fee = await recordFundFee(fundId, {
      date: '2025-02-20',
      amount: 5,
      description: 'Administrative fee',
      externalHash: 'test:fee:1',
    });
    assert.equal(Number(fee.cash_flow.amount), -5);

    metrics = await fundMetrics(fundId);
    assert.equal(metrics.paid_in, 150);
    assert.equal(metrics.distributed, 25);
    assert.equal(metrics.fees_to_date, 5);
    assert.equal(metrics.unfunded, 50);
    assertClose(metrics.dpi, 25 / 150);
    assertClose(metrics.tvpi, 150 / 150);

    await assert.rejects(
      () => query(`
        INSERT INTO cash_flows (investment_id, flow_date, type, amount, source)
        VALUES ($1, '2025-03-01', 'fee', 5, 'test')
      `, [fundId]),
      /cf_fee_negative|check constraint/i,
    );
    await assert.rejects(
      () => query(`UPDATE cash_flows SET amount = 999 WHERE id = $1`, [distribution.cash_flow.id]),
      /posted Fund cash-flow facts are immutable/,
    );
    await assert.rejects(
      () => query(`UPDATE fund_transactions SET activity_type = 'fee' WHERE id = $1`, [distribution.transaction.id]),
      /posted fund transaction facts are immutable/i,
    );

    const replacement = await voidAndReplaceFundTransaction(distribution.transaction.id, {
      reason: 'Corrected GP statement',
      date: '2025-02-15',
      amount: 30,
      description: 'Corrected first distribution',
      externalHash: 'test:distribution:1:corrected',
    });
    assert.ok(replacement.replacement.transaction.id);
    metrics = await fundMetrics(fundId);
    assert.equal(metrics.distributed, 30);
    assert.equal((await query(`SELECT * FROM cash_flows WHERE id = $1`, [distribution.cash_flow.id])).length, 1);

    await updateFundCommitment(fundId, 250, 'Approved commitment increase');
    metrics = await fundMetrics(fundId);
    assert.equal(metrics.commitment, 250);
    assert.equal(metrics.unfunded, 100);
    const commitmentEvents = await query(`
      SELECT * FROM investment_events
       WHERE investment_id = $1 AND event_type = 'fund_commitment_changed'
    `, [fundId]);
    assert.equal(commitmentEvents.length, 1);

    const valuation = await recordFundValuation(fundId, {
      date: '2025-03-31',
      nav: 150,
    });
    assert.equal(valuation.idempotent_replay, false);
    assert.equal((await recordFundValuation(fundId, {
      date: '2025-03-31',
      nav: 150,
    })).idempotent_replay, true);
    await assert.rejects(
      () => recordFundValuation(fundId, { date: '2025-03-31', nav: 151 }),
      /Correction reason is required/,
    );
    const correctedValuation = await recordFundValuation(fundId, {
      date: '2025-03-31',
      nav: 151,
      correctionReason: 'Corrected quarterly statement',
    });
    assert.equal(correctedValuation.corrected, true);
    assert.equal(Number(correctedValuation.valuation.net_value), 151);
    assert.equal((await query(`
      SELECT COUNT(*) AS count FROM investment_events
       WHERE investment_id = $1 AND event_type = 'fund_valuation_corrected'
    `, [fundId]))[0].count, 1);

    await updateFund(fundId, { fundStatus: 'harvesting', manager: 'Range Test GP II' });
    assert.equal((await getFund(fundId)).fund_status, 'harvesting');
    assert.equal((await query(`SELECT status FROM investments WHERE id = $1`, [fundId]))[0].status, 'Live');
    await archiveFund(fundId);
    assert.equal((await listFunds()).length, 0);
    assert.equal((await listFunds({ includeArchived: true })).length, 1);
    await restoreFund(fundId);
    assert.equal((await listFunds()).length, 1);
    assert.equal((await fundSummary()).fund_count, 1);

    const [operatingEntity] = await query(`
      INSERT INTO portfolio_entities (legal_name, normalized_name, entity_type)
      VALUES ('Not A Fund, Inc.', 'not a fund', 'operating_company') RETURNING id
    `);
    const [directPosition] = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, asset_class, source)
      VALUES ($1, 'Not A Fund, Inc.', 'Live', '2024-04-01', 'direct', 'test') RETURNING id
    `, [operatingEntity.id]);
    const [directValuation] = await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, net_value, source)
      VALUES ($1, '2025-01-01', 100, 100, 'manual') RETURNING id
    `, [directPosition.id]);
    await assert.rejects(
      () => query(`UPDATE valuations SET net_value = 101 WHERE id = $1`, [directValuation.id]),
      /valuations table is append-only/,
    );
    await assert.rejects(
      () => createFundProfile(directPosition.id, { commitment: 100 }),
      /Fund position linked to a fund_vehicle entity/,
    );

    const beforeRollback = {
      entities: Number((await query(`SELECT COUNT(*) AS count FROM portfolio_entities`))[0].count),
      investments: Number((await query(`SELECT COUNT(*) AS count FROM investments`))[0].count),
    };
    await assert.rejects(
      () => createFund({
        legalName: 'Duplicate Migration Key LP',
        commitmentDate: '2025-01-01',
        migrationKey: 'test:range-i',
      }),
      /migration_key|unique/i,
    );
    assert.deepEqual({
      entities: Number((await query(`SELECT COUNT(*) AS count FROM portfolio_entities`))[0].count),
      investments: Number((await query(`SELECT COUNT(*) AS count FROM investments`))[0].count),
    }, beforeRollback, 'failed Fund create rolls back entity and position');

    await assert.rejects(
      () => recordFundFee(fundId, { date: '2025-04-01', amount: 1, currency: 'EUR' }),
      /USD workspace amounts/,
    );

    const [otherFund] = await query(`
      INSERT INTO portfolio_entities (legal_name, normalized_name, entity_type)
      VALUES ('Other Fund LP', 'other fund', 'fund_vehicle') RETURNING id
    `);
    const [otherPosition] = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, asset_class, source)
      VALUES ($1, 'Other Fund LP', 'Live', '2025-01-01', 'fund', 'test') RETURNING id
    `, [otherFund.id]);
    await createFundProfile(otherPosition.id);
    const [otherCash] = await query(`
      INSERT INTO cash_flows (investment_id, flow_date, type, amount, source)
      VALUES ($1, '2025-01-02', 'investment', -10, 'test') RETURNING id
    `, [otherPosition.id]);
    await assert.rejects(
      () => query(`
        INSERT INTO fund_transactions
          (investment_id, cash_flow_id, activity_type)
        VALUES ($1, $2, 'contribution')
      `, [fundId, otherCash.id]),
      /belongs to another position/,
    );
  });

  console.log('funds: typed ledger, metrics, immutability, corrections, and rollback passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
