// Relative position of an offer: where it stands against reference prices and valuation context.
// No verdicts, ranks or scores. Exact rationals, rounded once at output.
import { CALCULATOR_VERSION } from './scenario.mjs';
import { readFact } from './facts.mjs';
import { sortedUnique } from './canonical-json.mjs';
import { Q, formatQ } from './rational.mjs';
import { addMonths, isValidIsoDate } from './dates.mjs';

export const SENIOR_CLAIMS_NOTE = 'Simplified as-converted figure: adds senior claims to the break-even equity value. It excludes participation, conversion and seniority detail.';

const fail = (code, message, path = '') => ({ ok: false, errors: [{ path, code, message }] });

// Older immutable snapshots do not carry comparisonMonths. Reconstruct only
// from their recorded basis, using the same monthly horizon as calculateOffer.
function comparisonMonths(base, scenario, result, offer) {
  if (Number.isInteger(base.cash.comparisonMonths) && base.cash.comparisonMonths >= 0) return base.cash.comparisonMonths;
  const basis = result.basis;
  const start = readFact(offer.serviceStartDate, 'service_start').value;
  if (!isValidIsoDate(start) || !isValidIsoDate(basis?.startDate) || !Number.isInteger(basis?.horizonMonths)) return null;
  const end = addMonths(basis.startDate, basis.horizonMonths);
  let months = 0;
  for (let k = 0; addMonths(start, k) < end; k += 1) {
    if (k < scenario.serviceMonths || scenario.postServiceAnnualCash != null) months += 1;
  }
  return months;
}

function ctxValue(vc, key, lim) {
  const r = readFact(vc?.[key], key, { allowResearched: true });
  r.limitations.forEach((c) => lim.add(c));
  return r.value === null ? null : Q.of(r.value);
}

function ratio(num, den, lim, name) {
  if (num === null || den === null) return null;
  if (den.isZero()) { lim.add(`${name}_reference_zero`); return null; }
  return num.div(den);
}

/** Find the base scenario: explicit id, else the first scenario of kind 'base'. */
export function pickBaseScenario(scenarios, baseScenarioId) {
  if (baseScenarioId) return scenarios.find((s) => s.scenarioId === baseScenarioId) ?? null;
  return scenarios.find((s) => s.kind === 'base') ?? null;
}

export function relativePosition(input) {
  try {
    const { offerRevision: offer, scenarioSet, result, baseScenarioId } = input ?? {};
    if (!offer || !scenarioSet || !Array.isArray(scenarioSet.scenarios) || !result || !Array.isArray(result.scenarios)) {
      return fail('missing_input', 'offerRevision, scenarioSet and a calculation result are required.');
    }
    const baseSet = pickBaseScenario(scenarioSet.scenarios, baseScenarioId);
    const base = baseSet ? result.scenarios.find((s) => s.scenarioId === baseSet.scenarioId) : null;
    if (!baseSet || !base) return fail('base_scenario_not_found', 'No base scenario found in the scenario set and result.');
    const lim = new Set(base.limitations);
    const vc = offer.valuationContext;

    const total = base.cash.totalCashDifference === null ? null : Q.of(base.cash.totalCashDifference);
    let perYear = null;
    if (total !== null) {
      const months = comparisonMonths(base, baseSet, result, offer);
      if (months > 0) perYear = total.mul(Q.int(12)).div(Q.int(months));
      else lim.add('cash_comparison_duration_unknown');
    }
    const be = base.breakEvenCommonPrice === null ? null : Q.of(base.breakEvenCommonPrice);
    const preferred = ctxValue(vc, 'preferredPricePerShare', lim);
    const fmv = ctxValue(vc, 'fmv409APerShare', lim);
    const multPreferred = ratio(be, preferred, lim, 'preferredPricePerShare');
    const mult409 = ratio(be, fmv, lim, 'fmv409APerShare');

    const shares = ctxValue(vc, 'fullyDilutedShares', lim);
    const post = ctxValue(vc, 'postMoneyValuation', lim);
    const senior = ctxValue(vc, 'seniorClaimsAmount', lim);
    const beValue = be !== null && shares !== null ? be.mul(shares) : null;
    const multPost = ratio(beValue, post, lim, 'postMoneyValuation');
    let seniorAdj = null;
    if (senior === null) lim.add('senior_claims_unknown');
    else if (beValue !== null) seniorAdj = ratio(beValue.add(senior), post, lim, 'postMoneyValuation');

    // Strike context: one distinct usable strike across the iso/nso grants.
    const strikes = new Set();
    let strikeUnusable = false;
    for (const g of offer.grants ?? []) {
      if (g.instrument !== 'iso' && g.instrument !== 'nso') continue;
      const r = readFact(g.strikePrice, 'strike_price');
      r.limitations.forEach((c) => lim.add(c));
      if (r.value === null) strikeUnusable = true;
      else strikes.add(Q.of(r.value).n.toString() + '/' + Q.of(r.value).d.toString());
    }
    let strikeVs = null;
    if (strikeUnusable || strikes.size === 0) lim.add('strike_context_unknown');
    else if (strikes.size > 1) lim.add('strike_context_ambiguous');
    else {
      const [n, d] = [...strikes][0].split('/');
      strikeVs = ratio(new Q(BigInt(n), BigInt(d)), fmv, lim, 'fmv409APerShare');
    }
    const m4 = (q) => (q === null ? null : formatQ(q, 4));
    return {
      ok: true,
      position: {
        calculatorVersion: CALCULATOR_VERSION,
        baseScenarioId: baseSet.scenarioId,
        cashGivenUpTotal: base.cash.totalCashDifference,
        cashGivenUpPerYear: perYear === null ? null : formatQ(perYear, 2),
        breakEvenCommonPrice: base.breakEvenCommonPrice,
        breakEvenMultipleOfPreferred: m4(multPreferred),
        breakEvenMultipleOf409A: m4(mult409),
        breakEvenEquityValue: beValue === null ? null : formatQ(beValue, 2),
        breakEvenMultipleOfPostMoney: m4(multPost),
        seniorClaimsAdjustedMultiple: m4(seniorAdj),
        seniorClaimsAdjustedNote: SENIOR_CLAIMS_NOTE,
        strikeVs409A: m4(strikeVs),
        limitations: sortedUnique([...lim]),
      },
    };
  } catch (e) {
    return fail(e.code ?? 'invalid_input', String(e?.message ?? e));
  }
}
