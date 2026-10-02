import { execFileSync, spawnSync } from 'node:child_process';

const paths = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACR', '-z'])
  .toString().split('\0').filter(Boolean);
const blocked = [];
for (const path of paths) {
  const fixture = /^(src\/models\/test-fixtures\/|src\/sync\/test-fixtures\/)/.test(path);
  const sensitive = /\.(pdf|csv|xlsx|xls)$|research.*\.md$|angellist.*\.json$|deal-log|\.env|credentials|secret/i.test(path);
  if (sensitive && path !== '.env.example' && !fixture) blocked.push(path);
  const bytes = execFileSync('git', ['show', ':' + path]);
  if (!bytes.includes(0) && /(TVPI|DPI|IRR|valuation_cap|invested.*\$[0-9])/i.test(bytes.toString())
      && !/^(src\/|hooks\/|scripts\/|docs\/|package.*\.json$|README\.md$|CLAUDE\.md$|LICENSE|pyproject\.toml$)/.test(path)) {
    blocked.push(path);
  }
}
if (blocked.length) {
  console.error('Blocked: review potentially sensitive staged files:\n' + [...new Set(blocked)].map(p => JSON.stringify(p)).join('\n'));
  process.exit(1);
}
if (paths.length) {
  const result = spawnSync(process.execPath, ['scripts/test-runner.mjs', '--group', 'fast'], { stdio: 'inherit' });
  process.exit(result.error ? 1 : result.status ?? 1);
}
