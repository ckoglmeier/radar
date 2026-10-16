import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { buildEvaluationSnapshot, newItemId } from '../angel/personal-context.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import {
  attachContextRun, claimNextPersonalFitJob, completePersonalFitJob, contextForRun, contextsForInvite,
  createEvaluationContext, createEvaluationDraft, createPersonalFitJob, currentBusinessPreferenceList,
  discardEvaluationDraft, failPersonalFitJob, getEvaluationContext, getEvaluationDraft, retryPersonalFitJob,
  saveBusinessPreferenceList, saveEvaluationDraft,
} from './angel-evaluations.js';

const A = 'ws-a';
const B = 'ws-b';
const code = expected => error => error.code === expected;
const biz = (label, extra = {}) => ({ id: newItemId('b'), label, note: null, must_have: false, ...extra });
const thesis = (n, id = newItemId('i')) => ({ id, label: n, note: null, source: { kind: 'thesis', lens_thesis_id: `t-${n}`, thesis_name: n, thesis_belief: 'belief' } });

function snapshotFor(inviteId, { interests = [], business = [], name = 'Acme' } = {}) {
  return buildEvaluationSnapshot({
    company: { name, url: null, pipeline_invite_id: inviteId, deal_slug: 'acme' },
    interests: { mode: interests.length ? 'custom' : 'unspecified', items: interests },
    business: { mode: business.length ? 'custom' : 'unspecified', items: business, origin: null },
    facts: {},
    framework: { review_mode: 'ad_hoc', framework_version_id: null, framework_label: null },
  }).snapshot;
}

const scratch = mkdtempSync(join(tmpdir(), 'radar-angel-evaluations-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const [invite] = await query(`INSERT INTO pipeline_invites (deal_slug, company_name, status) VALUES ('acme', 'Acme', 'invite') RETURNING id`);
    const run = async (status = 'queued', key = `k-${Math.random()}`) => (await query(`
      INSERT INTO council_runs (pipeline_invite_id, request_key, run_type, status, stage, review_mode)
      VALUES ($1, $2, 'initial', $3, $3, 'ad_hoc') RETURNING id`, [invite.id, key, status]))[0];

    // Workspace id is mandatory.
    await assert.rejects(currentBusinessPreferenceList({}), code('WORKSPACE_REQUIRED'));

    // Business list: versions, cap, empty stays empty, evaluation edits do not touch it.
    assert.equal(await currentBusinessPreferenceList({ workspaceId: A }), null);
    const six = Array.from({ length: 6 }, (_, i) => biz(`Pref ${i}`));
    const v1 = await saveBusinessPreferenceList({ workspaceId: A, items: six });
    assert.equal(v1.version, 1);
    assert.deepEqual(v1.items.map(i => i.label), six.map(i => i.label));
    await assert.rejects(saveBusinessPreferenceList({ workspaceId: A, items: [...six, biz('Seventh')] }), code('INVALID_PERSONAL_CONTEXT'));
    assert.equal((await currentBusinessPreferenceList({ workspaceId: A })).version, 1);
    const v2 = await saveBusinessPreferenceList({ workspaceId: A, items: [] });
    assert.equal(v2.version, 2);
    assert.deepEqual((await currentBusinessPreferenceList({ workspaceId: A })).items, []);
    assert.equal(await currentBusinessPreferenceList({ workspaceId: B }), null);

    // Drafts: optimistic revision, owner isolation.
    const draft = await createEvaluationDraft({ workspaceId: A, inviteId: Number(invite.id), state: { step: 'deal' } });
    assert.equal(draft.revision, 1);
    assert.equal(draft.state.company.pipeline_invite_id, Number(invite.id));
    assert.equal(await getEvaluationDraft({ workspaceId: B, draftId: draft.id }), null);
    await assert.rejects(saveEvaluationDraft({ workspaceId: B, draftId: draft.id, expectedRevision: 1, state: {} }), code('TARGET_NOT_FOUND'));
    await assert.rejects(discardEvaluationDraft({ workspaceId: B, draftId: draft.id }), code('TARGET_NOT_FOUND'));
    const saved = await saveEvaluationDraft({ workspaceId: A, draftId: draft.id, expectedRevision: 1, state: { step: 'interests', company: draft.state.company } });
    assert.equal(saved.revision, 2);
    await assert.rejects(saveEvaluationDraft({ workspaceId: A, draftId: draft.id, expectedRevision: 1, state: {} }), code('STALE_DRAFT'));
    assert.equal((await getEvaluationDraft({ workspaceId: A, draftId: draft.id })).state.step, 'interests');
    // Evaluation-only edits to the draft's business items leave the saved list alone.
    await saveEvaluationDraft({ workspaceId: A, draftId: draft.id, expectedRevision: 2, state: {
      business: { mode: 'custom', items: [biz('Only here')], origin: null, confirmed: true }, company: draft.state.company,
    } });
    assert.deepEqual((await currentBusinessPreferenceList({ workspaceId: A })).items, []);
    await assert.rejects(createEvaluationDraft({ workspaceId: A, inviteId: 999999, state: {} }), code('TARGET_NOT_FOUND'));
    const dropped = await createEvaluationDraft({ workspaceId: A, state: {} });
    assert.equal((await discardEvaluationDraft({ workspaceId: A, draftId: dropped.id })).status, 'discarded');
    await assert.rejects(saveEvaluationDraft({ workspaceId: A, draftId: dropped.id, expectedRevision: 1, state: {} }), code('PRECONDITION_FAILED'));

    // Contexts: idempotent per (draft, revision), immutable, set-once run.
    const snapshot = snapshotFor(Number(invite.id), { interests: [thesis('Climate')], business: [biz('Recurring revenue')] });
    const current = await getEvaluationDraft({ workspaceId: A, draftId: draft.id });
    await assert.rejects(createEvaluationContext({ workspaceId: B, draftId: draft.id, draftRevision: current.revision, snapshot }), code('TARGET_NOT_FOUND'));
    const context = await createEvaluationContext({ workspaceId: A, draftId: draft.id, draftRevision: current.revision, snapshot });
    const again = await createEvaluationContext({ workspaceId: A, draftId: draft.id, draftRevision: current.revision, snapshot: snapshotFor(Number(invite.id)) });
    assert.equal(again.id, context.id);
    assert.deepEqual(again.snapshot, snapshot);
    assert.equal(await getEvaluationContext({ workspaceId: B, contextId: context.id }), null);
    const before = JSON.stringify((await getEvaluationContext({ workspaceId: A, contextId: context.id })).snapshot);
    await assert.rejects(query(`UPDATE angel_evaluation_contexts SET snapshot = '{}'::jsonb WHERE id = $1`, [context.id]), /immutable/);
    await assert.rejects(query(`UPDATE angel_evaluation_contexts SET snapshot_sha256 = 'x' WHERE id = $1`, [context.id]), /immutable/);
    // Rename a thesis and add a new HOW list version: the snapshot is byte-stable.
    await query(`INSERT INTO theses (name, belief, status) VALUES ('Climate', 'x', 'active') ON CONFLICT DO NOTHING`).catch(() => {});
    await query(`UPDATE theses SET name = 'Renamed' WHERE name = 'Climate'`).catch(() => {});
    await saveBusinessPreferenceList({ workspaceId: A, items: [biz('Brand new')] });
    assert.equal(JSON.stringify((await getEvaluationContext({ workspaceId: A, contextId: context.id })).snapshot), before);

    const r1 = await run('queued');
    const attached = await attachContextRun({ workspaceId: A, contextId: context.id, runId: r1.id });
    assert.equal(attached.council_run_id, Number(r1.id));
    assert.equal((await attachContextRun({ workspaceId: A, contextId: context.id, runId: r1.id })).council_run_id, Number(r1.id));
    const r2 = await run('failed');
    await assert.rejects(attachContextRun({ workspaceId: A, contextId: context.id, runId: r2.id }), code('PRECONDITION_FAILED'));
    await assert.rejects(attachContextRun({ workspaceId: B, contextId: context.id, runId: r2.id }), code('TARGET_NOT_FOUND'));
    assert.equal((await contextForRun({ workspaceId: A, runId: r1.id })).id, context.id);
    assert.equal(await contextForRun({ workspaceId: B, runId: r1.id }), null);
    assert.equal((await contextsForInvite({ workspaceId: A, inviteId: invite.id })).length, 1);
    assert.equal((await contextsForInvite({ workspaceId: B, inviteId: invite.id })).length, 0);

    // Personal-fit jobs.
    const job = await createPersonalFitJob({ workspaceId: A, contextId: context.id });
    assert.equal(job.status, 'waiting');
    assert.equal((await createPersonalFitJob({ workspaceId: A, contextId: context.id })).id, job.id);
    await assert.rejects(createPersonalFitJob({ workspaceId: B, contextId: context.id }), code('TARGET_NOT_FOUND'));
    assert.equal(await claimNextPersonalFitJob({ claimToken: 't0' }), null, 'waits for the completed run');
    await query(`UPDATE council_runs SET status = 'completed' WHERE id = $1`, [r1.id]);
    const claimed = await claimNextPersonalFitJob({ claimToken: 't1', leaseMinutes: 5 });
    assert.equal(claimed.id, job.id);
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.attempt_number, 1);
    assert.equal(await claimNextPersonalFitJob({ claimToken: 't2' }), null);
    await assert.rejects(completePersonalFitJob({ jobId: job.id, claimToken: 'wrong', result: {}, inputSha256: 'h' }), code('PRECONDITION_FAILED'));
    await failPersonalFitJob({ jobId: job.id, claimToken: 't1', errorCode: 'MODEL', errorMessage: 'boom' });
    assert.equal((await retryPersonalFitJob({ workspaceId: A, contextId: context.id })).status, 'waiting');
    await assert.rejects(retryPersonalFitJob({ workspaceId: A, contextId: context.id }), code('PRECONDITION_FAILED'));
    await assert.rejects(retryPersonalFitJob({ workspaceId: B, contextId: context.id }), code('TARGET_NOT_FOUND'));

    // Lease expiry marks INTERRUPTED (retryable) rather than completing.
    await claimNextPersonalFitJob({ claimToken: 't3', leaseMinutes: 5 });
    await query(`UPDATE angel_personal_fit_jobs SET claim_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [job.id]);
    assert.equal(await claimNextPersonalFitJob({ claimToken: 't4' }), null);
    const interrupted = (await query('SELECT * FROM angel_personal_fit_jobs WHERE id = $1', [job.id]))[0];
    assert.equal(interrupted.status, 'failed');
    assert.equal(interrupted.error_code, 'INTERRUPTED');
    await retryPersonalFitJob({ workspaceId: A, contextId: context.id });
    const third = await claimNextPersonalFitJob({ claimToken: 't5' });
    const result = { contract_version: 1, interests: { status: 'assessed', readings: [] } };
    const done = await completePersonalFitJob({ jobId: third.id, claimToken: 't5', result, inputSha256: 'abc', usage: { tokens: 3 } });
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.result, result);
    await assert.rejects(query(`UPDATE angel_personal_fit_jobs SET result = '{}'::jsonb WHERE id = $1`, [job.id]), /immutable/);
    await assert.rejects(retryPersonalFitJob({ workspaceId: A, contextId: context.id }), code('PRECONDITION_FAILED'));

    // Both dimensions unspecified: not_applicable, never claimed.
    const draft2 = await createEvaluationDraft({ workspaceId: A, inviteId: Number(invite.id), state: {} });
    const ctx2 = await createEvaluationContext({ workspaceId: A, draftId: draft2.id, draftRevision: 1, snapshot: snapshotFor(Number(invite.id)) });
    const r3 = await run('completed');
    await attachContextRun({ workspaceId: A, contextId: ctx2.id, runId: r3.id });
    assert.equal((await createPersonalFitJob({ workspaceId: A, contextId: ctx2.id })).status, 'not_applicable');
    assert.equal(await claimNextPersonalFitJob({ claimToken: 't6' }), null);
    await assert.rejects(retryPersonalFitJob({ workspaceId: A, contextId: ctx2.id }), code('PRECONDITION_FAILED'));

    // Backup/restore round trip includes the new tables.
    const payload = await createDatabaseBackupPayload();
    const names = payload.tables.map(t => t.table);
    for (const table of ['angel_business_preference_lists', 'angel_evaluation_drafts', 'angel_evaluation_contexts', 'angel_personal_fit_jobs']) {
      assert.ok(names.includes(table), table);
      assert.ok(names.indexOf(table) > names.indexOf('council_runs'));
    }
    assert.ok(names.indexOf('angel_evaluation_contexts') > names.indexOf('angel_evaluation_drafts'));
    assert.ok(names.indexOf('angel_personal_fit_jobs') > names.indexOf('angel_evaluation_contexts'));
    const counts = async () => (await query(`SELECT (SELECT COUNT(*)::int FROM angel_evaluation_contexts) c, (SELECT COUNT(*)::int FROM angel_personal_fit_jobs) j, (SELECT COUNT(*)::int FROM angel_business_preference_lists) l, (SELECT COUNT(*)::int FROM angel_evaluation_drafts) d`))[0];
    const countsBefore = await counts();
    await restoreDatabase({ content: payload.content });
    assert.deepEqual(await counts(), countsBefore);
    const restored = await getEvaluationContext({ workspaceId: A, contextId: context.id });
    assert.equal(restored.council_run_id, Number(r1.id));
    assert.equal((await query('SELECT result FROM angel_personal_fit_jobs WHERE id = $1', [job.id]))[0].result.contract_version, 1);
    await assert.rejects(query(`UPDATE angel_evaluation_contexts SET snapshot = '{}'::jsonb WHERE id = $1`, [context.id]), /immutable/);

    // An existing database (with prior pipeline data) that predates migration 088.
    await query('DROP TABLE angel_personal_fit_jobs, angel_evaluation_contexts, angel_evaluation_drafts, angel_business_preference_lists');
    await query('DELETE FROM schema_migrations WHERE version = 88');
    const invitesBefore = Number((await query('SELECT COUNT(*)::int AS n FROM pipeline_invites'))[0].n);
    const runsBefore = Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n);
    const migrated = await runMigrations();
    assert.equal(migrated.applied, 1);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM pipeline_invites'))[0].n), invitesBefore);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n), runsBefore);
    assert.equal(await currentBusinessPreferenceList({ workspaceId: A }), null);
    const legacyDraft = await createEvaluationDraft({ workspaceId: A, inviteId: Number(invite.id), state: {} });
    assert.equal(legacyDraft.revision, 1);
    assert.deepEqual(await contextsForInvite({ workspaceId: A, inviteId: invite.id }), []);
  });
  console.log('angel evaluation model tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
