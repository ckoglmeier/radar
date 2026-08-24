import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { intakePreview } from '../intake/index.js';
import { stageVaultFile } from '../models/file-vault.js';
import { discardPendingIntake } from '../models/documents.js';
import { authorizeCommandProposal, planCommandProposal, undoCommandReceipt } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-intake-council-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:metadata'];

async function run(name, input, key, authorizationKind = 'explicit_imperative') {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'ask_radar', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `intake-council-command:${key}`,
  });
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [investment] = await query(`
      INSERT INTO investments (company_name, status, invested, source, asset_class)
      VALUES ('Command Intake Co', 'Live', 10000, 'test', 'Direct') RETURNING id
    `);
    const preview = await intakePreview({
      content: Buffer.from('Command Intake Co founder update\nRevenue grew this month.'),
      filename: 'founder-update.txt', mime: 'text/plain',
    });
    const reviewed = await run('intake.commit', {
      previewId: preview.preview_id,
      overrides: { entity_type: 'investment', entity_id: Number(investment.id) },
      startCouncil: false,
    }, 'commit-intake');
    assert.equal(reviewed.status, 'confirmation_required');
    assert.equal((await query('SELECT status FROM pending_intake WHERE id = $1', [preview.preview_id]))[0].status, 'pending');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM documents'))[0].count), 0);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM investment_updates'))[0].count), 0);
    assert.deepEqual(reviewed.proposal.previews[0].warnings, preview.warnings);
    const discardedPreview = await intakePreview({
      content: Buffer.from('Disposable staged update'),
      filename: 'discard.txt', mime: 'text/plain',
    });
    assert.equal((await discardPendingIntake(discardedPreview.preview_id)).id, discardedPreview.preview_id);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM pending_intake WHERE id = $1', [discardedPreview.preview_id]))[0].count), 0);
    const committed = await run('intake.commit', {
      previewId: preview.preview_id,
      overrides: { entity_type: 'investment', entity_id: Number(investment.id) },
      startCouncil: false,
    }, 'commit-intake', 'inline_confirmation');
    assert.equal(committed.status, 'applied');
    assert.equal((await query('SELECT status FROM pending_intake WHERE id = $1', [preview.preview_id]))[0].status, 'committed');
    assert.equal(committed.receipt.undo.available, true);
    await undoCommandReceipt(committed.receipt.id, { actorId: 'test', actorCapabilities });
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM company_updates'))[0].count), 0);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM documents'))[0].count), 0);
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM pending_intake WHERE id = $1', [preview.preview_id]))[0].count), 0);

    const dealPreview = await intakePreview({
      content: Buffer.from('Command New Deal pitch materials'),
      filename: 'new-deal.txt', mime: 'text/plain',
    });
    assert.equal((await run('intake.commit', {
      previewId: dealPreview.preview_id,
      overrides: { type: 'pipeline_invite', company_name: 'Command New Deal' },
      startCouncil: true,
    }, 'commit-and-score-intake')).status, 'confirmation_required');
    assert.equal((await run('intake.commit', {
      previewId: dealPreview.preview_id,
      overrides: { type: 'pipeline_invite', company_name: 'Command New Deal' },
      startCouncil: true,
    }, 'commit-and-score-intake', 'inline_confirmation')).status, 'applied');
    const [intakeRun] = await query(`
      SELECT cr.status FROM council_runs cr
      JOIN pipeline_invites pi ON pi.id = cr.pipeline_invite_id
      WHERE pi.company_name = 'Command New Deal'
    `);
    assert.equal(intakeRun.status, 'queued');

    const stagedVault = await stageVaultFile({
      filename: 'policy.pdf', mime: 'application/pdf', content: Buffer.from('private policy bytes'),
    });
    const vault = await run('document.vault_upload', {
      previewId: stagedVault.id,
      title: 'Life policy', category: 'life_insurance',
      relatedEntityType: 'investment', relatedEntityId: String(investment.id), relatedLabel: 'Command Intake Co',
      ownerName: 'Test Owner', documentDate: '2026-08-24', notes: null,
    }, 'vault-upload');
    assert.equal(vault.status, 'applied');
    assert.equal(Number((await query('SELECT COUNT(*)::int AS count FROM file_vault_entries'))[0].count), 1);

    const [invite] = await query(`
      INSERT INTO pipeline_invites (deal_slug, company_name, status, source)
      VALUES ('command-council', 'Command Council Co', 'invite', 'test') RETURNING id
    `);
    assert.equal((await run('council.start', {
      inviteId: Number(invite.id), fresh: false, runType: 'initial',
    }, 'start-council')).status, 'applied');
    const [initialRun] = await query('SELECT * FROM council_runs WHERE pipeline_invite_id = $1', [invite.id]);
    assert.equal(initialRun.status, 'queued');
    assert.equal((await run('council.cancel', { inviteId: Number(invite.id) }, 'cancel-council')).status, 'applied');
    assert.equal((await query('SELECT status FROM council_runs WHERE id = $1', [initialRun.id]))[0].status, 'cancelled');

    const manifest = [{ document_id: 777, filename: 'scan.pdf', document_kind: 'pdf', extraction_status: 'empty' }];
    await query(`
      UPDATE council_runs
         SET status = 'failed', stage = 'evidence_required', error_code = 'EVIDENCE_REQUIRED',
             source_manifest = $2::jsonb, source_coverage = '{}'::jsonb
       WHERE id = $1
    `, [initialRun.id, JSON.stringify(manifest)]);
    assert.equal((await run('intake.exclude_document', {
      inviteId: Number(invite.id), runId: Number(initialRun.id), documentId: 777,
      reason: 'Scanned duplicate has no extractable text.',
    }, 'exclude-document')).status, 'confirmation_required');
    assert.equal((await run('intake.exclude_document', {
      inviteId: Number(invite.id), runId: Number(initialRun.id), documentId: 777,
      reason: 'Scanned duplicate has no extractable text.',
    }, 'exclude-document', 'inline_confirmation')).status, 'applied');
    const [excludedRun] = await query('SELECT status, source_manifest FROM council_runs WHERE id = $1', [initialRun.id]);
    assert.equal(excludedRun.status, 'queued');
    assert.equal(excludedRun.source_manifest[0].extraction_status, 'excluded_by_user');
    await run('council.cancel', { inviteId: Number(invite.id) }, 'cancel-retry');

    const [evaluation] = await query(`
      INSERT INTO deal_evaluations (pipeline_invite_id, eval_date, total_score, verdict)
      VALUES ($1, '2026-08-24', 33, 'Likely pass') RETURNING id
    `, [invite.id]);
    const [question] = await query(`
      INSERT INTO council_followup_questions
        (pipeline_invite_id, evaluation_id, question_key, question, priority)
      VALUES ($1, $2, 'unit-economics', 'What are current gross margins?', 'critical') RETURNING id
    `, [invite.id, evaluation.id]);
    assert.equal((await run('council.answer_followup', {
      questionId: Number(question.id), answer: 'Gross margin is 54% in the latest cohort.',
    }, 'answer-followup')).status, 'applied');
    assert.equal((await run('council.apply_followups', {
      inviteId: Number(invite.id),
    }, 'apply-followups')).status, 'applied');
    const [followupRun] = await query(`
      SELECT run_type, status FROM council_runs
       WHERE pipeline_invite_id = $1 ORDER BY id DESC LIMIT 1
    `, [invite.id]);
    assert.equal(followupRun.run_type, 'founder_followup');
    assert.equal(followupRun.status, 'queued');
  });
  console.log('Intake/Council commands: intake, vault, start, cancel, evidence waiver, and follow-ups passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
