import { query, writeCapabilities } from '../db/index.js';
import {
  clearPipelineInvite,
  markPipelineInvestmentExecuted,
  reopenPipelineDecision,
  sealPipelineDecision,
} from '../models/pipeline-actions.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [text, { type: 'null' }] };
const nullableNumber = { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] };
const date = { type: 'string', format: 'date' };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

async function inviteTarget(inviteId) {
  const [row] = await query('SELECT id, company_name FROM pipeline_invites WHERE id = $1', [inviteId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${inviteId}`);
  return { type: 'pipeline_invite', id: Number(row.id), label: row.company_name };
}

async function inspectInvite(target) {
  const [row] = await query(`
    SELECT pi.*,
           dr.id AS decision_record_id, dr.decision, dr.sealed, dr.sealed_at,
           i.status AS investment_status, i.invested AS investment_amount,
           i.invest_date AS investment_date
      FROM pipeline_invites pi
      LEFT JOIN LATERAL (
        SELECT * FROM decision_records
         WHERE pipeline_invite_id = pi.id
         ORDER BY sealed_at DESC NULLS LAST, id DESC LIMIT 1
      ) dr ON TRUE
      LEFT JOIN investments i ON i.id = pi.investment_id
     WHERE pi.id = $1
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${target.id}`);
  return row;
}

function definition(base) {
  return {
    version: 1, tier: 'A', risk: 'lifecycle', domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'], applyCapabilities: ['portfolio:apply:metadata'],
    availability: available, resultSchema: objectResult, plannerExposure: true,
    interactionPolicy: 'confirm_inline', undoPolicy: 'unavailable',
    resolve: input => inviteTarget(input.inviteId), inspect: inspectInvite,
    affectedResources: ({ target, result }) => [
      target,
      ...(result?.investmentId || result?.investment_id
        ? [{ type: 'direct_position', id: Number(result.investmentId || result.investment_id), label: target.label }]
        : []),
    ],
    ...base,
  };
}

export const pipelineCommandDefinitions = [
  definition({
    name: 'pipeline.seal_decision',
    title: 'Record pipeline decision',
    description: 'Seal an invest or pass decision and transition the linked pipeline record atomically.',
    editableInputKeys: ['decision', 'chosenSize', 'thesisId', 'whatWasKnown', 'whatWasBelieved', 'keyRisks', 'bearView', 'confidence'],
    inputSchema: schema({
      inviteId: { type: 'integer', minimum: 1 },
      dealEvaluationId: { type: 'integer', minimum: 1 },
      companyName: text,
      decision: { type: 'string', enum: ['invest', 'pass'] },
      chosenSize: nullableNumber,
      thesisId: nullableInteger,
      whatWasKnown: nullableText,
      whatWasBelieved: nullableText,
      keyRisks: nullableText,
      bearView: nullableText,
      confidence: { anyOf: [{ type: 'integer', minimum: 0, maximum: 5 }, { type: 'null' }] },
      sizingBasis: { anyOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
      lead: nullableText,
      round: nullableText,
      market: nullableText,
      valuationUsd: nullableNumber,
      carryPct: nullableNumber,
    }, ['inviteId', 'dealEvaluationId', 'companyName', 'decision']),
    preview: ({ target, input, current }) => ({
      summary: `Record ${input.decision} decision for ${target.label}.`, target,
      before: [{ field: 'pipeline_status', value: current.status }, { field: 'sealed_decision', value: current.sealed ? current.decision : null }],
      after: [{ field: 'pipeline_status', value: input.decision === 'invest' ? 'committed' : 'passed' }, { field: 'decision', value: input.decision }, { field: 'chosen_size', value: input.chosenSize }],
      derivedEffects: input.decision === 'invest' ? ['Creates or links a Closing Direct position.'] : [],
      warnings: [], requiredReason: true,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => sealPipelineDecision(input),
  }),
  definition({
    name: 'pipeline.clear',
    title: 'Clear pipeline deal',
    description: 'Remove an active deal from pipeline work while retaining its history.',
    editableInputKeys: [],
    inputSchema: schema({ inviteId: { type: 'integer', minimum: 1 } }, ['inviteId']),
    preview: ({ target, current }) => ({
      summary: `Clear ${target.label} from active pipeline work.`, target,
      before: [{ field: 'status', value: current.status }],
      after: [{ field: 'status', value: 'archived' }],
      derivedEffects: ['Any running Council evaluation is cancelled.'], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target }) => clearPipelineInvite(target.id),
  }),
  definition({
    name: 'pipeline.reopen_decision',
    title: 'Reconsider pipeline decision',
    description: 'Reconsider a pass or an unexecuted commitment while retaining the original decision record.',
    editableInputKeys: [],
    inputSchema: schema({ inviteId: { type: 'integer', minimum: 1 } }, ['inviteId']),
    preview: ({ target, current }) => ({
      summary: `Reconsider the decision for ${target.label}.`, target,
      before: [{ field: 'status', value: current.status }, { field: 'sealed', value: current.sealed }],
      after: [{ field: 'status', value: 'invite' }, { field: 'sealed', value: false }],
      derivedEffects: current.decision === 'invest'
        ? ['Removes the generated Closing placeholder only if it has no activity or economic records.']
        : [],
      warnings: current.decision === 'invest'
        ? ['Executed investments cannot be reconsidered from the pipeline.']
        : [],
      requiredReason: true,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target }) => reopenPipelineDecision(target.id),
  }),
  definition({
    name: 'pipeline.mark_executed',
    title: 'Mark pipeline investment executed',
    description: 'Convert a committed Closing position to a funded Live investment.',
    interactionPolicy: 'execute_inline',
    editableInputKeys: ['executionDate', 'actualAmount'],
    inputSchema: schema({
      inviteId: { type: 'integer', minimum: 1 }, executionDate: date,
      actualAmount: { type: 'number', exclusiveMinimum: 0 },
    }, ['inviteId', 'executionDate', 'actualAmount']),
    preview: ({ target, input, current }) => ({
      summary: `Mark ${target.label} executed for ${input.actualAmount}.`, target,
      before: [{ field: 'pipeline_status', value: current.status }, { field: 'investment_status', value: current.investment_status }],
      after: [{ field: 'pipeline_status', value: 'invested' }, { field: 'investment_status', value: 'Live' }, { field: 'invested', value: input.actualAmount }, { field: 'invest_date', value: input.executionDate }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => markPipelineInvestmentExecuted({ inviteId: target.id, ...input }),
  }),
];
