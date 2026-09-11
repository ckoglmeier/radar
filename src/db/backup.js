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
import { join, posix } from 'path';
import { query, isPgliteActive, withAtomicWrite } from './index.js';

// Parents before children so a future restore can insert in file order.
const INSERT_ORDER = [
  'schema_migrations',
  'theses',
  'portfolio_entities',
  'companies',
  'investing_entities',
  'entity_aliases',
  'entity_redirects',
  'identity_review_receipts',
  'fund_vehicle_profiles',
  'fund_profile_field_ownership',
  'company_fact_registry',
  'investments',
  'investment_source_identities',
  'investment_consolidations',
  'position_duplicate_reviews',
  'file_vault_entries',
  // Polymorphic attachment integrity is model-enforced, so documents can be
  // restored before typed records whose explicit source-document FKs need it.
  'documents',
  'vehicle_portfolio_snapshots',
  'vehicle_exposure_claims',
  'company_facts',
  'company_fact_field_ownership',
  'direct_acquisition_profiles',
  'employment_equity_issuer_profiles',
  'employment_equity_positions',
  'employment_equity_grants',
  'investment_lots',
  'company_aliases',
  'valuations',
  'cash_flows',
  'direct_position_lifecycle_events',
  'investment_events',
  'investment_theses',
  'pipeline_invites',
  'pipeline_events',
  'council_runs',
  'ad_hoc_reviews',
  'council_run_events',
  'council_run_dispatch',
  'deal_evaluations',
  'council_followup_questions',
  'decision_records',
  'rooms',
  'room_holdings',
  'fund_profiles',
  'fund_notices',
  'fund_transactions',
  'employment_equity_events',
  'investment_lot_allocations',
  'employment_equity_issuer_marks',
  'employment_equity_valuation_details',
  'issuer_disclosures',
  'room_pipeline',
  'room_views',
  'metric_views',
  'attention_dismissals',
  'company_updates',
  'user_settings',
  'lens_config',
  'lens_framework_versions',
  'annual_deployment_plan_versions',
  'workspace_sizing_versions',
  'sync_runs',
  'investment_updates',
  'command_proposals',
  'command_threads',
  'command_receipts',
  'command_messages',
  'command_confirmations',
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

async function selfReferenceColumns(table) {
  return (await query(`
    SELECT DISTINCT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_schema = tc.constraint_schema
       AND ccu.constraint_name = tc.constraint_name
     WHERE tc.table_schema = 'public'
       AND tc.table_name = $1
       AND tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_schema = tc.table_schema
       AND ccu.table_name = tc.table_name
     ORDER BY kcu.column_name
  `, [table])).map(row => row.column_name);
}

async function generatedColumns(table) {
  return new Set((await query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND is_generated = 'ALWAYS'
  `, [table])).map(row => row.column_name));
}

async function jsonColumns(table) {
  return new Set((await query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND data_type IN ('json', 'jsonb')
  `, [table])).map(row => row.column_name));
}

function rowsWithDeferredSelfReferences(encodedRows, selfReferences) {
  if (selfReferences.length === 0) {
    return encodedRows.map(encodedRow => ({ row: decodeValue(encodedRow), references: [] }));
  }
  const remaining = encodedRows.map(encodedRow => decodeValue(encodedRow));
  const rowIds = new Set(remaining.map(row => String(row.id)));
  const inserted = new Set();
  const ordered = [];
  while (remaining.length > 0) {
    let index = remaining.findIndex(row => selfReferences.every(column => {
      const parentId = row[column] == null ? null : String(row[column]);
      return parentId == null || !rowIds.has(parentId) || inserted.has(parentId);
    }));
    let references = [];
    if (index === -1) {
      // A true self-reference cycle cannot be inserted in dependency order.
      // Break only the blocking edges, then restore them after all rows exist.
      index = 0;
      references = selfReferences
        .filter(column => rowIds.has(String(remaining[index][column])) && !inserted.has(String(remaining[index][column])))
        .map(column => ({ column, value: remaining[index][column] }));
    }
    const [row] = remaining.splice(index, 1);
    for (const { column } of references) row[column] = null;
    ordered.push({ row, references });
    inserted.add(String(row.id));
  }
  return ordered;
}

export async function createDatabaseBackupPayload({ includeLocalOnly = false } = {}) {
  if (!includeLocalOnly) {
    const [restricted] = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM documents WHERE sync_policy = 'local_only') AS documents,
        (SELECT COUNT(*)::int FROM vehicle_portfolio_snapshots WHERE sync_policy = 'local_only') AS vehicle_snapshots,
        (SELECT COUNT(*)::int FROM company_facts WHERE sync_policy = 'local_only') AS company_facts
    `);
    const restrictedCount = Number(restricted?.documents || 0)
      + Number(restricted?.vehicle_snapshots || 0)
      + Number(restricted?.company_facts || 0);
    if (restrictedCount > 0) {
      if (
        Number(restricted?.documents || 0) > 0 &&
        Number(restricted?.vehicle_snapshots || 0) === 0 &&
        Number(restricted?.company_facts || 0) === 0
      ) {
        throw new Error(
          `backup denied: ${restricted.documents} local_only document(s) are not permitted to leave the desktop workspace`,
        );
      }
      throw new Error(
        `backup denied: ${restrictedCount} local_only record(s) are not permitted to leave the desktop workspace `
        + `(documents: ${restricted.documents}, vehicle snapshots: ${restricted.vehicle_snapshots}, Company facts: ${restricted.company_facts})`,
      );
    }
  }
  const tables = (await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  )).map(r => r.table_name);

  if (tables.includes('documents')) {
    const [syncPolicyColumn] = await query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'documents'
           AND column_name = 'sync_policy'
      ) AS present
    `);
    if (syncPolicyColumn?.present && !includeLocalOnly) {
      const [restrictedDocuments] = await query(`
        SELECT COUNT(*)::int AS count FROM documents WHERE sync_policy = 'local_only'
      `);
      if (Number(restrictedDocuments?.count || 0) > 0) {
        throw new Error(
          `backup denied: ${restrictedDocuments.count} local_only document(s) are not permitted to leave the desktop workspace`,
        );
      }
    }
  }

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

  return {
    content: JSON.stringify(dump, null, 1),
    tables: ordered.map(t => ({ table: t, rows: dump.tables[t].length })),
    totalRows,
  };
}

function jsonClone(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    return JSON.parse(serialized);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
}

function validateSnapshotLenses(value) {
  if (!Array.isArray(value)) throw new TypeError('pre-migration lenses must be an array');
  return value.map((file, index) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).sort().join(',') !== 'content_base64,path') {
      throw new TypeError(`pre-migration lens ${index} has an invalid shape`);
    }
    const path = posix.normalize(String(file.path || ''));
    if (!path || path === '..' || path.startsWith('../') || posix.isAbsolute(path)) {
      throw new TypeError(`pre-migration lens ${index} has an unsafe path`);
    }
    const content = String(file.content_base64 || '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      throw new TypeError(`pre-migration lens ${index} is not base64`);
    }
    return { path, content_base64: content };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Build an old-schema-compatible workspace bundle for Desktop encryption.
 * This function never runs migrations and discovers tables/columns dynamically.
 * The Desktop must encrypt and authenticate the returned bundle before applying
 * a pending migration.
 */
export async function createPreMigrationSnapshot({
  safeConfig = {},
  lenses = [],
  now = new Date(),
} = {}) {
  const config = jsonClone(safeConfig, 'pre-migration safe config');
  const safeLenses = validateSnapshotLenses(lenses);
  // This snapshot remains inside the Desktop migration-safety path and is
  // encrypted before it is written. It must preserve local-only bytes too;
  // ordinary user-initiated backup/export policy remains fail-closed.
  const database = await createDatabaseBackupPayload({ includeLocalOnly: true });
  const parsedDatabase = JSON.parse(database.content);
  const inventory = {
    tables: database.tables.map(table => ({ table: table.table, rows: Number(table.rows) })),
    total_rows: Number(database.totalRows),
    document_rows: Number(database.tables.find(table => table.table === 'documents')?.rows || 0),
  };
  const bundle = {
    format_version: 1,
    kind: 'radar-pre-migration-snapshot',
    created_at: new Date(now).toISOString(),
    database: database.content,
    config,
    lenses: safeLenses,
  };

  // Validate the complete snapshot without assuming a post-migration schema.
  const roundTrip = JSON.parse(JSON.stringify(bundle));
  const roundTripDatabase = JSON.parse(roundTrip.database);
  if (roundTrip.format_version !== 1
      || roundTrip.kind !== 'radar-pre-migration-snapshot'
      || roundTripDatabase.format_version !== parsedDatabase.format_version
      || Object.keys(roundTripDatabase.tables || {}).length !== inventory.tables.length
      || inventory.tables.reduce((sum, table) => sum + table.rows, 0) !== inventory.total_rows) {
    throw new Error('pre-migration snapshot validation failed');
  }
  return { bundle: roundTrip, inventory };
}

export async function backupDatabase({ outDir = './backups' } = {}) {
  const payload = await createDatabaseBackupPayload();
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = join(outDir, `radar-backup-${stamp}.json`);
  writeFileSync(file, payload.content);

  return {
    file,
    tables: payload.tables,
    totalRows: payload.totalRows,
  };
}

/**
 * Restore a v2 backup into a migrated local PGlite database.
 * Every application table is replaced inside one transaction so a failed
 * restore leaves the existing workspace unchanged.
 */
export async function restoreDatabase({ file, content } = {}) {
  if (!file && content == null) throw new Error('restore file or content is required');
  if (!(await isPgliteActive())) {
    throw new Error('restoreDatabase currently supports local PGlite databases only');
  }

  const dump = JSON.parse(content == null ? readFileSync(file, 'utf8') : String(content));
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

  return withAtomicWrite(async () => {
    if (restoreTables.length > 0) {
      await query(
        `TRUNCATE TABLE ${restoreTables.map(quoteIdentifier).join(', ')} RESTART IDENTITY CASCADE`,
      );
    }

    const restored = [];
    for (const table of restoreTables) {
      const rows = dump.tables[table];
      if (!Array.isArray(rows)) throw new Error(`backup table is not an array: ${table}`);
      const selfReferences = await selfReferenceColumns(table);
      const generated = await generatedColumns(table);
      const json = await jsonColumns(table);
      const deferredSelfReferences = [];

      for (const { row, references } of rowsWithDeferredSelfReferences(rows, selfReferences)) {
        if (references.length > 0) {
          if (row.id == null) throw new Error(`self-referencing backup table has no id: ${table}`);
          deferredSelfReferences.push({ id: row.id, references });
        }
        // Generated columns are derivable schema state. Older and current
        // backups may contain their selected values, but restore must let the
        // destination database recompute them.
        const columns = Object.keys(row).filter(column => !generated.has(column));
        if (columns.length === 0) continue;
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        await query(
          `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) ` +
          `VALUES (${placeholders.join(', ')})`,
          columns.map(column => (
            json.has(column) && row[column] != null
              ? JSON.stringify(row[column])
              : row[column]
          )),
        );
      }

      for (const deferred of deferredSelfReferences) {
        const assignments = deferred.references.map(
          ({ column }, index) => `${quoteIdentifier(column)} = $${index + 1}`,
        );
        await query(
          `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} ` +
          `WHERE id = $${deferred.references.length + 1}`,
          [...deferred.references.map(reference => reference.value), deferred.id],
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

    return {
      tables: restored,
      totalRows: restored.reduce((total, table) => total + table.rows, 0),
    };
  });
}
