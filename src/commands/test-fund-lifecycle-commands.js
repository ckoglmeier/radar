import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { authorizeCommandProposal, planCommandProposal, undoCommandReceipt } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-fund-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata'];

async function plan(name, input, key) {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `fund-lifecycle:${key}`,
  });
  return planned.proposal;
}

async function authorize(proposal, authorizationKind = 'explicit_imperative') {
  return authorizeCommandProposal(proposal.id, proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const create = await plan('fund.create', {
      legalName: 'Command Fund II', commitmentDate: '2025-01-01',
      manager: 'Original Manager', strategy: 'Seed', vintageYear: 2025,
      commitment: 10000, initialContribution: 1000,
      initialContributionDate: '2025-01-01', initialNav: 1000,
      initialNavDate: '2025-01-01',
    }, 'create');
    const created = await authorize(create);
    assert.equal(created.status, 'applied');
    const fundId = Number(created.receipt.commands[0].result.investment.id);

    const update = await plan('fund.update', {
      investmentId: fundId, manager: 'New Manager', strategy: 'Seed',
      vintageYear: 2025, fundStatus: 'active', description: 'Updated',
    }, 'update');
    const updated = await authorize(update);
    assert.equal((await query('SELECT manager FROM fund_profiles WHERE investment_id = $1', [fundId]))[0].manager, 'New Manager');
    await undoCommandReceipt(updated.receipt.id, { actorId: 'test', actorCapabilities });
    assert.equal((await query('SELECT manager FROM fund_profiles WHERE investment_id = $1', [fundId]))[0].manager, 'Original Manager');

    const archive = await plan('fund.set_active', { investmentId: fundId, active: false }, 'archive');
    const archived = await authorize(archive);
    assert.ok((await query('SELECT archived_at FROM fund_profiles WHERE investment_id = $1', [fundId]))[0].archived_at);
    await undoCommandReceipt(archived.receipt.id, { actorId: 'test', actorCapabilities });
    assert.equal((await query('SELECT archived_at FROM fund_profiles WHERE investment_id = $1', [fundId]))[0].archived_at, null);

    const noticeProposal = await plan('fund.create_capital_call', {
      investmentId: fundId, noticeDate: '2025-02-01', dueDate: '2025-02-15',
      amount: 500, currency: 'USD', description: 'Call',
    }, 'notice');
    const noticeApplied = await authorize(noticeProposal);
    const noticeId = noticeApplied.receipt.commands[0].result.notice.id;
    const cancel = await plan('fund.cancel_capital_call', { noticeId, reason: 'Withdrawn' }, 'cancel');
    assert.equal((await authorize(cancel)).status, 'confirmation_required');
    assert.equal((await authorize(cancel, 'inline_confirmation')).status, 'applied');

    const feeProposal = await plan('fund.record_fee', {
      investmentId: fundId, date: '2025-03-01', amount: 25,
      currency: 'USD', description: 'Admin fee',
    }, 'fee');
    const feeApplied = await authorize(feeProposal);
    const transactionId = feeApplied.receipt.commands[0].result.transaction.id;
    const replace = await plan('fund.replace_transaction', {
      transactionId, reason: 'Correct amount', date: '2025-03-01',
      amount: 20, description: 'Corrected admin fee', externalHash: 'fund-command-replacement',
    }, 'replace');
    assert.equal((await authorize(replace)).status, 'confirmation_required');
    const replaced = await authorize(replace, 'inline_confirmation');
    assert.equal(replaced.status, 'applied');
  });
  console.log('Fund lifecycle commands: create, update/Undo, archive/Undo, cancel, and correction passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
