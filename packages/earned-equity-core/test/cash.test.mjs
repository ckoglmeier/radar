import test from 'node:test';
import assert from 'node:assert/strict';
import { first } from './helpers.mjs';
import { f, makeGroup, makeOffer, makeScenario, makeScenarioSet } from './fixtures/index.mjs';

const cashOffer = (cash, grants = []) => makeOffer({ cash: { annualBase: f('150000'), annualTargetBonus: f('0'), signingBonus: f('0'), signingRepaymentMonths: null, ...cash }, grants });

test('negative cash sacrifice is preserved', () => {
  const s = first({ offer: cashOffer({ annualBase: f('250000') }) });
  assert.equal(s.cash.baseDifference, '-200000.00');
  assert.equal(s.cash.totalCashDifference, '-200000.00');
  assert.equal(s.netPreTax, '200000.00');
});

test('missing baseline gives null differences with baseline_missing', () => {
  const s = first({ group: makeGroup({ baseline: { kind: 'none', annualBase: null, annualCashBonus: null } }) });
  assert.equal(s.cash.baseDifference, null);
  assert.equal(s.cash.totalCashDifference, null);
  assert.equal(s.netPreTax, null);
  assert.ok(s.limitations.includes('baseline_missing'));
});

test('bonus is reported separately and flagged uncertain', () => {
  const s = first({ offer: cashOffer({ annualTargetBonus: f('30000') }) });
  assert.equal(s.cash.offerBonus, '120000.00');
  assert.equal(s.cash.baseDifference, '200000.00');
  assert.equal(s.cash.totalCashDifference, '80000.00');
  assert.ok(s.limitations.includes('bonus_uncertain'));
  assert.ok(!first().limitations.includes('bonus_uncertain'));
});

test('signing bonus and repayment are dated flows', () => {
  const set = makeScenarioSet([makeScenario({ serviceMonths: 12, liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' } })]);
  const s = first({ offer: cashOffer({ signingBonus: f('10000'), signingRepaymentMonths: 24 }), set });
  const signing = s.cashFlows.filter((c) => c.kind.startsWith('signing'));
  assert.deepEqual(signing, [
    { date: '2026-01-15', amount: '10000.00', kind: 'signing' },
    { date: '2027-01-15', amount: '-10000.00', kind: 'signing_repayment' },
  ]);
  assert.equal(s.netPreTax, '-50000.00');
  assert.ok(s.limitations.includes('post_service_cash_unmodeled'));
  const kept = first({ offer: cashOffer({ signingBonus: f('10000'), signingRepaymentMonths: 6 }), set });
  assert.equal(kept.cashFlows.filter((c) => c.kind === 'signing_repayment').length, 0);
  assert.equal(kept.netPreTax, '-40000.00');
});

test('post-service cash is modeled when provided', () => {
  const set = makeScenarioSet([makeScenario({ serviceMonths: 24, postServiceAnnualCash: '60000', liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' } })]);
  const s = first({ offer: cashOffer({}), set });
  assert.equal(s.cash.offerBase, '420000.00'); // 24 x 12,500 + 24 x 5,000
  assert.equal(s.cash.baselineBase, '800000.00');
  assert.ok(!s.limitations.includes('post_service_cash_unmodeled'));
});
