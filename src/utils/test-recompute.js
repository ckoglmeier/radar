#!/usr/bin/env node

// Standalone tests for the recompute math used in transactions.js.
// Tests the pure arithmetic — no DB, no imports from transactions.js.
// The logic under test:
//   totalValue = distributions + unrealized
//   multiple   = totalValue / netInvested  (null if netInvested <= 0)
//
// Run: node src/utils/test-recompute.js

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

function approx(actual, expected, tolerance = 0.001) {
  if (actual === null && expected === null) return;
  if (actual === null) throw new Error(`expected ~${expected}, got null`);
  if (expected === null) throw new Error(`expected null, got ${actual}`);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expected ~${expected}, got ${actual}`);
  }
}

function isNull(actual) {
  if (actual !== null) throw new Error(`expected null, got ${actual}`);
}

// Recompute logic extracted from transactions.js recomputeInvestmentReturns()
function recompute({ invested, unrealized, distributions, refunds }) {
  const netInvested = invested;  // AL "Invested" already nets refunds
  const totalValue = distributions + unrealized;
  const multiple = netInvested > 0 ? totalValue / netInvested : null;
  return { netInvested, totalValue, multiple, distributions, refunds };
}

console.log('\n  recompute math tests\n');

test('basic: $1000 invested, $500 unrealized, no distributions', () => {
  const r = recompute({ invested: 1000, unrealized: 500, distributions: 0, refunds: 0 });
  approx(r.totalValue, 500);
  approx(r.multiple, 0.5);
});

test('2x return: $1000 invested, $1000 unrealized, $1000 distributions', () => {
  const r = recompute({ invested: 1000, unrealized: 1000, distributions: 1000, refunds: 0 });
  approx(r.totalValue, 2000);
  approx(r.multiple, 2.0);
});

test('pure distribution: $1000 invested, $0 unrealized, $3000 distributions', () => {
  const r = recompute({ invested: 1000, unrealized: 0, distributions: 3000, refunds: 0 });
  approx(r.totalValue, 3000);
  approx(r.multiple, 3.0);
});

test('total loss: $1000 invested, $0 unrealized, $0 distributions', () => {
  const r = recompute({ invested: 1000, unrealized: 0, distributions: 0, refunds: 0 });
  approx(r.totalValue, 0);
  approx(r.multiple, 0);
});

test('refunds tracked separately, do not affect multiple', () => {
  // Refunds reduce invested in AL data, but recompute uses invested as-is
  const r = recompute({ invested: 1000, unrealized: 1000, distributions: 0, refunds: 500 });
  approx(r.multiple, 1.0);
  approx(r.refunds, 500);
});

test('zero invested returns null multiple', () => {
  const r = recompute({ invested: 0, unrealized: 500, distributions: 100, refunds: 0 });
  isNull(r.multiple);
});

test('negative invested returns null multiple', () => {
  const r = recompute({ invested: -100, unrealized: 500, distributions: 100, refunds: 0 });
  isNull(r.multiple);
});

test('large multiple: $2000 invested, $0 unrealized, $20000 distributions (10x)', () => {
  const r = recompute({ invested: 2000, unrealized: 0, distributions: 20000, refunds: 0 });
  approx(r.totalValue, 20000);
  approx(r.multiple, 10.0);
});

test('fractional amounts: $1500 invested, $750.50 unrealized, $200.25 distributions', () => {
  const r = recompute({ invested: 1500, unrealized: 750.50, distributions: 200.25, refunds: 0 });
  approx(r.totalValue, 950.75);
  approx(r.multiple, 0.6338, 0.001);
});

test('netInvested equals invested (AL already nets refunds)', () => {
  const r = recompute({ invested: 5000, unrealized: 3000, distributions: 1000, refunds: 2000 });
  approx(r.netInvested, 5000);
  approx(r.totalValue, 4000);
  approx(r.multiple, 0.8);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
