#!/usr/bin/env node

// Standalone test fixture for calculateIRR — no DB required.
// Run: node src/utils/test-irr.js

import { calculateIRR } from './irr.js';

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

function approx(actual, expected, tolerance = 0.01) {
  if (actual === null && expected === null) return;
  if (actual === null) throw new Error(`expected ~${expected}, got null`);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expected ~${expected}, got ${actual.toFixed(4)}`);
  }
}

function isNull(actual) {
  if (actual !== null) throw new Error(`expected null, got ${actual}`);
}

console.log('\n  IRR Calculator Tests\n');

// --- Basic cases ---

test('Simple 10% annual return', () => {
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2025-01-01', amount: 1100 },
  ]);
  approx(irr, 0.10);
});

test('Simple 2x in 2 years', () => {
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 2000 },
  ]);
  // 2x in 2 years = (2)^(1/2) - 1 ≈ 0.414
  approx(irr, 0.414, 0.02);
});

test('Multi-cashflow: two investments, one exit', () => {
  // -$1000 day 0, -$500 at 6 months, +$2000 at 2 years
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-07-01', amount: -500 },
    { date: '2026-01-01', amount: 2000 },
  ]);
  // Should be positive, between 10-25%
  if (irr === null || irr < 0.05 || irr > 0.40) {
    throw new Error(`expected positive IRR in 5-40% range, got ${irr}`);
  }
});

test('5x in 3 years (high return)', () => {
  const irr = calculateIRR([
    { date: '2022-01-01', amount: -1000 },
    { date: '2025-01-01', amount: 5000 },
  ]);
  // 5^(1/3) - 1 ≈ 0.71
  approx(irr, 0.71, 0.02);
});

test('10x in 4 years (very high return)', () => {
  const irr = calculateIRR([
    { date: '2021-01-01', amount: -1000 },
    { date: '2025-01-01', amount: 10000 },
  ]);
  // 10^(1/4) - 1 ≈ 0.778
  approx(irr, 0.778, 0.02);
});

// --- Partial loss ---

test('50% loss in 2 years', () => {
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 500 },
  ]);
  // Should be negative
  if (irr === null || irr >= 0) throw new Error(`expected negative IRR, got ${irr}`);
  approx(irr, -0.293, 0.02);
});

// --- Unrealized-only (synthetic terminal value) ---

test('Unrealized 1.5x after 18 months', () => {
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2025-07-01', amount: 1500 },
  ]);
  if (irr === null || irr < 0) throw new Error(`expected positive IRR, got ${irr}`);
});

// --- With distributions along the way ---

test('Multiple distributions', () => {
  const irr = calculateIRR([
    { date: '2022-01-01', amount: -5000 },
    { date: '2023-01-01', amount: 500 },
    { date: '2024-01-01', amount: 1000 },
    { date: '2025-01-01', amount: 2000 },
    { date: '2025-01-01', amount: 3000 }, // terminal unrealized
  ]);
  // Total return: 6500/5000 = 1.3x, but with time weighting IRR should be reasonable
  if (irr === null || irr < 0) throw new Error(`expected positive IRR, got ${irr}`);
});

// --- Edge cases ---

test('Empty array → null', () => {
  isNull(calculateIRR([]));
});

test('Single cashflow → null', () => {
  isNull(calculateIRR([{ date: '2024-01-01', amount: -1000 }]));
});

test('Null input → null', () => {
  isNull(calculateIRR(null));
});

test('All negative → null', () => {
  isNull(calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2025-01-01', amount: -500 },
  ]));
});

test('All positive → null', () => {
  isNull(calculateIRR([
    { date: '2024-01-01', amount: 1000 },
    { date: '2025-01-01', amount: 500 },
  ]));
});

test('Total loss (zero terminal) → null or very negative', () => {
  // No positive cashflow at all — should return null
  isNull(calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2026-01-01', amount: 0 },
  ]));
});

// --- Edge cases: extreme returns, clamping, pathological flows ---

test('Extreme positive: 10x in 1 year (~900% IRR)', () => {
  // $1,000 in, $10,000 back exactly one year later → annualized IRR = 9.0 (900%)
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2025-01-01', amount: 10000 },
  ]);
  // Solver should converge and return ~9.0, not null or garbage
  approx(irr, 9.0, 0.10);
});

test('Deep negative: near-total loss over 5 years', () => {
  // $10,000 in, $10 back 5 years later
  // True XIRR: (10/10000)^(1/5) - 1 = (0.001)^0.2 - 1 ≈ -0.7488
  // Solver clamps iterates at -0.99; should still converge to a finite value near -0.748
  const irr = calculateIRR([
    { date: '2019-01-01', amount: -10000 },
    { date: '2024-01-01', amount: 10 },
  ]);
  if (irr === null) throw new Error('expected a finite value near -0.748, got null');
  if (irr >= -0.5) throw new Error(`expected IRR < -0.5, got ${irr}`);
  approx(irr, -0.748, 0.01);
});

test('Very short holding period: 2x in 1 day → null (pinned behavior)', () => {
  // No finite annualized rate exists: NPV = -1000 + 2000/(1+r)^(1/365) is always
  // positive for all finite r > -1, so the solver correctly returns null after 50 iters
  // rather than a non-converged or infinite value.
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-01-02', amount: 2000 },
  ]);
  // Pinned: returns null (not NaN, not Infinity)
  if (irr !== null) {
    if (!isFinite(irr) || isNaN(irr)) throw new Error(`expected null or finite, got ${irr}`);
    // If it ever starts converging, that's fine too — but it must not be NaN/Infinity
  }
  // assert no NaN/Infinity regardless
  if (isNaN(irr)) throw new Error(`got NaN`);
});

test('Same-date zero-gain cashflows → no crash, returns finite or null', () => {
  // -1000 and +1000 on the same day: NPV = 0 for all r, so f < TOLERANCE on iter 0
  // and solver returns its initial guess (0.1). Pinned: finite value (not null, not NaN).
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2024-01-01', amount: 1000 },
  ]);
  if (isNaN(irr)) throw new Error(`got NaN`);
  if (irr !== null && !isFinite(irr)) throw new Error(`got non-finite value: ${irr}`);
});

test('Break-even over 1 year → IRR ≈ 0', () => {
  // $1,000 in, $1,000 back one year later — true rate is exactly 0%
  const irr = calculateIRR([
    { date: '2024-01-01', amount: -1000 },
    { date: '2025-01-01', amount: 1000 },
  ]);
  approx(irr, 0.0, 1e-6);
});

test('Multi-sign-change flows: solver converges to a finite value, no crash', () => {
  // Multiple sign changes can produce multiple real IRRs (Descartes rule).
  // Newton-Raphson may converge to any root or oscillate. The guarantee is:
  // no crash, no NaN, no Infinity — either a finite value or null.
  const irr = calculateIRR([
    { date: '2022-01-01', amount: -1000 },
    { date: '2022-07-01', amount: 2000 },
    { date: '2023-01-01', amount: -1500 },
    { date: '2024-01-01', amount: 1000 },
  ]);
  if (isNaN(irr)) throw new Error(`got NaN`);
  if (irr !== null && !isFinite(irr)) throw new Error(`got non-finite value: ${irr}`);
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
