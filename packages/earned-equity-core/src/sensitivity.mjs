// Two-way sensitivity grid: net pre-tax by exit common price x years to liquidity.
// Every cell is a real calculateOffer run on the equivalent single scenario.
import { CALCULATOR_VERSION, calculateOffer } from './scenario.mjs';
import { readFact } from './facts.mjs';
import { sortedUnique } from './canonical-json.mjs';
import { Q, formatQ } from './rational.mjs';
import { pickBaseScenario } from './relative.mjs';

export const DEFAULT_YEARS = Object.freeze([2, 3, 4, 5, 7, 10]);
export const DEFAULT_PRICE_MULTIPLES = Object.freeze(['0.5', '1', '2', '3', '5', '10']);
const MAX_AXIS = 8;
const MAX_YEARS = 50;

const fail = (errors) => ({ ok: false, errors });
const e1 = (path, code, message) => fail([{ path, code, message }]);

function referencePrice(vc, baseBreakEven, lim) {
  for (const key of ['preferredPricePerShare', 'fmv409APerShare']) {
    const r = readFact(vc?.[key], key, { allowResearched: true });
    r.limitations.forEach((c) => lim.add(c));
    if (r.value !== null) return { value: Q.of(r.value), source: key };
  }
  if (baseBreakEven !== null) {
    const q = Q.of(baseBreakEven);
    if (!q.isZero()) return { value: q, source: 'baseBreakEvenCommonPrice' };
  }
  return null;
}

export function sensitivityGrid(input) {
  try {
    const { group, offerRevision, scenarioSet, baseScenarioId, prices, years } = input ?? {};
    if (!group || !offerRevision || !scenarioSet || !Array.isArray(scenarioSet.scenarios)) {
      return e1('', 'missing_input', 'group, offerRevision and scenarioSet are required.');
    }
    const base = pickBaseScenario(scenarioSet.scenarios, baseScenarioId);
    if (!base) return e1('baseScenarioId', 'base_scenario_not_found', 'Base scenario not found.');
    const baseCalc = calculateOffer({ group, offerRevision, scenarioSet: { ...scenarioSet, scenarios: [base] } });
    if (!baseCalc.ok) return fail(baseCalc.errors);
    const lim = new Set();

    const yearAxis = years === undefined || years === null ? [...DEFAULT_YEARS] : years;
    if (!Array.isArray(yearAxis) || yearAxis.length === 0 || yearAxis.length > MAX_AXIS
      || yearAxis.some((y) => !Number.isInteger(y) || y < 1 || y > MAX_YEARS)) {
      return e1('years', 'invalid_axis', `years must be 1-${MAX_AXIS} integers between 1 and ${MAX_YEARS}.`);
    }
    let priceAxis;
    let ref = null;
    if (prices === undefined || prices === null) {
      ref = referencePrice(offerRevision.valuationContext, baseCalc.result.scenarios[0].breakEvenCommonPrice, lim);
      if (ref === null) {
        lim.add('reference_price_unknown');
        priceAxis = [];
      } else priceAxis = DEFAULT_PRICE_MULTIPLES.map((m) => formatQ(ref.value.mul(Q.of(m)), 6));
    } else {
      if (!Array.isArray(prices) || prices.length === 0 || prices.length > MAX_AXIS) return e1('prices', 'invalid_axis', `prices must have 1-${MAX_AXIS} entries.`);
      for (const p of prices) {
        if (typeof p !== 'string' || !/^\d{1,15}(\.\d{1,12})?$/.test(p)) return e1('prices', 'invalid_axis', 'prices must be non-negative decimal strings.');
      }
      priceAxis = [...prices];
    }
    const rate = group.discountRateAnnual ?? null;
    if (rate === null) lim.add('discount_rate_missing');

    const runScenario = (monthsToLiquidity, payout) => {
      const horizonMonths = Math.max(group.horizonMonths, monthsToLiquidity);
      if (base.exercisePath.kind === 'at_date' && base.exercisePath.exerciseMonthsFromStart > monthsToLiquidity) {
        return { ok: false, codes: ['exercise_after_liquidity'] };
      }
      const cell = {
        ...base, scenarioId: 'grid-cell', weightPct: null, payout,
        liquidity: { occurs: true, monthsFromStart: monthsToLiquidity },
      };
      const out = calculateOffer({ group: { ...group, horizonMonths }, offerRevision, scenarioSet: { ...scenarioSet, scenarios: [cell] } });
      if (!out.ok) return { ok: false, codes: out.errors.map((x) => x.code) };
      return { ok: true, scenario: out.result.scenarios[0], horizonMonths };
    };

    const cells = priceAxis.map((price) => yearAxis.map((y) => {
      const r = runScenario(y * 12, { method: 'common_per_share', commonProceedsPerShare: price, source: 'sensitivity grid axis', asOfDate: offerRevision.asOfDate });
      if (!r.ok) return { netPreTax: null, ...(rate === null ? {} : { npv: null }), limitations: sortedUnique(r.codes) };
      return { netPreTax: r.scenario.netPreTax, ...(rate === null ? {} : { npv: r.scenario.npv }), limitations: r.scenario.limitations };
    }));

    const breakEvenByYear = yearAxis.map((y) => {
      const r = runScenario(y * 12, { method: 'none' });
      if (!r.ok) return { years: y, liquidityMonths: y * 12, horizonMonths: Math.max(group.horizonMonths, y * 12), breakEvenCommonPrice: null, limitations: sortedUnique(r.codes) };
      return {
        years: y, liquidityMonths: y * 12, horizonMonths: r.horizonMonths,
        breakEvenCommonPrice: r.scenario.breakEvenCommonPrice, limitations: r.scenario.limitations,
      };
    });
    return {
      ok: true,
      grid: {
        calculatorVersion: CALCULATOR_VERSION,
        baseScenarioId: base.scenarioId,
        referencePrice: prices === undefined || prices === null
          ? (ref === null ? null : { source: ref.source, value: formatQ(ref.value, 6) })
          : { source: 'explicit_axis', value: null },
        prices: priceAxis, years: yearAxis, cells, breakEvenByYear,
        limitations: sortedUnique([...lim, ...baseCalc.result.limitations]),
      },
    };
  } catch (e) {
    return e1('', e.code ?? 'invalid_input', String(e?.message ?? e));
  }
}
