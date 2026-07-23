#!/usr/bin/env node

// Conservative legacy-link repair for deal evaluations.
//
// Default behavior is a dry run. Pass --apply only after reviewing the diff.
// A row is linked only when its persisted company_name matches exactly one
// pipeline invite OR investment by case-insensitive/normalized equality.
// Existing links are never overwritten; zero or multiple candidates remain
// unlinked for manual review.

import { pathToFileURL } from 'url';
import { query, closeDb } from './index.js';
import { normalize as normalizeCompanyName } from '../utils/company-names.js';

function namesMatch(left, right) {
  const rawLeft = String(left || '').trim().toLowerCase();
  const rawRight = String(right || '').trim().toLowerCase();
  if (!rawLeft || !rawRight) return false;
  if (rawLeft === rawRight) return true;
  const normalizedLeft = normalizeCompanyName(left);
  const normalizedRight = normalizeCompanyName(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

export async function planEvaluationLinkBackfill() {
  const [evaluations, invites, investments] = await Promise.all([
    query(`
      SELECT id, company_name, file_path
      FROM deal_evaluations
      WHERE pipeline_invite_id IS NULL
        AND investment_id IS NULL
      ORDER BY id
    `),
    query(`SELECT id, company_name, deal_slug FROM pipeline_invites ORDER BY id`),
    query(`SELECT id, company_name FROM investments ORDER BY id`),
  ]);

  const candidates = [
    ...invites.map(row => ({ ...row, type: 'pipeline_invite' })),
    ...investments.map(row => ({ ...row, type: 'investment' })),
  ];

  return evaluations.map(evaluation => {
    const matches = candidates.filter(candidate =>
      namesMatch(evaluation.company_name, candidate.company_name));
    return {
      evaluation,
      candidates: matches,
      action: matches.length === 1 ? 'link' : matches.length === 0 ? 'unresolved' : 'ambiguous',
    };
  });
}

export async function backfillEvaluationLinks({ dryRun = true } = {}) {
  const plan = await planEvaluationLinkBackfill();
  let linked = 0;

  if (!dryRun) {
    for (const item of plan) {
      if (item.action !== 'link') continue;
      const candidate = item.candidates[0];
      const column = candidate.type === 'pipeline_invite'
        ? 'pipeline_invite_id'
        : 'investment_id';
      const updated = await query(
        `UPDATE deal_evaluations
         SET ${column} = $1
         WHERE id = $2
           AND pipeline_invite_id IS NULL
           AND investment_id IS NULL
         RETURNING id`,
        [candidate.id, item.evaluation.id]
      );
      linked += updated.length;
    }
  }

  return {
    dry_run: dryRun,
    scanned: plan.length,
    linkable: plan.filter(item => item.action === 'link').length,
    ambiguous: plan.filter(item => item.action === 'ambiguous').length,
    unresolved: plan.filter(item => item.action === 'unresolved').length,
    linked,
    rows: plan,
  };
}

function printReport(report) {
  console.log(`${report.dry_run ? 'Dry run' : 'Apply'}: ${report.scanned} unlinked evaluation(s)`);
  for (const item of report.rows) {
    const label = item.evaluation.company_name || item.evaluation.file_path || `#${item.evaluation.id}`;
    if (item.action === 'link') {
      const target = item.candidates[0];
      console.log(`  link  #${item.evaluation.id} ${JSON.stringify(label)} -> ${target.type} #${target.id} ${JSON.stringify(target.company_name)}`);
    } else if (item.action === 'ambiguous') {
      const targets = item.candidates
        .map(target => `${target.type} #${target.id} ${JSON.stringify(target.company_name)}`)
        .join('; ');
      console.log(`  skip  #${item.evaluation.id} ${JSON.stringify(label)} (ambiguous: ${targets})`);
    } else {
      console.log(`  skip  #${item.evaluation.id} ${JSON.stringify(label)} (no exact match)`);
    }
  }
  console.log(
    `Linkable: ${report.linkable}; ambiguous: ${report.ambiguous}; unresolved: ${report.unresolved}; linked: ${report.linked}`
  );
  if (report.dry_run && report.linkable > 0) {
    console.log('No rows changed. Re-run with --apply after reviewing this diff.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apply = process.argv.includes('--apply');
  try {
    printReport(await backfillEvaluationLinks({ dryRun: !apply }));
  } finally {
    await closeDb();
  }
}
