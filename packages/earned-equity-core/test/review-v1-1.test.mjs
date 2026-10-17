// Regression tests for the independent review (findings F1-F10) and amendments A1-A9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CALCULATOR_VERSION, calculateOffer, compareOffers, validateSelection, vestedUnitsAt } from '../index.mjs';
import { first, run } from './helpers.mjs';
import { f, makeGrant, makeGroup, makeOffer, makeOpportunity, makeScenario, makeScenarioSet, missing } from './fixtures/index.mjs';

const none = { liquidity: { occurs: false, monthsFromStart: null }, payout: { method: 'none' } };
const t0 = { commencementDate: f('2026-01-15'), totalMonths: 0, cliffMonths: 0, cadence: 'monthly', acceleration: 'none' };
const calc = (group, offerRevision, scenarioSet) => calculateOffer({ group, offerRevision, scenarioSet });

test('version is 1.2.1 and results carry their basis (A2)', () => {
  assert.equal(CALCULATOR_VERSION, 'earned-equity-core/1.2.1');
  const r = run({ group: makeGroup({ discountRateAnnual: '0.1' }) });
  assert.equal(r.calculatorVersion, 'earned-equity-core/1.2.1');
  assert.deepEqual(r.basis, { currency: 'USD', startDate: '2026-01-15', horizonMonths: 48, discountRateAnnual: '0.1' });
});

test('F1: exact accumulation, rounded once at output', () => {
  const offer = makeOffer({ grants: [], cash: { annualBase: f('150000.05'), annualTargetBonus: f('0'), signingBonus: f('0'), signingRepaymentMonths: null } });
  const s = first({ group: makeGroup({ horizonMonths: 6, baseline: { kind: 'none', annualBase: '0', annualCashBonus: '0' } }), offer, set: makeScenarioSet([makeScenario({ serviceMonths: 6, ...none })]) });
  assert.equal(s.cash.offerBase, '75000.02'); // 75000.025 rounds half-even once
  // The reviewer's weighted double-rounding case: true value 0.0149999995 rounds to 0.01.
  const g = makeGroup({ horizonMonths: 2, baseline: { kind: 'current_role', annualBase: '0.42', annualCashBonus: '0' } });
  const o = makeOffer({ grants: [], cash: { annualBase: f('0'), annualTargetBonus: f('0'), signingBonus: f('0.085'), signingRepaymentMonths: 2 } });
  const r = run({ group: g, offer: o, set: makeScenarioSet([
    makeScenario({ scenarioId: 'x', weightPct: '0.000001', serviceMonths: 1, ...none }),
    makeScenario({ scenarioId: 'y', weightPct: '99.999999', serviceMonths: 2, ...none }),
  ]) });
  assert.deepEqual(r.scenarios.map((s2) => s2.netPreTax), ['-0.04', '0.02']);
  assert.deepEqual(r.weighted, { expectedNetPreTax: '0.01' });
});

test('F2: 12-decimal prices are not truncated', () => {
  const offer = makeOffer({ grants: [makeGrant({ units: f('10000000'), strikePrice: f('0'), vesting: t0 })] });
  const set = makeScenarioSet([makeScenario({ payout: { method: 'common_per_share', commonProceedsPerShare: '1.0000005', source: 'x', asOfDate: '2026-01-10' } })]);
  assert.equal(first({ offer, set }).grants[0].realizedProceeds, '10000005.00');
});

test('F3: results computed on a different basis cannot be compared', () => {
  const a = run({ group: makeGroup({ horizonMonths: 48 }) });
  const offer2 = makeOffer({ id: 'rev-2', opportunityId: 'opp-2' });
  const b = run({ group: makeGroup({ horizonMonths: 24 }), offer: offer2, set: makeScenarioSet([makeScenario()], { offerRevisionId: 'rev-2' }) });
  const out = compareOffers({ group: makeGroup(), entries: [
    { opportunity: makeOpportunity(), offerRevision: makeOffer(), result: a },
    { opportunity: makeOpportunity({ id: 'opp-2' }), offerRevision: offer2, result: b },
  ] });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'comparison_basis_mismatch');
  assert.equal(out.errors[0].path, 'entries[1].result.basis.horizonMonths');
  const ok = compareOffers({ group: makeGroup(), entries: [{ opportunity: makeOpportunity(), offerRevision: makeOffer(), result: a }] });
  assert.equal(ok.ok, true);
});

test('F4: unknown grant expiration (A3)', () => {
  const long = { horizon: makeGroup({ horizonMonths: 200 }) };
  const at = (months) => makeScenarioSet([makeScenario({ serviceMonths: months, liquidity: { occurs: true, monthsFromStart: months } })]);
  const noDate = makeOffer({ grants: [makeGrant({ grantDate: missing() })] }); // asOfDate 2026-01-10, expiry 10y
  const near = first({ group: long.horizon, offer: noDate, set: at(100) }); // 2034-05-15 <= 2036-01-10
  assert.equal(near.grants[0].eligibleUnits, '48000');
  assert.equal(near.grants[0].realizedProceeds, '192000.00');
  const far = first({ group: long.horizon, offer: noDate, set: at(150) }); // 2038-07-15 > 2036-01-10
  assert.equal(far.grants[0].eligibleUnits, null);
  assert.equal(far.grants[0].realizedProceeds, null);
  assert.equal(far.netPreTax, null);
  assert.ok(far.limitations.includes('grant_expiration_unknown'));
  const noYears = makeOffer({ grants: [makeGrant({ exercise: { postTerminationWindowMonths: f('3'), expirationYears: missing(), earlyExercise: f(false) } })] });
  const unk = first({ offer: noYears });
  assert.equal(unk.netPreTax, null);
  assert.ok(unk.limitations.includes('grant_expiration_unknown'));
});

test('F5: known zero units give zero under pro_rata_ownership (A4)', () => {
  const set = makeScenarioSet([makeScenario({ payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: [] } })]);
  const s = first({ offer: makeOffer({ grants: [makeGrant({ units: f('0') })] }), set });
  assert.equal(s.grants[0].vestedUnits, '0');
  assert.equal(s.grants[0].eligibleUnits, '0');
  assert.equal(s.grants[0].realizedProceeds, '0.00');
  assert.equal(s.netPreTax, '-200000.00');
  // With units known the fraction is eligibleUnits / units: 17 of 48 months of 480 units.
  const part = first({
    offer: makeOffer({ grants: [makeGrant({ units: f('480') })] }),
    set: makeScenarioSet([makeScenario({ serviceMonths: 24, liquidity: { occurs: true, monthsFromStart: 24 }, payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: [] } })]),
  });
  assert.equal(part.grants[0].eligibleUnits, '240');
  assert.equal(part.grants[0].realizedProceeds, '2499760.00'); // 0.5% x 1e9 x 240/480 - 240 strike
});

test('F6: not_applicable cash terms count as zero; other fields error (A5)', () => {
  const na = { value: null, state: 'not_applicable' };
  const offer = makeOffer({ cash: { annualBase: f('150000'), annualTargetBonus: na, signingBonus: na, signingRepaymentMonths: null } });
  const s = first({ offer });
  assert.equal(s.cash.offerBonus, '0.00');
  assert.equal(s.cash.totalCashDifference, '200000.00');
  assert.equal(s.netPreTax, '-8000.00');
  assert.ok(!s.limitations.some((l) => /signing_bonus|offer_bonus|bonus_uncertain/.test(l)));
  const bad = calc(makeGroup(), makeOffer({ grants: [makeGrant({ strikePrice: na })] }), makeScenarioSet());
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'not_applicable_not_allowed:strike_price');
  assert.equal(bad.errors[0].path, 'offerRevision.grants[0].strikePrice');
  const base = calc(makeGroup(), makeOffer({ cash: { annualBase: na, annualTargetBonus: f('0'), signingBonus: f('0'), signingRepaymentMonths: null } }), makeScenarioSet());
  assert.equal(base.errors[0].code, 'not_applicable_not_allowed:offer_base');
});

test('F7: selection never assumes zero for unknown capacity inputs (A6)', () => {
  const group = makeGroup({ mode: 'advisory', capacity: { maxSelections: null, hoursPerMonth: '10', exerciseFundingCapacity: '1000' } });
  const opps = [makeOpportunity({ id: 'o1', commitmentHoursPerMonth: '8' }), makeOpportunity({ id: 'o2', commitmentHoursPerMonth: null })];
  const revs = [makeOffer({ id: 'r1', opportunityId: 'o1' }), makeOffer({ id: 'r2', opportunityId: 'o2' })];
  const v = validateSelection({
    group, opportunities: opps, offerRevisions: revs, selectedOfferRevisionIds: ['r1', 'r2'],
    results: { r1: { scenarios: [{ maxCumulativeFundingNeed: '900.00' }] }, r2: { scenarios: [{ maxCumulativeFundingNeed: null }] } },
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings.map((w) => w.code).sort(), ['capacity_hours_unknown', 'correlated_concentration', 'exercise_funding_unknown']);
  const noResults = validateSelection({ group, opportunities: opps, offerRevisions: revs, selectedOfferRevisionIds: ['r1'] });
  assert.ok(noResults.warnings.some((w) => w.code === 'exercise_funding_unknown'));
});

test('F8: the illiquid residual respects the window and expiry (A7)', () => {
  const ptw = (m) => makeOffer({ grants: [makeGrant({ exercise: { postTerminationWindowMonths: f(m), expirationYears: f('10'), earlyExercise: f(false) } })] });
  const noLiq = makeScenarioSet([makeScenario({ serviceMonths: 24, liquidity: { occurs: false, monthsFromStart: null } })]);
  const far = makeScenarioSet([makeScenario({ serviceMonths: 24, liquidity: { occurs: true, monthsFromStart: 100 } })]);
  for (const set of [noLiq, far]) {
    const s0 = first({ offer: ptw('0'), set });
    assert.equal(s0.grants[0].illiquidResidual.units, '0');
    assert.equal(s0.grants[0].realizedProceeds, '0.00');
    assert.ok(s0.limitations.includes('no_liquidity_in_horizon'));
    assert.equal(first({ offer: ptw('120'), set }).grants[0].illiquidResidual.units, '24000');
  }
  const unknownWindow = first({ offer: makeOffer({ grants: [makeGrant({ exercise: { postTerminationWindowMonths: missing(), expirationYears: f('10'), earlyExercise: f(false) } })] }), set: noLiq });
  assert.equal(unknownWindow.grants[0].illiquidResidual.units, null);
  assert.ok(unknownWindow.limitations.includes('exercise_window_unknown'));
  const shortExpiry = first({ offer: makeOffer({ grants: [makeGrant({ exercise: { postTerminationWindowMonths: f('120'), expirationYears: f('1'), earlyExercise: f(false) } })] }), set: noLiq });
  assert.equal(shortExpiry.grants[0].illiquidResidual.units, '0');
});

test('F9: cliff beyond the term errors; off-cadence term is flagged (A8)', () => {
  const bad = makeGrant({ vesting: { commencementDate: f('2026-01-15'), totalMonths: 12, cliffMonths: 24, cadence: 'monthly', acceleration: 'none' } });
  const out = calc(makeGroup(), makeOffer({ grants: [bad] }), makeScenarioSet());
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].code, 'vesting_cliff_exceeds_term');
  assert.equal(out.errors[0].path, 'offerRevision.grants[0].vesting.cliffMonths');
  assert.equal(vestedUnitsAt(bad, '2040-01-01').errors[0].code, 'vesting_cliff_exceeds_term');
  const off = makeGrant({ units: f('1000'), vesting: { commencementDate: f('2026-01-15'), totalMonths: 10, cliffMonths: 0, cadence: 'quarterly', acceleration: 'none' } });
  const r = vestedUnitsAt(off, '2026-11-15');
  assert.equal(r.units, '1000');
  assert.ok(r.limitations.includes('vesting_final_event_off_cadence'));
  assert.ok(!vestedUnitsAt(makeGrant(), '2030-01-15').limitations.includes('vesting_final_event_off_cadence'));
});

test('F10: impossible dates give structured errors; malformed compare does not throw (A9)', () => {
  const bad = calc(makeGroup(), makeOffer({ grants: [makeGrant({ grantDate: f('2026-02-30') })] }), makeScenarioSet());
  assert.equal(bad.ok, false);
  assert.deepEqual([bad.errors[0].code, bad.errors[0].path], ['invalid_date', 'offerRevision.grants[0].grantDate']);
  const badStart = calc(makeGroup({ startDate: '2026-13-01' }), makeOffer(), makeScenarioSet());
  assert.equal(badStart.errors[0].path, 'group.startDate');
  const badAsOf = calc(makeGroup(), makeOffer({ asOfDate: '2026-02-31' }), makeScenarioSet());
  assert.equal(badAsOf.errors[0].path, 'offerRevision.asOfDate');
  const badSvc = calc(makeGroup(), makeOffer({ serviceStartDate: f('2026-02-30') }), makeScenarioSet());
  assert.equal(badSvc.errors[0].path, 'offerRevision.serviceStartDate');
  const q = vestedUnitsAt(makeGrant(), '2026-13-01');
  assert.deepEqual([q.units, q.errors[0].code, q.errors[0].path], [null, 'invalid_date', 'isoDate']);
  const c = vestedUnitsAt(makeGrant({ vesting: { commencementDate: f('2026-02-31'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' } }), '2027-01-01');
  assert.deepEqual([c.units, c.errors[0].code, c.errors[0].path], [null, 'invalid_date', 'grant.vesting.commencementDate']);
  const cmp = compareOffers({ group: makeGroup(), entries: [{ offerRevision: makeOffer(), result: { currency: 'USD' } }] });
  assert.equal(cmp.ok, false);
  assert.equal(cmp.errors[0].code, 'invalid_entry');
  for (const junk of [undefined, null, {}, { group: 1, entries: 'x' }]) {
    assert.equal(compareOffers(junk).ok, false);
    assert.equal(validateSelection(junk).ok === false || validateSelection(junk).ok === true, true);
  }
  assert.equal(validateSelection({ group: makeGroup(), opportunities: 'x', offerRevisions: null, selectedOfferRevisionIds: 5 }).ok, false);
});

// ---- v1.2.0 (round 4): N1 / A4a, A3a, M1 and M2 / A9a, M3 / A10 ----

test('N1: known zero units give 0.00 even when the ownership percentage is unusable', () => {
  const own = { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: [] };
  for (const pct of [missing(), f('0.5', 'illustrative')]) {
    for (const exercisePath of [{ kind: 'at_liquidity' }, { kind: 'at_date', exerciseMonthsFromStart: 24 }]) {
      const s = first({
        offer: makeOffer({ grants: [makeGrant({ units: f('0'), quotedOwnershipPct: pct })] }),
        set: makeScenarioSet([makeScenario({ payout: own, exercisePath })]),
      });
      assert.equal(s.grants[0].realizedProceeds, '0.00');
      assert.equal(s.netPreTax, '-200000.00');
    }
  }
  // Unknown units with an unusable percentage stay null.
  const unk = first({ offer: makeOffer({ grants: [makeGrant({ units: missing(), quotedOwnershipPct: missing() })] }), set: makeScenarioSet([makeScenario({ payout: own })]) });
  assert.equal(unk.grants[0].realizedProceeds, null);
});

test('A3a: the asOfDate bound applies only to proposed revisions', () => {
  const group = makeGroup({ horizonMonths: 200 });
  const set = makeScenarioSet([makeScenario({ serviceMonths: 100, liquidity: { occurs: true, monthsFromStart: 100 } })]);
  const grants = [makeGrant({ grantDate: missing() })];
  const proposed = first({ group, offer: makeOffer({ grants, status: 'proposed' }), set });
  assert.equal(proposed.grants[0].eligibleUnits, '48000');
  for (const status of ['signed', 'user_reported']) {
    const s = first({ group, offer: makeOffer({ grants, status }), set });
    assert.equal(s.grants[0].eligibleUnits, null);
    assert.equal(s.netPreTax, null);
    assert.ok(s.limitations.includes('grant_expiration_unknown'));
  }
});

test('M1: an invalid offer asOfDate is reported once', () => {
  const out = calc(makeGroup(), makeOffer({ asOfDate: '2026-02-31' }), makeScenarioSet());
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors.map((e) => [e.path, e.code]), [['offerRevision.asOfDate', 'invalid_date']]);
});

test('M2: ownershipDenominator.asOfDate is validated', () => {
  const g = makeGrant({ ownershipDenominator: { basis: 'fully_diluted', asOfDate: '2026-13-01' } });
  const out = calc(makeGroup(), makeOffer({ grants: [g] }), makeScenarioSet());
  assert.equal(out.ok, false);
  assert.deepEqual(out.errors.map((e) => [e.path, e.code]), [['offerRevision.grants[0].ownershipDenominator.asOfDate', 'invalid_date']]);
});

test('M3: the residual note says whether units are options or already-exercised shares', () => {
  const exercised = first({ set: makeScenarioSet([makeScenario({ exercisePath: { kind: 'at_date', exerciseMonthsFromStart: 24 }, liquidity: { occurs: true, monthsFromStart: 60 } })]) });
  assert.equal(exercised.grants[0].illiquidResidual.units, '24000');
  assert.match(exercised.grants[0].illiquidResidual.note, /already-exercised shares/i);
  assert.doesNotMatch(exercised.grants[0].illiquidResidual.note, /still exercisable/i);
  const options = first({ set: makeScenarioSet([makeScenario({ liquidity: { occurs: false, monthsFromStart: null } })]) });
  assert.match(options.grants[0].illiquidResidual.note, /still exercisable/i);
});
