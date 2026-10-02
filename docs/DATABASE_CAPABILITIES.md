# Database capabilities

The engine is local-first. A PostgreSQL-style schema does not mean all adapters support all workflows.

| Capability | Local PGlite | Neon HTTP |
|---|---|---|
| Parameterized queries | Supported | Adapter exists; requires compatible Neon HTTP endpoint |
| Callback transaction via withAtomicWrite | Supported, serialized and re-entrant | Unsupported; fails with ATOMIC_WRITE_UNAVAILABLE before callback |
| Full transactional command/intake workflows | Supported | Not supported |
| Generic PostgreSQL wire protocol | Not applicable | Not implemented |

Use `DATABASE_URL=file:./radar.db` for complete local functionality. This points to a directory, not a portable single-file SQLite database. Preserve normal workspace ownership, backup and migration rules.

Read-only/individual query compatibility is not certification of every remote report, migration or write. Remote parity needs a real transactional driver and its own acceptance suite; never fake atomicity with independent HTTP statements. Existing fail-closed behavior is intentional.

The test runner ignores your configured database and creates disposable local databases. These tests do not establish hosted/Postgres compatibility.
