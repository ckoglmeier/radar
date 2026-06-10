#!/usr/bin/env node

// Standalone test fixture for parseDealLogFile — no DB required.
// Run: node src/models/test-evaluations.js

import { parseDealLogFile } from './evaluations.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

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
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function approx(actual, expected, tolerance = 0.01) {
  if (actual === null && expected === null) return;
  if (actual === null) throw new Error(`expected ~${expected}, got null`);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`expected ~${expected}, got ${actual}`);
  }
}

function isNull(actual) {
  if (actual !== null) throw new Error(`expected null, got ${JSON.stringify(actual)}`);
}

function notNull(actual) {
  if (actual === null || actual === undefined) throw new Error(`expected non-null, got ${actual}`);
}

// Helper: write markdown to a temp file and parse it
let tmpDir;
function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), 'test-eval-'));
}

function teardown() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function parseMarkdown(filename, content) {
  const filePath = join(tmpDir, filename);
  writeFileSync(filePath, content);
  return parseDealLogFile(filePath);
}

setup();

// =============================================
// Date extraction
// =============================================

console.log('\n  Date Extraction\n');

test('Date from filename (YYYY-MM-DD-company.md)', () => {
  const result = parseMarkdown('2026-04-09-acme.md', '# Deal Log: Acme Corp\nSome content.');
  eq(result.eval_date, '2026-04-09');
});

test('Date from filename takes precedence over content date', () => {
  const result = parseMarkdown('2026-04-09-acme.md',
    '# Deal Log: Acme Corp\n**Date evaluated:** 2026-03-15\nSome content.');
  eq(result.eval_date, '2026-04-09');
});

test('Date from content "Date evaluated:" when no date in filename', () => {
  const result = parseMarkdown('acme.md',
    '# Deal Log: Acme Corp\n**Date evaluated:** 2026-04-13\nSome content.');
  eq(result.eval_date, '2026-04-13');
});

test('Date from content "Date:" when no date in filename', () => {
  const result = parseMarkdown('acme.md',
    '# Deal Log: Acme Corp\n**Date:** 2026-04-08\nSome content.');
  eq(result.eval_date, '2026-04-08');
});

test('Null date when neither filename nor content has date', () => {
  const result = parseMarkdown('acme.md',
    '# Deal Log: Acme Corp\nNo date here.');
  isNull(result.eval_date);
});

// =============================================
// Company name extraction
// =============================================

console.log('\n  Company Name Extraction\n');

test('Company from "# Deal Log: Company"', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Nexus Autonomy\nContent.');
  eq(result.company_name, 'Nexus Autonomy');
});

test('Company from "# Deal Diagnosis: Company"', () => {
  const result = parseMarkdown('test.md', '# Deal Diagnosis: NeuralPath AI\nContent.');
  eq(result.company_name, 'NeuralPath AI');
});

test('Company from "# Deal Assessment: Company"', () => {
  const result = parseMarkdown('test.md', '# Deal Assessment: Quantum Labs\nContent.');
  eq(result.company_name, 'Quantum Labs');
});

test('Company from "# Company — Deal Assessment"', () => {
  const result = parseMarkdown('test.md', '# Retina Robotics — Deal Assessment\nContent.');
  eq(result.company_name, 'Retina Robotics');
});

test('Company from "# Investment Evaluation: Company"', () => {
  // This matches the alt heading pattern (anything before end of line)
  const result = parseMarkdown('test.md', '# Investment Evaluation: Vantage.AI\nContent.');
  eq(result.company_name, 'Investment Evaluation: Vantage.AI');
});

test('Company name strips em-dash suffix from heading', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Acme Corp — Series A\nContent.');
  eq(result.company_name, 'Acme Corp');
});

test('Returns null when no heading found', () => {
  const result = parseMarkdown('test.md', 'No heading here, just text.');
  isNull(result);
});

// =============================================
// Thesis Fit score extraction
// =============================================

console.log('\n  Thesis Fit Score Extraction\n');

test('Thesis Fit from bold markdown: "**Thesis Fit subtotal:** ... **21.5/25**"', () => {
  const content = '# Deal Log: Test\n**Thesis Fit subtotal:** (5x1.5)+(4x1.5) = **21.5/25**';
  const result = parseMarkdown('test.md', content);
  approx(result.thesis_fit_score, 21.5);
});

test('Thesis Fit from table: "| **Thesis Fit subtotal** | **15/25** |"', () => {
  const content = '# Deal Log: Test\n| **Thesis Fit subtotal** | **15/25** |';
  const result = parseMarkdown('test.md', content);
  approx(result.thesis_fit_score, 15);
});

test('Thesis Fit from inline: "**Thesis Fit subtotal: 10/20**"', () => {
  const content = '# Deal Log: Test\n**Thesis Fit subtotal: 10/20**';
  const result = parseMarkdown('test.md', content);
  approx(result.thesis_fit_score, 10);
});

test('Thesis Fit from colon format: "Thesis Fit subtotal: 16/25"', () => {
  const content = '# Deal Log: Test\n- **Thesis Fit subtotal: 16/25**';
  const result = parseMarkdown('test.md', content);
  approx(result.thesis_fit_score, 16);
});

test('Thesis Fit integer score', () => {
  const content = '# Deal Log: Test\n**Thesis Fit subtotal: 11/20**';
  const result = parseMarkdown('test.md', content);
  approx(result.thesis_fit_score, 11);
});

test('Thesis Fit null when not present', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo scores here.');
  isNull(result.thesis_fit_score);
});

// =============================================
// Viability score extraction
// =============================================

console.log('\n  Viability Score Extraction\n');

test('Viability from bold markdown: "**Viability subtotal:** ... **18.5/25**"', () => {
  const content = '# Deal Log: Test\n**Viability subtotal:** (4x1.5)+(3x1.0) = **18.5/25**';
  const result = parseMarkdown('test.md', content);
  approx(result.viability_score, 18.5);
});

test('Viability from table: "| **Viability subtotal** | **22/25** |"', () => {
  const content = '# Deal Log: Test\n| **Viability subtotal** | **22/25** |';
  const result = parseMarkdown('test.md', content);
  approx(result.viability_score, 22);
});

test('Viability from inline: "**Viability subtotal: 13/25**"', () => {
  const content = '# Deal Log: Test\n**Viability subtotal: 13/25**';
  const result = parseMarkdown('test.md', content);
  approx(result.viability_score, 13);
});

test('Viability null when not present', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo scores here.');
  isNull(result.viability_score);
});

// =============================================
// Total score extraction
// =============================================

console.log('\n  Total Score Extraction\n');

test('Total from "### Total: **40/50**"', () => {
  const content = '# Deal Log: Test\n### Total: **40/50**';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 40);
});

test('Total from "## Total: 37/50" (no bold)', () => {
  const content = '# Deal Log: Test\n## Total: 37/50';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 37);
});

test('Total from "## Total: 25/45" (different denominator)', () => {
  const content = '# Deal Log: Test\n## Total: 25/45';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 25);
});

test('Total from single hash heading "# Total: 32/50"', () => {
  const content = '# Deal Log: Test\nSome content\n# Total: 32/50';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 32);
});

test('Total from non-heading line "Total: **42/50**"', () => {
  const content = '# Deal Log: Test\nTotal: **42/50**';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 42);
});

test('Total decimal score "### Total: **38.5/50**"', () => {
  const content = '# Deal Log: Test\n### Total: **38.5/50**';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 38.5);
});

test('Total inside code block "## Total: 37/50"', () => {
  const content = '# Deal Log: Test\n```\n## Total: 37/50\n```';
  const result = parseMarkdown('test.md', content);
  approx(result.total_score, 37);
});

test('Total null when not present', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo total here.');
  isNull(result.total_score);
});

// =============================================
// Verdict extraction
// =============================================

console.log('\n  Verdict Extraction\n');

test('Verdict from "### Verdict: **Strong Fit**"', () => {
  const content = '# Deal Log: Test\n### Verdict: **Strong Fit**';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Strong Fit');
});

test('Verdict from "## Verdict: Likely Pass" (no bold)', () => {
  const content = '# Deal Log: Test\n## Verdict: Likely Pass';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Likely Pass');
});

test('Verdict from "## Verdict: Worth Exploring"', () => {
  const content = '# Deal Log: Test\n## Verdict: Worth Exploring';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Worth Exploring');
});

test('Verdict strips trailing whitespace', () => {
  const content = '# Deal Log: Test\n### Verdict: **Pass**  ';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Pass');
});

test('Verdict from non-heading line "Verdict: **Likely pass**"', () => {
  const content = '# Deal Log: Test\nVerdict: **Likely pass**';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Likely pass');
});

test('Verdict with parenthetical "Worth Exploring (high end...)"', () => {
  const content = '# Deal Log: Test\n## Verdict: Worth Exploring (high end — one or two data points from Strong Fit)';
  const result = parseMarkdown('test.md', content);
  eq(result.verdict, 'Worth Exploring (high end — one or two data points from Strong Fit)');
});

test('Verdict null when not present', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo verdict here.');
  isNull(result.verdict);
});

// =============================================
// Council score extraction
// =============================================

console.log('\n  Council Score Extraction\n');

test('Council Bull score from table "| Bull | 43/50 |"', () => {
  const content = '# Deal Log: Test\n| Bull | 43/50 | Key argument here |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_bull, 43);
});

test('Council Bear score from table "| Bear | 22/50 |"', () => {
  const content = '# Deal Log: Test\n| Bear | 22/50 | Key argument here |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_bear, 22);
});

test('Council Calibrator score from table "| Calibrator | 26/50 |"', () => {
  const content = '# Deal Log: Test\n| Calibrator | 26/50 | Key argument here |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_calibrator, 26);
});

test('Council scores with bold "| **Bull** | **42/50** |"', () => {
  const content = '# Deal Log: Test\n| **Bull** | **42/50** | Argument |\n| **Bear** | **23/50** | Argument |\n| **Calibrator** | **32/50** | Argument |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_bull, 42);
  approx(result.council_bear, 23);
  approx(result.council_calibrator, 32);
});

test('Council null when no council table', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo council data.');
  isNull(result.council_bull);
  isNull(result.council_bear);
  isNull(result.council_calibrator);
});

// =============================================
// CFO verdict extraction
// =============================================

console.log('\n  CFO Verdict Extraction\n');

test('CFO verdict "Deploy" from table "| CFO | — | Deploy ... |"', () => {
  const content = '# Deal Log: Test\n| CFO | — | Deploy — $5K tier; consensus qualifies |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_cfo_verdict, 'Deploy');
});

test('CFO verdict "Pass" from table "| CFO | — | Pass ... |"', () => {
  const content = '# Deal Log: Test\n| CFO | — | Pass — score consensus below threshold |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_cfo_verdict, 'Pass');
});

test('CFO verdict "Defer" from table "| CFO | — | Defer ... |"', () => {
  const content = '# Deal Log: Test\n| CFO | — | Defer — need more data |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_cfo_verdict, 'Defer');
});

test('CFO verdict "Defer" with bold markers "| **CFO** | — | **Defer** ... |"', () => {
  const content = '# Deal Log: Test\n| **CFO** | — | **Defer** — Min check is $10K |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_cfo_verdict, 'Defer');
});

test('CFO verdict from section fallback "Verdict: Deploy"', () => {
  const content = '# Deal Log: Test\n### CFO (Portfolio Construction)\nSome analysis.\nVerdict: Deploy at $2K tier.';
  const result = parseMarkdown('test.md', content);
  eq(result.council_cfo_verdict, 'Deploy');
});

test('CFO verdict null when not present', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo CFO data.');
  isNull(result.council_cfo_verdict);
});

// =============================================
// Council computed fields (spread, consensus, divergence)
// =============================================

console.log('\n  Council Computed Fields\n');

test('Spread = max - min of council scores', () => {
  const content = '# Deal Log: Test\n| Bull | 43/50 | x |\n| Bear | 37/50 | x |\n| Calibrator | 40/50 | x |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_spread, 6);
});

test('Consensus = average of council scores (3 voices)', () => {
  const content = '# Deal Log: Test\n| Bull | 43/50 | x |\n| Bear | 37/50 | x |\n| Calibrator | 40/50 | x |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_consensus, 40);
});

test('Divergence LOW when spread <= 5', () => {
  const content = '# Deal Log: Test\n| Bull | 40/50 | x |\n| Bear | 36/50 | x |\n| Calibrator | 38/50 | x |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_divergence, 'LOW');
});

test('Divergence MODERATE when spread 6-10', () => {
  const content = '# Deal Log: Test\n| Bull | 43/50 | x |\n| Bear | 37/50 | x |\n| Calibrator | 40/50 | x |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_divergence, 'MODERATE');
});

test('Divergence HIGH when spread > 10', () => {
  const content = '# Deal Log: Test\n| Bull | 42/50 | x |\n| Bear | 23/50 | x |\n| Calibrator | 32/50 | x |';
  const result = parseMarkdown('test.md', content);
  eq(result.council_divergence, 'HIGH');
});

test('Computed fields work with only 2 council scores', () => {
  const content = '# Deal Log: Test\n| Bull | 40/50 | x |\n| Bear | 30/50 | x |';
  const result = parseMarkdown('test.md', content);
  approx(result.council_spread, 10);
  approx(result.council_consensus, 35);
  eq(result.council_divergence, 'MODERATE');
});

test('Computed fields null when fewer than 2 council scores', () => {
  const content = '# Deal Log: Test\n| Bull | 40/50 | x |';
  const result = parseMarkdown('test.md', content);
  isNull(result.council_spread);
  isNull(result.council_consensus);
  isNull(result.council_divergence);
});

test('Computed fields null when no council scores', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Test\nNo council.');
  isNull(result.council_spread);
  isNull(result.council_consensus);
  isNull(result.council_divergence);
});

// =============================================
// Null handling / edge cases
// =============================================

console.log('\n  Null Handling & Edge Cases\n');

test('Returns null for file with no parseable heading', () => {
  const result = parseMarkdown('test.md', 'Just some text, no heading.');
  isNull(result);
});

test('Returns object with null fields for minimal valid file', () => {
  const result = parseMarkdown('test.md', '# Deal Log: Minimal Co\nNothing else.');
  notNull(result);
  eq(result.company_name, 'Minimal Co');
  isNull(result.eval_date);
  isNull(result.thesis_fit_score);
  isNull(result.viability_score);
  isNull(result.total_score);
  isNull(result.verdict);
  isNull(result.council_bull);
  isNull(result.council_bear);
  isNull(result.council_calibrator);
  isNull(result.council_cfo_verdict);
  isNull(result.council_spread);
  isNull(result.council_consensus);
  isNull(result.council_divergence);
});

test('file_path is set in result', () => {
  const result = parseMarkdown('2026-01-01-test.md', '# Deal Log: PathCo\nContent.');
  notNull(result);
  if (!result.file_path.endsWith('2026-01-01-test.md')) {
    throw new Error(`expected file_path to end with filename, got ${result.file_path}`);
  }
});

// =============================================
// Integration tests against synthetic deal-log fixtures
// =============================================

console.log('\n  Integration Tests (synthetic deal-log fixtures)\n');

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures/deal-log');

// 1. Acme Autonomy — "Deal Log:" heading, date in filename, council table
test('Fixture: Acme Autonomy — full parse (Deal Log heading, filename date, council table)', () => {
  const result = parseDealLogFile(join(FIXTURE_DIR, '2026-04-09-acme-autonomy.md'));
  notNull(result);
  eq(result.eval_date, '2026-04-09');
  eq(result.company_name, 'Acme Autonomy');
  approx(result.thesis_fit_score, 21.5);
  approx(result.viability_score, 18.5);
  approx(result.total_score, 40);
  eq(result.verdict, 'Strong Fit');
  approx(result.council_bull, 43);
  approx(result.council_bear, 37);
  approx(result.council_calibrator, 40);
  approx(result.council_spread, 6);
  approx(result.council_consensus, 40);
  eq(result.council_divergence, 'MODERATE');
  eq(result.council_cfo_verdict, 'Deploy');
});

// 2. Borealis Bio — "Investment Evaluation:" heading, "Date:" in content, /20 denominator thesis
test('Fixture: Borealis Bio — alternate heading format, /20 thesis denominator', () => {
  const result = parseDealLogFile(join(FIXTURE_DIR, '2026-04-08-borealis-bio.md'));
  notNull(result);
  eq(result.eval_date, '2026-04-08');
  // Heading is "# Investment Evaluation: Borealis Bio" — matches alt heading pattern
  notNull(result.company_name);
  approx(result.thesis_fit_score, 11);
  approx(result.viability_score, 13);
  approx(result.total_score, 24);
  eq(result.verdict, 'Likely pass');
  approx(result.council_bull, 30);
  approx(result.council_bear, 22);
  approx(result.council_calibrator, 26);
  approx(result.council_spread, 8);
  approx(result.council_consensus, 26);
  eq(result.council_divergence, 'MODERATE');
  eq(result.council_cfo_verdict, 'Pass');
});

// 3. Delta Dynamics — "Company — Deal Assessment" heading, no date in filename, code block total
test('Fixture: Delta Dynamics — alt heading, no filename date, code block scores', () => {
  const result = parseDealLogFile(join(FIXTURE_DIR, 'delta-dynamics.md'));
  notNull(result);
  // Date from content "**Date:** 2026-04-08"
  eq(result.eval_date, '2026-04-08');
  eq(result.company_name, 'Delta Dynamics');
  approx(result.thesis_fit_score, 15);
  approx(result.viability_score, 22);
  approx(result.total_score, 37);
  // Verdict is inside code block: "## Verdict: Worth Exploring (high end...)"
  notNull(result.verdict);
  if (!result.verdict.startsWith('Worth Exploring')) {
    throw new Error(`expected verdict starting with "Worth Exploring", got "${result.verdict}"`);
  }
  approx(result.council_bull, 40);
  approx(result.council_bear, 34);
  approx(result.council_calibrator, 37);
  approx(result.council_spread, 6);
  approx(result.council_consensus, 37);
  eq(result.council_divergence, 'MODERATE');
  // CFO says "Pass (confirmed by CK)"
  eq(result.council_cfo_verdict, 'Pass');
});

// 4. Epsilon AI — "Deal Log:" heading, date in filename+content, HIGH divergence, Defer CFO
test('Fixture: Epsilon AI — high divergence council, Defer CFO', () => {
  const result = parseDealLogFile(join(FIXTURE_DIR, '2026-04-13-epsilon-ai.md'));
  notNull(result);
  eq(result.eval_date, '2026-04-13');
  eq(result.company_name, 'Epsilon AI INC.');
  approx(result.thesis_fit_score, 16);
  approx(result.viability_score, 16);
  approx(result.total_score, 32);
  eq(result.verdict, 'Worth Exploring');
  approx(result.council_bull, 42);
  approx(result.council_bear, 23);
  approx(result.council_calibrator, 32);
  approx(result.council_spread, 19);
  approx(result.council_consensus, 32.33, 0.1);
  eq(result.council_divergence, 'HIGH');
  eq(result.council_cfo_verdict, 'Defer');
});

// =============================================
// Summary
// =============================================

teardown();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
