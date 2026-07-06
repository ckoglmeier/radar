#!/usr/bin/env node

// Tests for the lens seed script. Uses _template as the source dir. Follows
// the model-test convention (default DATABASE_URL; run under test:local for a
// throwaway migrated PGlite).
//
// Run: node src/db/test-seed-lens.js

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from './index.js';
import { seedLens } from './seed-lens.js';
import { loadCloudLens } from '../lenses/hydrate.js';
import { withLens, getTaggingRules } from '../lenses/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(__dirname, '../../lenses/_template');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}
function sameJson(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }

function templateFiles() {
  const opt = (name) => {
    try { return readJson(join(TEMPLATE_DIR, name)); } catch { return null; }
  };
  return {
    manifest: readJson(join(TEMPLATE_DIR, 'manifest.json')),
    rubric: opt('rubric.json'),
    rubricSecondary: opt('rubric-secondary.json'),
    taggingRules: opt('tagging-rules.json'),
    gpTiers: opt('gp-tiers.json'),
    killCriteria: opt('kill-criteria.json'),
    roundParams: opt('round-params.json'),
  };
}

const templateThesisNames = readdirSync(join(TEMPLATE_DIR, 'theses'))
  .filter(f => f.endsWith('.json'))
  .map(f => readJson(join(TEMPLATE_DIR, 'theses', f)).name);

async function cleanup() {
  await query(`DELETE FROM lens_config WHERE id = 1`);
  await query(`DELETE FROM theses WHERE name = ANY($1::text[])`, [templateThesisNames]);
}

async function run() {
  try {
    await cleanup();

    await test('first seed inserts theses + distributions', async () => {
      const summary = await seedLens(TEMPLATE_DIR);
      eq(summary.theses.inserted, templateThesisNames.length, 'all theses inserted');
      eq(summary.theses.updated, 0, 'none updated on first run');
      eq(summary.distributions, true, 'distributions seeded');
    });

    await test('row content deep-equals file content', async () => {
      const files = readdirSync(join(TEMPLATE_DIR, 'theses')).filter(f => f.endsWith('.json')).sort();
      for (const file of files) {
        const t = readJson(join(TEMPLATE_DIR, 'theses', file));
        const rows = await query(
          `SELECT lens_thesis_id, name, belief, qualifications, exclusions,
                  conviction_signal, active, lens_source
             FROM theses WHERE name = $1`, [t.name]
        );
        eq(rows.length, 1, `row for ${t.name}`);
        const r = rows[0];
        eq(r.lens_thesis_id, t.id, 'slug = file id');
        eq(r.belief, t.belief, 'belief');
        eq(r.conviction_signal, t.conviction_signal, 'conviction_signal');
        eq(r.active, t.active, 'active');
        eq(r.lens_source, 'file', 'lens_source');
        eq(sameJson(r.qualifications, t.qualifications), true, 'qualifications match');
        eq(sameJson(r.exclusions, t.exclusions), true, 'exclusions match');
      }
      // Distributions row matches file.
      const cfg = await query(`SELECT distributions FROM lens_config WHERE id = 1`);
      const fileDist = readJson(join(TEMPLATE_DIR, 'distributions.json'));
      eq(sameJson(cfg[0].distributions, fileDist), true, 'distributions row matches file');
    });

    await test('second seed is a no-op (idempotent — all updates, no new inserts)', async () => {
      const before = await query(`SELECT id, name FROM theses WHERE name = ANY($1::text[]) ORDER BY id`, [templateThesisNames]);
      const summary = await seedLens(TEMPLATE_DIR);
      eq(summary.theses.inserted, 0, 'no new inserts on re-run');
      eq(summary.theses.updated, templateThesisNames.length, 'all matched-and-updated');
      const after = await query(`SELECT id, name FROM theses WHERE name = ANY($1::text[]) ORDER BY id`, [templateThesisNames]);
      // Same row ids, same count — no duplication.
      eq(sameJson(before, after), true, 'rows unchanged (same ids, no duplicates)');
    });

    await test('getTaggingRules resolves every thesis_id after seeding', async () => {
      const lens = await loadCloudLens(templateFiles());
      await withLens(lens, async () => {
        const rules = getTaggingRules();
        const validNames = new Set(lens.theses.map(t => t.name));
        // Every rule's thesis must resolve to a real thesis name, not the raw
        // slug fallback (thesisById[thesis_id] || thesis_id).
        for (const rule of rules) {
          eq(validNames.has(rule.thesis), true, `rule resolves to a thesis name (${rule.thesis})`);
        }
        eq(rules.length, lens.taggingRules.rules.length, 'all rules present');
      });
    });
  } finally {
    await cleanup();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
