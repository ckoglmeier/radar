import { randomUUID } from 'node:crypto';
import { isPgliteActive, query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const FUND_STATUSES = new Set(['active', 'harvesting', 'realized', 'written_off']);
const STATUS_COMPATIBILITY = {
  active: 'Live',
  harvesting: 'Live',
  realized: 'Realized',
  written_off: 'Written Off',
};

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function positiveAmount(value, label = 'Amount') {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new TypeError(`${label} must be positive`);
  return amount;
}

function nonNegativeAmount(value, label = 'Amount') {
  if (value == null || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError(`${label} must be non-negative`);
  return amount;
}

function isoDate(value, label) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return date;
}

function dateOnly(value) {
  if (value instanceof Date) {
    return [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
      .join('-');
  }
  return String(value).slice(0, 10);
}

function assertUsd(currency) {
  if (currency != null && String(currency).toUpperCase() !== 'USD') {
    throw new TypeError('Funds currently support USD workspace amounts only');
  }
}

function assertFundStatus(status) {
  if (!FUND_STATUSES.has(status)) throw new TypeError(`invalid Fund status: ${status}`);
  return status;
}

async function withFundWrite(fn) {
  if (!(await isPgliteActive())) {
    throw new Error('Fund writes require local PGlite transaction support');
  }
  await query('BEGIN');
  try {
    const result = await fn();
    await query('COMMIT');
    return result;
  } catch (error) {
    try {
      await query('ROLLBACK');
    } catch {
      // Preserve the operation error.
    }
    throw error;
  }
}

async function fundPosition(investmentId, { lock = false } = {}) {
  const rows = await query(`
    SELECT i.id, i.position_key, i.company_name, i.asset_class,
           i.portfolio_entity_id, i.investment_entity, i.invest_date,
           pe.legal_name, pe.entity_type
      FROM investments i
      LEFT JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE i.id = $1
     ${lock ? 'FOR UPDATE OF i' : ''}
  `, [investmentId]);
  const position = rows[0];
  if (!position) throw new Error(`investment not found: ${investmentId}`);
  if (position.asset_class !== 'fund' || position.entity_type !== 'fund_vehicle') {
    throw new Error('Fund operation requires a Fund position linked to a fund_vehicle entity');
  }
  return position;
}

async function insertFundCashActivity({
  investmentId,
  activityType,
  date,
  amount,
  noticeId = null,
  description = null,
  externalHash = null,
}) {
  const requestKey = externalHash || randomUUID();
  const existing = await query(`
    SELECT ft.*, cf.flow_date, cf.amount
      FROM fund_transactions ft
      JOIN cash_flows cf ON cf.id = ft.cash_flow_id
     WHERE ft.external_hash = $1
  `, [requestKey]);
  if (existing[0]) {
    const expectedAmount = activityType === 'distribution' ? amount : -amount;
    if (
      Number(existing[0].investment_id) !== Number(investmentId) ||
      existing[0].activity_type !== activityType ||
      existing[0].notice_id !== noticeId ||
      dateOnly(existing[0].flow_date) !== date ||
      Number(existing[0].amount) !== expectedAmount ||
      existing[0].voided_at
    ) {
      throw new Error('Fund transaction idempotency key conflicts with another activity');
    }
    return { transaction: existing[0], idempotent_replay: true };
  }

  const cashType = activityType === 'contribution' ? 'investment'
    : activityType === 'distribution' ? 'distribution'
    : 'fee';
  const signedAmount = activityType === 'distribution' ? amount : -amount;
  const [cashFlow] = await query(`
    INSERT INTO cash_flows
      (investment_id, flow_date, type, amount, description, company_raw,
       source, external_hash, reconciliation_status, reconciled_at)
    SELECT $1, $2, $3, $4, $5, company_name, 'fund_manual', $6, 'matched', NOW()
      FROM investments WHERE id = $1
    RETURNING *
  `, [
    investmentId,
    date,
    cashType,
    signedAmount,
    description,
    `fund-cash:${requestKey}`,
  ]);
  const [transaction] = await query(`
    INSERT INTO fund_transactions
      (investment_id, cash_flow_id, notice_id, activity_type, external_hash)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [investmentId, cashFlow.id, noticeId, activityType, requestKey]);
  return { transaction, cash_flow: cashFlow, idempotent_replay: false };
}

export async function createFundProfile(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const status = assertFundStatus(fields.fundStatus || 'active');
    const rows = await query(`
      INSERT INTO fund_profiles
        (investment_id, manager, strategy, vintage_year, commitment,
         fund_status, description, migration_source_room_holding_id,
         migration_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (investment_id) DO NOTHING
      RETURNING *
    `, [
      investmentId,
      optionalText(fields.manager),
      optionalText(fields.strategy),
      fields.vintageYear == null ? null : Number(fields.vintageYear),
      nonNegativeAmount(fields.commitment, 'Commitment'),
      status,
      optionalText(fields.description),
      fields.migrationSourceRoomHoldingId || null,
      optionalText(fields.migrationKey),
    ]);
    if (rows[0]) {
      await query(`UPDATE investments SET status = $1, updated_at = NOW() WHERE id = $2`, [
        STATUS_COMPATIBILITY[status], investmentId,
      ]);
      return { profile: rows[0], idempotent_replay: false };
    }
    const [profile] = await query(`SELECT * FROM fund_profiles WHERE investment_id = $1`, [investmentId]);
    return { profile, idempotent_replay: true };
  });
}

export async function createFund(fields = {}) {
  assertUsd(fields.currency);
  const legalName = requiredText(fields.legalName, 'Legal name');
  const commitmentDate = isoDate(fields.commitmentDate, 'Commitment date');
  const status = assertFundStatus(fields.fundStatus || 'active');
  const initialContribution = fields.initialContribution == null
    ? null
    : positiveAmount(fields.initialContribution, 'Initial contribution');
  const initialNav = fields.initialNav == null ? null : nonNegativeAmount(fields.initialNav, 'Initial NAV');

  return withFundWrite(async () => {
    let entityId = fields.portfolioEntityId || null;
    if (entityId) {
      const [entity] = await query(`SELECT id, entity_type FROM portfolio_entities WHERE id = $1`, [entityId]);
      if (!entity || entity.entity_type !== 'fund_vehicle') {
        throw new Error('Reviewed portfolio entity must be a fund_vehicle');
      }
    } else {
      const [entity] = await query(`
        INSERT INTO portfolio_entities
          (legal_name, normalized_name, entity_type, legal_form,
           jurisdiction, website, description)
        VALUES ($1, $2, 'fund_vehicle', $3, $4, $5, $6)
        RETURNING id
      `, [
        legalName,
        normalize(legalName),
        fields.legalForm || null,
        optionalText(fields.jurisdiction),
        optionalText(fields.website),
        optionalText(fields.entityDescription),
      ]);
      entityId = entity.id;
    }

    const [investment] = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, invested,
         investment_entity, source, asset_class)
      VALUES ($1, $2, $3, $4, $5, $6, 'fund_manual', 'fund')
      RETURNING *
    `, [
      entityId,
      legalName,
      STATUS_COMPATIBILITY[status],
      commitmentDate,
      initialContribution,
      optionalText(fields.ownershipEntity),
    ]);
    const [profile] = await query(`
      INSERT INTO fund_profiles
        (investment_id, manager, strategy, vintage_year, commitment,
         fund_status, description, migration_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      investment.id,
      optionalText(fields.manager),
      optionalText(fields.strategy),
      fields.vintageYear == null ? null : Number(fields.vintageYear),
      nonNegativeAmount(fields.commitment, 'Commitment'),
      status,
      optionalText(fields.description),
      optionalText(fields.migrationKey),
    ]);

    let contribution = null;
    if (initialContribution != null) {
      contribution = await insertFundCashActivity({
        investmentId: investment.id,
        activityType: 'contribution',
        date: isoDate(fields.initialContributionDate || commitmentDate, 'Initial contribution date'),
        amount: initialContribution,
        description: 'Initial Fund contribution',
        externalHash: fields.initialContributionHash || `fund-create:${investment.position_key}:contribution`,
      });
    }
    let valuation = null;
    if (initialNav != null) {
      [valuation] = await query(`
        INSERT INTO valuations
          (investment_id, snapshot_date, unrealized_value, realized_value,
           net_value, source)
        VALUES ($1, $2, $3, 0, $3, 'fund_manual')
        RETURNING *
      `, [
        investment.id,
        isoDate(fields.initialNavDate || commitmentDate, 'Initial NAV date'),
        initialNav,
      ]);
    }
    return { investment, profile, contribution, valuation };
  });
}

export async function updateFund(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const [before] = await query(`SELECT * FROM fund_profiles WHERE investment_id = $1 FOR UPDATE`, [investmentId]);
    if (!before) throw new Error(`fund profile not found: ${investmentId}`);
    const status = fields.fundStatus == null ? before.fund_status : assertFundStatus(fields.fundStatus);
    const [profile] = await query(`
      UPDATE fund_profiles
         SET manager = COALESCE($2, manager),
             strategy = COALESCE($3, strategy),
             vintage_year = COALESCE($4, vintage_year),
             fund_status = $5,
             description = COALESCE($6, description),
             updated_at = NOW()
       WHERE investment_id = $1
       RETURNING *
    `, [
      investmentId,
      fields.manager === undefined ? null : optionalText(fields.manager),
      fields.strategy === undefined ? null : optionalText(fields.strategy),
      fields.vintageYear === undefined ? null : Number(fields.vintageYear),
      status,
      fields.description === undefined ? null : optionalText(fields.description),
    ]);
    await query(`UPDATE investments SET status = $1, updated_at = NOW() WHERE id = $2`, [
      STATUS_COMPATIBILITY[status], investmentId,
    ]);
    return profile;
  });
}

export async function archiveFund(investmentId) {
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const [profile] = await query(`
      UPDATE fund_profiles SET archived_at = COALESCE(archived_at, NOW()), updated_at = NOW()
       WHERE investment_id = $1 RETURNING *
    `, [investmentId]);
    if (!profile) throw new Error(`fund profile not found: ${investmentId}`);
    return profile;
  });
}

export async function restoreFund(investmentId) {
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const [profile] = await query(`
      UPDATE fund_profiles SET archived_at = NULL, updated_at = NOW()
       WHERE investment_id = $1 RETURNING *
    `, [investmentId]);
    if (!profile) throw new Error(`fund profile not found: ${investmentId}`);
    return profile;
  });
}

export async function createCapitalCallNotice(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const externalHash = optionalText(fields.externalHash);
    if (externalHash) {
      const [existing] = await query(`SELECT * FROM fund_notices WHERE external_hash = $1`, [externalHash]);
      if (existing) {
        const noticeDate = isoDate(fields.noticeDate, 'Notice date');
        const dueDate = fields.dueDate ? isoDate(fields.dueDate, 'Due date') : null;
        if (
          Number(existing.investment_id) !== Number(investmentId) ||
          existing.notice_type !== 'capital_call' ||
          dateOnly(existing.notice_date) !== noticeDate ||
          (existing.due_date == null ? null : dateOnly(existing.due_date)) !== dueDate ||
          Number(existing.amount) !== positiveAmount(fields.amount)
        ) {
          throw new Error('Fund notice idempotency key conflicts with another notice');
        }
        return { notice: existing, idempotent_replay: true };
      }
    }
    const [notice] = await query(`
      INSERT INTO fund_notices
        (investment_id, notice_type, notice_date, due_date, amount,
         status, description, external_hash)
      VALUES ($1, 'capital_call', $2, $3, $4, 'open', $5, $6)
      RETURNING *
    `, [
      investmentId,
      isoDate(fields.noticeDate, 'Notice date'),
      fields.dueDate ? isoDate(fields.dueDate, 'Due date') : null,
      positiveAmount(fields.amount),
      optionalText(fields.description),
      externalHash,
    ]);
    return { notice, idempotent_replay: false };
  });
}

export async function cancelFundNotice(noticeId, reason = null) {
  return withFundWrite(async () => {
    const [notice] = await query(`SELECT * FROM fund_notices WHERE id = $1 FOR UPDATE`, [noticeId]);
    if (!notice) throw new Error(`fund notice not found: ${noticeId}`);
    await fundPosition(notice.investment_id, { lock: true });
    if (notice.status === 'settled') throw new Error('settled Fund notice cannot be cancelled');
    if (notice.status === 'cancelled') return notice;
    const [cancelled] = await query(`
      UPDATE fund_notices
         SET status = 'cancelled', description = CONCAT_WS(E'\n', description, $2), updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [noticeId, optionalText(reason)]);
    await query(`
      INSERT INTO investment_events
        (investment_id, event_type, field_name, old_value, new_value, source, notes)
      VALUES ($1, 'fund_notice_cancelled', 'notice_status', 'open', 'cancelled', 'fund_manual', $2)
    `, [notice.investment_id, optionalText(reason)]);
    return cancelled;
  });
}

export async function settleCapitalCall(noticeId, fields = {}) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    const [notice] = await query(`SELECT * FROM fund_notices WHERE id = $1 FOR UPDATE`, [noticeId]);
    if (!notice) throw new Error(`fund notice not found: ${noticeId}`);
    await fundPosition(notice.investment_id, { lock: true });
    const [existingSettlement] = await query(`
      SELECT * FROM fund_transactions
       WHERE notice_id = $1 AND voided_at IS NULL
    `, [noticeId]);
    if (existingSettlement) {
      return { transaction: existingSettlement, idempotent_replay: true };
    }
    if (notice.notice_type !== 'capital_call' || notice.status !== 'open') {
      throw new Error('only an open capital-call notice can be settled');
    }
    const amount = fields.amount == null ? Number(notice.amount) : positiveAmount(fields.amount);
    if (amount !== Number(notice.amount)) throw new Error('v1 requires one full settlement per notice');
    const activity = await insertFundCashActivity({
      investmentId: notice.investment_id,
      activityType: 'contribution',
      date: isoDate(fields.settlementDate, 'Settlement date'),
      amount,
      noticeId,
      description: optionalText(fields.description) || notice.description || 'Capital call paid',
      externalHash: fields.externalHash || `fund-notice:${noticeId}:settlement`,
    });
    await query(`UPDATE fund_notices SET status = 'settled', updated_at = NOW() WHERE id = $1`, [noticeId]);
    return activity;
  });
}

async function recordStandaloneActivity(investmentId, activityType, fields) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    return insertFundCashActivity({
      investmentId,
      activityType,
      date: isoDate(fields.date, 'Activity date'),
      amount: positiveAmount(fields.amount),
      description: optionalText(fields.description),
      externalHash: optionalText(fields.externalHash),
    });
  });
}

export function recordFundDistribution(investmentId, fields = {}) {
  return recordStandaloneActivity(investmentId, 'distribution', fields);
}

export function recordFundFee(investmentId, fields = {}) {
  return recordStandaloneActivity(investmentId, 'fee', fields);
}

export async function recordFundValuation(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const date = isoDate(fields.date, 'Valuation date');
    const nav = nonNegativeAmount(fields.nav, 'NAV');
    const [existing] = await query(`
      SELECT * FROM valuations WHERE investment_id = $1 AND snapshot_date = $2
    `, [investmentId, date]);
    if (existing) {
      if (Number(existing.net_value) === nav) return { valuation: existing, idempotent_replay: true };
      const reason = requiredText(fields.correctionReason, 'Correction reason');
      await query(`SELECT set_config('radar.allow_fund_valuation_correction', 'on', TRUE)`);
      const [valuation] = await query(`
        UPDATE valuations
           SET unrealized_value = $3,
               realized_value = 0,
               net_value = $3,
               multiple = NULL
         WHERE investment_id = $1 AND snapshot_date = $2
         RETURNING *
      `, [investmentId, date, nav]);
      await query(`
        INSERT INTO investment_events
          (investment_id, event_type, field_name, old_value, new_value, source, notes)
        VALUES ($1, 'fund_valuation_corrected', 'net_value', $2, $3, 'fund_manual', $4)
      `, [investmentId, existing.net_value, nav, reason]);
      return { valuation, idempotent_replay: false, corrected: true };
    }
    const [valuation] = await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, realized_value,
         net_value, source)
      VALUES ($1, $2, $3, 0, $3, 'fund_manual')
      RETURNING *
    `, [investmentId, date, nav]);
    return { valuation, idempotent_replay: false };
  });
}

export async function updateFundCommitment(investmentId, commitment, note = null) {
  const amount = nonNegativeAmount(commitment, 'Commitment');
  return withFundWrite(async () => {
    await fundPosition(investmentId, { lock: true });
    const [before] = await query(`SELECT commitment FROM fund_profiles WHERE investment_id = $1 FOR UPDATE`, [investmentId]);
    if (!before) throw new Error(`fund profile not found: ${investmentId}`);
    const [profile] = await query(`
      UPDATE fund_profiles SET commitment = $2, updated_at = NOW()
       WHERE investment_id = $1 RETURNING *
    `, [investmentId, amount]);
    await query(`
      INSERT INTO investment_events
        (investment_id, event_type, field_name, old_value, new_value, source, notes)
      VALUES ($1, 'fund_commitment_changed', 'commitment', $2, $3, 'fund_manual', $4)
    `, [investmentId, before.commitment, amount, optionalText(note)]);
    return profile;
  });
}

export async function voidAndReplaceFundTransaction(transactionId, fields = {}) {
  assertUsd(fields.currency);
  const reason = requiredText(fields.reason, 'Void reason');
  return withFundWrite(async () => {
    const [current] = await query(`
      SELECT ft.*, cf.amount, cf.flow_date
        FROM fund_transactions ft
        JOIN cash_flows cf ON cf.id = ft.cash_flow_id
       WHERE ft.id = $1
       FOR UPDATE
    `, [transactionId]);
    if (!current) throw new Error(`fund transaction not found: ${transactionId}`);
    if (current.voided_at) throw new Error('fund transaction is already voided');
    await fundPosition(current.investment_id, { lock: true });
    await query(`
      UPDATE fund_transactions
         SET voided_at = NOW(), void_reason = $2
       WHERE id = $1
    `, [transactionId, reason]);
    const replacement = await insertFundCashActivity({
      investmentId: current.investment_id,
      activityType: current.activity_type,
      date: isoDate(fields.date, 'Replacement date'),
      amount: positiveAmount(fields.amount, 'Replacement amount'),
      noticeId: current.notice_id,
      description: optionalText(fields.description),
      externalHash: optionalText(fields.externalHash) || `fund-replacement:${transactionId}:${randomUUID()}`,
    });
    await query(`
      INSERT INTO investment_events
        (investment_id, event_type, field_name, old_value, new_value, source, notes)
      VALUES ($1, 'fund_transaction_replaced', 'fund_transaction_id', $2, $3, 'fund_manual', $4)
    `, [current.investment_id, transactionId, replacement.transaction.id, reason]);
    return { voided_transaction_id: transactionId, replacement };
  });
}

export async function listFunds({ includeArchived = false } = {}) {
  const rows = await query(`
    SELECT i.id AS investment_id, i.position_key, i.company_name,
           i.invest_date, i.investment_entity, i.portfolio_entity_id,
           pe.legal_name, fp.manager, fp.strategy, fp.vintage_year,
           fp.commitment, fp.fund_status, fp.description, fp.archived_at
      FROM fund_profiles fp
      JOIN investments i ON i.id = fp.investment_id
      JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE ($1::boolean OR fp.archived_at IS NULL)
     ORDER BY LOWER(pe.legal_name), i.invest_date, i.id
  `, [includeArchived]);
  return Promise.all(rows.map(async row => ({ ...row, metrics: await fundMetrics(row.investment_id) })));
}

export async function getFund(investmentId) {
  const rows = await query(`
    SELECT i.id AS investment_id, i.position_key, i.company_name,
           i.invest_date, i.investment_entity, i.portfolio_entity_id,
           pe.legal_name, pe.legal_form, pe.jurisdiction, pe.website,
           fp.*
      FROM fund_profiles fp
      JOIN investments i ON i.id = fp.investment_id
      JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE fp.investment_id = $1
  `, [investmentId]);
  if (!rows[0]) return null;
  const [metrics, notices, transactions, valuations, documents] = await Promise.all([
    fundMetrics(investmentId),
    query(`SELECT * FROM fund_notices WHERE investment_id = $1 ORDER BY notice_date DESC, created_at DESC`, [investmentId]),
    query(`
      SELECT ft.*, cf.flow_date, cf.type AS cash_flow_type, cf.amount,
             cf.description, cf.source AS cash_flow_source
        FROM fund_transactions ft
        JOIN cash_flows cf ON cf.id = ft.cash_flow_id
       WHERE ft.investment_id = $1
       ORDER BY cf.flow_date DESC, ft.created_at DESC
    `, [investmentId]),
    query(`SELECT * FROM valuations WHERE investment_id = $1 ORDER BY snapshot_date DESC, id DESC`, [investmentId]),
    query(`
      SELECT id, filename, mime, sha256, source, size_bytes, confidentiality,
             processing_policy, sync_policy, created_at
        FROM documents
       WHERE entity_type = 'investment' AND entity_id = $1::text
       ORDER BY created_at DESC, id DESC
    `, [investmentId]),
  ]);
  return { ...rows[0], metrics, notices, transactions, valuations, documents };
}

export async function fundMetrics(investmentId) {
  await fundPosition(investmentId);
  const [totals] = await query(`
    SELECT
      COUNT(*) FILTER (WHERE ft.activity_type = 'contribution')::int AS contribution_count,
      COUNT(*) FILTER (WHERE ft.activity_type = 'distribution')::int AS distribution_count,
      COALESCE(SUM(-cf.amount) FILTER (WHERE ft.activity_type = 'contribution'), 0) AS paid_in,
      COALESCE(SUM(cf.amount) FILTER (WHERE ft.activity_type = 'distribution'), 0) AS distributed,
      COALESCE(SUM(-cf.amount) FILTER (WHERE ft.activity_type = 'fee'), 0) AS fees_to_date
      FROM fund_transactions ft
      JOIN cash_flows cf ON cf.id = ft.cash_flow_id
     WHERE ft.investment_id = $1 AND ft.voided_at IS NULL
  `, [investmentId]);
  const [profile] = await query(`SELECT commitment FROM fund_profiles WHERE investment_id = $1`, [investmentId]);
  const [valuation] = await query(`
    SELECT snapshot_date, net_value
      FROM valuations
     WHERE investment_id = $1 AND net_value IS NOT NULL
     ORDER BY snapshot_date DESC, id DESC LIMIT 1
  `, [investmentId]);
  const paidIn = totals.contribution_count > 0 ? Number(totals.paid_in) : null;
  const distributed = totals.distribution_count > 0 ? Number(totals.distributed) : 0;
  const nav = valuation ? Number(valuation.net_value) : null;
  const commitment = profile?.commitment == null ? null : Number(profile.commitment);
  return {
    commitment,
    paid_in: paidIn,
    distributed,
    nav,
    nav_date: valuation?.snapshot_date || null,
    unfunded: commitment == null || paidIn == null ? null : Math.max(commitment - paidIn, 0),
    dpi: paidIn > 0 ? distributed / paidIn : null,
    tvpi: paidIn > 0 && nav != null ? (distributed + nav) / paidIn : null,
    fees_to_date: Number(totals.fees_to_date || 0),
    coverage: {
      paid_in: paidIn == null ? 'unavailable' : 'complete',
      nav: nav == null ? 'unavailable' : 'complete',
      commitment: commitment == null ? 'unavailable' : 'complete',
    },
  };
}

export async function fundSummary() {
  const funds = await listFunds();
  const sumKnown = key => funds.reduce((sum, fund) => sum + Number(fund.metrics[key] || 0), 0);
  return {
    fund_count: funds.length,
    total_commitment: sumKnown('commitment'),
    total_paid_in: sumKnown('paid_in'),
    total_distributed: sumKnown('distributed'),
    total_nav: sumKnown('nav'),
    total_unfunded: sumKnown('unfunded'),
    total_fees: sumKnown('fees_to_date'),
    coverage: {
      commitment: funds.filter(fund => fund.metrics.commitment != null).length,
      paid_in: funds.filter(fund => fund.metrics.paid_in != null).length,
      nav: funds.filter(fund => fund.metrics.nav != null).length,
      total_funds: funds.length,
    },
  };
}
