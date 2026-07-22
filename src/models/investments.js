// Investment model — upsert, valuation snapshots, and change detection.
// Mirrors the pipeline_events pattern in src/models/pipeline.js.
//
// Note: investment identity is keyed on (company_name, invest_date) — a
// pragmatic but weak key. AngelList does not expose a stable per-position
// id, and "Closing" status rows have a drifting Invest Date until the deal
// actually closes. The Closing pre-check in upsertInvestment patches around
// the date drift; a longer-term fix would be a normalized composite identity
// or a source-side stable id.

import { query } from '../db/index.js';

/** Infer a default asset class when an import does not supply one. */
export function inferAssetClass(companyName, explicitAssetClass) {
  const explicit = explicitAssetClass?.trim();
  if (explicit) return explicit;
  return /\bfund\b/i.test(companyName || '') ? 'fund' : 'direct';
}

// AngelList exports "Closing" status rows with an Invest Date that drifts
// between exports until the deal actually closes. The (company_name,
// invest_date) upsert key would create a new row each time the date moves.
// While a position is in Closing status, match on the economic identity
// (company + source + lead + round + invested) instead.
//
// Match key reasoning: same dollar amount + same lead + same round on the
// same source is tight enough to avoid colliding genuine separate Closing
// SPVs. A real follow-on SPV would have a different invested amount.
//
// Known limitation: company-name drift ("Karman" vs "Karman Industries"
// vs "Karman Industries, Inc.") is NOT handled here. If AngelList renames
// a Closing position between exports, this fix will not catch it.
async function findClosingPosition(fields) {
  if (fields.status !== 'Closing') return null;
  const rows = await query(`
    SELECT id FROM investments
    WHERE company_name = $1
      AND source = $2
      AND status = 'Closing'
      AND lead IS NOT DISTINCT FROM $3
      AND round IS NOT DISTINCT FROM $4
      AND invested = $5
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT 1
  `, [fields.company_name, fields.source, fields.lead, fields.round, fields.invested]);
  return rows[0]?.id ?? null;
}

/**
 * Upsert an investment row. Returns { id, isNew }.
 * Conflict key: (company_name, invest_date).
 *
 * Special case: if the incoming row is in "Closing" status, first check for
 * an existing Closing row with the same economic identity (see
 * findClosingPosition) and update its invest_date in place. This prevents
 * AngelList "Invest Date" drift on pending deals from creating duplicate rows.
 */
export async function upsertInvestment(fields) {
  const assetClass = inferAssetClass(fields.company_name, fields.asset_class);
  const closingId = await findClosingPosition(fields);
  if (closingId) {
    await query(
      `UPDATE investments SET invest_date = $1, updated_at = NOW() WHERE id = $2`,
      [fields.invest_date, closingId]
    );
    return { id: closingId, isNew: false };
  }

  const result = await query(`
    INSERT INTO investments (
      company_name, status, invest_date, invested, unrealized_value,
      realized_value, net_value, multiple, investment_entity, lead,
      investment_type, round, stage_bucket, market, fund_name, allocation,
      instrument, round_size, valuation_cap_type, valuation_cap, discount,
      carry, share_class, source, asset_class
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
    )
    ON CONFLICT (company_name, invest_date)
    DO UPDATE SET
      status = COALESCE(investments.status_override, EXCLUDED.status),
      invested = EXCLUDED.invested,
      -- Protect manual valuation overrides: keep existing value when a manual
      -- valuation snapshot exists with a higher mark than the incoming CSV data.
      unrealized_value = CASE
        WHEN EXISTS (
          SELECT 1 FROM valuations v
          WHERE v.investment_id = investments.id
            AND v.source ILIKE 'manual%'
            AND v.net_value > COALESCE(EXCLUDED.net_value, 0)
        ) THEN investments.unrealized_value
        ELSE EXCLUDED.unrealized_value
      END,
      realized_value = CASE
        WHEN EXISTS (
          SELECT 1 FROM valuations v
          WHERE v.investment_id = investments.id
            AND v.source ILIKE 'manual%'
            AND v.net_value > COALESCE(EXCLUDED.net_value, 0)
        ) THEN investments.realized_value
        ELSE EXCLUDED.realized_value
      END,
      net_value = CASE
        WHEN EXISTS (
          SELECT 1 FROM valuations v
          WHERE v.investment_id = investments.id
            AND v.source ILIKE 'manual%'
            AND v.net_value > COALESCE(EXCLUDED.net_value, 0)
        ) THEN investments.net_value
        ELSE EXCLUDED.net_value
      END,
      multiple = CASE
        WHEN EXISTS (
          SELECT 1 FROM valuations v
          WHERE v.investment_id = investments.id
            AND v.source ILIKE 'manual%'
            AND v.net_value > COALESCE(EXCLUDED.net_value, 0)
        ) THEN investments.multiple
        ELSE EXCLUDED.multiple
      END,
      stage_bucket = EXCLUDED.stage_bucket,
      updated_at = NOW()
    RETURNING id, (xmax = 0) AS is_new
  `, [
    fields.company_name,
    fields.status,
    fields.invest_date,
    fields.invested,
    fields.unrealized_value,
    fields.realized_value,
    fields.net_value,
    fields.multiple,
    fields.investment_entity,
    fields.lead,
    fields.investment_type,
    fields.round,
    fields.stage_bucket,
    fields.market,
    fields.fund_name,
    fields.allocation,
    fields.instrument,
    fields.round_size,
    fields.valuation_cap_type,
    fields.valuation_cap,
    fields.discount,
    fields.carry,
    fields.share_class,
    fields.source,
    assetClass,
  ]);

  return { id: result[0].id, isNew: result[0].is_new };
}

/**
 * Create a valuation snapshot for an investment.
 * ON CONFLICT DO NOTHING — safe to call multiple times per day.
 */
export async function createValuationSnapshot(investmentId, values) {
  const source = values.source || 'angellist_import';
  await query(`
    INSERT INTO valuations (investment_id, snapshot_date, unrealized_value, realized_value, net_value, multiple, source)
    VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
    ON CONFLICT (investment_id, snapshot_date) DO NOTHING
  `, [investmentId, values.unrealized_value, values.realized_value, values.net_value, values.multiple, source]);
}

export async function addPositionManual(fields) {
  const result = await upsertInvestment({
    ...fields,
    source: 'manual',
  });

  await createValuationSnapshot(result.id, {
    unrealized_value: fields.unrealized_value,
    realized_value: fields.realized_value,
    net_value: fields.net_value,
    multiple: fields.multiple,
    source: 'manual_position',
  });

  return result;
}

export async function tagInvestment(investmentId, thesisId, options = {}) {
  const {
    isPrimary = false,
    confidence = 'manual',
    taggedBy = 'manual',
    weight = 100,
  } = options;

  const rows = await query(`
    INSERT INTO investment_theses (investment_id, thesis_id, is_primary, confidence, tagged_by, weight)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING
    RETURNING investment_id, thesis_id, is_primary, confidence, tagged_by, weight
  `, [investmentId, thesisId, isPrimary, confidence, taggedBy, weight]);

  return rows[0] || null;
}

export async function untagInvestment(investmentId, thesisId) {
  const rows = await query(`
    DELETE FROM investment_theses
    WHERE investment_id = $1 AND thesis_id = $2
    RETURNING investment_id, thesis_id
  `, [investmentId, thesisId]);

  return rows[0] || null;
}

export async function setConviction(investmentId, { now, entry }) {
  const rows = await query(`
    UPDATE investments
    SET conviction_now = $2,
        conviction_entry = $3,
        updated_at = NOW()
    WHERE id = $1
    RETURNING id, conviction_now, conviction_entry
  `, [investmentId, now ?? null, entry ?? null]);

  return rows[0] || null;
}

const TRACKED_FIELDS = [
  'status',
  'invested',
  'unrealized_value',
  'realized_value',
  'net_value',
  'multiple',
  'round',
  'stage_bucket',
  'lead',
];

const TRACKED_COMPUTED = [
  'computed_realized',
  'computed_refunds',
  'computed_net_invested',
  'computed_total_value',
  'computed_multiple',
];

function normalizeValue(v) {
  if (v === undefined || v === null || v === '') return null;
  return v;
}

function valuesDiffer(a, b) {
  const na = normalizeValue(a);
  const nb = normalizeValue(b);
  if (na === null && nb === null) return false;
  if (na === null || nb === null) return true;
  if (typeof na === 'number' || typeof nb === 'number') {
    return Number(na) !== Number(nb);
  }
  return String(na) !== String(nb);
}

export async function logInvestmentEvent(investmentId, eventType, fieldName, oldValue, newValue, source, notes) {
  await query(
    `INSERT INTO investment_events (investment_id, event_type, field_name, old_value, new_value, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      investmentId,
      eventType,
      fieldName || null,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      source || null,
      notes || null,
    ]
  );
}

// Fetch current state of an investment before an upsert, so we can diff after.
export async function snapshotInvestment(companyName, investDate) {
  const rows = await query(
    `SELECT * FROM investments WHERE company_name = $1 AND invest_date = $2 LIMIT 1`,
    [companyName, investDate]
  );
  return rows[0] || null;
}

// Compare before/after snapshots and log changes.
export async function detectAndLogChanges(before, after, source) {
  if (!before || !after) return [];

  const fields = source === 'transactions_recompute' ? TRACKED_COMPUTED : TRACKED_FIELDS;
  const changes = [];

  for (const field of fields) {
    if (valuesDiffer(before[field], after[field])) {
      changes.push({ field, old: before[field], new: after[field] });
      await logInvestmentEvent(
        after.id,
        'field_change',
        field,
        before[field],
        after[field],
        source
      );
    }
  }

  return changes;
}
