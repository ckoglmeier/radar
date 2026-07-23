#!/usr/bin/env node

// Integration fixtures for the Pipeline ⇄ Evals consolidation.
// Run under test:local so every mutation stays inside the scratch PGlite DB.

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query } from '../db/index.js';
import { importDealLogs, evaluationHistoryForInvite } from '../models/evaluations.js';
import { pipelineListWithLatestEval } from './pipeline.js';
import { evaluationLedger } from './evaluations.js';
import { backfillEvaluationLinks } from '../db/backfill-eval-links.js';

const PREFIX = 'ZZPIPEEVAL';
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed++;
  }
}

function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, message = 'expected truthy value') {
  if (!value) throw new Error(message);
}

function dateOnly(value) {
  if (value instanceof Date) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
      .join('-');
  }
  return String(value).slice(0, 10);
}

async function insertInvite(company, slug, status = 'invite') {
  const rows = await query(
    `INSERT INTO pipeline_invites (company_name, deal_slug, source, status, email_received_at)
     VALUES ($1, $2, 'test', $3, NOW())
     RETURNING id`,
    [company, slug, status]
  );
  return rows[0].id;
}

async function insertInvestment(company) {
  const rows = await query(
    `INSERT INTO investments (company_name, invest_date, status, invested)
     VALUES ($1, '1994-01-01', 'Live', 1000)
     RETURNING id`,
    [company]
  );
  return rows[0].id;
}

async function insertEvaluation({
  company,
  date,
  score,
  path,
  inviteId = null,
  investmentId = null,
  mode = 'standard',
}) {
  const rows = await query(
    `INSERT INTO deal_evaluations
       (company_name, eval_date, total_score, verdict, file_path,
        pipeline_invite_id, investment_id, eval_mode, raw_content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      company,
      date,
      score,
      score >= 39 ? 'Strong fit' : score >= 30 ? 'Worth exploring' : 'Pass',
      path,
      inviteId,
      investmentId,
      mode,
      `# Deal Evaluation: ${company}\n\nSource fixture for ${company}.`,
    ]
  );
  return rows[0].id;
}

async function cleanup() {
  await query(`DELETE FROM deal_evaluations WHERE company_name LIKE $1`, [`${PREFIX}%`]);
  await query(`DELETE FROM pipeline_invites WHERE company_name LIKE $1`, [`${PREFIX}%`]);
  await query(`DELETE FROM investments WHERE company_name LIKE $1`, [`${PREFIX}%`]);
}

async function run() {
  const tempEvalDir = mkdtempSync(join(tmpdir(), 'radar-pipeline-evals-'));
  try {
    await cleanup();

    const alphaId = await insertInvite(`${PREFIX} Alpha`, `${PREFIX.toLowerCase()}-alpha`);
    const betaId = await insertInvite(`${PREFIX} Beta`, `${PREFIX.toLowerCase()}-beta`);
    const rangeId = await insertInvite(`${PREFIX} Range II`, `${PREFIX.toLowerCase()}-range-ii`);

    const alphaOld = await insertEvaluation({
      company: `${PREFIX} Alpha`, date: '2026-01-01', score: 31,
      path: `/fixtures/2026-01-01-${PREFIX.toLowerCase()}-alpha.md`, inviteId: alphaId,
    });
    const alphaLatest = await insertEvaluation({
      company: `${PREFIX} Alpha`, date: '2026-03-01', score: 42,
      path: `/fixtures/2026-03-01-${PREFIX.toLowerCase()}-alpha.md`, inviteId: alphaId,
      mode: 'council',
    });
    await insertEvaluation({
      company: `${PREFIX} Alpha`, date: '2026-02-01', score: 36,
      path: `/fixtures/2026-02-01-${PREFIX.toLowerCase()}-alpha.md`, inviteId: alphaId,
    });
    await insertEvaluation({
      company: `${PREFIX} Range`, date: '2026-04-01', score: 45,
      path: `/fixtures/2026-04-01-${PREFIX.toLowerCase()}-range.md`,
    });

    await test('latest evaluation is joined by foreign key and drives the deal row', async () => {
      const rows = await pipelineListWithLatestEval({ limit: 200 });
      const alpha = rows.find(row => row.id === alphaId);
      eq(alpha.latest_evaluation.id, alphaLatest);
      eq(Number(alpha.latest_evaluation.total_score), 42);
      eq(alpha.latest_evaluation.eval_mode, 'council');
    });

    await test('zero evaluations returns a plain null latest_evaluation', async () => {
      const rows = await pipelineListWithLatestEval({ limit: 200 });
      const beta = rows.find(row => row.id === betaId);
      eq(beta.latest_evaluation, null);
    });

    await test('similar company names never cross-link in the Deals query', async () => {
      const rows = await pipelineListWithLatestEval({ limit: 200 });
      const range = rows.find(row => row.id === rangeId);
      eq(range.latest_evaluation, null);
    });

    await test('history returns every version newest-first', async () => {
      const history = await evaluationHistoryForInvite(alphaId);
      eq(history.length, 3);
      eq(history[0].id, alphaLatest);
      eq(history[2].id, alphaOld);
      eq(dateOnly(history[0].eval_date), '2026-03-01');
    });

    const suggestionInviteId = await insertInvite(
      `${PREFIX} Suggest Systems`,
      `${PREFIX.toLowerCase()}-suggest-systems`
    );
    const suggestionEvalId = await insertEvaluation({
      company: `${PREFIX} Suggest`, date: '2026-05-01', score: 33,
      path: `/fixtures/2026-05-01-${PREFIX.toLowerCase()}-suggest.md`,
    });

    await test('ledger keeps repair suggestions separate from authoritative links', async () => {
      const ledger = await evaluationLedger();
      const row = ledger.find(item => item.id === suggestionEvalId);
      eq(row.link_type, 'unlinked');
      eq(row.linked_id, null);
      eq(row.suggested_match.id, suggestionInviteId);
      eq(row.suggested_match.type, 'pipeline_invite');
      eq(row.suggested_match.confirmed, false);
    });

    const exactInviteId = await insertInvite(
      `${PREFIX} Exact`,
      `${PREFIX.toLowerCase()}-exact`
    );
    const exactEvalId = await insertEvaluation({
      company: `${PREFIX} Exact Inc.`, date: '2026-06-01', score: 34,
      path: `/fixtures/2026-06-01-${PREFIX.toLowerCase()}-exact.md`,
    });
    await insertInvite(`${PREFIX} Ambiguous`, `${PREFIX.toLowerCase()}-ambiguous`);
    await insertInvestment(`${PREFIX} Ambiguous`);
    const ambiguousEvalId = await insertEvaluation({
      company: `${PREFIX} Ambiguous`, date: '2026-06-02', score: 35,
      path: `/fixtures/2026-06-02-${PREFIX.toLowerCase()}-ambiguous.md`,
    });
    const missingEvalId = await insertEvaluation({
      company: `${PREFIX} Missing`, date: '2026-06-03', score: 29,
      path: `/fixtures/2026-06-03-${PREFIX.toLowerCase()}-missing.md`,
    });

    await test('backfill dry-run reports exact, ambiguous, and zero-candidate rows without writes', async () => {
      const report = await backfillEvaluationLinks({ dryRun: true });
      eq(report.rows.find(item => item.evaluation.id === exactEvalId).action, 'link');
      eq(report.rows.find(item => item.evaluation.id === ambiguousEvalId).action, 'ambiguous');
      eq(report.rows.find(item => item.evaluation.id === missingEvalId).action, 'unresolved');
      const rows = await query(`SELECT pipeline_invite_id FROM deal_evaluations WHERE id = $1`, [exactEvalId]);
      eq(rows[0].pipeline_invite_id, null);
    });

    await test('backfill apply links only the unique match and never guesses', async () => {
      await backfillEvaluationLinks({ dryRun: false });
      const rows = await query(
        `SELECT id, pipeline_invite_id, investment_id
         FROM deal_evaluations WHERE id = ANY($1::int[]) ORDER BY id`,
        [[exactEvalId, ambiguousEvalId, missingEvalId]]
      );
      const byId = Object.fromEntries(rows.map(row => [row.id, row]));
      eq(byId[exactEvalId].pipeline_invite_id, exactInviteId);
      eq(byId[ambiguousEvalId].pipeline_invite_id, null);
      eq(byId[ambiguousEvalId].investment_id, null);
      eq(byId[missingEvalId].pipeline_invite_id, null);
    });

    const rescoreCompany = `${PREFIX} Rescore`;
    const rescoreInviteId = await insertInvite(rescoreCompany, `${PREFIX.toLowerCase()}-rescore`);
    const evalBody = (score) => [
      `# Deal Log: ${rescoreCompany}`,
      `## Total: ${score}/50`,
      `## Verdict: ${score >= 39 ? 'Strong Fit' : 'Worth Exploring'}`,
    ].join('\n');
    writeFileSync(join(tempEvalDir, `2026-07-01-${PREFIX.toLowerCase()}-rescore.md`), evalBody(32));
    writeFileSync(join(tempEvalDir, `2026-07-02-${PREFIX.toLowerCase()}-rescore.md`), evalBody(41));

    await test('rescoring appends a new evaluation and re-import remains idempotent', async () => {
      const first = await importDealLogs(tempEvalDir, { mode: 'council' });
      eq(first.imported, 2);
      const history = await evaluationHistoryForInvite(rescoreInviteId);
      eq(history.length, 2);
      eq(Number(history[0].total_score), 41);
      const second = await importDealLogs(tempEvalDir, { mode: 'council' });
      eq(second.imported, 0);
      eq(second.skipped, 2);
      const after = await evaluationHistoryForInvite(rescoreInviteId);
      eq(after.length, 2);
    });

    ok(alphaLatest !== alphaOld, 'fixture should contain distinct evaluation versions');
  } finally {
    rmSync(tempEvalDir, { recursive: true, force: true });
    await cleanup();
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(error => {
  console.error('FATAL:', error);
  process.exit(1);
});
