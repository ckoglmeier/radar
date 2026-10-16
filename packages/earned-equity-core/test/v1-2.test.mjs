// v1.2: relative position, sensitivity grid, researched values.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { CALCULATOR_VERSION, calculateOffer, relativePosition, sensitivityGrid } from '../index.mjs';
import { SCHEMAS } from '../schema.mjs';
import { first, run } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeScenario, makeScenarioSet, missing } from './fixtures/index.mjs';

const ctx = {
  preferredPricePerShare: f('10.00'), postMoneyValuation: f('992000064'), fullyDilutedShares: f('96000000'),
  fmv409APerShare: f('2.00'), fmv409AAsOf: f('2026-01-01'), lastRoundDate: f('2025-11-01'), seniorClaimsAmount: f('100000000'),
  preferenceTerms: f('1x non-participating'),
};
const withCtx = (valuationContext) => makeOffer({ valuationContext });
const baseSet = () => makeScenarioSet([makeScenario()]);
const position = (offer, set = baseSet(), group = makeGroup()) => {
  const out = relativePosition({ group, offerRevision: offer, scenarioSet: set, result: run({ group, offer, set }) });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  return out.position;
};

test('version is 1.2.0 and valuation context validates against the schema', () => {
  assert.equal(CALCULATOR_VERSION, 'earned-equity-core/1.2.0');
  const ajv = new Ajv({ strict: true, allErrors: true });
  assert.ok(ajv.compile(SCHEMAS.offerRevision)(withCtx(ctx)));
});

test('relativePosition: hand-computed golden case', () => {
  // Break-even price = 1 + 200,000 / 48,000 = 5.166667.
  const p = position(withCtx(ctx));
  assert.equal(p.cashGivenUpTotal, '200000.00');
  assert.equal(p.cashGivenUpPerYear, '50000.00'); // 200,000 x 12 / 48
  assert.equal(p.breakEvenCommonPrice, '5.166667');
  assert.equal(p.breakEvenMultipleOfPreferred, '0.5167'); // 5.166667 / 10
  assert.equal(p.breakEvenMultipleOf409A, '2.5833'); // 5.166667 / 2 = 2.5833335
  assert.equal(p.breakEvenEquityValue, '496000032.00'); // 5.166667 x 96,000,000
  assert.equal(p.breakEvenMultipleOfPostMoney, '0.5000'); // 496,000,032 / 992,000,064
  assert.equal(p.seniorClaimsAdjustedMultiple, '0.6008'); // 596,000,032 / 992,000,064 = 0.600806
  assert.match(p.seniorClaimsAdjustedNote, /excludes participation/);
  assert.equal(p.strikeVs409A, '0.5000'); // 1.00 / 2.00
  for (const k of Object.keys(p)) assert.ok(!/verdict|rank|score|winner|accept|decline/i.test(k), k);
});

test('relativePosition: unknown references give null, never zero', () => {
  const p = position(makeOffer());
  for (const k of ['breakEvenMultipleOfPreferred', 'breakEvenMultipleOf409A', 'breakEvenEquityValue', 'breakEvenMultipleOfPostMoney', 'seniorClaimsAdjustedMultiple', 'strikeVs409A']) assert.equal(p[k], null, k);
  assert.ok(p.limitations.includes('senior_claims_unknown'));
  assert.ok(p.limitations.includes('preferredPricePerShare_missing'));
  const noSenior = position(withCtx({ ...ctx, seniorClaimsAmount: missing() }));
  assert.equal(noSenior.seniorClaimsAdjustedMultiple, null);
  assert.equal(noSenior.breakEvenMultipleOfPostMoney, '0.5000');
  const noBreakEven = position(makeOffer({ grants: [], valuationContext: ctx }));
  assert.equal(noBreakEven.breakEvenCommonPrice, null);
  assert.equal(noBreakEven.breakEvenMultipleOfPreferred, null);
});

test('relativePosition: researched values are usable here but flagged', () => {
  const p = position(withCtx({ ...ctx, preferredPricePerShare: f('10.00', 'researched_unconfirmed') }));
  assert.equal(p.breakEvenMultipleOfPreferred, '0.5167');
  assert.ok(p.limitations.includes('researched_value:preferredPricePerShare'));
  assert.ok(!position(withCtx(ctx)).limitations.some((l) => l.startsWith('researched_value')));
  const illustrative = position(withCtx({ ...ctx, fmv409APerShare: f('2.00', 'illustrative') }));
  assert.equal(illustrative.breakEvenMultipleOf409A, null);
  assert.ok(illustrative.limitations.includes('illustrative_value_ignored:fmv409APerShare'));
});

test('relativePosition: errors are structured', () => {
  assert.equal(relativePosition({}).ok, false);
  const out = relativePosition({ offerRevision: makeOffer(), scenarioSet: makeScenarioSet([makeScenario({ kind: 'upside' })]), result: run({ set: makeScenarioSet([makeScenario({ kind: 'upside' })]) }) });
  assert.equal(out.errors[0].code, 'base_scenario_not_found');
});

test('researched values never drive units, strike or payout', () => {
  const s = first({ offer: makeOffer({ grants: [makeGrant({ units: f('48000', 'researched_unconfirmed') })] }) });
  assert.equal(s.grants[0].realizedProceeds, null);
  assert.equal(s.netPreTax, null);
  assert.ok(s.limitations.includes('researched_value:units'));
  const k = first({ offer: makeOffer({ grants: [makeGrant({ strikePrice: f('1.00', 'researched_unconfirmed') })] }) });
  assert.equal(k.grants[0].realizedProceeds, null);
  assert.ok(k.limitations.includes('researched_value:strike_price'));
  // A researched valuation context does not change the calculation at all.
  const plain = first();
  const withResearch = first({ offer: withCtx({ ...ctx, preferredPricePerShare: f('1.00', 'researched_unconfirmed') }) });
  assert.equal(withResearch.netPreTax, plain.netPreTax);
});

test('valuationContext dates are validated', () => {
  const out = calculateOffer({ group: makeGroup(), offerRevision: withCtx({ ...ctx, fmv409AAsOf: f('2026-02-30') }), scenarioSet: baseSet() });
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors.map((e) => [e.path, e.code]), [['offerRevision.valuationContext.fmv409AAsOf', 'invalid_date']]);
});

// ---- sensitivity grid ----
const grid = (over = {}) => {
  const out = sensitivityGrid({ group: makeGroup(), offerRevision: makeOffer(), scenarioSet: baseSet(), baseScenarioId: 'sc-base', ...over });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  return out.grid;
};

test('default axes and reference choice', () => {
  const pref = grid({ offerRevision: withCtx(ctx) });
  assert.deepEqual(pref.years, [2, 3, 4, 5, 7, 10]);
  assert.deepEqual(pref.prices, ['5.000000', '10.000000', '20.000000', '30.000000', '50.000000', '100.000000']);
  assert.deepEqual(pref.referencePrice, { source: 'preferredPricePerShare', value: '10.000000' });
  const only409 = grid({ offerRevision: withCtx({ fmv409APerShare: f('2.00') }) });
  assert.deepEqual(only409.referencePrice, { source: 'fmv409APerShare', value: '2.000000' });
  assert.deepEqual(only409.prices, ['1.000000', '2.000000', '4.000000', '6.000000', '10.000000', '20.000000']);
  const fallback = grid();
  assert.deepEqual(fallback.referencePrice, { source: 'baseBreakEvenCommonPrice', value: '5.166667' });
  assert.equal(fallback.prices[0], '2.583334'); // 5.166667 x 0.5 = 2.5833335, half-even
  const researched = grid({ offerRevision: withCtx({ preferredPricePerShare: f('10', 'researched_unconfirmed') }) });
  assert.equal(researched.referencePrice.source, 'preferredPricePerShare');
  assert.ok(researched.limitations.includes('researched_value:preferredPricePerShare'));
  const explicit = grid({ prices: ['1', '9'], years: [3] });
  assert.deepEqual(explicit.referencePrice, { source: 'explicit_axis', value: null });
});

test('grid cells equal calculateOffer on the equivalent single scenario, exactly', () => {
  const group = makeGroup({ discountRateAnnual: '0.1' });
  const g = grid({ group, prices: ['2', '5.5', '20'], years: [2, 4, 10] });
  assert.equal(g.cells.length, 3);
  g.prices.forEach((price, i) => g.years.forEach((years, j) => {
    const months = years * 12;
    const scenario = makeScenario({ scenarioId: 'x', payout: { method: 'common_per_share', commonProceedsPerShare: price, source: 'x', asOfDate: '2026-01-10' }, liquidity: { occurs: true, monthsFromStart: months } });
    const out = calculateOffer({ group: { ...group, horizonMonths: Math.max(48, months) }, offerRevision: makeOffer(), scenarioSet: makeScenarioSet([scenario]) });
    assert.equal(out.ok, true);
    const s = out.result.scenarios[0];
    assert.equal(g.cells[i][j].netPreTax, s.netPreTax);
    assert.equal(g.cells[i][j].npv, s.npv);
    assert.deepEqual(g.cells[i][j].limitations, s.limitations);
  }));
  // Hand check: price 20, liquidity at year 4 is the base shape: 48,000 x 19 - 200,000.
  assert.equal(g.cells[2][1].netPreTax, '712000.00');
});

test('per-year break-even matches calculateOffer for that timing', () => {
  const g = grid({ years: [2, 4, 10], prices: ['1'] });
  g.breakEvenByYear.forEach((col) => {
    const scenario = makeScenario({ scenarioId: 'x', liquidity: { occurs: true, monthsFromStart: col.years * 12 } });
    const out = calculateOffer({ group: makeGroup({ horizonMonths: Math.max(48, col.years * 12) }), offerRevision: makeOffer(), scenarioSet: makeScenarioSet([scenario]) });
    assert.equal(col.breakEvenCommonPrice, out.result.scenarios[0].breakEvenCommonPrice);
    assert.equal(col.horizonMonths, Math.max(48, col.years * 12));
  });
  // Service is 48 months whatever the liquidity year, so the same units vest and the break-even is unchanged.
  assert.equal(g.breakEvenByYear[1].breakEvenCommonPrice, '5.166667');
});

test('cells that cannot be computed are null with limitations, never zero', () => {
  const g = grid({ offerRevision: makeOffer({ grants: [makeGrant({ strikePrice: missing() })] }), prices: ['5'], years: [4] });
  assert.equal(g.cells[0][0].netPreTax, null);
  assert.ok(g.cells[0][0].limitations.includes('strike_price_missing'));
  assert.equal(g.breakEvenByYear[0].breakEvenCommonPrice, null);
  const atDate = grid({ scenarioSet: makeScenarioSet([makeScenario({ exercisePath: { kind: 'at_date', exerciseMonthsFromStart: 24 } })]), prices: ['5'], years: [1, 4] });
  assert.equal(atDate.cells[0][0].netPreTax, null);
  assert.deepEqual(atDate.cells[0][0].limitations, ['exercise_after_liquidity']);
  assert.notEqual(atDate.cells[0][1].netPreTax, null);
  const none = grid({ offerRevision: makeOffer({ grants: [] }) });
  assert.deepEqual(none.prices, []);
  assert.ok(none.limitations.includes('reference_price_unknown'));
});

test('axis caps, validation and determinism', () => {
  const nine = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const base = { group: makeGroup(), offerRevision: makeOffer(), scenarioSet: baseSet(), baseScenarioId: 'sc-base' };
  assert.equal(sensitivityGrid({ ...base, prices: nine }).errors[0].code, 'invalid_axis');
  assert.equal(sensitivityGrid({ ...base, years: [1, 2, 3, 4, 5, 6, 7, 8, 9] }).errors[0].code, 'invalid_axis');
  assert.equal(sensitivityGrid({ ...base, years: [0] }).errors[0].code, 'invalid_axis');
  assert.equal(sensitivityGrid({ ...base, prices: ['abc'] }).errors[0].code, 'invalid_axis');
  assert.equal(sensitivityGrid({ ...base, baseScenarioId: 'nope' }).errors[0].code, 'base_scenario_not_found');
  assert.equal(sensitivityGrid({ ...base, prices: nine.slice(0, 8), years: [1, 2, 3, 4, 5, 6, 7, 8] }).ok, true);
  assert.equal(JSON.stringify(sensitivityGrid(base)), JSON.stringify(sensitivityGrid(base)));
  assert.equal(sensitivityGrid(null).ok, false);
  const bad = sensitivityGrid({ ...base, offerRevision: makeOffer({ currency: 'EUR' }) });
  assert.equal(bad.errors[0].code, 'currency_mismatch');
});
