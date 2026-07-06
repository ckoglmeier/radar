#!/usr/bin/env node

/**
 * Seed the cloud lens store from a file lens directory (one-time cutover).
 *
 * Maps a lens's theses/*.json onto the theses table (matching existing rows on
 * name — the AngelList import already created them — and writing lens_thesis_id,
 * lens_source='file', and the content columns) and the distributions.json value
 * onto the one-row lens_config table.
 *
 * Idempotent: a second run is a no-op (match-on-name UPDATE, distributions
 * upsert). New theses in the file that don't match a row are INSERTed.
 *
 * Usage:  node src/db/seed-lens.js [lensDir]
 *   lensDir defaults to ~/.radar/lenses/ck-conviction-era.
 *
 * Runs against DATABASE_URL. DO NOT point this at a remote/Neon DB from here —
 * CK runs the real cutover. Tests exercise it against throwaway PGlite.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { query } from './index.js';

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function defaultLensDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  return join(home, '.radar', 'lenses', 'ck-conviction-era');
}

/**
 * Seed one thesis file onto a row. Match on name: UPDATE if present, else INSERT.
 * Returns 'updated' | 'inserted'.
 */
async function seedThesis(t) {
  const existing = await query(`SELECT id FROM theses WHERE name = $1`, [t.name]);
  const params = [
    t.id,                                     // lens_thesis_id (slug)
    t.belief ?? null,
    t.proves_true ?? null,                    // file lens may not carry these
    t.proves_false ?? null,
    t.open_question ?? null,
    JSON.stringify(t.qualifications ?? []),
    JSON.stringify(t.exclusions ?? []),
    t.conviction_signal ?? null,
    t.active ?? true,
  ];

  if (existing.length > 0) {
    await query(
      `UPDATE theses SET
         lens_thesis_id = $1, lens_source = 'file',
         belief = $2, proves_true = $3, proves_false = $4, open_question = $5,
         qualifications = $6::jsonb, exclusions = $7::jsonb,
         conviction_signal = $8, active = $9
       WHERE name = $10`,
      [...params, t.name]
    );
    return 'updated';
  }

  await query(
    `INSERT INTO theses
       (name, lens_thesis_id, lens_source, belief, proves_true, proves_false,
        open_question, qualifications, exclusions, conviction_signal, active)
     VALUES ($10, $1, 'file', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [...params, t.name]
  );
  return 'inserted';
}

/**
 * Seed a lens directory into the DB. Returns a summary of what changed.
 */
export async function seedLens(lensDir = defaultLensDir()) {
  if (!existsSync(lensDir)) {
    throw new Error(`lens directory not found: ${lensDir}`);
  }

  const summary = { lensDir, theses: { updated: 0, inserted: 0 }, distributions: false };

  const thesesDir = join(lensDir, 'theses');
  if (existsSync(thesesDir)) {
    const files = readdirSync(thesesDir).filter(f => f.endsWith('.json')).sort();
    for (const file of files) {
      const t = readJson(join(thesesDir, file));
      const result = await seedThesis(t);
      summary.theses[result] += 1;
    }
  }

  const distPath = join(lensDir, 'distributions.json');
  if (existsSync(distPath)) {
    const dist = readJson(distPath);
    await query(
      `INSERT INTO lens_config (id, distributions, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET
         distributions = EXCLUDED.distributions, updated_at = NOW()`,
      [JSON.stringify(dist)]
    );
    summary.distributions = true;
  }

  return summary;
}

// CLI entry point: `node src/db/seed-lens.js [lensDir]`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const lensDir = process.argv[2] || defaultLensDir();
  seedLens(lensDir)
    .then((s) => {
      console.log(`Seeded lens from ${s.lensDir}`);
      console.log(`  theses: ${s.theses.updated} updated, ${s.theses.inserted} inserted`);
      console.log(`  distributions: ${s.distributions ? 'seeded' : 'no distributions.json'}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err.message);
      process.exit(1);
    });
}
