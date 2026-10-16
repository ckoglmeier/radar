import { randomUUID } from 'node:crypto';
import { query } from '../db/index.js';
import { CommandError } from '../commands/errors.js';
import {
  canonicalJson,
  personalFitApplicable,
  validateBusinessPreferences,
  validateDraftState,
  validateSnapshot,
  snapshotHash,
} from '../angel/personal-context.js';

// One-time angel evaluation persistence. Every function takes a workspaceId and
// filters by it; a row in another workspace is indistinguishable from a missing
// one. Snapshots are only ever produced by buildEvaluationSnapshot (callers) and
// re-validated here through validateSnapshot.

export const DEFAULT_WORKSPACE_ID = 'local';

function ws(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new CommandError('WORKSPACE_REQUIRED', 'A workspace is required.');
  }
  return workspaceId;
}

const json = value => (typeof value === 'string' ? JSON.parse(value) : value);
const isUnique = error => error?.code === '23505' || /unique|duplicate key/i.test(error?.message || '');

function draftRow(row) {
  if (!row) return null;
  return { ...row, revision: Number(row.revision), state: json(row.state), pipeline_invite_id: row.pipeline_invite_id == null ? null : Number(row.pipeline_invite_id) };
}

function contextRow(row) {
  if (!row) return null;
  return {
    ...row,
    draft_revision: Number(row.draft_revision),
    pipeline_invite_id: Number(row.pipeline_invite_id),
    council_run_id: row.council_run_id == null ? null : Number(row.council_run_id),
    snapshot: json(row.snapshot),
  };
}

function jobRow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    attempt_number: Number(row.attempt_number),
    result: row.result == null ? null : json(row.result),
    usage_snapshot: row.usage_snapshot == null ? null : json(row.usage_snapshot),
  };
}

// ── Reusable business-preference list (HOW) ────────────────────────────────

function listRow(row) {
  return row ? { id: row.id, version: Number(row.version), items: json(row.items), confirmed_at: row.confirmed_at } : null;
}

export async function currentBusinessPreferenceList({ workspaceId }) {
  const [row] = await query(`
    SELECT * FROM angel_business_preference_lists
     WHERE workspace_id = $1 AND domain = 'angel'
     ORDER BY version DESC LIMIT 1
  `, [ws(workspaceId)]);
  return listRow(row);
}

// Appends a new version. An empty list is saved as an intentional "unspecified".
export async function saveBusinessPreferenceList({ workspaceId, items }) {
  const workspace = ws(workspaceId);
  const normalized = validateBusinessPreferences(items ?? []);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await currentBusinessPreferenceList({ workspaceId: workspace });
    try {
      const [row] = await query(`
        INSERT INTO angel_business_preference_lists (id, workspace_id, version, items)
        VALUES ($1, $2, $3, $4::jsonb) RETURNING *
      `, [randomUUID(), workspace, (current?.version || 0) + 1, JSON.stringify(normalized)]);
      return listRow(row);
    } catch (error) {
      if (!isUnique(error) || attempt === 2) throw error;
    }
  }
  return null;
}

export function sameBusinessItems(left, right) {
  return canonicalJson(left ?? []) === canonicalJson(right ?? []);
}

// ── Drafts ─────────────────────────────────────────────────────────────────

export async function createEvaluationDraft({ workspaceId, inviteId = null, state = {} }) {
  const workspace = ws(workspaceId);
  const normalized = validateDraftState(state);
  const invite = inviteId != null ? Number(inviteId) : normalized.company?.pipeline_invite_id ?? null;
  if (invite != null) {
    const [exists] = await query('SELECT id FROM pipeline_invites WHERE id = $1', [invite]);
    if (!exists) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${invite}`);
    normalized.company = { name: null, url: null, deal_slug: null, ...(normalized.company || {}), pipeline_invite_id: invite };
  }
  const [row] = await query(`
    INSERT INTO angel_evaluation_drafts (id, workspace_id, pipeline_invite_id, state)
    VALUES ($1, $2, $3, $4::jsonb) RETURNING *
  `, [randomUUID(), workspace, invite, JSON.stringify(normalized)]);
  return draftRow(row);
}

export async function getEvaluationDraft({ workspaceId, draftId }) {
  const [row] = await query('SELECT * FROM angel_evaluation_drafts WHERE id = $1 AND workspace_id = $2', [String(draftId), ws(workspaceId)]);
  return draftRow(row);
}

export async function saveEvaluationDraft({ workspaceId, draftId, expectedRevision, state }) {
  const workspace = ws(workspaceId);
  if (!Number.isInteger(expectedRevision)) throw new CommandError('STALE_DRAFT', 'This draft needs its current revision to be saved.');
  const normalized = validateDraftState(state);
  const invite = normalized.company?.pipeline_invite_id ?? null;
  if (invite != null) {
    const [exists] = await query('SELECT id FROM pipeline_invites WHERE id = $1', [invite]);
    if (!exists) throw new CommandError('TARGET_NOT_FOUND', `Pipeline deal not found: ${invite}`);
  }
  const [row] = await query(`
    UPDATE angel_evaluation_drafts
       SET state = $4::jsonb, pipeline_invite_id = $5, revision = revision + 1, updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND revision = $3 AND status = 'draft'
 RETURNING *
  `, [String(draftId), workspace, expectedRevision, JSON.stringify(normalized), invite]);
  if (row) return draftRow(row);
  const current = await getEvaluationDraft({ workspaceId: workspace, draftId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  if (current.status !== 'draft') throw new CommandError('PRECONDITION_FAILED', `This evaluation draft was already ${current.status}.`);
  throw new CommandError('STALE_DRAFT', 'This draft changed somewhere else. Your edits are kept here; reload to merge.', { current_revision: current.revision });
}

export async function discardEvaluationDraft({ workspaceId, draftId }) {
  const workspace = ws(workspaceId);
  const current = await getEvaluationDraft({ workspaceId: workspace, draftId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  if (current.status === 'discarded') return current;
  if (current.status === 'submitted') throw new CommandError('PRECONDITION_FAILED', 'A submitted evaluation cannot be discarded.');
  const [row] = await query(`
    UPDATE angel_evaluation_drafts SET status = 'discarded', updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status = 'draft' RETURNING *
  `, [String(draftId), workspace]);
  return draftRow(row) || getEvaluationDraft({ workspaceId: workspace, draftId });
}

export async function markEvaluationDraftSubmitted({ workspaceId, draftId }) {
  const [row] = await query(`
    UPDATE angel_evaluation_drafts SET status = 'submitted', updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2 AND status IN ('draft', 'submitted') RETURNING *
  `, [String(draftId), ws(workspaceId)]);
  if (!row) throw new CommandError('PRECONDITION_FAILED', 'This evaluation draft is no longer open.');
  return draftRow(row);
}

// ── Contexts ───────────────────────────────────────────────────────────────

export async function getEvaluationContext({ workspaceId, contextId }) {
  const [row] = await query('SELECT * FROM angel_evaluation_contexts WHERE id = $1 AND workspace_id = $2', [String(contextId), ws(workspaceId)]);
  return contextRow(row);
}

export async function contextForDraftRevision({ workspaceId, draftId, draftRevision }) {
  const [row] = await query(`
    SELECT * FROM angel_evaluation_contexts
     WHERE workspace_id = $1 AND draft_id = $2 AND draft_revision = $3
  `, [ws(workspaceId), String(draftId), draftRevision]);
  return contextRow(row);
}

// Idempotent per (draft, revision): a repeat returns the existing context.
export async function createEvaluationContext({ workspaceId, draftId, draftRevision, snapshot }) {
  const workspace = ws(workspaceId);
  const draft = await getEvaluationDraft({ workspaceId: workspace, draftId });
  if (!draft) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation draft not found.');
  const existing = await contextForDraftRevision({ workspaceId: workspace, draftId, draftRevision });
  if (existing) return existing;
  const valid = validateSnapshot(snapshot);
  const [row] = await query(`
    INSERT INTO angel_evaluation_contexts
      (id, workspace_id, draft_id, draft_revision, pipeline_invite_id, contract_version, snapshot, snapshot_sha256)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    ON CONFLICT (workspace_id, draft_id, draft_revision) DO NOTHING
    RETURNING *
  `, [randomUUID(), workspace, String(draftId), draftRevision, valid.company.pipeline_invite_id, valid.contract_version, JSON.stringify(valid), snapshotHash(valid)]);
  return contextRow(row) || contextForDraftRevision({ workspaceId: workspace, draftId, draftRevision });
}

// Set once. Re-attaching the same run is a no-op; a different run is refused.
export async function attachContextRun({ workspaceId, contextId, runId }) {
  const workspace = ws(workspaceId);
  const [row] = await query(`
    UPDATE angel_evaluation_contexts SET council_run_id = $3
     WHERE id = $1 AND workspace_id = $2 AND council_run_id IS NULL RETURNING *
  `, [String(contextId), workspace, Number(runId)]);
  if (row) return contextRow(row);
  const current = await getEvaluationContext({ workspaceId: workspace, contextId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation context not found.');
  if (current.council_run_id === Number(runId)) return current;
  throw new CommandError('PRECONDITION_FAILED', 'This evaluation is already linked to a different analysis run.');
}

export async function contextForRun({ workspaceId, runId }) {
  const [row] = await query('SELECT * FROM angel_evaluation_contexts WHERE council_run_id = $1 AND workspace_id = $2', [Number(runId), ws(workspaceId)]);
  return contextRow(row);
}

export async function contextsForInvite({ workspaceId, inviteId }) {
  const rows = await query(`
    SELECT * FROM angel_evaluation_contexts
     WHERE pipeline_invite_id = $1 AND workspace_id = $2
     ORDER BY created_at DESC, seq DESC
  `, [Number(inviteId), ws(workspaceId)]);
  return rows.map(contextRow);
}

// ── Personal-fit jobs ──────────────────────────────────────────────────────

export async function getPersonalFitJob({ workspaceId, contextId }) {
  const [row] = await query('SELECT * FROM angel_personal_fit_jobs WHERE context_id = $1 AND workspace_id = $2', [String(contextId), ws(workspaceId)]);
  return jobRow(row);
}

export async function createPersonalFitJob({ workspaceId, contextId }) {
  const workspace = ws(workspaceId);
  const context = await getEvaluationContext({ workspaceId: workspace, contextId });
  if (!context) throw new CommandError('TARGET_NOT_FOUND', 'Evaluation context not found.');
  const status = personalFitApplicable(validateSnapshot(context.snapshot)) ? 'waiting' : 'not_applicable';
  await query(`
    INSERT INTO angel_personal_fit_jobs (context_id, workspace_id, status)
    VALUES ($1, $2, $3) ON CONFLICT (context_id) DO NOTHING
  `, [context.id, workspace, status]);
  return getPersonalFitJob({ workspaceId: workspace, contextId });
}

export async function claimNextPersonalFitJob({ claimToken = randomUUID(), leaseMinutes = 10, workspaceId = null } = {}) {
  await query(`
    UPDATE angel_personal_fit_jobs
       SET status = 'failed', error_code = 'INTERRUPTED',
           error_message = 'Personal-fit synthesis was interrupted. Retry to run it again.',
           claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
     WHERE status = 'running' AND claim_expires_at IS NOT NULL AND claim_expires_at < NOW()
  `);
  const [row] = await query(`
    UPDATE angel_personal_fit_jobs SET
        status = 'running', attempt_number = attempt_number + 1, claim_token = $1,
        claim_expires_at = NOW() + ($2::int * INTERVAL '1 minute'),
        error_code = NULL, error_message = NULL, updated_at = NOW()
     WHERE id = (
       SELECT j.id FROM angel_personal_fit_jobs j
         JOIN angel_evaluation_contexts c ON c.id = j.context_id
         JOIN council_runs r ON r.id = c.council_run_id
        WHERE j.status = 'waiting' AND r.status = 'completed'
          AND ($3::text IS NULL OR j.workspace_id = $3)
        ORDER BY j.created_at, j.id LIMIT 1
     ) AND status = 'waiting'
 RETURNING *
  `, [claimToken, Math.max(1, Math.round(leaseMinutes)), workspaceId]);
  return jobRow(row);
}

export async function completePersonalFitJob({ jobId, claimToken, result, inputSha256, usage = null }) {
  const [row] = await query(`
    UPDATE angel_personal_fit_jobs
       SET status = 'completed', result = $3::jsonb, input_sha256 = $4, usage_snapshot = $5::jsonb,
           claim_token = NULL, claim_expires_at = NULL, error_code = NULL, error_message = NULL,
           completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND claim_token = $2 AND status = 'running' RETURNING *
  `, [Number(jobId), String(claimToken), JSON.stringify(result), inputSha256 ?? null, usage == null ? null : JSON.stringify(usage)]);
  if (!row) throw new CommandError('PRECONDITION_FAILED', 'This personal-fit job is no longer claimed by this worker.');
  return jobRow(row);
}

export async function failPersonalFitJob({ jobId, claimToken, errorCode = 'FAILED', errorMessage = 'Personal-fit synthesis failed.' }) {
  const [row] = await query(`
    UPDATE angel_personal_fit_jobs
       SET status = 'failed', error_code = $3, error_message = $4,
           claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
     WHERE id = $1 AND claim_token = $2 AND status = 'running' RETURNING *
  `, [Number(jobId), String(claimToken), String(errorCode).slice(0, 64), String(errorMessage).slice(0, 500)]);
  if (!row) throw new CommandError('PRECONDITION_FAILED', 'This personal-fit job is no longer claimed by this worker.');
  return jobRow(row);
}

// failed -> waiting only. Completed results are immutable and never re-run.
export async function retryPersonalFitJob({ workspaceId, contextId }) {
  const workspace = ws(workspaceId);
  const [row] = await query(`
    UPDATE angel_personal_fit_jobs
       SET status = 'waiting', error_code = NULL, error_message = NULL,
           claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
     WHERE context_id = $1 AND workspace_id = $2 AND status = 'failed' RETURNING *
  `, [String(contextId), workspace]);
  if (row) return jobRow(row);
  const current = await getPersonalFitJob({ workspaceId: workspace, contextId });
  if (!current) throw new CommandError('TARGET_NOT_FOUND', 'Personal-fit job not found.');
  throw new CommandError('PRECONDITION_FAILED', `Only a failed personal-fit job can be retried (this one is ${current.status}).`);
}
