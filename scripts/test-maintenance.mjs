import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'radar-maintenance-fixture-'));
try {
  mkdirSync(join(scratch, 'scripts'));
  mkdirSync(join(scratch, 'src'));
  symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
  copyFileSync(resolve('scripts/test-runner.mjs'), join(scratch, 'scripts/test-runner.mjs'));
  writeFileSync(join(scratch, 'package.json'), '{"type":"module"}');
  writeFileSync(join(scratch, '.env'), 'DATABASE_URL=postgresql://do-not-connect/fixture\n');
  writeFileSync(join(scratch, 'src/cli.js'), '');
  writeFileSync(join(scratch, 'src/test-fixture.js'), `
    import 'dotenv/config';
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    assert.ok(process.env.DATABASE_URL.startsWith('file:'));
    assert.ok(process.env.RADAR_DATA_DIR.includes('radar-engine-tests-'));
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.OPENROUTER_API_KEY, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(existsSync(process.env.DOTENV_CONFIG_PATH), false);
    console.log('SCRATCH=' + process.env.RADAR_DATA_DIR);
  `);
  writeFileSync(join(scratch, 'scripts/test-manifest.json'), JSON.stringify({
    tests: ['src/test-fixture.js'], groups: { fast: ['src/test-fixture.js'] },
  }));
  const run = (...args) => spawnSync(process.execPath, ['scripts/test-runner.mjs', ...args], {
    cwd: scratch, encoding: 'utf8', env: { ...process.env,
      DATABASE_URL: 'postgresql://do-not-connect/fixture', RADAR_DATA_DIR: '/never-use',
      ANTHROPIC_API_KEY: 'synthetic', OPENAI_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic', NODE_OPTIONS: '--no-warnings',
    },
  });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(result.stdout.match(/SCRATCH=(.*)/)[1]), false, 'scratch cleaned');
  writeFileSync(join(scratch, 'src/test-fixture.js'), 'process.exit(7)');
  assert.equal(run().status, 1, 'child failure propagated');
  writeFileSync(join(scratch, 'src/test-missing.js'), '');
  assert.notEqual(run('--list').status, 0, 'unregistered suite rejected');
  assert.notEqual(run('--group', 'unknown').status, 0);

  copyFileSync(resolve('scripts/pre-commit.mjs'), join(scratch, 'scripts/pre-commit.mjs'));
  const git = (...args) => execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(scratch, 'private notes.csv'), 'synthetic');
  git('add', '--', 'private notes.csv');
  const hook = () => spawnSync(process.execPath, ['scripts/pre-commit.mjs'], { cwd: scratch, encoding: 'utf8' });
  result = hook();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private notes.csv/);
  git('rm', '--cached', '--', 'private notes.csv');
  writeFileSync(join(scratch, 'README.md'), 'synthetic');
  git('add', 'README.md');
  writeFileSync(join(scratch, 'scripts/test-runner.mjs'), 'process.exit(7)');
  assert.equal(hook().status, 7, 'hook preserves failed check status');
  writeFileSync(join(scratch, 'scripts/test-runner.mjs'), 'process.exit(0)');
  assert.equal(hook().status, 0);
  console.log('Maintenance fixtures: isolated env, cleanup, inventory drift, child failure and whitespace-safe hook passed');
} finally { rmSync(scratch, { recursive: true, force: true }); }
