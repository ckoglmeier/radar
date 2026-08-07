import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from './index.js';
import { runMigrations } from './migrate.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-migration-040-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await query(`
      CREATE TABLE schema_migrations (
        version INT PRIMARY KEY,
        name TEXT,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      INSERT INTO schema_migrations (version, name)
      SELECT version, 'legacy-' || version
      FROM generate_series(1, 39) AS version
    `);
    // This fixture isolates migration 040 with a deliberately partial legacy
    // schema. Mark later migrations applied so their unrelated prerequisites
    // are not part of this focused normalization test.
    await query(`
      INSERT INTO schema_migrations (version, name)
      VALUES (41, 'fixture-skip-041')
    `);
    await query(`
      CREATE TABLE council_runs (
        id SERIAL PRIMARY KEY,
        pipeline_invite_id INT,
        run_type TEXT NOT NULL DEFAULT 'score',
        status TEXT NOT NULL DEFAULT 'completed',
        stage TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        previous_evaluation_id INT,
        evaluation_id INT
      )
    `);
    await query(`
      CREATE TABLE deal_evaluations (
        id SERIAL PRIMARY KEY,
        council_run_type TEXT
      )
    `);
    const [evaluation] = await query(`
      INSERT INTO deal_evaluations (council_run_type)
      VALUES ('audit_replay')
      RETURNING id
    `);
    await query(`
      INSERT INTO council_runs (run_type, evaluation_id)
      VALUES ('audit_replay', $1)
    `, [evaluation.id]);

    const migrated = await runMigrations();
    assert.deepEqual(migrated.migrations, ['040_evaluation_integrity_runs']);

    const [run] = await query('SELECT run_type FROM council_runs');
    assert.equal(run.run_type, 'controlled_replay');

    const [updatedEvaluation] = await query(`
      SELECT council_run_type, promotes_to_canonical
      FROM deal_evaluations
      WHERE id = $1
    `, [evaluation.id]);
    assert.equal(updatedEvaluation.council_run_type, 'controlled_replay');
    assert.equal(updatedEvaluation.promotes_to_canonical, false);

    await assert.rejects(
      () => query(`UPDATE council_runs SET run_type = 'audit_replay'`),
      /council_runs_run_type_check/,
    );
  });

  console.log('migration-040: legacy audit replay normalization passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
