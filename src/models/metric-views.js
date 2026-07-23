import { query } from '../db/index.js';
import { validateMetricQuery } from '../metrics/contract.js';

function normalizeName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('metric view name must be non-empty');
  }
  if (name.trim().length > 120) {
    throw new TypeError('metric view name must be 120 characters or fewer');
  }
  return name.trim();
}

function normalizeRow(row) {
  if (!row) return null;
  return { ...row, query: validateMetricQuery(row.query) };
}

export async function createMetricView({ name, query: metricQuery } = {}) {
  const rows = await query(`
    INSERT INTO metric_views (name, query)
    VALUES ($1, $2::jsonb)
    RETURNING *
  `, [normalizeName(name), JSON.stringify(validateMetricQuery(metricQuery))]);
  return normalizeRow(rows[0]);
}

export async function listMetricViews() {
  const rows = await query(`
    SELECT * FROM metric_views
    ORDER BY updated_at DESC, id DESC
  `);
  return rows.map(normalizeRow);
}

export async function getMetricView(id) {
  const rows = await query(
    `SELECT * FROM metric_views WHERE id = $1 LIMIT 1`,
    [id],
  );
  return normalizeRow(rows[0]);
}

export async function updateMetricView(id, fields = {}) {
  const clauses = [];
  const params = [];
  if ('name' in fields) {
    params.push(normalizeName(fields.name));
    clauses.push(`name = $${params.length}`);
  }
  if ('query' in fields) {
    params.push(JSON.stringify(validateMetricQuery(fields.query)));
    clauses.push(`query = $${params.length}::jsonb`);
  }
  if (clauses.length === 0) throw new TypeError('no metric view fields to update');
  params.push(id);

  const rows = await query(`
    UPDATE metric_views
    SET ${clauses.join(', ')}, updated_at = NOW()
    WHERE id = $${params.length}
    RETURNING *
  `, params);
  if (rows.length === 0) throw new Error(`metric view not found: ${id}`);
  return normalizeRow(rows[0]);
}

export async function deleteMetricView(id) {
  const rows = await query(
    `DELETE FROM metric_views WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
