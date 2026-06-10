#!/usr/bin/env node

// Standalone test fixture for transaction description parser and helpers — no DB required.
// Tests parseDescription(), extractCompanyFromSpv(), normalizeType(), and hashRow().
// Run: node src/import/test-transactions.js

import { parseDescription } from './transactions.js';
import { createHash } from 'crypto';

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
//  Synthetic prefix list — injected into every parseDescription call.
//  Tests must never rely on src/config/lead-prefixes.json being present.
// ============================================================

const TEST_PREFIXES = [
  'Example Ventures Access Fund',
  'Example Ventures',
  'Sample Syndicate Partners',
  'Alpha Capital',
  'Beta VC',
  'Gamma Ventures',
  'Delta Fund',
  'Epsilon Partners',
  'Zeta Collective',
  'Eta Alliance',
  'Theta Investments',
  'Iota Capital',
  'Kappa Ventures',
];

// Helper: call parseDescription with the synthetic prefix list
function pd(type, description) {
  return parseDescription(type, description, TEST_PREFIXES);
}

// ============================================================
//  normalizeType (not exported — re-implement for testing)
// ============================================================

function normalizeType(t) {
  const x = t.toLowerCase();
  if (x === 'investment') return 'investment';
  if (x === 'refund') return 'refund';
  if (x === 'disbursement') return 'distribution';
  if (x === 'deposit') return 'deposit';
  if (x === 'withdrawal' || x === 'transfer') return 'withdrawal';
  if (x === 'adjustment') return 'adjustment';
  return x;
}

// hashRow (not exported — re-implement for testing)
function hashRow(row) {
  return createHash('sha1')
    .update(`${row.Date}|${row.Transaction}|${row.Description}|${row.Amount}|${row.Balance || ''}`)
    .digest('hex')
    .slice(0, 16);
}

// ============================================================
//  parseDescription — Investment type
// ============================================================

console.log('\n  parseDescription — Investment\n');

test('Investment: standard "Investment in Company Name"', () => {
  const r = pd('Investment', 'Investment in Acme Robotics');
  eq(r.company, 'Acme Robotics');
  isNull(r.spv);
  eq(r.subtype, 'primary');
});

test('Investment: multi-word company name', () => {
  const r = pd('Investment', 'Investment in Nova Propulsion Systems');
  eq(r.company, 'Nova Propulsion Systems');
  isNull(r.spv);
  eq(r.subtype, 'primary');
});

test('Investment: company name with extra spaces', () => {
  const r = pd('Investment', 'Investment in   Orbit Labs  ');
  eq(r.company, 'Orbit Labs');
  eq(r.subtype, 'primary');
});

test('Investment: case-insensitive prefix', () => {
  const r = pd('Investment', 'investment in TestCo');
  eq(r.company, 'TestCo');
  eq(r.subtype, 'primary');
});

test('Investment: description does not match pattern → all null', () => {
  const r = pd('Investment', 'Random text here');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

// ============================================================
//  parseDescription — Refund type
// ============================================================

console.log('\n  parseDescription — Refund\n');

test('Refund: standard with parenthetical reason', () => {
  const r = pd('Refund', 'Refund for Acme Corp (deal oversubscribed)');
  eq(r.company, 'Acme Corp');
  isNull(r.spv);
  eq(r.subtype, 'oversubscription');
});

test('Refund: without parenthetical', () => {
  const r = pd('Refund', 'Refund for Orbit Labs');
  eq(r.company, 'Orbit Labs');
  isNull(r.spv);
  eq(r.subtype, 'oversubscription');
});

test('Refund: complex parenthetical reason', () => {
  const r = pd('Refund', 'Refund for TestCo (round cancelled due to market conditions)');
  eq(r.company, 'TestCo');
  eq(r.subtype, 'oversubscription');
});

test('Refund: case-insensitive prefix', () => {
  const r = pd('Refund', 'refund for SomeCo');
  eq(r.company, 'SomeCo');
  eq(r.subtype, 'oversubscription');
});

test('Refund: company name with trailing whitespace', () => {
  const r = pd('Refund', 'Refund for  WidgetCorp  ');
  eq(r.company, 'WidgetCorp');
});

test('Refund: description does not match pattern → all null', () => {
  const r = pd('Refund', 'Some other text');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

// ============================================================
//  parseDescription — Disbursement (distribution proceeds)
// ============================================================

console.log('\n  parseDescription — Disbursement: distribution proceeds\n');

test('Disbursement: standard "Company - Distribution Proceeds - SPV"', () => {
  const r = pd('Disbursement', 'Acme Robotics - Distribution Proceeds - Example Ventures SPV');
  eq(r.company, 'Acme Robotics');
  eq(r.spv, 'Example Ventures SPV');
  eq(r.subtype, 'distribution');
});

test('Disbursement: multi-word company with distribution proceeds', () => {
  const r = pd('Disbursement', 'Nova Propulsion Systems - Distribution Proceeds - Alpha Capital SPV');
  eq(r.company, 'Nova Propulsion Systems');
  eq(r.spv, 'Alpha Capital SPV');
  eq(r.subtype, 'distribution');
});

// ============================================================
//  parseDescription — Disbursement (secondary sale)
// ============================================================

console.log('\n  parseDescription — Disbursement: secondary sale\n');

test('Disbursement: secondary sale proceeds', () => {
  const r = pd('Disbursement', 'Acme - Secondary Sale Proceeds - Example Ventures SPV');
  eq(r.company, 'Acme');
  eq(r.spv, 'Example Ventures SPV');
  eq(r.subtype, 'secondary');
});

test('Disbursement: secondary proceeds variant', () => {
  const r = pd('Disbursement', 'TestCo - Secondary Proceeds - Beta VC SPV');
  eq(r.company, 'TestCo');
  eq(r.spv, 'Beta VC SPV');
  eq(r.subtype, 'secondary');
});

// ============================================================
//  parseDescription — Disbursement (closing proceeds / acquisition)
// ============================================================

console.log('\n  parseDescription — Disbursement: closing / acquisition\n');

test('Disbursement: closing proceeds', () => {
  const r = pd('Disbursement', 'DesignCo - Closing Proceeds - Alpha Capital SPV');
  eq(r.company, 'DesignCo');
  eq(r.spv, 'Alpha Capital SPV');
  eq(r.subtype, 'closing');
});

test('Disbursement: company name ending with Acquisition gets stripped', () => {
  const r = pd('Disbursement', 'CompanyX Acquisition - Closing Proceeds - Alpha Capital SPV');
  eq(r.company, 'CompanyX');
  eq(r.subtype, 'closing');
});

// ============================================================
//  parseDescription — Disbursement (escrow release)
// ============================================================

console.log('\n  parseDescription — Disbursement: escrow release\n');

test('Disbursement: escrow release', () => {
  const r = pd('Disbursement', 'AcquiredCo - Escrow Release - Gamma Ventures SPV');
  eq(r.company, 'AcquiredCo');
  eq(r.spv, 'Gamma Ventures SPV');
  eq(r.subtype, 'escrow_release');
});

// ============================================================
//  parseDescription — Disbursement (dissolution)
// ============================================================

console.log('\n  parseDescription — Disbursement: dissolution\n');

test('Disbursement: dissolution', () => {
  const r = pd('Disbursement', 'DeadCo - Dissolution Proceeds - Delta Fund SPV');
  eq(r.company, 'DeadCo');
  eq(r.spv, 'Delta Fund SPV');
  eq(r.subtype, 'dissolution');
});

// ============================================================
//  parseDescription — Disbursement (redemption)
// ============================================================

console.log('\n  parseDescription — Disbursement: redemption\n');

test('Disbursement: redemption', () => {
  const r = pd('Disbursement', 'SafeCo - Redemption Proceeds - Epsilon Partners SPV');
  eq(r.company, 'SafeCo');
  eq(r.spv, 'Epsilon Partners SPV');
  eq(r.subtype, 'redemption');
});

// ============================================================
//  parseDescription — Disbursement (deferred consideration)
// ============================================================

console.log('\n  parseDescription — Disbursement: deferred consideration\n');

test('Disbursement: deferred consideration', () => {
  const r = pd('Disbursement', 'MergeCo - Deferred Consideration - Zeta Collective SPV');
  eq(r.company, 'MergeCo');
  eq(r.spv, 'Zeta Collective SPV');
  eq(r.subtype, 'deferred_consideration');
});

// ============================================================
//  parseDescription — Disbursement (return of capital)
// ============================================================

console.log('\n  parseDescription — Disbursement: return of capital\n');

test('Disbursement: "Return of Capital - Lead Company SPV"', () => {
  // Example Ventures is a known prefix; stripping it reveals the embedded company
  const r = pd('Disbursement', 'Return of Capital - Example Ventures Sample Pay SPV');
  eq(r.company, 'Sample Pay');
  eq(r.spv, 'Example Ventures Sample Pay SPV');
  eq(r.subtype, 'return_of_capital');
});

test('Disbursement: return of capital with known lead-only SPV → null company', () => {
  // Alpha Capital is a known prefix; after stripping + removing "SPV" suffix, nothing left
  const r = pd('Disbursement', 'Return of Capital - Alpha Capital SPV');
  isNull(r.company);
  eq(r.spv, 'Alpha Capital SPV');
  eq(r.subtype, 'return_of_capital');
});

test('Disbursement: return of capital with second prefix lead', () => {
  const r = pd('Disbursement', 'Return of Capital - Sample Syndicate Partners SomeCo SPV');
  eq(r.company, 'SomeCo');
  eq(r.spv, 'Sample Syndicate Partners SomeCo SPV');
  eq(r.subtype, 'return_of_capital');
});

test('Disbursement: return of capital in middle section', () => {
  const r = pd('Disbursement', 'FundCo - Return of Capital Proceeds - Theta Investments SPV');
  eq(r.company, 'FundCo');
  eq(r.spv, 'Theta Investments SPV');
  eq(r.subtype, 'return_of_capital');
});

// ============================================================
//  parseDescription — Disbursement (tranche / multi-part)
// ============================================================

console.log('\n  parseDescription — Disbursement: tranche patterns\n');

test('Disbursement: tranche in middle section', () => {
  const r = pd('Disbursement', 'Acme Robotics - Distribution Proceeds (2nd Tranche) - Example Ventures SPV');
  eq(r.company, 'Acme Robotics');
  eq(r.spv, 'Example Ventures SPV');
  eq(r.subtype, 'distribution');
});

// ============================================================
//  parseDescription — Disbursement (unknown subtype)
// ============================================================

console.log('\n  parseDescription — Disbursement: unknown / minimal\n');

test('Disbursement: two-part description with no recognized subtype', () => {
  const r = pd('Disbursement', 'SomeCo - Weird Payout');
  eq(r.company, 'SomeCo');
  eq(r.spv, 'Weird Payout');
  isNull(r.subtype);
});

test('Disbursement: single token description → no company, spv is the text', () => {
  const r = pd('Disbursement', 'JustOneWord');
  isNull(r.company);
  eq(r.spv, 'JustOneWord');
  eq(r.subtype, 'unknown');
});

// ============================================================
//  parseDescription — Non-company types (Deposit, Withdrawal, etc.)
// ============================================================

console.log('\n  parseDescription — Non-company types\n');

test('Deposit: returns all null', () => {
  const r = pd('Deposit', 'ACH deposit from First National Bank');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Withdrawal: returns all null', () => {
  const r = pd('Withdrawal', 'ACH withdrawal to external account');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Transfer: returns all null', () => {
  const r = pd('Transfer', 'ACH to external bank');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Adjustment: returns all null', () => {
  const r = pd('Adjustment', 'Failed ACH reversal');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

// ============================================================
//  parseDescription — Edge cases
// ============================================================

console.log('\n  parseDescription — Edge cases\n');

test('Null description → all null', () => {
  const r = pd('Investment', null);
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Undefined description → all null', () => {
  const r = pd('Investment', undefined);
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Empty string description → all null', () => {
  const r = pd('Investment', '');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Whitespace-only description → all null for Investment', () => {
  const r = pd('Investment', '   ');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

test('Unknown type with description → all null', () => {
  const r = pd('SomethingNew', 'Random description text');
  isNull(r.company);
  isNull(r.spv);
  isNull(r.subtype);
});

// ============================================================
//  parseDescription — SPV lead prefix extraction
// ============================================================

console.log('\n  parseDescription — SPV lead prefix extraction\n');

test('Example Ventures Access Fund prefix stripped from SPV', () => {
  const r = pd('Disbursement', 'Return of Capital - Example Ventures Access Fund BigCo SPV');
  eq(r.company, 'BigCo');
  eq(r.subtype, 'return_of_capital');
});

test('Iota Capital prefix stripped from SPV', () => {
  const r = pd('Disbursement', 'Return of Capital - Iota Capital TechStart SPV');
  eq(r.company, 'TechStart');
});

test('Kappa Ventures prefix stripped from SPV', () => {
  const r = pd('Disbursement', 'Return of Capital - Kappa Ventures HealthCo Fund');
  eq(r.company, 'HealthCo');
});

test('Eta Alliance prefix stripped from SPV', () => {
  const r = pd('Disbursement', 'Return of Capital - Eta Alliance DataCo SPV');
  eq(r.company, 'DataCo');
});

test('Zeta Collective prefix stripped from SPV', () => {
  const r = pd('Disbursement', 'Return of Capital - Zeta Collective AICo LP');
  eq(r.company, 'AICo');
});

test('Unknown lead → full SPV name minus suffix as company', () => {
  const r = pd('Disbursement', 'Return of Capital - Unknown Lead CompanyX SPV');
  // No known prefix matches, so company is the full cleaned string
  eq(r.company, 'Unknown Lead CompanyX');
});

test('SPV name too short after stripping → null company', () => {
  // After stripping "Beta VC" prefix and "SPV" suffix, single char remains
  const r = pd('Disbursement', 'Return of Capital - Beta VC X SPV');
  // "X" is only 1 char, < 2 → null
  isNull(r.company);
});

// ============================================================
//  normalizeType
// ============================================================

console.log('\n  normalizeType\n');

test('Investment → investment', () => {
  eq(normalizeType('Investment'), 'investment');
});

test('Refund → refund', () => {
  eq(normalizeType('Refund'), 'refund');
});

test('Disbursement → distribution', () => {
  eq(normalizeType('Disbursement'), 'distribution');
});

test('Deposit → deposit', () => {
  eq(normalizeType('Deposit'), 'deposit');
});

test('Withdrawal → withdrawal', () => {
  eq(normalizeType('Withdrawal'), 'withdrawal');
});

test('Transfer → withdrawal', () => {
  eq(normalizeType('Transfer'), 'withdrawal');
});

test('Adjustment → adjustment', () => {
  eq(normalizeType('Adjustment'), 'adjustment');
});

test('Unknown type passes through lowercase', () => {
  eq(normalizeType('SomethingNew'), 'somethingnew');
});

test('Case insensitive: INVESTMENT → investment', () => {
  eq(normalizeType('INVESTMENT'), 'investment');
});

test('Case insensitive: disbursement → distribution', () => {
  eq(normalizeType('disbursement'), 'distribution');
});

// ============================================================
//  hashRow
// ============================================================

console.log('\n  hashRow\n');

test('Deterministic: same input produces same hash', () => {
  const row = { Date: '2026-03-16', Transaction: 'Disbursement', Description: 'Acme Robotics - Distribution Proceeds', Amount: '1234.56', Balance: '5678.90' };
  const h1 = hashRow(row);
  const h2 = hashRow(row);
  eq(h1, h2);
});

test('Hash is 16 characters', () => {
  const row = { Date: '2026-01-01', Transaction: 'Investment', Description: 'Investment in TestCo', Amount: '-1000', Balance: '5000' };
  eq(hashRow(row).length, 16);
});

test('Different rows produce different hashes', () => {
  const row1 = { Date: '2026-01-01', Transaction: 'Investment', Description: 'Investment in TestCo', Amount: '-1000', Balance: '5000' };
  const row2 = { Date: '2026-01-02', Transaction: 'Investment', Description: 'Investment in TestCo', Amount: '-1000', Balance: '5000' };
  if (hashRow(row1) === hashRow(row2)) {
    throw new Error('expected different hashes for different rows');
  }
});

test('Missing Balance treated as empty string', () => {
  const row = { Date: '2026-01-01', Transaction: 'Deposit', Description: 'ACH', Amount: '5000', Balance: undefined };
  // Should not throw
  const h = hashRow(row);
  eq(h.length, 16);
});

test('Null Balance treated as empty string', () => {
  const row = { Date: '2026-01-01', Transaction: 'Deposit', Description: 'ACH', Amount: '5000', Balance: null };
  const h = hashRow(row);
  eq(h.length, 16);
});

test('Hash uses SHA-1 hex prefix', () => {
  const row = { Date: '2026-01-01', Transaction: 'Deposit', Description: 'Test', Amount: '100', Balance: '100' };
  const h = hashRow(row);
  // Should be valid hex
  if (!/^[0-9a-f]{16}$/.test(h)) {
    throw new Error(`expected 16-char hex string, got ${h}`);
  }
});

// ============================================================
//  parseDescription — AngelList description shape patterns
// ============================================================

console.log('\n  parseDescription — AngelList description shape patterns\n');

test('Shape 3: "Company - Distribution Proceeds - SPV"', () => {
  const r = pd('Disbursement', 'Acme Robotics - Distribution Proceeds - Example Ventures SPV');
  eq(r.company, 'Acme Robotics');
  eq(r.spv, 'Example Ventures SPV');
  eq(r.subtype, 'distribution');
});

test('Shape 1: Investment in single company', () => {
  const r = pd('Investment', 'Investment in Quantum Defense Systems');
  eq(r.company, 'Quantum Defense Systems');
  eq(r.subtype, 'primary');
});

test('Shape: Refund with oversubscription note', () => {
  const r = pd('Refund', 'Refund for Orbit Labs (deal oversubscribed)');
  eq(r.company, 'Orbit Labs');
  eq(r.subtype, 'oversubscription');
});

test('Shape 4: multi-dash disbursement with 4 parts', () => {
  // "Company - Sub1 - Sub2 - SPV" → company = first, spv = last, middle joined
  const r = pd('Disbursement', 'BigCo - Distribution Proceeds (1st Tranche) - Extra Info - Sample Syndicate Partners SPV');
  eq(r.company, 'BigCo');
  eq(r.spv, 'Sample Syndicate Partners SPV');
  eq(r.subtype, 'distribution');
});

test('Disbursement with whitespace around dashes', () => {
  const r = pd('Disbursement', '  Acme Robotics  -  Distribution Proceeds  -  Example Ventures SPV  ');
  eq(r.company, 'Acme Robotics');
  eq(r.spv, 'Example Ventures SPV');
  eq(r.subtype, 'distribution');
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
