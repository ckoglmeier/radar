import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, withTenant, closeDb } from './index.js';
import { runMigrations } from './migrate.js';
const root = mkdtempSync(join(tmpdir(), 'radar-public-bootstrap-'));
try {
  await withTenant(`file:${join(root, 'public')}`, async () => {
    await runMigrations({ seedLegacyTheses: false });
    assert.equal((await query('SELECT * FROM theses')).length, 0);
    await query("INSERT INTO theses (name, description) VALUES ('User thesis', 'User-authored belief')");
    await runMigrations({ seedLegacyTheses: false });
    assert.equal((await query('SELECT * FROM theses'))[0].description, 'User-authored belief');
  });
  await withTenant(`file:${join(root, 'local')}`, async () => {
    await runMigrations();
    const before = await query('SELECT id, name, description FROM theses ORDER BY id');
    assert.equal(before.length, 4);
    await runMigrations({ seedLegacyTheses: false });
    assert.deepEqual(await query('SELECT id, name, description FROM theses ORDER BY id'), before);
  });
  console.log('Public bootstrap: no starter theses; user-authored and legacy workspaces preserved');
} finally { await closeDb(); rmSync(root, { recursive: true, force: true }); }
