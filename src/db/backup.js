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

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { query, isPgliteActive } from './index.js';

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
  'council_runs',
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

const FORMAT_VERSION = 2;
const BINARY_TAG = '$radar_bytes_base64';

function encodeValue(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { [BINARY_TAG]: Buffer.from(value).toString('base64') };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, encodeValue(child)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function decodeValue(value) {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value[BINARY_TAG] === 'string') {
      return Buffer.from(value[BINARY_TAG], 'base64');
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, decodeValue(child)]),
    );
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

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
    format_version: FORMAT_VERSION,
    dumped_at: new Date().toISOString(),
    server_version: version.split(' ').slice(0, 2).join(' '),
    tables: {},
  };

  let totalRows = 0;
  for (const table of ordered) {
    const rows = await query(`SELECT * FROM ${table}`);
    dump.tables[table] = rows.map(encodeValue);
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

/**
 * Restore a v2 backup into a migrated local PGlite database.
 * Every application table is replaced inside one transaction so a failed
 * restore leaves the existing workspace unchanged.
 */
export async function restoreDatabase({ file } = {}) {
  if (!file) throw new Error('restore file is required');
  if (!(await isPgliteActive())) {
    throw new Error('restoreDatabase currently supports local PGlite databases only');
  }

  const dump = JSON.parse(readFileSync(file, 'utf8'));
  if (dump.format_version !== FORMAT_VERSION || !dump.tables || typeof dump.tables !== 'object') {
    throw new Error(`unsupported Radar backup format: ${dump.format_version ?? 'legacy'}`);
  }

  const liveTables = new Set((await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )).map(row => row.table_name));
  const restoreTables = Object.keys(dump.tables).filter(table => table !== 'schema_migrations');

  for (const table of restoreTables) {
    if (!liveTables.has(table)) throw new Error(`backup contains unknown table: ${table}`);
  }

  await query('BEGIN');
  try {
    if (restoreTables.length > 0) {
      await query(
        `TRUNCATE TABLE ${restoreTables.map(quoteIdentifier).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }

    const restored = [];
    for (const table of restoreTables) {
      const rows = dump.tables[table];
      if (!Array.isArray(rows)) throw new Error(`backup table is not an array: ${table}`);

      for (const encodedRow of rows) {
        const row = decodeValue(encodedRow);
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        await query(
          `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) ` +
          `VALUES (${placeholders.join(', ')})`,
          columns.map(column => row[column]),
        );
      }

      const idColumn = await query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'`,
        [table],
      );
      if (idColumn.length > 0) {
        const [{ sequence_name }] = await query(
          `SELECT pg_get_serial_sequence($1, 'id') AS sequence_name`,
          [table],
        );
        if (sequence_name) {
          await query(
            `SELECT setval($1::regclass, COALESCE(MAX(id), 1), COUNT(*) > 0)
             FROM ${quoteIdentifier(table)}`,
            [sequence_name],
          );
        }
      }
      restored.push({ table, rows: rows.length });
    }

    await query('COMMIT');
    return {
      tables: restored,
      totalRows: restored.reduce((total, table) => total + table.rows, 0),
    };
  } catch (error) {
    try {
      await query('ROLLBACK');
    } catch {
      // Preserve the restore error.
    }
    throw error;
  }
}
