import { readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'scripts/test-manifest.json')));
function discover(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? discover(dir + '/' + entry.name)
      : /^(test-.*\.js|test_.*\.py)$/.test(entry.name) ? [dir + '/' + entry.name] : []);
}
const found = discover('src').sort();
if (JSON.stringify(found) !== JSON.stringify([...new Set(manifest.tests)].sort())
    || manifest.tests.length !== new Set(manifest.tests).size) {
  throw Error('Test manifest drift: register every src test exactly once in scripts/test-manifest.json');
}
for (const [name, paths] of Object.entries(manifest.groups)) {
  if (!paths.length || paths.some(p => !manifest.tests.includes(p))) throw Error('Invalid test group: ' + name);
}
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--list') {
  console.log(manifest.tests.join('\n'));
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== '--group' || !manifest.groups[args[1]])) {
  throw Error('Usage: test-runner.mjs [--list | --group NAME]');
}
const selected = args.length ? manifest.groups[args[1]] : manifest.tests;
const scratch = mkdtempSync(join(tmpdir(), 'radar-engine-tests-'));
// Never inherit database URLs, provider credentials, NODE_OPTIONS or dotenv paths.
const env = {
  PATH: process.env.PATH,
  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  DATABASE_URL: 'file:' + join(scratch, 'db'),
  RADAR_DATA_DIR: join(scratch, 'data'),
  CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
  DOTENV_CONFIG_PATH: join(scratch, 'absent.env'),
  PYTHONDONTWRITEBYTECODE: '1',
};
mkdirSync(env.RADAR_DATA_DIR);
let failed = false;
function run(binary, argv) {
  const result = spawnSync(binary, argv, { cwd: root, env, stdio: 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) {
    console.error('FAILED:', argv.join(' '), result.error?.message || result.signal || result.status);
    failed = true;
  }
}
try {
  for (const [index, test] of selected.entries()) {
    const caseRoot = join(scratch, String(index));
    mkdirSync(caseRoot);
    env.DATABASE_URL = 'file:' + join(caseRoot, 'db');
    env.RADAR_DATA_DIR = join(caseRoot, 'data');
    mkdirSync(env.RADAR_DATA_DIR);
    console.log('\nTEST ' + test);
    const before = failed;
    failed = false;
    // The reviewed fast group is DB-free; any accidental database access
    // still points at this empty disposable workspace, never the user's DB.
    if (args[1] !== 'fast') run(process.execPath, ['src/cli.js', 'db:migrate']);
    if (!failed) run(test.endsWith('.py') ? 'python3' : process.execPath, [test]);
    failed = failed || before;
    rmSync(caseRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(selected.length + ' registered suites selected; ' + (failed ? 'FAIL' : 'PASS'));
process.exitCode = failed ? 1 : 0;
