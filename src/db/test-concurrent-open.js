import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'radar-concurrent-open-'));
process.env.DATABASE_URL = `file:${join(scratch, 'db')}`;
const { query, withTenant, closeDb } = await import('./index.js');
const url = process.env.DATABASE_URL;
try {
  await query('CREATE TABLE upload_probe (id integer PRIMARY KEY)');
  await closeDb();
  // Cold default-driver and tenant-scoped requests race during app startup.
  await Promise.all(Array.from({ length: 8 }, (_, n) => n % 2
    ? withTenant(url, () => query('SELECT 1')) : query('SELECT 1')));
  await query('INSERT INTO upload_probe VALUES (1)');
  assert.deepEqual(await withTenant(url, () => query('SELECT id FROM upload_probe')), [{ id: 1 }],
    'A scoped commit must see the upload written through the default driver');
  await withTenant(url, () => query('INSERT INTO upload_probe VALUES (2)'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM upload_probe'))[0].n, 2);
  await closeDb();
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM upload_probe'))[0].n, 2,
    'Both writes survive closing and reopening the single instance');
  console.log('Concurrent default/scoped database open: visibility and persistence passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
