import { query, writeCapabilities } from '../db/index.js';
import {
  addEmploymentEquityGrant,
  addInvestmentLot,
  addIssuerDisclosure,
  archiveEmploymentEquityPosition,
  createEmploymentEquityIssuer,
  createEmploymentEquityPosition,
  recordBasisAdjustment,
  recordEmploymentEquityDisposition,
  recordEmploymentEquityDistribution,
  recordExerciseOrPurchase,
  recordSettlement,
  restoreEmploymentEquityPosition,
} from '../models/employment-equity.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const number = { type: 'number', minimum: 0 };
const nullableNumber = { anyOf: [number, { type: 'null' }] };
const date = { type: 'string', format: 'date' };
const nullableDate = { anyOf: [date, { type: 'null' }] };
const uuid = { type: 'string', format: 'uuid' };
const nullableUuid = { anyOf: [uuid, { type: 'null' }] };
const grantInstrument = { type: 'string', enum: ['ppu', 'common_stock', 'iso', 'nso', 'rsu', 'profits_interest', 'other'] };
const lotInstrument = { type: 'string', enum: ['ppu', 'common_stock', 'iso', 'nso', 'rsu', 'preferred_stock', 'profits_interest', 'safe', 'convertible_note', 'other'] };
const basisSource = { type: 'string', enum: ['manual', 'grant_document', 'exercise_confirmation', 'tax_record', 'company_statement', 'other'] };
const disclosureType = { type: 'string', enum: ['rule_701', 'plan_document', 'grant_agreement', '409a', 'tender_notice', 'cap_table_statement', 'k1', 'tax_election', 'exercise_confirmation', 'company_financials', 'other'] };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function base(definition) {
  return {
    version: 1, tier: 'A', domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available, resultSchema: objectResult, plannerExposure: true,
    interactionPolicy: 'execute_inline', undoPolicy: 'unavailable',
    ...definition,
  };
}

async function positionTarget(investmentId) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.asset_class, i.portfolio_entity_id,
           eep.archived_at
      FROM investments i
      JOIN employment_equity_positions eep ON eep.investment_id = i.id
     WHERE i.id = $1
  `, [investmentId]);
  if (!row || row.asset_class !== 'employment_equity') throw new CommandError('TARGET_NOT_FOUND', `Employment Equity position not found: ${investmentId}`);
  return { type: 'employment_equity_position', id: Number(row.id), label: row.company_name, portfolioEntityId: row.portfolio_entity_id };
}

async function inspectPosition(target) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.updated_at, eep.archived_at, eep.updated_at AS profile_updated_at,
           (SELECT COUNT(*)::int FROM employment_equity_grants g WHERE g.investment_id = i.id) AS grant_count,
           (SELECT COUNT(*)::int FROM investment_lots l WHERE l.investment_id = i.id) AS lot_count,
           (SELECT COUNT(*)::int FROM employment_equity_events e WHERE e.investment_id = i.id) AS event_count,
           (SELECT COUNT(*)::int FROM valuations v WHERE v.investment_id = i.id) AS valuation_count
      FROM investments i JOIN employment_equity_positions eep ON eep.investment_id = i.id
     WHERE i.id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Employment Equity position not found: ${target.id}`);
  return row;
}

function childCommand({ name, title, description, fieldsSchema, requiredFields, apply, risk = 'additive_reporting_fact', interactionPolicy = 'execute_inline' }) {
  return base({
    name, title, description, risk, interactionPolicy,
    applyCapabilities: risk === 'sensitive_basis' ? ['portfolio:apply:additive'] : ['portfolio:apply:additive'],
    editableInputKeys: ['fields'],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      fields: schema(fieldsSchema, requiredFields),
    }, ['investmentId', 'fields']),
    resolve: input => positionTarget(input.investmentId), inspect: inspectPosition,
    preview: ({ target, current }) => ({ summary: `${title} for ${target.label}.`, target, before: [{ field: 'record_count', value: current.event_count }], after: [{ field: 'new_record', value: true }], derivedEffects: [], warnings: [], requiredReason: risk === 'sensitive_basis' }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => apply(target, input.fields),
    affectedResources: ({ target }) => [target],
  });
}

const grantFields = {
  grantIdentifier: nullableText, legalInstrumentName: text,
  instrumentType: grantInstrument, grantDate: date, unitsGranted: number,
  unitsVestedConfirmed: nullableNumber, balanceAsOfDate: nullableDate,
  strikePrice: nullableNumber, expirationDate: nullableDate,
  hurdleAmount: nullableNumber, vestingTermsSummary: nullableText,
};

const lotFields = {
  grantId: nullableUuid, acquisitionDate: date, taxHoldingStartDate: nullableDate,
  instrumentType: lotInstrument, shareOrUnitClass: nullableText,
  unitsAcquired: number, acquisitionPricePerUnit: nullableNumber,
  fairMarketValuePerUnit: nullableNumber, fairMarketValueDate: nullableDate,
  cashOutlay: nullableNumber, taxBasis: nullableNumber, compensationBasis: nullableNumber,
  basisAsOfDate: nullableDate, basisSource: { anyOf: [basisSource, { type: 'null' }] },
};

const exerciseFields = {
  grantId: uuid, date, units: number, cashOutlay: nullableNumber,
  acquisitionPricePerUnit: nullableNumber, fairMarketValuePerUnit: nullableNumber,
  fairMarketValueDate: nullableDate, taxHoldingStartDate: nullableDate,
  taxBasis: nullableNumber, compensationBasis: nullableNumber,
  basisAsOfDate: nullableDate, notes: nullableText, externalHash: nullableText,
};

const settlementFields = {
  grantId: uuid, date, units: number, fairMarketValuePerUnit: nullableNumber,
  fairMarketValueDate: nullableDate, taxHoldingStartDate: nullableDate,
  taxBasis: nullableNumber, compensationBasis: nullableNumber,
  basisAsOfDate: nullableDate, notes: nullableText, externalHash: nullableText,
};

export const employmentLifecycleCommandDefinitions = [
  base({
    name: 'employment.create_issuer', title: 'Create Employment issuer',
    description: 'Create an operating-company issuer for Employment Equity reporting.',
    risk: 'metadata_change',
    editableInputKeys: ['legalName', 'legalForm', 'jurisdiction', 'relationshipStatus', 'employmentStartDate', 'employmentEndDate'],
    inputSchema: schema({
      legalName: text, legalForm: nullableText, jurisdiction: nullableText,
      relationshipStatus: nullableText, employmentStartDate: nullableDate, employmentEndDate: nullableDate,
    }, ['legalName']),
    resolve: input => ({ type: 'employment_issuer_name', id: input.legalName.trim().toLowerCase(), label: input.legalName.trim() }),
    inspect: async target => ({ existing: (await query(`SELECT id FROM portfolio_entities WHERE entity_type = 'operating_company' AND normalized_name = $1`, [target.id]))[0] || null }),
    preview: ({ target, current }) => {
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `${target.label} already exists.`);
      return { summary: `Create issuer ${target.label}.`, target, before: [], after: [{ field: 'legal_name', value: target.label }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => createEmploymentEquityIssuer(input),
    inspectAfter: async ({ result }) => (await query('SELECT * FROM portfolio_entities WHERE id = $1', [result.entity.id]))[0],
    affectedResources: ({ result }) => [{ type: 'employment_issuer', id: result.entity.id, label: result.entity.legal_name }],
  }),
  base({
    name: 'employment.create_position', title: 'Create Employment position',
    description: 'Create an Employment Equity position with its opening instrument and valuation evidence.',
    risk: 'metadata_change',
    editableInputKeys: ['displayName', 'description'],
    inputSchema: schema({
      portfolioEntityId: uuid, displayName: text,
      instrumentFamily: { type: 'string', enum: ['ppu', 'common_stock', 'iso', 'nso', 'rsu', 'profits_interest', 'other'] },
      investDate: date, ownershipEntity: nullableText, description: nullableText,
      firstGrant: { anyOf: [schema(grantFields, ['legalInstrumentName', 'instrumentType', 'grantDate', 'unitsGranted']), { type: 'null' }] },
      firstLot: { anyOf: [schema(lotFields, ['acquisitionDate', 'instrumentType', 'unitsAcquired']), { type: 'null' }] },
      openingValuations: {
        type: 'array', items: schema({
          date, vestedValue: number, unvestedValue: nullableNumber,
          commonShareValuePerUnit: nullableNumber, taxFmvPerUnit: nullableNumber,
          methodology: nullableText, confidence: nullableText, notes: nullableText,
        }, ['date', 'vestedValue']),
      },
    }, ['portfolioEntityId', 'displayName', 'instrumentFamily', 'investDate']),
    resolve: async input => {
      const [entity] = await query(`SELECT id, legal_name, entity_type FROM portfolio_entities WHERE id = $1`, [input.portfolioEntityId]);
      if (!entity || entity.entity_type !== 'operating_company') throw new CommandError('TARGET_NOT_FOUND', 'Employment issuer not found.');
      return { type: 'employment_issuer', id: entity.id, label: entity.legal_name };
    },
    inspect: async (target, input) => ({ existing: (await query(`SELECT id FROM investments WHERE portfolio_entity_id = $1 AND asset_class = 'employment_equity' AND invest_date = $2::date AND company_name = $3`, [target.id, input.investDate, input.displayName]))[0] || null }),
    preview: ({ target, input, current }) => {
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `${input.displayName} already exists.`);
      return { summary: `Create ${input.displayName} for ${target.label}.`, target, before: [], after: [{ field: 'instrument_family', value: input.instrumentFamily }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => createEmploymentEquityPosition(input),
    inspectAfter: ({ result }) => inspectPosition({ id: result.investment.id }),
    affectedResources: ({ result }) => [{ type: 'employment_equity_position', id: Number(result.investment.id), label: result.investment.company_name }],
  }),
  base({
    name: 'employment.set_active', title: 'Set Employment position activity',
    description: 'Archive or restore an Employment Equity position without deleting history.',
    risk: 'lifecycle', undoPolicy: 'inverse', editableInputKeys: ['active'],
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, active: { type: 'boolean' } }, ['investmentId', 'active']),
    resolve: input => positionTarget(input.investmentId), inspect: inspectPosition,
    preview: ({ target, input, current }) => ({ summary: `${input.active ? 'Restore' : 'Archive'} ${target.label}.`, target, before: [{ field: 'active', value: current.archived_at == null }], after: [{ field: 'active', value: input.active }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => input.active ? restoreEmploymentEquityPosition(target.id) : archiveEmploymentEquityPosition(target.id),
    affectedResources: ({ target }) => [target],
    undo: ({ target, before }) => before.archived_at == null ? restoreEmploymentEquityPosition(target.id) : archiveEmploymentEquityPosition(target.id),
  }),
  childCommand({
    name: 'employment.add_grant', title: 'Add Employment grant',
    description: 'Add a grant instrument to an Employment Equity position.',
    fieldsSchema: grantFields, requiredFields: ['legalInstrumentName', 'instrumentType', 'grantDate', 'unitsGranted'],
    apply: (target, fields) => addEmploymentEquityGrant(target.id, fields),
  }),
  childCommand({
    name: 'employment.add_lot', title: 'Add Employment lot',
    description: 'Add a tax and ownership lot to an Employment Equity position.',
    fieldsSchema: lotFields, requiredFields: ['acquisitionDate', 'instrumentType', 'unitsAcquired'],
    apply: (target, fields) => addInvestmentLot(target.id, fields),
  }),
  childCommand({
    name: 'employment.record_exercise', title: 'Record Employment exercise',
    description: 'Record an option exercise or share purchase with its basis evidence.',
    fieldsSchema: exerciseFields, requiredFields: ['grantId', 'date', 'units'],
    apply: (target, fields) => recordExerciseOrPurchase(target.id, fields),
  }),
  childCommand({
    name: 'employment.record_settlement', title: 'Record Employment settlement',
    description: 'Record settlement of an Employment Equity grant.',
    fieldsSchema: settlementFields, requiredFields: ['grantId', 'date', 'units'],
    apply: (target, fields) => recordSettlement(target.id, fields),
  }),
  childCommand({
    name: 'employment.record_distribution', title: 'Record Employment distribution',
    description: 'Record cash returned by an Employment Equity position.',
    fieldsSchema: { date, amount: number, description: nullableText, externalHash: nullableText },
    requiredFields: ['date', 'amount'],
    apply: (target, fields) => recordEmploymentEquityDistribution(target.id, fields),
  }),
  childCommand({
    name: 'employment.record_disposition', title: 'Record Employment disposition',
    description: 'Record a sale, tender, or repurchase and exact lot allocation.',
    fieldsSchema: {
      eventType: { type: 'string', enum: ['sale', 'tender', 'repurchase'] }, date,
      amount: number, pricePerUnit: nullableNumber, description: nullableText, externalHash: nullableText,
      allocations: { type: 'array', minItems: 1, items: schema({ lotId: uuid, units: number, grossProceedsAllocated: number, taxBasisAllocated: nullableNumber }, ['lotId', 'units', 'grossProceedsAllocated']) },
    },
    requiredFields: ['eventType', 'date', 'amount', 'allocations'],
    apply: (target, fields) => recordEmploymentEquityDisposition(target.id, fields),
  }),
  childCommand({
    name: 'employment.adjust_basis', title: 'Adjust Employment basis',
    description: 'Record an audited tax-basis adjustment for one exact lot.',
    risk: 'sensitive_basis', interactionPolicy: 'confirm_inline',
    fieldsSchema: {
      lotId: uuid, date, basisSource, reason: text, externalHash: nullableText,
      cashOutlay: nullableNumber, taxBasis: nullableNumber, compensationBasis: nullableNumber,
    },
    requiredFields: ['lotId', 'date', 'basisSource', 'reason'],
    apply: (target, fields) => recordBasisAdjustment(target.id, fields),
  }),
  base({
    name: 'employment.add_disclosure', title: 'Add Employment issuer disclosure',
    description: 'Link disclosure metadata and an optional source document to an Employment issuer.',
    risk: 'additive_reporting_fact', applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: ['disclosureType', 'receivedDate', 'financialsAsOfDate', 'notes'],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 }, portfolioEntityId: uuid,
      documentId: { type: 'integer', minimum: 1 },
      disclosureType, receivedDate: date, financialsAsOfDate: nullableDate, notes: nullableText,
    }, ['investmentId', 'portfolioEntityId', 'documentId', 'disclosureType', 'receivedDate']),
    resolve: input => positionTarget(input.investmentId), inspect: inspectPosition,
    preview: ({ target, input }) => ({ summary: `Add ${input.disclosureType} disclosure for ${target.label}.`, target, before: [], after: [{ field: 'received_date', value: input.receivedDate }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => {
      if (target.portfolioEntityId !== input.portfolioEntityId) throw new CommandError('TARGET_CHANGED', 'The issuer no longer matches this position.');
      return addIssuerDisclosure(input.portfolioEntityId, input);
    },
    affectedResources: ({ target }) => [target, { type: 'employment_issuer', id: target.portfolioEntityId, label: target.label }],
  }),
];
