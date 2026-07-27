import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWorkspaceLease,
  readWorkspaceLease,
  workspaceLeasePath,
} from './workspace-lease.js';

const root = mkdtempSync(join(tmpdir(), 'radar-workspace-lease-'));
const dataDir = join(root, 'db');
const path = workspaceLeasePath(dataDir);

try {
  assert.equal(readWorkspaceLease(dataDir), null);
  assert.equal(assertWorkspaceLease(dataDir), null);

  writeFileSync(path, JSON.stringify({ pid: process.pid, token: 'owner' }));
  assert.equal(assertWorkspaceLease(dataDir, { token: 'owner' }).token, 'owner');
  assert.throws(
    () => assertWorkspaceLease(dataDir, { token: 'other' }),
    error => error.code === 'RADAR_WORKSPACE_LOCKED',
  );
  assert.throws(
    () => assertWorkspaceLease(dataDir, { token: null }),
    /already open/,
  );

  writeFileSync(path, JSON.stringify({ pid: 99999999, token: 'stale' }));
  assert.equal(
    assertWorkspaceLease(dataDir, { processRunning: () => false }).token,
    'stale',
  );

  writeFileSync(path, '{not-json');
  assert.throws(
    () => assertWorkspaceLease(dataDir, { processRunning: () => false }),
    error => error.code === 'RADAR_WORKSPACE_LOCKED',
  );

  console.log('workspace lease: 7/7 passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
