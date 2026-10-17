# Changelog

## 2.4.4-daffy.5 — 2026-10-17 (local, unpublished)

- Correct Earned Equity annual cash comparisons to use modeled cash periods,
  including the horizon cap and explicitly modeled post-service pay. Calculator
  version 1.2.1 records the denominator without changing stored snapshots.
- Paid gifts inherit their linked request/pledge purpose when no payment-specific
  purpose is supplied; explicit overrides remain intact.
- Verified 102 calculator cases and the Giving contract, command, timezone,
  immutable snapshot, backup/restore, DAF and workspace-isolation suites using
  disposable data. No public release or personal-data fixtures.

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
