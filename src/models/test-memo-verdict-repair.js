import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant, query, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { repairMemoVerdicts, reconcileSavedMemo } from './memo-verdict-repair.js';
const raw = '## Transaction Assessment\n\n| Company | positive | Verify revenue |\n\n**Recommendation:** proceed — before Oct 9\n\n## Verdict: Pass\n\n## Draft Response\nHistorical draft';
assert.equal(reconcileSavedMemo({ verdict: null, raw_content: raw }), null);
assert.equal(reconcileSavedMemo({ verdict: 'Pass', raw_content: 'No transaction recommendation.' }), null);
const dir = mkdtempSync(join(tmpdir(), 'radar-memo-repair-'));
try {
  await withTenant(`file:${dir}/db`, async () => {
    await runMigrations();
    const [row] = await query(`INSERT INTO deal_evaluations (company_name,total_score,verdict,raw_content,council_transaction_assessment,invested)
      VALUES ('Synthetic',38,'Pass',$1,$2::jsonb,true) RETURNING *`, [raw, JSON.stringify({ recommendation: 'proceed', gated_reason: 'Proceed now', company: { blocking_facts: ['Verify revenue'] } })]);
    assert.equal((await repairMemoVerdicts({ dryRun: true })).count, 1);
    assert.equal((await query('SELECT * FROM memo_verdict_repairs')).length, 0);
    assert.equal((await repairMemoVerdicts()).count, 1);
    const [fixed] = await query('SELECT * FROM deal_evaluations WHERE id=$1', [row.id]);
    assert.match(fixed.raw_content, /Recommendation:\*\* Pass/);
    assert.doesNotMatch(fixed.raw_content, /proceed —/);
    assert.match(fixed.raw_content, /Historical draft/);
    assert.equal(fixed.total_score, row.total_score);
    assert.equal(fixed.invested, true);
    assert.equal(fixed.verdict, row.verdict);
    assert.equal(fixed.council_transaction_assessment.recommendation, 'Pass');
    assert.deepEqual(fixed.council_transaction_assessment.company, row.council_transaction_assessment.company);
    const [receipt] = await query('SELECT * FROM memo_verdict_repairs');
    assert.equal(receipt.original_evaluation.raw_content, raw);
    assert.equal(receipt.repaired_content_hash, fixed.council_artifact_hash);
    assert.equal((await repairMemoVerdicts()).count, 0);
  });
  console.log('memo-verdict-repair: dry run, archival, invariants, and idempotence passed');
} finally { await closeDb(); rmSync(dir, { recursive: true, force: true }); }
