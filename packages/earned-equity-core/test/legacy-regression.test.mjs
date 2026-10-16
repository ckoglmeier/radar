import test from 'node:test';
import assert from 'node:assert/strict';
import { vestedUnitsAt } from '../index.mjs';
import { run } from './helpers.mjs';
import { legacyGroup, legacyOffer, legacyScenarioSet, makeGroup } from './fixtures/index.mjs';

const legacy = (group = legacyGroup) => run({ group, offer: legacyOffer, set: legacyScenarioSet });

test('weights that imply a silent 38% zero remainder are rejected', () => {
  const r = legacy();
  assert.equal(r.weighted, null);
  assert.ok(r.limitations.includes('weights_not_100'));
});

test('a 3-year vest completes at 36 months, with no hardcoded 4-year divisor', () => {
  const g = legacyOffer.grants[0];
  assert.equal(vestedUnitsAt(g, '2027-01-15').units, '12000');
  assert.equal(vestedUnitsAt(g, '2029-01-15').units, '36000'); // a 4-year divisor would give 27000
  const high = legacy().scenarios.find((s) => s.scenarioId === 'high');
  assert.equal(high.grants[0].vestedUnits, '36000');
  assert.equal(high.grants[0].realizedProceeds, '306000.00'); // 36,000 x (9.00 - 0.50)
});

test('NPV comes only from the discount rate, with no combined haircut', () => {
  const withRate = legacy();
  const noRate = legacy(makeGroup({ ...legacyGroup, discountRateAnnual: null }));
  noRate.scenarios.forEach((s) => assert.equal(s.npv, null));
  withRate.scenarios.forEach((s, i) => assert.equal(s.netPreTax, noRate.scenarios[i].netPreTax));
  for (const s of withRate.scenarios) {
    let expected = 0;
    for (const c of s.cashFlows) {
      const months = (Number(c.date.slice(0, 4)) - 2026) * 12 + (Number(c.date.slice(5, 7)) - 1);
      expected += Number(c.amount) * Math.pow(1.1, -months / 12);
    }
    assert.ok(Math.abs(Number(s.npv) - expected) < 1, `${s.scenarioId}: ${s.npv} vs ${expected}`);
  }
});

test('no annual versus four-year label mismatch is possible', () => {
  const text = JSON.stringify(legacy());
  assert.ok(!/haircut|annualized|four_year|4-year|per_year/i.test(text));
  assert.deepEqual(Object.keys(legacy().scenarios[0]).sort(), [
    'breakEvenCommonPrice', 'cash', 'cashFlows', 'grants', 'kind', 'label', 'limitations',
    'maxCumulativeFundingNeed', 'netPreTax', 'npv', 'scenarioId',
  ]);
});
