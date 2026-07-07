#!/usr/bin/env node

// Hydration tests: assembling a lens from DB rows + bundled files must
// reproduce loadLens()'s object, withLens must isolate across async contexts,
// and the RADAR_LENS_SOURCE=db guard must throw when unhydrated.
//
// Follows the model-test convention (test-settings.js): hits the default
// DATABASE_URL; run under `npm run test:local` for a throwaway migrated PGlite.
//
// Run: node src/lenses/test-hydrate.js

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db/index.js';
import { loadLens, withLens, getActiveLens } from './loader.js';
import { assembleLens, loadCloudLens } from './hydrate.js';

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

// Canonical stringify: sort object keys recursively so comparison is
// key-order-independent (JSONB round-trips through Postgres reorder object keys;
// value equality is what matters, and getDistributions() reads by key).
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

function deepEq(actual, expected, msg = '') {
  const a = JSON.stringify(canonical(actual));
  const e = JSON.stringify(canonical(expected));
  if (a !== e) {
    throw new Error(`${msg ? msg + ': ' : ''}\n    expected ${e}\n    actual   ${a}`);
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}

// The file fields shared between a loadLens() thesis and an assembled thesis.
// (New DB-only fields — proves_true, conviction_now, etc. — have no file
// counterpart; portfolio_examples is deliberately dropped to []. So we compare
// the shared file fields for value parity and check the drops separately.)
const SHARED_THESIS_FIELDS = [
  'id', 'name', 'belief', 'qualifications', 'exclusions', 'conviction_signal', 'active',
];

function pick(obj, fields) {
  const out = {};
  for (const f of fields) out[f] = obj[f] ?? null;
  return out;
}

async function seedTemplateRows() {
  // Clear any pre-seeded theses (the base schema seeds CK's default thesis names)
  // so the assembled lens contains exactly the _template theses for the deep-equal.
  // Safe: throwaway PGlite under test:local.
  await query(`DELETE FROM investment_theses`);
  await query(`DELETE FROM theses`);

  // Thesis rows from _template/theses/*.json, matching the file loader's sort order.
  const thesesDir = join(TEMPLATE_DIR, 'theses');
  const files = readdirSync(thesesDir).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    const t = readJson(join(thesesDir, file));
    await query(
      `INSERT INTO theses (name, active, lens_source, lens_thesis_id, belief,
                           qualifications, exclusions, conviction_signal)
       VALUES ($1, $2, 'file', $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [t.name, t.active, t.id, t.belief,
       JSON.stringify(t.qualifications ?? []),
       JSON.stringify(t.exclusions ?? []),
       t.conviction_signal],
    );
  }
  // Distributions from _template/distributions.json.
  const dist = readJson(join(TEMPLATE_DIR, 'distributions.json'));
  await query(
    `INSERT INTO lens_config (id, distributions) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET distributions = EXCLUDED.distributions`,
    [JSON.stringify(dist)],
  );
}

async function cleanup(thesisNames) {
  await query(`DELETE FROM lens_config WHERE id = 1`);
  await query(`DELETE FROM theses WHERE name = ANY($1::text[])`, [thesisNames]);
}

// The bundled read-only files an assembled cloud lens uses. For _template we
// read them off disk to mirror what lib/lens-files.js will import statically.
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

async function run() {
  const fileLens = loadLens(TEMPLATE_DIR);
  const thesisNames = fileLens.theses.map(t => t.name);

  try {
    await cleanup(thesisNames);
    await seedTemplateRows();

    await test('loadCloudLens output deep-equals loadLens() (modulo dir + portfolio_examples)', async () => {
      const cloud = await loadCloudLens(templateFiles());

      // Top-level non-thesis components must match exactly.
      for (const key of ['manifest', 'rubric', 'rubricSecondary', 'taggingRules',
                          'gpTiers', 'killCriteria', 'distributions', 'roundParams']) {
        deepEq(cloud[key], fileLens[key], `lens.${key}`);
      }
      eq(cloud.dir, null, 'cloud dir is null');

      // Thesis parity: same count, same shared file fields (order-independent
      // by name), portfolio_examples dropped to [].
      eq(cloud.theses.length, fileLens.theses.length, 'thesis count');
      const cloudByName = Object.fromEntries(cloud.theses.map(t => [t.name, t]));
      for (const ft of fileLens.theses) {
        const ct = cloudByName[ft.name];
        if (!ct) throw new Error(`assembled lens missing thesis ${ft.name}`);
        deepEq(pick(ct, SHARED_THESIS_FIELDS), pick(ft, SHARED_THESIS_FIELDS), `thesis ${ft.name} shared fields`);
        deepEq(ct.portfolio_examples, [], `thesis ${ft.name} portfolio_examples dropped to []`);
      }
    });

    await test('assembleLens defaults qualifications/exclusions to [] on null JSONB', async () => {
      const lens = assembleLens({
        files: templateFiles(),
        theses: [{ id: 'x', name: 'X', active: true, qualifications: null, exclusions: null }],
        distributions: null,
      });
      deepEq(lens.theses[0].qualifications, [], 'qualifications default');
      deepEq(lens.theses[0].exclusions, [], 'exclusions default');
      eq(lens.distributions, null, 'distributions null passthrough');
    });

    await test('withLens makes getActiveLens() return the assembled lens', async () => {
      const cloud = await loadCloudLens(templateFiles());
      await withLens(cloud, async () => {
        eq(getActiveLens() === cloud, true, 'ALS store returned');
      });
    });

    await test('withLens isolates concurrent async contexts', async () => {
      const lensA = { manifest: { name: 'A' } };
      const lensB = { manifest: { name: 'B' } };
      const results = await Promise.all([
        withLens(lensA, async () => {
          await new Promise(r => setTimeout(r, 10));
          return getActiveLens().manifest.name;
        }),
        withLens(lensB, async () => {
          await new Promise(r => setTimeout(r, 5));
          return getActiveLens().manifest.name;
        }),
      ]);
      deepEq(results, ['A', 'B'], 'each context saw its own lens');
    });

    await test('loadCloudLens throws on an unseeded DB (zero theses)', async () => {
      // Empty-lens guard: an empty-but-hydrated lens must fail loudly, not feed
      // empty distributions to the Kelly solver. Clear the tables, expect a throw.
      await query(`DELETE FROM lens_config WHERE id = 1`);
      await query(`DELETE FROM investment_theses`);
      await query(`DELETE FROM theses`);
      let threw = false;
      let msg = '';
      try {
        await loadCloudLens(templateFiles());
      } catch (e) {
        threw = true;
        msg = e.message;
      }
      eq(threw, true, 'loadCloudLens threw on unseeded DB');
      eq(/zero rows/.test(msg), true, `error names the empty-theses cause (got: ${msg})`);
      // Re-seed so subsequent tests see the seeded state.
      await seedTemplateRows();
    });

    await test('loadCloudLens throws when distributions are missing (theses present)', async () => {
      // Second door to the same wrong-numbers class: theses seeded but no
      // lens_config row. Must also fail loudly.
      await query(`DELETE FROM lens_config WHERE id = 1`);
      let threw = false;
      let msg = '';
      try {
        await loadCloudLens(templateFiles());
      } catch (e) {
        threw = true;
        msg = e.message;
      }
      eq(threw, true, 'loadCloudLens threw when distributions missing');
      eq(/distributions/.test(msg), true, `error names the missing-distributions cause (got: ${msg})`);
      await seedTemplateRows();
    });

    await test('loadCloudLens succeeds on a seeded DB', async () => {
      // The positive: with template rows + distributions seeded, no throw and
      // the assembled lens carries real distributions.
      const cloud = await loadCloudLens(templateFiles());
      eq(cloud.theses.length > 0, true, 'assembled lens has theses');
      eq(cloud.distributions != null, true, 'assembled lens has distributions');
    });

    await test('guard throws when RADAR_LENS_SOURCE=db and unhydrated', async () => {
      const prev = process.env.RADAR_LENS_SOURCE;
      process.env.RADAR_LENS_SOURCE = 'db';
      try {
        let threw = false;
        try { getActiveLens(); } catch (e) { threw = /RADAR_LENS_SOURCE/.test(e.message); }
        eq(threw, true, 'unhydrated getActiveLens threw');
        // ...but not inside withLens.
        const lens = { manifest: { name: 'hydrated' } };
        await withLens(lens, async () => {
          eq(getActiveLens() === lens, true, 'hydrated call under flag does not throw');
        });
      } finally {
        if (prev === undefined) delete process.env.RADAR_LENS_SOURCE;
        else process.env.RADAR_LENS_SOURCE = prev;
      }
    });
  } finally {
    await cleanup(thesisNames);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
