# Engine maintenance roadmap

This file is the current engine roadmap; older speculative lists in Git history are not implementation instructions.

## Already present

Council grading, direct/fund/employment ledgers, cash-flow tracking, document intake, migrations, evidence provenance and host-schema primitives exist. The separate radar-app repository owns the desktop/web UI, onboarding, connection guides, accounts and store distribution. Do not build another UI inside this engine.

## Near-term engineering

- Keep all regression suites registered and synthetic; preserve migration/backup/transaction and provenance gates.
- Define stable consumer interfaces before incrementally splitting the large CLI and Council orchestrator.
- Evaluate a proper transactional remote adapter only with dedicated hosted acceptance coverage.
- Maintain explicit package contents, immutable app pins and reproducible release evidence.

## Product backlog requiring scoped approval

Connector architecture/additional import sources; founder submission; proactive sourcing/watchlists; pipeline reconciliation; missed-opportunity analysis; forward deployment reserves; cash-flow forecasting; community lens sharing. These are ideas, not enabled features or authorization for live account access.

## Not part of this maintenance patch

No scoring/model-policy changes, no personal portfolio cleanup, no migration edits, no live data or paid calls, and no app RC engine-pin replacement. Large module refactors are deferred until after release acceptance.
