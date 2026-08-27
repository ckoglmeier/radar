import { query } from '../db/index.js';

const ASSET_CLASSES = new Set(['direct', 'fund', 'employment_equity']);
const COVERAGE_MESSAGES = {
  MISSING_DISPOSITION_DATE: 'Historical state indicates a possible disposition, but no dated lifecycle event is recorded.',
  MISSING_BASIS_ALLOCATION: 'Recorded basis cannot be allocated to this disposition from the available facts.',
  PENDING_RECONCILIATION: 'The linked cash movement has not been reconciled.',
  UNKNOWN_REMAINING_INTEREST: 'Whether an economic interest remains is not recorded.',
  CONTRADICTORY_RETURN_RECORD: 'The lifecycle fact conflicts with current position state or value.',
};

function isoDate(value, label) {
  const date = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError(`${label} must be an ISO date`);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError(`${label} must be an ISO date`);
  }
  return date;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function money(value) {
  const result = numberOrNull(value);
  return result == null ? null : Math.round(result * 100) / 100;
}

function resultFrom(proceeds, basis) {
  if (proceeds == null || basis == null) return { economic_result: 'unknown', gain_loss_amount: null };
  const difference = money(proceeds - basis);
  return {
    economic_result: Math.abs(difference) < 0.005 ? 'breakeven' : difference > 0 ? 'gain' : 'loss',
    gain_loss_amount: difference,
  };
}

function evidence(kind, sourceId, label) {
  return { kind, source_id: sourceId == null ? null : String(sourceId), label };
}

function lifecycleRecord(fields) {
  const recordedBasis = money(fields.recordedBasis);
  const allocatedBasis = money(fields.allocatedBasis);
  const proceeds = money(fields.proceeds);
  return {
    record_id: String(fields.recordId),
    position_id: Number(fields.positionId),
    company_name: fields.companyName,
    asset_class: fields.assetClass,
    event_date: fields.eventDate || null,
    event_type: fields.eventType,
    proceeds,
    currency: 'USD',
    reconciliation_state: fields.reconciliationState || 'not_applicable',
    recorded_basis: recordedBasis,
    allocated_basis: allocatedBasis,
    basis_coverage: fields.basisCoverage || (allocatedBasis == null ? 'missing' : 'allocated'),
    ...(fields.forceUnknownResult
      ? { economic_result: 'unknown', gain_loss_amount: null }
      : resultFrom(proceeds, allocatedBasis)),
    remaining_interest: fields.remainingInterest || 'unknown',
    evidence: fields.evidence,
    confidence_class: fields.confidenceClass,
    coverage_codes: [...new Set(fields.coverageCodes || [])].sort(),
  };
}

function assetClasses(value) {
  if (value == null) return [...ASSET_CLASSES];
  if (!Array.isArray(value) || value.length === 0) throw new TypeError('assetClasses must be a non-empty array');
  const normalized = [...new Set(value.map(item => String(item)))];
  for (const item of normalized) {
    if (!ASSET_CLASSES.has(item)) throw new TypeError(`unsupported asset class: ${item}`);
  }
  return normalized;
}

function stableSort(records) {
  return records.sort((left, right) =>
    String(left.event_date || '9999-12-31').localeCompare(String(right.event_date || '9999-12-31'))
    || left.company_name.localeCompare(right.company_name)
    || left.record_id.localeCompare(right.record_id));
}

function coverageFrom(records) {
  return records.flatMap(record => record.coverage_codes.map(code => ({
    code,
    severity: code === 'CONTRADICTORY_RETURN_RECORD' ? 'error' : 'warning',
    position_id: record.position_id,
    message: COVERAGE_MESSAGES[code],
  }))).filter((item, index, items) => items.findIndex(candidate =>
    candidate.code === item.code && candidate.position_id === item.position_id) === index)
    .sort((left, right) => left.position_id - right.position_id || left.code.localeCompare(right.code));
}

function sum(records) {
  return money(records.reduce((total, record) => total + (record.proceeds || 0), 0)) || 0;
}

export async function portfolioRealizationEvents(options = {}) {
  const since = isoDate(options.since, 'since');
  const until = isoDate(options.until, 'until');
  if (until < since) throw new TypeError('until must be on or after since');
  const selected = assetClasses(options.assetClasses);
  const includeCandidates = options.includeCandidates !== false;
  const includeExcluded = options.includeExcluded === true;
  const confirmed = [];
  const partial = [];
  const fundActivity = [];
  const candidates = [];
  const excluded = [];

  if (selected.includes('direct')) {
    const events = await query(`
      SELECT e.*, i.company_name, i.status, i.invested, i.computed_net_invested,
             i.computed_total_value, i.net_value, i.unrealized_value,
             cf.amount AS proceeds, cf.reconciliation_status,
             d.filename AS source_filename,
             returns_to_event.total_proceeds AS cumulative_proceeds,
             returns_to_event.pending_count
        FROM direct_position_lifecycle_events e
        JOIN investments i ON i.id = e.investment_id
        LEFT JOIN cash_flows cf ON cf.id = e.cash_flow_id
        LEFT JOIN documents d ON d.id = e.source_document_id
        LEFT JOIN LATERAL (
          SELECT SUM(prior.amount) AS total_proceeds,
                 COUNT(*) FILTER (WHERE prior.reconciliation_status = 'pending')::int AS pending_count
            FROM cash_flows prior
           WHERE prior.investment_id = e.investment_id
             AND prior.type = 'distribution' AND prior.amount > 0
             AND prior.flow_date <= e.event_date
        ) returns_to_event ON TRUE
       WHERE e.voided_at IS NULL AND e.event_date BETWEEN $1 AND $2
       ORDER BY e.event_date, e.id
    `, [since, until]);
    for (const row of events) {
      const recordedBasis = numberOrNull(row.computed_net_invested) ?? numberOrNull(row.invested);
      const terminal = ['full_exit', 'dissolution', 'write_off', 'abandonment'].includes(row.event_type);
      const isFull = terminal && row.remaining_interest === 'no';
      const eventProceeds = isFull
        ? numberOrNull(row.cumulative_proceeds) ?? 0
        : numberOrNull(row.proceeds);
      const basisCanBeFullyAllocated = isFull;
      const coverageCodes = [];
      if (row.remaining_interest === 'unknown') coverageCodes.push('UNKNOWN_REMAINING_INTEREST');
      if (row.reconciliation_status === 'pending' || Number(row.pending_count || 0) > 0) {
        coverageCodes.push('PENDING_RECONCILIATION');
      }
      if (!basisCanBeFullyAllocated) coverageCodes.push('MISSING_BASIS_ALLOCATION');
      const currentUnrealized = numberOrNull(row.unrealized_value);
      const contradictory = isFull && currentUnrealized != null && currentUnrealized > 0;
      if (contradictory) {
        coverageCodes.push('CONTRADICTORY_RETURN_RECORD');
      }
      const record = lifecycleRecord({
        recordId: `direct-event:${row.id}`,
        positionId: row.investment_id,
        companyName: row.company_name,
        assetClass: 'direct',
        eventDate: String(row.event_date).slice(0, 10),
        eventType: row.event_type,
        proceeds: eventProceeds,
        reconciliationState: Number(row.pending_count || 0) > 0
          ? 'pending'
          : row.cash_flow_id == null ? 'not_applicable' : row.reconciliation_status,
        recordedBasis,
        allocatedBasis: basisCanBeFullyAllocated ? recordedBasis : null,
        basisCoverage: basisCanBeFullyAllocated && recordedBasis != null ? 'full_position' : 'missing',
        remainingInterest: row.remaining_interest,
        evidence: evidence(
          row.source_document_id ? 'source_document' : row.cash_flow_id ? 'cash_flow' : 'user_attested_event',
          row.source_document_id || row.cash_flow_id || row.id,
          row.source_filename || row.evidence_note || 'Recorded Direct lifecycle event',
        ),
        confidenceClass: row.remaining_interest === 'unknown' ? 'candidate' : 'confirmed',
        forceUnknownResult: contradictory,
        coverageCodes,
      });
      if (isFull) confirmed.push(record);
      else if (row.remaining_interest === 'unknown') candidates.push(record);
      else partial.push(record);
    }

    const distributions = await query(`
      SELECT cf.id, cf.investment_id, cf.flow_date, cf.amount, cf.subtype,
             cf.reconciliation_status, cf.description, i.company_name,
             i.invested, i.computed_net_invested
        FROM cash_flows cf
        JOIN investments i ON i.id = cf.investment_id
       WHERE i.asset_class = 'direct'
         AND cf.type = 'distribution' AND cf.amount > 0
         AND cf.flow_date BETWEEN $1 AND $2
         AND NOT EXISTS (
           SELECT 1 FROM direct_position_lifecycle_events e
            WHERE e.cash_flow_id = cf.id AND e.voided_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM direct_position_lifecycle_events terminal
            WHERE terminal.investment_id = cf.investment_id
              AND terminal.voided_at IS NULL
              AND terminal.event_type IN ('full_exit', 'dissolution', 'write_off', 'abandonment')
              AND terminal.remaining_interest = 'no'
              AND terminal.event_date BETWEEN $1 AND $2
              AND cf.flow_date <= terminal.event_date
         )
       ORDER BY cf.flow_date, cf.id
    `, [since, until]);
    for (const row of distributions) {
      const missingFinalDissolution = row.subtype === 'dissolution';
      const record = lifecycleRecord({
        recordId: `direct-flow:${row.id}`,
        positionId: row.investment_id,
        companyName: row.company_name,
        assetClass: 'direct',
        eventDate: String(row.flow_date).slice(0, 10),
        eventType: missingFinalDissolution ? 'dissolution' : 'partial_liquidity',
        proceeds: row.amount,
        reconciliationState: row.reconciliation_status,
        recordedBasis: numberOrNull(row.computed_net_invested) ?? numberOrNull(row.invested),
        allocatedBasis: null,
        remainingInterest: 'unknown',
        evidence: evidence('cash_flow', row.id, row.description || 'Unlinked Direct distribution'),
        confidenceClass: missingFinalDissolution ? 'candidate' : 'recorded_cash_activity',
        coverageCodes: [
          'MISSING_BASIS_ALLOCATION', 'UNKNOWN_REMAINING_INTEREST',
          ...(row.reconciliation_status === 'pending' ? ['PENDING_RECONCILIATION'] : []),
        ],
      });
      if (missingFinalDissolution) candidates.push(record); else partial.push(record);
    }

    if (includeCandidates) {
      const historical = await query(`
        SELECT i.id, i.company_name, i.status, i.invested, i.computed_net_invested,
               i.computed_total_value, i.net_value, i.unrealized_value
          FROM investments i
         WHERE i.asset_class = 'direct'
           AND (
             i.status IN ('Realized', 'Written Off')
             OR (ABS(COALESCE(i.computed_total_value, i.net_value, i.unrealized_value)) <= 0.01
                 AND COALESCE(i.computed_net_invested, i.invested, 0) > 0)
           )
           AND NOT EXISTS (
             SELECT 1 FROM direct_position_lifecycle_events e
              WHERE e.investment_id = i.id AND e.voided_at IS NULL
           )
         ORDER BY i.company_name, i.id
      `);
      for (const row of historical) {
        const recordedBasis = numberOrNull(row.computed_net_invested) ?? numberOrNull(row.invested);
        const isLossCandidate = row.status === 'Written Off'
          || [row.computed_total_value, row.net_value, row.unrealized_value]
            .some(value => value != null && Number(value) === 0);
        candidates.push(lifecycleRecord({
          recordId: `direct-candidate:${row.id}`,
          positionId: row.id,
          companyName: row.company_name,
          assetClass: 'direct',
          eventDate: null,
          eventType: isLossCandidate ? 'write_off' : 'historical_disposition',
          proceeds: isLossCandidate ? 0 : null,
          recordedBasis,
          allocatedBasis: recordedBasis,
          basisCoverage: recordedBasis == null ? 'missing' : 'full_position',
          remainingInterest: 'unknown',
          evidence: evidence('legacy_position_state', row.id, `Position status: ${row.status || 'unknown'}`),
          confidenceClass: 'candidate',
          coverageCodes: ['MISSING_DISPOSITION_DATE', 'UNKNOWN_REMAINING_INTEREST'],
        }));
      }
    }

    if (includeExcluded) {
      const refunds = await query(`
        SELECT cf.id, cf.investment_id, cf.flow_date, cf.amount, cf.description,
               cf.reconciliation_status, i.company_name
          FROM cash_flows cf JOIN investments i ON i.id = cf.investment_id
         WHERE i.asset_class = 'direct' AND cf.type = 'refund'
           AND cf.flow_date BETWEEN $1 AND $2
         ORDER BY cf.flow_date, cf.id
      `, [since, until]);
      for (const row of refunds) {
        excluded.push(lifecycleRecord({
          recordId: `direct-refund:${row.id}`,
          positionId: row.investment_id,
          companyName: row.company_name,
          assetClass: 'direct', eventDate: String(row.flow_date).slice(0, 10),
          eventType: 'refund', proceeds: row.amount,
          reconciliationState: row.reconciliation_status,
          recordedBasis: null, allocatedBasis: null, remainingInterest: 'yes',
          evidence: evidence('cash_flow', row.id, row.description || 'Refund'),
          confidenceClass: 'excluded_non_disposition', coverageCodes: [],
        }));
      }
    }
  }

  if (selected.includes('fund')) {
    const rows = await query(`
      SELECT ft.id, ft.investment_id, cf.flow_date, cf.amount,
             cf.reconciliation_status, cf.description, i.company_name,
             fp.fund_status, i.invested, i.computed_net_invested
        FROM fund_transactions ft
        JOIN cash_flows cf ON cf.id = ft.cash_flow_id
        JOIN investments i ON i.id = ft.investment_id
        JOIN fund_profiles fp ON fp.investment_id = i.id
       WHERE ft.voided_at IS NULL AND ft.activity_type = 'distribution'
         AND cf.flow_date BETWEEN $1 AND $2
       ORDER BY cf.flow_date, ft.id
    `, [since, until]);
    for (const row of rows) {
      const closed = ['realized', 'written_off'].includes(row.fund_status);
      const recordedBasis = numberOrNull(row.computed_net_invested) ?? numberOrNull(row.invested);
      const record = lifecycleRecord({
        recordId: `fund-transaction:${row.id}`,
        positionId: row.investment_id, companyName: row.company_name,
        assetClass: 'fund', eventDate: String(row.flow_date).slice(0, 10),
        eventType: 'fund_distribution',
        proceeds: row.amount, reconciliationState: row.reconciliation_status,
        recordedBasis, allocatedBasis: null,
        basisCoverage: 'missing',
        remainingInterest: closed ? 'no' : 'yes',
        evidence: evidence(
          'fund_transaction', row.id,
          `${row.description || 'Fund distribution'} · fund status ${row.fund_status}`,
        ),
        confidenceClass: 'fund_activity',
        coverageCodes: [
          'MISSING_BASIS_ALLOCATION',
          ...(row.reconciliation_status === 'pending' ? ['PENDING_RECONCILIATION'] : []),
        ],
      });
      fundActivity.push(record);
    }
    if (includeCandidates) {
      const undatedClosed = await query(`
        SELECT i.id, i.company_name, i.invested, i.computed_net_invested, fp.fund_status
          FROM investments i JOIN fund_profiles fp ON fp.investment_id = i.id
         WHERE fp.fund_status IN ('realized', 'written_off')
           AND NOT EXISTS (
             SELECT 1 FROM fund_transactions ft JOIN cash_flows cf ON cf.id = ft.cash_flow_id
              WHERE ft.investment_id = i.id AND ft.voided_at IS NULL
                AND ft.activity_type = 'distribution' AND cf.flow_date BETWEEN $1 AND $2
           )
         ORDER BY i.company_name, i.id
      `, [since, until]);
      for (const row of undatedClosed) candidates.push(lifecycleRecord({
        recordId: `fund-candidate:${row.id}`, positionId: row.id,
        companyName: row.company_name, assetClass: 'fund', eventDate: null,
        eventType: row.fund_status === 'written_off' ? 'write_off' : 'fund_closure',
        proceeds: row.fund_status === 'written_off' ? 0 : null,
        recordedBasis: numberOrNull(row.computed_net_invested) ?? numberOrNull(row.invested),
        allocatedBasis: null, remainingInterest: 'unknown',
        evidence: evidence('fund_profile', row.id, `Fund status: ${row.fund_status}`),
        confidenceClass: 'candidate',
        coverageCodes: ['MISSING_DISPOSITION_DATE', 'UNKNOWN_REMAINING_INTEREST'],
      }));
    }
  }

  if (selected.includes('employment_equity')) {
    const rows = await query(`
      SELECT e.id, e.investment_id, e.event_date, e.event_type, e.gross_amount,
             e.cash_flow_id, e.source_document_id, e.notes, i.company_name,
             cf.reconciliation_status, d.filename AS source_filename,
             ep.position_status,
             COALESCE(a.allocated_basis, 0) AS allocated_basis,
             a.allocation_count,
             COALESCE(l.remaining_units, 0) AS remaining_units,
             l.lot_count
        FROM employment_equity_events e
        JOIN investments i ON i.id = e.investment_id
        JOIN employment_equity_positions ep ON ep.investment_id = i.id
        LEFT JOIN cash_flows cf ON cf.id = e.cash_flow_id
        LEFT JOIN documents d ON d.id = e.source_document_id
        LEFT JOIN LATERAL (
          SELECT SUM(tax_basis_allocated) AS allocated_basis, COUNT(*)::int AS allocation_count
            FROM investment_lot_allocations WHERE event_id = e.id
        ) a ON TRUE
        LEFT JOIN LATERAL (
          SELECT SUM(COALESCE(units_remaining, 0)) AS remaining_units, COUNT(*)::int AS lot_count
            FROM investment_lots WHERE investment_id = e.investment_id
        ) l ON TRUE
       WHERE e.voided_at IS NULL
         AND e.event_type IN ('distribution', 'sale', 'tender', 'repurchase')
         AND e.event_date BETWEEN $1 AND $2
       ORDER BY e.event_date, e.id
    `, [since, until]);
    for (const row of rows) {
      const disposition = ['sale', 'tender', 'repurchase'].includes(row.event_type);
      const fullyDisposed = disposition && (
        row.position_status === 'realized'
        || (Number(row.lot_count) > 0 && Number(row.remaining_units) === 0)
      );
      const hasBasis = Number(row.allocation_count) > 0 && row.allocated_basis != null;
      const record = lifecycleRecord({
        recordId: `employment-event:${row.id}`, positionId: row.investment_id,
        companyName: row.company_name, assetClass: 'employment_equity',
        eventDate: String(row.event_date).slice(0, 10), eventType: row.event_type,
        proceeds: row.gross_amount, reconciliationState: row.cash_flow_id ? row.reconciliation_status : 'not_applicable',
        recordedBasis: hasBasis ? row.allocated_basis : null,
        allocatedBasis: hasBasis ? row.allocated_basis : null,
        basisCoverage: hasBasis ? 'lot_allocated' : 'missing',
        remainingInterest: fullyDisposed ? 'no' : 'yes',
        evidence: evidence(
          row.source_document_id ? 'source_document' : 'employment_equity_event',
          row.source_document_id || row.id,
          row.source_filename || row.notes || 'Employment Equity event',
        ),
        confidenceClass: fullyDisposed ? 'confirmed' : 'recorded_cash_activity',
        coverageCodes: [
          ...(!hasBasis ? ['MISSING_BASIS_ALLOCATION'] : []),
          ...(row.reconciliation_status === 'pending' ? ['PENDING_RECONCILIATION'] : []),
        ],
      });
      if (fullyDisposed) confirmed.push(record); else partial.push(record);
    }
  }

  stableSort(confirmed); stableSort(partial); stableSort(fundActivity);
  stableSort(candidates); stableSort(excluded);
  const all = [
    ...confirmed,
    ...partial,
    ...fundActivity,
    ...(includeCandidates ? candidates : []),
    ...(includeExcluded ? excluded : []),
  ];
  return {
    schema_version: 1,
    as_of: until,
    window: { since, until },
    coverage: coverageFrom(all),
    confirmed,
    partial,
    fund_activity: fundActivity,
    candidates: includeCandidates ? candidates : [],
    excluded: includeExcluded ? excluded : [],
    totals: {
      confirmed_proceeds: sum(confirmed),
      partial_proceeds: sum(partial),
      fund_distributions: sum(fundActivity),
      currency: 'USD',
    },
  };
}

export async function positionLifecycleHistory(options = {}) {
  const positionId = Number(options.positionId);
  if (!Number.isInteger(positionId) || positionId <= 0) throw new TypeError('positionId must be a positive integer');
  const limit = options.limit == null ? 100 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit must be an integer from 1 to 200');
  const [position] = await query(`
    SELECT id, position_key, company_name, asset_class, status, invest_date
      FROM investments WHERE id = $1
  `, [positionId]);
  if (!position) return null;

  let lifecycleEvents = [];
  if (position.asset_class === 'direct') {
    lifecycleEvents = await query(`
      SELECT id, event_date, event_type, remaining_interest, cash_flow_id,
             source_document_id, evidence_note, voided_at, void_reason,
             replacement_event_id, created_at
        FROM direct_position_lifecycle_events
       WHERE investment_id = $1 ORDER BY event_date DESC, id DESC LIMIT $2
    `, [positionId, limit]);
  } else if (position.asset_class === 'employment_equity') {
    lifecycleEvents = await query(`
      SELECT id, event_date, event_type, units, gross_amount, cash_flow_id,
             source_document_id, notes, voided_at, void_reason,
             replacement_event_id, created_at
        FROM employment_equity_events
       WHERE investment_id = $1 ORDER BY event_date DESC, id DESC LIMIT $2
    `, [positionId, limit]);
  } else if (position.asset_class === 'fund') {
    lifecycleEvents = await query(`
      SELECT ft.id, cf.flow_date AS event_date, ft.activity_type AS event_type,
             ft.cash_flow_id, ft.notice_id, ft.voided_at, ft.void_reason, ft.created_at
        FROM fund_transactions ft JOIN cash_flows cf ON cf.id = ft.cash_flow_id
       WHERE ft.investment_id = $1 ORDER BY cf.flow_date DESC, ft.id DESC LIMIT $2
    `, [positionId, limit]);
  }
  const cashFlows = await query(`
    SELECT id, flow_date, type, subtype, amount, description, source,
           reconciliation_status, reconciled_at, created_at
      FROM cash_flows WHERE investment_id = $1
     ORDER BY flow_date DESC, id DESC LIMIT $2
  `, [positionId, limit]);
  const valuations = await query(`
    SELECT id, snapshot_date, unrealized_value, realized_value, net_value, source, created_at
      FROM valuations WHERE investment_id = $1
     ORDER BY snapshot_date DESC, id DESC LIMIT $2
  `, [positionId, limit]);
  const evidenceReferences = await query(`
    SELECT d.id, d.filename, d.mime, d.entity_type, d.entity_id, d.created_at
      FROM documents d
     WHERE d.id IN (
       SELECT source_document_id FROM direct_position_lifecycle_events
        WHERE investment_id = $1 AND source_document_id IS NOT NULL
       UNION
       SELECT source_document_id FROM employment_equity_events
        WHERE investment_id = $1 AND source_document_id IS NOT NULL
     )
     ORDER BY d.created_at DESC, d.id DESC LIMIT $2
  `, [positionId, limit]);
  return {
    schema_version: 1,
    position: {
      position_id: Number(position.id),
      position_key: position.position_key,
      company_name: position.company_name,
      asset_class: position.asset_class,
      status: position.status,
      investment_date: position.invest_date ? String(position.invest_date).slice(0, 10) : null,
    },
    lifecycle_events: lifecycleEvents,
    cash_flows: cashFlows,
    valuations,
    evidence_references: evidenceReferences,
  };
}
