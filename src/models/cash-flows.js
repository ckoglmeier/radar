// Cash flow model — insert with hash-based dedup.

import { query } from '../db/index.js';

/**
 * Insert a cash flow row if it doesn't already exist (dedup on external_hash).
 * Returns { id } on insert, or null if duplicate.
 */
export async function insertCashFlow(fields) {
  const existing = await query(
    `SELECT id FROM cash_flows WHERE external_hash = $1 LIMIT 1`,
    [fields.external_hash]
  );
  if (existing.length > 0) return null;

  const result = await query(
    `INSERT INTO cash_flows
       (investment_id, flow_date, type, subtype, amount, running_balance,
        description, company_raw, spv_raw, source, external_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      fields.investment_id,
      fields.flow_date,
      fields.type,
      fields.subtype,
      fields.amount,
      fields.running_balance,
      fields.description,
      fields.company_raw,
      fields.spv_raw,
      fields.source,
      fields.external_hash,
    ]
  );

  return { id: result[0].id };
}

/**
 * Link an orphan cash flow to an investment by ID.
 * Returns the updated row, or null if the cash flow doesn't exist.
 */
export async function linkCashFlowToInvestment(cashFlowId, investmentId) {
  const rows = await query(
    `UPDATE cash_flows SET investment_id = $1 WHERE id = $2 RETURNING id, company_raw, type, amount`,
    [investmentId, cashFlowId]
  );
  return rows[0] || null;
}
