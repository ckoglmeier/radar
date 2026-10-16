import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOffer, ownershipRetentionPct } from '../index.mjs';
import { first } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeScenario, makeScenarioSet, missing } from './fixtures/index.mjs';

const sc = (over) => makeScenarioSet([makeScenario(over)]);
const withGrant = (over) => makeOffer({ grants: [makeGrant(over)] });

test('baseline case is exact', () => {
  const s = first();
  assert.equal(s.cash.offerBase, '600000.00');
  assert.equal(s.cash.baselineBase, '800000.00');
  assert.equal(s.cash.baseDifference, '200000.00');
  assert.equal(s.grants[0].vestedUnits, '48000');
  assert.equal(s.grants[0].realizedProceeds, '192000.00');
  assert.equal(s.netPreTax, '-8000.00');
  assert.ok(s.limitations.includes('pre_tax_only'));
});

test('below strike is worth zero when exercised at liquidity', () => {
  const s = first({ set: sc({ payout: { method: 'common_per_share', commonProceedsPerShare: '0.50', source: 'x', asOfDate: '2026-01-10' } }) });
  assert.equal(s.grants[0].realizedProceeds, '0.00');
  assert.equal(s.netPreTax, '-200000.00');
});

test('at_date exercise loss is preserved, not floored', () => {
  const s = first({ set: sc({
    exercisePath: { kind: 'at_date', exerciseMonthsFromStart: 24 },
    payout: { method: 'common_per_share', commonProceedsPerShare: '0.50', source: 'x', asOfDate: '2026-01-10' },
  }) });
  assert.equal(s.grants[0].exerciseCost, '24000.00');
  assert.equal(s.grants[0].realizedProceeds, '12000.00');
  const ex = s.cashFlows.find((c) => c.kind === 'exercise');
  assert.deepEqual(ex, { date: '2028-01-15', amount: '-24000.00', kind: 'exercise' });
  assert.equal(s.maxCumulativeFundingNeed, '24000.00');
  assert.equal(s.netPreTax, '-212000.00');
});

test('zero strike differs from missing strike', () => {
  const zero = first({ offer: withGrant({ strikePrice: f('0') }) });
  assert.equal(zero.grants[0].realizedProceeds, '240000.00');
  assert.equal(zero.netPreTax, '40000.00');
  const miss = first({ offer: withGrant({ strikePrice: missing() }) });
  assert.equal(miss.grants[0].realizedProceeds, null);
  assert.equal(miss.netPreTax, null);
  assert.ok(miss.limitations.includes('strike_price_missing'));
});

test('10% then 20% dilution retains exactly 72%', () => {
  assert.equal(ownershipRetentionPct(['0.1', '0.2']), '72.0000');
  const set = sc({ payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: ['0.1', '0.2'] } });
  const s = first({ set });
  // 0.5% x 0.72 x 1,000,000,000 = 3,600,000 gross; minus 48,000 strike cost.
  assert.equal(s.grants[0].realizedProceeds, '3552000.00');
  assert.ok(s.limitations.includes('excludes_preferences'));
  const none = first({ set: sc({ payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: [] } }) });
  assert.equal(none.grants[0].realizedProceeds, '4952000.00');
});

test('ownership method needs units and strike for net', () => {
  const set = sc({ payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: [] } });
  const s = first({ offer: withGrant({ units: missing() }), set });
  assert.equal(s.grants[0].realizedProceeds, null);
  assert.ok(s.limitations.includes('exercise_cost_unknown'));
  assert.equal(s.netPreTax, null);
});

test('share-based methods reject dilution', () => {
  for (const payout of [
    { method: 'pro_rata_shares', equityExitValue: '480000000', fullyDilutedExitShares: '96000000', dilutionRounds: ['0.1'] },
    { method: 'common_per_share', commonProceedsPerShare: '5', source: 'x', asOfDate: '2026-01-10', dilutionRounds: ['0.1'] },
  ]) {
    const out = calculateOffer({ group: makeGroup(), offerRevision: makeOffer(), scenarioSet: sc({ payout }) });
    assert.equal(out.ok, false);
    assert.equal(out.errors[0].code, 'dilution_not_allowed');
  }
  const ok = first({ set: sc({ payout: { method: 'pro_rata_shares', equityExitValue: '480000000', fullyDilutedExitShares: '96000000' } }) });
  assert.equal(ok.grants[0].realizedProceeds, '192000.00');
  assert.ok(ok.limitations.includes('excludes_preferences'));
});

test('no liquidity separates the illiquid residual', () => {
  const s = first({ set: sc({ liquidity: { occurs: false, monthsFromStart: null } }) });
  assert.equal(s.grants[0].realizedProceeds, '0.00');
  assert.equal(s.grants[0].illiquidResidual.units, '48000');
  assert.ok(s.limitations.includes('no_liquidity_in_horizon'));
  assert.equal(s.netPreTax, '-200000.00');
});

test('liquidity beyond the horizon separates the residual', () => {
  const s = first({ set: sc({ serviceMonths: 60, liquidity: { occurs: true, monthsFromStart: 59 } }) });
  assert.equal(s.grants[0].realizedProceeds, '0.00');
  assert.equal(s.grants[0].illiquidResidual.units, '48000');
  assert.ok(s.limitations.includes('no_liquidity_in_horizon'));
});

test('post-termination window handling', () => {
  const early = { serviceMonths: 24, liquidity: { occurs: true, monthsFromStart: 40 } };
  const expired = first({ set: sc(early) });
  assert.equal(expired.grants[0].vestedUnits, '24000');
  assert.equal(expired.grants[0].eligibleUnits, '0');
  assert.equal(expired.grants[0].realizedProceeds, '0.00');
  const unknown = first({ offer: withGrant({ exercise: { postTerminationWindowMonths: missing(), expirationYears: f('10'), earlyExercise: f(false) } }), set: sc(early) });
  assert.equal(unknown.grants[0].eligibleUnits, null);
  assert.equal(unknown.netPreTax, null);
  assert.ok(unknown.limitations.includes('exercise_window_unknown'));
  const long = first({ offer: withGrant({ exercise: { postTerminationWindowMonths: f('24'), expirationYears: f('10'), earlyExercise: f(false) } }), set: sc(early) });
  assert.equal(long.grants[0].eligibleUnits, '24000');
  assert.equal(long.grants[0].realizedProceeds, '96000.00');
  assert.ok(long.limitations.includes('post_service_cash_unmodeled'));
});

test('grant expiry before liquidity makes units ineligible', () => {
  const s = first({ offer: withGrant({ exercise: { postTerminationWindowMonths: f('3'), expirationYears: f('2'), earlyExercise: f(false) } }) });
  assert.equal(s.grants[0].eligibleUnits, '0');
  assert.equal(s.grants[0].realizedProceeds, '0.00');
});

test('currency mismatch is an error', () => {
  const a = calculateOffer({ group: makeGroup(), offerRevision: makeOffer({ currency: 'EUR' }), scenarioSet: makeScenarioSet() });
  assert.equal(a.ok, false);
  assert.equal(a.errors[0].code, 'currency_mismatch');
  const b = calculateOffer({ group: makeGroup(), offerRevision: makeOffer(), scenarioSet: makeScenarioSet([makeScenario()], { currency: 'EUR' }) });
  assert.equal(b.ok, false);
  assert.equal(b.errors[0].code, 'currency_mismatch');
});

test('missing service start is an error', () => {
  const out = calculateOffer({ group: makeGroup(), offerRevision: makeOffer({ serviceStartDate: missing() }), scenarioSet: makeScenarioSet() });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'service_start_unusable');
});

test('illustrative values are ignored with a limitation', () => {
  const s = first({ offer: withGrant({ units: f('48000', 'illustrative') }) });
  assert.equal(s.grants[0].vestedUnits, null);
  assert.equal(s.netPreTax, null);
  assert.ok(s.limitations.includes('illustrative_value_ignored:units'));
});

test('unsupported instrument gives null with a limitation', () => {
  const s = first({ offer: withGrant({ instrument: 'rsu' }) });
  assert.equal(s.grants[0].realizedProceeds, null);
  assert.equal(s.netPreTax, null);
  assert.ok(s.limitations.includes('instrument_unsupported:rsu'));
});

test('unsupported vesting cadence nulls the equity result', () => {
  const s = first({ offer: withGrant({ vesting: { commencementDate: f('2026-01-15'), totalMonths: 48, cliffMonths: 12, cadence: 'performance', acceleration: 'none' } }) });
  assert.equal(s.netPreTax, null);
  assert.ok(s.limitations.includes('vesting_unsupported'));
});

test('npv only when a discount rate is given', () => {
  assert.equal(first().npv, null);
  assert.ok(first().limitations.includes('discount_rate_missing'));
  assert.notEqual(first({ group: makeGroup({ discountRateAnnual: '0.1' }) }).npv, null);
});
