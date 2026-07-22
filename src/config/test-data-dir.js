import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirPaths, ensureDataDir, resolveDataDir, resolveLegacyRadarDir } from './data-dir.js';

const home = join(tmpdir(), 'radar-home');

assert.equal(resolveDataDir({ platform: 'darwin', env: {}, home }), join(home, 'Library', 'Application Support', 'Radar'));
assert.equal(
  resolveDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, home }),
  join('C:\\Users\\test\\AppData\\Roaming', 'Radar'),
);
assert.equal(resolveDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home }), join('/data', 'radar'));
assert.equal(resolveDataDir({ platform: 'linux', env: {}, home }), join(home, '.local', 'share', 'radar'));
assert.equal(
  resolveDataDir({ platform: 'darwin', env: { RADAR_DATA_DIR: './scratch-radar' }, home }),
  join(process.cwd(), 'scratch-radar'),
);
assert.equal(resolveLegacyRadarDir({ home }), join(home, '.radar'));

const scratch = mkdtempSync(join(tmpdir(), 'radar-data-dir-'));
try {
  const options = { env: { RADAR_DATA_DIR: join(scratch, 'Radar') } };
  const paths = ensureDataDir(options);
  assert.deepEqual(paths, dataDirPaths(options));
  for (const key of ['root', 'db', 'documents', 'backups', 'lenses', 'logs']) {
    assert.equal(existsSync(paths[key]), true, `${key} directory exists`);
  }
  assert.equal(existsSync(paths.config), false, 'config remains create-on-demand');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('data-dir: all tests passed');
