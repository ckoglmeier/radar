#!/usr/bin/env node

import { getActiveLens } from '../lenses/loader.js';
import {
  applyFrameworkVersion,
  getActiveFrameworkVersion,
  getFrameworkState,
  saveFrameworkVersion,
} from './framework.js';
import { query } from '../db/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed += 1;
  }
}

function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function nextPatch(version) {
  const [major, minor, patch] = version.split('.');
  return `${major}.${minor}.${Number(patch) + 1}`;
}

async function run() {
  await query('DELETE FROM lens_framework_versions');
  const base = getActiveLens();
  const state = await getFrameworkState(base);

  await test('bundled framework is the initial fallback', async () => {
    eq(state.activeVersion, base.manifest.version);
    eq(state.framework.rubric.sections.length, base.rubric.sections.length);
  });

  const edited = structuredClone(state.framework);
  edited.manifest.description = 'Edited framework description';
  edited.rubric.sections[0].dimensions[0].anchors['3'] = 'Edited midpoint';
  const first = await saveFrameworkVersion({ framework: edited, changeNote: 'First edit' });

  await test('first edit creates the next patch version', async () => {
    eq(first.version, nextPatch(base.manifest.version));
    eq(first.active, true);
  });

  const active = await getActiveFrameworkVersion();
  await test('active framework overlays bundled values', async () => {
    const hydrated = applyFrameworkVersion(base, active);
    eq(hydrated.manifest.description, 'Edited framework description');
    eq(hydrated.rubric.sections[0].dimensions[0].anchors['3'], 'Edited midpoint');
  });

  edited.manifest.description = 'Second description';
  const second = await saveFrameworkVersion({ framework: edited, changeNote: 'Second edit' });
  await test('a later save activates one new immutable version', async () => {
    eq(second.version, nextPatch(first.version));
    const rows = await query('SELECT version FROM lens_framework_versions ORDER BY id');
    eq(rows.length, 2);
    const versions = (await getFrameworkState(base)).versions;
    eq(versions[0].version, second.version);
    eq(versions[0].active, true);
    eq(versions[1].active, false);
  });

  const invalid = structuredClone(edited);
  invalid.rubric.sections[0].dimensions[0].max_points = 99;
  await test('invalid rubric point totals are rejected', async () => {
    let rejected = false;
    try {
      await saveFrameworkVersion({ framework: invalid });
    } catch (error) {
      rejected = /dimension points must total/.test(error.message);
    }
    eq(rejected, true);
  });

  await query('DELETE FROM lens_framework_versions');
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(error => {
  console.error('FATAL:', error);
  process.exit(1);
});
