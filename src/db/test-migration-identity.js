import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, withTenant, closeDb } from './index.js';
import { runMigrations, inspectPendingMigrations } from './migrate.js';

const root = mkdtempSync(join(tmpdir(), 'radar-migration-identity-'));
try {
  for (const branch of ['local-compaction', 'public-beta']) {
    await withTenant(`file:${join(root, branch)}`, async () => {
      await runMigrations({ seedLegacyTheses: false });
      await query("INSERT INTO theses (name, description) VALUES ('User thesis', 'Preserve this belief')");
      if (branch === 'local-compaction') {
        await query('DROP TABLE ad_hoc_reviews');
        await query('ALTER TABLE council_runs DROP COLUMN review_mode');
        await query('DROP TABLE workspace_sizing_versions');
        await query("UPDATE schema_migrations SET name = '072_document_compaction' WHERE version = 72");
        await query("UPDATE schema_migrations SET name = '073_document_compaction_legacy_writers' WHERE version = 73");
      } else {
        await query("INSERT INTO workspace_sizing_versions (version, config, change_note) VALUES (1, '{}', 'Keep my settings')");
      }
      await query('DELETE FROM schema_migrations WHERE version >= 74');
      const history = await query('SELECT * FROM schema_migrations WHERE version <= 73 ORDER BY version');
      assert.deepEqual((await inspectPendingMigrations()).pending.map(m => m.version), [74, 75, 76, 77]);
      await runMigrations({ seedLegacyTheses: false });
      assert.deepEqual(await query('SELECT * FROM schema_migrations WHERE version <= 73 ORDER BY version'), history);
      assert.equal((await query('SELECT description FROM theses'))[0].description, 'Preserve this belief');
      await query('SELECT * FROM ad_hoc_reviews');
      await query('SELECT review_mode FROM council_runs');
      await query('SELECT * FROM workspace_sizing_versions');
      await query('SELECT content_encoding, stored_size_bytes FROM documents');
      if (branch === 'public-beta') assert.equal((await query('SELECT change_note FROM workspace_sizing_versions'))[0].change_note, 'Keep my settings');
      assert.equal((await runMigrations()).applied, 0);
      await query("UPDATE schema_migrations SET name = '072_unrecognized_branch' WHERE version = 72");
      await assert.rejects(inspectPendingMigrations, /unexpected identity/);
      await assert.rejects(runMigrations, /unexpected identity/);
    });
  }
  console.log('Migration identities: both shipped branches reconcile forward; historical rows/settings preserved; unknown collisions fail closed');
} finally { await closeDb(); rmSync(root, { recursive: true, force: true }); }
