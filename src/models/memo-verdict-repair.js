import { createHash } from 'node:crypto';
import { query, withAtomicWrite } from '../db/index.js';

export function reconcileSavedMemo(row) {
  const verdict = String(row.verdict || '').trim();
  if (!verdict || /[\r\n]/.test(verdict)) return null;
  let assessment = row.council_transaction_assessment;
  if (typeof assessment === 'string') assessment = JSON.parse(assessment);
  const original = row.raw_content;
  // Only the transaction assessment's labeled recommendation is replaced.
  // Historical council voices and investor decisions remain untouched.
  const content = typeof original === 'string' ? original.replace(
    /(^## Transaction Assessment[^\n]*\n)([\s\S]*?)(?=^## |$(?![\s\S]))/gm,
    (_section, heading, body) => heading + body.replace(
      /^\*\*Recommendation:\*\*[^\n]*$/gm,
      () => `**Recommendation:** ${verdict}`,
    ),
  ) : original;
  const changedAssessment = assessment && (assessment.recommendation !== verdict || assessment.gated_reason != null);
  if (content === original && !changedAssessment) return null;
  return {
    content,
    assessment: assessment ? { ...assessment, recommendation: verdict, gated_reason: null } : null,
    hash: typeof content === 'string' ? createHash('sha256').update(content).digest('hex') : row.council_artifact_hash,
  };
}

export async function repairMemoVerdicts({ dryRun = false } = {}) {
  return withAtomicWrite(async () => {
    const rows = await query(`SELECT de.* FROM deal_evaluations de
      LEFT JOIN memo_verdict_repairs r ON r.evaluation_id=de.id
      WHERE r.evaluation_id IS NULL AND de.verdict IS NOT NULL ORDER BY de.id`);
    const repaired = [];
    for (const row of rows) {
      const next = reconcileSavedMemo(row);
      if (!next) continue;
      repaired.push(row.id);
      if (dryRun) continue;
      await query(`INSERT INTO memo_verdict_repairs (evaluation_id,original_evaluation,repaired_content_hash)
        VALUES ($1,$2::jsonb,$3)`, [row.id, JSON.stringify(row), next.hash]);
      await query(`UPDATE deal_evaluations SET raw_content=$1,council_transaction_assessment=$2::jsonb,
        council_artifact_hash=$3 WHERE id=$4`, [next.content, JSON.stringify(next.assessment), next.hash, row.id]);
    }
    return { count: repaired.length, evaluationIds: repaired, dryRun };
  });
}
