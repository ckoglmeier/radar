# Private Assets implementation log

## Baseline

- Started: 2026-08-07
- Engine baseline: `b610979d2aa55062e9902edfd1fde40274905875`
- App baseline: `a1c1cf8` (`origin/main` fetched 2026-08-07)
- Plan: `RADAR_FUNDS_OTHER_ASSETS_IMPLEMENTATION_PLAN.md`
- Review disposition: R1–R7 and C1–C6 accepted

## W1.5 — Direct boundary hardening

Status: implemented and verified on the engine branch.

Changes:

- Scoped headline portfolio IRR to Direct-position cash flows.
- Scoped Kelly year-to-date deployment to Direct positions.
- Scoped thesis performance, thesis counts, and thesis IRR inputs to Direct positions.
- Excluded non-Direct linked evaluations from validation/discovery inputs.
- Made Beancount a Direct-only position/flow/valuation export while retaining unlinked account-level flows.
- Limited generic return recomputation to Direct positions.
- Kept Direct portfolio detail and reconciliation defects Direct-only; reconciliation reports intentionally excluded class counts.
- Replaced name-based Fund classification with a non-mutating review candidate surfaced by the AngelList importer.
- Added Fund, Employment Equity, and `merged` regression fixtures.

Verification:

- `npm run test:boundary` — passed.
- `npm run test:local` — passed.
- `git diff --check` — passed.

## W2a — Additive entity and position identity

Status: implemented and verified on the engine branch.

Changes:

- Added stable UUID `position_key` values to every investment and nullable
  `portfolio_entity_id` links without changing the legacy importer identity.
- Added `portfolio_entities` for operating companies, distinct fund vehicles,
  and future typed assets.
- Added a deterministic, dry-run identity audit with explicit source evidence,
  unresolved owner decisions, source/proposal hashes, and stale-manifest
  rejection.
- Made reviewed apply local-PGlite-only and atomic across the full manifest.
- Kept every Fund position as a separate vehicle proposal; names and adjacent
  vintages are never collapsed automatically.
- Excluded `merged` investments as link targets and traversed consolidation
  chains to the surviving position; missing mappings and cycles block apply.
- Migrated confirmed aliases to entity links while retaining legacy fallback
  behavior during the additive transition.
- Added entity/position/alias ordering and coverage to backup/restore.
- Kept `UNIQUE(company_name, invest_date)` intact for the current importers.

Verification:

- `npm run test:identity` — passed, including rollback, stale-manifest,
  idempotency, fund-vintage isolation, alias migration, and merged-chain tests.
- `npm run test:backup-restore` — passed.
- `npm run test:local` — passed.
- `git diff --check` — passed.

The next gated wave is W3: the Funds audit, typed fund ledger, document/privacy
foundation, backup coverage, and greenfield app surface.
