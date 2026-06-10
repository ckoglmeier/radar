// Pure data fetchers for portfolio reports. No chalk, no console.log — return
// JSON-serializable shapes that the CLI printers (or future web GUI) consume.

import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';

export async function portfolioSummary(opts = {}) {
  const { since, until } = opts;

  // Build date filter clause and params
  const conditions = [];
  const params = [];
  if (since) { params.push(since); conditions.push(`invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`invest_date <= $${params.length}`); }
  const dateFilter = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const dateFilterAnd = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';

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
    ORDER BY count DESC
  `, params);

  // By round
  const byRound = await query(`
    SELECT round, COUNT(*) AS count, SUM(invested) AS total
    FROM investments
    WHERE round IS NOT NULL AND round != '' ${dateFilterAnd}
    GROUP BY round
    ORDER BY count DESC
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
      COALESCE(
        (SELECT string_agg(t.name, ', ') FROM investment_theses it JOIN theses t ON t.id = it.thesis_id WHERE it.investment_id = i.id),
        ''
      ) AS theses
    FROM investments_effective i
    ${dateFilter}
    ORDER BY ${sortCol} ${dir} NULLS LAST
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
  // Investments with cash_flows that don't match investments.invested
  const mismatched = await query(`
    SELECT i.id, i.company_name, i.invested,
      COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0) AS cf_invested,
      i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0) AS diff
    FROM investments i
    JOIN cash_flows cf ON cf.investment_id = i.id
    GROUP BY i.id, i.company_name, i.invested
    HAVING ABS(i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0)) > 0.01
    ORDER BY ABS(i.invested - COALESCE(SUM(CASE WHEN cf.type = 'investment' THEN ABS(cf.amount) END), 0)) DESC
  `);

  // Investments with no cash_flows at all
  const missing = await query(`
    SELECT i.id, i.company_name, i.invested
    FROM investments i
    LEFT JOIN cash_flows cf ON cf.investment_id = i.id
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
    GROUP BY company_name, source
    HAVING COUNT(*) > 1
    ORDER BY company_name
  `);

  return {
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
    ORDER BY i.invest_date
  `, [`%${companyName}%`]);

  // Compute IRR per matched investment. Terminal value uses best_unrealized_value
  // (snapshot, then table, then locked→cost) so list and detail always agree.
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const cfRows2 = await query(
      `SELECT flow_date AS date, amount FROM cash_flows WHERE investment_id = $1 ORDER BY flow_date`,
      [r.id]
    );
    const flows = cfRows2.map(cf => ({ date: cf.date, amount: Number(cf.amount) }));
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
