import { query, withAtomicWrite } from '../db/index.js';
import { createAdHocReviewArtifact } from '../council/ad-hoc-review.js';
import { appendCouncilRunEvent } from './council-runs.js';

export async function saveAdHocReview({ runId, report, sources, claimToken = null, usage = null, provenance = null }) {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('A valid run ID is required');
  const artifact = createAdHocReviewArtifact(report, sources);
  return withAtomicWrite(async () => {
    const [run] = await query('SELECT * FROM council_runs WHERE id = $1 FOR UPDATE', [runId]);
    if (!run || run.review_mode !== 'ad_hoc') throw new Error('An ad hoc run is required');
    if (run.claim_token && run.claim_token !== claimToken) throw new Error('Ad hoc claim no longer belongs to this worker');
    const [existing] = await query('SELECT * FROM ad_hoc_reviews WHERE council_run_id = $1', [runId]);
    if (existing) {
      const [same] = await query('SELECT id FROM ad_hoc_reviews WHERE id = $1 AND artifact = $2::jsonb', [existing.id, JSON.stringify(artifact)]);
      if (!same) throw new Error('Saved reviews cannot be overwritten; start a new review');
      return existing;
    }
    if (run.status !== 'running') throw new Error('The review is not running');
    const [saved] = await query(
      'INSERT INTO ad_hoc_reviews (council_run_id, contract_version, artifact) VALUES ($1, $2, $3::jsonb) RETURNING *',
      [runId, artifact.contract_version, JSON.stringify(artifact)],
    );
    await query('UPDATE council_runs SET usage_snapshot = $2::jsonb, research_snapshot = $3::jsonb WHERE id = $1',
      [runId, JSON.stringify(usage), JSON.stringify(provenance)]);
    return saved;
  });
}

export async function adHocReviewsForInvite(inviteId) {
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) throw new Error('A valid invite ID is required');
  return query(`SELECT ar.* FROM ad_hoc_reviews ar JOIN council_runs cr ON cr.id = ar.council_run_id
    WHERE cr.pipeline_invite_id = $1 ORDER BY ar.created_at DESC, ar.id DESC`, [inviteId]);
}

// Completion is separate from report storage so a restart can finish an already
// saved report without buying another analysis. A stale worker cannot complete it.
export async function completeAdHocRun({ runId, claimToken, usage, provenance }) {
  if (!Number.isSafeInteger(runId) || runId <= 0 || !claimToken) throw new Error('Run and claim token are required');
  return withAtomicWrite(async () => {
    const [run] = await query('SELECT * FROM council_runs WHERE id = $1 FOR UPDATE', [runId]);
    if (!run || run.review_mode !== 'ad_hoc' || run.claim_token !== claimToken) throw new Error('Ad hoc claim no longer belongs to this worker');
    const [review] = await query('SELECT * FROM ad_hoc_reviews WHERE council_run_id = $1', [runId]);
    if (!review) throw new Error('Save the ad hoc report before completing the run');
    if (run.status === 'completed') return review;
    if (run.status !== 'running') throw new Error('Ad hoc run is no longer running');
    await query(`UPDATE council_runs SET status = 'completed', stage = 'completed',
      usage_snapshot = $2::jsonb, research_snapshot = $3::jsonb,
      completed_at = NOW(), claim_expires_at = NULL, updated_at = NOW()
      WHERE id = $1`, [runId, JSON.stringify(usage === undefined ? run.usage_snapshot : usage), JSON.stringify(provenance === undefined ? run.research_snapshot : provenance)]);
    await query("UPDATE council_run_dispatch SET status = 'delivered', updated_at = NOW() WHERE run_id = $1", [runId]);
    await appendCouncilRunEvent({ runId, attemptNumber: run.attempt_number, eventType: 'completed', phase: 'completed', outcome: { ad_hoc_review_id: review.id } });
    return review;
  });
}
