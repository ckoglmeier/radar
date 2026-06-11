// Pure data fetchers for thesis reports.
import { query } from '../db/index.js';
import { calculateIRR } from '../utils/irr.js';
import { STAGE_ORDER, BARBELL_GROUPS, stageLabel, stageToBarbellGroup } from '../utils/stage.js';

export async function thesisPerformance(opts = {}) {
  const { since, until } = opts;
  const conditions = ['t.active = TRUE'];
  const params = [];
  if (since) { params.push(since); conditions.push(`i.invest_date >= $${params.length}`); }
  if (until) { params.push(until); conditions.push(`i.invest_date <= $${params.length}`); }
  const whereClause = 'WHERE ' + conditions.join(' AND ');

  const rows = await query(`
    SELECT
      t.name AS thesis,
      COUNT(DISTINCT i.id) AS deal_count,
      SUM(i.invested * it.weight / 100.0) AS total_invested,
      SUM(i.net_value * it.weight / 100.0) AS total_net_value,
      SUM(COALESCE(i.net_value, i.invested) * it.weight / 100.0) /
        NULLIF(SUM(i.invested * it.weight / 100.0), 0) AS tvpi,
      AVG(i.multiple) FILTER (WHERE i.multiple IS NOT NULL) AS avg_multiple,
      MAX(i.multiple) AS best_multiple,
      MIN(i.invest_date) AS first_deal,
      MAX(i.invest_date) AS last_deal,
      COUNT(*) FILTER (WHERE i.status = 'Live') AS live,
      COUNT(*) FILTER (WHERE i.status = 'Realized') AS realized
    FROM theses t
    LEFT JOIN investment_theses it ON it.thesis_id = t.id
    LEFT JOIN investments i ON i.id = it.investment_id
    ${whereClause}
    GROUP BY t.id, t.name
    ORDER BY total_invested DESC NULLS LAST
  `, params);

  // Compute IRR per thesis cluster using cash_flows
  const irrDateFilter = [];
  if (since) irrDateFilter.push(`i.invest_date >= $${irrDateFilter.length + 1}`);
  if (until) irrDateFilter.push(`i.invest_date <= $${irrDateFilter.length + 1}`);
  const irrParams = [];
  if (since) irrParams.push(since);
  if (until) irrParams.push(until);
  const irrWhere = irrDateFilter.length > 0 ? 'AND ' + irrDateFilter.join(' AND ') : '';

  const cfRows = await query(`
    SELECT it.thesis_id, cf.flow_date AS date, cf.amount
    FROM cash_flows cf
    JOIN investments i ON i.id = cf.investment_id
    JOIN investment_theses it ON it.investment_id = cf.investment_id
    JOIN theses t ON t.id = it.thesis_id
    WHERE t.active = TRUE ${irrWhere}
    ORDER BY cf.flow_date
  `, irrParams);
  const cfByThesis = {};
  for (const cf of cfRows) {
    if (!cfByThesis[cf.thesis_id]) cfByThesis[cf.thesis_id] = [];
    cfByThesis[cf.thesis_id].push({ date: cf.date, amount: Number(cf.amount) });
  }

  // Get unrealized by thesis for terminal value
  const unrRows = await query(`
    -- Terminal value for IRR: fall back to invested (at cost) for locked positions.
    -- Crowdfunding write-offs are encoded in the data layer (unrealized_value = 0).
    SELECT it.thesis_id, SUM(COALESCE(i.unrealized_value, i.invested)) AS unrealized
    FROM investment_theses it
    JOIN investments i ON i.id = it.investment_id
    JOIN theses t ON t.id = it.thesis_id
    WHERE t.active = TRUE ${irrWhere}
    GROUP BY it.thesis_id
  `, irrParams);
  const unrByThesis = {};
  for (const r of unrRows) unrByThesis[r.thesis_id] = Number(r.unrealized || 0);

  const today = new Date().toISOString().slice(0, 10);
  const thesisIdRows = await query(`SELECT id, name FROM theses WHERE active = TRUE`);
  const idByName = {};
  for (const t of thesisIdRows) idByName[t.name] = t.id;

  for (const r of rows) {
    const tid = idByName[r.thesis];
    const flows = [...(cfByThesis[tid] || [])];
    const unrealized = unrByThesis[tid] || 0;
    if (unrealized > 0) flows.push({ date: today, amount: unrealized });
    r.irr = flows.length >= 2 ? calculateIRR(flows) : null;
  }

  return rows;
}

export async function thesisList() {
  const rows = await query(`
    SELECT t.*, COUNT(it.investment_id) AS investment_count
    FROM theses t
    LEFT JOIN investment_theses it ON it.thesis_id = t.id
    GROUP BY t.id
    ORDER BY investment_count DESC
  `);
  return rows;
}

export async function untaggedInvestments() {
  const rows = await query(`
    SELECT i.company_name, i.invest_date, i.invested, i.market, i.round, i.status
    FROM investments i
    LEFT JOIN investment_theses it ON it.investment_id = i.id
    WHERE it.investment_id IS NULL
    ORDER BY i.invest_date DESC, i.company_name
  `);
  return rows;
}

export async function stageBreakdown() {
  const rows = await query(`
    SELECT
      COALESCE(stage_bucket, 'unknown') AS stage_bucket,
      COUNT(*) AS deal_count,
      SUM(COALESCE(computed_net_invested, invested)) AS net_invested,
      AVG(COALESCE(computed_net_invested, invested)) AS avg_check,
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
    FROM investments
    GROUP BY COALESCE(stage_bucket, 'unknown')
    ORDER BY ARRAY_POSITION(
      ARRAY['pre-seed','seed','seed-ext','series-a','series-b','series-c','growth','fund','unknown'],
      COALESCE(stage_bucket, 'unknown')
    )
  `);

  // Barbell roll-up: aggregate Early / Mid / Late
  const barbellMap = {};
  for (const row of rows) {
    const group = stageToBarbellGroup(row.stage_bucket);
    if (!barbellMap[group]) {
      barbellMap[group] = { group, deal_count: 0, net_invested: 0, realized: 0, total_value: 0 };
    }
    const b = barbellMap[group];
    b.deal_count   += Number(row.deal_count);
    b.net_invested += Number(row.net_invested || 0);
    b.realized     += Number(row.realized || 0);
    b.total_value  += Number(row.total_value || 0);
  }
  const barbell = ['Early', 'Mid', 'Late', 'Growth', 'Unknown']
    .filter(g => barbellMap[g])
    .map(g => {
      const b = barbellMap[g];
      return {
        ...b,
        dpi:  b.net_invested > 0 ? Math.round(b.realized / b.net_invested * 1000) / 1000 : null,
        tvpi: b.net_invested > 0 ? Math.round(b.total_value / b.net_invested * 1000) / 1000 : null,
      };
    });

  return { byStage: rows, barbell };
}

export async function eraAnalysis() {
  const rows = await query(`
    SELECT
      CASE
        WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)'
        ELSE 'Conviction (2023+)'
      END AS era,
      COUNT(*) AS deal_count,
      SUM(invested) AS total_invested,
      AVG(invested) AS avg_check,
      SUM(net_value) AS total_net_value,
      SUM(COALESCE(net_value, invested)) /
        NULLIF(SUM(invested), 0) AS tvpi,
      AVG(multiple) FILTER (WHERE multiple IS NOT NULL) AS avg_multiple
    FROM investments
    GROUP BY CASE WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)' ELSE 'Conviction (2023+)' END
    ORDER BY era
  `);
  return rows;
}
