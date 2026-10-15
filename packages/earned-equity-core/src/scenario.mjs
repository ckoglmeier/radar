// Scenario economics: cash, equity, funding, NPV, break-even and weighting.
import { addMonths, isValidIsoDate, minDate, monthsBetween } from './dates.mjs';
import {
  CoreInputError, MONEY_SCALE, RATIO_SCALE, divRound, formatFixed, formatMoney, formatPct, formatPerShare,
  maxBig, parseDecimal, parseUnits, pow10,
} from './decimal.mjs';
import { readFact } from './facts.mjs';
import { sortedUnique } from './canonical-json.mjs';
import { vestedFractionAt } from './vesting.mjs';

export const CALCULATOR_VERSION = 'earned-equity-core/1.0.0';
const R12 = pow10(RATIO_SCALE);

/** Product of (1 - d_i) as an exact fraction. */
function retentionFraction(rounds) {
  let num = 1n;
  let den = 1n;
  for (const d of rounds) {
    const d12 = parseDecimal(d, RATIO_SCALE);
    if (d12 < 0n || d12 >= R12) throw new CoreInputError('invalid_dilution', `Dilution "${d}" must be in [0, 1).`);
    num *= R12 - d12;
    den *= R12;
  }
  return { num, den };
}

/** Retained ownership after successive primary rounds, as a percentage with 4 decimals. */
export function ownershipRetentionPct(rounds) {
  const { num, den } = retentionFraction(rounds);
  return formatPct(divRound(num * 100n * R12, den));
}

const err = (errors, path, code, message) => errors.push({ path, code, message });

function validate(group, offer, set) {
  const errors = [];
  if (!group || !offer || !set) {
    err(errors, '', 'missing_input', 'group, offerRevision and scenarioSet are required.');
    return errors;
  }
  if (group.currency !== offer.currency) err(errors, 'offerRevision.currency', 'currency_mismatch', 'Offer currency differs from the group currency.');
  if (group.currency !== set.currency) err(errors, 'scenarioSet.currency', 'currency_mismatch', 'Scenario set currency differs from the group currency.');
  if (set.offerRevisionId !== offer.id) err(errors, 'scenarioSet.offerRevisionId', 'scenario_set_offer_mismatch', 'Scenario set belongs to a different offer revision.');
  if (!isValidIsoDate(group.startDate)) err(errors, 'group.startDate', 'invalid_date', 'Group startDate is not a valid ISO date.');
  if (!Number.isInteger(group.horizonMonths) || group.horizonMonths < 1) err(errors, 'group.horizonMonths', 'invalid_horizon', 'horizonMonths must be a positive integer.');
  const ss = readFact(offer.serviceStartDate, 'service_start');
  if (ss.value === null) err(errors, 'offerRevision.serviceStartDate', 'service_start_unusable', 'serviceStartDate must be a usable date for calculation.');
  else if (!isValidIsoDate(ss.value)) err(errors, 'offerRevision.serviceStartDate', 'invalid_date', 'serviceStartDate is not a valid ISO date.');
  else if (isValidIsoDate(group.startDate) && ss.value < group.startDate) err(errors, 'offerRevision.serviceStartDate', 'service_start_before_group_start', 'Service starts before the group start date.');
  if (!Array.isArray(set.scenarios) || set.scenarios.length === 0) err(errors, 'scenarioSet.scenarios', 'no_scenarios', 'At least one scenario is required.');
  const seen = new Set();
  const compIds = new Set();
  for (const [i, g] of (offer.grants ?? []).entries()) {
    if (compIds.has(g.componentId)) err(errors, `offerRevision.grants[${i}].componentId`, 'duplicate_component', 'Duplicate componentId.');
    compIds.add(g.componentId);
  }
  for (const [i, sc] of (set.scenarios ?? []).entries()) {
    const p = `scenarioSet.scenarios[${i}]`;
    if (seen.has(sc.scenarioId)) err(errors, `${p}.scenarioId`, 'duplicate_scenario', 'Duplicate scenarioId.');
    seen.add(sc.scenarioId);
    if (sc.weightPct !== null && sc.weightPct !== undefined) {
      try { parseDecimal(sc.weightPct, 6); } catch { err(errors, `${p}.weightPct`, 'invalid_weight', 'weightPct is not a decimal.'); }
    }
    if (!Number.isInteger(sc.serviceMonths) || sc.serviceMonths < 0) err(errors, `${p}.serviceMonths`, 'invalid_service_months', 'serviceMonths must be a non-negative integer.');
    const liq = sc.liquidity ?? {};
    if (liq.occurs && !Number.isInteger(liq.monthsFromStart)) err(errors, `${p}.liquidity.monthsFromStart`, 'liquidity_months_missing', 'Liquidity occurs but monthsFromStart is missing.');
    const pay = sc.payout ?? {};
    if (['common_per_share', 'pro_rata_shares'].includes(pay.method) && 'dilutionRounds' in pay) {
      err(errors, `${p}.payout.dilutionRounds`, 'dilution_not_allowed', 'Dilution is accepted only under pro_rata_ownership.');
    }
    try {
      if (pay.method === 'pro_rata_ownership') retentionFraction(pay.dilutionRounds ?? []);
      if (pay.method === 'pro_rata_shares' && !(parseUnits(pay.fullyDilutedExitShares) > 0n)) throw new CoreInputError('invalid_shares', 'fullyDilutedExitShares must be positive.');
      if (pay.method === 'pro_rata_shares' || pay.method === 'pro_rata_ownership') parseDecimal(pay.equityExitValue, 6);
      if (pay.method === 'common_per_share') parseDecimal(pay.commonProceedsPerShare, 6);
      if (!['common_per_share', 'pro_rata_shares', 'pro_rata_ownership', 'none'].includes(pay.method)) err(errors, `${p}.payout.method`, 'unknown_payout_method', 'Unknown payout method.');
    } catch (e) {
      err(errors, `${p}.payout`, e.code ?? 'invalid_payout', e.message);
    }
    const ex = sc.exercisePath ?? {};
    if (ex.kind === 'at_date') {
      if (!Number.isInteger(ex.exerciseMonthsFromStart)) err(errors, `${p}.exercisePath.exerciseMonthsFromStart`, 'exercise_months_missing', 'at_date exercise needs exerciseMonthsFromStart.');
      else if (liq.occurs && Number.isInteger(liq.monthsFromStart) && ex.exerciseMonthsFromStart > liq.monthsFromStart) err(errors, `${p}.exercisePath.exerciseMonthsFromStart`, 'exercise_after_liquidity', 'Exercise date is after liquidity.');
    } else if (ex.kind !== 'at_liquidity') err(errors, `${p}.exercisePath.kind`, 'unknown_exercise_path', 'Unknown exercise path.');
  }
  return errors;
}

function prepareCash(group, offer) {
  const limitations = [];
  const money = (fact, name) => {
    const r = readFact(fact, name);
    limitations.push(...r.limitations);
    return r.value === null ? null : parseDecimal(r.value, MONEY_SCALE);
  };
  const offerBase = money(offer.cash.annualBase, 'offer_base');
  const offerBonus = money(offer.cash.annualTargetBonus, 'offer_bonus');
  const signing = money(offer.cash.signingBonus, 'signing_bonus');
  const b = group.baseline;
  const baseBase = b.annualBase === null || b.annualBase === undefined ? null : parseDecimal(b.annualBase, MONEY_SCALE);
  const baseBonus = b.annualCashBonus === null || b.annualCashBonus === undefined ? null : parseDecimal(b.annualCashBonus, MONEY_SCALE);
  if (baseBase === null) limitations.push('baseline_missing');
  else if (baseBonus === null) limitations.push('baseline_bonus_missing');
  if (offerBonus !== null && offerBonus > 0n) limitations.push('bonus_uncertain');
  const m12 = (v) => (v === null ? null : divRound(v, 12n));
  return {
    limitations,
    offerBaseM: m12(offerBase), offerBonusM: m12(offerBonus), baseBaseM: m12(baseBase), baseBonusM: m12(baseBonus),
    signing,
    signingRepaymentMonths: offer.cash.signingRepaymentMonths ?? null,
  };
}

function addFlow(map, date, kind, amount) {
  const key = `${date}|${kind}`;
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function computeGrant(grant, sc, ctx) {
  const lim = new Set();
  const out = (extra) => ({
    res: {
      componentId: grant.componentId, vestedUnits: null, eligibleUnits: null, exerciseCost: null,
      realizedProceeds: null, illiquidResidual: null, limitations: [], ...extra,
    },
    flows: [], be: null, known: false, lim,
  });
  const finish = (o) => { o.res.limitations = sortedUnique([...lim]); return o; };
  if (grant.instrument !== 'iso' && grant.instrument !== 'nso') {
    lim.add(`instrument_unsupported:${grant.instrument}`);
    return finish(out({}));
  }
  const { S, E, H, L, realizeIn } = ctx.timeline(sc);
  const path = sc.exercisePath;
  const method = sc.payout.method;
  let exDate;
  let vestDate;
  if (path.kind === 'at_date') {
    exDate = addMonths(S, path.exerciseMonthsFromStart);
    vestDate = minDate(exDate, E);
  } else {
    exDate = L;
    vestDate = L === null ? E : minDate(E, L);
  }
  const frac = vestedFractionAt(grant, vestDate);
  frac.limitations.forEach((c) => lim.add(c));
  const u = readFact(grant.units, 'units');
  u.limitations.forEach((c) => lim.add(c));
  const U = u.value === null ? null : parseUnits(u.value);
  const kf = readFact(grant.strikePrice, 'strike_price');
  kf.limitations.forEach((c) => lim.add(c));
  const K = kf.value === null ? null : parseDecimal(kf.value, MONEY_SCALE);
  const vested = frac.num !== null && U !== null ? (U * frac.num) / frac.den : null;

  // Eligibility.
  let eligible = true;
  if (frac.num === null) eligible = null;
  else if (exDate !== null) {
    if (exDate > E) {
      const w = readFact(grant.exercise.postTerminationWindowMonths, 'post_termination_window');
      w.limitations.forEach((c) => lim.add(c));
      if (w.value === null) {
        eligible = null;
        lim.add('exercise_window_unknown');
      } else {
        const wm = parseDecimal(w.value, MONEY_SCALE);
        if (wm % pow10(MONEY_SCALE) !== 0n) lim.add('window_fractional_months_floored');
        if (addMonths(E, Number(wm / pow10(MONEY_SCALE))) < exDate) eligible = false;
      }
    }
    if (eligible !== false) {
      const gd = readFact(grant.grantDate, 'grant_date');
      const ey = readFact(grant.exercise.expirationYears, 'expiration_years');
      gd.limitations.forEach((c) => lim.add(c));
      ey.limitations.forEach((c) => lim.add(c));
      if (gd.value === null || ey.value === null) lim.add('grant_expiration_unknown');
      else {
        const months = Number((parseDecimal(ey.value, MONEY_SCALE) * 12n) / pow10(MONEY_SCALE));
        if (exDate > addMonths(gd.value, months)) eligible = false;
      }
    }
  }
  const o = out({ vestedUnits: vested === null ? null : vested.toString() });
  if (eligible === false) {
    o.res.eligibleUnits = '0';
    o.res.exerciseCost = formatMoney(0n);
    o.res.realizedProceeds = formatMoney(0n);
    o.known = true;
    o.be = { u: 0n, K: K ?? 0n, path: path.kind };
    if (!realizeIn) o.res.illiquidResidual = { units: '0', note: 'No eligible units remain.' };
    if (!realizeIn) lim.add('no_liquidity_in_horizon');
    return finish(o);
  }
  if (eligible === null) return finish(o);
  const eligUnits = vested; // eligible === true
  o.res.eligibleUnits = eligUnits === null ? null : eligUnits.toString();
  const cost = eligUnits !== null && K !== null ? eligUnits * K : null;
  o.res.exerciseCost = formatMoney(cost);
  if (eligUnits !== null && K !== null) o.be = { u: eligUnits, K, path: path.kind };

  // Gross value of the eligible units at the scenario's common value.
  let gross = null;
  if (method === 'none') gross = 0n;
  else if (method === 'common_per_share') {
    if (eligUnits !== null) gross = eligUnits * parseDecimal(sc.payout.commonProceedsPerShare, MONEY_SCALE);
  } else if (method === 'pro_rata_shares') {
    lim.add('excludes_preferences');
    if (eligUnits !== null) gross = divRound(eligUnits * parseDecimal(sc.payout.equityExitValue, MONEY_SCALE), parseUnits(sc.payout.fullyDilutedExitShares));
  } else {
    lim.add('excludes_preferences');
    const pf = readFact(grant.quotedOwnershipPct, 'ownership_pct');
    pf.limitations.forEach((c) => lim.add(c));
    if (grant.ownershipDenominator.basis === 'unknown') lim.add('ownership_denominator_unknown');
    else if (grant.ownershipDenominator.basis === 'outstanding') lim.add('ownership_basis_not_fully_diluted');
    if (pf.value !== null && frac.num !== null) {
      const { num, den } = retentionFraction(sc.payout.dilutionRounds);
      gross = divRound(
        parseDecimal(sc.payout.equityExitValue, MONEY_SCALE) * parseDecimal(pf.value, RATIO_SCALE) * num * frac.num,
        100n * R12 * den * frac.den,
      );
    }
    if (cost === null && method === 'pro_rata_ownership') lim.add('exercise_cost_unknown');
  }

  const flows = [];
  let realized = null;
  let known = false;
  if (path.kind === 'at_liquidity') {
    if (!realizeIn) {
      realized = 0n;
      known = true;
    } else if (method === 'none') {
      realized = 0n;
      known = true;
    } else if (gross !== null && cost !== null) {
      realized = maxBig(gross - cost, 0n);
      known = true;
      if (realized !== 0n) flows.push({ date: L, kind: 'proceeds', amount: realized });
    }
  } else if (cost !== null) {
    if (exDate <= H && cost !== 0n) flows.push({ date: exDate, kind: 'exercise', amount: -cost });
    if (!realizeIn) {
      realized = 0n;
      known = true;
    } else if (gross !== null) {
      realized = gross;
      known = true;
      if (gross !== 0n) flows.push({ date: L, kind: 'proceeds', amount: gross });
    }
  }
  o.res.realizedProceeds = known ? formatMoney(realized) : null;
  o.known = known;
  o.flows = known ? flows : [];
  if (!realizeIn) {
    lim.add('no_liquidity_in_horizon');
    o.res.illiquidResidual = {
      units: eligUnits === null ? null : eligUnits.toString(),
      note: 'Eligible units not realized within the horizon. This is not a valuation and not a statement that the company is worthless.',
    };
  }
  return finish(o);
}

/** Smallest P (scale 6) with sum(equity(P)) = F > 0, or null. */
function solveBreakEven(parts, F) {
  const live = parts.filter((p) => p.u > 0n);
  if (live.length === 0) return null;
  const atDate = live.filter((p) => p.path === 'at_date');
  const atLiq = live.filter((p) => p.path === 'at_liquidity').sort((a, b) => (a.K < b.K ? -1 : a.K > b.K ? 1 : 0));
  for (let j = 0; j <= atLiq.length; j += 1) {
    const active = [...atDate, ...atLiq.slice(0, j)];
    const slope = active.reduce((s, p) => s + p.u, 0n);
    if (slope === 0n) continue;
    const P = divRound(F + active.reduce((s, p) => s + p.u * p.K, 0n), slope);
    const lowOk = j === 0 || P >= atLiq[j - 1].K;
    const highOk = j === atLiq.length || P <= atLiq[j].K;
    if (lowOk && highOk) return P;
  }
  return null;
}

function computeScenario(sc, ctx) {
  const lim = new Set(['pre_tax_only', ...ctx.cash.limitations]);
  const c = ctx.cash;
  const { S, E, H } = ctx.timeline(sc);
  const post = sc.postServiceAnnualCash === null || sc.postServiceAnnualCash === undefined ? null : divRound(parseDecimal(sc.postServiceAnnualCash, MONEY_SCALE), 12n);
  const flows = new Map();
  const T = { ob: 0n, obo: 0n, bb: 0n, bbo: 0n };
  let postExcluded = false;
  for (let k = 0; ; k += 1) {
    const d = addMonths(S, k);
    if (d >= H) break;
    let ob;
    let obo;
    if (k < sc.serviceMonths) {
      ob = c.offerBaseM;
      obo = c.offerBonusM;
    } else if (post !== null) {
      ob = post;
      obo = 0n;
    } else {
      postExcluded = true;
      continue;
    }
    if (ob !== null) T.ob += ob;
    if (obo !== null) T.obo += obo;
    if (c.baseBaseM !== null) T.bb += c.baseBaseM;
    if (c.baseBonusM !== null) T.bbo += c.baseBonusM;
    if (ob !== null && c.baseBaseM !== null && ob !== c.baseBaseM) addFlow(flows, d, 'base', ob - c.baseBaseM);
    if (obo !== null && c.baseBonusM !== null && obo !== c.baseBonusM) addFlow(flows, d, 'bonus', obo - c.baseBonusM);
  }
  if (postExcluded) lim.add('post_service_cash_unmodeled');
  const offerBase = c.offerBaseM === null ? null : T.ob;
  const offerBonus = c.offerBonusM === null ? null : T.obo;
  const baselineBase = c.baseBaseM === null ? null : T.bb;
  const baselineBonus = c.baseBonusM === null ? null : T.bbo;
  const baseDifference = baselineBase !== null && offerBase !== null ? baselineBase - offerBase : null;
  const totalCashDifference = baseDifference !== null && baselineBonus !== null && offerBonus !== null
    ? baseDifference + (baselineBonus - offerBonus) : null;

  // Signing.
  const signingKnown = c.signing !== null;
  if (signingKnown && c.signing > 0n) {
    if (S <= H) addFlow(flows, S, 'signing', c.signing);
    if (c.signingRepaymentMonths === null) lim.add('signing_repayment_unknown');
    else if (sc.serviceMonths < c.signingRepaymentMonths && E <= H) addFlow(flows, E, 'signing_repayment', -c.signing);
  }

  // Equity.
  const grants = [];
  const equityFlows = [];
  let allKnown = true;
  let beKnown = true;
  const parts = [];
  for (const g of ctx.offer.grants) {
    const r = computeGrant(g, sc, ctx);
    grants.push(r.res);
    r.res.limitations.forEach((x) => lim.add(x));
    if (!r.known) allKnown = false;
    if (r.be) parts.push(r.be);
    else beKnown = false;
    for (const f of r.flows) {
      equityFlows.push(f);
      addFlow(flows, f.date, f.kind, f.amount);
    }
  }
  if (sc.payout.method === 'pro_rata_shares' || sc.payout.method === 'pro_rata_ownership') lim.add('excludes_preferences');

  const cashFlows = [...flows.entries()]
    .filter(([, v]) => v !== 0n)
    .map(([k, v]) => { const [date, kind] = k.split('|'); return { date, kind, amount: v }; })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));

  const netKnown = totalCashDifference !== null && signingKnown && allKnown;
  const netPreTax = netKnown ? cashFlows.reduce((s, f) => s + f.amount, 0n) : null;

  let maxFunding = null;
  if (allKnown) {
    const sorted = [...equityFlows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    let run = 0n;
    let low = 0n;
    for (const f of sorted) {
      run += f.amount;
      if (run < low) low = run;
    }
    maxFunding = -low;
  }

  let npv = null;
  if (ctx.discount === null) lim.add('discount_rate_missing');
  else if (netPreTax !== null) {
    let acc = 0n;
    for (const f of cashFlows) {
      const months = monthsBetween(ctx.group.startDate, f.date);
      const factor = BigInt(Math.round(Math.pow(1 + ctx.discount.monthly, -months) * 1e12));
      acc += f.amount * factor;
    }
    npv = divRound(acc, R12);
  }

  // Break-even common price.
  let breakEven = null;
  if (totalCashDifference !== null && signingKnown && allKnown && beKnown) {
    const signingNet = cashFlows.filter((f) => f.kind === 'signing' || f.kind === 'signing_repayment').reduce((s, f) => s + f.amount, 0n);
    const F = totalCashDifference - signingNet;
    if (F <= 0n) {
      breakEven = 0n;
      lim.add('offer_pays_more');
    } else {
      const { realizeIn } = ctx.timeline(sc);
      const P = realizeIn ? solveBreakEven(parts, F) : null;
      if (P === null) lim.add('no_solution');
      else breakEven = P;
    }
  }
  return {
    scenarioId: sc.scenarioId,
    label: sc.label,
    kind: sc.kind,
    cash: {
      offerBase: formatMoney(offerBase), offerBonus: formatMoney(offerBonus),
      baselineBase: formatMoney(baselineBase), baselineBonus: formatMoney(baselineBonus),
      baseDifference: formatMoney(baseDifference), totalCashDifference: formatMoney(totalCashDifference),
    },
    grants,
    cashFlows: cashFlows.map((f) => ({ date: f.date, amount: formatMoney(f.amount), kind: f.kind })),
    maxCumulativeFundingNeed: formatMoney(maxFunding),
    netPreTax: formatMoney(netPreTax),
    npv: formatMoney(npv),
    breakEvenCommonPrice: breakEven === null ? null : breakEven === 0n ? '0' : formatPerShare(breakEven),
    limitations: sortedUnique([...lim]),
    _net: netPreTax,
  };
}

function weigh(scenarioSet, rows) {
  const ws = scenarioSet.scenarios.map((s) => s.weightPct);
  if (ws.some((w) => w === null || w === undefined)) return { weighted: null, code: 'weights_incomplete' };
  const w6 = ws.map((w) => parseDecimal(w, 6));
  if (w6.reduce((a, b) => a + b, 0n) !== 100n * pow10(6)) return { weighted: null, code: 'weights_not_100' };
  if (rows.some((r) => r._net === null)) return { weighted: null, code: 'expected_value_unavailable' };
  const acc = rows.reduce((s, r, i) => s + w6[i] * r._net, 0n);
  return { weighted: { expectedNetPreTax: formatMoney(divRound(acc, 100n * pow10(6))) }, code: null };
}

export function calculateOffer(input) {
  const { group, offerRevision: offer, scenarioSet } = input ?? {};
  const errors = validate(group, offer, scenarioSet);
  if (errors.length) return { ok: false, errors };
  try {
    const S = readFact(offer.serviceStartDate, 'service_start').value;
    const H = addMonths(group.startDate, group.horizonMonths);
    const rate = group.discountRateAnnual === null || group.discountRateAnnual === undefined ? null : Number(group.discountRateAnnual);
    const ctx = {
      group, offer,
      cash: prepareCash(group, offer),
      discount: rate === null ? null : { monthly: Math.pow(1 + rate, 1 / 12) - 1 },
      timeline(sc) {
        const E = addMonths(S, sc.serviceMonths);
        const L = sc.liquidity.occurs ? addMonths(S, sc.liquidity.monthsFromStart) : null;
        return { S, E, H, L, realizeIn: L !== null && L <= H };
      },
    };
    const rows = scenarioSet.scenarios.map((sc) => computeScenario(sc, ctx));
    const w = weigh(scenarioSet, rows);
    const scenarios = rows.map(({ _net, ...r }) => r);
    const limitations = sortedUnique([...scenarios.flatMap((s) => s.limitations), ...(w.code ? [w.code] : [])]);
    return {
      ok: true,
      result: { calculatorVersion: CALCULATOR_VERSION, schemaVersion: 1, currency: group.currency, scenarios, weighted: w.weighted, limitations },
    };
  } catch (e) {
    return { ok: false, errors: [{ path: '', code: e.code ?? 'invalid_input', message: e.message }] };
  }
}

export { formatFixed };
