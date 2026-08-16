import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import {
  createCommandProposal,
  getCommandProposal,
  rejectCommandProposal,
} from './command-proposals.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-command-proposals-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

function fixture(overrides = {}) {
  return {
    registryVersion: 'registry-v1',
    originSurface: 'ask_radar',
    actorType: 'local_user',
    actorId: 'owner',
    intentText: 'Record the NAV',
    commands: [{ id: 'c1', name: 'fund.record_nav', version: 1 }],
    previews: [{ summary: 'Record NAV' }],
    commandSetHash: 'set-hash-1',
    idempotencyKey: 'ask:test:1',
    ...overrides,
  };
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const created = await createCommandProposal(fixture());
    assert.equal(created.idempotent_replay, false);
    assert.equal(created.proposal.status, 'proposed');
    const replay = await createCommandProposal(fixture());
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.proposal.id, created.proposal.id);
    await assert.rejects(
      () => createCommandProposal(fixture({ commandSetHash: 'other' })),
      error => error.code === 'PROPOSAL_IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      () => query(`UPDATE command_proposals SET commands = '[]'::jsonb WHERE id = $1`, [created.proposal.id]),
      /payload is immutable/,
    );

    const rejected = await rejectCommandProposal(created.proposal.id, 'set-hash-1', {
      reviewedBy: 'owner',
      reason: 'Not now',
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal((await getCommandProposal(created.proposal.id)).status, 'rejected');
    assert.equal(await rejectCommandProposal(created.proposal.id, 'set-hash-1', { reviewedBy: 'owner' }), null);
    await assert.rejects(
      () => query(`UPDATE command_proposals SET status = 'applied' WHERE id = $1`, [created.proposal.id]),
      /terminal command proposals are immutable/,
    );
  });

  console.log('command proposals: migration, idempotency, immutability, and lifecycle passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
