import { query, writeCapabilities } from '../db/index.js';
import {
  createCapitalCallNotice,
  recordFundDistribution,
  recordFundFee,
  recordFundValuation,
  settleCapitalCall,
  updateFund,
  updateFundCommitment,
} from '../models/funds.js';
import {
  calculateEmploymentEquityValue,
  recordEmploymentEquityIssuerMark,
  recordEmploymentEquityValuation,
  updateEmploymentEquityPosition,
} from '../models/employment-equity.js';
import { recordDirectValuation, setConviction } from '../models/investments.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const usd = { type: 'string', const: 'USD' };
const date = { type: 'string', format: 'date' };
const money = { type: 'number', minimum: 0 };
const positiveMoney = { type: 'number', exclusiveMinimum: 0 };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capability = await writeCapabilities();
  return capability.proposalApply === 'transactional' && capability.serializedWrites;
}

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

function num(value) {
  return value == null ? null : Number(value);
}

async function investmentTarget(investmentId, assetClass) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.asset_class, i.portfolio_entity_id,
           i.status, i.status_override, i.updated_at,
           fp.archived_at AS fund_archived_at,
           eep.archived_at AS employment_archived_at,
           pe.entity_type
      FROM investments i
      LEFT JOIN fund_profiles fp ON fp.investment_id = i.id
      LEFT JOIN employment_equity_positions eep ON eep.investment_id = i.id
      LEFT JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE i.id = $1
  `, [investmentId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Investment not found: ${investmentId}`);
  if (row.asset_class !== assetClass || row.asset_class === 'merged') {
    throw new CommandError('WRONG_TARGET_TYPE', `Command requires a ${assetClass} position.`);
  }
  if (assetClass === 'fund' && row.entity_type !== 'fund_vehicle') {
    throw new CommandError('WRONG_TARGET_TYPE', 'Fund position is not linked to a fund vehicle.');
  }
  if (assetClass === 'employment_equity' && row.entity_type !== 'operating_company') {
    throw new CommandError('WRONG_TARGET_TYPE', 'Employment position is not linked to an operating company.');
  }
  return { type: `${assetClass}_position`, id: Number(row.id), label: row.company_name };
}

async function inspectInvestment(target, input = {}) {
  const [row] = await query(`
    SELECT i.*, fp.commitment, fp.manager AS fund_manager,
           fp.strategy AS fund_strategy, fp.vintage_year,
           fp.fund_status, fp.description AS fund_description,
           fp.archived_at AS fund_archived_at,
           eep.display_name, eep.position_status, eep.description,
           eep.archived_at AS employment_archived_at,
           (SELECT id FROM valuations WHERE investment_id = i.id ORDER BY snapshot_date DESC, id DESC LIMIT 1) AS latest_valuation_id,
           (SELECT snapshot_date FROM valuations WHERE investment_id = i.id ORDER BY snapshot_date DESC, id DESC LIMIT 1) AS latest_valuation_date,
           (SELECT net_value FROM valuations WHERE investment_id = i.id ORDER BY snapshot_date DESC, id DESC LIMIT 1) AS latest_valuation_value
           ,(SELECT id FROM valuations WHERE investment_id = i.id AND snapshot_date = $2::date LIMIT 1) AS same_date_valuation_id
           ,(SELECT unrealized_value FROM valuations WHERE investment_id = i.id AND snapshot_date = $2::date LIMIT 1) AS same_date_unrealized_value
           ,(SELECT net_value FROM valuations WHERE investment_id = i.id AND snapshot_date = $2::date LIMIT 1) AS same_date_net_value
           ,(SELECT COALESCE(SUM(amount), 0) FROM cash_flows WHERE investment_id = i.id AND type = 'distribution' AND reconciliation_status = 'matched') AS matched_distributions
           ,(SELECT COUNT(*) FROM cash_flows WHERE investment_id = i.id AND type = 'distribution' AND reconciliation_status = 'matched') AS matched_distribution_count
      FROM investments i
      LEFT JOIN fund_profiles fp ON fp.investment_id = i.id
      LEFT JOIN employment_equity_positions eep ON eep.investment_id = i.id
     WHERE i.id = $1
  `, [target.id, input.date || input.noticeDate || null]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Investment not found: ${target.id}`);
  return row;
}

function investmentBaseline(current) {
  return {
    id: Number(current.id),
    asset_class: current.asset_class,
    portfolio_entity_id: current.portfolio_entity_id,
    status: current.status,
    status_override: current.status_override,
    fund_archived_at: current.fund_archived_at,
    employment_archived_at: current.employment_archived_at,
    updated_at: current.updated_at,
  };
}

function basicPreview(target, current, before, after, warnings = []) {
  return {
    summary: `${target.label}: review proposed change`,
    target,
    before,
    after,
    derivedEffects: [],
    warnings,
    requiredReason: false,
  };
}

function definition(base) {
  const applyCapability = base.risk === 'explicit_override'
    ? 'portfolio:apply:override'
    : base.risk === 'metadata_change'
      ? 'portfolio:apply:metadata'
      : 'portfolio:apply:additive';
  return {
    tier: 'A',
    version: 1,
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: [applyCapability],
    resultSchema: objectResult,
    availability: available,
    affectedResources: ({ target, result }) => result?.affected_resources || [target],
    ...base,
  };
}

const FUND_STATUSES = new Set(['active', 'harvesting', 'realized', 'written_off']);

function overrideText(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new CommandError('COMMAND_OVERRIDE_VALUE_INVALID', `${label} must be non-empty text.`);
  return normalized;
}

function overrideVintage(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2100) {
    throw new CommandError('COMMAND_OVERRIDE_VALUE_INVALID', 'Fund vintage year must be between 1900 and 2100.');
  }
  return year;
}

function overrideFundStatus(value) {
  const status = String(value || '').trim();
  if (!FUND_STATUSES.has(status)) {
    throw new CommandError('COMMAND_OVERRIDE_VALUE_INVALID', `Unsupported Fund status: ${status || 'blank'}.`);
  }
  return status;
}

const OVERRIDE_FIELDS = {
  fund_profile: {
    manager: {
      assetClass: 'fund', currentKey: 'fund_manager', normalize: value => overrideText(value, 'Fund manager'),
      apply: (id, value) => updateFund(id, { manager: value }),
    },
    strategy: {
      assetClass: 'fund', currentKey: 'fund_strategy', normalize: value => overrideText(value, 'Fund strategy'),
      apply: (id, value) => updateFund(id, { strategy: value }),
    },
    vintage_year: {
      assetClass: 'fund', currentKey: 'vintage_year', normalize: overrideVintage,
      apply: (id, value) => updateFund(id, { vintageYear: value }),
    },
    fund_status: {
      assetClass: 'fund', currentKey: 'fund_status', normalize: overrideFundStatus,
      apply: (id, value) => updateFund(id, { fundStatus: value }),
    },
    description: {
      assetClass: 'fund', currentKey: 'fund_description', normalize: value => overrideText(value, 'Fund description'),
      apply: (id, value) => updateFund(id, { description: value }),
    },
  },
  employment_position: {
    display_name: {
      assetClass: 'employment_equity', currentKey: 'display_name', normalize: value => overrideText(value, 'Position display name'),
      apply: (id, value) => updateEmploymentEquityPosition(id, { displayName: value }),
    },
    description: {
      assetClass: 'employment_equity', currentKey: 'description', normalize: value => overrideText(value, 'Position description'),
      apply: (id, value) => updateEmploymentEquityPosition(id, { description: value }),
    },
  },
};

function overrideField(input) {
  const field = OVERRIDE_FIELDS[input.resourceType]?.[input.field];
  if (!field) {
    throw new CommandError(
      'COMMAND_OVERRIDE_NOT_ALLOWLISTED',
      `No safe generic override exists for ${input.resourceType}.${input.field}.`,
    );
  }
  return field;
}

function investmentCommand({ name, title, description, risk, assetClass, inputSchema, inspect, preview, preconditions, apply }) {
  return definition({
    name, title, description, risk, inputSchema,
    resolve: input => investmentTarget(input.investmentId, assetClass),
    inspect: inspect || ((target, input) => inspectInvestment(target, input)),
    preview,
    preconditions: args => ({ ...investmentBaseline(args.current), ...(preconditions?.(args) || {}) }),
    apply,
  });
}

export const tierACommandDefinitions = [
  investmentCommand({
    name: 'direct.record_valuation', title: 'Record Direct valuation',
    description: 'Record the dated unrealized value of a Direct position.',
    risk: 'additive_reporting_fact', assetClass: 'direct',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, date, unrealizedValue: money, currency: usd, correctionReason: { type: 'string', minLength: 1 } }, ['investmentId', 'date', 'unrealizedValue', 'currency']),
    preview: ({ target, input, current }) => {
      if (current.same_date_valuation_id && num(current.same_date_unrealized_value) !== input.unrealizedValue && !input.correctionReason) {
        throw new CommandError('CORRECTION_REASON_REQUIRED', 'A different Direct mark exists on this date; provide a correction reason.');
      }
      return basicPreview(target, current,
        [{ field: 'current_unrealized_value', value: num(current.unrealized_value), as_of: dateOnly(current.latest_valuation_date) }],
        [{ field: 'unrealized_value', value: input.unrealizedValue, as_of: input.date }]);
    },
    preconditions: ({ current, input }) => ({
      latest_valuation_id: current.latest_valuation_id,
      latest_valuation_date: dateOnly(current.latest_valuation_date),
      same_date_valuation_id: current.same_date_valuation_id,
      same_date_unrealized_value: num(current.same_date_unrealized_value),
      matched_distributions: num(current.matched_distributions),
      matched_distribution_count: Number(current.matched_distribution_count),
      computed_net_invested: num(current.computed_net_invested),
      realized_value: num(current.realized_value),
      requested_date: input.date,
    }),
    apply: ({ target, input, provenance }) => recordDirectValuation(target.id, {
      ...input, proposalId: provenance.proposal_id,
    }),
  }),
  investmentCommand({
    name: 'direct.set_conviction', title: 'Set Direct conviction',
    description: 'Update current and entry conviction for a Direct position.',
    risk: 'metadata_change', assetClass: 'direct',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, now: { anyOf: [{ type: 'number', minimum: 0, maximum: 5 }, { type: 'null' }] }, entry: { anyOf: [{ type: 'number', minimum: 0, maximum: 5 }, { type: 'null' }] } }, ['investmentId']),
    preview: ({ target, input, current }) => basicPreview(target, current,
      [{ field: 'conviction_now', value: current.conviction_now }, { field: 'conviction_entry', value: current.conviction_entry }],
      [{ field: 'conviction_now', value: input.now }, { field: 'conviction_entry', value: input.entry }]),
    preconditions: ({ current }) => ({ conviction_now: current.conviction_now, conviction_entry: current.conviction_entry }),
    apply: ({ target, input }) => setConviction(target.id, input),
  }),
  investmentCommand({
    name: 'fund.record_nav', title: 'Record Fund NAV', description: 'Record or correct a dated Fund NAV.',
    risk: 'additive_reporting_fact', assetClass: 'fund',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, date, nav: money, currency: usd, correctionReason: { type: 'string', minLength: 1 } }, ['investmentId', 'date', 'nav', 'currency']),
    preview: ({ target, input, current }) => {
      if (current.same_date_valuation_id && num(current.same_date_net_value) !== input.nav && !input.correctionReason) {
        throw new CommandError('CORRECTION_REASON_REQUIRED', 'A different Fund NAV exists on this date; provide a correction reason.');
      }
      return basicPreview(target, current,
        [{ field: 'latest_nav', value: num(current.latest_valuation_value), as_of: dateOnly(current.latest_valuation_date) }],
        [{ field: 'nav', value: input.nav, as_of: input.date }]);
    },
    preconditions: ({ current }) => ({ latest_valuation_id: current.latest_valuation_id, latest_valuation_date: dateOnly(current.latest_valuation_date), same_date_valuation_id: current.same_date_valuation_id, same_date_net_value: num(current.same_date_net_value) }),
    apply: ({ target, input }) => recordFundValuation(target.id, input),
  }),
  investmentCommand({
    name: 'fund.update_commitment', title: 'Update Fund commitment', description: 'Update the reporting commitment for a Fund.',
    risk: 'metadata_change', assetClass: 'fund',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, commitment: money, note: nullableText }, ['investmentId', 'commitment']),
    preview: ({ target, input, current }) => basicPreview(target, current,
      [{ field: 'commitment', value: num(current.commitment) }], [{ field: 'commitment', value: input.commitment }]),
    preconditions: ({ current }) => ({ commitment: num(current.commitment) }),
    apply: ({ target, input }) => updateFundCommitment(target.id, input.commitment, input.note),
  }),
  investmentCommand({
    name: 'fund.set_vintage_year', title: 'Set Fund vintage year',
    description: 'Set the reporting vintage year for a Fund vehicle.',
    risk: 'metadata_change', assetClass: 'fund',
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 },
      vintageYear: { type: 'integer', minimum: 1900, maximum: 2100 },
    }, ['investmentId', 'vintageYear']),
    preview: ({ target, input, current }) => basicPreview(target, current,
      [{ field: 'vintage_year', value: current.vintage_year == null ? null : Number(current.vintage_year) }],
      [{ field: 'vintage_year', value: input.vintageYear }]),
    preconditions: ({ current }) => ({
      vintage_year: current.vintage_year == null ? null : Number(current.vintage_year),
    }),
    apply: ({ target, input }) => updateFund(target.id, { vintageYear: input.vintageYear }),
  }),
  definition({
    name: 'reporting.override_field', version: 1, tier: 'override',
    title: 'Request a one-time reporting-field override',
    description: 'Change one allowlisted reporting metadata field when no dedicated command exists. Every override requires separate user permission.',
    risk: 'explicit_override',
    inputSchema: schema({
      resourceType: { type: 'string', enum: ['fund_profile', 'employment_position'] },
      resourceId: { type: 'integer', minimum: 1 },
      field: { type: 'string', enum: ['manager', 'strategy', 'vintage_year', 'fund_status', 'description', 'display_name'] },
      value: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      reason: { type: 'string', minLength: 1 },
    }, ['resourceType', 'resourceId', 'field', 'value', 'reason']),
    resolve: async input => {
      const field = overrideField(input);
      field.normalize(input.value);
      return investmentTarget(input.resourceId, field.assetClass);
    },
    inspect: (target, input) => inspectInvestment(target, input),
    preview: ({ target, input, current }) => {
      const field = overrideField(input);
      const nextValue = field.normalize(input.value);
      return {
        ...basicPreview(
          target,
          current,
          [{ field: input.field, value: current[field.currentKey] ?? null }],
          [{ field: input.field, value: nextValue }],
          ['No dedicated command owns this field. This one-time override requires separate approval.'],
        ),
        requiredReason: true,
      };
    },
    preconditions: ({ input, current }) => {
      const field = overrideField(input);
      return {
        resource_type: input.resourceType,
        field: input.field,
        current_value: current[field.currentKey] ?? null,
        updated_at: current.updated_at,
      };
    },
    apply: ({ target, input }) => {
      const field = overrideField(input);
      return field.apply(target.id, field.normalize(input.value));
    },
  }),
  investmentCommand({
    name: 'fund.create_capital_call', title: 'Create capital call', description: 'Record a Fund capital-call notice.',
    risk: 'additive_reporting_fact', assetClass: 'fund',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, noticeDate: date, dueDate: date, amount: positiveMoney, currency: usd, description: nullableText }, ['investmentId', 'noticeDate', 'amount', 'currency']),
    preview: ({ target, input, current }) => basicPreview(target, current, [], [{ field: 'capital_call', value: input.amount, as_of: input.noticeDate }]),
    preconditions: () => ({}),
    apply: ({ target, input, idempotencyKey }) => createCapitalCallNotice(target.id, { ...input, externalHash: idempotencyKey }),
  }),
  definition({
    name: 'fund.settle_capital_call', version: 1, title: 'Settle capital call', description: 'Settle an open capital-call notice.',
    risk: 'additive_reporting_fact',
    inputSchema: schema({ noticeId: { type: 'string', format: 'uuid' }, settlementDate: date, amount: positiveMoney, currency: usd, description: nullableText }, ['noticeId', 'settlementDate', 'currency']),
    resolve: async input => {
      const [notice] = await query(`SELECT * FROM fund_notices WHERE id = $1`, [input.noticeId]);
      if (!notice) throw new CommandError('TARGET_NOT_FOUND', `Fund notice not found: ${input.noticeId}`);
      await investmentTarget(notice.investment_id, 'fund');
      return { type: 'fund_notice', id: notice.id, investment_id: Number(notice.investment_id), label: 'Capital call' };
    },
    inspect: async target => (await query(`SELECT * FROM fund_notices WHERE id = $1`, [target.id]))[0],
    preview: ({ target, input, current }) => basicPreview(target, current, [{ field: 'status', value: current.status }], [{ field: 'settled_amount', value: input.amount ?? num(current.amount), as_of: input.settlementDate }]),
    preconditions: ({ target, current }) => ({ id: target.id, investment_id: target.investment_id, status: current.status, amount: num(current.amount), updated_at: current.updated_at }),
    apply: ({ target, input, idempotencyKey }) => settleCapitalCall(target.id, { ...input, externalHash: idempotencyKey }),
  }),
  ...['distribution', 'fee'].map(activity => investmentCommand({
    name: `fund.record_${activity}`, title: `Record Fund ${activity}`, description: `Record a settled Fund ${activity}.`,
    risk: 'additive_reporting_fact', assetClass: 'fund',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, date, amount: positiveMoney, currency: usd, description: nullableText }, ['investmentId', 'date', 'amount', 'currency']),
    preview: ({ target, input, current }) => basicPreview(target, current, [], [{ field: activity, value: input.amount, as_of: input.date }]),
    preconditions: () => ({}),
    apply: ({ target, input, idempotencyKey }) => (activity === 'distribution' ? recordFundDistribution : recordFundFee)(target.id, { ...input, externalHash: idempotencyKey }),
  })),
  definition({
    name: 'employment.record_issuer_mark', version: 1, title: 'Record issuer share mark', description: 'Record one dated issuer-level common economic or 409A price.',
    risk: 'additive_reporting_fact',
    inputSchema: schema({ portfolioEntityId: { type: 'string', format: 'uuid' }, markType: { type: 'string', enum: ['common_share_economic', 'tax_409a'] }, date, valuePerUnit: money, currency: usd, confidence: { type: 'string', enum: ['company_reported', 'calculated', 'estimated'] }, notes: nullableText, sourceFactKey: { type: 'string', minLength: 1 }, sourceDocumentId: { type: 'integer', minimum: 1 } }, ['portfolioEntityId', 'markType', 'date', 'valuePerUnit', 'currency']),
    resolve: async input => {
      const [entity] = await query(`SELECT * FROM portfolio_entities WHERE id = $1`, [input.portfolioEntityId]);
      if (!entity) throw new CommandError('TARGET_NOT_FOUND', `Portfolio entity not found: ${input.portfolioEntityId}`);
      if (entity.entity_type !== 'operating_company') throw new CommandError('WRONG_TARGET_TYPE', 'Issuer mark requires an operating company.');
      return { type: 'employment_issuer', id: entity.id, label: entity.legal_name };
    },
    inspect: async (target, input) => {
      const positions = await query(`
        SELECT i.id, i.asset_class, i.portfolio_entity_id, i.updated_at,
               eep.display_name, eep.instrument_family, eep.position_status, eep.archived_at,
               (SELECT id FROM valuations WHERE investment_id = i.id ORDER BY snapshot_date DESC, id DESC LIMIT 1) AS latest_valuation_id
          FROM investments i JOIN employment_equity_positions eep ON eep.investment_id = i.id
         WHERE i.portfolio_entity_id = $1 AND i.asset_class = 'employment_equity'
         ORDER BY i.id
      `, [target.id]);
      const effects = [];
      if (input.markType === 'common_share_economic') {
        for (const row of positions.filter(item => !item.archived_at && !['realized', 'forfeited', 'archived'].includes(item.position_status))) {
          if (['ppu', 'profits_interest', 'other'].includes(row.instrument_family)) {
            effects.push({ investment_id: Number(row.id), disposition: 'manual_required' });
          } else {
            effects.push({ investment_id: Number(row.id), disposition: 'derive', calculation: await calculateEmploymentEquityValue(row.id, input.valuePerUnit) });
          }
        }
      }
      const [sameDate] = await query(`SELECT * FROM employment_equity_issuer_marks WHERE portfolio_entity_id = $1 AND mark_type = $2 AND mark_date = $3`, [target.id, input.markType, input.date]);
      return { positions, effects, sameDate };
    },
    preview: ({ target, input, current }) => ({
      ...basicPreview(target, current, current.sameDate ? [{ field: input.markType, value: num(current.sameDate.value_per_unit), as_of: input.date }] : [], [{ field: input.markType, value: input.valuePerUnit, as_of: input.date }], current.effects.filter(row => row.disposition === 'manual_required').map(row => `Position ${row.investment_id} requires a manual valuation.`)),
      derivedEffects: current.effects,
    }),
    preconditions: ({ current }) => ({
      same_date_mark_id: current.sameDate?.id || null,
      positions: current.positions.map(row => ({ id: Number(row.id), asset_class: row.asset_class, portfolio_entity_id: row.portfolio_entity_id, position_status: row.position_status, archived_at: row.archived_at, latest_valuation_id: row.latest_valuation_id })),
    }),
    apply: ({ target, input }) => recordEmploymentEquityIssuerMark(target.id, input),
    affectedResources: ({ target, result }) => [target, ...(result?.valuations || []).map(row => ({ type: 'employment_equity_position', id: Number(row.investment_id) }))],
  }),
  investmentCommand({
    name: 'employment.record_valuation', title: 'Record Employment valuation', description: 'Record a manually confirmed Employment position value.',
    risk: 'additive_reporting_fact', assetClass: 'employment_equity',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, date, vestedValue: money, unvestedValue: money, currency: usd, methodology: { type: 'string', enum: ['company_statement', 'common_fmv', 'tender', 'waterfall', 'manual', 'other'] }, confidence: { type: 'string', enum: ['company_reported', 'calculated', 'estimated'] }, notes: nullableText, sourceDocumentId: { type: 'integer', minimum: 1 } }, ['investmentId', 'date', 'vestedValue', 'currency']),
    preview: ({ target, input, current }) => {
      if (current.same_date_valuation_id && num(current.same_date_net_value) !== input.vestedValue) {
        throw new CommandError('EMPLOYMENT_VALUATION_DATE_CONFLICT', 'A different Employment valuation exists on this date.');
      }
      return basicPreview(target, current, [{ field: 'latest_value', value: num(current.latest_valuation_value), as_of: dateOnly(current.latest_valuation_date) }], [{ field: 'vested_value', value: input.vestedValue, as_of: input.date }]);
    },
    preconditions: ({ current }) => ({ latest_valuation_id: current.latest_valuation_id, latest_valuation_date: dateOnly(current.latest_valuation_date), same_date_valuation_id: current.same_date_valuation_id, same_date_net_value: num(current.same_date_net_value) }),
    apply: ({ target, input }) => recordEmploymentEquityValuation(target.id, input),
  }),
  investmentCommand({
    name: 'employment.update_position', title: 'Update Employment position', description: 'Update narrow reporting metadata for an Employment position.',
    risk: 'metadata_change', assetClass: 'employment_equity',
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, displayName: { type: 'string', minLength: 1 }, positionStatus: { type: 'string', enum: ['active', 'partially_realized', 'realized', 'forfeited', 'archived'] }, description: nullableText }, ['investmentId']),
    preview: ({ target, input, current }) => basicPreview(target, current, [{ field: 'display_name', value: current.display_name }, { field: 'position_status', value: current.position_status }, { field: 'description', value: current.description }], [{ field: 'display_name', value: input.displayName ?? current.display_name }, { field: 'position_status', value: input.positionStatus ?? current.position_status }, { field: 'description', value: input.description === undefined ? current.description : input.description }]),
    preconditions: ({ current }) => ({ display_name: current.display_name, position_status: current.position_status, description: current.description }),
    apply: ({ target, input }) => updateEmploymentEquityPosition(target.id, input),
  }),
];
