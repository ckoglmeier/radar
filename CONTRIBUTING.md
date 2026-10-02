# Contributing

Use a supported Node version (20.16+ on 20.x, or 22.3+) and Python 3.9+. Run `npm ci`, then `npm test`. Tests require no portfolio, provider key or external database.

- `npm test` and `npm run test:local`: same complete manifest, each suite once, isolated default databases.
- `npm run test:fast`: small feedback loop used by the pre-commit hook.
- `npm run test:inventory`: check that every src/test-*.js and test_*.py appears exactly once.
- Existing named groups remain available, using the same isolation wrapper.
- Add new suites to scripts/test-manifest.json; do not add another duplicated shell chain.
- Live evaluation runners (`eval:*`) are separate and may cost money. They are not CI tests.

The runner removes only its own temporary directory, uses a sanitized child environment and does not load your .env. This is test isolation, not a security sandbox for untrusted code. Never directly run old database tests against a real workspace.

Run `npm run setup-hooks` to enable filename/content checks plus fast tests. The hook inspects staged bytes, handles whitespace in filenames and preserves failure exit codes. It is not a complete secret scanner: review your diff and never commit private documents, credentials or personal lenses.

CI runs for pull requests and main pushes, with superseded runs cancelled. Branch pushes without a PR do not run duplicate full suites; workflow_dispatch is available. Full tests still run for documentation changes to keep required-check behavior predictable.

Runtime packages use an explicit files allowlist. Verify `npm pack --dry-run --ignore-scripts` before release, including migrations, skills, Python modules and lens templates. Do not add an exports map without auditing the app's existing deep imports.
