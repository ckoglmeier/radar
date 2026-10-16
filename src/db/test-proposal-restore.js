import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from './index.js';
import { runMigrations } from './migrate.js';
import { createDatabaseBackupPayload, restoreDatabase } from './backup.js';
import { createCommandProposal } from '../models/command-proposals.js';

const root = mkdtempSync(join(tmpdir(), 'radar-proposal-restore-'));
const statuses = ['proposed', 'applied', 'rejected', 'stale', 'failed', 'superseded'];
try {
  let content, expected, expectedThreads, expectedMessages, expectedTimestamp;
  await withTenant(`file:${join(root, 'source')}`, async () => {
    await runMigrations();
    let previous;
    for (const status of statuses) {
      const { proposal } = await createCommandProposal({ registryVersion: 'test', originSurface: 'manual_ui', actorType: 'test', commands: [{ name: 'test' }], previews: [], commandSetHash: status, idempotencyKey: status, supersedesProposalId: previous });
      if (status !== 'proposed') await query(`UPDATE command_proposals SET status=$2, result=$3::jsonb, reviewed_by=$4, reviewed_at=$5, applied_at=$6, error_code=$7 WHERE id=$1`, [proposal.id, status, status === 'applied' ? '{}' : null, ['applied', 'rejected'].includes(status) ? 'test' : null, ['applied', 'rejected'].includes(status) ? '2026-01-01T00:00:00Z' : null, status === 'applied' ? '2026-01-01T00:00:00Z' : null, status === 'failed' ? 'TEST_FAILURE' : null]);
      previous = proposal.id;
    }
    const [thread] = await query("INSERT INTO command_threads (title) VALUES ('Synthetic restore thread') RETURNING id");
    await query("UPDATE command_threads SET created_at='2026-01-02T03:04:05.123456Z' WHERE id=$1", [thread.id]);
    const [message] = await query("INSERT INTO command_messages (thread_id, role, content) VALUES ($1, 'user', 'Synthetic request') RETURNING id", [thread.id]);
    await query("UPDATE command_threads SET active_request_id=$2, active_request_state='completed', active_request_stage='complete' WHERE id=$1", [thread.id, message.id]);
    expectedThreads = await query('SELECT * FROM command_threads ORDER BY id');
    expectedTimestamp = await query('SELECT created_at::text FROM command_threads ORDER BY id');
    expectedMessages = await query('SELECT * FROM command_messages ORDER BY id');
    expected = await query('SELECT * FROM command_proposals ORDER BY id');
    ({ content } = await createDatabaseBackupPayload({ includeLocalOnly: true }));
  });
  await closeDb();
  await withTenant(`file:${join(root, 'target')}`, async () => {
    await runMigrations();
    await restoreDatabase({ content });
    assert.deepEqual(await query('SELECT * FROM command_proposals ORDER BY id'), expected, 'all lifecycle states, timestamps and supersession links preserved');
    assert.deepEqual(await query('SELECT * FROM command_threads ORDER BY id'), expectedThreads);
    assert.deepEqual(await query('SELECT created_at::text FROM command_threads ORDER BY id'), expectedTimestamp, 'microsecond audit timestamps preserved');
    assert.deepEqual(await query('SELECT * FROM command_messages ORDER BY id'), expectedMessages);
    const assertGuards = async () => {
      assert.equal((await query("SELECT tgenabled FROM pg_trigger WHERE tgname='command_proposals_contract'"))[0].tgenabled, 'O');
      await assert.rejects(query("INSERT INTO command_proposals SELECT gen_random_uuid(), schema_version, normalizer_version, registry_version, status, origin_surface, actor_type, actor_id, intent_text, source_document_id, source_update_id, commands, previews, command_set_hash, 'invalid-new', supersedes_proposal_id, planner_provider, planner_model, planner_run_key, result, error_code, error_message, reviewed_by, reviewed_at, applied_at, created_at, updated_at, intent, execution_preference, planner_confidence, planner_warnings, conversation_context, provenance_context FROM command_proposals WHERE status='applied'"), /new command proposals must start proposed/);
      await assert.rejects(query("UPDATE command_proposals SET reviewed_by='changed' WHERE status='applied'"), /terminal command proposals are immutable/);
    };
    await assertGuards();
    const brokenLink = JSON.parse(content);
    brokenLink.tables.command_threads[0].active_request_id = '00000000-0000-4000-8000-000000000001';
    await assert.rejects(restoreDatabase({ content: JSON.stringify(brokenLink) }), /foreign key/);
    assert.deepEqual(await query('SELECT * FROM command_threads ORDER BY id'), expectedThreads, 'failed cycle repair rolls back');
    await assertGuards();
    for (const status of statuses) {
      const invalid = JSON.parse(content);
      const row = invalid.tables.command_proposals.find(r => r.status === status);
      if (status === 'applied') row.reviewed_by = null;
      else if (status === 'rejected') row.reviewed_at = null;
      else if (status === 'failed') row.error_code = null;
      else row.result = {};
      await assert.rejects(restoreDatabase({ content: JSON.stringify(invalid) }), /Invalid command proposal state/);
    }
    // Fail after trigger suspension, proving transactional DDL and data rollback.
    const invalid = JSON.parse(content);
    invalid.tables.command_proposals.at(-1).unknown_restore_column = 'invalid';
    await assert.rejects(restoreDatabase({ content: JSON.stringify(invalid) }), /unknown_restore_column/);
    assert.deepEqual(await query('SELECT * FROM command_proposals ORDER BY id'), expected);
    await assertGuards();
  });
  console.log('proposal restore: six states, circular thread/message links, exact history, invalid-state/FK rejection, atomic rollback and normal guards passed');
} finally { await closeDb(); rmSync(root, { recursive: true, force: true }); }
