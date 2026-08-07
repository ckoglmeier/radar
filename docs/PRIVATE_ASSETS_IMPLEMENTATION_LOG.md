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

The next gated wave is W2a: additive entity/position identity with the legacy
`UNIQUE(company_name, invest_date)` constraint left intact.
