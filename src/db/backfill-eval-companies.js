#!/usr/bin/env node

// One-time (idempotent) backfill: populate deal_evaluations.company_name
// for rows imported before migration 027 persisted it.
//
// Strategy per row where company_name IS NULL:
//   1. Parse raw_content with the exact heading logic the importer uses
//      (extractCompanyName — shared export, not a reimplementation).
//   2. Fallback: derive from the filename slug (YYYY-MM-DD-company-slug.md
//      → "Company Slug", title-cased).
// Rows with a name already set are untouched — safe to re-run.
//
// Run: DATABASE_URL=... node src/db/backfill-eval-companies.js

import { query, closeDb } from './index.js';
import { extractCompanyName } from '../models/evaluations.js';

function nameFromFilePath(filePath) {
  if (!filePath) return null;
  const file = filePath.split('/').pop() || '';
  const slug = file
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/\.md$/i, '');
  if (!slug) return null;
  return slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const recomputeAll = process.argv.includes('--all');
const rows = await query(
  recomputeAll
    ? `SELECT id, file_path, raw_content, company_name FROM deal_evaluations ORDER BY id`
    : `SELECT id, file_path, raw_content, company_name FROM deal_evaluations WHERE company_name IS NULL ORDER BY id`
);
console.log(`${rows.length} evaluation(s) to ${recomputeAll ? 'recompute' : 'backfill'}`);

let fromHeading = 0;
let fromSlug = 0;
let unresolved = 0;

for (const row of rows) {
  let name = extractCompanyName(row.raw_content);
  if (name) fromHeading++;
  else {
    name = nameFromFilePath(row.file_path);
    if (name) fromSlug++;
  }
  if (!name) {
    unresolved++;
    console.log(`  ! id=${row.id} unresolved (no heading, no usable file_path)`);
    continue;
  }
  if (name === row.company_name) continue;
  await query(`UPDATE deal_evaluations SET company_name = $1 WHERE id = $2`, [name, row.id]);
}

console.log(`Backfilled: ${fromHeading} from markdown heading, ${fromSlug} from filename slug, ${unresolved} unresolved`);
await closeDb();
