// Local backup of the active database to a JSON file.
//
// Relies on query()'s no-ALS-scope fallback to DATABASE_URL (single-tenant
// only today — see src/db/index.js); must be revisited once multi-tenancy
// lands.
//
// Why JSON through the driver instead of pg_dump: installations can't be
// assumed to have a version-matched pg_dump (or any Postgres client tools),
// and the same code must back up PGlite, Neon, or Supabase identically.
// Schema is not dumped — it lives in the repo (schema.sql + migrations);
// this captures data only, table by table, in FK-safe insert order where
// known (unknown tables are appended alphabetically).
//
// Restore path: apply migrations to an empty database, then insert each
// table's rows in file order with parameterized INSERTs (objects/arrays
// re-stringified for JSONB columns). Deliberately not a command yet —
// restore is destructive and rare; see docs/phase9/RADAR_SUPABASE_AUTH_PLAN.md.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { query } from './index.js';

// Parents before children so a future restore can insert in file order.
const INSERT_ORDER = [
  'schema_migrations',
  'theses',
  'investments',
  'valuations',
  'cash_flows',
  'investment_events',
  'investment_theses',
  'pipeline_invites',
  'pipeline_events',
  'deal_evaluations',
  'decision_records',
  'rooms',
  'room_holdings',
  'room_pipeline',
  'room_views',
  'metric_views',
  'company_updates',
  'documents', // provenance artifacts; must follow all 4 of its possible parents (investments, pipeline_invites, company_updates, deal_evaluations) above
  'user_settings',
  'lens_config',
  'sync_runs',
  'pending_intake', // ephemeral preview/confirm staging; no FK dependents, kept last
];

export async function backupDatabase({ outDir = './backups' } = {}) {
  const tables = (await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )).map(r => r.table_name);

  const ordered = [
    ...INSERT_ORDER.filter(t => tables.includes(t)),
    ...tables.filter(t => !INSERT_ORDER.includes(t)).sort(),
  ];

  const [{ version }] = await query('SELECT version()');
  const dump = {
    dumped_at: new Date().toISOString(),
    server_version: version.split(' ').slice(0, 2).join(' '),
    tables: {},
  };

  let totalRows = 0;
  for (const table of ordered) {
    const rows = await query(`SELECT * FROM ${table}`);
    dump.tables[table] = rows;
    totalRows += rows.length;
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = join(outDir, `radar-backup-${stamp}.json`);
  writeFileSync(file, JSON.stringify(dump, null, 1));

  return {
    file,
    tables: ordered.map(t => ({ table: t, rows: dump.tables[t].length })),
    totalRows,
  };
}
