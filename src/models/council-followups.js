import { createHash } from 'crypto';
import { query } from '../db/index.js';

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer`);
  return id;
}

function legacyQuestions(content) {
  const value = String(content || '');
  const heading = /^##\s+Key Questions\s*$/mi.exec(value);
  if (!heading) return [];
  const remainder = value.slice(heading.index + heading[0].length);
  const nextHeading = remainder.search(/^##\s+/m);
  const section = nextHeading >= 0 ? remainder.slice(0, nextHeading) : remainder;
  if (!section) return [];
  return section
    .split('\n')
    .map(line => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] || null)
    .filter(Boolean)
    .map(question => question.replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function questionKey(question, index) {
  const digest = createHash('sha256').update(question).digest('hex').slice(0, 10);
  return `legacy-${index + 1}-${digest}`;
}

async function ensureLegacyQuestions(inviteId) {
  const existing = await query(
    `SELECT id FROM council_followup_questions
     WHERE pipeline_invite_id = $1
     LIMIT 1`,
    [inviteId],
  );
  if (existing[0]) return;
  const evaluations = await query(
    `SELECT id, raw_content
     FROM deal_evaluations
     WHERE pipeline_invite_id = $1
     ORDER BY eval_date DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    [inviteId],
  );
  const evaluation = evaluations[0];
  if (!evaluation) return;
  for (const [index, question] of legacyQuestions(evaluation.raw_content).entries()) {
    await query(
      `INSERT INTO council_followup_questions
         (pipeline_invite_id, evaluation_id, question_key, question, priority)
       VALUES ($1, $2, $3, $4, 'helpful')
       ON CONFLICT (evaluation_id, question_key) DO NOTHING`,
      [inviteId, evaluation.id, questionKey(question, index), question],
    );
  }
}

function withStatus(row) {
  return {
    ...row,
    status: row.applied_evaluation_id
      ? 'applied'
      : row.answer
        ? 'answered'
        : 'open',
  };
}

export async function founderFollowupsForInvite(inviteId) {
  const id = positiveId(inviteId, 'Pipeline invite id');
  await ensureLegacyQuestions(id);
  const rows = await query(
    `SELECT fq.*,
            de.total_score AS source_total_score,
            applied.total_score AS applied_total_score
     FROM council_followup_questions fq
     JOIN deal_evaluations de ON de.id = fq.evaluation_id
     LEFT JOIN deal_evaluations applied ON applied.id = fq.applied_evaluation_id
     WHERE fq.pipeline_invite_id = $1
     ORDER BY
       CASE WHEN fq.applied_evaluation_id IS NOT NULL THEN 2
            WHEN fq.answer IS NOT NULL THEN 0 ELSE 1 END,
       CASE fq.priority WHEN 'critical' THEN 0 ELSE 1 END,
       fq.created_at ASC,
       fq.id ASC`,
    [id],
  );
  return rows.map(withStatus);
}

export async function answerFounderFollowup({ questionId, answer }) {
  const id = positiveId(questionId, 'Question id');
  const text = String(answer || '').trim();
  if (!text) throw new Error('Founder answer is required');
  if (text.length > 12000) throw new Error('Founder answer must be 12,000 characters or fewer');
  const rows = await query(
    `UPDATE council_followup_questions
     SET answer = $1,
         answer_source = 'founder',
         answered_at = NOW(),
         applied_evaluation_id = NULL,
         applied_at = NULL,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [text, id],
  );
  if (!rows[0]) throw new Error(`Founder follow-up question ${id} was not found`);
  return withStatus(rows[0]);
}

export async function pendingFounderFollowups(inviteId) {
  const id = positiveId(inviteId, 'Pipeline invite id');
  return query(
    `SELECT *
     FROM council_followup_questions
     WHERE pipeline_invite_id = $1
       AND answer IS NOT NULL
       AND applied_evaluation_id IS NULL
     ORDER BY answered_at ASC, id ASC`,
    [id],
  );
}

export async function markFounderFollowupsApplied(questionIds, evaluationId) {
  const target = positiveId(evaluationId, 'Evaluation id');
  const ids = [...new Set((questionIds || []).map(Number))]
    .filter(id => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return [];
  return query(
    `UPDATE council_followup_questions
     SET applied_evaluation_id = $1,
         applied_at = NOW(),
         updated_at = NOW()
     WHERE id = ANY($2::int[])
     RETURNING *`,
    [target, ids],
  );
}
