#!/usr/bin/env node

// Standalone test fixture for stage bucket helpers — no DB required.
// Run: node src/utils/test-stage.js

import { roundToStageBucket, stageToBarbellGroup, stageLabel, STAGE_ORDER, BARBELL_GROUPS } from './stage.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected) {
  if (actual !== expected) {
    throw new Error(`expected "${expected}", got "${actual}"`);
  }
}

// ─── roundToStageBucket ─────────────────────────────────────────────

console.log('\n  roundToStageBucket — standard rounds\n');

test('Pre-Seed → pre-seed', () => eq(roundToStageBucket('Pre-Seed'), 'pre-seed'));
test('pre-seed (lowercase) → pre-seed', () => eq(roundToStageBucket('pre-seed'), 'pre-seed'));
test('preseed (no separator) → pre-seed', () => eq(roundToStageBucket('preseed'), 'pre-seed'));
test('PreSeed (camelCase, lowered) → pre-seed', () => eq(roundToStageBucket('PreSeed'), 'pre-seed'));
test('pre seed (space) → pre-seed', () => eq(roundToStageBucket('pre seed'), 'pre-seed'));
test('PRE-SEED (uppercase) → pre-seed', () => eq(roundToStageBucket('PRE-SEED'), 'pre-seed'));

test('Seed → seed', () => eq(roundToStageBucket('Seed'), 'seed'));
test('seed (lowercase) → seed', () => eq(roundToStageBucket('seed'), 'seed'));
test('SEED (uppercase) → seed', () => eq(roundToStageBucket('SEED'), 'seed'));

test('Seed+ → seed-ext', () => eq(roundToStageBucket('Seed+'), 'seed-ext'));
test('seed+ (lowercase) → seed-ext', () => eq(roundToStageBucket('seed+'), 'seed-ext'));

test('Series A → series-a', () => eq(roundToStageBucket('Series A'), 'series-a'));
test('series a (lowercase) → series-a', () => eq(roundToStageBucket('series a'), 'series-a'));
test('Series A+ → series-a', () => eq(roundToStageBucket('Series A+'), 'series-a'));
test('SERIES A (uppercase) → series-a', () => eq(roundToStageBucket('SERIES A'), 'series-a'));

test('Series B → series-b', () => eq(roundToStageBucket('Series B'), 'series-b'));
test('series b (lowercase) → series-b', () => eq(roundToStageBucket('series b'), 'series-b'));
test('Series B+ → series-b', () => eq(roundToStageBucket('Series B+'), 'series-b'));

test('Series C → series-c', () => eq(roundToStageBucket('Series C'), 'series-c'));
test('series c (lowercase) → series-c', () => eq(roundToStageBucket('series c'), 'series-c'));
test('Series C+ → series-c', () => eq(roundToStageBucket('Series C+'), 'series-c'));

console.log('\n  roundToStageBucket — growth stage\n');

test('Series D → growth', () => eq(roundToStageBucket('Series D'), 'growth'));
test('Series D+ → growth', () => eq(roundToStageBucket('Series D+'), 'growth'));
test('Series E → growth', () => eq(roundToStageBucket('Series E'), 'growth'));
test('Series E+ → growth', () => eq(roundToStageBucket('Series E+'), 'growth'));
test('Series F → growth', () => eq(roundToStageBucket('Series F'), 'growth'));
test('Series F+ → growth', () => eq(roundToStageBucket('Series F+'), 'growth'));
test('Growth → growth', () => eq(roundToStageBucket('Growth'), 'growth'));
test('growth (lowercase) → growth', () => eq(roundToStageBucket('growth'), 'growth'));
test('Late Stage → growth', () => eq(roundToStageBucket('Late Stage'), 'growth'));
test('late stage (lowercase) → growth', () => eq(roundToStageBucket('late stage'), 'growth'));
test('late-stage (hyphenated) → growth', () => eq(roundToStageBucket('late-stage'), 'growth'));
test('Late-Stage (hyphenated, mixed case) → growth', () => eq(roundToStageBucket('Late-Stage'), 'growth'));

console.log('\n  roundToStageBucket — edge cases\n');

test('null → unknown', () => eq(roundToStageBucket(null), 'unknown'));
test('undefined → unknown', () => eq(roundToStageBucket(undefined), 'unknown'));
test('empty string → unknown', () => eq(roundToStageBucket(''), 'unknown'));
test('whitespace only → unknown', () => eq(roundToStageBucket('   '), 'unknown'));
test('unknown round name → unknown', () => eq(roundToStageBucket('Bridge'), 'unknown'));
test('Seed Extension → unknown (not mapped)', () => eq(roundToStageBucket('Seed Extension'), 'unknown'));
test('Series A1 → unknown (not mapped)', () => eq(roundToStageBucket('Series A1'), 'unknown'));
test('Series A-1 → unknown (not mapped)', () => eq(roundToStageBucket('Series A-1'), 'unknown'));
test('Convertible Note → unknown', () => eq(roundToStageBucket('Convertible Note'), 'unknown'));
test('SAFE → unknown', () => eq(roundToStageBucket('SAFE'), 'unknown'));
test('numeric input coerced to string → unknown', () => eq(roundToStageBucket(42), 'unknown'));
test('leading/trailing whitespace trimmed', () => eq(roundToStageBucket('  Seed  '), 'seed'));
test('extra internal whitespace collapsed', () => eq(roundToStageBucket('Series   A'), 'series-a'));
test('extra internal whitespace in Pre Seed', () => eq(roundToStageBucket('pre   seed'), 'pre-seed'));

// ─── stageToBarbellGroup ────────────────────────────────────────────

console.log('\n  stageToBarbellGroup\n');

test('pre-seed → Early', () => eq(stageToBarbellGroup('pre-seed'), 'Early'));
test('seed → Early', () => eq(stageToBarbellGroup('seed'), 'Early'));
test('seed-ext → Mid', () => eq(stageToBarbellGroup('seed-ext'), 'Mid'));
test('series-a → Mid', () => eq(stageToBarbellGroup('series-a'), 'Mid'));
test('series-b → Late', () => eq(stageToBarbellGroup('series-b'), 'Late'));
test('series-c → Late', () => eq(stageToBarbellGroup('series-c'), 'Late'));
test('growth → Growth', () => eq(stageToBarbellGroup('growth'), 'Growth'));
test('fund → Unknown (not in barbell groups)', () => eq(stageToBarbellGroup('fund'), 'Unknown'));
test('unknown → Unknown', () => eq(stageToBarbellGroup('unknown'), 'Unknown'));
test('arbitrary string → Unknown', () => eq(stageToBarbellGroup('nonsense'), 'Unknown'));

// ─── stageLabel ─────────────────────────────────────────────────────

console.log('\n  stageLabel\n');

test('pre-seed → Pre-Seed', () => eq(stageLabel('pre-seed'), 'Pre-Seed'));
test('seed → Seed', () => eq(stageLabel('seed'), 'Seed'));
test('seed-ext → Seed+', () => eq(stageLabel('seed-ext'), 'Seed+'));
test('series-a → Series A', () => eq(stageLabel('series-a'), 'Series A'));
test('series-b → Series B', () => eq(stageLabel('series-b'), 'Series B'));
test('series-c → Series C', () => eq(stageLabel('series-c'), 'Series C'));
test('growth → Growth (D+)', () => eq(stageLabel('growth'), 'Growth (D+)'));
test('fund → Fund', () => eq(stageLabel('fund'), 'Fund'));
test('unknown → Unknown', () => eq(stageLabel('unknown'), 'Unknown'));
test('unmapped bucket falls through to raw value', () => eq(stageLabel('something-new'), 'something-new'));

// ─── STAGE_ORDER constant ───────────────────────────────────────────

console.log('\n  STAGE_ORDER constant\n');

test('has 9 entries', () => {
  if (STAGE_ORDER.length !== 9) throw new Error(`expected 9, got ${STAGE_ORDER.length}`);
});

test('starts with pre-seed', () => eq(STAGE_ORDER[0], 'pre-seed'));
test('ends with unknown', () => eq(STAGE_ORDER[STAGE_ORDER.length - 1], 'unknown'));

test('ordering: pre-seed < seed < seed-ext < series-a < series-b < series-c < growth', () => {
  const ordered = ['pre-seed', 'seed', 'seed-ext', 'series-a', 'series-b', 'series-c', 'growth'];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = STAGE_ORDER.indexOf(ordered[i]);
    const b = STAGE_ORDER.indexOf(ordered[i + 1]);
    if (a >= b) throw new Error(`${ordered[i]} (${a}) should come before ${ordered[i + 1]} (${b})`);
  }
});

// ─── BARBELL_GROUPS constant ────────────────────────────────────────

console.log('\n  BARBELL_GROUPS constant\n');

test('has 4 groups', () => {
  const keys = Object.keys(BARBELL_GROUPS);
  if (keys.length !== 4) throw new Error(`expected 4 groups, got ${keys.length}`);
});

test('groups are Early, Mid, Late, Growth', () => {
  const keys = Object.keys(BARBELL_GROUPS).sort();
  const expected = ['Early', 'Growth', 'Late', 'Mid'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`expected ${expected}, got ${keys}`);
  }
});

test('every barbell stage exists in STAGE_ORDER', () => {
  for (const stages of Object.values(BARBELL_GROUPS)) {
    for (const s of stages) {
      if (!STAGE_ORDER.includes(s)) throw new Error(`${s} not in STAGE_ORDER`);
    }
  }
});

test('fund and unknown are not in any barbell group', () => {
  const allGrouped = Object.values(BARBELL_GROUPS).flat();
  if (allGrouped.includes('fund')) throw new Error('fund should not be in a barbell group');
  if (allGrouped.includes('unknown')) throw new Error('unknown should not be in a barbell group');
});

// ─── Summary ────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
