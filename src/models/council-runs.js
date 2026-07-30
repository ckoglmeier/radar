import { createHash, randomUUID } from 'node:crypto';
import { query as defaultQuery } from '../db/index.js';

export const COUNCIL_RUN_TYPES = Object.freeze([
  'initial',
  'founder_followup',
  'research_refresh',
  'policy_refresh',
  'controlled_replay',
  'review_import',
]);

const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);

function assertPositiveInteger(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return id;
}

function assertRunType(runType) {
  if (!COUNCIL_RUN_TYPES.includes(runType)) {
    throw new Error(`Invalid Council run type: ${runType}`);
  }
  return runType;
}

export function councilRequestKey({
  workspace = 'default',
  pipelineInviteId,
  sourceHash = '',
  modelPolicy = '',
  policyVersion = '',
  runType = 'initial',
  nonce = '',
}) {
  const inviteId = assertPositiveInteger(pipelineInviteId, 'pipelineInviteId');
  assertRunType(runType);
  return createHash('sha256').update(JSON.stringify({
    workspace,
    pipelineInviteId: inviteId,
    sourceHash,
    modelPolicy,
    policyVersion,
    runType,
    nonce,
  })).digest('hex');
}

async function transaction(query, fn) {
  await query('BEGIN');
  try {
    const result = await fn();
    await query('COMMIT');
    return result;
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
}

async function nextEventSequence(query, runId, attemptNumber) {
  const [row] = await query(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
     FROM council_run_events
     WHERE run_id = $1 AND attempt_number = $2`,
    [runId, attemptNumber],
  );
  return Number(row?.next_sequence || 1);
}

export async function appendCouncilRunEvent({
  runId,
  attemptNumber,
  eventType,
  phase = null,
  safeDetail = null,
  outcome = null,
}, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  const attempt = Math.max(0, Number(attemptNumber || 0));
  const sequence = await nextEventSequence(query, id, attempt);
  const [event] = await query(
    `INSERT INTO council_run_events
       (run_id, attempt_number, sequence, event_type, phase, safe_detail, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      id,
      attempt,
      sequence,
      eventType,
      phase,
      safeDetail,
      outcome == null ? null : JSON.stringify(outcome),
    ],
  );
  return event;
}

export async function createCouncilRun({
  pipelineInviteId,
  requestKey,
  runType = 'initial',
  parentRunId = null,
  previousEvaluationId = null,
  factsConfirmedAt = null,
  modelAuthorizedAt = null,
}, deps = {}) {
  const query = deps.query || defaultQuery;
  const inviteId = assertPositiveInteger(pipelineInviteId, 'pipelineInviteId');
  const type = assertRunType(runType);
  if (!String(requestKey || '').trim()) {
    throw new Error('requestKey is required');
  }

  return transaction(query, async () => {
    const existing = await query(
      `SELECT * FROM council_runs WHERE request_key = $1 LIMIT 1`,
      [requestKey],
    );
    if (existing[0]) return { run: existing[0], deduplicated: true };

    const active = await query(
      `SELECT * FROM council_runs
       WHERE pipeline_invite_id = $1 AND status = ANY($2::text[])
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
      [inviteId, ACTIVE_STATUSES],
    );
    if (active[0]) return { run: active[0], deduplicated: true };

    const [run] = await query(
      `INSERT INTO council_runs
         (pipeline_invite_id, previous_evaluation_id, parent_run_id,
          request_key, run_type, status, stage, attempt_number,
          facts_confirmed_at, model_authorized_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', 'queued', 0, $6, $7)
       RETURNING *`,
      [
        inviteId,
        previousEvaluationId,
        parentRunId,
        requestKey,
        type,
        factsConfirmedAt,
        modelAuthorizedAt,
      ],
    );
    await appendCouncilRunEvent({
      runId: run.id,
      attemptNumber: 0,
      eventType: 'queued',
      phase: 'queued',
      safeDetail: 'Council run queued',
    }, { query });
    await query(
      `INSERT INTO council_run_dispatch (run_id, status)
       VALUES ($1, 'pending')`,
      [run.id],
    );
    return { run, deduplicated: false };
  });
}

export async function claimNextCouncilRun(deps = {}) {
  const query = deps.query || defaultQuery;
  const claimToken = deps.claimToken || randomUUID();
  const leaseMinutes = Math.max(1, Number(deps.leaseMinutes || 5));

  return transaction(query, async () => {
    const running = await query(
      `SELECT id FROM council_runs WHERE status = 'running' LIMIT 1`,
    );
    if (running[0]) return null;

    const [candidate] = await query(
      `SELECT cr.*
       FROM council_run_dispatch dispatch
       JOIN council_runs cr ON cr.id = dispatch.run_id
       WHERE dispatch.status = 'pending'
         AND dispatch.available_at <= NOW()
         AND cr.status = 'queued'
       ORDER BY dispatch.available_at ASC, dispatch.id ASC
       LIMIT 1`,
    );
    if (!candidate) return null;

    const dispatchRows = await query(
      `UPDATE council_run_dispatch
       SET status = 'claimed',
           claimed_at = NOW(),
           claim_token = $1,
           delivery_attempts = delivery_attempts + 1,
           updated_at = NOW()
       WHERE run_id = $2 AND status = 'pending'
       RETURNING id`,
      [claimToken, candidate.id],
    );
    if (!dispatchRows[0]) return null;

    const [run] = await query(
      `UPDATE council_runs
       SET status = 'running',
           stage = 'preparing',
           attempt_number = attempt_number + 1,
           claim_token = $1,
           claim_expires_at = NOW() + ($2 * INTERVAL '1 minute'),
           last_heartbeat_at = NOW(),
           updated_at = NOW()
       WHERE id = $3 AND status = 'queued'
       RETURNING *`,
      [claimToken, leaseMinutes, candidate.id],
    );
    if (!run) return null;

    await appendCouncilRunEvent({
      runId: run.id,
      attemptNumber: run.attempt_number,
      eventType: 'claimed',
      phase: 'preparing',
      safeDetail: 'Council worker claimed the run',
    }, { query });
    return run;
  });
}

export async function heartbeatCouncilRun(runId, {
  claimToken,
  phase,
  modelStarted = false,
  leaseMinutes = 5,
} = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  const [run] = await query(
    `UPDATE council_runs
     SET stage = COALESCE($1, stage),
         last_heartbeat_at = NOW(),
         claim_expires_at = NOW() + ($2 * INTERVAL '1 minute'),
         model_started_at = CASE
           WHEN $3 AND model_started_at IS NULL THEN NOW()
           ELSE model_started_at
         END,
         updated_at = NOW()
     WHERE id = $4
       AND status = 'running'
       AND claim_token = $5
     RETURNING *`,
    [phase || null, Math.max(1, Number(leaseMinutes)), Boolean(modelStarted), id, claimToken],
  );
  return run || null;
}

export async function updateCouncilRunEvidence(runId, {
  sourceManifest,
  sourceCoverage,
  researchSnapshot,
  usageSnapshot,
  evidenceContractVersion,
} = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  const [run] = await query(
    `UPDATE council_runs
     SET source_manifest = COALESCE($1::jsonb, source_manifest),
         source_coverage = COALESCE($2::jsonb, source_coverage),
         research_snapshot = COALESCE($3::jsonb, research_snapshot),
         usage_snapshot = COALESCE($4::jsonb, usage_snapshot),
         evidence_contract_version = COALESCE($5, evidence_contract_version),
         updated_at = NOW()
     WHERE id = $6
     RETURNING *`,
    [
      sourceManifest == null ? null : JSON.stringify(sourceManifest),
      sourceCoverage == null ? null : JSON.stringify(sourceCoverage),
      researchSnapshot == null ? null : JSON.stringify(researchSnapshot),
      usageSnapshot == null ? null : JSON.stringify(usageSnapshot),
      evidenceContractVersion ?? null,
      id,
    ],
  );
  return run || null;
}

export async function completeCouncilRun(runId, {
  evaluationId,
  runKey = null,
  evidenceContractVersion = null,
  manifestHash = null,
  coverageHash = null,
  researchHash = null,
  promotesToCanonical = true,
} = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  const evalId = assertPositiveInteger(evaluationId, 'evaluationId');

  return transaction(query, async () => {
    const [evaluation] = await query(
      `UPDATE deal_evaluations
       SET council_run_id = $1,
           promotes_to_canonical = $2,
           council_evidence_contract_version = $3,
           council_source_manifest_sha256 = $4,
           council_source_coverage_sha256 = $5,
           council_research_snapshot_sha256 = $6
       WHERE id = $7
       RETURNING *`,
      [
        id,
        Boolean(promotesToCanonical),
        evidenceContractVersion,
        manifestHash,
        coverageHash,
        researchHash,
        evalId,
      ],
    );
    if (!evaluation) throw new Error(`Evaluation ${evalId} was not found`);

    const [run] = await query(
      `UPDATE council_runs
       SET status = 'completed',
           stage = 'completed',
           evaluation_id = $1,
           run_key = COALESCE($2, run_key),
           completed_at = NOW(),
           claim_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [evalId, runKey, id],
    );
    if (!run) throw new Error(`Council run ${id} was not found`);

    await query(
      `UPDATE council_run_dispatch
       SET status = 'delivered', updated_at = NOW()
       WHERE run_id = $1`,
      [id],
    );
    await appendCouncilRunEvent({
      runId: id,
      attemptNumber: run.attempt_number,
      eventType: 'completed',
      phase: 'completed',
      safeDetail: 'Council evaluation saved',
      outcome: { evaluation_id: evalId },
    }, { query });
    return { run, evaluation };
  });
}

export async function finishCouncilRun(runId, {
  status,
  phase = status,
  errorCode = null,
  errorMessage = null,
} = {}, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  if (!['failed', 'stalled', 'interrupted', 'cancelled'].includes(status)) {
    throw new Error(`Invalid terminal Council status: ${status}`);
  }
  return transaction(query, async () => {
    const [run] = await query(
      `UPDATE council_runs
       SET status = $1,
           stage = $2,
           error_code = $3,
           error_message = $4,
           completed_at = NOW(),
           claim_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [status, phase, errorCode, errorMessage, id],
    );
    if (!run) throw new Error(`Council run ${id} was not found`);
    await query(
      `UPDATE council_run_dispatch
       SET status = CASE WHEN $1 = 'cancelled' THEN 'cancelled' ELSE 'delivered' END,
           updated_at = NOW()
       WHERE run_id = $2`,
      [status, id],
    );
    await appendCouncilRunEvent({
      runId: id,
      attemptNumber: run.attempt_number,
      eventType: status,
      phase,
      safeDetail: errorMessage,
      outcome: errorCode ? { error_code: errorCode } : null,
    }, { query });
    return run;
  });
}

export async function retryCouncilRun(runId, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  return transaction(query, async () => {
    const [run] = await query(
      `UPDATE council_runs
       SET status = 'queued',
           stage = 'queued',
           error_code = NULL,
           error_message = NULL,
           completed_at = NULL,
           claim_token = NULL,
           claim_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1
         AND status IN ('failed', 'stalled', 'interrupted')
       RETURNING *`,
      [id],
    );
    if (!run) throw new Error('Only failed, stalled, or interrupted runs can be retried');
    await query(
      `UPDATE council_run_dispatch
       SET status = 'pending',
           available_at = NOW(),
           claimed_at = NULL,
           claim_token = NULL,
           updated_at = NOW()
       WHERE run_id = $1`,
      [id],
    );
    await appendCouncilRunEvent({
      runId: id,
      attemptNumber: run.attempt_number,
      eventType: 'retry_authorized',
      phase: 'queued',
      safeDetail: 'Council retry authorized',
    }, { query });
    return run;
  });
}

export async function councilRunEvents(runId, deps = {}) {
  const query = deps.query || defaultQuery;
  const id = assertPositiveInteger(runId, 'runId');
  return query(
    `SELECT * FROM council_run_events
     WHERE run_id = $1
     ORDER BY attempt_number ASC, sequence ASC`,
    [id],
  );
}
