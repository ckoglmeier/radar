import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from './index.js';
import { runMigrations } from './migrate.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-migration-069-'));

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const [invalid] = await query(`
      INSERT INTO deal_evaluations
        (company_name, eval_date, total_score, raw_content)
      VALUES (
        'Groq fixture',
        '2026-04-10',
        85,
        '# Groq fixture\n## Total: 85/100\n## Total: 43/50\n'
      )
      RETURNING id
    `);
    const [valid] = await query(`
      INSERT INTO deal_evaluations
        (company_name, eval_date, total_score, raw_content)
      VALUES ('Valid fixture', '2026-04-10', 49, '# Valid\n## Total: 42/50\n')
      RETURNING id
    `);

    await query(`DELETE FROM schema_migrations WHERE version = 69`);
    const result = await runMigrations();
    assert.deepEqual(result.migrations, ['069_repair_out_of_range_entry_scores']);

    const [repaired] = await query(`SELECT total_score FROM deal_evaluations WHERE id = $1`, [invalid.id]);
    const [untouched] = await query(`SELECT total_score FROM deal_evaluations WHERE id = $1`, [valid.id]);
    assert.equal(Number(repaired.total_score), 43);
    assert.equal(Number(untouched.total_score), 49);
  });
  console.log('migration-069: out-of-range entry score repaired from final /50 Total');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
