# Migration Conventions

## File naming
- `NNN_descriptive_name.sql` — zero-padded 3-digit prefix, snake_case description.
- Next migration: increment the highest existing number.

## Safety rules
1. **One risky change per migration.** If a migration has both DDL and data manipulation, split them into separate files so a partial failure doesn't leave data in an inconsistent state.
2. **All DDL uses `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.** This makes re-running a partially-applied migration safe.
3. **No down migrations.** Corrections are forward-only (new migration that reverses the change).
4. **No multi-statement transactions.** The Neon HTTP driver executes statements individually. A failure mid-migration leaves the DB partially migrated — `IF NOT EXISTS` guards make this recoverable.
5. **Data backfills go through CLI commands, not migrations.** Use `radar import recompute` or a dedicated command rather than INSERT/UPDATE in a migration file. This keeps migrations purely structural (DDL).

## Comment header
Every migration should start with a comment block:
```sql
-- Migration NNN: short description
-- Why: one-line rationale for the change.
```

## Dollar-quoting
The migration runner (`src/db/migrate.js`) handles `$$`-delimited PL/pgSQL blocks (triggers, functions). Use `$$` for any procedural SQL.
