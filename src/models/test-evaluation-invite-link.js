import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, withTenant, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { importDealLogs } from './evaluations.js';
const scratch = mkdtempSync(join(tmpdir(), 'radar-invite-link-'));
try {
 await withTenant(`file:${join(scratch, 'db')}`, async () => {
  await runMigrations();
  const [old] = await query("INSERT INTO pipeline_invites (deal_slug,company_name,status) VALUES ('old-chef','Chef Robotics','archived') RETURNING id");
  const [current] = await query("INSERT INTO pipeline_invites (deal_slug,company_name,status) VALUES ('new-chef','Chef Robotics','invite') RETURNING id");
  writeFileSync(join(scratch,'2026-09-28-chef.md'), '# Deal Log: Chef Robotics\n\n## Total: 38/50\n## Verdict: Pass\n');
  const result = await importDealLogs(scratch, { pipelineInviteId: current.id });
  assert.equal(result.imported, 1, JSON.stringify(result));
  const [evaluation] = await query('SELECT pipeline_invite_id FROM deal_evaluations');
  assert.equal(evaluation.pipeline_invite_id, current.id);
  assert.notEqual(evaluation.pipeline_invite_id, old.id);
  await assert.rejects(importDealLogs(scratch, {pipelineInviteId: 999999}), /not found/);
  writeFileSync(join(scratch,'2026-09-28-other.md'), '# Deal Log: Other Company\n\n## Total: 38/50\n## Verdict: Pass\n');
  const mismatch = await importDealLogs(scratch, {pipelineInviteId: current.id, files:['2026-09-28-other.md']});
  assert.equal(mismatch.errors, 1);
  assert.equal((await query('SELECT id FROM deal_evaluations')).length, 1);
 });
 console.log('Exact invite linking: repeat-company, missing-target, and mismatch checks passed');
} finally { await closeDb(); rmSync(scratch,{recursive:true,force:true}); }
