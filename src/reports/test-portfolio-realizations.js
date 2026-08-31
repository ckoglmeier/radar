import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  getDirectLifecycleEvent,
  recordDirectLifecycleEvent,
  voidDirectLifecycleEvent,
} from '../models/direct-lifecycle-events.js';
import { createFund, recordFundDistribution, updateFund } from '../models/funds.js';
import {
  createEmploymentEquityIssuer,
  createEmploymentEquityPosition,
  recordEmploymentEquityDisposition,
} from '../models/employment-equity.js';
import { portfolioRealizationEvents, positionLifecycleHistory } from './portfolio-realizations.js';
import { portfolioDetail, portfolioList } from './portfolio.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-portfolio-realizations-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

async function direct(name, fields = {}) {
  const [row] = await query(`
    INSERT INTO investments
      (company_name, status, invest_date, invested, unrealized_value, net_value, source, asset_class)
    VALUES ($1,$2,$3,$4,$5,$6,'test','direct') RETURNING *
  `, [
    name,
    fields.status || 'Live',
    fields.investDate || '2024-01-01',
    fields.invested ?? 1000,
    fields.unrealizedValue ?? null,
    fields.netValue ?? null,
  ]);
  return row;
}

async function distribution(investmentId, date, amount, fields = {}) {
  const [row] = await query(`
    INSERT INTO cash_flows
      (investment_id, flow_date, type, subtype, amount, description, source,
       external_hash, reconciliation_status, reconciled_at)
    VALUES ($1,$2,'distribution',$3,$4,$5,'test',$6,$7,
            CASE WHEN $7 = 'matched' THEN NOW() ELSE NULL END)
    RETURNING *
  `, [
    investmentId, date, fields.subtype || 'secondary_sale', amount,
    fields.description || 'Disposition proceeds',
    fields.externalHash || `test-distribution:${investmentId}:${date}:${amount}`,
    fields.reconciliationStatus || 'matched',
  ]);
  return row;
}

async function tableCounts() {
  const names = [
    'direct_position_lifecycle_events', 'cash_flows', 'valuations',
    'fund_transactions', 'employment_equity_events', 'investment_lot_allocations',
  ];
  const result = {};
  for (const name of names) result[name] = Number((await query(`SELECT COUNT(*) AS count FROM ${name}`))[0].count);
  return result;
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const exited = await direct('Full Exit Co', { status: 'Realized', invested: 1000, unrealizedValue: 0, netValue: 1500 });
    await distribution(exited.id, '2026-01-10', 200, { externalHash: 'exit-installment:1' });
    const exitFlow = await distribution(exited.id, '2026-02-10', 1500);
    const first = await recordDirectLifecycleEvent(exited.id, {
      date: '2026-02-10', eventType: 'full_exit', remainingInterest: 'no',
      cashFlowId: exitFlow.id, evidenceNote: 'Closing statement', idempotencyKey: 'exit:full:1',
    });
    assert.equal(first.idempotent_replay, false);
    const replay = await recordDirectLifecycleEvent(exited.id, {
      date: '2026-02-10', eventType: 'full_exit', remainingInterest: 'no',
      cashFlowId: exitFlow.id, evidenceNote: 'Closing statement', idempotencyKey: 'exit:full:1',
    });
    assert.equal(replay.idempotent_replay, true);
    const [cumulativeExit] = await query(`
      SELECT status, best_unrealized_value, best_realized, best_total_value,
             best_multiple, lifecycle_closed
      FROM investments_effective WHERE id = $1
    `, [exited.id]);
    assert.equal(cumulativeExit.status, 'Realized');
    assert.equal(cumulativeExit.lifecycle_closed, true);
    assert.equal(Number(cumulativeExit.best_unrealized_value), 0);
    assert.equal(Number(cumulativeExit.best_realized), 1700,
      'every matched exit distribution contributes to realized proceeds');
    assert.equal(Number(cumulativeExit.best_total_value), 1700,
      'closed-position net value equals cumulative realized proceeds');
    assert.equal(Number(cumulativeExit.best_multiple), 1.7);
    await assert.rejects(
      () => recordDirectLifecycleEvent(exited.id, {
        date: '2026-02-11', eventType: 'full_exit', remainingInterest: 'no',
        cashFlowId: exitFlow.id, idempotencyKey: 'exit:full:1',
      }),
      /idempotency key conflicts/,
    );
    await assert.rejects(
      () => query(`UPDATE direct_position_lifecycle_events SET event_date = '2026-02-11' WHERE id = $1`, [first.event.id]),
      /immutable/,
    );
    await assert.rejects(
      () => query(`DELETE FROM direct_position_lifecycle_events WHERE id = $1`, [first.event.id]),
      /append-only/,
    );

    const partialPosition = await direct('Partial Co', { invested: 1200, netValue: 1300 });
    const partialFlow = await distribution(partialPosition.id, '2026-03-05', 300);
    await recordDirectLifecycleEvent(partialPosition.id, {
      date: '2026-03-05', eventType: 'partial_liquidity', remainingInterest: 'yes',
      cashFlowId: partialFlow.id, idempotencyKey: 'partial:1',
    });

    const writeoff = await direct('Writeoff Co', { status: 'Written Off', invested: 500, unrealizedValue: 0, netValue: 0 });
    await recordDirectLifecycleEvent(writeoff.id, {
      date: '2026-04-01', eventType: 'write_off', remainingInterest: 'no',
      evidenceNote: 'Dissolution notice', idempotencyKey: 'writeoff:1',
    });

    const abandonment = await direct('Corrected Event Co', { status: 'Written Off', invested: 200, unrealizedValue: 0, netValue: 0 });
    const oldEvent = await recordDirectLifecycleEvent(abandonment.id, {
      date: '2026-05-01', eventType: 'abandonment', remainingInterest: 'no',
      idempotencyKey: 'abandonment:old',
    });
    const replacement = await recordDirectLifecycleEvent(abandonment.id, {
      date: '2026-05-02', eventType: 'write_off', remainingInterest: 'no',
      idempotencyKey: 'abandonment:replacement',
    });
    const voided = await voidDirectLifecycleEvent(oldEvent.event.id, {
      reason: 'Correct event date and type', replacementEventId: replacement.event.id,
    });
    assert.ok(voided.event.voided_at);
    assert.equal(voided.event.replacement_event_id, replacement.event.id);
    assert.equal((await getDirectLifecycleEvent(oldEvent.event.id)).void_reason, 'Correct event date and type');

    await direct('Undated Legacy Co', { status: 'Realized', invested: 250 });
    const pending = await direct('Pending Distribution Co', { invested: 400 });
    await distribution(pending.id, '2026-05-15', 40, { externalHash: 'pending-distribution:1' });
    await distribution(pending.id, '2026-06-01', 100, { reconciliationStatus: 'pending' });
    await distribution(pending.id, '2026-06-15', 60, { externalHash: 'pending-distribution:3' });
    const dissolutionCandidate = await direct('Dissolution Candidate Co', { invested: 600 });
    await distribution(dissolutionCandidate.id, '2026-06-02', 150, { subtype: 'dissolution' });
    const contradictory = await direct('Contradictory Exit Co', { status: 'Realized', invested: 700, unrealizedValue: 200, netValue: 900 });
    const contradictoryFlow = await distribution(contradictory.id, '2026-06-03', 900);
    await recordDirectLifecycleEvent(contradictory.id, {
      date: '2026-06-03', eventType: 'full_exit', remainingInterest: 'no',
      cashFlowId: contradictoryFlow.id, idempotencyKey: 'contradictory:1',
    });

    const [effectiveExit] = await query(`
      SELECT status, best_unrealized_value, best_realized, best_total_value,
             best_multiple, lifecycle_closed, effective_close_date
      FROM investments_effective WHERE id = $1
    `, [contradictory.id]);
    assert.equal(effectiveExit.status, 'Realized');
    assert.equal(effectiveExit.lifecycle_closed, true);
    assert.equal(Number(effectiveExit.best_unrealized_value), 0);
    assert.equal(Number(effectiveExit.best_realized), 900);
    assert.equal(Number(effectiveExit.best_total_value), 900);
    assert.equal(Number(effectiveExit.best_multiple), 900 / 700);
    assert.equal(new Date(effectiveExit.effective_close_date).toISOString().slice(0, 10), '2026-06-03');

    const listedExit = (await portfolioList()).find(row => Number(row.id) === Number(contradictory.id));
    assert.equal(Number(listedExit.unrealized_value), 0);
    assert.equal(Number(listedExit.realized_value), 900);
    assert.equal(Number(listedExit.net_value), 900);
    assert.equal(new Date(listedExit.closed_date).toISOString().slice(0, 10), '2026-06-03');

    const [detailExit] = await portfolioDetail('Contradictory Exit Co');
    assert.equal(detailExit.effective_status, 'Realized');
    assert.equal(detailExit.status, 'Realized');
    assert.equal(detailExit.recorded_status, 'Realized');
    const closedState = detailExit.valuation_history.find(row => row.kind === 'position_closed');
    assert.ok(closedState);
    assert.equal(Number(closedState.unrealized), 0);
    assert.equal(Number(closedState.realized), 900);
    assert.equal(Number(closedState.net), 900);

    const legacyClosed = await direct('Legacy Closed With Stale Mark Co', {
      status: 'Realized', invested: 500, unrealizedValue: 800, netValue: 800,
    });
    await distribution(legacyClosed.id, '2026-06-04', 725);
    const [legacyEffective] = await query(`
      SELECT status, best_unrealized_value, best_realized, best_total_value,
             lifecycle_closed, effective_close_date
      FROM investments_effective WHERE id = $1
    `, [legacyClosed.id]);
    assert.equal(legacyEffective.status, 'Realized');
    assert.equal(legacyEffective.lifecycle_closed, true);
    assert.equal(Number(legacyEffective.best_unrealized_value), 0);
    assert.equal(Number(legacyEffective.best_realized), 725);
    assert.equal(Number(legacyEffective.best_total_value), 725);
    assert.equal(new Date(legacyEffective.effective_close_date).toISOString().slice(0, 10), '2026-06-04');
    const refunded = await direct('Refund Co', { invested: 100 });
    await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, description, source,
         external_hash, reconciliation_status, reconciled_at)
      VALUES ($1,'2026-06-05','refund',50,'Returned allocation','test','refund:1','matched',NOW())
    `, [refunded.id]);
    await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, description, source,
         external_hash, reconciliation_status, reconciled_at)
      VALUES ($1,'2026-01-01','investment',-100,'Initial check','test','refund:investment','matched',NOW())
    `, [refunded.id]);
    const [refundedEffective] = await query(`
      SELECT best_invested_basis, cf_total_invested, cf_total_refunded
      FROM investments_effective WHERE id = $1
    `, [refunded.id]);
    assert.equal(Number(refundedEffective.best_invested_basis), 50);
    assert.equal(Number(refundedEffective.cf_total_invested), 100);
    assert.equal(Number(refundedEffective.cf_total_refunded), 50);
    const refundedList = (await portfolioList()).find(row => Number(row.id) === Number(refunded.id));
    assert.equal(Number(refundedList.invested), 50, 'list reports net basis after refunds');
    assert.equal(Number(refundedList.recorded_invested), 100, 'list preserves the recorded source fact');
    const [refundedDetail] = await portfolioDetail('Refund Co');
    assert.equal(Number(refundedDetail.invested), 50, 'detail reports net basis after refunds');
    assert.equal(Number(refundedDetail.recorded_invested), 100, 'detail preserves the recorded source fact');

    const activeFund = await createFund({
      legalName: 'Active Fund I', commitmentDate: '2025-01-01', fundStatus: 'active',
      commitment: 10000, initialContribution: 1000, initialContributionDate: '2025-01-01',
    });
    await recordFundDistribution(activeFund.investment.id, {
      date: '2026-07-01', amount: 250, currency: 'USD', externalHash: 'active-fund-dist',
    });
    const closedFund = await createFund({
      legalName: 'Closed Fund I', commitmentDate: '2024-01-01', fundStatus: 'active',
      commitment: 10000, initialContribution: 1000, initialContributionDate: '2024-01-01',
    });
    await recordFundDistribution(closedFund.investment.id, {
      date: '2026-07-02', amount: 1300, currency: 'USD', externalHash: 'closed-fund-dist',
    });
    await updateFund(closedFund.investment.id, { fundStatus: 'realized' });

    const fullIssuer = await createEmploymentEquityIssuer({ legalName: 'Employment Full Co' });
    const fullEmployment = await createEmploymentEquityPosition({
      portfolioEntityId: fullIssuer.entity.id, displayName: 'Employment Full Co Common',
      instrumentFamily: 'common_stock', investDate: '2023-01-01',
      firstLot: {
        acquisitionDate: '2023-01-01', instrumentType: 'common_stock',
        unitsAcquired: 10, taxBasis: 100, basisAsOfDate: '2023-01-01', basisSource: 'tax_record',
      },
    });
    await recordEmploymentEquityDisposition(fullEmployment.investment.id, {
      eventType: 'sale', date: '2026-08-01', amount: 200, currency: 'USD', externalHash: 'ee-full',
      allocations: [{
        lotId: fullEmployment.lot.id, units: 10,
        grossProceedsAllocated: 200, taxBasisAllocated: 100,
      }],
    });
    const partialIssuer = await createEmploymentEquityIssuer({ legalName: 'Employment Partial Co' });
    const partialEmployment = await createEmploymentEquityPosition({
      portfolioEntityId: partialIssuer.entity.id, displayName: 'Employment Partial Co Common',
      instrumentFamily: 'common_stock', investDate: '2023-01-01',
      firstLot: {
        acquisitionDate: '2023-01-01', instrumentType: 'common_stock',
        unitsAcquired: 10, taxBasis: 100, basisAsOfDate: '2023-01-01', basisSource: 'tax_record',
      },
    });
    await recordEmploymentEquityDisposition(partialEmployment.investment.id, {
      eventType: 'tender', date: '2026-08-02', amount: 60, currency: 'USD', externalHash: 'ee-partial',
      allocations: [{
        lotId: partialEmployment.lot.id, units: 3,
        grossProceedsAllocated: 60, taxBasisAllocated: 30,
      }],
    });
    const noDispositionIssuer = await createEmploymentEquityIssuer({ legalName: 'Employment No Disposition Co' });
    await createEmploymentEquityPosition({
      portfolioEntityId: noDispositionIssuer.entity.id,
      displayName: 'Employment No Disposition Co Options',
      instrumentFamily: 'iso', investDate: '2024-01-01',
      firstGrant: {
        legalInstrumentName: 'Option grant', instrumentType: 'iso',
        grantDate: '2024-01-01', unitsGranted: 100, unitsVestedConfirmed: 25, strikePrice: 1,
      },
    });

    const before = await tableCounts();
    const report = await portfolioRealizationEvents({
      since: '2026-01-01', until: '2026-12-31', includeCandidates: true, includeExcluded: true,
    });
    assert.deepEqual(await tableCounts(), before, 'report performed a write');
    assert.equal(report.schema_version, 1);
    assert.ok(report.confirmed.some(row => row.company_name === 'Full Exit Co' && row.economic_result === 'gain' && row.proceeds === 1700));
    assert.ok(!report.partial.some(row => row.company_name === 'Full Exit Co'), 'exit installments were double-counted as partial');
    assert.ok(report.confirmed.some(row => row.company_name === 'Writeoff Co' && row.economic_result === 'loss'));
    assert.ok(report.confirmed.some(row => row.company_name === 'Employment Full Co'));
    assert.ok(report.partial.some(row => row.company_name === 'Partial Co'));
    assert.ok(report.partial.some(row => row.company_name === 'Pending Distribution Co'));
    assert.equal(report.partial.filter(row => row.company_name === 'Pending Distribution Co').length, 3);
    assert.ok(report.partial.some(row => row.company_name === 'Employment Partial Co'));
    assert.ok(report.fund_activity.some(row => row.company_name === 'Active Fund I'));
    assert.ok(report.fund_activity.some(row => row.company_name === 'Closed Fund I' && row.remaining_interest === 'no'));
    assert.ok(report.candidates.some(row => row.company_name === 'Undated Legacy Co' && row.event_date == null));
    assert.ok(report.candidates.some(row => row.company_name === 'Dissolution Candidate Co' && row.event_type === 'dissolution'));
    assert.ok(![
      ...report.confirmed, ...report.partial, ...report.candidates,
    ].some(row => row.company_name === 'Employment No Disposition Co'));
    assert.ok(report.excluded.some(row => row.company_name === 'Refund Co' && row.event_type === 'refund'));
    assert.ok(report.coverage.some(row => row.code === 'PENDING_RECONCILIATION' && row.position_id === pending.id));
    assert.ok(report.coverage.some(row => row.code === 'MISSING_DISPOSITION_DATE'));
    assert.ok(report.coverage.some(row => row.code === 'CONTRADICTORY_RETURN_RECORD' && row.position_id === contradictory.id));
    assert.ok(report.confirmed.some(row => row.position_id === contradictory.id && row.economic_result === 'unknown'));
    assert.equal(report.confirmed.filter(row => row.company_name === 'Corrected Event Co').length, 1);

    const directOnly = await portfolioRealizationEvents({
      since: '2026-01-01', until: '2026-12-31', assetClasses: ['direct'],
      includeCandidates: false,
    });
    assert.ok(directOnly.confirmed.every(row => row.asset_class === 'direct'));
    assert.deepEqual(directOnly.candidates, []);
    assert.deepEqual(directOnly.fund_activity, []);

    const history = await positionLifecycleHistory({ positionId: exited.id, limit: 10 });
    assert.equal(history.position.position_id, exited.id);
    assert.equal(history.lifecycle_events.length, 1);
    assert.equal(history.cash_flows.length, 2);
    assert.ok(!JSON.stringify(history).includes('content_bytes'));
  });
  console.log('Portfolio realization ledger/report: typed lifecycle, coverage, asset boundaries, and read-only behavior passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
