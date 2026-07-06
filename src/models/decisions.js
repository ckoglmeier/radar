// Decision-record model for draft/seal workflows.
//
// Immutability is intentionally enforced at the model/UI layer per Phase 8
// owner decision: sealed rows are not DB-append-only, but this API refuses
// draft edits or repeat seals once `sealed` is true.

import { query } from '../db/index.js';

const WRITABLE_FIELDS = [
  'investment_id',
  'pipeline_invite_id',
  'deal_evaluation_id',
  'decision',
  'what_was_known',
  'what_was_believed',
  'key_risks',
  'bear_view',
  'confidence',
  'chosen_size',
  'sizing_basis',
  'review_due',
];

function assertConfidence(confidence) {
  if (confidence == null) return;
  const n = Number(confidence);
  if (!Number.isInteger(n) || n < 0 || n > 5) {
    throw new Error('confidence must be an integer from 0 to 5');
  }
}

function normalizeValue(field, value) {
  if (value === undefined) return undefined;
  if (field === 'confidence') {
    assertConfidence(value);
    return value == null ? null : Number(value);
  }
  if (field === 'sizing_basis') {
    return value == null ? null : JSON.stringify(value);
  }
  return value ?? null;
}

function buildSet(fields, startIndex = 1) {
  const setClauses = [];
  const params = [];
  let i = startIndex;

  for (const field of WRITABLE_FIELDS) {
    if (!(field in fields)) continue;
    const value = normalizeValue(field, fields[field]);
    if (value === undefined) continue;
    if (field === 'sizing_basis') {
      setClauses.push(`${field} = $${i++}::jsonb`);
    } else {
      setClauses.push(`${field} = $${i++}`);
    }
    params.push(value);
  }

  return { setClauses, params, nextIndex: i };
}

function assertHasWritableFields(setClauses) {
  if (setClauses.length === 0) {
    throw new Error('no decision fields to update');
  }
}

export async function createDecisionDraft(fields = {}) {
  const { setClauses, params } = buildSet(fields);
  assertHasWritableFields(setClauses);

  const columns = setClauses.map(clause => clause.split(' = ')[0]);
  const placeholders = columns.map((column, idx) => (
    column === 'sizing_basis' ? `$${idx + 1}::jsonb` : `$${idx + 1}`
  ));

  const rows = await query(`
    INSERT INTO decision_records (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `, params);
  return rows[0];
}

export async function updateDecisionDraft(id, fields = {}) {
  const existing = await getDecisionRecord(id);
  if (!existing) throw new Error(`decision record not found: ${id}`);
  if (existing.sealed) throw new Error('cannot update a sealed decision record');

  const { setClauses, params, nextIndex } = buildSet(fields);
  assertHasWritableFields(setClauses);
  setClauses.push('updated_at = NOW()');
  params.push(id);

  const rows = await query(`
    UPDATE decision_records
    SET ${setClauses.join(', ')}
    WHERE id = $${nextIndex}
    RETURNING *
  `, params);
  return rows[0];
}

export async function sealDecision(id, fields = {}) {
  const existing = await getDecisionRecord(id);
  if (!existing) throw new Error(`decision record not found: ${id}`);
  if (existing.sealed) throw new Error('decision record is already sealed');

  const { setClauses, params, nextIndex } = buildSet(fields);
  setClauses.push('sealed = TRUE');
  setClauses.push('sealed_at = NOW()');
  setClauses.push('updated_at = NOW()');
  params.push(id);

  const rows = await query(`
    UPDATE decision_records
    SET ${setClauses.join(', ')}
    WHERE id = $${nextIndex}
    RETURNING *
  `, params);
  return rows[0];
}

export async function getDecisionRecord(id) {
  const rows = await query(
    `SELECT * FROM decision_records WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function getDecisionsForInvestment(investmentId) {
  return query(`
    SELECT *
    FROM decision_records
    WHERE investment_id = $1
    ORDER BY sealed_at DESC NULLS LAST, created_at DESC, id DESC
  `, [investmentId]);
}

export async function listDecisions({ sealed, limit = 100 } = {}) {
  if (sealed === undefined) {
    return query(`
      SELECT *
      FROM decision_records
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `, [limit]);
  }

  return query(`
    SELECT *
    FROM decision_records
    WHERE sealed = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
  `, [sealed, limit]);
}
