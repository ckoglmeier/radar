import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant, closeDb, query } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { validateWorkspaceSizing, getWorkspaceSizing, saveWorkspaceSizing } from './workspace-sizing.js';
import { withWorkspaceSizing, loadBetSizingConfig, scoreToTier } from '../utils/bet-sizing.js';
import { loadLens, withLens } from '../lenses/loader.js';
import { loadCloudLens } from '../lenses/hydrate.js';

const config = { risk_capital: 10000, floor: 1000, min_check: 100, max_check: 1000, late_stage_approved_check: 0, single_position_cap_pct: .1, cluster_cap_pct: .2, illiquid_ceiling_pct: .4, opportunity_cost_rate: .05, tiers: [{ min_score: 40, check: 500 }, { min_score: 0, check: 0 }] };
assert.deepEqual(validateWorkspaceSizing(config), config);
for (const invalid of [{}, { ...config, risk_capital: null }, { ...config, annual_budget: 1000 }, { ...config, tiers: [{ min_score: 40, check: 500 }] }, { ...config, max_check: 50 }, { ...config, floor: 10000 }]) assert.throws(() => validateWorkspaceSizing(invalid));
await Promise.all([10000, 20000].map(capital => withWorkspaceSizing({ ...config, risk_capital: capital }, async () => {
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(loadBetSizingConfig().risk_capital, capital);
  const mutableCopy = loadBetSizingConfig();
  mutableCopy.risk_capital = 1;
  assert.equal(loadBetSizingConfig().risk_capital, capital);
})));
const root = mkdtempSync(join(tmpdir(), 'radar-sizing-'));
try {
  await withTenant(`file:${join(root, 'db')}`, async () => {
    await runMigrations();
    assert.equal(await getWorkspaceSizing(), null);
    await saveWorkspaceSizing({ config, expectedVersion: 0, changeNote: 'Synthetic setup' });
    await assert.rejects(saveWorkspaceSizing({ config, expectedVersion: 0, changeNote: 'Stale save' }), /changed/);
    await saveWorkspaceSizing({ config: { ...config, max_check: 1500 }, expectedVersion: 1, changeNote: 'Synthetic revision' });
    await query("INSERT INTO theses (name, lens_thesis_id, active) VALUES ('Sizing Test', 'sizing-test', TRUE)");
    await query("INSERT INTO lens_config (id, distributions) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET distributions = EXCLUDED.distributions");
    const lens = await loadCloudLens(loadLens(new URL('../../lenses/_template', import.meta.url).pathname));
    assert.equal(lens.sizingVersion, 2);
    await withLens(lens, async () => {
      assert.equal(loadBetSizingConfig().max_check, 1500);
      assert.equal(scoreToTier(45).check, 500);
    });
    const backup = await createDatabaseBackupPayload();
    await query('DELETE FROM workspace_sizing_versions');
    await restoreDatabase({ content: backup.content });
    const restored = await getWorkspaceSizing();
    assert.equal(restored.version, 2);
    assert.equal(restored.config.max_check, 1500);
    const rows = await query('SELECT * FROM workspace_sizing_versions ORDER BY version');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].config, config);
  });
  console.log('Workspace sizing: validation, version conflict, request isolation, and backup round-trip passed');
} finally {
  await closeDb();
  rmSync(root, { recursive: true, force: true });
}
