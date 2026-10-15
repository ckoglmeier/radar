// Synthetic fixtures only. Invented companies and numbers.
export const f = (value, state = 'user_reported') => ({ value, state });
export const missing = () => ({ value: null, state: 'missing' });

export function makeGroup(over = {}) {
  return {
    schemaVersion: 1, id: 'grp-1', title: 'Synthetic decision', mode: 'employment', currency: 'USD',
    startDate: '2026-01-15', horizonMonths: 48, discountRateAnnual: null,
    baseline: { kind: 'current_role', annualBase: '200000', annualCashBonus: '0' },
    status: 'open', ...over,
  };
}

export function makeGrant(over = {}) {
  return {
    componentId: 'comp-1', instrument: 'iso', units: f('48000'), quotedOwnershipPct: f('0.5'),
    ownershipDenominator: { basis: 'fully_diluted', asOfDate: '2026-01-01' },
    strikePrice: f('1.00'), grantDate: f('2026-01-15'), boardApproval: f('approved'),
    vesting: { commencementDate: f('2026-01-15'), totalMonths: 48, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
    exercise: { postTerminationWindowMonths: f('3'), expirationYears: f('10'), earlyExercise: f(false) },
    ...over,
  };
}

export function makeOffer(over = {}) {
  return {
    schemaVersion: 1, id: 'rev-1', opportunityId: 'opp-1', supersedesRevisionId: null, asOfDate: '2026-01-10',
    status: 'proposed', currency: 'USD',
    cash: { annualBase: f('150000'), annualTargetBonus: f('0'), signingBonus: f('0'), signingRepaymentMonths: null },
    serviceStartDate: f('2026-01-15'), grants: [makeGrant()], ...over,
  };
}

export function makeScenario(over = {}) {
  return {
    scenarioId: 'sc-base', label: 'Base case', kind: 'base', weightPct: null, serviceMonths: 48,
    liquidity: { occurs: true, monthsFromStart: 48 },
    payout: { method: 'common_per_share', commonProceedsPerShare: '5.00', source: 'Synthetic assumption', asOfDate: '2026-01-10' },
    exercisePath: { kind: 'at_liquidity' }, ...over,
  };
}

export function makeScenarioSet(scenarios = [makeScenario()], over = {}) {
  return { schemaVersion: 1, id: 'set-1', offerRevisionId: 'rev-1', currency: 'USD', scenarios, ...over };
}

export function makeOpportunity(over = {}) {
  return {
    schemaVersion: 1, id: 'opp-1', groupId: 'grp-1', companyName: 'Northwind Synthetic', relationship: 'employment',
    lifecycle: 'offer_received', ...over,
  };
}

// Legacy-workbook regression: invented numbers. Weights imply an implicit 38% zero remainder.
export const legacyGroup = makeGroup({ id: 'grp-legacy', horizonMonths: 36, discountRateAnnual: '0.1' });
export const legacyOffer = makeOffer({
  id: 'rev-legacy', opportunityId: 'opp-legacy',
  cash: { annualBase: f('90000'), annualTargetBonus: f('0'), signingBonus: f('0'), signingRepaymentMonths: null },
  grants: [makeGrant({
    units: f('36000'), strikePrice: f('0.50'),
    vesting: { commencementDate: f('2026-01-15'), totalMonths: 36, cliffMonths: 12, cadence: 'monthly', acceleration: 'none' },
  })],
});
export const legacyScenarioSet = makeScenarioSet([
  makeScenario({ scenarioId: 'low', label: 'Low', kind: 'downside', weightPct: '20', serviceMonths: 36, liquidity: { occurs: true, monthsFromStart: 36 }, payout: { method: 'common_per_share', commonProceedsPerShare: '1.00', source: 'Synthetic', asOfDate: '2026-01-10' } }),
  makeScenario({ scenarioId: 'mid', label: 'Mid', kind: 'base', weightPct: '30', serviceMonths: 36, liquidity: { occurs: true, monthsFromStart: 36 }, payout: { method: 'common_per_share', commonProceedsPerShare: '3.00', source: 'Synthetic', asOfDate: '2026-01-10' } }),
  makeScenario({ scenarioId: 'high', label: 'High', kind: 'upside', weightPct: '12', serviceMonths: 36, liquidity: { occurs: true, monthsFromStart: 36 }, payout: { method: 'common_per_share', commonProceedsPerShare: '9.00', source: 'Synthetic', asOfDate: '2026-01-10' } }),
], { id: 'set-legacy', offerRevisionId: 'rev-legacy' });

export const namedFixtures = {
  group: makeGroup(),
  groupLegacy: legacyGroup,
  opportunity: makeOpportunity(),
  offer: makeOffer(),
  offerLegacy: legacyOffer,
  scenarioSet: makeScenarioSet(),
  scenarioSetLegacy: legacyScenarioSet,
  scenarioSetOwnership: makeScenarioSet([makeScenario({
    scenarioId: 'own', payout: { method: 'pro_rata_ownership', equityExitValue: '1000000000', dilutionRounds: ['0.1', '0.2'] },
  })]),
  scenarioSetShares: makeScenarioSet([makeScenario({
    scenarioId: 'sh', payout: { method: 'pro_rata_shares', equityExitValue: '480000000', fullyDilutedExitShares: '96000000' },
  })]),
  scenarioSetNone: makeScenarioSet([makeScenario({ scenarioId: 'fail', kind: 'failure', payout: { method: 'none' }, liquidity: { occurs: false, monthsFromStart: null } })]),
};
