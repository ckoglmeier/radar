# Engine maintenance verification

Maintenance version: `2.4.0-assessment-update.2`, based on `a9034efd5248a6cd934911a2382e5d143a1bd5f1`.

## Scope

Test isolation and inventory, stale migration fixtures, portable pre-commit checks,
CI deduplication/cancellation, package contents, and contributor/database documentation.
No runtime engine modules, SQL migrations, scoring rules, or provider routing changed.
Large-module refactoring is deferred.

## Local evidence

Verified on macOS with Node 25.9.0:

- `npm test`: 106 registered suites passed, following maintenance-runner self-tests.
- `npm run test:fast`: 7 suites passed.
- `npm run test:backup-restore`: 3 suites passed.
- `npm run test:maintenance`: environment isolation, actual dotenv loading, manifest
  drift, failure propagation, and staged-file hook fixtures passed.
- `npm run test:live-assessment`: 4 contract tests passed.
- `npm run test:package`: 255-file archive passed runtime-asset and migration
  inclusion, private/test-file exclusion, and unpacked CLI help checks.
- `git diff --check`, Node script syntax checks, and `sh -n hooks/pre-commit`: passed.

The first runs exposed shared-database test contamination and obsolete migration
fixture expectations. Each suite now receives a fresh disposable database; the
fixtures use real migration identities and current migration inventory. Tests were
not removed to obtain a passing result.

Dependencies were reused from the existing checkout; a clean Linux/Node 20 CI run
is still required. These local results do not claim hosted-database, packaged-app,
or live-provider acceptance. No live user database or provider calls were used.

## RC3 boundary

The app's `1.0.0-rc.3` remains pinned to its existing
`vendor/radar-2.4.0-assessment-update.1.tgz`, SHA-256:

`7bad504a3b5b615bef56b0c21a78a26abab724521652cf18a917d4bf2d8ffc42`

The archive hash was rechecked after the full suite. No app dependency, lockfile,
installer, or public download was changed. This maintenance branch is a separate
engine candidate; adoption requires an explicit repin and app regression tests.
No npm publication is part of this maintenance verification.
