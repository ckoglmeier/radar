# Changelog

## 2.4.0-assessment-update.2 — 2026-10-01

Engine maintenance candidate based on a9034ef. Does not replace Radar RC3's pinned assessment-update.1 archive.

- Register all source regression suites in one manifest; isolate npm test runs from configured databases, dotenv and provider credentials, with a fresh default database for each suite.
- Keep a fast pre-commit group and full CI coverage; cancel superseded CI and avoid duplicate branch-push/PR runs.
- Replace shell-specific hook logic with staged-byte checks that handle whitespace and propagate failures.
- Refresh stale migration test fixtures without changing migrations or runtime behavior.
- Define package contents and verify an unpacked CLI; exclude development tests and historical evaluation output.
- Clarify PGlite/Neon capability boundaries, supported Node versions, contributor workflow and engine/app roadmap.

No runtime scoring, provider routing, database migration or app-pin changes. Large module refactors are deferred.

## 2.4.0-live-assessment.0 — 2026-09-19

Prerelease candidate; not published. This additive feature advances the Git release series from v2.3.11 to the next minor version. Package metadata is now aligned with that series (older releases retained stale 1.0.0 metadata).

- Add the independently versioned `@radar/live-assessment` 0.1.1 package: validated, source-attributed assessment changes and revision history.
- Add migration 078 for durable conversational assessment sessions and turns, atomic completion, idempotent admission, and immutable finished turns.
- Include assessment records in backup and restore.
- Preserve existing inference routes, saved Council evaluations, and scoring policy.

### Upgrade and provenance

Candidate source builds on ccb52d80251c7ad765999e2731dec56b4281c31c, which reconciles shipped migration identities and incorporates the document-compaction changes from the v2.3.11 line. Do not merge the older numbered compaction migrations into this branch. Apply migrations through the engine migration runner after backup; do not manually renumber them.

Consumers must pin the exact release commit and lockfile integrity. The candidate archive is for local validation; production packaging still requires the immutable Git pin. Stable v2.4.0 and public publication remain pending release acceptance.

Validation: shared assessment contract tests, disposable-database admission and concurrency tests, backup/restore roundtrip, app integration tests, and both app production builds. Live-provider acceptance remains pending.
