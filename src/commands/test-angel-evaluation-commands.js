import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { newItemId } from '../angel/personal-context.js';
import { currentBusinessPreferenceList, getEvaluationDraft, getPersonalFitJob } from '../models/angel-evaluations.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-angel-commands-'));
const actorCapabilities = ['portfolio:apply:metadata'];
let counter = 0;

async function run(name, input) {
  counter += 1;
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: name, idempotencyKey: `angel-test:${counter}`,
  });
  const outcome = await authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind: 'manual_ui', actorType: 'user', actorId: 'test', actorCapabilities,
  });
  assert.equal(outcome.status, 'applied', JSON.stringify(outcome).slice(0, 400));
  return outcome.receipt.commands[0].result;
}
const rejection = async (promise, code) => {
  await assert.rejects(promise, error => (error.code === code ? true : (console.error(error), false)));
};
const item = (label, extra = {}) => ({ id: newItemId('b'), label, note: null, must_have: false, ...extra });
const thesisItem = name => ({ id: newItemId('i'), label: name, note: null, source: { kind: 'thesis', lens_thesis_id: `t-${name}`, thesis_name: name, thesis_belief: 'b' } });
const confirmedState = (inviteId, overrides = {}) => ({
  step: 'review',
  company: { name: 'Cmd Deal', url: null, pipeline_invite_id: inviteId, deal_slug: 'cmd-deal' },
  interests: { mode: 'custom', items: [thesisItem('Climate')], confirmed: true },
  business: { mode: 'custom', items: [item('Recurring revenue', { must_have: true })], origin: null, confirmed: true },
  framework: { review_mode: 'ad_hoc', framework_version_id: null, framework_label: null },
  ...overrides,
});

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const [invite] = await query(`INSERT INTO pipeline_invites (deal_slug, company_name, status) VALUES ('cmd-deal', 'Cmd Deal', 'invite') RETURNING id`);
    const [other] = await query(`INSERT INTO pipeline_invites (deal_slug, company_name, status) VALUES ('other-deal', 'Other Deal', 'invite') RETURNING id`);
    const inviteId = Number(invite.id);

    // Save draft: create, update, stale.
    const created = await run('angel_evaluation.save_draft', { inviteId, state: { step: 'deal' } });
    // Content-identical create requests replay one receipt unless each carries its own requestId.
    const replayA = await run('angel_evaluation.save_draft', { inviteId, state: {}, requestId: 'req-a' });
    const replayB = await run('angel_evaluation.save_draft', { inviteId, state: {}, requestId: 'req-b' });
    assert.notEqual(replayA.id, replayB.id, 'separate requests create separate drafts');
    assert.equal(created.revision, 1);
    const updated = await run('angel_evaluation.save_draft', { draftId: created.id, expectedRevision: 1, state: confirmedState(inviteId) });
    assert.equal(updated.revision, 2);
    await rejection(run('angel_evaluation.save_draft', { draftId: created.id, expectedRevision: 1, state: {} }), 'STALE_DRAFT');
    await rejection(run('angel_evaluation.save_draft', { draftId: created.id, state: {} }), 'STALE_DRAFT');
    // Wrong workspace is indistinguishable from missing.
    await rejection(run('angel_evaluation.save_draft', { workspaceId: 'someone-else', draftId: created.id, expectedRevision: 2, state: {} }), 'TARGET_NOT_FOUND');
    await rejection(run('angel_evaluation.submit', { workspaceId: 'someone-else', draftId: created.id, expectedRevision: 2 }), 'TARGET_NOT_FOUND');

    // Business list: empty stays empty, cap, no draft coupling.
    await run('angel_preferences.save_business', { items: [] });
    assert.deepEqual((await currentBusinessPreferenceList({ workspaceId: 'local' })).items, []);
    await rejection(run('angel_preferences.save_business', { items: Array.from({ length: 7 }, (_, i) => item(`P${i}`)) }), 'COMMAND_VALIDATION_FAILED');

    // Submit refuses incomplete drafts before touching runs.
    const incomplete = await run('angel_evaluation.save_draft', { inviteId, state: { step: 'review', framework: confirmedState(inviteId).framework } });
    await rejection(run('angel_evaluation.submit', { draftId: incomplete.id, expectedRevision: 1 }), 'PRECONDITION_FAILED');
    const noInvite = await run('angel_evaluation.save_draft', { state: { ...confirmedState(inviteId), company: { name: 'X' } } });
    await rejection(run('angel_evaluation.submit', { draftId: noInvite.id, expectedRevision: 1 }), 'PRECONDITION_FAILED');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n), 0);
    await rejection(run('angel_evaluation.submit', { draftId: created.id, expectedRevision: 1 }), 'STALE_DRAFT');

    // Submit: one run, context attached, job waiting, draft submitted; list saved only on opt-in.
    await run('angel_evaluation.save_draft', { draftId: created.id, expectedRevision: 2, state: { ...confirmedState(inviteId), save_business_preferences: true } });
    const submitted = await run('angel_evaluation.submit', { draftId: created.id, expectedRevision: 3 });
    assert.ok(submitted.context_id && submitted.run_id);
    assert.equal(submitted.personal_fit_status, 'waiting');
    assert.equal(submitted.slug, 'cmd-deal');
    const [runRow] = await query('SELECT * FROM council_runs WHERE id = $1', [submitted.run_id]);
    assert.equal(runRow.review_mode, 'ad_hoc');
    assert.equal(runRow.run_type, 'initial');
    assert.equal((await getEvaluationDraft({ workspaceId: 'local', draftId: created.id })).status, 'submitted');
    assert.deepEqual((await currentBusinessPreferenceList({ workspaceId: 'local' })).items.map(i => i.label), ['Recurring revenue']);
    assert.equal((await getPersonalFitJob({ workspaceId: 'local', contextId: submitted.context_id })).status, 'waiting');

    // Re-submission: same context and run, no new run, no new list version.
    const versionBefore = (await currentBusinessPreferenceList({ workspaceId: 'local' })).version;
    const again = await run('angel_evaluation.submit', { draftId: created.id, expectedRevision: 3 });
    assert.equal(again.context_id, submitted.context_id);
    assert.equal(again.run_id, submitted.run_id);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n), 1);
    assert.equal((await currentBusinessPreferenceList({ workspaceId: 'local' })).version, versionBefore);
    await rejection(run('angel_evaluation.discard_draft', { draftId: created.id }), 'PRECONDITION_FAILED');

    // Another run is active for the deal: a different submission is refused and writes nothing.
    const second = await run('angel_evaluation.save_draft', { inviteId, state: confirmedState(inviteId, { interests: { mode: 'unspecified', items: [], confirmed: true } }) });
    await rejection(run('angel_evaluation.submit', { draftId: second.id, expectedRevision: 1 }), 'PRECONDITION_FAILED');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM angel_evaluation_contexts'))[0].n), 1);

    // After the run finishes, a new submission gets its own run (distinct nonce).
    await query(`UPDATE council_runs SET status = 'completed', stage = 'completed' WHERE id = $1`, [submitted.run_id]);
    const next = await run('angel_evaluation.submit', { draftId: second.id, expectedRevision: 1 });
    assert.notEqual(next.run_id, submitted.run_id);
    assert.equal(next.personal_fit_status, 'waiting');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n), 2);

    // A deal with no interests and no business is a general assessment: no personal-fit job work.
    await query(`UPDATE council_runs SET status = 'completed', stage = 'completed' WHERE id = $1`, [next.run_id]);
    const general = await run('angel_evaluation.save_draft', { inviteId, state: confirmedState(inviteId, {
      interests: { mode: 'unspecified', items: [], confirmed: true },
      business: { mode: 'unspecified', items: [], origin: null, confirmed: true },
    }) });
    const generalSubmit = await run('angel_evaluation.submit', { draftId: general.id, expectedRevision: 1 });
    assert.equal(generalSubmit.personal_fit_status, 'not_applicable');
    await query(`UPDATE council_runs SET status = 'completed', stage = 'completed' WHERE id = $1`, [generalSubmit.run_id]);

    // Personalized with a canonical evaluation uses a fresh research_refresh run.
    await query(`INSERT INTO deal_evaluations (pipeline_invite_id, company_name) VALUES ($1, 'Cmd Deal')`, [inviteId]).catch(async () => {
      await query(`INSERT INTO deal_evaluations (pipeline_invite_id) VALUES ($1)`, [inviteId]);
    });
    const personalized = await run('angel_evaluation.save_draft', { inviteId, state: confirmedState(inviteId, {
      framework: { review_mode: 'personalized', framework_version_id: null, framework_label: 'Framework' },
    }) });
    const personalizedSubmit = await run('angel_evaluation.submit', { draftId: personalized.id, expectedRevision: 1 });
    const [personalizedRun] = await query('SELECT * FROM council_runs WHERE id = $1', [personalizedSubmit.run_id]);
    assert.equal(personalizedRun.run_type, 'research_refresh');
    assert.equal(personalizedRun.review_mode, 'personalized');
    await query(`UPDATE council_runs SET status = 'completed', stage = 'completed' WHERE id = $1`, [personalizedSubmit.run_id]);

    // Retry only from failed, and only the job.
    await rejection(run('angel_evaluation.retry_personal_fit', { contextId: submitted.context_id }), 'PRECONDITION_FAILED');
    await query(`UPDATE angel_personal_fit_jobs SET status = 'failed', error_code = 'X' WHERE context_id = $1`, [submitted.context_id]);
    const runsBefore = Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n);
    await run('angel_evaluation.retry_personal_fit', { contextId: submitted.context_id });
    assert.equal((await getPersonalFitJob({ workspaceId: 'local', contextId: submitted.context_id })).status, 'waiting');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS n FROM council_runs'))[0].n), runsBefore);
    await rejection(run('angel_evaluation.retry_personal_fit', { workspaceId: 'someone-else', contextId: submitted.context_id }), 'TARGET_NOT_FOUND');

    // Discard.
    const throwaway = await run('angel_evaluation.save_draft', { state: {} });
    assert.equal((await run('angel_evaluation.discard_draft', { draftId: throwaway.id })).status, 'discarded');
    assert.ok(other);
  });
  console.log('angel evaluation command tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
