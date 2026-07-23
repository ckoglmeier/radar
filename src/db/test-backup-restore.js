import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, restoreDatabase } from './backup.js';
import { closeDb, query, withTenant } from './index.js';
import { runMigrations } from './migrate.js';
import { createDocument, getDocument } from '../models/documents.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-backup-restore-'));
const sourceUrl = `file:${join(scratch, 'source')}`;
const targetUrl = `file:${join(scratch, 'target')}`;
const backupDir = join(scratch, 'backups');
const bytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);

try {
  let backupFile;
  await withTenant(sourceUrl, async () => {
    await runMigrations();
    const [invite] = await query(
      `INSERT INTO pipeline_invites (deal_slug, company_name, status)
       VALUES ('backup-fixture', 'Backup Fixture', 'invite') RETURNING id`,
    );
    await createDocument({
      entity_type: 'pipeline_invite',
      entity_id: invite.id,
      filename: 'fixture.bin',
      mime: 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      content: bytes,
    });
    ({ file: backupFile } = await backupDatabase({ outDir: backupDir }));
  });

  const serialized = readFileSync(backupFile, 'utf8');
  assert.match(serialized, /\$radar_bytes_base64/);

  await withTenant(targetUrl, async () => {
    await runMigrations();
    await query(
      `INSERT INTO pipeline_invites (deal_slug, company_name)
       VALUES ('junk', 'Replace Me')`,
    );
    const result = await restoreDatabase({ file: backupFile });
    assert.ok(result.totalRows > 0);

    const invites = await query(
      `SELECT id, deal_slug, company_name FROM pipeline_invites ORDER BY id`,
    );
    assert.deepEqual(invites.map(row => row.deal_slug), ['backup-fixture']);
    const [docMeta] = await query(`SELECT id FROM documents`);
    const restoredDocument = await getDocument(docMeta.id);
    assert.deepEqual(Buffer.from(restoredDocument.content), bytes);

    const [nextInvite] = await query(
      `INSERT INTO pipeline_invites (deal_slug, company_name)
       VALUES ('after-restore', 'Sequence Check') RETURNING id`,
    );
    assert.ok(nextInvite.id > invites[0].id, 'serial sequence advanced past restored ids');

    const corruptFile = join(scratch, 'corrupt.json');
    const corrupt = JSON.parse(readFileSync(backupFile, 'utf8'));
    corrupt.tables.pipeline_invites[0].unknown_column = 'force rollback';
    writeFileSync(corruptFile, JSON.stringify(corrupt));
    await assert.rejects(() => restoreDatabase({ file: corruptFile }), /unknown_column/);
    const afterFailedRestore = await query(
      `SELECT deal_slug FROM pipeline_invites ORDER BY id`,
    );
    assert.deepEqual(
      afterFailedRestore.map(row => row.deal_slug),
      ['backup-fixture', 'after-restore'],
      'failed restore leaves the target unchanged',
    );
  });

  console.log('backup-restore: round-trip passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
