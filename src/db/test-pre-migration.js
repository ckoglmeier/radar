import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreMigrationSnapshot } from './backup.js';
import { closeDb, query, withTenant } from './index.js';
import { inspectPendingMigrations, runMigrations } from './migrate.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-pre-migration-'));
try {
  const emptyUrl = `file:${join(scratch, 'empty')}`;
  await withTenant(emptyUrl, async () => {
    const before = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    assert.deepEqual(before, []);
    const inspection = await inspectPendingMigrations();
    assert.equal(inspection.schema_version, 1);
    assert.equal(inspection.migration_table_present, false);
    assert.equal(inspection.applied.length, 0);
    assert.ok(inspection.pending.length > 0);
    assert.equal(inspection.latest_available_version, 60);
    const after = await query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    assert.deepEqual(after, [], 'inspection creates no migration table or other schema');
  });
  await closeDb();

  const oldUrl = `file:${join(scratch, 'old-schema')}`;
  await withTenant(oldUrl, async () => {
    await query(`CREATE TABLE schema_migrations (version INT PRIMARY KEY, name TEXT)`);
    await query(`INSERT INTO schema_migrations (version, name) VALUES (1, '001_initial_schema')`);
    await query(`CREATE TABLE legacy_records (id SERIAL PRIMARY KEY, label TEXT, payload BYTEA)`);
    await query(`INSERT INTO legacy_records (label, payload) VALUES ($1, $2)`, [
      'Synthetic legacy record', Buffer.from([0, 1, 2, 255]),
    ]);
    // Deliberately model an old documents table with no sync_policy column.
    await query(`CREATE TABLE documents (id SERIAL PRIMARY KEY, filename TEXT, content BYTEA)`);
    await query(`INSERT INTO documents (filename, content) VALUES ($1, $2)`, [
      'synthetic.txt', Buffer.from('synthetic old-schema document'),
    ]);

    const inspection = await inspectPendingMigrations();
    assert.equal(inspection.migration_table_present, true);
    assert.deepEqual(inspection.applied, [{ version: 1, name: '001_initial_schema' }]);
    assert.equal(inspection.pending.some(migration => migration.version === 1), false);
    assert.equal(inspection.pending.at(-1).version, 60);

    const snapshot = await createPreMigrationSnapshot({
      safeConfig: { appearance: { theme: 'dark' }, ai: { auth_mode: 'subscription' } },
      lenses: [{ path: 'conviction/manifest.json', content_base64: Buffer.from('{"version":1}').toString('base64') }],
      now: new Date('2026-08-27T17:00:00Z'),
    });
    assert.equal(snapshot.bundle.kind, 'radar-pre-migration-snapshot');
    assert.equal(snapshot.bundle.created_at, '2026-08-27T17:00:00.000Z');
    assert.equal(snapshot.inventory.document_rows, 1);
    assert.equal(snapshot.inventory.total_rows, 3);
    assert.deepEqual(snapshot.bundle.config, {
      appearance: { theme: 'dark' }, ai: { auth_mode: 'subscription' },
    });
    assert.equal(snapshot.bundle.lenses[0].path, 'conviction/manifest.json');
    assert.match(snapshot.bundle.database, /\$radar_bytes_base64/);
    const database = JSON.parse(snapshot.bundle.database);
    assert.deepEqual(Buffer.from(database.tables.legacy_records[0].payload.$radar_bytes_base64, 'base64'), Buffer.from([0, 1, 2, 255]));
    assert.deepEqual(Buffer.from(database.tables.documents[0].content.$radar_bytes_base64, 'base64'), Buffer.from('synthetic old-schema document'));
    assert.equal((await inspectPendingMigrations()).applied.length, 1, 'snapshot applies no migration');

    await assert.rejects(
      () => createPreMigrationSnapshot({ lenses: [{ path: '../escape', content_base64: '' }] }),
      /unsafe path/,
    );
    await assert.rejects(
      () => createPreMigrationSnapshot({ safeConfig: { bad: 1n } }),
      /JSON serializable/,
    );
  });
  await closeDb();

  const localOnlyUrl = `file:${join(scratch, 'local-only-old-schema')}`;
  await withTenant(localOnlyUrl, async () => {
    await query(`CREATE TABLE documents (
      id SERIAL PRIMARY KEY,
      filename TEXT,
      content BYTEA,
      sync_policy TEXT
    )`);
    await query(`INSERT INTO documents (filename, content, sync_policy) VALUES ($1, $2, $3)`, [
      'private.bin', Buffer.from([9, 8, 7, 0]), 'local_only',
    ]);
    const snapshot = await createPreMigrationSnapshot();
    const database = JSON.parse(snapshot.bundle.database);
    assert.deepEqual(
      Buffer.from(database.tables.documents[0].content.$radar_bytes_base64, 'base64'),
      Buffer.from([9, 8, 7, 0]),
      'encrypted migration snapshot preserves local-only bytes',
    );
  });
  await closeDb();

  const currentUrl = `file:${join(scratch, 'current')}`;
  await withTenant(currentUrl, async () => {
    await runMigrations();
    const inspection = await inspectPendingMigrations();
    assert.equal(inspection.migration_table_present, true);
    assert.equal(inspection.pending.length, 0);
    assert.equal(inspection.applied.at(-1).version, 60);
  });

  console.log('pre-migration: read-only inspection and old-schema snapshot passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
