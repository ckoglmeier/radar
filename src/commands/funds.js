import { query, writeCapabilities } from '../db/index.js';
import {
  archiveFund,
  cancelFundNotice,
  createFund,
  restoreFund,
  updateFund,
  voidAndReplaceFundTransaction,
} from '../models/funds.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableMoney = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] };
const nullableYear = { anyOf: [{ type: 'integer', minimum: 1900, maximum: 2100 }, { type: 'null' }] };

function schema(properties, required) {
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

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function fundTarget(investmentId) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.asset_class, fp.*
      FROM investments i JOIN fund_profiles fp ON fp.investment_id = i.id
     WHERE i.id = $1
  `, [investmentId]);
  if (!row || row.asset_class !== 'fund') throw new CommandError('TARGET_NOT_FOUND', `Fund not found: ${investmentId}`);
  return { type: 'fund_position', id: Number(row.id), label: row.company_name };
}

async function inspectFund(target) {
  const [row] = await query(`
    SELECT i.id, i.company_name, i.status, i.invest_date, i.investment_entity,
           fp.manager, fp.strategy, fp.vintage_year, fp.commitment,
           fp.fund_status, fp.description, fp.archived_at, fp.updated_at
      FROM investments i JOIN fund_profiles fp ON fp.investment_id = i.id
     WHERE i.id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Fund not found: ${target.id}`);
  return { ...row, id: Number(row.id), invest_date: dateOnly(row.invest_date) };
}

const createProperties = {
  legalName: { type: 'string', minLength: 1 },
  commitmentDate: { type: 'string', format: 'date' },
  ownershipEntity: nullableText,
  manager: nullableText,
  strategy: nullableText,
  vintageYear: nullableYear,
  commitment: nullableMoney,
  initialContribution: nullableMoney,
  initialContributionDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
  initialNav: nullableMoney,
  initialNavDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
  description: nullableText,
};

export const fundLifecycleCommandDefinitions = [
  base({
    name: 'fund.create', title: 'Create Fund',
    description: 'Create a Fund vehicle and position with optional opening contribution and NAV.',
    risk: 'metadata_change', editableInputKeys: Object.keys(createProperties),
    inputSchema: schema(createProperties, ['legalName', 'commitmentDate']),
    resolve: input => ({ type: 'fund_name', id: `${input.legalName.trim().toLowerCase()}|${input.commitmentDate}`, label: input.legalName.trim() }),
    inspect: async (_target, input) => ({ existing: (await query(`SELECT id FROM investments WHERE asset_class = 'fund' AND LOWER(BTRIM(company_name)) = $1 AND invest_date = $2::date`, [input.legalName.trim().toLowerCase(), input.commitmentDate]))[0] || null }),
    preview: ({ target, input, current }) => {
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `${target.label} already exists for ${input.commitmentDate}.`);
      return { summary: `Create Fund ${target.label}.`, target, before: [], after: [{ field: 'commitment', value: input.commitment }, { field: 'initial_nav', value: input.initialNav }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: ({ input }) => createFund(input),
    inspectAfter: ({ result }) => inspectFund({ id: result.investment.id }),
    affectedResources: ({ result }) => [{ type: 'fund_position', id: Number(result.investment.id), label: result.investment.company_name }],
  }),
  base({
    name: 'fund.update', title: 'Update Fund',
    description: 'Update Fund manager, strategy, vintage, status, and description.',
    risk: 'metadata_change', undoPolicy: 'inverse',
    editableInputKeys: ['manager', 'strategy', 'vintageYear', 'fundStatus', 'description'],
    inputSchema: schema({
      investmentId: { type: 'integer', minimum: 1 }, manager: nullableText,
      strategy: nullableText, vintageYear: nullableYear,
      fundStatus: { anyOf: [{ type: 'string', enum: ['active', 'harvesting', 'realized', 'written_off'] }, { type: 'null' }] },
      description: nullableText,
    }, ['investmentId']),
    resolve: input => fundTarget(input.investmentId), inspect: inspectFund,
    preview: ({ target, input, current }) => ({ summary: `Update ${target.label}.`, target, before: [current], after: [input], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => updateFund(target.id, input),
    affectedResources: ({ target }) => [target],
    undo: ({ target, before }) => updateFund(target.id, {
      manager: before.manager, strategy: before.strategy, vintageYear: before.vintage_year,
      fundStatus: before.fund_status, description: before.description,
    }),
  }),
  base({
    name: 'fund.set_active', title: 'Set Fund activity',
    description: 'Show or hide a Fund from the active Fund workspace without deleting history.',
    risk: 'lifecycle', undoPolicy: 'inverse',
    editableInputKeys: ['active'],
    inputSchema: schema({ investmentId: { type: 'integer', minimum: 1 }, active: { type: 'boolean' } }, ['investmentId', 'active']),
    resolve: input => fundTarget(input.investmentId), inspect: inspectFund,
    preview: ({ target, input, current }) => ({ summary: `${input.active ? 'Restore' : 'Archive'} ${target.label}.`, target, before: [{ field: 'active', value: current.archived_at == null }], after: [{ field: 'active', value: input.active }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => ({ archived_at: current.archived_at, updated_at: current.updated_at }),
    apply: ({ target, input }) => input.active ? restoreFund(target.id) : archiveFund(target.id),
    affectedResources: ({ target }) => [target],
    undo: ({ target, before }) => before.archived_at == null ? restoreFund(target.id) : archiveFund(target.id),
  }),
  base({
    name: 'fund.cancel_capital_call', title: 'Cancel Fund capital call',
    description: 'Cancel an exact open Fund capital-call notice.',
    risk: 'destructive', interactionPolicy: 'confirm_inline',
    editableInputKeys: ['reason'],
    inputSchema: schema({ noticeId: { type: 'string', format: 'uuid' }, reason: nullableText }, ['noticeId']),
    resolve: async input => {
      const [row] = await query(`SELECT fn.*, i.company_name FROM fund_notices fn JOIN investments i ON i.id = fn.investment_id WHERE fn.id = $1`, [input.noticeId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Fund notice not found: ${input.noticeId}`);
      return { type: 'fund_notice', id: row.id, label: `${row.company_name} capital call` };
    },
    inspect: async target => (await query('SELECT * FROM fund_notices WHERE id = $1', [target.id]))[0],
    preview: ({ target, current }) => ({ summary: `Cancel ${target.label}.`, target, before: [{ field: 'status', value: current.status }], after: [{ field: 'status', value: 'cancelled' }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => cancelFundNotice(target.id, input.reason),
    affectedResources: ({ target }) => [target],
  }),
  base({
    name: 'fund.replace_transaction', title: 'Replace Fund transaction',
    description: 'Void an exact Fund transaction and record its audited replacement.',
    risk: 'corrective', interactionPolicy: 'confirm_inline',
    applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: ['reason', 'date', 'amount', 'description'],
    inputSchema: schema({
      transactionId: { type: 'string', format: 'uuid' }, reason: { type: 'string', minLength: 1 },
      date: { type: 'string', format: 'date' }, amount: { type: 'number', exclusiveMinimum: 0 },
      description: nullableText, externalHash: nullableText,
    }, ['transactionId', 'reason', 'date', 'amount']),
    resolve: async input => {
      const [row] = await query(`SELECT ft.id, ft.investment_id, i.company_name FROM fund_transactions ft JOIN investments i ON i.id = ft.investment_id WHERE ft.id = $1`, [input.transactionId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Fund transaction not found: ${input.transactionId}`);
      return { type: 'fund_transaction', id: row.id, label: row.company_name, investmentId: Number(row.investment_id) };
    },
    inspect: async target => (await query(`SELECT ft.*, cf.flow_date, cf.amount, cf.description FROM fund_transactions ft JOIN cash_flows cf ON cf.id = ft.cash_flow_id WHERE ft.id = $1`, [target.id]))[0],
    preview: ({ target, input, current }) => ({ summary: `Correct ${target.label} Fund transaction.`, target, before: [{ field: 'date', value: dateOnly(current.flow_date) }, { field: 'amount', value: Number(current.amount) }], after: [{ field: 'date', value: input.date }, { field: 'amount', value: input.amount }], derivedEffects: [], warnings: ['The original transaction remains as a voided audit record.'], requiredReason: true }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => voidAndReplaceFundTransaction(target.id, input),
    inspectAfter: async ({ target, result }) => ({
      original: (await query('SELECT * FROM fund_transactions WHERE id = $1', [target.id]))[0],
      replacement: (await query('SELECT * FROM fund_transactions WHERE id = $1', [result.replacement.transaction.id]))[0],
    }),
    affectedResources: ({ target, result }) => [target, { type: 'fund_transaction', id: result.replacement.transaction.id, label: target.label }],
  }),
];
