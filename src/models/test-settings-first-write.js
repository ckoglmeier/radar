import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withTenant, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { getUserSettings, updateUserSettings, setOnboarded } from './settings.js';

const root = mkdtempSync(join(tmpdir(), 'radar-first-settings-'));
try {
  await withTenant(`file:${join(root, 'db')}`, async () => {
    await runMigrations();
    const saved = await updateUserSettings('fresh', { beta_setup_version: 1, onboarded: true, onboarding_track: 'theses' });
    assert.equal(saved.beta_setup_version, 1);
    assert.equal(saved.onboarded, true);
    assert.equal(saved.onboarding_track, 'theses');
    await updateUserSettings('fresh', { beta_setup_version: 2 });
    const updated = await getUserSettings('fresh');
    assert.equal(updated.beta_setup_version, 2);
    assert.equal(updated.onboarding_track, 'theses');
    const finished = await setOnboarded('another-new-user', true, 'portfolio');
    assert.equal(finished.onboarded, true);
    assert.equal(finished.onboarding_track, 'portfolio');
    await assert.rejects(updateUserSettings('invalid', { beta_setup_version: -1 }));
    await assert.rejects(updateUserSettings('invalid', { arbitrary_column: true }));
  });
  console.log('First-write settings: insert values, partial update preservation, onboarding, and validation passed');
} finally {
  await closeDb();
  rmSync(root, { recursive: true, force: true });
}
