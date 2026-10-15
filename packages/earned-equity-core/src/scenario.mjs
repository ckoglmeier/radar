// Scenario economics: cash, equity, funding, NPV, break-even and weighting.
// All money arithmetic is exact (BigInt rationals); rounding happens once, at output.
import { addMonths, isValidIsoDate, minDate, monthsBetween } from './dates.mjs';
import { CoreInputError, parseUnits } from './decimal.mjs';
import { readFact } from './facts.mjs';
import { sortedUnique } from './canonical-json.mjs';
import { Q, ZERO, formatQ } from './rational.mjs';
import { vestedFractionAt, vestingErrors } from './vesting.mjs';

export const CALCULATOR_VERSION = 'earned-equity-core/1.1.1';
const ONE = Q.int(1);
const money = (q) => formatQ(q, 2);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function retention(rounds) {
  let r = ONE;
  for (const d of rounds) {
    const q = Q.of(d);
    if (q.cmp(ZERO) < 0 || q.cmp(ONE) >= 0) throw new CoreInputError('invalid_dilution', `Dilution "${d}" must be in [0, 1).`);
    r = r.mul(ONE.sub(q));
  }
  return r;
}

/** Retained ownership after successive primary rounds, as a percentage with 4 decimals. */
export function ownershipRetentionPct(rounds) {
  return formatQ(retention(rounds).mul(Q.int(100)), 4);
}

const err = (errors, path, code, message) => errors.push({ path, code, message });

// Cash terms: not_applicable means the term does not exist and counts as zero.
function cashTerm(fact, name) {
  if (fact?.state === 'not_applicable') return { value: ZERO, limitations: [] };
  const r = readFact(fact, name);
  return { value: r.value === null ? null : Q.of(r.value), limitations: r.limitations };
}

function checkDate(errors, path, value) {
  if (typeof value === 'string' && !isValidIsoDate(value)) err(errors, path, 'invalid_date', `${path} is not a valid calendar date.`);
}

function checkNotApplicable(errors, path, fact, name) {
  if (fact?.state === 'not_applicable') err(errors, path, `not_applicable_not_allowed:${name}`, `${path} cannot be not_applicable.`);
}

function validate(group, offer, set) {
  const errors = [];
  if (!group || typeof group !== 'object' || !offer || typeof offer !== 'object' || !set || typeof set !== 'object') {
    err(errors, '', 'missing_input', 'group, offerRevision and scenarioSet are required.');
    return errors;
  }
  if (group.currency !== offer.currency) err(errors, 'offerRevision.currency', 'currency_mismatch', 'Offer currency differs from the group currency.');
  if (group.currency !== set.currency) err(errors, 'scenarioSet.currency', 'currency_mismatch', 'Scenario set currency differs from the group currency.');
  if (set.offerRevisionId !== offer.id) err(errors, 'scenarioSet.offerRevisionId', 'scenario_set_offer_mismatch', 'Scenario set belongs to a different offer revision.');
  if (!isValidIsoDate(group.startDate)) err(errors, 'group.startDate', 'invalid_date', 'Group startDate is not a valid calendar date.');
  if (!Number.isInteger(group.horizonMonths) || group.horizonMonths < 1) err(errors, 'group.horizonMonths', 'invalid_horizon', 'horizonMonths must be a positive integer.');
  if (!isValidIsoDate(offer.asOfDate)) err(errors, 'offerRevision.asOfDate', 'invalid_date', 'asOfDate must be a valid calendar date.');
  if (!offer.cash || typeof offer.cash !== 'object') {
    err(errors, 'offerRevision.cash', 'missing_input', 'cash is required.');
    return errors;
  }
  checkNotApplicable(errors, 'offerRevision.cash.annualBase', offer.cash.annualBase, 'offer_base');
  checkNotApplicable(errors, 'offerRevision.serviceStartDate', offer.serviceStartDate, 'service_start');
  const ss = readFact(offer.serviceStartDate, 'service_start');
  if (ss.value === null) {
    if (offer.serviceStartDate?.state !== 'not_applicable') err(errors, 'offerRevision.serviceStartDate', 'service_start_unusable', 'serviceStartDate must be a usable date for calculation.');
  } else if (!isValidIsoDate(ss.value)) err(errors, 'offerRevision.serviceStartDate', 'invalid_date', 'serviceStartDate is not a valid calendar date.');
  else if (isValidIsoDate(group.startDate) && ss.value < group.startDate) err(errors, 'offerRevision.serviceStartDate', 'service_start_before_group_start', 'Service starts before the group start date.');
  if (!Array.isArray(set.scenarios) || set.scenarios.length === 0) err(errors, 'scenarioSet.scenarios', 'no_scenarios', 'At least one scenario is required.');
  const scenarios = Array.isArray(set.scenarios) ? set.scenarios : [];
  const usesOwnership = scenarios.some((s) => s?.payout?.method === 'pro_rata_ownership');
  const compIds = new Set();
  for (const [i, g] of (offer.grants ?? []).entries()) {
    const p = `offerRevision.grants[${i}]`;
    if (compIds.has(g.componentId)) err(errors, `${p}.componentId`, 'duplicate_component', 'Duplicate componentId.');
    compIds.add(g.componentId);
    errors.push(...vestingErrors(g, p));
    const gd = readFact(g.grantDate, 'grant_date');
    checkDate(errors, `${p}.grantDate`, gd.value);
    checkDate(errors, `${p}.ownershipDenominator.asOfDate`, g.ownershipDenominator?.asOfDate);
    if (g.instrument === 'iso' || g.instrument === 'nso') {
      checkNotApplicable(errors, `${p}.units`, g.units, 'units');
      checkNotApplicable(errors, `${p}.strikePrice`, g.strikePrice, 'strike_price');
      checkNotApplicable(errors, `${p}.grantDate`, g.grantDate, 'grant_date');
      checkNotApplicable(errors, `${p}.exercise.postTerminationWindowMonths`, g.exercise?.postTerminationWindowMonths, 'post_termination_window');
      checkNotApplicable(errors, `${p}.exercise.expirationYears`, g.exercise?.expirationYears, 'expiration_years');
      if (usesOwnership) checkNotApplicable(errors, `${p}.quotedOwnershipPct`, g.quotedOwnershipPct, 'ownership_pct');
    }
  }
  const seen = new Set();
  for (const [i, sc] of scenarios.entries()) {
    const p = `scenarioSet.scenarios[${i}]`;
    if (!sc || typeof sc !== 'object') { err(errors, p, 'invalid_scenario', 'Scenario must be an object.'); continue; }
    if (seen.has(sc.scenarioId)) err(errors, `${p}.scenarioId`, 'duplicate_scenario', 'Duplicate scenarioId.');
    seen.add(sc.scenarioId);
    if (sc.weightPct !== null && sc.weightPct !== undefined) {
      try { Q.of(sc.weightPct); } catch { err(errors, `${p}.weightPct`, 'invalid_weight', 'weightPct is not a decimal.'); }
    }
    if (!Number.isInteger(sc.serviceMonths) || sc.serviceMonths < 0) err(errors, `${p}.serviceMonths`, 'invalid_service_months', 'serviceMonths must be a non-negative integer.');
    const liq = sc.liquidity ?? {};
    if (liq.occurs && !Number.isInteger(liq.monthsFromStart)) err(errors, `${p}.liquidity.monthsFromStart`, 'liquidity_months_missing', 'Liquidity occurs but monthsFromStart is missing.');
    const pay = sc.payout ?? {};
    if (['common_per_share', 'pro_rata_shares'].includes(pay.method) && 'dilutionRounds' in pay) {
      err(errors, `${p}.payout.dilutionRounds`, 'dilution_not_allowed', 'Dilution is accepted only under pro_rata_ownership.');
    }
    try {
      if (pay.method === 'pro_rata_ownership') retention(pay.dilutionRounds ?? []);
      if (pay.method === 'pro_rata_shares' && !(parseUnits(pay.fullyDilutedExitShares) > 0n)) throw new CoreInputError('invalid_shares', 'fullyDilutedExitShares must be positive.');
      if (pay.method === 'pro_rata_shares' || pay.method === 'pro_rata_ownership') Q.of(pay.equityExitValue);
      if (pay.method === 'common_per_share') {
        Q.of(pay.commonProceedsPerShare);
        checkDate(errors, `${p}.payout.asOfDate`, pay.asOfDate);
      }
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
  const take = (r) => { limitations.push(...r.limitations); return r.value; };
  const readBase = (fact, name) => { const r = readFact(fact, name); limitations.push(...r.limitations); return r.value === null ? null : Q.of(r.value); };
  const offerBase = readBase(offer.cash.annualBase, 'offer_base');
  const offerBonus = take(cashTerm(offer.cash.annualTargetBonus, 'offer_bonus'));
  const signing = take(cashTerm(offer.cash.signingBonus, 'signing_bonus'));
  const b = group.baseline;
  const baseBase = b.annualBase === null || b.annualBase === undefined ? null : Q.of(b.annualBase);
  const baseBonus = b.annualCashBonus === null || b.annualCashBonus === undefined ? null : Q.of(b.annualCashBonus);
  if (baseBase === null) limitations.push('baseline_missing');
  else if (baseBonus === null) limitations.push('baseline_bonus_missing');
  if (offerBonus !== null && offerBonus.cmp(ZERO) > 0) limitations.push('bonus_uncertain');
  return {
    limitations, offerBase, offerBonus, baseBase, baseBonus, signing,
    signingRepaymentMonths: offer.cash.signingRepaymentMonths ?? null,
  };
}

function addFlow(map, date, kind, amount) {
  const key = `${date}|${kind}`;
  map.set(key, (map.get(key) ?? ZERO).add(amount));
}

const sortFlows = (a, b) => cmpStr(a.date, b.date) || cmpStr(a.kind, b.kind);

function computeGrant(grant, sc, ctx) {
  const lim = new Set();
  const out = (extra) => ({
    res: {
      componentId: grant.componentId, vestedUnits: null, eligibleUnits: null, exerciseCost: null,
      realizedProceeds: null, illiquidResidual: null, limitations: [], ...extra,
    },
    flows: [], be: null, known: false,
  });
  const finish = (o) => { o.res.limitations = sortedUnique([...lim]); return o; };
  if (grant.instrument !== 'iso' && grant.instrument !== 'nso') {
    lim.add(`instrument_unsupported:${grant.instrument}`);
    return finish(out({}));
  }
  const { S, E, H, L, realizeIn } = ctx.timeline(sc);
  const path = sc.exercisePath;
  const method = sc.payout.method;
  const XD = path.kind === 'at_date' ? addMonths(S, path.exerciseMonthsFromStart) : null;
  // 'exercise' mode: an exercise event falls inside the horizon. Otherwise the residual is
  // assessed at the horizon end.
  const exercising = path.kind === 'at_date' ? XD <= H : realizeIn;
  const exDate = exercising ? (path.kind === 'at_date' ? XD : L) : null;
  const checkAt = exercising ? exDate : H;
  const vestDate = exercising ? minDate(exDate, E) : minDate(E, H);

  const frac = vestedFractionAt(grant, vestDate);
  frac.limitations.forEach((c) => lim.add(c));
  const u = readFact(grant.units, 'units');
  u.limitations.forEach((c) => lim.add(c));
  const U = u.value === null ? null : parseUnits(u.value);
  const kf = readFact(grant.strikePrice, 'strike_price');
  kf.limitations.forEach((c) => lim.add(c));
  const K = kf.value === null ? null : Q.of(kf.value);
  const vested = frac.num !== null && U !== null ? (U * frac.num) / frac.den : null;

  // Eligibility at checkAt: true, false, or null (unknown).
  let eligible = true;
  if (frac.num === null) eligible = null;
  else {
    let unknown = false;
    let expired = false;
    if (checkAt > E) {
      const w = readFact(grant.exercise.postTerminationWindowMonths, 'post_termination_window');
      w.limitations.forEach((c) => lim.add(c));
      if (w.value === null) {
        unknown = true;
        lim.add('exercise_window_unknown');
      } else {
        const wq = Q.of(w.value);
        const months = Number(wq.n / wq.d);
        if (wq.d !== 1n) lim.add('window_fractional_months_floored');
        if (addMonths(E, months) < checkAt) expired = true;
      }
    }
    const gd = readFact(grant.grantDate, 'grant_date');
    const ey = readFact(grant.exercise.expirationYears, 'expiration_years');
    gd.limitations.forEach((c) => lim.add(c));
    ey.limitations.forEach((c) => lim.add(c));
    if (ey.value === null) {
      unknown = true;
      lim.add('grant_expiration_unknown');
    } else {
      const eq = Q.of(ey.value).mul(Q.int(12));
      const months = Number(eq.n / eq.d);
      if (gd.value !== null) {
        if (checkAt > addMonths(gd.value, months)) expired = true;
      } else if (ctx.offer.status !== 'proposed' || checkAt > addMonths(ctx.offer.asOfDate, months)) {
        // Unknown grant date. For a proposed offer the grant cannot predate the as-of date, so
        // that bounds expiry. A signed or user-reported grant may predate it: expiry is unknown.
        unknown = true;
        lim.add('grant_expiration_unknown');
      }
    }
    eligible = expired ? false : unknown ? null : true;
  }

  const o = out({ vestedUnits: vested === null ? null : vested.toString() });
  const noLiq = () => {
    lim.add('no_liquidity_in_horizon');
  };
  const residual = (units, exercised) => ({
    units: units === null ? null : units.toString(),
    note: `${exercised
      ? 'Already-exercised shares held at the horizon end and not realized within it.'
      : 'Options still exercisable at the horizon end and not realized within it.'} This is not a valuation and not a statement that the company is worthless.`,
  });

  if (!exercising) {
    // No exercise event inside the horizon: realized equity is zero; report the residual.
    noLiq();
    o.known = true;
    o.res.realizedProceeds = money(ZERO);
    const units = eligible === false ? 0n : eligible === true ? vested : null;
    o.res.eligibleUnits = units === null ? null : units.toString();
    o.res.illiquidResidual = residual(units, false);
    if (units !== null) {
      const cost = units === 0n ? ZERO : K === null ? null : Q.int(units).mul(K);
      o.res.exerciseCost = cost === null ? null : money(cost);
      if (cost !== null) o.be = { u: units, K: K ?? ZERO, path: path.kind };
    }
    return finish(o);
  }

  if (eligible === false) {
    o.res.eligibleUnits = '0';
    o.res.exerciseCost = money(ZERO);
    o.res.realizedProceeds = money(ZERO);
    o.known = true;
    o.be = { u: 0n, K: K ?? ZERO, path: path.kind };
    if (!realizeIn) {
      noLiq();
      o.res.illiquidResidual = residual(0n, path.kind === 'at_date');
    }
    return finish(o);
  }
  if (eligible === null) return finish(o);

  const eligUnits = vested;
  o.res.eligibleUnits = eligUnits === null ? null : eligUnits.toString();
  const cost = eligUnits === null ? null : eligUnits === 0n ? ZERO : K === null ? null : Q.int(eligUnits).mul(K);
  o.res.exerciseCost = cost === null ? null : money(cost);
  if (cost !== null) o.be = { u: eligUnits, K: K ?? ZERO, path: path.kind };

  // Gross value of the eligible units at the scenario's common value.
  let gross = null;
  if (eligUnits === 0n || method === 'none') gross = ZERO; // known zero units: zero, before anything else is read
  else if (method === 'common_per_share') {
    if (eligUnits !== null) gross = Q.int(eligUnits).mul(Q.of(sc.payout.commonProceedsPerShare));
  } else if (method === 'pro_rata_shares') {
    lim.add('excludes_preferences');
    if (eligUnits !== null) gross = Q.int(eligUnits).mul(Q.of(sc.payout.equityExitValue)).div(Q.of(sc.payout.fullyDilutedExitShares));
  } else {
    lim.add('excludes_preferences');
    const pf = readFact(grant.quotedOwnershipPct, 'ownership_pct');
    pf.limitations.forEach((c) => lim.add(c));
    if (grant.ownershipDenominator.basis === 'unknown') lim.add('ownership_denominator_unknown');
    else if (grant.ownershipDenominator.basis === 'outstanding') lim.add('ownership_basis_not_fully_diluted');
    if (pf.value !== null) {
      // With units known the vested fraction is eligibleUnits / units; otherwise it comes from the schedule.
      let fraction;
      if (U !== null) fraction = U === 0n ? ZERO : Q.int(eligUnits).div(Q.int(U));
      else fraction = new Q(frac.num, frac.den);
      gross = Q.of(pf.value).div(Q.int(100)).mul(retention(sc.payout.dilutionRounds)).mul(Q.of(sc.payout.equityExitValue)).mul(fraction);
    }
    if (cost === null) lim.add('exercise_cost_unknown');
  }

  const flows = [];
  let realized = null;
  let known = false;
  if (path.kind === 'at_liquidity') {
    if (method === 'none') {
      realized = ZERO;
      known = true;
    } else if (gross !== null && cost !== null) {
      realized = gross.sub(cost);
      if (realized.cmp(ZERO) < 0) realized = ZERO;
      known = true;
      if (!realized.isZero()) flows.push({ date: L, kind: 'proceeds', amount: realized });
    }
  } else if (cost !== null) {
    if (!cost.isZero()) flows.push({ date: XD, kind: 'exercise', amount: ZERO.sub(cost) });
    if (!realizeIn) {
      realized = ZERO;
      known = true;
    } else if (gross !== null) {
      realized = gross;
      known = true;
      if (!gross.isZero()) flows.push({ date: L, kind: 'proceeds', amount: gross });
    }
  }
  o.res.realizedProceeds = known ? money(realized) : null;
  o.known = known;
  o.flows = known ? flows : [];
  if (!realizeIn) {
    noLiq();
    o.res.illiquidResidual = residual(eligUnits, path.kind === 'at_date');
  }
  return finish(o);
}

/** Smallest P with sum(equity(P)) = F > 0, or null. Exact. */
function solveBreakEven(parts, F) {
  const live = parts.filter((p) => p.u > 0n);
  if (live.length === 0) return null;
  const atDate = live.filter((p) => p.path === 'at_date');
  const atLiq = live.filter((p) => p.path === 'at_liquidity').sort((a, b) => a.K.cmp(b.K));
  for (let j = 0; j <= atLiq.length; j += 1) {
    const active = [...atDate, ...atLiq.slice(0, j)];
    const slope = active.reduce((s, p) => s + p.u, 0n);
    if (slope === 0n) continue;
    const P = F.add(active.reduce((s, p) => s.add(Q.int(p.u).mul(p.K)), ZERO)).div(Q.int(slope));
    const lowOk = j === 0 || P.cmp(atLiq[j - 1].K) >= 0;
    const highOk = j === atLiq.length || P.cmp(atLiq[j].K) <= 0;
    if (lowOk && highOk) return P;
  }
  return null;
}

function computeScenario(sc, ctx) {
  const lim = new Set(['pre_tax_only', ...ctx.cash.limitations]);
  const c = ctx.cash;
  const { S, E, H } = ctx.timeline(sc);
  const post = sc.postServiceAnnualCash === null || sc.postServiceAnnualCash === undefined ? null : Q.of(sc.postServiceAnnualCash);
  const twelve = Q.int(12);
  const flows = new Map();
  let nServ = 0;
  let nPost = 0;
  let postExcluded = false;
  for (let k = 0; ; k += 1) {
    const d = addMonths(S, k);
    if (d >= H) break;
    const serving = k < sc.serviceMonths;
    if (!serving && post === null) { postExcluded = true; continue; }
    if (serving) nServ += 1; else nPost += 1;
    const ob = serving ? c.offerBase : post;
    const obo = serving ? c.offerBonus : ZERO;
    if (ob !== null && c.baseBase !== null) addFlow(flows, d, 'base', ob.sub(c.baseBase).div(twelve));
    if (obo !== null && c.baseBonus !== null) addFlow(flows, d, 'bonus', obo.sub(c.baseBonus).div(twelve));
  }
  if (postExcluded) lim.add('post_service_cash_unmodeled');
  const per = (annual, n) => annual.mul(Q.int(n)).div(twelve);
  const nAll = nServ + nPost;
  const offerBase = c.offerBase === null ? null : per(c.offerBase, nServ).add(post === null ? ZERO : per(post, nPost));
  const offerBonus = c.offerBonus === null ? null : per(c.offerBonus, nServ);
  const baselineBase = c.baseBase === null ? null : per(c.baseBase, nAll);
  const baselineBonus = c.baseBonus === null ? null : per(c.baseBonus, nAll);
  const baseDifference = baselineBase !== null && offerBase !== null ? baselineBase.sub(offerBase) : null;
  const totalCashDifference = baseDifference !== null && baselineBonus !== null && offerBonus !== null
    ? baseDifference.add(baselineBonus.sub(offerBonus)) : null;

  // Signing.
  const signingKnown = c.signing !== null;
  let signingNet = ZERO;
  if (signingKnown && c.signing.cmp(ZERO) > 0) {
    if (S <= H) { addFlow(flows, S, 'signing', c.signing); signingNet = signingNet.add(c.signing); }
    if (c.signingRepaymentMonths === null) lim.add('signing_repayment_unknown');
    else if (sc.serviceMonths < c.signingRepaymentMonths && E <= H) {
      addFlow(flows, E, 'signing_repayment', ZERO.sub(c.signing));
      signingNet = signingNet.sub(c.signing);
    }
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
    .filter(([, v]) => !v.isZero())
    .map(([k, v]) => { const [date, kind] = k.split('|'); return { date, kind, amount: v }; })
    .sort(sortFlows);

  const netKnown = totalCashDifference !== null && signingKnown && allKnown;
  const netPreTax = netKnown ? cashFlows.reduce((s, f) => s.add(f.amount), ZERO) : null;

  let maxFunding = null;
  if (allKnown) {
    let run = ZERO;
    let low = ZERO;
    for (const f of [...equityFlows].sort(sortFlows)) {
      run = run.add(f.amount);
      if (run.cmp(low) < 0) low = run;
    }
    maxFunding = ZERO.sub(low);
  }

  let npv = null;
  if (ctx.discount === null) lim.add('discount_rate_missing');
  else if (netPreTax !== null) {
    npv = ZERO;
    for (const f of cashFlows) {
      const months = monthsBetween(ctx.group.startDate, f.date);
      const factor = BigInt(Math.round(Math.pow(1 + ctx.discount.monthly, -months) * 1e12));
      npv = npv.add(f.amount.mul(new Q(factor, 10n ** 12n)));
    }
  }

  let breakEven = null;
  let breakEvenText = null;
  if (totalCashDifference !== null && signingKnown && allKnown && beKnown) {
    const F = totalCashDifference.sub(signingNet);
    if (F.cmp(ZERO) <= 0) {
      breakEvenText = '0';
      lim.add('offer_pays_more');
    } else {
      const P = ctx.timeline(sc).realizeIn ? solveBreakEven(parts, F) : null;
      if (P === null) lim.add('no_solution');
      else breakEven = P;
    }
  }
  return {
    scenarioId: sc.scenarioId,
    label: sc.label,
    kind: sc.kind,
    cash: {
      offerBase: offerBase && money(offerBase), offerBonus: offerBonus && money(offerBonus),
      baselineBase: baselineBase && money(baselineBase), baselineBonus: baselineBonus && money(baselineBonus),
      baseDifference: baseDifference && money(baseDifference), totalCashDifference: totalCashDifference && money(totalCashDifference),
    },
    grants,
    cashFlows: cashFlows.map((f) => ({ date: f.date, amount: money(f.amount), kind: f.kind })),
    maxCumulativeFundingNeed: maxFunding && money(maxFunding),
    netPreTax: netPreTax && money(netPreTax),
    npv: npv && money(npv),
    breakEvenCommonPrice: breakEvenText ?? (breakEven === null ? null : formatQ(breakEven, 6)),
    limitations: sortedUnique([...lim]),
    _net: netPreTax,
  };
}

function weigh(scenarioSet, rows) {
  const ws = scenarioSet.scenarios.map((s) => s.weightPct);
  if (ws.some((w) => w === null || w === undefined)) return { weighted: null, code: 'weights_incomplete' };
  const wq = ws.map((w) => Q.of(w));
  if (wq.reduce((a, b) => a.add(b), ZERO).cmp(Q.int(100)) !== 0) return { weighted: null, code: 'weights_not_100' };
  if (rows.some((r) => r._net === null)) return { weighted: null, code: 'expected_value_unavailable' };
  const acc = rows.reduce((s, r, i) => s.add(wq[i].mul(r._net)), ZERO);
  return { weighted: { expectedNetPreTax: money(acc.div(Q.int(100))) }, code: null };
}

export function calculateOffer(input) {
  const { group, offerRevision: offer, scenarioSet } = input ?? {};
  let errors;
  try {
    errors = validate(group, offer, scenarioSet);
  } catch (e) {
    return { ok: false, errors: [{ path: '', code: e.code ?? 'invalid_input', message: e.message }] };
  }
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
      result: {
        calculatorVersion: CALCULATOR_VERSION, schemaVersion: 1, currency: group.currency,
        basis: { currency: group.currency, startDate: group.startDate, horizonMonths: group.horizonMonths, discountRateAnnual: group.discountRateAnnual ?? null },
        scenarios, weighted: w.weighted, limitations,
      },
    };
  } catch (e) {
    return { ok: false, errors: [{ path: '', code: e.code ?? 'invalid_input', message: e.message }] };
  }
}
