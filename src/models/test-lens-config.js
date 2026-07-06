#!/usr/bin/env node

// Tests for the distributions writer. Follows test-settings.js: hits the default
// DATABASE_URL; run under `npm run test:local` for a throwaway migrated PGlite.
//
// Run: node src/models/test-lens-config.js

import { query } from '../db/index.js';
import { saveDistributions, getLensConfig } from './lens-config.js';
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

const EMPTY_FILES = {
  manifest: { name: 'test' }, rubric: null, rubricSecondary: null,
  taggingRules: null, gpTiers: null, killCriteria: null, roundParams: null,
};

// A valid distributions value: all four bands, each summing to 1.
function validDist() {
  return {
    calibration_date: '2099-01-01',
    calibration_source: 'test',
    bands: {
      '44+':   { outcomes: [0, 1, 10], probs: [0.5, 0.3, 0.2] },
      '39-43': { outcomes: [0, 1, 10], probs: [0.6, 0.3, 0.1] },
      '30-38': { outcomes: [0, 1],     probs: [0.7, 0.3] },
      '<30':   { outcomes: [0, 1],     probs: [0.9, 0.1] },
    },
  };
}

async function cleanup() {
  await query(`DELETE FROM lens_config WHERE id = 1`);
}

async function run() {
  try {
    await cleanup();

    await test('saveDistributions upserts the one row (first write inserts)', async () => {
      const saved = await saveDistributions(validDist());
      eq(saved.id, 1, 'row id = 1');
      const cfg = await getLensConfig();
      eq(cfg.distributions.bands['44+'].probs.length, 3);
    });

    await test('save → fresh hydration reflects the new distributions', async () => {
      const dist = validDist();
      dist.bands['44+'].probs = [0.4, 0.4, 0.2];
      await saveDistributions(dist);
      const lens = await loadCloudLens(EMPTY_FILES);
      eq(lens.distributions.bands['44+'].probs[0], 0.4, 'hydration sees updated probs');
    });

    await test('rejects wrong band keys (extra band)', async () => {
      const d = validDist();
      d.bands['99+'] = { outcomes: [0], probs: [1] };
      await expectRejects(() => saveDistributions(d), /band keys must be exactly/);
    });

    await test('rejects partial bands (missing a required band)', async () => {
      const d = validDist();
      delete d.bands['<30'];
      await expectRejects(() => saveDistributions(d), /band keys must be exactly/);
    });

    await test('rejects sum != 1', async () => {
      const d = validDist();
      d.bands['44+'].probs = [0.5, 0.3, 0.3]; // sums to 1.1
      await expectRejects(() => saveDistributions(d), /sum to 1/);
    });

    await test('rejects outcomes/probs length mismatch', async () => {
      const d = validDist();
      d.bands['44+'].probs = [0.5, 0.5]; // outcomes has 3
      await expectRejects(() => saveDistributions(d), /length/);
    });

    await test('rejects negative prob', async () => {
      const d = validDist();
      d.bands['44+'].probs = [1.2, -0.1, -0.1];
      await expectRejects(() => saveDistributions(d), />= 0/);
    });

    await test('rejects non-object / missing bands', async () => {
      await expectRejects(() => saveDistributions(null), /must be an object/);
      await expectRejects(() => saveDistributions({}), /bands must be an object/);
    });

    await test('a rejected write leaves the stored value unchanged (whole-write rejection)', async () => {
      const good = validDist();
      good.bands['44+'].probs = [0.5, 0.3, 0.2];
      await saveDistributions(good);
      const bad = validDist();
      bad.bands['44+'].probs = [0.9, 0.9, 0.9];
      await expectRejects(() => saveDistributions(bad), /sum to 1/);
      const cfg = await getLensConfig();
      eq(cfg.distributions.bands['44+'].probs[0], 0.5, 'stored value untouched');
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
