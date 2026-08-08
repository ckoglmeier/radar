// Investment model — upsert, valuation snapshots, and change detection.
// Mirrors the pipeline_events pattern in src/models/pipeline.js.
//
// Import identity is stored separately from the position row. The legacy
// AngelList CSV does not expose a source ID, so its v1 link preserves the old
// exact (company_name, invest_date) behavior without keeping that pair unique
// for manual and Employment Equity positions.

import { createHash } from 'node:crypto';
import { query } from '../db/index.js';

/**
 * Return a non-mutating review hint for names that may represent fund vehicles.
 * Name patterns are evidence for human review, never asset-class authority.
 */
export function assetClassReviewCandidate(companyName) {
  return /\bfund\b/i.test(companyName || '')
    ? { suggested_asset_class: 'fund', reason: 'fund-name-pattern' }
    : null;
}

/** Default unlabeled imports to Direct; only explicit source data changes class. */
export function inferAssetClass(companyName, explicitAssetClass) {
  const explicit = explicitAssetClass?.trim();
  if (explicit) return explicit;
  return 'direct';
}

function normalizedSource(source) {
  const value = String(source || '').trim();
  return value || 'legacy';
}

export function legacyInvestmentSourceKey(companyName, investDate) {
  const date = investDate instanceof Date
    ? investDate.toISOString().slice(0, 10)
    : String(investDate || '').slice(0, 10);
  const digest = createHash('md5')
    .update(`${companyName}\u001f${date}`)
    .digest('hex');
  return `legacy-v1:${digest}`;
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
async function findClosingPosition(fields, source) {
  if (fields.status !== 'Closing') return null;
  const rows = await query(`
    SELECT id FROM investments
    WHERE company_name = $1
      AND COALESCE(NULLIF(BTRIM(source), ''), 'legacy') = $2
      AND status = 'Closing'
      AND lead IS NOT DISTINCT FROM $3
      AND round IS NOT DISTINCT FROM $4
      AND invested = $5
    ORDER BY updated_at DESC NULLS LAST, id DESC
  `, [fields.company_name, source, fields.lead, fields.round, fields.invested]);
  if (rows.length > 1) {
    throw new Error(`ambiguous Closing position identity for ${fields.company_name}`);
  }
  return rows[0]?.id ?? null;
}

async function findImportedPosition(fields, source, sourceKey) {
  const linked = await query(`
    SELECT i.id
      FROM investment_source_identities isi
      JOIN investments i ON i.id = isi.investment_id
     WHERE isi.source = $1
       AND isi.source_key = $2
       AND i.asset_class <> 'merged'
  `, [source, sourceKey]);
  if (linked[0]) return linked[0].id;

  // Compatibility bridge for a row created before source identities existed,
  // or by an older writer. Never guess once valid same-day positions exist.
  const legacy = await query(`
    SELECT id
      FROM investments
     WHERE company_name = $1
       AND invest_date IS NOT DISTINCT FROM $2::date
       AND asset_class <> 'merged'
     ORDER BY id
  `, [fields.company_name, fields.invest_date]);
  if (legacy.length > 1) {
    throw new Error(`ambiguous legacy investment identity for ${fields.company_name} on ${fields.invest_date || 'unknown date'}`);
  }
  return legacy[0]?.id ?? null;
}

async function updateImportedPosition(id, fields, source, sourceKey) {
  const rows = await query(`
    WITH updated AS (
      UPDATE investments
         SET status = COALESCE(status_override, $1),
             invested = $2,
             unrealized_value = CASE
               WHEN EXISTS (
                 SELECT 1 FROM valuations v
                  WHERE v.investment_id = investments.id
                    AND v.source ILIKE 'manual%'
                    AND v.net_value > COALESCE($5, 0)
               ) THEN investments.unrealized_value ELSE $3
             END,
             realized_value = CASE
               WHEN EXISTS (
                 SELECT 1 FROM valuations v
                  WHERE v.investment_id = investments.id
                    AND v.source ILIKE 'manual%'
                    AND v.net_value > COALESCE($5, 0)
               ) THEN investments.realized_value ELSE $4
             END,
             net_value = CASE
               WHEN EXISTS (
                 SELECT 1 FROM valuations v
                  WHERE v.investment_id = investments.id
                    AND v.source ILIKE 'manual%'
                    AND v.net_value > COALESCE($5, 0)
               ) THEN investments.net_value ELSE $5
             END,
             multiple = CASE
               WHEN EXISTS (
                 SELECT 1 FROM valuations v
                  WHERE v.investment_id = investments.id
                    AND v.source ILIKE 'manual%'
                    AND v.net_value > COALESCE($5, 0)
               ) THEN investments.multiple ELSE $6
             END,
             stage_bucket = $7,
             updated_at = NOW()
       WHERE id = $8 AND asset_class <> 'merged'
       RETURNING id
    ), linked AS (
      INSERT INTO investment_source_identities
        (investment_id, source, source_key, key_version)
      SELECT id, $9, $10, 1 FROM updated
      ON CONFLICT (source, source_key) DO UPDATE
        SET investment_id = EXCLUDED.investment_id,
            key_version = EXCLUDED.key_version,
            updated_at = NOW()
      RETURNING investment_id
    )
    SELECT updated.id
      FROM updated
      JOIN linked ON linked.investment_id = updated.id
  `, [
    fields.status,
    fields.invested,
    fields.unrealized_value,
    fields.realized_value,
    fields.net_value,
    fields.multiple,
    fields.stage_bucket,
    id,
    source,
    sourceKey,
  ]);
  if (!rows[0]) throw new Error(`investment is not an active import target: ${id}`);
  return { id: rows[0].id, isNew: false };
}

async function updateClosingPositionDate(id, fields, source, sourceKey) {
  const rows = await query(`
    WITH updated AS (
      UPDATE investments
         SET invest_date = $1,
             updated_at = NOW()
       WHERE id = $2 AND asset_class <> 'merged'
       RETURNING id
    ), linked AS (
      INSERT INTO investment_source_identities
        (investment_id, source, source_key, key_version)
      SELECT id, $3, $4, 1 FROM updated
      ON CONFLICT (source, source_key) DO UPDATE
        SET investment_id = EXCLUDED.investment_id,
            key_version = EXCLUDED.key_version,
            updated_at = NOW()
      RETURNING investment_id
    )
    SELECT updated.id
      FROM updated
      JOIN linked ON linked.investment_id = updated.id
  `, [fields.invest_date, id, source, sourceKey]);
  if (!rows[0]) throw new Error(`investment is not an active import target: ${id}`);
  return { id: rows[0].id, isNew: false };
}

/**
 * Upsert an investment row. Returns { id, isNew }.
 * Identity is resolved through investment_source_identities. Legacy CSV rows
 * use the exact former (company_name, invest_date) key as their source link.
 *
 * Special case: if the incoming row is in "Closing" status, first check for
 * an existing Closing row with the same economic identity (see
 * findClosingPosition) and update its invest_date in place. This prevents
 * AngelList "Invest Date" drift on pending deals from creating duplicate rows.
 */
export async function upsertInvestment(fields) {
  const assetClass = inferAssetClass(fields.company_name, fields.asset_class);
  const source = normalizedSource(fields.source);
  const sourceKey = legacyInvestmentSourceKey(fields.company_name, fields.invest_date);
  const importedId = await findImportedPosition(fields, source, sourceKey);
  if (importedId) {
    return updateImportedPosition(importedId, fields, source, sourceKey);
  }

  const closingId = await findClosingPosition(fields, source);
  if (closingId) {
    return updateClosingPositionDate(closingId, fields, source, sourceKey);
  }

  const result = await query(`
    WITH inserted AS (
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
      RETURNING id
    ), linked AS (
      INSERT INTO investment_source_identities
        (investment_id, source, source_key, key_version)
      SELECT id, $26, $27, 1 FROM inserted
      RETURNING investment_id
    )
    SELECT inserted.id, TRUE AS is_new
      FROM inserted
      JOIN linked ON linked.investment_id = inserted.id
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
    source,
    sourceKey,
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
export async function snapshotInvestment(companyName, investDate, source = null) {
  if (source) {
    const rows = await query(`
      SELECT i.*
        FROM investment_source_identities isi
        JOIN investments i ON i.id = isi.investment_id
       WHERE isi.source = $1
         AND isi.source_key = $2
         AND i.asset_class <> 'merged'
    `, [normalizedSource(source), legacyInvestmentSourceKey(companyName, investDate)]);
    if (rows[0]) return rows[0];
  }
  const rows = await query(`
    SELECT *
      FROM investments
     WHERE company_name = $1
       AND invest_date IS NOT DISTINCT FROM $2::date
       AND asset_class <> 'merged'
     ORDER BY id
  `, [companyName, investDate]);
  if (rows.length > 1) {
    throw new Error(`ambiguous legacy investment identity for ${companyName} on ${investDate || 'unknown date'}`);
  }
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
