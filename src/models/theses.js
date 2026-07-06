/**
 * Thesis writer — the cloud lens's editable thesis store.
 *
 * Theses live in the theses table (one store, no file/DB sync). lens_thesis_id
 * is the stable slug: it's the `id` of the assembled thesis object and the key
 * tagging-rules.json references. Renames are a column update, so tags
 * (investment_theses) and thesisPerformance history keep their FK.
 *
 * See RADAR_CLOUD_LENS_ARCHITECTURE.md §5. Follows the models/ convention.
 */

import { query } from '../db/index.js';

const CONTENT_FIELDS = [
  'belief', 'proves_true', 'proves_false', 'open_question',
  'conviction_now', 'conviction_entry', 'qualifications', 'exclusions',
  'conviction_signal',
];

const JSONB_FIELDS = new Set(['qualifications', 'exclusions']);
const CONVICTION_FIELDS = new Set(['conviction_now', 'conviction_entry']);

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Generate a slug from name, appending -2, -3, ... on collision with existing lens_thesis_id. */
async function generateSlug(name) {
  const base = slugify(name) || 'thesis';
  let candidate = base;
  let n = 1;
  // Loop terminates: each miss increments n; slug space is unbounded.
  while (true) {
    const rows = await query(
      `SELECT 1 FROM theses WHERE lens_thesis_id = $1 LIMIT 1`,
      [candidate]
    );
    if (rows.length === 0) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

function validateConviction(value, field) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new Error(`${field} must be an integer 0–5, got ${JSON.stringify(value)}`);
  }
}

/**
 * Create or update a thesis.
 *   - slug present  → UPDATE WHERE lens_thesis_id = slug (rename allowed; slug immutable)
 *   - slug absent   → INSERT with a generated, collision-checked slug
 * Returns the saved row.
 */
export async function saveThesis(thesis = {}) {
  const { slug, name } = thesis;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('thesis name is required and must be non-empty');
  }
  validateConviction(thesis.conviction_now, 'conviction_now');
  validateConviction(thesis.conviction_entry, 'conviction_entry');

  // Build the content assignments present in the payload.
  const cols = [];
  const vals = [];
  for (const field of CONTENT_FIELDS) {
    if (!(field in thesis)) continue;
    let v = thesis[field];
    if (JSONB_FIELDS.has(field)) v = JSON.stringify(v ?? []);
    else if (CONVICTION_FIELDS.has(field)) v = v ?? null;
    else v = v ?? null;
    cols.push(field);
    vals.push(v);
  }

  if (slug) {
    // UPDATE by immutable slug. Rename = name column change; FKs (id) untouched.
    const setClauses = ['name = $2'];
    const params = [slug, name.trim()];
    let idx = 3;
    for (let i = 0; i < cols.length; i++) {
      const cast = JSONB_FIELDS.has(cols[i]) ? '::jsonb' : '';
      setClauses.push(`${cols[i]} = $${idx}${cast}`);
      params.push(vals[i]);
      idx += 1;
    }
    const rows = await query(
      `UPDATE theses SET ${setClauses.join(', ')}
        WHERE lens_thesis_id = $1
        RETURNING *`,
      params
    );
    if (rows.length === 0) throw new Error(`no thesis with slug ${slug}`);
    return rows[0];
  }

  // INSERT with generated slug. lens_source marks it as UI-created.
  const newSlug = await generateSlug(name);
  const insertCols = ['name', 'active', 'lens_source', 'lens_thesis_id', ...cols];
  const insertVals = [name.trim(), thesis.active ?? true, 'ui', newSlug, ...vals];
  const placeholders = insertCols.map((c, i) => {
    const cast = JSONB_FIELDS.has(c) ? '::jsonb' : '';
    return `$${i + 1}${cast}`;
  });
  const rows = await query(
    `INSERT INTO theses (${insertCols.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING *`,
    insertVals
  );
  return rows[0];
}

/**
 * Soft-delete a thesis (active = FALSE). Never hard-delete: historical
 * investment_theses tags and thesisPerformance must survive.
 */
export async function deleteThesis(slug) {
  if (!slug) throw new Error('deleteThesis requires a slug');
  const rows = await query(
    `UPDATE theses SET active = FALSE WHERE lens_thesis_id = $1 RETURNING *`,
    [slug]
  );
  if (rows.length === 0) throw new Error(`no thesis with slug ${slug}`);
  return rows[0];
}

/**
 * List theses (rich rows for hydration and the Theses screen).
 * Only rows carrying a lens_thesis_id (the lens's theses); excludes inactive
 * unless includeInactive is set.
 */
export async function listTheses({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'AND active = TRUE';
  return query(
    `SELECT * FROM theses
      WHERE lens_thesis_id IS NOT NULL ${where}
      ORDER BY id`
  );
}
