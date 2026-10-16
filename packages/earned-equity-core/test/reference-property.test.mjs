import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOffer, sensitivityGrid } from '../index.mjs';
import { am, predictErrors, reference } from './fixtures/reference.mjs';

// Seeded LCG so the cases are reproducible.
function makeRng(seed) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[ri(0, a.length - 1)];
  return { rnd, ri, pick };
}
const f = (value, state = 'user_reported') => ({ value, state });
const miss = () => ({ value: null, state: 'missing' });
const na = () => ({ value: null, state: 'not_applicable' });
// A value that is usually usable, sometimes missing or illustrative.
const maybe = (rnd, value, pMissing, pIllustrative) => {
  const r = rnd();
  return r < pMissing ? miss() : r < pMissing + pIllustrative ? f(value, 'illustrative') : f(value);
};

function generate(rng) {
  const { rnd, ri, pick } = rng;
  const dec = (maxInt, dp) => { const i = ri(0, maxInt); return dp ? `${i}.${String(ri(0, 10 ** dp - 1)).padStart(dp, '0')}` : String(i); };
  const y = ri(2023, 2027);
  const m = ri(1, 12);
  const dim = [31, y % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  const start = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(pick([1, 15, 28, 29, 30, 31]), dim)).padStart(2, '0')}`;
  const S = am(start, ri(0, 3));
  const dp = rnd() < 0.5 ? 6 : 2;
  const grants = [];
  const ng = ri(1, 3);
  for (let g = 0; g < ng; g += 1) {
    const T = pick([0, 12, 24, 36, 48, 10, 13]);
    const K0 = pick([0, 6, 12, T]);
    const K = T > 0 ? Math.min(K0, T) : K0;
    const C = rnd() < 0.6 ? S : am(S, ri(-6, 6));
    grants.push({
      componentId: `c${g}`, instrument: pick(['iso', 'nso', 'iso']),
      units: maybe(rnd, String(pick([0, 0, ri(1, 999), ri(1000, 200000), ri(1, 999999999)])), 0.06, 0.04),
      quotedOwnershipPct: maybe(rnd, dec(2, 4), 0.08, 0.05), ownershipDenominator: { basis: 'fully_diluted', asOfDate: pick([null, '2026-01-01']) },
      strikePrice: rnd() < 0.1 ? miss() : maybe(rnd, rnd() < 0.15 ? '0' : dec(10, pick([2, 4, 6, 12])), 0, 0.04),
      grantDate: rnd() < 0.2 ? miss() : f(C), boardApproval: f('approved'),
      vesting: { commencementDate: rnd() < 0.04 ? miss() : f(C), totalMonths: T, cliffMonths: K, cadence: rnd() < 0.04 ? 'performance' : pick(['monthly', 'quarterly', 'annual']), acceleration: 'none' },
      exercise: {
        postTerminationWindowMonths: rnd() < 0.1 ? miss() : f(String(pick([0, 1, 3, 12, 24, 120]))),
        expirationYears: rnd() < 0.08 ? miss() : f(String(pick([1, 2, 5, 10]))), earlyExercise: f(false),
      },
    });
  }
  const group = {
    schemaVersion: 1, id: 'g', mode: 'employment', currency: 'USD', startDate: start, horizonMonths: ri(1, 120),
    discountRateAnnual: rnd() < 0.5 ? null : pick(['0', '0.05', '0.1', '0.137']),
    baseline: { kind: 'current_role', annualBase: dec(300000, dp), annualCashBonus: rnd() < 0.5 ? '0' : dec(50000, dp) }, status: 'open',
  };
  const offer = {
    schemaVersion: 1, id: 'r', opportunityId: 'o', supersedesRevisionId: null, asOfDate: am(start, pick([-24, -6, 0, 3, 60, 130])), status: pick(['proposed', 'signed', 'user_reported', 'proposed']), currency: 'USD',
    cash: {
      annualBase: f(dec(300000, dp)), annualTargetBonus: rnd() < 0.12 ? na() : f(rnd() < 0.5 ? '0' : dec(50000, dp)),
      signingBonus: rnd() < 0.12 ? na() : f(rnd() < 0.5 ? '0' : dec(50000, 2)), signingRepaymentMonths: pick([null, 0, 12, 24]),
    },
    serviceStartDate: f(S), grants,
  };
  const scenarios = [];
  const nsc = ri(1, 4);
  let left = 100;
  for (let s = 0; s < nsc; s += 1) {
    const serviceMonths = pick([0, 1, 11, 12, 13, 24, 48, ri(0, 120)]);
    const occurs = rnd() < 0.8;
    const Lm = ri(0, 130);
    const atDate = rnd() < 0.4;
    const X = ri(0, occurs ? Lm : 130);
    const method = pick(['common_per_share', 'pro_rata_shares', 'pro_rata_ownership', 'none', 'common_per_share']);
    const payout = method === 'common_per_share' ? { method, commonProceedsPerShare: dec(30, pick([2, 6, 12])), source: 's', asOfDate: start }
      : method === 'pro_rata_shares' ? { method, equityExitValue: dec(2e9, 2), fullyDilutedExitShares: String(ri(1e6, 2e8)) }
        : method === 'pro_rata_ownership' ? { method, equityExitValue: dec(2e9, 2), dilutionRounds: Array.from({ length: ri(0, 3) }, () => `0.${ri(1, 4)}${ri(0, 9)}`) }
          : { method };
    const w = s === nsc - 1 ? left : ri(0, left);
    left -= w;
    scenarios.push({
      scenarioId: `s${s}`, label: 'x', kind: 'custom', weightPct: rnd() < 0.85 ? String(w) : null, serviceMonths,
      postServiceAnnualCash: rnd() < 0.4 ? dec(200000, dp) : null,
      liquidity: { occurs, monthsFromStart: occurs ? Lm : null }, payout,
      exercisePath: atDate ? { kind: 'at_date', exerciseMonthsFromStart: X } : { kind: 'at_liquidity' },
    });
  }
  const input = { group, offerRevision: offer, scenarioSet: { schemaVersion: 1, id: 'ss', offerRevisionId: 'r', currency: 'USD', scenarios } };
  if (rnd() < 0.1) {
    const g0 = grants[0];
    g0.instrument = 'iso';
    pick([
      () => { g0.vesting.totalMonths = 12; g0.vesting.cliffMonths = 24; },
      () => { g0.grantDate = f('2026-02-30'); },
      () => { offer.asOfDate = '2026-02-31'; },
      () => { g0.ownershipDenominator.asOfDate = '2026-13-01'; },
      () => { g0.units = na(); },
      () => { g0.strikePrice = na(); },
      () => { offer.cash.annualBase = na(); },
      () => { offer.serviceStartDate = f('2026-04-31'); },
    ])();
  }
  return input;
}

test('property: calculator agrees EXACTLY with the independent rational reference (>= 500 cases)', () => {
  const rng = makeRng(20261015);
  let agreed = 0;
  let generated = 0;
  const stats = { net: 0, be: 0, residual: 0, nullNet: 0, gridCells: 0 };
  let errorCases = 0;
  while (agreed < 600 && generated < 6000) {
    generated += 1;
    const input = generate(rng);
    const got = calculateOffer(input);
    const predicted = predictErrors(input);
    if (predicted.length > 0) {
      errorCases += 1;
      assert.equal(got.ok, false, `case ${generated} should fail: ${predicted}`);
      assert.deepEqual([...new Set(got.errors.map((e) => e.code))].sort(), predicted, `case ${generated}`);
      const keys = got.errors.map((e) => `${e.path}|${e.code}`);
      assert.deepEqual(keys, [...new Set(keys)], `case ${generated}: an invalid field was reported twice`);
      continue;
    }
    assert.equal(got.ok, true, JSON.stringify(got.errors));
    const ref = reference(input);
    got.result.scenarios.forEach((s, j) => {
      const r = ref.scenarios[j];
      if (s.netPreTax === null) stats.nullNet += 1; else stats.net += 1;
      if (s.breakEvenCommonPrice !== null) stats.be += 1;
      if (s.grants.some((g) => g.illiquidResidual && g.illiquidResidual.units !== null)) stats.residual += 1;
      const where = `case ${generated} scenario ${j}`;
      for (const k of Object.keys(r.cash)) assert.equal(s.cash[k], r.cash[k], `${where} cash.${k}`);
      for (const k of ['netPreTax', 'npv', 'breakEvenCommonPrice', 'maxCumulativeFundingNeed']) assert.equal(s[k], r[k], `${where} ${k}`);
      s.grants.forEach((g, q) => {
        for (const k of ['vestedUnits', 'eligibleUnits', 'exerciseCost', 'realizedProceeds']) assert.equal(g[k], r.grants[q][k], `${where} grant ${q} ${k}`);
        assert.equal(g.illiquidResidual ? g.illiquidResidual.units : null, (r.grants[q].residual ?? null), `${where} grant ${q} residual`);
      });
    });
    assert.deepEqual(got.result.weighted, ref.weighted, `case ${generated} weighted`);
    if (generated % 3 === 0) {
      // Sample grid cells against the independent reference on the equivalent single scenario.
      const prices = ['3.5', '12'];
      const years = [2, 5];
      const grid = sensitivityGrid({ ...input, baseScenarioId: 's0', prices, years });
      assert.equal(grid.ok, true, JSON.stringify(grid.errors));
      const base = input.scenarioSet.scenarios[0];
      prices.forEach((price, i) => years.forEach((y, j) => {
        const months = y * 12;
        const cell = grid.grid.cells[i][j];
        if (base.exercisePath.kind === 'at_date' && base.exercisePath.exerciseMonthsFromStart > months) {
          assert.equal(cell.netPreTax, null);
          return;
        }
        const scenario = {
          ...base, scenarioId: 'c', weightPct: null,
          payout: { method: 'common_per_share', commonProceedsPerShare: price, source: 's', asOfDate: input.group.startDate },
          liquidity: { occurs: true, monthsFromStart: months },
        };
        const cellInput = { group: { ...input.group, horizonMonths: Math.max(input.group.horizonMonths, months) }, offerRevision: input.offerRevision, scenarioSet: { ...input.scenarioSet, scenarios: [scenario] } };
        const r = reference(cellInput).scenarios[0];
        assert.equal(cell.netPreTax, r.netPreTax, `case ${generated} grid ${price}/${y} net`);
        if (input.group.discountRateAnnual !== null) assert.equal(cell.npv, r.npv, `case ${generated} grid ${price}/${y} npv`);
        stats.gridCells += 1;
      }));
    }
    agreed += 1;
  }
  assert.ok(agreed >= 500);
  assert.ok(errorCases >= 30, `error cases: ${errorCases}`);
  assert.ok(stats.net >= 150 && stats.be >= 40 && stats.residual >= 40 && stats.nullNet >= 20 && stats.gridCells >= 400, JSON.stringify(stats));
});
