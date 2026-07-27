import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const WORKSPACE_LEASE_FILENAME = '.radar-workspace.lock';

export function workspaceLeasePath(dataDir) {
  return join(dirname(resolve(dataDir)), WORKSPACE_LEASE_FILENAME);
}

export function readWorkspaceLease(dataDir) {
  const path = workspaceLeasePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const lease = JSON.parse(readFileSync(path, 'utf8'));
    return { ...lease, path };
  } catch {
    return { path, invalid: true };
  }
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function assertWorkspaceLease(
  dataDir,
  {
    token = process.env.RADAR_WORKSPACE_LEASE_TOKEN,
    processRunning = isProcessRunning,
  } = {},
) {
  const lease = readWorkspaceLease(dataDir);
  if (!lease) return null;
  if (token && lease.token === token) return lease;
  if (!lease.invalid && !processRunning(lease.pid)) return lease;

  const error = new Error(
    lease.invalid
      ? 'Radar workspace lock is unreadable. Close Radar before using this database.'
      : 'This Radar workspace is already open. Close the Radar app before running another process against it.',
  );
  error.code = 'RADAR_WORKSPACE_LOCKED';
  error.lease = lease;
  throw error;
}
