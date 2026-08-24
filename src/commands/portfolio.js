import { query, writeCapabilities } from '../db/index.js';
import { importTransactionRows } from '../import/transactions.js';
import { addPositionManual, setConviction } from '../models/investments.js';
import {
  assignPrimaryThesis,
  getThesisById,
} from '../models/theses.js';
import {
  consolidatePositions,
  keepPositionsSeparate,
  markCashFlowsMatched,
} from '../models/reconciliation.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const nullableText = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableMoney = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] };
const nullableConviction = { anyOf: [{ type: 'integer', minimum: 0, maximum: 5 }, { type: 'null' }] };

function schema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function base(definition) {
  return {
    version: 1,
    tier: 'A',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available,
    resultSchema: objectResult,
    plannerExposure: true,
    interactionPolicy: 'execute_inline',
    undoPolicy: 'unavailable',
    ...definition,
  };
}

function dateOnly(value) {
  return value == null ? null : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
}

async function directRows(ids) {
  const unique = [...new Set(ids.map(Number))].sort((a, b) => a - b);
  const rows = await query(`
    SELECT id, company_name, asset_class, status, invest_date, invested,
           unrealized_value, realized_value, net_value, updated_at
      FROM investments
     WHERE id = ANY($1::int[])
     ORDER BY id
  `, [unique]);
  if (rows.length !== unique.length || rows.some(row => row.asset_class !== 'direct')) {
    throw new CommandError('TARGET_NOT_FOUND', 'Every target must be an active Direct position.');
  }
  return rows.map(row => ({ ...row, id: Number(row.id), invest_date: dateOnly(row.invest_date) }));
}

async function createTarget(input) {
  const thesis = await getThesisById(input.thesisId);
  if (!thesis) throw new CommandError('TARGET_NOT_FOUND', `Thesis not found: ${input.thesisId}`);
  return { type: 'direct_position_name', id: `${input.companyName.trim().toLowerCase()}|${input.investDate}`, label: input.companyName.trim(), thesisId: Number(thesis.id) };
}

async function inspectCreate(target, input) {
  const [existing] = await query(`
    SELECT id, company_name, asset_class, invest_date, updated_at
      FROM investments
     WHERE LOWER(BTRIM(company_name)) = $1 AND invest_date = $2::date
     LIMIT 1
  `, [input.companyName.trim().toLowerCase(), input.investDate]);
  return { existing: existing || null, thesis: await getThesisById(target.thesisId) };
}

async function applyCreate(input) {
  const invested = input.invested ?? 0;
  const realized = input.realizedValue ?? 0;
  const net = input.netValue ?? invested;
  const position = await addPositionManual({
    company_name: input.companyName.trim(),
    status: input.status || 'Live',
    invest_date: input.investDate,
    invested,
    unrealized_value: Math.max(net - realized, 0),
    realized_value: realized,
    net_value: net,
    multiple: invested > 0 ? net / invested : null,
    investment_entity: null,
    lead: input.lead || null,
    investment_type: null,
    round: input.round || null,
    stage_bucket: null,
    market: input.market || null,
    fund_name: null,
    allocation: null,
    instrument: null,
    round_size: null,
    valuation_cap_type: null,
    valuation_cap: null,
    discount: null,
    carry: null,
    share_class: null,
  });
  await assignPrimaryThesis(position.id, input.thesisId);
  if (input.convictionNow != null || input.convictionEntry != null) {
    await setConviction(position.id, { now: input.convictionNow, entry: input.convictionEntry });
  }
  return { position };
}

const createProperties = {
  companyName: { type: 'string', minLength: 1 },
  thesisId: { type: 'integer', minimum: 1 },
  status: { type: 'string', minLength: 1 },
  investDate: { type: 'string', format: 'date' },
  invested: { type: 'number', minimum: 0 },
  netValue: { type: 'number', minimum: 0 },
  realizedValue: { type: 'number', minimum: 0 },
  lead: nullableText,
  round: nullableText,
  market: nullableText,
  convictionNow: nullableConviction,
  convictionEntry: nullableConviction,
};

export const portfolioCommandDefinitions = [
  base({
    name: 'direct.create_position',
    title: 'Create Direct position',
    description: 'Create a manually reported Direct position with one primary thesis.',
    risk: 'metadata_change',
    editableInputKeys: Object.keys(createProperties),
    inputSchema: schema(createProperties, ['companyName', 'thesisId', 'status', 'investDate', 'invested', 'netValue', 'realizedValue']),
    resolve: createTarget,
    inspect: inspectCreate,
    preview: ({ target, input, current }) => {
      if (current.existing) throw new CommandError('TARGET_ALREADY_EXISTS', `${target.label} already has a position on ${input.investDate}.`);
      return { summary: `Create ${target.label}.`, target, before: [], after: [{ field: 'invested', value: input.invested }, { field: 'net_value', value: input.netValue }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => ({ existing: current.existing, thesis_id: Number(current.thesis.id), thesis_active: Boolean(current.thesis.active) }),
    apply: ({ input }) => applyCreate(input),
    inspectAfter: ({ result }) => directRows([result.position.id]).then(rows => rows[0]),
    affectedResources: ({ result }) => [{ type: 'direct_position', id: Number(result.position.id), label: result.position.company_name }],
  }),
  base({
    name: 'transaction.import',
    title: 'Import transactions',
    description: 'Import an exact normalized set of transaction rows idempotently.',
    risk: 'additive_reporting_fact',
    applyCapabilities: ['portfolio:apply:additive'],
    editableInputKeys: [],
    inputSchema: schema({
      rows: {
        type: 'array', minItems: 1, maxItems: 5000,
        items: schema({
          Date: { type: 'string', format: 'date' },
          Transaction: { type: 'string', minLength: 1 },
          Description: { type: 'string' },
          Amount: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          Balance: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
        }, ['Date', 'Transaction', 'Description', 'Amount']),
      },
      source: { type: 'string', minLength: 1 },
    }, ['rows', 'source']),
    resolve: input => ({ type: 'transaction_import', id: input.rows.length, label: `${input.rows.length} transaction rows` }),
    inspect: async (_target, input) => {
      const descriptions = input.rows.map(row => row.Description);
      const existing = await query('SELECT external_hash FROM cash_flows WHERE description = ANY($1::text[]) ORDER BY external_hash', [descriptions]);
      return { existing_hashes: existing.map(row => row.external_hash) };
    },
    preview: ({ target, current }) => ({ summary: `Import ${target.label}.`, target, before: [{ field: 'possible_existing_rows', value: current.existing_hashes.length }], after: [{ field: 'submitted_rows', value: target.id }], derivedEffects: [], warnings: ['Duplicate rows are skipped by stable source hash.'], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => importTransactionRows(input.rows, { source: input.source }),
    affectedResources: () => [{ type: 'transaction_ledger', id: 'cash_flows' }],
  }),
  base({
    name: 'direct.create_from_transactions',
    title: 'Create Direct position from transactions',
    description: 'Create a Direct position from an exact pending cash-flow set and match those flows.',
    risk: 'reconciliation',
    applyCapabilities: ['portfolio:apply:reconciliation'],
    editableInputKeys: ['companyName', 'thesisId'],
    inputSchema: schema({
      cashFlowIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
      companyName: { type: 'string', minLength: 1 },
      thesisId: { type: 'integer', minimum: 1 },
    }, ['cashFlowIds', 'companyName', 'thesisId']),
    resolve: async input => {
      const thesis = await getThesisById(input.thesisId);
      if (!thesis) throw new CommandError('TARGET_NOT_FOUND', `Thesis not found: ${input.thesisId}`);
      return { type: 'cash_flow_set', id: input.cashFlowIds.join(','), label: input.companyName, cashFlowIds: [...input.cashFlowIds].sort((a, b) => a - b), thesisId: Number(thesis.id) };
    },
    inspect: async target => ({
      thesis: await getThesisById(target.thesisId),
      flows: await query(`SELECT id, flow_date, type, amount, investment_id, reconciliation_status FROM cash_flows WHERE id = ANY($1::int[]) ORDER BY flow_date, id`, [target.cashFlowIds]),
    }),
    preview: ({ target, current }) => {
      if (current.flows.length !== target.cashFlowIds.length || current.flows.some(row => row.investment_id != null || row.reconciliation_status !== 'pending')) {
        throw new CommandError('TARGET_NOT_AVAILABLE', 'Every source transaction must still be pending and unmatched.');
      }
      return { summary: `Create ${target.label} from ${current.flows.length} transactions.`, target, before: current.flows.map(row => ({ field: `cash_flow_${row.id}`, value: row.reconciliation_status })), after: [{ field: 'position', value: target.label }], derivedEffects: [], warnings: [], requiredReason: false };
    },
    preconditions: ({ current }) => current,
    apply: async ({ target, input }) => {
      const invested = target.cashFlowIds.length ? target.cashFlowIds : [];
      const flows = await query(`SELECT id, flow_date, type, amount FROM cash_flows WHERE id = ANY($1::int[]) ORDER BY flow_date, id`, [invested]);
      const deployed = flows.filter(row => row.type === 'investment').reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
      if (deployed <= 0) throw new CommandError('INVESTMENT_FLOW_REQUIRED', 'Create a position first, then match returned cash to it.');
      const realized = flows.filter(row => row.type === 'distribution').reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
      const refunds = flows.filter(row => row.type === 'refund').reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0);
      const unrealized = Math.max(deployed - realized - refunds, 0);
      const firstDate = dateOnly(flows.find(row => row.type === 'investment')?.flow_date);
      const created = await applyCreate({
        companyName: input.companyName, thesisId: input.thesisId,
        status: realized + refunds >= deployed ? 'Realized' : 'Live', investDate: firstDate,
        invested: deployed, realizedValue: realized, netValue: unrealized + realized,
      });
      const linked = await markCashFlowsMatched(target.cashFlowIds, created.position.id);
      return { position: created.position, linked };
    },
    inspectAfter: ({ result }) => directRows([result.position.id]).then(rows => rows[0]),
    affectedResources: ({ target, result }) => [
      { type: 'direct_position', id: Number(result.position.id), label: result.position.company_name },
      ...target.cashFlowIds.map(id => ({ type: 'cash_flow', id })),
    ],
  }),
  base({
    name: 'direct.keep_separate',
    title: 'Keep Direct positions separate',
    description: 'Record that an exact duplicate-looking position set is intentionally separate.',
    risk: 'metadata_change',
    editableInputKeys: [],
    inputSchema: schema({ investmentIds: { type: 'array', minItems: 2, uniqueItems: true, items: { type: 'integer', minimum: 1 } } }, ['investmentIds']),
    resolve: async input => ({ type: 'direct_position_set', id: [...input.investmentIds].sort((a, b) => a - b).join(','), label: `${input.investmentIds.length} Direct positions`, investmentIds: [...input.investmentIds].sort((a, b) => a - b) }),
    inspect: target => directRows(target.investmentIds),
    preview: ({ target, current }) => ({ summary: `Keep ${current.length} positions separate.`, target, before: current.map(row => ({ field: `position_${row.id}`, value: 'unreviewed' })), after: current.map(row => ({ field: `position_${row.id}`, value: 'separate' })), derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target }) => keepPositionsSeparate(target.investmentIds),
    affectedResources: ({ target }) => target.investmentIds.map(id => ({ type: 'direct_position', id })),
  }),
  base({
    name: 'direct.consolidate',
    title: 'Consolidate Direct positions',
    description: 'Consolidate exact duplicate Direct positions into one retained position.',
    risk: 'destructive',
    interactionPolicy: 'confirm_inline',
    editableInputKeys: ['targetInvestmentId'],
    inputSchema: schema({
      targetInvestmentId: { type: 'integer', minimum: 1 },
      sourceInvestmentIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
    }, ['targetInvestmentId', 'sourceInvestmentIds']),
    resolve: async input => ({ type: 'direct_position_set', id: [input.targetInvestmentId, ...input.sourceInvestmentIds].sort((a, b) => a - b).join(','), label: `${input.sourceInvestmentIds.length + 1} Direct positions`, targetInvestmentId: input.targetInvestmentId, sourceInvestmentIds: [...input.sourceInvestmentIds].sort((a, b) => a - b) }),
    inspect: target => directRows([target.targetInvestmentId, ...target.sourceInvestmentIds]),
    preview: ({ target, current }) => ({ summary: `Consolidate ${current.length} positions into ${current.find(row => row.id === target.targetInvestmentId)?.company_name}.`, target, before: current.map(row => ({ field: `position_${row.id}`, value: row.asset_class })), after: target.sourceInvestmentIds.map(id => ({ field: `position_${id}`, value: 'merged' })), derivedEffects: [], warnings: ['Source records become historical merged positions; financial history moves to the retained position.'], requiredReason: false }),
    preconditions: ({ current }) => current,
    apply: ({ target }) => consolidatePositions({ targetInvestmentId: target.targetInvestmentId, sourceInvestmentIds: target.sourceInvestmentIds }),
    inspectAfter: async ({ target }) => query(`
      SELECT id, company_name, asset_class, status, invest_date, invested,
             unrealized_value, realized_value, net_value, updated_at
        FROM investments
       WHERE id = ANY($1::int[])
       ORDER BY id
    `, [[target.targetInvestmentId, ...target.sourceInvestmentIds]]),
    affectedResources: ({ target }) => [target.targetInvestmentId, ...target.sourceInvestmentIds].map(id => ({ type: 'direct_position', id })),
  }),
];
