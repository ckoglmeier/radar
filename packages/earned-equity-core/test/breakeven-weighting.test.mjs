import test from 'node:test';
import assert from 'node:assert/strict';
import { run, first } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeScenario, makeScenarioSet, missing } from './fixtures/index.mjs';

const pay = (p) => ({ method: 'common_per_share', commonProceedsPerShare: p, source: 'x', asOfDate: '2026-01-10' });
const sets = (...rows) => makeScenarioSet(rows.map(([id, kind, w, payout, extra]) => makeScenario({ scenarioId: id, label: id, kind, weightPct: w, payout, ...extra })));
const failure = { liquidity: { occurs: false, monthsFromStart: null } };

test('break-even is exact', () => {
  const offer = makeOffer({ grants: [makeGrant({ units: f('50000') })] });
  const s = first({ offer });
  assert.equal(s.breakEvenCommonPrice, '5.000000'); // 1 + 200,000 / 50,000
  // At that price the scenario nets to zero.
  const at = first({ offer, set: makeScenarioSet([makeScenario({ payout: pay('5.00') })]) });
  assert.equal(at.netPreTax, '0.00');
  assert.equal(first().breakEvenCommonPrice, '5.166667');
});

test('break-even solves across mixed strikes', () => {
  const offer = makeOffer({ grants: [
    makeGrant({ componentId: 'a', units: f('10000'), strikePrice: f('1.00') }),
    makeGrant({ componentId: 'b', units: f('10000'), strikePrice: f('9.00') }),
  ] });
  // F = 200,000. Below P=9 only A pays: 10000 x (P-1) = 200000 -> P = 21 (> 9). Both: 20000P - 100000 = 200000 -> 15.
  assert.equal(first({ offer }).breakEvenCommonPrice, '15.000000');
});

test('offer_pays_more gives 0', () => {
  const s = first({ offer: makeOffer({ cash: { annualBase: f('250000'), annualTargetBonus: f('0'), signingBonus: f('0') } }) });
  assert.equal(s.breakEvenCommonPrice, '0');
  assert.ok(s.limitations.includes('offer_pays_more'));
});

test('no_solution without eligible units or liquidity', () => {
  const none = first({ offer: makeOffer({ grants: [] }) });
  assert.equal(none.breakEvenCommonPrice, null);
  assert.ok(none.limitations.includes('no_solution'));
  const noLiq = first({ set: makeScenarioSet([makeScenario(failure)]) });
  assert.equal(noLiq.breakEvenCommonPrice, null);
  assert.ok(noLiq.limitations.includes('no_solution'));
});

test('weights summing to 100 including a zero outcome', () => {
  const r = run({ set: sets(['a', 'base', '60', pay('5.00')], ['b', 'upside', '40', pay('9.00')], ['c', 'failure', '0', { method: 'none' }, failure]) });
  assert.deepEqual(r.weighted, { expectedNetPreTax: '68800.00' }); // 0.6 x -8,000 + 0.4 x 184,000
  assert.ok(!r.limitations.includes('weights_not_100'));
});

test('zero-weight failure still counts when weighted', () => {
  const r = run({ set: sets(['a', 'base', '50', pay('5.00')], ['c', 'failure', '50', { method: 'none' }, failure]) });
  assert.deepEqual(r.weighted, { expectedNetPreTax: '-104000.00' }); // 0.5 x -8,000 + 0.5 x -200,000
});

test('99.9 is rejected', () => {
  const r = run({ set: sets(['a', 'base', '59.9', pay('5.00')], ['b', 'upside', '40', pay('9.00')]) });
  assert.equal(r.weighted, null);
  assert.ok(r.limitations.includes('weights_not_100'));
});

test('null weights make the expectation incomplete', () => {
  const r = run({ set: sets(['a', 'base', '60', pay('5.00')], ['b', 'upside', null, pay('9.00')]) });
  assert.equal(r.weighted, null);
  assert.ok(r.limitations.includes('weights_incomplete'));
  assert.equal(r.scenarios[0].netPreTax, '-8000.00'); // unweighted results remain useful
});

test('a null net makes the weighted value unavailable', () => {
  const r = run({ offer: makeOffer({ grants: [makeGrant({ strikePrice: missing() })] }), set: sets(['a', 'base', '60', pay('5.00')], ['b', 'upside', '40', pay('9.00')]) });
  assert.equal(r.weighted, null);
  assert.ok(r.limitations.includes('expected_value_unavailable'));
});

test('group-level validity: discount rate leaves net untouched', () => {
  const a = first();
  const b = first({ group: makeGroup({ discountRateAnnual: '0.12' }) });
  assert.equal(a.netPreTax, b.netPreTax);
});
