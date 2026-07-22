import { homedir as osHomedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Resolve Radar's durable application-data directory. */
export function resolveDataDir({
  env = process.env,
  platform = process.platform,
  home = osHomedir(),
} = {}) {
  if (env.RADAR_DATA_DIR?.trim()) return resolve(env.RADAR_DATA_DIR);

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Radar');
  }

  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Radar');
  }

  return env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, 'radar')
    : join(home, '.local', 'share', 'radar');
}

export function resolveLegacyRadarDir({ home = osHomedir() } = {}) {
  return join(home, '.radar');
}

export function dataDirPaths(options) {
  const root = resolveDataDir(options);
  return {
    root,
    db: join(root, 'db'),
    documents: join(root, 'documents'),
    backups: join(root, 'backups'),
    lenses: join(root, 'lenses'),
    config: join(root, 'config.json'),
    logs: join(root, 'logs'),
  };
}

/** Create only directories; config.json remains create-on-demand. */
export function ensureDataDir(options) {
  const paths = dataDirPaths(options);
  for (const path of [
    paths.root,
    paths.db,
    paths.documents,
    paths.backups,
    paths.lenses,
    paths.logs,
  ]) {
    mkdirSync(path, { recursive: true });
  }
  return paths;
}
