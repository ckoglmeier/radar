import { query, writeCapabilities } from '../db/index.js';
import { intakeCommit } from '../intake/index.js';
import { answerFounderFollowup } from '../models/council-followups.js';
import {
  cancelQueuedCouncilRun,
  excludeCouncilDocument,
  queueCouncilRun,
} from '../models/council-actions.js';
import { COUNCIL_RUN_TYPES } from '../models/council-runs.js';
import { createVaultFileFromPendingIntake } from '../models/file-vault.js';
import { CommandError } from './errors.js';

const objectResult = { type: 'object', additionalProperties: true };
const text = { type: 'string', minLength: 1 };
const nullableText = { anyOf: [text, { type: 'null' }] };
const uuid = { type: 'string', format: 'uuid' };

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

async function available() {
  const capabilities = await writeCapabilities();
  return capabilities.proposalApply === 'transactional' && capabilities.serializedWrites;
}

function definition(base) {
  return {
    version: 1,
    tier: 'A',
    risk: 'lifecycle',
    domainAtomicity: 'multi_statement',
    proposeCapabilities: ['portfolio:propose'],
    applyCapabilities: ['portfolio:apply:metadata'],
    availability: available,
    resultSchema: objectResult,
    interactionPolicy: 'execute_inline',
    undoPolicy: 'unavailable',
    plannerExposure: true,
    ...base,
  };
}

async function inviteTarget(inviteId) {
  const [row] = await query('SELECT id, company_name FROM pipeline_invites WHERE id = $1', [inviteId]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${inviteId}`);
  return { type: 'pipeline_invite', id: Number(row.id), label: row.company_name };
}

async function inspectInvite(target) {
  const [invite] = await query('SELECT id, status, updated_at FROM pipeline_invites WHERE id = $1', [target.id]);
  if (!invite) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${target.id}`);
  const [evaluation] = await query(`
    SELECT id, created_at FROM deal_evaluations
     WHERE pipeline_invite_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1
  `, [target.id]);
  const [run] = await query(`
    SELECT id, status, stage, run_type, updated_at FROM council_runs
     WHERE pipeline_invite_id = $1
     ORDER BY started_at DESC, id DESC LIMIT 1
  `, [target.id]);
  const [pending] = await query(`
    SELECT COUNT(*)::int AS count FROM council_followup_questions
     WHERE pipeline_invite_id = $1 AND answer IS NOT NULL AND applied_evaluation_id IS NULL
  `, [target.id]);
  return { invite, evaluation: evaluation || null, run: run || null, pending_answers: Number(pending.count) };
}

async function pendingTarget(previewId, expectedType = null) {
  const [row] = await query(`
    SELECT id, filename, mime, sha256, size_bytes, preview, status, created_refs, expires_at
      FROM pending_intake WHERE id = $1 AND expires_at > NOW()
  `, [previewId]);
  if (!row || (expectedType && row.preview?.type !== expectedType)) {
    throw new CommandError('TARGET_NOT_FOUND', 'The staged upload is missing or expired.');
  }
  return { type: 'pending_intake', id: row.id, label: row.filename || 'Staged upload' };
}

async function inspectPending(target) {
  const [row] = await query(`
    SELECT id, filename, mime, sha256, size_bytes, preview, status, created_refs, expires_at
      FROM pending_intake WHERE id = $1 AND expires_at > NOW()
  `, [target.id]);
  if (!row) throw new CommandError('TARGET_NOT_FOUND', 'The staged upload is missing or expired.');
  return row;
}

export const intakeCouncilCommandDefinitions = [
  definition({
    name: 'intake.commit',
    title: 'Add staged intake item',
    description: 'Commit an already-reviewed staged artifact to its selected Radar record.',
    editableInputKeys: ['overrides'],
    inputSchema: schema({
      previewId: uuid,
      overrides: { type: 'object', additionalProperties: true },
    }, ['previewId', 'overrides']),
    resolve: input => pendingTarget(input.previewId),
    inspect: inspectPending,
    preview: ({ target, input, current }) => ({
      summary: `Add ${target.label} to Radar.`, target,
      before: [{ field: 'status', value: current.status }],
      after: [{ field: 'type', value: input.overrides.type || current.preview?.type || null }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ status: current.status, sha256: current.sha256, expires_at: current.expires_at }),
    apply: ({ input }) => intakeCommit({ preview_id: input.previewId, overrides: input.overrides }),
    affectedResources: ({ result }) => result.created
      ? [{ type: result.created.table || 'intake_record', id: result.created.id }]
      : [{ type: 'document', id: result.document_id }],
  }),
  definition({
    name: 'intake.exclude_document',
    title: 'Exclude blocking Council document',
    description: 'Record an evidence waiver for one unusable source and retry the blocked Council run.',
    risk: 'sensitive_basis',
    interactionPolicy: 'confirm_inline',
    editableInputKeys: ['reason'],
    inputSchema: schema({
      inviteId: { type: 'integer', minimum: 1 },
      runId: { type: 'integer', minimum: 1 },
      documentId: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 3 },
    }, ['inviteId', 'runId', 'documentId', 'reason']),
    resolve: input => inviteTarget(input.inviteId),
    inspect: async (target, input) => {
      const [run] = await query(`
        SELECT id, status, error_code, source_manifest, source_coverage, updated_at
          FROM council_runs WHERE id = $1 AND pipeline_invite_id = $2
      `, [input.runId, target.id]);
      if (!run) throw new CommandError('TARGET_NOT_FOUND', `Council run not found: ${input.runId}`);
      return run;
    },
    preview: ({ target, input, current }) => ({
      summary: `Exclude one blocking source for ${target.label} and retry Council.`, target,
      before: [{ field: 'run_status', value: current.status }, { field: 'document_id', value: input.documentId }],
      after: [{ field: 'document_status', value: 'excluded_by_user' }, { field: 'run_status', value: 'queued' }],
      derivedEffects: ['Council will score without this source.'], warnings: ['This changes the evidence basis.'], requiredReason: true,
    }),
    preconditions: ({ current }) => current,
    apply: ({ input }) => excludeCouncilDocument(input),
    affectedResources: ({ target, result }) => [target, { type: 'council_run', id: Number(result.run.id), label: target.label }],
  }),
  definition({
    name: 'council.start',
    title: 'Start Council analysis',
    description: 'Queue a durable Council run for the selected pipeline deal.',
    editableInputKeys: ['fresh', 'runType'],
    inputSchema: schema({
      inviteId: { type: 'integer', minimum: 1 },
      fresh: { type: 'boolean' },
      runType: { type: 'string', enum: [...COUNCIL_RUN_TYPES] },
    }, ['inviteId', 'fresh', 'runType']),
    resolve: input => inviteTarget(input.inviteId),
    inspect: inspectInvite,
    preview: ({ target, input, current }) => {
      if (current.run && ['queued', 'running'].includes(current.run.status)) {
        throw new CommandError('PRECONDITION_FAILED', `${target.label} already has an active Council run.`);
      }
      return {
        summary: `Queue ${input.runType.replaceAll('_', ' ')} Council analysis for ${target.label}.`, target,
        before: [{ field: 'latest_run', value: current.run?.status || null }],
        after: [{ field: 'run_status', value: 'queued' }],
        derivedEffects: ['Radar Desktop will run the configured models in the background.'], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, input, idempotencyKey }) => queueCouncilRun({
      inviteId: target.id, runType: input.runType, fresh: input.fresh, executionId: idempotencyKey,
    }),
    affectedResources: ({ target, result }) => [target, ...(result.run ? [{ type: 'council_run', id: Number(result.run.id), label: target.label }] : [])],
  }),
  definition({
    name: 'council.cancel',
    title: 'Stop Council analysis',
    description: 'Cancel the active queued or running Council analysis for a pipeline deal.',
    editableInputKeys: [],
    inputSchema: schema({ inviteId: { type: 'integer', minimum: 1 } }, ['inviteId']),
    resolve: input => inviteTarget(input.inviteId),
    inspect: inspectInvite,
    preview: ({ target, current }) => ({
      summary: `Stop Council analysis for ${target.label}.`, target,
      before: [{ field: 'run_status', value: current.run?.status || null }],
      after: [{ field: 'run_status', value: 'cancelled' }],
      derivedEffects: [], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target }) => cancelQueuedCouncilRun(target.id),
    affectedResources: ({ target, result }) => [target, ...(result.run ? [{ type: 'council_run', id: Number(result.run.id), label: target.label }] : [])],
  }),
  definition({
    name: 'council.answer_followup',
    title: 'Answer Council follow-up',
    description: 'Save or replace a founder answer for one Council follow-up question.',
    editableInputKeys: ['answer'],
    inputSchema: schema({
      questionId: { type: 'integer', minimum: 1 },
      answer: { type: 'string', minLength: 1, maxLength: 12000 },
    }, ['questionId', 'answer']),
    resolve: async input => {
      const [row] = await query(`
        SELECT fq.id, fq.question, pi.company_name
          FROM council_followup_questions fq
          JOIN pipeline_invites pi ON pi.id = fq.pipeline_invite_id
         WHERE fq.id = $1
      `, [input.questionId]);
      if (!row) throw new CommandError('TARGET_NOT_FOUND', `Council follow-up not found: ${input.questionId}`);
      return { type: 'council_followup', id: Number(row.id), label: `${row.company_name}: ${row.question}` };
    },
    inspect: async target => (await query(`
      SELECT id, answer, answered_at, applied_evaluation_id, updated_at
        FROM council_followup_questions WHERE id = $1
    `, [target.id]))[0],
    preview: ({ target, input, current }) => ({
      summary: `${current.answer ? 'Replace' : 'Save'} the answer to ${target.label}.`, target,
      before: [{ field: 'answer', value: current.answer }],
      after: [{ field: 'answer', value: input.answer }],
      derivedEffects: ['A later reassessment can apply this answer.'], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => current,
    apply: ({ target, input }) => answerFounderFollowup({ questionId: target.id, answer: input.answer }),
    affectedResources: ({ target }) => [target],
  }),
  definition({
    name: 'council.apply_followups',
    title: 'Apply Council follow-up answers',
    description: 'Queue a founder-follow-up Council reassessment using all saved, unapplied answers.',
    editableInputKeys: [],
    inputSchema: schema({ inviteId: { type: 'integer', minimum: 1 } }, ['inviteId']),
    resolve: input => inviteTarget(input.inviteId),
    inspect: inspectInvite,
    preview: ({ target, current }) => {
      if (!current.evaluation) throw new CommandError('PRECONDITION_FAILED', 'A completed Council evaluation is required.');
      if (current.pending_answers === 0) throw new CommandError('PRECONDITION_FAILED', 'Save at least one founder answer before reassessing.');
      if (current.run && ['queued', 'running'].includes(current.run.status)) {
        throw new CommandError('PRECONDITION_FAILED', 'Wait for the active Council evaluation to finish.');
      }
      return {
        summary: `Apply ${current.pending_answers} founder answer${current.pending_answers === 1 ? '' : 's'} for ${target.label}.`, target,
        before: [{ field: 'pending_answers', value: current.pending_answers }],
        after: [{ field: 'run_status', value: 'queued' }],
        derivedEffects: ['The new evaluation will supersede the prior canonical score when completed.'], warnings: [], requiredReason: false,
      };
    },
    preconditions: ({ current }) => current,
    apply: ({ target, idempotencyKey }) => queueCouncilRun({
      inviteId: target.id, runType: 'founder_followup', fresh: true, executionId: idempotencyKey,
    }),
    affectedResources: ({ target, result }) => [target, { type: 'council_run', id: Number(result.run.id), label: target.label }],
  }),
  definition({
    name: 'document.vault_upload',
    title: 'Store File Vault document',
    description: 'Commit a locally staged private document and its reviewed File Vault metadata.',
    risk: 'sensitive_basis',
    editableInputKeys: ['title', 'category', 'relatedEntityType', 'relatedEntityId', 'relatedLabel', 'ownerName', 'documentDate', 'notes'],
    inputSchema: schema({
      previewId: uuid,
      title: text,
      category: { type: 'string', enum: ['life_insurance', 'home_insurance', 'auto_insurance', 'umbrella_insurance', 'estate', 'tax', 'identity', 'investments', 'other'] },
      relatedEntityType: { anyOf: [{ type: 'string', enum: ['investment', 'portfolio_entity'] }, { type: 'null' }] },
      relatedEntityId: nullableText,
      relatedLabel: nullableText,
      ownerName: nullableText,
      documentDate: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
      notes: nullableText,
    }, ['previewId', 'title', 'category']),
    resolve: input => pendingTarget(input.previewId, 'file_vault_upload'),
    inspect: inspectPending,
    preview: ({ target, input, current }) => ({
      summary: `Store ${input.title} in File Vault.`, target,
      before: [{ field: 'staged_filename', value: current.filename }],
      after: [{ field: 'category', value: input.category }, { field: 'related_record', value: input.relatedLabel }],
      derivedEffects: ['The original bytes stay local and are excluded from the command transcript.'], warnings: [], requiredReason: false,
    }),
    preconditions: ({ current }) => ({ status: current.status, sha256: current.sha256, expires_at: current.expires_at }),
    apply: ({ input }) => createVaultFileFromPendingIntake(input),
    affectedResources: ({ result }) => [
      { type: 'file_vault_entry', id: result.id, label: result.title },
      { type: 'document', id: Number(result.document.id), label: result.document.filename },
    ],
  }),
];
