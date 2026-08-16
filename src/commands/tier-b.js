import { query, writeCapabilities } from '../db/index.js';
import { markCashFlowsMatched, resolveCashFlows } from '../models/reconciliation.js';
import { resolveCompanyAlias, saveCompanyAlias } from '../models/company-aliases.js';
import { CommandError } from './errors.js';

const resultSchema = { type: 'object', additionalProperties: true };

async function availability() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

async function flows(ids) {
  const rows = await query(`
    SELECT id, investment_id, reconciliation_status, reconciliation_note, reconciled_at, created_at
      FROM cash_flows WHERE id = ANY($1::int[]) ORDER BY id
  `, [ids]);
  if (rows.length !== ids.length) throw new CommandError('TARGET_NOT_FOUND', 'One or more cash flows were not found.');
  return rows;
}

function definition(base) {
  return {
    tier: 'B', version: 1, risk: 'reconciliation', domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'], applyCapabilities: ['portfolio:apply:reconciliation'],
    resultSchema, availability,
    affectedResources: ({ target }) => target.affected,
    ...base,
  };
}

export const tierBCommandDefinitions = [
  definition({
    name: 'transaction.match_to_position', title: 'Match transactions to Direct position',
    description: 'Match exact pending cash-flow IDs to one exact Direct position ID.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        cashFlowIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
        investmentId: { type: 'integer', minimum: 1 },
      },
      required: ['cashFlowIds', 'investmentId'],
    },
    resolve: async input => {
      const [investment] = await query(`SELECT id, company_name, asset_class FROM investments WHERE id = $1`, [input.investmentId]);
      if (!investment) throw new CommandError('TARGET_NOT_FOUND', `Investment not found: ${input.investmentId}`);
      if (investment.asset_class !== 'direct') throw new CommandError('WRONG_TARGET_TYPE', 'Transactions can be matched only to a Direct position.');
      return { type: 'direct_position', id: Number(investment.id), label: investment.company_name, affected: input.cashFlowIds.map(id => ({ type: 'cash_flow', id })) };
    },
    inspect: (_target, input) => flows(input.cashFlowIds),
    preview: ({ target, current }) => ({ summary: `Match ${current.length} transaction(s) to ${target.label}`, target, before: current.map(row => ({ field: `cash_flow_${row.id}`, value: row.reconciliation_status })), after: current.map(row => ({ field: `cash_flow_${row.id}`, value: 'matched' })), derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => ({ flows: current.map(row => ({ id: Number(row.id), investment_id: row.investment_id == null ? null : Number(row.investment_id), reconciliation_status: row.reconciliation_status, reconciled_at: row.reconciled_at, created_at: row.created_at })) }),
    apply: async ({ target, input }) => ({ rows: await markCashFlowsMatched(input.cashFlowIds, target.id) }),
  }),
  definition({
    name: 'transaction.classify', title: 'Classify pending transactions',
    description: 'Classify exact pending cash-flow IDs as ignored or routed to Funds.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        cashFlowIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 1 } },
        action: { type: 'string', enum: ['ignored', 'fund'] },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['cashFlowIds', 'action'],
    },
    resolve: input => ({ type: 'cash_flow_set', id: input.cashFlowIds.join(','), label: `${input.cashFlowIds.length} transactions`, affected: input.cashFlowIds.map(id => ({ type: 'cash_flow', id })) }),
    inspect: (_target, input) => flows(input.cashFlowIds),
    preview: ({ target, input, current }) => ({ summary: `Classify ${current.length} transaction(s) as ${input.action}`, target, before: current.map(row => ({ field: `cash_flow_${row.id}`, value: row.reconciliation_status })), after: current.map(row => ({ field: `cash_flow_${row.id}`, value: input.action })), derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => ({ flows: current.map(row => ({ id: Number(row.id), investment_id: row.investment_id == null ? null : Number(row.investment_id), reconciliation_status: row.reconciliation_status, reconciled_at: row.reconciled_at, created_at: row.created_at })) }),
    apply: async ({ input }) => ({ rows: await resolveCashFlows({ cashFlowIds: input.cashFlowIds, action: input.action, note: input.note }) }),
  }),
  definition({
    name: 'company.save_alias', title: 'Save company alias',
    description: 'Save an alternate company name against an exact Direct position.',
    risk: 'metadata_change',
    applyCapabilities: ['portfolio:apply:metadata'],
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        canonicalInvestmentId: { type: 'integer', minimum: 1 },
        alias: { type: 'string', minLength: 1 },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['canonicalInvestmentId', 'alias'],
    },
    resolve: async input => {
      const [investment] = await query(`SELECT id, company_name, asset_class, portfolio_entity_id, updated_at FROM investments WHERE id = $1`, [input.canonicalInvestmentId]);
      if (!investment) throw new CommandError('TARGET_NOT_FOUND', `Investment not found: ${input.canonicalInvestmentId}`);
      if (investment.asset_class !== 'direct') throw new CommandError('WRONG_TARGET_TYPE', 'Company alias requires a Direct position.');
      return { type: 'direct_company', id: Number(investment.id), label: investment.company_name, affected: [{ type: 'direct_position', id: Number(investment.id) }] };
    },
    inspect: async (target, input) => ({
      investment: (await query(`SELECT id, company_name, asset_class, portfolio_entity_id, updated_at FROM investments WHERE id = $1`, [target.id]))[0],
      existing: await resolveCompanyAlias(input.alias),
    }),
    preview: ({ target, input, current }) => ({ summary: `Save ${input.alias} as an alias for ${target.label}`, target, before: [{ field: 'existing_alias', value: current.existing?.canonical_company_name || null }], after: [{ field: 'canonical_company', value: target.label }], derivedEffects: [], warnings: [], requiredReason: false }),
    preconditions: ({ current }) => ({ investment: current.investment, existing_alias_id: current.existing?.id || null, existing_canonical: current.existing?.canonical_company_name || null }),
    apply: ({ target, input }) => saveCompanyAlias({ alias: input.alias, canonicalCompanyName: target.label, provenanceSource: 'command', provenanceNote: input.note, confirmedBy: 'user' }),
  }),
];
