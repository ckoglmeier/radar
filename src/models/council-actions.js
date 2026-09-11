import { createHash, randomUUID } from 'node:crypto';
import { COUNCIL_POLICY_VERSION } from '../council/evaluate.js';
import { query } from '../db/index.js';
import {
  councilRequestKey,
  createCouncilRun,
  retryCouncilRun,
  updateCouncilRunEvidence,
} from './council-runs.js';

const COUNCIL_EVIDENCE_CONTRACT_VERSION = 2;
const ABORT_REGISTRY_KEY = Symbol.for('radar.council.abort-controllers');

async function activeCouncilRun(inviteId) {
  return (await query(`
    SELECT * FROM council_runs
     WHERE pipeline_invite_id = $1 AND status IN ('queued', 'running')
     ORDER BY started_at DESC, id DESC LIMIT 1
  `, [inviteId]))[0] || null;
}

function documentSetHash(rows) {
  const snapshot = rows.map(row => ({
    id: Number(row.id), sha256: row.sha256, filename: row.filename,
    mime: row.mime, size_bytes: Number(row.size_bytes || 0),
  }));
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export async function queueCouncilRun({
  inviteId,
  runType = 'initial',
  fresh = runType !== 'initial',
  executionId = null,
  reviewMode = 'personalized',
  policyId = process.env.RADAR_COUNCIL_POLICY || 'balanced',
}) {
  if (!['personalized', 'ad_hoc'].includes(reviewMode)) throw new Error('Invalid review mode');
  const active = await activeCouncilRun(inviteId);
  if (active) {
    if (active.review_mode !== reviewMode) throw new Error('A different review mode is already running for this pitch');
    return { status: active.status, run: active };
  }
  const [evaluations, invites, sourceRows, completedRuns] = await Promise.all([
    query(`
      SELECT de.id FROM deal_evaluations de
      LEFT JOIN council_runs cr ON cr.id = de.council_run_id
       WHERE de.pipeline_invite_id = $1 AND COALESCE(de.promotes_to_canonical, TRUE)
       ORDER BY COALESCE(cr.completed_at, de.created_at) DESC, de.id DESC LIMIT 1
    `, [inviteId]),
    query('SELECT * FROM pipeline_invites WHERE id = $1', [inviteId]),
    query(`
      SELECT id, filename, mime, sha256, size_bytes FROM documents
       WHERE entity_type = 'pipeline_invite' AND entity_id = $1::text
       ORDER BY created_at, id
    `, [inviteId]),
    query(`
      SELECT cr.id FROM council_runs cr
      JOIN deal_evaluations de ON de.council_run_id = cr.id
       WHERE cr.pipeline_invite_id = $1 AND cr.status = 'completed'
         AND COALESCE(de.promotes_to_canonical, TRUE)
       ORDER BY cr.completed_at DESC NULLS LAST, de.id DESC LIMIT 1
    `, [inviteId]),
  ]);
  const invite = invites[0];
  if (!invite) throw new Error(`Pipeline invite ${inviteId} was not found`);
  if (reviewMode === 'personalized' && evaluations[0] && !fresh) return { status: 'already_scored', evaluation_id: evaluations[0].id };

  const sourceHash = documentSetHash(sourceRows);
  const request = {
    reviewMode,
    pipelineInviteId: inviteId,
    requestKey: councilRequestKey({
      reviewMode,
      pipelineInviteId: inviteId, sourceHash, modelPolicy: policyId,
      policyVersion: COUNCIL_POLICY_VERSION, runType,
      nonce: fresh ? (executionId || randomUUID()) : '',
    }),
    runType,
    parentRunId: completedRuns[0]?.id || null,
    previousEvaluationId: evaluations[0]?.id || null,
    factsConfirmedAt: new Date(),
    modelAuthorizedAt: new Date(),
  };
  let created = await createCouncilRun(request);
  if (created.deduplicated && ['cancelled', 'failed'].includes(created.run.status)) {
    created = await createCouncilRun({
      ...request,
      requestKey: councilRequestKey({
        reviewMode,
        pipelineInviteId: inviteId, sourceHash, modelPolicy: policyId,
        policyVersion: COUNCIL_POLICY_VERSION, runType,
        nonce: executionId || randomUUID(),
      }),
    });
  }
  return {
    status: created.run.status, run: created.run, deduplicated: created.deduplicated,
    invite_id: inviteId, slug: invite.deal_slug, company_name: invite.company_name,
  };
}

export async function cancelQueuedCouncilRun(inviteId) {
  const run = await activeCouncilRun(inviteId);
  if (!run) return { status: 'not_running' };
  if (run.stage === 'finalizing') return { status: 'too_late', run };
  await query(`
    UPDATE council_runs
       SET status = 'cancelled', stage = 'cancelled', error_message = 'Stopped by user',
           completed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status IN ('queued', 'running')
  `, [run.id]);
  await query(`UPDATE council_run_dispatch SET status = 'cancelled', updated_at = NOW() WHERE run_id = $1`, [run.id]);
  globalThis[ABORT_REGISTRY_KEY]?.get(Number(run.id))?.abort();
  return { status: 'cancelled', run: { ...run, status: 'cancelled', stage: 'cancelled' } };
}

function coverageForManifest(manifest, previous = {}) {
  const count = status => manifest.filter(entry => entry.extraction_status === status).length;
  const included = count('included');
  const excluded = count('excluded_by_user');
  const terminal = new Set(['included', 'empty', 'unsupported', 'extraction_failed', 'excluded_by_user']);
  return {
    ...previous,
    attached: manifest.length,
    supported: manifest.filter(entry => entry.document_kind !== 'binary').length,
    included,
    excluded_by_user: excluded,
    empty: count('empty'),
    unsupported: count('unsupported'),
    failed: count('extraction_failed'),
    extracted_characters: manifest.reduce((sum, entry) => sum + Number(entry.extracted_characters || 0), 0),
    pages: manifest.reduce((sum, entry) => sum + Number(entry.page_count || 0), 0),
    chunks: manifest.reduce((sum, entry) => sum + Number(entry.chunk_count || 0), 0),
    accounted_for: manifest.every(entry => terminal.has(entry.extraction_status)),
    all_included: included === manifest.length,
    scoring_permitted: included + excluded === manifest.length,
    evidence_contract_version: COUNCIL_EVIDENCE_CONTRACT_VERSION,
  };
}

export async function excludeCouncilDocument({
  inviteId, runId, documentId, reason,
  userId = 'local-user', userDisplay = 'you',
}) {
  const exclusionReason = String(reason || '').trim();
  if (exclusionReason.length < 3) throw new Error('Explain why this document should be excluded');
  const [run] = await query(`
    SELECT * FROM council_runs WHERE id = $1 AND pipeline_invite_id = $2
  `, [runId, inviteId]);
  if (!run || run.status !== 'failed' || run.error_code !== 'EVIDENCE_REQUIRED') {
    throw new Error('Only a document blocking a failed evidence check can be excluded');
  }
  const manifest = Array.isArray(run.source_manifest) ? run.source_manifest : [];
  const source = manifest.find(entry => Number(entry.document_id) === Number(documentId));
  if (!source || !['empty', 'unsupported', 'extraction_failed'].includes(source.extraction_status)) {
    throw new Error('This document is not blocking the Council run');
  }
  const nextManifest = manifest.map(entry => Number(entry.document_id) !== Number(documentId) ? entry : {
    ...entry,
    extraction_status: 'excluded_by_user',
    underlying_extraction_status: entry.extraction_status,
    included_in_run: false,
    excluded_by_user_id: userId,
    excluded_by_user_display: userDisplay,
    excluded_at: new Date().toISOString(),
    exclusion_reason: exclusionReason,
  });
  const coverage = coverageForManifest(nextManifest, run.source_coverage || {});
  await updateCouncilRunEvidence(runId, {
    sourceManifest: nextManifest,
    sourceCoverage: coverage,
    evidenceContractVersion: COUNCIL_EVIDENCE_CONTRACT_VERSION,
  });
  const queued = await retryCouncilRun(runId);
  return { status: queued.status, run: { ...queued, source_manifest: nextManifest, source_coverage: coverage } };
}
