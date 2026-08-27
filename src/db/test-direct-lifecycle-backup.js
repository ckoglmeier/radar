import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseBackupPayload, restoreDatabase } from './backup.js';
import { closeDb, query, withTenant } from './index.js';
import { runMigrations } from './migrate.js';
import { recordDirectLifecycleEvent, voidDirectLifecycleEvent } from '../models/direct-lifecycle-events.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-direct-lifecycle-backup-'));
const source = `file:${join(scratch, 'source')}`;
const target = `file:${join(scratch, 'target')}`;

try {
  let content;
  let eventId;
  let replacementId;
  await withTenant(source, async () => {
    await runMigrations();
    const [position] = await query(`
      INSERT INTO investments (company_name, status, invest_date, invested, source, asset_class)
      VALUES ('Backup Lifecycle Co','Written Off','2025-01-01',100,'test','direct') RETURNING id
    `);
    const result = await recordDirectLifecycleEvent(position.id, {
      date: '2026-01-15', eventType: 'write_off', remainingInterest: 'no',
      evidenceNote: 'Backup fixture', idempotencyKey: 'backup-lifecycle:1',
    });
    eventId = result.event.id;
    const replacement = await recordDirectLifecycleEvent(position.id, {
      date: '2026-01-16', eventType: 'abandonment', remainingInterest: 'no',
      evidenceNote: 'Replacement fixture', idempotencyKey: 'backup-lifecycle:2',
    });
    replacementId = replacement.event.id;
    await voidDirectLifecycleEvent(eventId, {
      reason: 'Corrected classification', replacementEventId: replacementId,
    });
    content = (await createDatabaseBackupPayload()).content;
  });
  await withTenant(target, async () => {
    await runMigrations();
    await restoreDatabase({ content });
    const [event] = await query(`SELECT * FROM direct_position_lifecycle_events WHERE id = $1`, [eventId]);
    assert.equal(event.event_type, 'write_off');
    assert.equal(event.evidence_note, 'Backup fixture');
    assert.ok(event.voided_at);
    assert.equal(event.replacement_event_id, replacementId);
    assert.equal((await query(`SELECT event_type FROM direct_position_lifecycle_events WHERE id = $1`, [replacementId]))[0].event_type, 'abandonment');
  });
  console.log('Direct lifecycle backup/restore: event and evidence metadata passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
