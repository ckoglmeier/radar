#!/usr/bin/env node

// B2 contract test: a deal-log artifact written in the vendored SKILL.md's
// output format must parse cleanly through the EXISTING parseDealLogFile —
// proving the council's generated output ingests into deal_evaluations with the
// right council fields (no new ingestion code; the parse/compute/store pipeline
// already exists and is tested elsewhere).
// Run: node src/council/test-ingest.js

import { writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseDealLogContent, parseDealLogFile } from '../models/evaluations.js';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); passed++; } catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; } }
function eq(a, b, m = '') { if (a !== b) throw new Error(`${m ? m + ': ' : ''}expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function approx(a, b, tol = 0.01, m = '') { if (Math.abs(a - b) > tol) throw new Error(`${m ? m + ': ' : ''}expected ~${b}, got ${a}`); }

// A sample artifact in EXACTLY the format SKILL.md's Output section specifies.
const SAMPLE = `# Deal Log: Acme Autonomy

**Date:** 2026-07-08 · headless council run · calibration: partial

| Field | Value |
|---|---|
| Company | Acme Autonomy |
| Stage | Series A |

## Team Dossier
Jane Doe, CEO — a decade in autonomy; credible builder for this problem.

## Company Context
$3.1M ARR, RaaS model, industrial customers.

## Gates
Kill criteria: none triggered
Primary thesis: Intelligence for Physical Systems

## Thesis Fit
- Domain match: 5/5 — core thesis
- Compounding structure: 4/5 — RaaS flywheel
- **Thesis Fit subtotal: 21/25**

## Viability
- Team-market fit: 4/5 — domain insider
- Capital efficiency: 3/5 — hardware-typical
- **Viability subtotal: 18/25**

## Total: 39/50
## Verdict: Worth exploring

## Council Evaluation

| Voice | Score | Key argument |
|---|---|---|
| Bull | 43/50 | Vision-only autonomy is a narrow moat; clean ARR compounding. |
| Bear | 37/50 | ARR-to-capital is unexceptional; gross margin unconfirmed. |
| Calibrator | 39/50 | Real commercial validation; capital-efficiency gap caps it. |
| CFO | — | Deploy — $5K tier; confirm margin before wire. |

## What Would Change This Analysis
### Moves this up
- A signed Tier-1 OEM LOI → Differentiation 3→5, into Strong fit.
### Moves this down
- Gross margin under 40% → Capital efficiency 3→1.
### Net assessment
Confirm hardware gross margin before the call.

## Key Questions
- What is gross margin at current deployment scale?

## Draft Response
**Email:** The vision-only autonomy stack is the part worth a closer look. I'd want to understand your design-partner pipeline and gross-margin trajectory. Open to 30 minutes next week?
**LinkedIn:** Vision-only autonomy here is the interesting part — worth a short conversation on unit economics.
`;

const dir = mkdtempSync(join(tmpdir(), 'radar-council-ingest-'));
const filePath = join(dir, '2026-07-08-acme-autonomy.md');
writeFileSync(filePath, SAMPLE);

console.log('\n  Council ingest contract (B2) tests\n');

const p = parseDealLogFile(filePath);

test('parses (company_name present -> not null)', () => { if (!p) throw new Error('parseDealLogFile returned null'); });
test('company_name from H1 heading', () => eq(p.company_name, 'Acme Autonomy'));
test('eval_date from filename', () => eq(p.eval_date, '2026-07-08'));
test('thesis_fit_score from subtotal', () => eq(p.thesis_fit_score, 21));
test('viability_score from subtotal', () => eq(p.viability_score, 18));
test('total_score from ## Total', () => eq(p.total_score, 39));
test('verdict from ## Verdict', () => eq(p.verdict, 'Worth exploring'));
test('council Bull/Bear/Calibrator extracted', () => { eq(p.council_bull, 43); eq(p.council_bear, 37); eq(p.council_calibrator, 39); });
test('CFO verdict extracted from table row', () => eq(p.council_cfo_verdict, 'Deploy'));
test('spread computed (43-37=6)', () => eq(p.council_spread, 6));
test('consensus computed (mean 43/37/39)', () => approx(p.council_consensus, (43 + 37 + 39) / 3));
test('divergence MODERATE (spread 6 > 5)', () => eq(p.council_divergence, 'MODERATE'));

const RUBRIC = {
  sections: [
    {
      name: 'Thesis Fit',
      dimensions: [
        { name: 'Domain match', max_points: 8, scale: [1, 5] },
        { name: 'Compounding structure', max_points: 7, scale: [1, 5] },
        { name: 'Structural tailwind', max_points: 5, scale: [1, 5] },
        { name: 'Portfolio construction fit', max_points: 5, scale: [1, 5] },
      ],
    },
    {
      name: 'Viability',
      dimensions: [
        { name: 'Team-market fit', max_points: 8, scale: [1, 5] },
        { name: 'Capital efficiency', max_points: 5, scale: [1, 5] },
        { name: 'Business model clarity', max_points: 5, scale: [1, 5] },
        { name: 'Differentiation', max_points: 5, scale: [1, 5] },
        { name: 'Source quality', max_points: 2, scale: [1, 5] },
      ],
    },
  ],
  verdict_bands: [
    { range: [44, 50], verdict: 'Fund' },
    { range: [39, 43], verdict: 'Review' },
    { range: [0, 38], verdict: 'Pass' },
  ],
};

const BAD_MATH = `# Deal Log: Archera

## Thesis Fit
- Domain match: 2/5 (points: 2/8)
- Compounding structure: 4/5 (points: 4/7)
- Structural tailwind: 3/5 (points: 3/5)
- Portfolio construction fit: 2/5 (points: 2/5)
- **Thesis Fit subtotal: 11/25**

## Viability
- Team-market fit: 4/5
- Capital efficiency: 4/5
- Business model clarity: 4/5
- Differentiation: 3/5
- Source quality: 5/5
- **Viability subtotal: 19/25**

## Total: 30/50
## Verdict: Pass

| Voice | Score | Key argument |
|---|---|---|
| Bull | 37/50 | Upside |
| Bear | 22/50 | Risk |
| Calibrator | 30/50 | Reconcile |
| CFO | — | Pass — off thesis |
`;

const corrected = parseDealLogContent(BAD_MATH, null, { rubric: RUBRIC });
test('Council arithmetic is recomputed from dimension choices', () => {
  eq(corrected.thesis_fit_score, 14);
  eq(corrected.viability_score, 19);
  eq(corrected.total_score, 33);
  eq(corrected.council_calibrator, 33);
  eq(corrected.verdict, 'Pass');
  eq(corrected.score_validation.adjusted, true);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
