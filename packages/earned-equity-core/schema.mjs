// Frozen v1 contract for Earned Equity records. Coordinator-owned: builders
// propose changes rather than editing. Plain JSON Schema (AJV strict-compatible),
// no runtime dependencies, safe for browser and Node.

export const SCHEMA_VERSION = 1;

export const VALUE_STATES = Object.freeze([
  'confirmed_by_user', 'supported_by_document', 'user_reported',
  'illustrative', 'conflicting', 'missing', 'not_applicable', 'researched_unconfirmed',
]);

const id = { type: 'string', minLength: 1, maxLength: 128 };
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const decimal = { type: 'string', pattern: '^-?\\d{1,15}(\\.\\d{1,12})?$' };
const nonNegativeDecimal = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,12})?$' };
const units = { type: 'string', pattern: '^\\d{1,15}$' };
const currency = { type: 'string', enum: ['USD'] };
const note = { type: ['string', 'null'], maxLength: 2000 };

const evidenceRef = {
  type: 'object', additionalProperties: false,
  properties: {
    documentId: id,
    documentSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    locator: { type: 'string', maxLength: 200 },
    quote: { type: 'string', maxLength: 300 },
    assertionId: id,
  },
};

// A material input with provenance. value is null exactly when state is
// missing or not_applicable; unknown is never encoded as zero.
function fact(valueSchema) {
  return {
    type: 'object', additionalProperties: false, required: ['value', 'state'],
    properties: {
      value: { anyOf: [valueSchema, { type: 'null' }] },
      state: { type: 'string', enum: VALUE_STATES },
      sources: { type: 'array', maxItems: 20, items: evidenceRef },
      note,
    },
  };
}

export const decisionGroupSchema = {
  $id: 'earned-equity/decision-group.v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'mode', 'currency', 'startDate', 'horizonMonths', 'discountRateAnnual', 'baseline', 'status'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    title: { type: 'string', maxLength: 200 },
    mode: { type: 'string', enum: ['employment', 'advisory'] },
    currency,
    startDate: date,
    horizonMonths: { type: 'integer', minimum: 1, maximum: 240 },
    discountRateAnnual: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
    baseline: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'annualBase', 'annualCashBonus'],
      properties: {
        kind: { type: 'string', enum: ['current_role', 'alternative_offer', 'market_range', 'none'] },
        annualBase: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
        annualCashBonus: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
        benchmarkId: id,
        sourceNote: note,
      },
    },
    capacity: {
      type: 'object', additionalProperties: false,
      properties: {
        maxSelections: { type: ['integer', 'null'], minimum: 1 },
        hoursPerMonth: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
        exerciseFundingCapacity: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
      },
    },
    status: { type: 'string', enum: ['open', 'decided', 'archived'] },
  },
};

export const opportunitySchema = {
  $id: 'earned-equity/opportunity.v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'groupId', 'companyName', 'relationship', 'lifecycle'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    groupId: id,
    portfolioEntityId: { anyOf: [{ type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }, { type: 'null' }] },
    companyName: { type: 'string', minLength: 1, maxLength: 200 },
    relationship: { type: 'string', enum: ['employment', 'advisory', 'board', 'other'] },
    isStayPut: { type: 'boolean' },
    role: { type: 'string', maxLength: 200 },
    level: { type: 'string', maxLength: 100 },
    location: { type: 'string', maxLength: 200 },
    commitmentHoursPerMonth: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
    conflicts: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
    lifecycle: { type: 'string', enum: ['considering', 'offer_received', 'accepted', 'declined', 'expired', 'withdrawn'] },
  },
};

const vesting = {
  type: 'object', additionalProperties: false,
  required: ['commencementDate', 'totalMonths', 'cliffMonths', 'cadence', 'acceleration'],
  properties: {
    commencementDate: fact(date),
    totalMonths: { type: 'integer', minimum: 0, maximum: 240 },
    cliffMonths: { type: 'integer', minimum: 0, maximum: 240 },
    cadence: { type: 'string', enum: ['monthly', 'quarterly', 'annual', 'performance', 'other'] },
    acceleration: { type: 'string', enum: ['none', 'single_trigger', 'double_trigger', 'unknown'] },
  },
};

export const grantComponentSchema = {
  type: 'object', additionalProperties: false,
  required: ['componentId', 'instrument', 'units', 'quotedOwnershipPct', 'ownershipDenominator', 'strikePrice', 'grantDate', 'boardApproval', 'vesting', 'exercise'],
  properties: {
    componentId: id,
    instrument: { type: 'string', enum: ['iso', 'nso', 'rsu', 'restricted_stock', 'profits_interest', 'other'] },
    units: fact(units),
    quotedOwnershipPct: fact(nonNegativeDecimal),
    ownershipDenominator: {
      type: 'object', additionalProperties: false, required: ['basis', 'asOfDate'],
      properties: {
        basis: { type: 'string', enum: ['fully_diluted', 'outstanding', 'unknown'] },
        asOfDate: { anyOf: [date, { type: 'null' }] },
      },
    },
    strikePrice: fact(nonNegativeDecimal),
    grantDate: fact(date),
    boardApproval: fact({ type: 'string', enum: ['approved', 'pending'] }),
    vesting,
    exercise: {
      type: 'object', additionalProperties: false,
      required: ['postTerminationWindowMonths', 'expirationYears', 'earlyExercise'],
      properties: {
        postTerminationWindowMonths: fact(nonNegativeDecimal),
        expirationYears: fact(nonNegativeDecimal),
        earlyExercise: fact({ type: 'boolean' }),
      },
    },
  },
};

export const offerRevisionSchema = {
  $id: 'earned-equity/offer-revision.v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'opportunityId', 'supersedesRevisionId', 'asOfDate', 'status', 'currency', 'cash', 'serviceStartDate', 'grants'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    opportunityId: id,
    supersedesRevisionId: { anyOf: [id, { type: 'null' }] },
    asOfDate: date,
    status: { type: 'string', enum: ['proposed', 'signed', 'user_reported'] },
    currency,
    cash: {
      type: 'object', additionalProperties: false,
      required: ['annualBase', 'annualTargetBonus', 'signingBonus'],
      properties: {
        annualBase: fact(nonNegativeDecimal),
        annualTargetBonus: fact(nonNegativeDecimal),
        signingBonus: fact(nonNegativeDecimal),
        signingRepaymentMonths: { type: ['integer', 'null'], minimum: 0, maximum: 120 },
      },
    },
    serviceStartDate: fact(date),
    grants: { type: 'array', maxItems: 20, items: grantComponentSchema },
    valuationContext: {
      type: 'object', additionalProperties: false,
      properties: {
        preferredPricePerShare: fact(nonNegativeDecimal),
        postMoneyValuation: fact(nonNegativeDecimal),
        fullyDilutedShares: fact(units),
        fmv409APerShare: fact(nonNegativeDecimal),
        fmv409AAsOf: fact(date),
        lastRoundDate: fact(date),
        seniorClaimsAmount: fact(nonNegativeDecimal),
        preferenceTerms: fact({ type: 'string', maxLength: 500 }),
      },
    },
    note,
  },
};

const payoutMethod = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      required: ['method', 'commonProceedsPerShare', 'source', 'asOfDate'],
      properties: {
        method: { const: 'common_per_share' },
        commonProceedsPerShare: nonNegativeDecimal,
        source: { type: 'string', minLength: 1, maxLength: 500 },
        asOfDate: date,
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['method', 'equityExitValue', 'fullyDilutedExitShares'],
      properties: {
        method: { const: 'pro_rata_shares' },
        equityExitValue: nonNegativeDecimal,
        fullyDilutedExitShares: { type: 'string', pattern: '^[1-9]\\d{0,14}$' },
      },
    },
    {
      type: 'object', additionalProperties: false,
      required: ['method', 'equityExitValue', 'dilutionRounds'],
      properties: {
        method: { const: 'pro_rata_ownership' },
        equityExitValue: nonNegativeDecimal,
        dilutionRounds: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^0(\\.\\d{1,12})?$' } },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['method'],
      properties: { method: { const: 'none' } },
    },
  ],
};

export const scenarioSchema = {
  type: 'object', additionalProperties: false,
  required: ['scenarioId', 'label', 'kind', 'weightPct', 'serviceMonths', 'liquidity', 'payout', 'exercisePath'],
  properties: {
    scenarioId: id,
    label: { type: 'string', minLength: 1, maxLength: 120 },
    kind: { type: 'string', enum: ['failure', 'no_liquidity', 'downside', 'base', 'upside', 'custom'] },
    weightPct: { anyOf: [{ type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,6})?$' }, { type: 'null' }] },
    serviceMonths: { type: 'integer', minimum: 0, maximum: 240 },
    postServiceAnnualCash: { anyOf: [nonNegativeDecimal, { type: 'null' }] },
    liquidity: {
      type: 'object', additionalProperties: false, required: ['occurs', 'monthsFromStart'],
      properties: {
        occurs: { type: 'boolean' },
        monthsFromStart: { type: ['integer', 'null'], minimum: 0, maximum: 600 },
      },
    },
    payout: payoutMethod,
    exercisePath: {
      type: 'object', additionalProperties: false, required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['at_liquidity', 'at_date'] },
        exerciseMonthsFromStart: { type: ['integer', 'null'], minimum: 0, maximum: 600 },
      },
    },
    assumptionSources: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 500 } },
    rubricFindingIds: { type: 'array', maxItems: 50, items: id },
  },
};

export const scenarioSetSchema = {
  $id: 'earned-equity/scenario-set.v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'offerRevisionId', 'currency', 'scenarios'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    offerRevisionId: id,
    currency,
    scenarios: { type: 'array', minItems: 1, maxItems: 12, items: scenarioSchema },
  },
};

export const decisionRecordSchema = {
  $id: 'earned-equity/decision-record.v1',
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'groupId', 'comparedSnapshotIds', 'selectedOfferRevisionIds', 'outcome', 'rationale', 'acknowledgedRisks'],
  properties: {
    schemaVersion: { const: 1 },
    id,
    groupId: id,
    comparedSnapshotIds: { type: 'array', maxItems: 50, items: id },
    selectedOfferRevisionIds: { type: 'array', maxItems: 20, items: id },
    outcome: { type: 'string', enum: ['selected', 'stay_put', 'decline_all', 'deferred'] },
    rationale: { type: 'string', maxLength: 5000 },
    acknowledgedRisks: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } },
    // Deprecated (v1.2): kept only so earlier decisions still validate; new decisions omit it.
    gates: {
      type: 'object', additionalProperties: false, required: ['business', 'participation'],
      properties: {
        business: { type: 'string', enum: ['supported', 'failed', 'unresolved'] },
        participation: { type: 'string', enum: ['financially_attractive', 'learning_led_user_choice', 'unresolved', 'not_attractive'] },
      },
    },
    learningJudgment: {
      type: ['object', 'null'], additionalProperties: false,
      required: ['expectedLearning', 'whyThisRole', 'compensatesForShortfall'],
      properties: {
        expectedLearning: { type: 'string', maxLength: 2000 },
        whyThisRole: { type: 'string', maxLength: 2000 },
        compensatesForShortfall: { type: 'boolean' },
      },
    },
    contraryToAnalysis: { type: 'boolean' },
  },
};

export const SCHEMAS = Object.freeze({
  decisionGroup: decisionGroupSchema,
  opportunity: opportunitySchema,
  offerRevision: offerRevisionSchema,
  scenarioSet: scenarioSetSchema,
  decisionRecord: decisionRecordSchema,
});
