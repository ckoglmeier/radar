// Audit-trail helper for ingester runs.
//
// Wrap an ingester body in `withSyncRun(source, notes, fn)` and a row will be
// inserted into `sync_runs` (status pending → completed/failed) with counts +
// error JSON. Use this for any importer that processes more than a handful of
// rows so partial failures aren't lost to terminal scrollback.
//
// The wrapped function receives `{ runId }` and must return an object that may
// include any of: { records_seen, records_new, records_changed, errors,
// error_details }. Whatever it returns is also returned to the caller verbatim
// (with `runId` injected).

import { query } from './index.js';

// status + error_details columns are created by migration 003_sync_runs_status_columns.sql.
// Run `radar db:migrate` if they don't exist yet.

export async function withSyncRun(source, notes, fn) {

  const inserted = await query(
    `INSERT INTO sync_runs (source, notes, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [source, notes || null]
  );
  const runId = inserted[0].id;

  let result;
  try {
    result = await fn({ runId });
  } catch (err) {
    await query(
      `UPDATE sync_runs
          SET completed_at = NOW(),
              status = 'failed',
              errors = COALESCE(errors, 0) + 1,
              error_details = $1
        WHERE id = $2`,
      [JSON.stringify({ fatal: err.message, stack: err.stack }), runId]
    );
    throw err;
  }

  const seen = result?.records_seen ?? result?.total ?? 0;
  const newCount = result?.records_new ?? result?.inserted ?? 0;
  const changedCount = result?.records_changed ?? result?.updated ?? 0;
  const errorCount = result?.errors ?? 0;
  const errorDetails = result?.error_details ?? result?.errorDetails ?? null;

  await query(
    `UPDATE sync_runs
        SET completed_at = NOW(),
            status = $1,
            records_seen = $2,
            records_new = $3,
            records_changed = $4,
            errors = $5,
            error_details = $6
      WHERE id = $7`,
    [
      errorCount > 0 ? 'completed_with_errors' : 'completed',
      seen,
      newCount,
      changedCount,
      errorCount,
      errorDetails ? JSON.stringify(errorDetails) : null,
      runId,
    ]
  );

  return { ...result, runId };
}
