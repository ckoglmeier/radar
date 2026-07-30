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
  let runId;
  let evaluationId;
  await withTenant(sourceUrl, async () => {
    await runMigrations();
    const [invite] = await query(
      `INSERT INTO pipeline_invites (deal_slug, company_name, status)
       VALUES ('backup-fixture', 'Backup Fixture', 'invite') RETURNING id`,
    );
    const [run] = await query(
      `INSERT INTO council_runs
         (pipeline_invite_id, request_key, run_type, status, stage,
          source_manifest, source_coverage, evidence_contract_version)
       VALUES ($1, 'backup-run', 'initial', 'completed', 'completed',
               $2::jsonb, $3::jsonb, 1)
       RETURNING id`,
      [
        invite.id,
        JSON.stringify([{ document_id: 1, extraction_status: 'included' }]),
        JSON.stringify({ attached: 1, included: 1, accounted_for: true }),
      ],
    );
    runId = run.id;
    await query(
      `INSERT INTO council_run_events
         (run_id, attempt_number, sequence, event_type, phase, safe_detail)
       VALUES ($1, 1, 1, 'completed', 'completed', 'Fixture completed')`,
      [run.id],
    );
    await query(
      `INSERT INTO council_run_dispatch (run_id, status, delivery_attempts)
       VALUES ($1, 'delivered', 1)`,
      [run.id],
    );
    const [evaluation] = await query(
      `INSERT INTO deal_evaluations
         (pipeline_invite_id, company_name, council_run_id,
          council_evidence_contract_version, council_source_manifest_sha256,
          promotes_to_canonical)
       VALUES ($1, 'Backup Fixture', $2, 1, 'manifest-hash', TRUE)
       RETURNING id`,
      [invite.id, run.id],
    );
    evaluationId = evaluation.id;
    await query(
      `UPDATE council_runs SET evaluation_id = $1 WHERE id = $2`,
      [evaluation.id, run.id],
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
    const [restoredRun] = await query(
      `SELECT source_manifest, source_coverage, evidence_contract_version,
              evaluation_id
       FROM council_runs WHERE request_key = 'backup-run'`,
    );
    assert.equal(restoredRun.evidence_contract_version, 1);
    assert.equal(restoredRun.source_manifest[0].extraction_status, 'included');
    assert.equal(restoredRun.source_coverage.accounted_for, true);
    const [restoredEvent] = await query(
      `SELECT event_type, safe_detail FROM council_run_events WHERE run_id = $1`,
      [runId],
    );
    assert.equal(restoredEvent.event_type, 'completed');
    assert.equal(restoredEvent.safe_detail, 'Fixture completed');
    const [restoredDispatch] = await query(
      `SELECT status, delivery_attempts FROM council_run_dispatch WHERE run_id = $1`,
      [runId],
    );
    assert.equal(restoredDispatch.status, 'delivered');
    assert.equal(restoredDispatch.delivery_attempts, 1);
    const [restoredEvaluation] = await query(
      `SELECT council_run_id, council_evidence_contract_version,
              council_source_manifest_sha256, promotes_to_canonical
       FROM deal_evaluations WHERE id = $1`,
      [evaluationId],
    );
    assert.equal(restoredEvaluation.council_run_id, runId);
    assert.equal(restoredEvaluation.council_evidence_contract_version, 1);
    assert.equal(restoredEvaluation.council_source_manifest_sha256, 'manifest-hash');
    assert.equal(restoredEvaluation.promotes_to_canonical, true);

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
