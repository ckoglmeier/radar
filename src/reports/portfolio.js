// Pure data fetchers for portfolio reports. No chalk, no console.log — return
// JSON-serializable shapes that the CLI printers (or future web GUI) consume.

import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { stageToBarbellGroup } from '../utils/stage.js';

const MONEY_TOLERANCE = 0.01;

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function reportDate(value) {
  const date = value ? String(value).slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError('asOf must be an ISO date');
  return date;
}

function returnCoverage(base, overrides = {}) {
  return {
    position_count: base.positionCount,
    invested_basis_positions: base.investedBasisPositions,
    realized_value_positions: base.realizedValuePositions,
    current_mark_positions: base.currentMarkPositions,
    opening_flow_sources: base.openingFlowSources,
    dated_positive_return_positions: base.datedPositiveReturnPositions,
    linked_flow_count: base.linkedFlowCount,
    linked_invested_amount: base.linkedInvestedAmount,
    linked_returned_amount: base.linkedReturnedAmount,
    unresolved_positions: base.unresolvedPositions,
    ...overrides,
  };
}

/**
 * Canonical since-inception return register for Direct positions.
 *
 * Position facts own DPI/TVPI. The linked ledger supplies dated IRR and cash
 * activity only; it never silently replaces the position-basis denominator.
 */
export async function directReturnRegister(options = {}) {
  const asOf = reportDate(options.asOf);
  const [positionRows, flowRows] = await Promise.all([
    query(`
      SELECT
        i.id, i.company_name, i.invest_date, i.invested,
        i.computed_net_invested, i.computed_realized, i.computed_total_value,
        i.realized_value, i.unrealized_value, i.net_value, i.multiple,
        latest.realized_value AS latest_realized_value,
        latest.unrealized_value AS latest_unrealized_value,
        latest.net_value AS latest_net_value
      FROM investments i
      LEFT JOIN LATERAL (
        SELECT v.realized_value, v.unrealized_value, v.net_value
        FROM valuations v
        WHERE v.investment_id = i.id AND v.snapshot_date <= $1
        ORDER BY v.snapshot_date DESC, v.id DESC
        LIMIT 1
      ) latest ON TRUE
      WHERE i.asset_class = 'direct'
        AND (i.invest_date IS NULL OR i.invest_date <= $1)
      ORDER BY i.id
    `, [asOf]),
    query(`
      SELECT cf.id, cf.investment_id, cf.flow_date, cf.type, cf.amount
      FROM cash_flows cf
      JOIN investments i ON i.id = cf.investment_id
      WHERE i.asset_class = 'direct'
        AND cf.flow_date <= $1
        AND cf.type IN ('investment', 'distribution', 'refund', 'adjustment')
      ORDER BY cf.flow_date, cf.id
    `, [asOf]),
  ]);

  const flowsByPosition = new Map();
  for (const row of flowRows) {
    const investmentId = Number(row.investment_id);
    if (!flowsByPosition.has(investmentId)) flowsByPosition.set(investmentId, []);
    flowsByPosition.get(investmentId).push({
      id: Number(row.id),
      date: String(row.flow_date).slice(0, 10),
      type: row.type,
      amount: Number(row.amount),
    });
  }

  let investedBasis = 0;
  let realizedValue = 0;
  let currentTotalValue = 0;
  let unrealizedTerminalValue = 0;
  let investedBasisPositions = 0;
  let realizedValuePositions = 0;
  let currentMarkPositions = 0;
  let datedPositiveReturnPositions = 0;
  let linkedInvestedAmount = 0;
  let linkedReturnedAmount = 0;
  const openingFlowSources = { linked_ledger: 0, position_basis_fallback: 0 };
  const unresolvedPositions = [];
  const irrFlows = [];

  for (const row of positionRows) {
    const positionBasis = numberOrNull(row.computed_net_invested) ?? Number(row.invested || 0);
    const positionRealized = numberOrNull(row.computed_realized)
      ?? numberOrNull(row.latest_realized_value)
      ?? numberOrNull(row.realized_value)
      ?? 0;
    const hasCurrentMark = [
      row.computed_total_value,
      row.latest_net_value,
      row.latest_unrealized_value,
      row.net_value,
      row.unrealized_value,
      row.multiple,
    ].some(value => value != null);
    const hasReportedValue = hasCurrentMark || row.realized_value != null;
    const positionTotal = numberOrNull(row.computed_total_value)
      ?? numberOrNull(row.latest_net_value)
      ?? numberOrNull(row.net_value)
      ?? (row.unrealized_value != null || row.realized_value != null
        ? Number(row.unrealized_value || 0) + Number(row.realized_value || 0)
        : positionBasis);
    const positionTerminal = Math.max(0,
      row.computed_total_value != null
        ? positionTotal - positionRealized
        : numberOrNull(row.latest_unrealized_value)
          ?? numberOrNull(row.unrealized_value)
          ?? (hasReportedValue ? positionTotal - positionRealized : positionBasis),
    );

    investedBasis += positionBasis;
    realizedValue += positionRealized;
    currentTotalValue += positionTotal;
    unrealizedTerminalValue += positionTerminal;
    if (Number.isFinite(positionBasis) && positionBasis > 0) investedBasisPositions += 1;
    if (Number.isFinite(positionRealized)) realizedValuePositions += 1;
    if (hasCurrentMark) currentMarkPositions += 1;

    const positionFlows = flowsByPosition.get(Number(row.id)) || [];
    const openingFlows = positionFlows.filter(flow => flow.type === 'investment' || flow.type === 'refund');
    const investmentFlows = openingFlows.filter(flow => flow.type === 'investment');
    const distributionFlows = positionFlows.filter(flow => flow.type === 'distribution');
    const adjustmentFlows = positionFlows.filter(flow => flow.type === 'adjustment');
    const linkedBasis = -openingFlows.reduce((sum, flow) => sum + flow.amount, 0);
    const datedDistributions = distributionFlows.reduce((sum, flow) => sum + flow.amount, 0);
    const reasons = [];

    linkedInvestedAmount += investmentFlows.reduce((sum, flow) => sum + Math.abs(flow.amount), 0);
    linkedReturnedAmount += positionFlows.reduce(
      (sum, flow) => flow.amount > 0 ? sum + flow.amount : sum,
      0,
    );
    if (distributionFlows.some(flow => flow.amount > 0)) datedPositiveReturnPositions += 1;

    if (investmentFlows.length > 0 && Math.abs(linkedBasis - positionBasis) <= MONEY_TOLERANCE) {
      openingFlowSources.linked_ledger += 1;
      irrFlows.push(...openingFlows.map(flow => ({ date: flow.date, amount: flow.amount })));
    } else if (row.invest_date && positionBasis > 0) {
      openingFlowSources.position_basis_fallback += 1;
      irrFlows.push({ date: String(row.invest_date).slice(0, 10), amount: -positionBasis });
    } else {
      if (!row.invest_date) reasons.push('missing_investment_date');
      if (!(positionBasis > 0)) reasons.push('missing_invested_basis');
    }

    irrFlows.push(...distributionFlows.map(flow => ({ date: flow.date, amount: flow.amount })));
    irrFlows.push(...adjustmentFlows.map(flow => ({ date: flow.date, amount: flow.amount })));
    if (positionRealized - datedDistributions > MONEY_TOLERANCE) {
      reasons.push('realized_value_exceeds_dated_distributions');
    }
    if (positionTerminal > 0) irrFlows.push({ date: asOf, amount: positionTerminal });
    if (reasons.length > 0) {
      unresolvedPositions.push({
        id: Number(row.id),
        company_name: row.company_name,
        reasons,
      });
    }
  }

  const dpi = investedBasis > 0 ? realizedValue / investedBasis : null;
  const tvpi = investedBasis > 0 ? currentTotalValue / investedBasis : null;
  const computedIrr = unresolvedPositions.length === 0 ? calculateIRR(irrFlows) : null;
  const irrState = unresolvedPositions.length === 0 && computedIrr != null ? 'available' : 'unavailable';
  const baseCoverage = {
    positionCount: positionRows.length,
    investedBasisPositions,
    realizedValuePositions,
    currentMarkPositions,
    openingFlowSources,
    datedPositiveReturnPositions,
    linkedFlowCount: flowRows.length,
    linkedInvestedAmount,
    linkedReturnedAmount,
    unresolvedPositions,
  };

  return {
    as_of: asOf,
    scope: 'direct',
    invested_basis: investedBasis,
    realized_value: realizedValue,
    current_total_value: currentTotalValue,
    unrealized_terminal_value: unrealizedTerminalValue,
    dpi,
    tvpi,
    irr: irrState === 'available' ? computedIrr : null,
    coverage: {
      dpi: returnCoverage(baseCoverage),
      tvpi: returnCoverage(baseCoverage),
      irr: returnCoverage(baseCoverage, {
        state: irrState,
        calculation_error: unresolvedPositions.length === 0 && computedIrr == null
          ? 'irr_not_computable'
          : null,
      }),
      cash_activity: returnCoverage(baseCoverage),
    },
  };
}

export async function portfolioSummary(opts = {}) {
  const { since, until } = opts;

  // Build filter clause and params. Direct positions only — fund LP stakes
  // (asset_class = 'fund') have their own surfaces and their own math.
  const conditions = [`asset_class = 'direct'`];
  const params = [];
  if (since) { params.push(since); conditions.push(`invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`invest_date <= $${params.length}`); }
  const dateFilter = 'WHERE ' + conditions.join(' AND ');
  const dateFilterAnd = 'AND ' + conditions.join(' AND ');

  const summary = await query(`
    SELECT
      COUNT(*) AS total_investments,
      COUNT(*) FILTER (WHERE status = 'Live') AS live,
      COUNT(*) FILTER (WHERE status = 'Realized') AS realized,
      COUNT(*) FILTER (WHERE status = 'Closing') AS closing,
      SUM(invested) AS total_invested,
      -- Terminal value for IRR: fall back to invested (at cost) for locked positions.
      -- Crowdfunding write-offs are now encoded in the data layer (unrealized_value = 0);
      -- this COALESCE only catches legitimately-locked positions awaiting valuation release.
      SUM(COALESCE(unrealized_value, invested)) AS total_unrealized,
      SUM(realized_value) AS total_realized,
      SUM(net_value) AS total_net_value,
      SUM(CASE WHEN invested > 0 THEN COALESCE(net_value, invested) ELSE 0 END) /
        NULLIF(SUM(invested), 0) AS tvpi,
      MIN(invest_date) AS first_investment,
      MAX(invest_date) AS last_investment
    FROM investments ${dateFilter}
  `, params);

  const s = summary[0];

  // Count investments with locked (null) valuations and sum their invested
  const locked = await query(`
    SELECT COUNT(*) AS count, COALESCE(SUM(invested), 0) AS locked_invested FROM investments
    WHERE status = 'Live' AND unrealized_value IS NULL ${dateFilterAnd}
  `, params);

  // Top performers
  const top = await query(`
    SELECT company_name, invested, net_value, multiple
    FROM investments
    WHERE multiple IS NOT NULL AND multiple > 0 ${dateFilterAnd}
    ORDER BY multiple DESC
    LIMIT 10
  `, params);

  // By instrument
  const byInstrument = await query(`
    SELECT instrument, COUNT(*) AS count, SUM(invested) AS total
    FROM investments
    WHERE instrument IS NOT NULL ${dateFilterAnd}
    GROUP BY instrument
    ORDER BY count DESC, instrument
  `, params);

  // By round
  const byRound = await query(`
    SELECT round, COUNT(*) AS count, SUM(invested) AS total
    FROM investments
    WHERE round IS NOT NULL AND round != '' ${dateFilterAnd}
    GROUP BY round
    ORDER BY count DESC, round
  `, params);

  // By stage bucket
  const byStage = await query(`
    SELECT
      COALESCE(stage_bucket, 'unknown') AS stage_bucket,
      COUNT(*) AS count,
      SUM(COALESCE(computed_net_invested, invested)) AS net_invested,
      SUM(COALESCE(computed_realized, realized_value, 0)) AS realized,
      SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) AS total_value,
      ROUND(
        SUM(COALESCE(computed_realized, realized_value, 0)) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS dpi,
      ROUND(
        SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS tvpi
    FROM investments ${dateFilter}
    GROUP BY COALESCE(stage_bucket, 'unknown')
    ORDER BY ARRAY_POSITION(
      ARRAY['pre-seed','seed','seed-ext','series-a','series-b','series-c','growth','fund','unknown'],
      COALESCE(stage_bucket, 'unknown')
    )
  `, params);

  // Portfolio-level IRR from investment cash_flows + terminal unrealized
  // Exclude deposits/withdrawals (account-level transfers, not investment returns)
  // When date-filtered, scope to investments in the date range
  const irrParams = [];
  let irrDateFilter = '';
  if (since || until) {
    const irrConds = [];
    if (since) { irrParams.push(since); irrConds.push(`i.invest_date >= $${irrParams.length}`); }
    if (until) { irrParams.push(until); irrConds.push(`i.invest_date <= $${irrParams.length}`); }
    irrDateFilter = 'AND ' + irrConds.join(' AND ');
  }
  const cfRows = await query(`
    SELECT cf.flow_date AS date, cf.amount FROM cash_flows cf
    JOIN investments i ON i.id = cf.investment_id
    WHERE cf.type IN ('investment', 'distribution', 'refund', 'adjustment')
      AND i.asset_class = 'direct'
    ${irrDateFilter}
    ORDER BY cf.flow_date
  `, irrParams);
  const today = new Date().toISOString().slice(0, 10);
  const terminalValue = Number(s.total_unrealized || 0);
  const irrFlows = cfRows.map(r => ({ date: r.date, amount: Number(r.amount) }));
  if (terminalValue > 0) {
    irrFlows.push({ date: today, amount: terminalValue });
  }
  s.irr = calculateIRR(irrFlows);

  return {
    summary: s,
    locked: locked[0].count,
    lockedInvested: Number(locked[0].locked_invested),
    top, byInstrument, byRound, byStage,
  };
}

export async function portfolioByStage() {
  const rows = await query(`
    SELECT
      COALESCE(stage_bucket, 'unknown') AS stage_bucket,
      COUNT(*) AS n,
      SUM(cf_net_invested) AS net_invested,
      SUM(best_realized) AS realized,
      SUM(best_total_value) AS total_value,
      ROUND(
        SUM(best_realized) /
        NULLIF(SUM(cf_net_invested), 0), 3
      ) AS dpi,
      ROUND(
        SUM(best_total_value) /
        NULLIF(SUM(cf_net_invested), 0), 3
      ) AS tvpi
    FROM investments_effective
    GROUP BY COALESCE(stage_bucket, 'unknown')
    ORDER BY ARRAY_POSITION(
      ARRAY['pre-seed','seed','seed-ext','series-a','series-b','series-c','growth','fund','unknown'],
      COALESCE(stage_bucket, 'unknown')
    )
  `);
  return rows;
}

/** portfolioByStage with barbell roll-up. Returns { byStage, barbell } for the printer. */
export async function portfolioByStageWithBarbell() {
  const rows = await portfolioByStage();

  const barbellMap = {};
  for (const r of rows) {
    const g = stageToBarbellGroup(r.stage_bucket);
    if (!barbellMap[g]) barbellMap[g] = { group: g, deal_count: 0, net_invested: 0, realized: 0, total_value: 0 };
    const b = barbellMap[g];
    b.deal_count   += Number(r.n);
    b.net_invested += Number(r.net_invested || 0);
    b.realized     += Number(r.realized || 0);
    b.total_value  += Number(r.total_value || 0);
  }
  const barbell = ['Early', 'Mid', 'Late', 'Growth', 'Unknown']
    .filter(g => barbellMap[g])
    .map(g => {
      const b = barbellMap[g];
      return {
        ...b,
        dpi:  b.net_invested > 0 ? b.realized / b.net_invested : null,
        tvpi: b.net_invested > 0 ? b.total_value / b.net_invested : null,
      };
    });

  const byStage = rows.map(r => ({ ...r, deal_count: Number(r.n), avg_check: r.n > 0 ? Number(r.net_invested) / Number(r.n) : 0 }));
  return { byStage, barbell };
}

export async function portfolioList(sortBy = 'invest_date', opts = {}) {
  const { since, until } = opts;
  const validSorts = ['invest_date', 'invested', 'multiple', 'company_name', 'net_value'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'invest_date';
  const dir = sort === 'company_name' ? 'ASC' : 'DESC';

  // Use investments_effective view for best-available derived values
  const sortCol = sort === 'multiple' ? 'best_multiple'
    : sort === 'net_value' ? 'best_total_value'
    : sort;

  const conditions = [];
  const params = [];
  if (since) { params.push(since); conditions.push(`i.invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`i.invest_date <= $${params.length}`); }
  const dateFilter = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const rows = await query(`
    SELECT
      i.id, i.company_name, i.status, i.invest_date, i.invested,
      i.best_unrealized_value AS unrealized_value,
      COALESCE(i.best_total_value, i.invested) AS net_value,
      COALESCE(i.best_multiple, 1.0) AS multiple,
      i.round, i.market, i.lead,
      raw.conviction_now, raw.conviction_entry, raw.qsbs_eligible,
      COALESCE(
        (SELECT string_agg(t.name, ', ' ORDER BY t.name) FROM investment_theses it JOIN theses t ON t.id = it.thesis_id WHERE it.investment_id = i.id),
        ''
      ) AS theses
    FROM investments_effective i
    JOIN investments raw ON raw.id = i.id
    ${dateFilter}
    ORDER BY ${sortCol} ${dir} NULLS LAST, i.company_name ASC
  `, params);

  // Bulk-fetch all cash flows and compute per-investment IRR
  const cfRows = await query(`
    SELECT investment_id, flow_date AS date, amount FROM cash_flows
    WHERE investment_id IS NOT NULL ORDER BY flow_date
  `);
  const cfByInvestment = {};
  for (const cf of cfRows) {
    const id = cf.investment_id;
    if (!cfByInvestment[id]) cfByInvestment[id] = [];
    cfByInvestment[id].push({ date: cf.date, amount: Number(cf.amount) });
  }

  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const flows = [...(cfByInvestment[r.id] || [])];
    const unrealized = Number(r.unrealized_value || 0);
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    r.irr = flows.length >= 2 ? calculateIRR(flows) : null;
  }

  return rows;
}

export async function reconcilePortfolio() {
  // This is a Direct-portfolio audit. Other asset classes have different
  // reconciliation semantics and are reported as intentionally excluded.
  const excludedNonDirect = await query(`
    SELECT asset_class, COUNT(*)::int AS position_count
    FROM investments
    WHERE asset_class != 'direct'
    GROUP BY asset_class
    ORDER BY asset_class
  `);

  // Investments with cash_flows that don't match investments.invested
  const mismatched = await query(`
    SELECT i.id, i.company_name, i.invested,
      COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0) AS cf_invested,
      i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0) AS diff
    FROM investments i
    JOIN cash_flows cf ON cf.investment_id = i.id
    WHERE i.asset_class = 'direct'
    GROUP BY i.id, i.company_name, i.invested
    HAVING ABS(i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0)) > 0.01
    ORDER BY ABS(i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0)) DESC
  `);

  // Investments with no cash_flows at all
  const missing = await query(`
    SELECT i.id, i.company_name, i.invested
    FROM investments i
    LEFT JOIN cash_flows cf ON cf.investment_id = i.id
    WHERE i.asset_class = 'direct'
    GROUP BY i.id, i.company_name, i.invested
    HAVING COUNT(cf.id) = 0
    ORDER BY i.invested DESC
  `);

  // Orphan cash_flows (unlinked but with company_raw)
  const orphans = await query(`
    SELECT cf.id, cf.flow_date, cf.type, cf.amount, cf.company_raw, cf.description
    FROM cash_flows cf
    WHERE cf.investment_id IS NULL AND cf.company_raw IS NOT NULL
    ORDER BY cf.flow_date DESC
  `);

  // Matched count
  const matched = await query(`
    SELECT i.id
    FROM investments i
    JOIN cash_flows cf ON cf.investment_id = i.id
    WHERE i.asset_class = 'direct'
    GROUP BY i.id, i.invested
    HAVING ABS(i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0)) <= 0.01
  `);

  // Non-exited positions marked at zero value — likely need status update or manual review
  const zeroValue = await query(`
    SELECT i.id, i.company_name, i.invested, i.status, i.invest_date
    FROM investments_effective ie
    JOIN investments i ON i.id = ie.id
    WHERE ie.best_multiple IS NOT NULL AND ie.best_multiple = 0
      AND i.status NOT IN ('Realized')
      AND i.asset_class = 'direct'
    ORDER BY i.invested DESC
  `);

  // Exact duplicate candidates — same economic identity (company + source +
  // lead + round + invested), multiple rows. High-confidence "this is a dup."
  const exactDuplicates = await query(`
    SELECT company_name, source, lead, round, invested,
           COUNT(*)::int AS n,
           array_agg(id ORDER BY invest_date) AS ids,
           array_agg(invest_date ORDER BY invest_date) AS dates,
           array_agg(status ORDER BY invest_date) AS statuses
    FROM investments
    WHERE asset_class = 'direct'
    GROUP BY company_name, source, lead, round, invested
    HAVING COUNT(*) > 1
    ORDER BY company_name
  `);

  // Possible duplicate / multi-lot positions — same company + source, multiple
  // rows. Lower confidence: real follow-on SPVs will appear here, so this is
  // an audit signal for operator review, not an error.
  const possibleDuplicates = await query(`
    SELECT company_name, source,
           COUNT(*)::int AS n,
           array_agg(id ORDER BY invest_date) AS ids,
           array_agg(invest_date ORDER BY invest_date) AS dates,
           array_agg(status ORDER BY invest_date) AS statuses,
           array_agg(invested ORDER BY invest_date) AS invested_amounts,
           array_agg(lead ORDER BY invest_date) AS leads,
           array_agg(round ORDER BY invest_date) AS rounds
    FROM investments
    WHERE asset_class = 'direct'
    GROUP BY company_name, source
    HAVING COUNT(*) > 1
    ORDER BY company_name
  `);

  return {
    scope: 'direct',
    excluded_non_direct: excludedNonDirect,
    matched_count: matched.length,
    mismatched,
    missing_cash_flows: missing,
    orphan_cash_flows: orphans,
    zero_value: zeroValue,
    exact_duplicates: exactDuplicates,
    possible_duplicates: possibleDuplicates,
  };
}

export async function portfolioDetail(companyName) {
  const rows = await query(`
    SELECT i.*,
      ie.best_unrealized_value,
      COALESCE(
        (SELECT json_agg(json_build_object('name', t.name, 'is_primary', it.is_primary, 'confidence', it.confidence, 'weight', it.weight))
         FROM investment_theses it JOIN theses t ON t.id = it.thesis_id WHERE it.investment_id = i.id),
        '[]'::json
      ) AS theses,
      COALESCE(
        (SELECT json_agg(json_build_object('date', v.snapshot_date, 'unrealized', v.unrealized_value, 'realized', v.realized_value, 'net', v.net_value, 'multiple', v.multiple) ORDER BY v.snapshot_date)
         FROM valuations v WHERE v.investment_id = i.id),
        '[]'::json
      ) AS valuation_history
    FROM investments i
    JOIN investments_effective ie ON ie.id = i.id
    WHERE LOWER(i.company_name) LIKE LOWER($1)
      AND i.asset_class = 'direct'
    ORDER BY i.invest_date
  `, [`%${companyName}%`]);

  // Compute IRR per matched investment. Terminal value uses best_unrealized_value
  // (snapshot, then table, then locked→cost) so list and detail always agree.
  // Cash flows for all matched lots are fetched in one round trip.
  const today = new Date().toISOString().slice(0, 10);
  const cfRows2 = rows.length > 0 ? await query(
    `SELECT investment_id, flow_date AS date, amount FROM cash_flows
     WHERE investment_id = ANY($1) ORDER BY flow_date`,
    [rows.map(r => r.id)]
  ) : [];
  const cfByInvestment = {};
  for (const cf of cfRows2) {
    if (!cfByInvestment[cf.investment_id]) cfByInvestment[cf.investment_id] = [];
    cfByInvestment[cf.investment_id].push({ date: cf.date, amount: Number(cf.amount) });
  }
  for (const r of rows) {
    const flows = [...(cfByInvestment[r.id] || [])];
    const unrealized = Number(r.best_unrealized_value || 0);
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    r.irr = flows.length >= 2 ? calculateIRR(flows) : null;
  }

  // Add lot info with QSBS countdown
  const isMultiLot = rows.length > 1;
  for (const r of rows) {
    const holdingDays = Math.floor((new Date(today) - new Date(r.invest_date)) / (1000 * 60 * 60 * 24));
    const qsbs5yr = new Date(r.invest_date);
    qsbs5yr.setFullYear(qsbs5yr.getFullYear() + 5);
    r.lot = {
      holding_days: holdingDays,
      qsbs_5yr_date: qsbs5yr.toISOString().slice(0, 10),
      qsbs_5yr_met: new Date(today) >= qsbs5yr,
    };
    if (isMultiLot) r.is_multi_lot = true;
  }

  return rows;
}
