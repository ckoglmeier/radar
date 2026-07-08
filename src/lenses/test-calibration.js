#!/usr/bin/env node

// Integration tests for getCalibration() — cold start, blended evolution, and
// maturity transitions, against real deal_evaluations/pipeline_invites/investments
// rows (no synthetic/fixture calibration data baked into the module itself).
// Run: node src/lenses/test-calibration.js

import { query } from '../db/index.js';
import { getCalibration } from './calibration.js';
import { getRubric } from './loader.js';

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

function ok(value, msg = 'expected truthy value') {
  if (!value) throw new Error(msg);
}

function approx(actual, expected, tolerance = 0.01, msg = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ~${expected}, got ${actual}`);
  }
}

// --- Fixture helpers -------------------------------------------------------

async function insertInvestment(companyName) {
  const result = await query(`
    INSERT INTO investments (company_name, status, invest_date, invested, source)
    VALUES ($1, 'Live', '2026-01-01', 5000, 'test')
    RETURNING id
  `, [companyName]);
  return result[0].id;
}

async function insertPipelineInvite(companyName, status) {
  const result = await query(`
    INSERT INTO pipeline_invites (company_name, status, source)
    VALUES ($1, $2, 'test')
    RETURNING id
  `, [companyName, status]);
  return result[0].id;
}

async function insertScoredEval({ companyName, totalScore, verdict, investmentId = null, pipelineInviteId = null, invested = false }) {
  const filePath = `/tmp/test-deal-log/2026-01-01-${companyName.toLowerCase().replace(/\s+/g, '-')}.md`;
  const result = await query(`
    INSERT INTO deal_evaluations (investment_id, pipeline_invite_id, eval_date, file_path, total_score, verdict, invested)
    VALUES ($1, $2, '2026-01-01', $3, $4, $5, $6)
    RETURNING id
  `, [investmentId, pipelineInviteId, filePath, totalScore, verdict, invested]);
  return result[0].id;
}

async function cleanup(stamp) {
  const companies = await query(
    `SELECT id FROM investments WHERE company_name LIKE $1`,
    [`ZZCAL%${stamp}%`]
  );
  const investmentIds = companies.map(r => r.id);

  const invites = await query(
    `SELECT id FROM pipeline_invites WHERE company_name LIKE $1`,
    [`ZZCAL%${stamp}%`]
  );
  const inviteIds = invites.map(r => r.id);

  await query(`DELETE FROM deal_evaluations WHERE file_path LIKE $1`, [`%${stamp}%`]);
  if (investmentIds.length > 0) {
    await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [investmentIds]);
  }
  if (inviteIds.length > 0) {
    await query(`DELETE FROM pipeline_invites WHERE id = ANY($1::int[])`, [inviteIds]);
  }
}

async function run() {
  const stamp = Date.now();
  const name = (n) => `ZZCAL ${n} ${stamp}`;

  try {
    await cleanup(stamp);

    // ==========================================================
    // Cold start: 0 scored deals
    // ==========================================================
    await test('0 deals -> maturity default, empty examples, default thresholds, confidence 0', async () => {
      const cal = await getCalibration();
      // Cold-start behavior is only guaranteed when there truly are no scored
      // deals in the active DB. In this test-local scratch DB that's the case
      // before we insert anything below.
      // Derive expected thresholds positionally (highest/mid/lowest band floor),
      // same as calibration.js's defaultThresholds() — don't hardcode verdict
      // names, since the active lens on any given machine may not be _template
      // (e.g. a personal lens with different band names/counts).
      const rubric = getRubric();
      const sortedBands = [...rubric.verdict_bands].sort((a, b) => b.range[0] - a.range[0]);
      const expectedThresholds = {
        strong: sortedBands[0]?.range[0],
        exploring: sortedBands[1]?.range[0],
        likely_pass: sortedBands[2]?.range[0],
      };

      if (cal.dealsScored === 0) {
        eq(cal.maturity, 'default');
        eq(cal.confidence, 0);
        eq(cal.examples.length, 0);
        eq(cal.thresholds.strong, expectedThresholds.strong);
        eq(cal.thresholds.exploring, expectedThresholds.exploring);
        eq(cal.thresholds.likely_pass, expectedThresholds.likely_pass);
        ok(cal.note.toLowerCase().includes('no scored deals'), 'note should say no scored deals');
        ok(Object.keys(cal.dimensionWeights).length > 0, 'dimensionWeights should carry rubric defaults');
      } else {
        console.log('    (skipped strict cold-start assertions — DB already has scored deals)');
      }
    });

    // ==========================================================
    // A handful of deals -> partial, blended threshold, real examples
    // ==========================================================
    let investedId, passedId, borderlineId;

    await test('a handful of deals -> maturity partial, blended (non-default, non-pure-observed) threshold, real examples', async () => {
      // One clean invest at a high score, one clean pass at a low score —
      // gives estimateRevealedThreshold() a clean separating boundary.
      const invCompany = name('Invested Co');
      const investmentId = await insertInvestment(invCompany);
      investedId = await insertScoredEval({
        companyName: invCompany,
        totalScore: 44,
        verdict: 'Strong fit',
        investmentId,
        invested: true,
      });

      const passCompany = name('Passed Co');
      const passInviteId = await insertPipelineInvite(passCompany, 'passed');
      passedId = await insertScoredEval({
        companyName: passCompany,
        totalScore: 24,
        verdict: 'Likely pass',
        pipelineInviteId: passInviteId,
        invested: false,
      });

      // A borderline deal near the default "exploring" threshold (30), with
      // no outcome yet (still in pipeline) — should still show up as a real
      // example when nothing better matches the borderline slot.
      const borderCompany = name('Borderline Co');
      const borderInviteId = await insertPipelineInvite(borderCompany, 'invite');
      borderlineId = await insertScoredEval({
        companyName: borderCompany,
        totalScore: 31,
        verdict: 'Worth exploring',
        pipelineInviteId: borderInviteId,
        invested: false,
      });

      const cal = await getCalibration();

      ok(cal.dealsScored >= 3, 'dealsScored should include at least the 3 fixtures just inserted');
      eq(cal.maturity, 'partial');
      ok(cal.confidence > 0 && cal.confidence < 1, 'confidence should be a fractional shrinkage weight');

      const rubric = getRubric();
      const sortedBands = [...rubric.verdict_bands].sort((a, b) => b.range[0] - a.range[0]);
      const defaultExploring = sortedBands[1]?.range[0];
      // Revealed boundary from the 44-invested / 24-passed pair is the
      // midpoint = 34. The blended threshold = default*(1-w) + 34*w must sit
      // strictly between the default and 34 (since 0 < w < 1 with other
      // deals in the DB) — neither pure-default nor pure-observed.
      const revealed = 34;
      const lo = Math.min(defaultExploring, revealed);
      const hi = Math.max(defaultExploring, revealed);
      ok(cal.thresholds.exploring !== defaultExploring, 'blended threshold should move off pure default');
      ok(cal.thresholds.exploring > lo - 0.01 && cal.thresholds.exploring < hi + 0.01,
        `blended threshold ${cal.thresholds.exploring} should sit between default ${defaultExploring} and revealed ${revealed}`);

      ok(cal.examples.length > 0, 'examples should be non-empty once deals exist');
      const roles = cal.examples.map(e => e.role);
      ok(roles.includes('invested'), 'should surface an invested example');
      ok(roles.includes('passed'), 'should surface a passed example');

      // Traceability: every example must resolve to a real deal_evaluations id
      // we just inserted (or another pre-existing real row) — never a
      // hardcoded/synthetic fixture baked into the calibration module.
      for (const ex of cal.examples) {
        ok(Number.isInteger(ex.deal_evaluation_id), 'example must carry a real deal_evaluation_id');
        const rows = await query(`SELECT id FROM deal_evaluations WHERE id = $1`, [ex.deal_evaluation_id]);
        ok(rows.length === 1, `example deal_evaluation_id ${ex.deal_evaluation_id} must exist in deal_evaluations`);
      }

      const investedExample = cal.examples.find(e => e.role === 'invested');
      eq(investedExample.deal_evaluation_id, investedId);
      eq(investedExample.company_name, invCompany);

      const passedExample = cal.examples.find(e => e.role === 'passed');
      eq(passedExample.deal_evaluation_id, passedId);
      eq(passedExample.company_name, passCompany);
    });

    // ==========================================================
    // Shrinkage weight math, asserted directly
    // ==========================================================
    await test('shrinkage weight math: w = N / (N + k), k = 15', async () => {
      const cal = await getCalibration();
      const k = 15;
      const expectedW = cal.dealsScored / (cal.dealsScored + k);
      approx(cal.confidence, expectedW, 0.001, 'confidence should equal N/(N+15)');
    });

    // ==========================================================
    // Many deals -> personal maturity
    // ==========================================================
    await test('many deals -> maturity personal', async () => {
      // Need dealsScored >= 30 for 'personal'. Top up with alternating
      // invested/passed deals well clear of the boundary so the revealed
      // threshold stays clean.
      const before = await getCalibration();
      const needed = Math.max(0, 30 - before.dealsScored);
      for (let i = 0; i < needed; i++) {
        const co = name(`Bulk ${i}`);
        if (i % 2 === 0) {
          const investmentId = await insertInvestment(co);
          await insertScoredEval({ companyName: co, totalScore: 42, verdict: 'Strong fit', investmentId, invested: true });
        } else {
          const inviteId = await insertPipelineInvite(co, 'passed');
          await insertScoredEval({ companyName: co, totalScore: 22, verdict: 'Likely pass', pipelineInviteId: inviteId, invested: false });
        }
      }

      const cal = await getCalibration();
      ok(cal.dealsScored >= 30, `expected dealsScored >= 30, got ${cal.dealsScored}`);
      eq(cal.maturity, 'personal');
      ok(cal.confidence >= 30 / (30 + 15) - 0.01, 'confidence should reflect the personal-maturity weight');
      ok(cal.note.toLowerCase().includes('tuned to your judgment'), 'note should reflect personal maturity');
    });
  } finally {
    await cleanup(stamp);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
