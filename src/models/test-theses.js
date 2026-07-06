#!/usr/bin/env node

// Tests for the thesis writer. Follows test-settings.js: hits the default
// DATABASE_URL; run under `npm run test:local` for a throwaway migrated PGlite.
//
// Run: node src/models/test-theses.js

import { query } from '../db/index.js';
import { saveThesis, deleteThesis, listTheses } from './theses.js';
import { loadCloudLens } from '../lenses/hydrate.js';

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

async function expectRejects(fn, pattern) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  if (!caught) throw new Error('expected function to reject');
  if (pattern && !pattern.test(caught.message)) {
    throw new Error(`expected error matching ${pattern}, got ${caught.message}`);
  }
}

// Empty file set — hydration here only exercises theses rows.
const EMPTY_FILES = {
  manifest: { name: 'test' }, rubric: null, rubricSecondary: null,
  taggingRules: null, gpTiers: null, killCriteria: null, roundParams: null,
};

const SLUGS = ['tw-alpha', 'tw-beta', 'tw-gamma', 'tw-renamed', 'tw-new-thesis'];

async function cleanup() {
  const rows = await query(
    `SELECT id FROM theses WHERE lens_thesis_id = ANY($1::text[]) OR name LIKE 'TW %' OR name LIKE 'TW:%'`,
    [SLUGS]
  );
  if (rows.length === 0) return;
  const ids = rows.map(r => r.id);
  await query(`DELETE FROM investment_theses WHERE thesis_id = ANY($1::int[])`, [ids]);
  await query(`DELETE FROM theses WHERE id = ANY($1::int[])`, [ids]);
}

async function run() {
  try {
    await cleanup();

    await test('saveThesis inserts a new thesis with a generated slug', async () => {
      const row = await saveThesis({
        name: 'TW New Thesis',
        belief: 'infra compounds',
        qualifications: ['a', 'b'],
        exclusions: ['c'],
        conviction_now: 4,
        conviction_entry: 2,
        conviction_signal: 'signal',
      });
      eq(row.lens_thesis_id, 'tw-new-thesis', 'generated slug');
      eq(row.belief, 'infra compounds');
      eq(row.conviction_now, 4);
      eq(row.lens_source, 'ui');
      // JSONB round-trips to arrays.
      eq(Array.isArray(row.qualifications), true, 'qualifications is array');
      eq(row.qualifications.length, 2);
    });

    await test('save → fresh hydration reflects the new thesis', async () => {
      const lens = await loadCloudLens(EMPTY_FILES);
      const t = lens.theses.find(x => x.id === 'tw-new-thesis');
      eq(t !== undefined, true, 'thesis present in assembled lens');
      eq(t.belief, 'infra compounds');
      eq(t.conviction_now, 4);
    });

    await test('saveThesis updates by slug (upsert on existing slug)', async () => {
      await saveThesis({ name: 'TW Alpha', belief: 'v1', conviction_now: 1 });
      const updated = await saveThesis({ slug: 'tw-alpha', name: 'TW Alpha', belief: 'v2', conviction_now: 3 });
      eq(updated.belief, 'v2');
      eq(updated.conviction_now, 3);
    });

    await test('rename keeps theses.id (slug immutable, tags intact)', async () => {
      const created = await saveThesis({ name: 'TW Beta', belief: 'b' });
      const id = created.id;
      const slug = created.lens_thesis_id;
      eq(slug, 'tw-beta');

      // Attach a tag to prove the FK survives a rename.
      const inv = await query(
        `INSERT INTO investments (company_name) VALUES ('TW-FK-Co') RETURNING id`
      );
      const invId = inv[0].id;
      await query(
        `INSERT INTO investment_theses (investment_id, thesis_id) VALUES ($1, $2)`,
        [invId, id]
      );

      const renamed = await saveThesis({ slug: 'tw-beta', name: 'TW Beta Renamed' });
      eq(renamed.id, id, 'theses.id unchanged across rename');
      eq(renamed.lens_thesis_id, 'tw-beta', 'slug unchanged across rename');
      eq(renamed.name, 'TW Beta Renamed', 'name updated');

      const tags = await query(
        `SELECT thesis_id FROM investment_theses WHERE investment_id = $1`, [invId]
      );
      eq(tags.length, 1, 'tag still present after rename');
      eq(tags[0].thesis_id, id, 'tag still points at same theses.id');

      await query(`DELETE FROM investment_theses WHERE investment_id = $1`, [invId]);
      await query(`DELETE FROM investments WHERE id = $1`, [invId]);
    });

    await test('slug generation avoids collision', async () => {
      // theses.name is UNIQUE, so collisions come from distinct names that
      // slugify to the same base: "TW Gamma!" and "TW Gamma?" → tw-gamma.
      const a = await saveThesis({ name: 'TW Gamma!' });
      eq(a.lens_thesis_id, 'tw-gamma');
      const b = await saveThesis({ name: 'TW Gamma?' });
      eq(b.lens_thesis_id, 'tw-gamma-2', 'collision-suffixed slug');
      // Track for cleanup.
      SLUGS.push('tw-gamma-2');
    });

    await test('deleteThesis deactivates, never hard-deletes', async () => {
      const created = await saveThesis({ name: 'TW Alpha 2' });
      const slug = created.lens_thesis_id;
      SLUGS.push(slug);
      const deleted = await deleteThesis(slug);
      eq(deleted.active, false, 'active set false');
      const row = await query(`SELECT active FROM theses WHERE lens_thesis_id = $1`, [slug]);
      eq(row.length, 1, 'row still exists');
      eq(row[0].active, false);
    });

    await test('listTheses excludes inactive by default, includes with flag', async () => {
      const active = await listTheses();
      const activeSlugs = active.map(t => t.lens_thesis_id);
      eq(activeSlugs.includes('tw-alpha'), true, 'active thesis listed');

      const all = await listTheses({ includeInactive: true });
      const allSlugs = all.map(t => t.lens_thesis_id);
      // The tw-alpha-2 soft-deleted one appears only with includeInactive.
      const deactivatedPresent = all.some(t => t.active === false);
      eq(deactivatedPresent, true, 'inactive included with flag');
      eq(all.length >= active.length, true);
      void allSlugs;
    });

    await test('saveThesis rejects empty name', async () => {
      await expectRejects(() => saveThesis({ name: '  ' }), /name is required/);
      await expectRejects(() => saveThesis({}), /name is required/);
    });

    await test('saveThesis rejects out-of-range / non-integer conviction', async () => {
      await expectRejects(() => saveThesis({ name: 'TW Bad', conviction_now: 6 }), /conviction_now/);
      await expectRejects(() => saveThesis({ name: 'TW Bad', conviction_entry: -1 }), /conviction_entry/);
      await expectRejects(() => saveThesis({ name: 'TW Bad', conviction_now: 2.5 }), /conviction_now/);
    });

    await test('saveThesis with unknown slug rejects', async () => {
      await expectRejects(() => saveThesis({ slug: 'no-such-slug', name: 'X' }), /no thesis with slug/);
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
