// Lightweight schema migration runner.
//
// Migrations live in src/db/migrations/ as numbered SQL files (NNN_name.sql).
// A schema_migrations table tracks which have been applied. Running
// `radar db:migrate` applies all pending migrations in order.
//
// No down migrations. All DDL should use IF NOT EXISTS for idempotency so
// re-running after a partial failure is safe (Neon HTTP driver doesn't support
// multi-statement transactions).

import { readFileSync, readdirSync } from 'fs';
import { query } from './index.js';

const MIGRATIONS_DIR = new URL('./migrations', import.meta.url);

export async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY,
      name TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedVersions() {
  const rows = await query(`SELECT version FROM schema_migrations ORDER BY version`);
  return new Set(rows.map(r => r.version));
}

function getPendingMigrations(applied) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  const migrations = [];
  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (applied.has(version)) continue;
    migrations.push({
      version,
      name: file.replace(/\.sql$/, ''),
      filePath: new URL(file, MIGRATIONS_DIR + '/'),
    });
  }
  return migrations;
}

function splitStatements(sql) {
  // Split on semicolons at end of line, but respect $$ dollar-quoting
  const statements = [];
  let current = '';
  let inDollarQuote = false;

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();

    // Toggle dollar-quoting
    const dollarMatches = trimmed.match(/\$\$/g);
    if (dollarMatches) {
      // Odd number of $$ on a line toggles the state
      if (dollarMatches.length % 2 === 1) inDollarQuote = !inDollarQuote;
    }

    current += line + '\n';

    // Statement ends with ; at end of line, but only outside $$ blocks
    if (!inDollarQuote && /;\s*$/.test(trimmed)) {
      const stmt = current.trim().replace(/;\s*$/, '').trim();
      if (stmt.length > 0) statements.push(stmt);
      current = '';
    }
  }

  // Handle trailing statement without semicolon
  const last = current.trim().replace(/;\s*$/, '').trim();
  if (last.length > 0) statements.push(last);

  return statements;
}

export async function runMigrations() {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();
  const pending = getPendingMigrations(applied);

  if (pending.length === 0) {
    return { applied: 0, migrations: [] };
  }

  const results = [];
  for (const migration of pending) {
    const sql = readFileSync(migration.filePath, 'utf-8');
    const statements = splitStatements(sql);

    for (let i = 0; i < statements.length; i++) {
      try {
        await query(statements[i]);
      } catch (err) {
        throw new Error(
          `Migration ${migration.name} failed at statement ${i + 1}: ${err.message}`
        );
      }
    }

    await query(
      `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
      [migration.version, migration.name]
    );
    results.push(migration.name);
  }

  return { applied: results.length, migrations: results };
}
