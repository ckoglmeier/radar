import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { authorizeCommandProposal, planCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-direct-lifecycle-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:lifecycle'];

async function plan(name, input, key) {
  return (await planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `direct-lifecycle-command:${key}`,
  })).proposal;
}

async function authorize(proposal, authorizationKind = 'explicit_imperative') {
  return authorizeCommandProposal(proposal.id, proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [position] = await query(`
      INSERT INTO investments (company_name, status, invest_date, invested, source, asset_class)
      VALUES ('Command Exit Co','Realized','2024-01-01',1000,'test','direct') RETURNING id
    `);
    const [flow] = await query(`
      INSERT INTO cash_flows
        (investment_id, flow_date, type, amount, source, external_hash,
         reconciliation_status, reconciled_at)
      VALUES ($1,'2026-03-01','distribution',1200,'test','command-exit-flow','matched',NOW())
      RETURNING id
    `, [position.id]);
    const proposal = await plan('direct.record_lifecycle_event', {
      investmentId: position.id, date: '2026-03-01', eventType: 'full_exit',
      remainingInterest: 'no', cashFlowId: flow.id, sourceDocumentId: null,
      evidenceNote: 'Closing statement',
    }, 'record');
    assert.equal((await authorize(proposal)).status, 'confirmation_required');
    const applied = await authorize(proposal, 'inline_confirmation');
    assert.equal(applied.status, 'applied');
    const eventId = applied.receipt.commands[0].result.event.id;
    assert.equal((await query(`SELECT event_type FROM direct_position_lifecycle_events WHERE id = $1`, [eventId]))[0].event_type, 'full_exit');

    const voidProposal = await plan('direct.void_lifecycle_event', {
      eventId, reason: 'Wrong disposition evidence', replacementEventId: null,
    }, 'void');
    assert.equal((await authorize(voidProposal)).status, 'confirmation_required');
    const voided = await authorize(voidProposal, 'inline_confirmation');
    assert.equal(voided.status, 'applied');
    assert.ok((await query(`SELECT voided_at FROM direct_position_lifecycle_events WHERE id = $1`, [eventId]))[0].voided_at);
  });
  console.log('Direct lifecycle commands: proposal, confirmation, apply, receipt, and void passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
