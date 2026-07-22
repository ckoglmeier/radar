// Time-windowed performance metrics.
// Returns YTD, trailing 12-month, per-vintage-year, and per-quarter views.

import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';

/**
 * Portfolio value as of a given date. For each investment that existed by
 * asOfDate, uses the most recent valuation snapshot on or before that date.
 * Falls back to invested (cost basis) when no snapshot exists.
 */
export async function portfolioValueAsOf(asOfDate) {
  const rows = await query(`
    SELECT
      SUM(COALESCE(v.net_value, i.invested)) AS total_value,
      COUNT(*) AS investment_count,
      COUNT(v.net_value) AS valued_count
    FROM investments i
    LEFT JOIN LATERAL (
      SELECT net_value FROM valuations
      WHERE investment_id = i.id AND snapshot_date <= $1
      ORDER BY snapshot_date DESC LIMIT 1
    ) v ON true
    WHERE i.invest_date <= $1 AND i.asset_class = 'direct'
  `, [asOfDate]);
  const r = rows[0];
  return {
    total_value: Number(r.total_value || 0),
    investment_count: Number(r.investment_count),
    valued_count: Number(r.valued_count),
  };
}

/**
 * Sum cash flows by direction within a date range.
 * Returns { cash_in, cash_out } where cash_in = distributions/refunds,
 * cash_out = investments deployed.
 */
export async function cashFlowsInRange(startDate, endDate) {
  // Investment-level flows only: deposits/withdrawals are transfers between
  // the owner's bank and the brokerage account — counting them here showed
  // the owner's own ACH transfers as "cash returned". Same filter the
  // portfolio ledger uses. Fund flows excluded from direct-window math.
  const rows = await query(`
    SELECT
      COALESCE(SUM(CASE WHEN cf.amount > 0 THEN cf.amount ELSE 0 END), 0) AS cash_in,
      COALESCE(SUM(CASE WHEN cf.amount < 0 THEN ABS(cf.amount) ELSE 0 END), 0) AS cash_out
    FROM cash_flows cf
    LEFT JOIN investments i ON i.id = cf.investment_id
    WHERE cf.flow_date BETWEEN $1 AND $2
      AND cf.type IN ('investment', 'distribution', 'refund')
      AND COALESCE(i.asset_class, 'direct') = 'direct'
  `, [startDate, endDate]);
  return {
    cash_in: Number(rows[0].cash_in),
    cash_out: Number(rows[0].cash_out),
  };
}

export function computeWindowMetrics(startValue, endValue, cashIn, cashOut) {
  // Flow-adjusted period return (Modified Dietz, midpoint convention).
  // Capital deployed during the window is a contribution, not a gain —
  // the naive (end-start)/start formula counted every new check as
  // appreciation. netFlow = capital added to the portfolio in-window.
  const netFlow = cashOut - cashIn;
  const gain = endValue - startValue - netFlow;
  const base = startValue + netFlow / 2;
  return {
    gain: Math.round(gain),
    value_change_pct: base > 0 ? Math.round(gain / base * 10000) / 100 : null,
    // Window "TVPI"/"DPI" were period ratios wearing since-inception labels
    // — retired. TVPI/DPI live on the vintage (since-inception) views.
  };
}

/**
 * Main entry point. Returns all time-windowed performance views.
 */
export async function performanceWindows() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const ytdStart = `${year}-01-01`;

  // Trailing 12 months
  const t12Start = new Date();
  t12Start.setFullYear(t12Start.getFullYear() - 1);
  const trailing12mStart = t12Start.toISOString().slice(0, 10);

  // --- YTD ---
  const [ytdStartVal, ytdEndVal, ytdCash] = await Promise.all([
    portfolioValueAsOf(ytdStart),
    portfolioValueAsOf(today),
    cashFlowsInRange(ytdStart, today),
  ]);
  const ytdMetrics = computeWindowMetrics(
    ytdStartVal.total_value, ytdEndVal.total_value,
    ytdCash.cash_in, ytdCash.cash_out
  );
  const ytd = {
    start_date: ytdStart,
    end_date: today,
    start_value: ytdStartVal.total_value,
    end_value: ytdEndVal.total_value,
    cash_in: ytdCash.cash_in,
    cash_out: ytdCash.cash_out,
    ...ytdMetrics,
  };

  // --- Trailing 12M ---
  const [t12StartVal, t12EndVal, t12Cash] = await Promise.all([
    portfolioValueAsOf(trailing12mStart),
    portfolioValueAsOf(today),
    cashFlowsInRange(trailing12mStart, today),
  ]);
  const t12Metrics = computeWindowMetrics(
    t12StartVal.total_value, t12EndVal.total_value,
    t12Cash.cash_in, t12Cash.cash_out
  );
  const trailing12m = {
    start_date: trailing12mStart,
    end_date: today,
    start_value: t12StartVal.total_value,
    end_value: t12EndVal.total_value,
    cash_in: t12Cash.cash_in,
    cash_out: t12Cash.cash_out,
    ...t12Metrics,
  };

  // --- By Vintage Year ---
  const vintageRows = await query(`
    SELECT
      EXTRACT(YEAR FROM invest_date)::int AS vintage_year,
      COUNT(*) AS deal_count,
      SUM(COALESCE(computed_net_invested, invested)) AS invested,
      SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) AS current_value,
      SUM(COALESCE(computed_realized, realized_value, 0)) AS realized,
      ROUND(
        SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS tvpi,
      ROUND(
        SUM(COALESCE(computed_realized, realized_value, 0)) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 3
      ) AS dpi
    FROM investments
    WHERE invest_date IS NOT NULL AND asset_class = 'direct'
    GROUP BY EXTRACT(YEAR FROM invest_date)
    ORDER BY vintage_year
  `);
  // Compute IRR per vintage year
  const vintageCfRows = await query(`
    SELECT
      EXTRACT(YEAR FROM i.invest_date)::int AS vintage_year,
      cf.flow_date AS date,
      cf.amount
    FROM cash_flows cf
    JOIN investments i ON i.id = cf.investment_id
    WHERE i.invest_date IS NOT NULL AND i.asset_class = 'direct'
    ORDER BY cf.flow_date
  `);
  const cfByVintage = {};
  for (const cf of vintageCfRows) {
    const vy = cf.vintage_year;
    if (!cfByVintage[vy]) cfByVintage[vy] = [];
    cfByVintage[vy].push({ date: cf.date, amount: Number(cf.amount) });
  }

  // Unrealized by vintage for terminal value
  const vintageUnrRows = await query(`
    SELECT
      EXTRACT(YEAR FROM invest_date)::int AS vintage_year,
      -- Terminal value for IRR: fall back to invested (at cost) for locked positions.
      -- Crowdfunding write-offs are encoded in the data layer (unrealized_value = 0).
      SUM(COALESCE(unrealized_value, invested)) AS unrealized
    FROM investments
    WHERE invest_date IS NOT NULL AND asset_class = 'direct'
    GROUP BY EXTRACT(YEAR FROM invest_date)
  `);
  const unrByVintage = {};
  for (const r of vintageUnrRows) unrByVintage[Number(r.vintage_year)] = Number(r.unrealized || 0);

  const byVintageYear = vintageRows.map(r => {
    const vy = Number(r.vintage_year);
    const flows = [...(cfByVintage[vy] || [])];
    const unrealized = unrByVintage[vy] || 0;
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    return {
      vintage_year: vy,
      deal_count: Number(r.deal_count),
      invested: Number(r.invested || 0),
      current_value: Number(r.current_value || 0),
      realized: Number(r.realized || 0),
      tvpi: r.tvpi != null ? Number(r.tvpi) : null,
      dpi: r.dpi != null ? Number(r.dpi) : null,
      irr: flows.length >= 2 ? calculateIRR(flows) : null,
    };
  });

  // --- By Quarter ---
  const quarterRows = await query(`
    WITH bounds AS (
      SELECT
        date_trunc('quarter', MIN(invest_date))::date AS first_q,
        date_trunc('quarter', CURRENT_DATE)::date AS last_q
      FROM investments
      WHERE invest_date IS NOT NULL AND asset_class = 'direct'
    ),
    quarters AS (
      SELECT generate_series(first_q, last_q, '3 months'::interval)::date AS quarter_start
      FROM bounds
    ),
    deployed AS (
      SELECT
        date_trunc('quarter', cf.flow_date)::date AS q,
        COALESCE(SUM(CASE WHEN cf.amount < 0 THEN ABS(cf.amount) ELSE 0 END), 0) AS deployed,
        COALESCE(SUM(CASE WHEN cf.amount > 0 THEN cf.amount ELSE 0 END), 0) AS distributions
      FROM cash_flows cf
      LEFT JOIN investments i ON i.id = cf.investment_id
      WHERE cf.type IN ('investment', 'distribution', 'refund')
        AND COALESCE(i.asset_class, 'direct') = 'direct'
      GROUP BY date_trunc('quarter', cf.flow_date)
    )
    SELECT
      q.quarter_start,
      COALESCE(d.deployed, 0) AS deployed,
      COALESCE(d.distributions, 0) AS distributions,
      COALESCE(d.distributions, 0) - COALESCE(d.deployed, 0) AS net_cash_flow
    FROM quarters q
    LEFT JOIN deployed d ON d.q = q.quarter_start
    ORDER BY q.quarter_start
  `);
  const byQuarter = quarterRows.map(r => {
    const qs = new Date(r.quarter_start);
    const qLabel = `${qs.getFullYear()}-Q${Math.floor(qs.getMonth() / 3) + 1}`;
    return {
      quarter: qLabel,
      quarter_start: r.quarter_start,
      deployed: Number(r.deployed || 0),
      distributions: Number(r.distributions || 0),
      net_cash_flow: Number(r.net_cash_flow || 0),
    };
  });

  return { ytd, trailing12m, byVintageYear, byQuarter };
}
