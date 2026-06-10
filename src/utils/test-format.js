#!/usr/bin/env node

// Standalone test fixture for format utilities — no DB required.
// Run: node src/utils/test-format.js

import { parseMoney, parseDate, parsePercent, parseMultiple, formatMoney, formatMultiple, formatIRR } from './format.js';

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
  if (actual === expected) return;
  throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function isNull(actual) {
  if (actual !== null) throw new Error(`expected null, got ${JSON.stringify(actual)}`);
}

// ============================================================
//  parseMoney
// ============================================================

console.log('\n  parseMoney\n');

test('Standard: "$1,000" → 1000', () => {
  eq(parseMoney('$1,000'), 1000);
});

test('Standard with cents: "$10,000.50" → 10000.5', () => {
  eq(parseMoney('$10,000.50'), 10000.5);
});

test('Large: "$1,000,000" → 1000000', () => {
  eq(parseMoney('$1,000,000'), 1000000);
});

test('Small: "$5" → 5', () => {
  eq(parseMoney('$5'), 5);
});

test('Cents only: "$0.50" → 0.5', () => {
  eq(parseMoney('$0.50'), 0.5);
});

test('No dollar sign: "1000" → 1000', () => {
  eq(parseMoney('1000'), 1000);
});

test('Negative: "-$500" → -500', () => {
  eq(parseMoney('-$500'), -500);
});

test('Negative with comma: "-$1,500" → -1500', () => {
  eq(parseMoney('-$1,500'), -1500);
});

test('Zero: "$0" → 0', () => {
  eq(parseMoney('$0'), 0);
});

test('Null → null', () => {
  isNull(parseMoney(null));
});

test('Empty string → null', () => {
  isNull(parseMoney(''));
});

test('Undefined → null', () => {
  isNull(parseMoney(undefined));
});

test('"Locked" → null (AngelList locked values)', () => {
  isNull(parseMoney('Locked'));
});

test('Whitespace only → null', () => {
  isNull(parseMoney('   '));
});

test('Whitespace around value: " $1,000 " → 1000', () => {
  eq(parseMoney(' $1,000 '), 1000);
});

test('AngelList realistic: "$13,912.69" → 13912.69', () => {
  eq(parseMoney('$13,912.69'), 13912.69);
});

test('Non-numeric garbage → null', () => {
  isNull(parseMoney('abc'));
});

// ============================================================
//  parseDate
// ============================================================

console.log('\n  parseDate\n');

test('MM/DD/YYYY: "01/15/2024" → "2024-01-15"', () => {
  eq(parseDate('01/15/2024'), '2024-01-15');
});

test('Single-digit month/day: "1/5/2024" → "2024-01-05"', () => {
  eq(parseDate('1/5/2024'), '2024-01-05');
});

test('End of year: "12/31/2023" → "2023-12-31"', () => {
  eq(parseDate('12/31/2023'), '2023-12-31');
});

test('Null → null', () => {
  isNull(parseDate(null));
});

test('Empty string → null', () => {
  isNull(parseDate(''));
});

test('Undefined → null', () => {
  isNull(parseDate(undefined));
});

test('Whitespace only → null', () => {
  isNull(parseDate('   '));
});

test('ISO format "2024-01-15" → null (not MM/DD/YYYY)', () => {
  isNull(parseDate('2024-01-15'));
});

test('Partial date "01/15" → null', () => {
  isNull(parseDate('01/15'));
});

test('Whitespace trimmed: " 01/15/2024 " → "2024-01-15"', () => {
  eq(parseDate(' 01/15/2024 '), '2024-01-15');
});

// ============================================================
//  parsePercent
// ============================================================

console.log('\n  parsePercent\n');

test('"20%" → 20', () => {
  eq(parsePercent('20%'), 20);
});

test('"1.5%" → 1.5', () => {
  eq(parsePercent('1.5%'), 1.5);
});

test('"0%" → 0', () => {
  eq(parsePercent('0%'), 0);
});

test('"100%" → 100', () => {
  eq(parsePercent('100%'), 100);
});

test('Without % sign: "20" → 20', () => {
  eq(parsePercent('20'), 20);
});

test('Null → null', () => {
  isNull(parsePercent(null));
});

test('Empty string → null', () => {
  isNull(parsePercent(''));
});

test('Undefined → null', () => {
  isNull(parsePercent(undefined));
});

test('Whitespace only → null', () => {
  isNull(parsePercent('   '));
});

test('Non-numeric → null', () => {
  isNull(parsePercent('abc%'));
});

// ============================================================
//  parseMultiple
// ============================================================

console.log('\n  parseMultiple\n');

test('"2.5x" → 2.5', () => {
  eq(parseMultiple('2.5x'), 2.5);
});

test('"0.5x" → 0.5', () => {
  eq(parseMultiple('0.5x'), 0.5);
});

test('"1.00" → 1', () => {
  eq(parseMultiple('1.00'), 1);
});

test('"10" → 10', () => {
  eq(parseMultiple('10'), 10);
});

test('Null → null', () => {
  isNull(parseMultiple(null));
});

test('Empty string → null', () => {
  isNull(parseMultiple(''));
});

test('Undefined → null', () => {
  isNull(parseMultiple(undefined));
});

test('Whitespace only → null', () => {
  isNull(parseMultiple('   '));
});

test('"Locked" → null', () => {
  // parseMultiple doesn't special-case "Locked" but parseFloat("Locked") is NaN → null
  isNull(parseMultiple('Locked'));
});

// ============================================================
//  formatMoney
// ============================================================

console.log('\n  formatMoney\n');

test('1000 → "$1,000.00"', () => {
  eq(formatMoney(1000), '$1,000.00');
});

test('1000000 → "$1,000,000.00"', () => {
  eq(formatMoney(1000000), '$1,000,000.00');
});

test('0 → "$0.00"', () => {
  eq(formatMoney(0), '$0.00');
});

test('1234.56 → "$1,234.56"', () => {
  eq(formatMoney(1234.56), '$1,234.56');
});

test('Negative: -500 → "$-500.00"', () => {
  // Node toLocaleString en-US puts minus after $
  eq(formatMoney(-500), '$-500.00');
});

test('Null → "—"', () => {
  eq(formatMoney(null), '—');
});

test('Undefined → "—"', () => {
  eq(formatMoney(undefined), '—');
});

test('Small decimal: 0.5 → "$0.50"', () => {
  eq(formatMoney(0.5), '$0.50');
});

// ============================================================
//  formatMultiple
// ============================================================

console.log('\n  formatMultiple\n');

test('2.5 → "2.50x"', () => {
  eq(formatMultiple(2.5), '2.50x');
});

test('1 → "1.00x"', () => {
  eq(formatMultiple(1), '1.00x');
});

test('0.52 → "0.52x"', () => {
  eq(formatMultiple(0.52), '0.52x');
});

test('10 → "10.00x"', () => {
  eq(formatMultiple(10), '10.00x');
});

test('Null → "—"', () => {
  eq(formatMultiple(null), '—');
});

test('Undefined → "—"', () => {
  eq(formatMultiple(undefined), '—');
});

// ============================================================
//  formatIRR
// ============================================================

console.log('\n  formatIRR\n');

test('0.25 → "+25.0%"', () => {
  eq(formatIRR(0.25), '+25.0%');
});

test('0.152 → "+15.2%"', () => {
  eq(formatIRR(0.152), '+15.2%');
});

test('1.0 → "+100.0%"', () => {
  eq(formatIRR(1.0), '+100.0%');
});

test('0 → "+0.0%"', () => {
  eq(formatIRR(0), '+0.0%');
});

test('-0.18 → "-18.0%"', () => {
  eq(formatIRR(-0.18), '-18.0%');
});

test('-0.5 → "-50.0%"', () => {
  eq(formatIRR(-0.5), '-50.0%');
});

test('Null → "—"', () => {
  eq(formatIRR(null), '—');
});

test('Undefined → "—"', () => {
  eq(formatIRR(undefined), '—');
});

test('Small positive: 0.005 → "+0.5%"', () => {
  eq(formatIRR(0.005), '+0.5%');
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
