import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { saveThesis } from '../models/theses.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-portfolio-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = [
  'portfolio:apply:additive', 'portfolio:apply:metadata', 'portfolio:apply:reconciliation',
];

async function command(name, input, key, authorizationKind = 'explicit_imperative') {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `portfolio-command:${key}`,
  });
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const thesis = await saveThesis({ name: 'Portfolio command thesis' });
    const created = await command('direct.create_position', {
      companyName: 'Command Portfolio Co', thesisId: Number(thesis.id), status: 'Live',
      investDate: '2025-01-01', invested: 1000, netValue: 1200, realizedValue: 0,
      convictionNow: 4, convictionEntry: 3,
    }, 'create');
    assert.equal(created.status, 'applied');
    const positionId = Number(created.receipt.commands[0].result.position.id);
    const [position] = await query('SELECT conviction_now, conviction_entry FROM investments WHERE id = $1', [positionId]);
    assert.equal(Number(position.conviction_now), 4);

    const imported = await command('transaction.import', {
      source: 'test',
      rows: [{
        Date: '2025-02-01', Transaction: 'Investment',
        Description: 'Investment in Transaction Newco', Amount: '-500', Balance: null,
      }],
    }, 'import');
    assert.equal(imported.status, 'applied');
    const [flow] = await query("SELECT id FROM cash_flows WHERE company_raw = 'Transaction Newco'");

    const fromTransactions = await command('direct.create_from_transactions', {
      cashFlowIds: [Number(flow.id)], companyName: 'Transaction Newco', thesisId: Number(thesis.id),
    }, 'create-from-transactions');
    assert.equal(fromTransactions.status, 'applied');
    assert.equal(fromTransactions.receipt.commands[0].result.linked.length, 1);

    const [duplicate] = await query(`
      INSERT INTO investments (company_name, status, invest_date, invested, source, asset_class)
      VALUES ('Command Portfolio Co', 'Live', '2025-01-02', 100, 'manual', 'direct')
      RETURNING id
    `);
    const duplicateId = Number(duplicate.id);
    const kept = await command('direct.keep_separate', {
      investmentIds: [positionId, duplicateId],
    }, 'keep-separate');
    assert.equal(kept.status, 'applied');

    const consolidation = await command('direct.consolidate', {
      targetInvestmentId: positionId, sourceInvestmentIds: [duplicateId],
    }, 'consolidate');
    assert.equal(consolidation.status, 'confirmation_required');
    const consolidated = await command('direct.consolidate', {
      targetInvestmentId: positionId, sourceInvestmentIds: [duplicateId],
    }, 'consolidate', 'inline_confirmation');
    assert.equal(consolidated.status, 'applied');
    assert.equal((await query('SELECT asset_class FROM investments WHERE id = $1', [duplicateId]))[0].asset_class, 'merged');
  });
  console.log('Portfolio commands: create, import, create-from-transactions, review, and confirmation passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
