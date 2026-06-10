#!/usr/bin/env node

// Standalone tests for parseCouncil() — no DB required.
// Run: node src/lenses/test-council-parser.js

import { parseCouncil } from './sync-council-scores.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function approx(actual, expected, tolerance = 0.01) {
  if (Math.abs(actual - expected) > tolerance)
    throw new Error(`expected ~${expected}, got ${actual}`);
}

// ============================================================
//  Council score parsing
// ============================================================

console.log('\n  parseCouncil — score extraction\n');

test('standard table with all three scores', () => {
  const content = `
| Voice | Score |
|---|---|
| **Bull** | **38 / 50** |
| **Bear** | **22 / 50** |
| **Calibrator** | **30 / 50** |
`;
  const c = parseCouncil(content);
  eq(c.council_bull, 38);
  eq(c.council_bear, 22);
  eq(c.council_calibrator, 30);
});

test('scores without bold formatting', () => {
  const content = `
| Voice | Score |
|---|---|
| Bull | 40 / 50 |
| Bear | 25 / 50 |
| Calibrator | 32 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_bull, 40);
  eq(c.council_bear, 25);
  eq(c.council_calibrator, 32);
});

test('decimal scores', () => {
  const content = `
| Bull | 38.5 / 50 |
| Bear | 22.5 / 50 |
| Calibrator | 30.5 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_bull, 38.5);
  eq(c.council_bear, 22.5);
  eq(c.council_calibrator, 30.5);
});

test('only bull and bear — calibrator null', () => {
  const content = `
| Bull | 38 / 50 |
| Bear | 22 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_bull, 38);
  eq(c.council_bear, 22);
  eq(c.council_calibrator, null);
});

test('only bull — still returns data', () => {
  const content = `| Bull | 35 / 50 |`;
  const c = parseCouncil(content);
  eq(c.council_bull, 35);
  eq(c.council_bear, null);
  eq(c.council_calibrator, null);
});

// ============================================================
//  CFO verdict parsing
// ============================================================

console.log('\n  parseCouncil — CFO verdict\n');

test('CFO table format — Deploy', () => {
  const content = `
| **CFO** | — | **Deploy** |
`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Deploy');
});

test('CFO table format — Defer', () => {
  const content = `
| **CFO** | — | **Defer** |
`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Defer');
});

test('CFO table format — Pass', () => {
  const content = `
| **CFO** | — | **Pass** |
`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Pass');
});

test('CFO section format — Deploy', () => {
  const content = `
### CFO (Portfolio Construction)

Verdict: Deploy
`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Deploy');
});

test('CFO section format — Pass', () => {
  const content = `
### CFO (Portfolio Construction)

Some analysis text here.

Verdict: Pass
`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Pass');
});

test('no CFO verdict — null', () => {
  const content = `| Bull | 35 / 50 |`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, null);
});

test('CFO without bold', () => {
  const content = `| CFO | — | Deploy |`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Deploy');
});

// ============================================================
//  Computed fields (spread, consensus, divergence)
// ============================================================

console.log('\n  parseCouncil — computed fields\n');

test('spread = max - min of scores', () => {
  const content = `
| Bull | 40 / 50 |
| Bear | 20 / 50 |
| Calibrator | 30 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_spread, 20);
});

test('consensus = average of scores', () => {
  const content = `
| Bull | 40 / 50 |
| Bear | 20 / 50 |
| Calibrator | 30 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_consensus, 30);
});

test('divergence HIGH when spread > 10', () => {
  const content = `
| Bull | 40 / 50 |
| Bear | 20 / 50 |
| Calibrator | 30 / 50 |
`;
  eq(parseCouncil(content).council_divergence, 'HIGH');
});

test('divergence MODERATE when 5 < spread <= 10', () => {
  const content = `
| Bull | 35 / 50 |
| Bear | 28 / 50 |
| Calibrator | 30 / 50 |
`;
  // spread = 7
  eq(parseCouncil(content).council_divergence, 'MODERATE');
});

test('divergence LOW when spread <= 5', () => {
  const content = `
| Bull | 32 / 50 |
| Bear | 30 / 50 |
| Calibrator | 31 / 50 |
`;
  // spread = 2
  eq(parseCouncil(content).council_divergence, 'LOW');
});

test('two scores: spread, consensus, divergence still computed', () => {
  const content = `
| Bull | 40 / 50 |
| Bear | 25 / 50 |
`;
  const c = parseCouncil(content);
  eq(c.council_spread, 15);
  eq(c.council_consensus, 32.5);
  eq(c.council_divergence, 'HIGH');
});

test('one score: computed fields are null', () => {
  const content = `| Bull | 40 / 50 |`;
  const c = parseCouncil(content);
  eq(c.council_spread, null);
  eq(c.council_consensus, null);
  eq(c.council_divergence, null);
});

test('spread exactly 10 → MODERATE (not HIGH)', () => {
  // Need scores where max - min = 10
  const content = `
| Bull | 40 / 50 |
| Bear | 30 / 50 |
`;
  eq(parseCouncil(content).council_divergence, 'MODERATE');
});

test('spread exactly 5 → LOW (not MODERATE)', () => {
  const content = `
| Bull | 35 / 50 |
| Bear | 30 / 50 |
`;
  eq(parseCouncil(content).council_divergence, 'LOW');
});

// ============================================================
//  No council data
// ============================================================

console.log('\n  parseCouncil — no data\n');

test('empty content → null', () => {
  eq(parseCouncil(''), null);
});

test('unrelated markdown → null', () => {
  eq(parseCouncil('# Some Deal\n\nJust a description, no council scores.'), null);
});

test('content with only CFO verdict → returns data', () => {
  const content = `| CFO | — | Deploy |`;
  const c = parseCouncil(content);
  eq(c.council_cfo_verdict, 'Deploy');
  eq(c.council_bull, null);
});

// ============================================================
//  Real-world format variant B
// ============================================================

console.log('\n  parseCouncil — real-world format\n');

test('full council table with CFO row', () => {
  const content = `
## Investment Council

| Voice | Score |
|---|---|
| **Bull** | **36 / 50** |
| **Bear** | **22 / 50** |
| **Calibrator** | **30 / 50** |
| **CFO** | — | **Pass** |
`;
  const c = parseCouncil(content);
  eq(c.council_bull, 36);
  eq(c.council_bear, 22);
  eq(c.council_calibrator, 30);
  eq(c.council_cfo_verdict, 'Pass');
  eq(c.council_spread, 14);
  approx(c.council_consensus, 29.33, 0.01);
  eq(c.council_divergence, 'HIGH');
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
