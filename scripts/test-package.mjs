import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'radar-package-check-'));
try {
  const [pack] = JSON.parse(execFileSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', scratch, '--cache', join(scratch, 'cache'),
  ], { encoding: 'utf8' }));
  const files = new Set(pack.files.map(f => f.path));
  for (const file of ['src/cli.js', 'src/db/index.js', 'src/analytics/kelly.py',
    'src/analytics/__main__.py', 'skills/investment-grading/SKILL.md',
    'lenses/_template/manifest.json', 'src/config/bet-sizing.json.example',
    'docs/COUNCIL_AUTH.md', 'updates/README.md']) {
    assert.ok(files.has(file), 'required runtime asset: ' + file);
  }
  for (const file of readdirSync('src/db/migrations')) {
    assert.ok(files.has('src/db/migrations/' + file), 'migration retained: ' + file);
  }
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)test\/|\.test\.mjs$/);
    assert.doesNotMatch(file, /(^|\/)(test-[^/]+\.js|test_[^/]+\.py)$|^hooks\/|^CLAUDE|\/test-fixtures\/|evals\/results\//);
    assert.ok(!['src/config/bet-sizing.json', 'src/config/lead-prefixes.json', '.env'].includes(file));
  }
  mkdirSync(join(scratch, 'unpacked'));
  execFileSync('tar', ['-xzf', join(scratch, pack.filename), '-C', join(scratch, 'unpacked')]);
  const root = join(scratch, 'unpacked/package');
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
  const help = execFileSync(process.execPath, ['src/cli.js', '--help'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH,
      RADAR_DATA_DIR: join(scratch, 'data'), DOTENV_CONFIG_PATH: join(scratch, 'absent.env') },
  });
  assert.match(help, /Usage:/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version,
    JSON.parse(readFileSync('package.json')).version);
  console.log('Packed asset allowlist, all migrations, private-file exclusions and unpacked CLI smoke passed: ' + pack.entryCount + ' files');
} finally { rmSync(scratch, { recursive: true, force: true }); }
