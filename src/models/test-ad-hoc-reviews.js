import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant, closeDb, query } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { createCouncilRun, councilRequestKey } from './council-runs.js';
import { saveAdHocReview, adHocReviewsForInvite, completeAdHocRun } from './ad-hoc-reviews.js';

const root = mkdtempSync(join(tmpdir(), 'radar-ad-hoc-'));
const report = { company: 'Synthetic', summary: { text: 'Evidence is missing.', evidence: 'unknown', source_ids: [] }, strengths: [], risks: [], open_questions: ['Who is the customer?'], deal_terms: [] };
let backup;
let inviteId;
try {
  await withTenant(`file:${join(root, 'original')}`, async () => {
    await runMigrations();
    const [invite] = await query("INSERT INTO pipeline_invites (deal_slug, company_name, status) VALUES ('synthetic', 'Synthetic', 'new') RETURNING id");
    inviteId = invite.id;
    const common = { pipelineInviteId: inviteId };
    assert.notEqual(councilRequestKey(common), councilRequestKey({ ...common, reviewMode: 'ad_hoc' }));
    const { run } = await createCouncilRun({ ...common, requestKey: 'ad-hoc-test', reviewMode: 'ad_hoc' });
    assert.equal(run.review_mode, 'ad_hoc');
    await assert.rejects(createCouncilRun({ ...common, requestKey: 'ad-hoc-test' }), /different review mode/);
    await assert.rejects(createCouncilRun({ ...common, requestKey: 'another' }), /different review mode/);
    await assert.rejects(saveAdHocReview({ runId: run.id, report, sources: [] }), /not running/);
    await query("UPDATE council_runs SET status = 'running' WHERE id = $1", [run.id]);
    const saved = await saveAdHocReview({ runId: run.id, report, sources: [], usage: { totalCostUsd: null }, provenance: { reviewMode: 'ad_hoc' } });
    assert.equal((await saveAdHocReview({ runId: run.id, report, sources: [] })).id, saved.id);
    await assert.rejects(saveAdHocReview({ runId: run.id, report: { ...report, company: 'Changed' }, sources: [] }), /cannot be overwritten/);
    await query("UPDATE council_runs SET claim_token = 'synthetic-claim' WHERE id = $1", [run.id]);
    await assert.rejects(completeAdHocRun({ runId: run.id, claimToken: 'stale' }), /no longer belongs/);
    await completeAdHocRun({ runId: run.id, claimToken: 'synthetic-claim' });
    assert.equal((await completeAdHocRun({ runId: run.id, claimToken: 'synthetic-claim' })).id, saved.id);
    const [completed] = await query('SELECT * FROM council_runs WHERE id = $1', [run.id]);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.usage_snapshot, { totalCostUsd: null });
    assert.equal(completed.evaluation_id, null);
    const personal = await createCouncilRun({ ...common, requestKey: 'personal-test' });
    assert.equal(personal.run.review_mode, 'personalized');
    await assert.rejects(saveAdHocReview({ runId: personal.run.id, report, sources: [] }), /ad hoc run/);
    assert.equal((await query('SELECT * FROM deal_evaluations')).length, 0);
    backup = await createDatabaseBackupPayload();
  });
  await withTenant(`file:${join(root, 'restored')}`, async () => {
    await runMigrations();
    await restoreDatabase({ content: backup.content });
    const reviews = await adHocReviewsForInvite(inviteId);
    assert.equal(reviews.length, 1);
    assert.deepEqual(reviews[0].artifact.report, report);
    assert.equal(reviews[0].artifact.review_mode, 'ad_hoc');
  });
  console.log('Ad hoc persistence: queued mode, mode conflicts, immutable/idempotent save, and fresh-database restore passed');
} finally {
  await closeDb();
  rmSync(root, { recursive: true, force: true });
}
