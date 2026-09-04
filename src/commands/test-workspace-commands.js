import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { getActiveLens } from '../lenses/loader.js';
import { createDocument } from '../models/documents.js';
import { getFrameworkState } from '../models/framework.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-workspace-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata'];

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function run(name, input, key, authorizationKind = 'explicit_imperative') {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'ask_radar', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `workspace-command:${key}`,
  });
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [investment] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, unrealized_value, net_value, source, asset_class)
      VALUES ('Workspace Co', 'Live', '2025-01-01', 1000, 1000, 1000, 'test', 'direct')
      RETURNING id
    `);
    const document = await createDocument({
      entity_type: 'investment', entity_id: investment.id,
      filename: 'workspace-update.txt', mime: 'text/plain', content: Buffer.from('Update'),
      confidentiality: 'confidential_company', processing_policy: 'model_allowed',
      sync_policy: 'encrypted_backup_allowed', executionMode: 'desktop',
    });

    const added = await run('update.add', {
      investmentId: Number(investment.id), sourceDocumentId: Number(document.id),
      updateKind: 'founder_update', taxYear: null, title: 'Q2 update',
      receivedDate: '2026-06-30', processingMode: 'store_only',
    }, 'add-update');
    const updateId = added.receipt.commands[0].result.update.id;
    assert.equal(added.status, 'applied');

    assert.equal((await run('update.update_metadata', {
      updateId, receivedDate: '2026-07-01',
    }, 'update-date')).status, 'applied');
    assert.equal(dateOnly((await query('SELECT received_date FROM investment_updates WHERE id = $1', [updateId]))[0].received_date), '2026-07-01');

    await query(`UPDATE investment_updates SET status = 'failed' WHERE id = $1`, [updateId]);
    assert.equal((await run('update.retry', { updateId }, 'retry-update')).status, 'applied');
    await query(`
      UPDATE investment_updates
         SET status = 'complete', review_status = 'pending_review', summary = 'Reviewed fixture'
       WHERE id = $1
    `, [updateId]);
    assert.equal((await run('update.review', {
      updateId, outcome: 'reviewed_no_changes', reviewedBy: 'test', note: null,
    }, 'review-update')).status, 'applied');

    const metricQuery = { metric: 'tvpi', groupBy: [], filters: {}, window: {}, excludeIds: [] };
    const saved = await run('performance.save_view', { name: 'My TVPI', query: metricQuery }, 'save-view');
    const viewId = Number(saved.receipt.commands[0].result.id);
    assert.equal((await run('performance.rename_view', { viewId, name: 'Portfolio TVPI' }, 'rename-view')).status, 'applied');
    const deletion = await run('performance.delete_view', { viewId }, 'delete-view');
    assert.equal(deletion.status, 'confirmation_required');
    assert.equal((await run('performance.delete_view', { viewId }, 'delete-view', 'inline_confirmation')).status, 'applied');

    assert.equal((await run('preference.finish_onboarding', {
      userId: 'default', track: 'portfolio',
    }, 'onboarding')).status, 'applied');
    assert.equal((await query(`SELECT onboarded FROM user_settings WHERE user_id = 'default'`))[0].onboarded, true);

    assert.equal((await run('pin.dismiss', {
      signalKey: 'decide-42', signalType: 'decide',
    }, 'dismiss-pin')).status, 'applied');
    assert.equal((await query(`SELECT COUNT(*)::int AS count FROM attention_dismissals WHERE signal_key = 'decide-42'`))[0].count, 1);

    const deploymentPlan = await run('deployment_plan.save', {
      budgetYear: 2026, annualBudget: 85000, changeNote: 'Annual plan fixture',
    }, 'save-deployment-plan');
    assert.equal(deploymentPlan.status, 'applied');
    const [savedPlan] = await query(`
      SELECT budget_year, annual_budget, version
        FROM annual_deployment_plan_versions
       WHERE budget_year = 2026
    `);
    assert.equal(savedPlan.budget_year, 2026);
    assert.equal(Number(savedPlan.annual_budget), 85000);
    assert.equal(savedPlan.version, 1);

    const frameworkState = await getFrameworkState(getActiveLens());
    const framework = structuredClone(frameworkState.framework);
    framework.manifest.description = 'Workspace command fixture';
    const frameworkConfirmation = await run('framework.save', {
      framework, changeNote: 'Command test',
    }, 'save-framework');
    assert.equal(frameworkConfirmation.status, 'confirmation_required');
    assert.equal((await run('framework.save', {
      framework, changeNote: 'Command test',
    }, 'save-framework', 'inline_confirmation')).status, 'applied');
  });
  console.log('Workspace commands: updates, views, onboarding, pins, deployment plan, and framework passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
