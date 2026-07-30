import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  COUNCIL_RUN_TYPES,
  claimNextCouncilRun,
  completeCouncilRun,
  councilRequestKey,
  councilRunEvents,
  createCouncilRun,
  finishCouncilRun,
  heartbeatCouncilRun,
  retryCouncilRun,
  updateCouncilRunEvidence,
} from './council-runs.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-council-runs-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [invite] = await query(
      `INSERT INTO pipeline_invites (deal_slug, company_name, status)
       VALUES ('durable-run', 'Durable Run', 'invite')
       RETURNING id`,
    );
    const requestKey = councilRequestKey({
      pipelineInviteId: invite.id,
      sourceHash: 'source-v1',
      modelPolicy: 'balanced',
      policyVersion: 9,
      runType: 'initial',
    });
    assert.equal(requestKey.length, 64);
    assert.deepEqual(COUNCIL_RUN_TYPES, [
      'initial',
      'founder_followup',
      'research_refresh',
      'policy_refresh',
      'controlled_replay',
      'review_import',
    ]);

    const created = await createCouncilRun({
      pipelineInviteId: invite.id,
      requestKey,
      runType: 'initial',
      factsConfirmedAt: new Date(),
      modelAuthorizedAt: new Date(),
    });
    assert.equal(created.deduplicated, false);
    assert.equal(created.run.status, 'queued');

    const duplicate = await createCouncilRun({
      pipelineInviteId: invite.id,
      requestKey,
      runType: 'initial',
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.run.id, created.run.id);

    await assert.rejects(
      () => createCouncilRun({
        pipelineInviteId: invite.id,
        requestKey: 'legacy-vocabulary',
        runType: 'score',
      }),
      /Invalid Council run type/,
    );

    const claimed = await claimNextCouncilRun({ claimToken: 'claim-1', leaseMinutes: 2 });
    assert.equal(claimed.id, created.run.id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempt_number, 1);

    const heartbeat = await heartbeatCouncilRun(claimed.id, {
      claimToken: 'claim-1',
      phase: 'research',
      modelStarted: true,
    });
    assert.equal(heartbeat.stage, 'research');
    assert.ok(heartbeat.model_started_at);

    await updateCouncilRunEvidence(claimed.id, {
      sourceManifest: [{ document_id: 1, extraction_status: 'included' }],
      sourceCoverage: { accounted_for: true, scoring_permitted: true },
      researchSnapshot: { facts: [{ claim: 'fixture' }] },
      usageSnapshot: { input_tokens: 10 },
      evidenceContractVersion: 1,
    });

    const [evaluation] = await query(
      `INSERT INTO deal_evaluations
         (pipeline_invite_id, company_name, total_score, verdict)
       VALUES ($1, 'Durable Run', 31, 'Likely pass')
       RETURNING id`,
      [invite.id],
    );
    const completed = await completeCouncilRun(claimed.id, {
      evaluationId: evaluation.id,
      runKey: 'run-key',
      evidenceContractVersion: 1,
      manifestHash: 'manifest',
      coverageHash: 'coverage',
      researchHash: 'research',
    });
    assert.equal(completed.run.status, 'completed');
    assert.equal(completed.evaluation.council_run_id, claimed.id);

    const [compatibility] = await query(
      `SELECT evaluation_id FROM council_runs WHERE id = $1`,
      [claimed.id],
    );
    assert.equal(compatibility.evaluation_id, evaluation.id);

    const events = await councilRunEvents(claimed.id);
    assert.deepEqual(events.map(event => event.event_type), [
      'queued',
      'claimed',
      'completed',
    ]);

    const secondRequest = councilRequestKey({
      pipelineInviteId: invite.id,
      sourceHash: 'source-v2',
      modelPolicy: 'balanced',
      policyVersion: 9,
      runType: 'research_refresh',
    });
    const second = await createCouncilRun({
      pipelineInviteId: invite.id,
      requestKey: secondRequest,
      runType: 'research_refresh',
      parentRunId: claimed.id,
      previousEvaluationId: evaluation.id,
    });
    const secondClaim = await claimNextCouncilRun({ claimToken: 'claim-2' });
    assert.equal(secondClaim.id, second.run.id);
    await finishCouncilRun(secondClaim.id, {
      status: 'failed',
      phase: 'research',
      errorCode: 'PROVIDER_ERROR',
      errorMessage: 'Safe failure',
    });
    const retried = await retryCouncilRun(secondClaim.id);
    assert.equal(retried.status, 'queued');
    const thirdClaim = await claimNextCouncilRun({ claimToken: 'claim-3' });
    assert.equal(thirdClaim.id, secondClaim.id);
    assert.equal(thirdClaim.attempt_number, 2);
    const retryEvents = await councilRunEvents(thirdClaim.id);
    assert.deepEqual(retryEvents.map(event => event.event_type), [
      'queued',
      'claimed',
      'failed',
      'retry_authorized',
      'claimed',
    ]);
  });

  console.log('council-runs: durable lifecycle passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
