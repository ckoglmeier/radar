import test from 'node:test';
import assert from 'node:assert/strict';
import { vestedUnitsAt } from '../index.mjs';
import { first, run } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeScenario, makeScenarioSet } from './fixtures/index.mjs';

const noLiq = { liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' } };
const vestedAtService = (serviceMonths, grantOver = {}) =>
  first({ offer: makeOffer({ grants: [makeGrant(grantOver)] }), set: makeScenarioSet([makeScenario({ serviceMonths, ...noLiq })]) }).grants[0].vestedUnits;

test('service end is the N-month anniversary', () => {
  assert.equal(vestedAtService(12), '12000'); // 25% on the cliff
  assert.equal(vestedAtService(11), '0');
  assert.equal(vestedAtService(48), '48000');
  assert.equal(vestedAtService(0), '0');
  const t0 = { vesting: { commencementDate: f('2026-01-15'), totalMonths: 0, cliffMonths: 0, cadence: 'monthly', acceleration: 'none' } };
  assert.equal(vestedAtService(0, t0), '48000');
  assert.equal(vestedUnitsAt(makeGrant(), '2030-01-15').units, '48000');
});

test('48 service months produce 48 monthly pay flows', () => {
  const s = first({ offer: makeOffer({ grants: [] }), set: makeScenarioSet([makeScenario({ serviceMonths: 48, ...noLiq })]) });
  const base = s.cashFlows.filter((c) => c.kind === 'base');
  assert.equal(base.length, 48);
  assert.equal(base[0].date, '2026-01-15');
  assert.equal(base[47].date, '2029-12-15');
});

test('golden: hand-computed ISO case', () => {
  // 48,000 units x (11.00 - 1.00) = 480,000; cash forgone 800,000 - 600,000 = 200,000.
  // The 24-month post-termination window keeps the units exercisable at liquidity (month 60).
  const grant = makeGrant({ exercise: { postTerminationWindowMonths: f('24'), expirationYears: f('10'), earlyExercise: f(false) } });
  const r = run({
    group: makeGroup({ horizonMonths: 72 }),
    offer: makeOffer({ grants: [grant] }),
    set: makeScenarioSet([makeScenario({
      serviceMonths: 48, liquidity: { occurs: true, monthsFromStart: 60 },
      payout: { method: 'common_per_share', commonProceedsPerShare: '11.00', source: 'Synthetic', asOfDate: '2026-01-10' },
    })]),
  });
  const s = r.scenarios[0];
  assert.equal(s.grants[0].vestedUnits, '48000');
  assert.equal(s.grants[0].eligibleUnits, '48000');
  assert.equal(s.grants[0].realizedProceeds, '480000.00');
  assert.equal(s.cash.totalCashDifference, '200000.00');
  assert.equal(s.netPreTax, '280000.00');
  assert.equal(s.breakEvenCommonPrice, '5.166667');
  assert.equal(s.npv, null);
});
