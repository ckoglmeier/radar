import { query, isPgliteActive } from '../db/index.js';
import { recomputeInvestmentReturns } from '../import/transactions.js';
import { normalize } from '../utils/company-names.js';

const CASH_FLOW_ACTIONS = new Set(['ignored', 'fund']);

function positiveIds(values, label) {
  const ids = [...new Set((values || []).map(Number))]
    .filter(value => Number.isInteger(value) && value > 0);
  if (ids.length === 0) throw new Error(`${label} must include at least one positive integer`);
  return ids;
}

function duplicateGroupKey(ids) {
  return positiveIds(ids, 'Investment ids').sort((a, b) => a - b).join(',');
}

export async function resolveCashFlows({ cashFlowIds, action, note = null }) {
  const ids = positiveIds(cashFlowIds, 'Cash flow ids');
  if (!CASH_FLOW_ACTIONS.has(action)) throw new Error('Action must be ignored or fund');
  const rows = await query(
    `UPDATE cash_flows
        SET reconciliation_status = $1,
            reconciliation_note = $2,
            reconciled_at = NOW()
      WHERE id = ANY($3::int[])
        AND investment_id IS NULL
        AND reconciliation_status = 'pending'
      RETURNING id, reconciliation_status, reconciliation_note, reconciled_at`,
    [action, note, ids],
  );
  return rows;
}

export async function markCashFlowsMatched(cashFlowIds, investmentId) {
  const ids = positiveIds(cashFlowIds, 'Cash flow ids');
  const targetId = positiveIds([investmentId], 'Investment id')[0];
  const target = await query(
    `SELECT id FROM investments
      WHERE id = $1 AND asset_class = 'direct'
      LIMIT 1`,
    [targetId],
  );
  if (!target[0]) throw new Error('Choose a valid direct position');

  const rows = await query(
    `UPDATE cash_flows
        SET investment_id = $1,
            reconciliation_status = 'matched',
            reconciliation_note = NULL,
            reconciled_at = NOW()
      WHERE id = ANY($2::int[])
        AND investment_id IS NULL
        AND reconciliation_status = 'pending'
      RETURNING id`,
    [targetId, ids],
  );
  if (rows.length > 0) await recomputeInvestmentReturns();
  return rows;
}

export async function positionDuplicateGroups() {
  const rows = await query(
    `SELECT id, company_name, status, invest_date, invested, net_value,
            lead, round, source
       FROM investments
      WHERE asset_class = 'direct'
      ORDER BY LOWER(BTRIM(company_name)), invest_date, id`,
  );
  const reviews = await query(
    `SELECT group_key FROM position_duplicate_reviews
      WHERE resolution IN ('separate', 'merged')`,
  );
  const reviewed = new Set(reviews.map(row => row.group_key));
  const grouped = new Map();

  for (const row of rows) {
    const nameKey = normalize(row.company_name);
    if (!nameKey) continue;
    const group = grouped.get(nameKey) || [];
    group.push(row);
    grouped.set(nameKey, group);
  }

  return [...grouped.values()]
    .filter(group => group.length > 1)
    .map(group => ({
      groupKey: duplicateGroupKey(group.map(row => row.id)),
      companyName: group[0].company_name,
      positions: group,
    }))
    .filter(group => !reviewed.has(group.groupKey));
}

export async function keepPositionsSeparate(investmentIds) {
  const ids = positiveIds(investmentIds, 'Investment ids').sort((a, b) => a - b);
  if (ids.length < 2) throw new Error('Choose at least two positions');
  const groupKey = duplicateGroupKey(ids);
  const rows = await query(
    `INSERT INTO position_duplicate_reviews
       (group_key, investment_ids, resolution, reviewed_at)
     VALUES ($1, $2::jsonb, 'separate', NOW())
     ON CONFLICT (group_key) DO UPDATE
       SET investment_ids = EXCLUDED.investment_ids,
           resolution = EXCLUDED.resolution,
           reviewed_at = NOW()
     RETURNING *`,
    [groupKey, JSON.stringify(ids)],
  );
  return rows[0];
}

async function consolidateOne(sourceId, targetId) {
  const sourceRows = await query(
    `SELECT * FROM investments
      WHERE id = $1 AND asset_class = 'direct'
      LIMIT 1`,
    [sourceId],
  );
  const source = sourceRows[0];
  if (!source) throw new Error(`Source position ${sourceId} is not an active direct position`);

  await query(
    `INSERT INTO investment_consolidations
       (source_investment_id, target_investment_id, source_snapshot)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (source_investment_id) DO NOTHING`,
    [sourceId, targetId, JSON.stringify(source)],
  );

  await query(
    `INSERT INTO investment_theses
       (investment_id, thesis_id, is_primary, confidence, tagged_by, weight)
     SELECT $1, thesis_id, is_primary, confidence, tagged_by, weight
       FROM investment_theses
      WHERE investment_id = $2
     ON CONFLICT (investment_id, thesis_id) DO NOTHING`,
    [targetId, sourceId],
  );

  await query(
    `INSERT INTO valuations
       (investment_id, snapshot_date, unrealized_value, realized_value, net_value, multiple, source)
     SELECT $1, snapshot_date, unrealized_value, realized_value, net_value, multiple,
            CONCAT(COALESCE(source, 'unknown'), ':merged:', ($2::int)::text)
       FROM valuations
      WHERE investment_id = $2::int
     ON CONFLICT (investment_id, snapshot_date) DO NOTHING`,
    [targetId, sourceId],
  );

  for (const statement of [
    `UPDATE cash_flows SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE cash_flows SET lot_investment_id = $1 WHERE lot_investment_id = $2`,
    `UPDATE company_updates SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE pipeline_invites SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE deal_evaluations SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE decision_records SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE room_holdings SET investment_id = $1 WHERE investment_id = $2`,
    `UPDATE documents SET entity_id = $1 WHERE entity_type = 'investment' AND entity_id = $2`,
  ]) {
    await query(statement, [targetId, sourceId]);
  }

  await query(
    `UPDATE investments
        SET asset_class = 'merged',
            notes = CONCAT_WS(E'\\n', NULLIF(notes, ''), $1::text),
            updated_at = NOW()
      WHERE id = $2`,
    [`Consolidated into investment #${targetId}.`, sourceId],
  );
}

export async function consolidatePositions({ targetInvestmentId, sourceInvestmentIds }) {
  const targetId = positiveIds([targetInvestmentId], 'Target investment id')[0];
  const sourceIds = positiveIds(sourceInvestmentIds, 'Source investment ids')
    .filter(id => id !== targetId);
  if (sourceIds.length === 0) throw new Error('Choose at least one duplicate position to consolidate');

  const positions = await query(
    `SELECT id, company_name, asset_class
       FROM investments
      WHERE id = ANY($1::int[])`,
    [[targetId, ...sourceIds]],
  );
  if (positions.length !== sourceIds.length + 1) throw new Error('One or more positions were not found');
  if (positions.some(row => row.asset_class !== 'direct')) {
    throw new Error('Only active direct positions can be consolidated');
  }
  const names = new Set(positions.map(row => normalize(row.company_name)));
  if (names.size !== 1) throw new Error('Only positions with the same company name can be consolidated');
  if (!await isPgliteActive()) {
    throw new Error('Position consolidation currently requires a local Radar workspace');
  }

  await query('BEGIN');
  try {
    for (const sourceId of sourceIds) await consolidateOne(sourceId, targetId);
    const allIds = [targetId, ...sourceIds].sort((a, b) => a - b);
    await query(
      `INSERT INTO position_duplicate_reviews
         (group_key, investment_ids, resolution, reviewed_at)
       VALUES ($1, $2::jsonb, 'merged', NOW())
       ON CONFLICT (group_key) DO UPDATE
         SET investment_ids = EXCLUDED.investment_ids,
             resolution = EXCLUDED.resolution,
             reviewed_at = NOW()`,
      [duplicateGroupKey(allIds), JSON.stringify(allIds)],
    );
    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }

  await recomputeInvestmentReturns();
  return { targetInvestmentId: targetId, sourceInvestmentIds: sourceIds };
}
