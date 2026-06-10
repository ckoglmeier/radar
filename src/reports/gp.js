// Pure data fetchers for GP / source quality reports.
import { query } from '../db/index.js';

// Crowdfunding platforms are excluded from GP analysis — they are sourcing channels,
// not syndicate leads, and pollute per-GP quality metrics.
const CROWDFUNDING_LEADS = ["'Republic'", "'StartEngine'", "'WeFunder'", "'Backstage Syndicate'"].join(', ');

export async function gpSummary() {
  // Use computed_* values when available (from cash_flows recompute), fall back to AngelList columns.
  // effective_multiple = COALESCE(computed_multiple, multiple)
  // effective_value    = COALESCE(computed_total_value, realized_value + unrealized_value)
  const rows = await query(`
    WITH inv AS (
      SELECT
        COALESCE(lead, 'Direct / Unknown') AS gp_name,
        invested,
        status,
        COALESCE(computed_multiple, multiple) AS eff_mult,
        COALESCE(computed_total_value,
                 COALESCE(realized_value, 0) + COALESCE(unrealized_value, 0)) AS eff_value
      FROM investments
      WHERE COALESCE(lead, '') NOT IN (${CROWDFUNDING_LEADS})
    )
    SELECT
      gp_name,
      COUNT(*) AS deal_count,
      SUM(invested) AS total_invested,
      AVG(invested) AS avg_check,
      SUM(CASE WHEN eff_mult IS NOT NULL THEN invested * eff_mult ELSE 0 END) /
        NULLIF(SUM(CASE WHEN eff_mult IS NOT NULL THEN invested ELSE 0 END), 0) AS weighted_avg_multiple,
      SUM(eff_value) AS total_value,
      SUM(COALESCE(eff_value, invested)) /
        NULLIF(SUM(invested), 0) AS tvpi,
      COUNT(*) FILTER (WHERE status = 'Realized') AS realized_count
    FROM inv
    GROUP BY gp_name
    ORDER BY SUM(invested) DESC NULLS LAST
  `);

  // Get best performer per GP (using effective multiple)
  const bestPerformers = await query(`
    SELECT DISTINCT ON (COALESCE(lead, 'Direct / Unknown'))
      COALESCE(lead, 'Direct / Unknown') AS gp_name,
      company_name,
      COALESCE(computed_multiple, multiple) AS multiple
    FROM investments
    WHERE COALESCE(computed_multiple, multiple) IS NOT NULL
      AND COALESCE(lead, '') NOT IN (${CROWDFUNDING_LEADS})
    ORDER BY COALESCE(lead, 'Direct / Unknown'), COALESCE(computed_multiple, multiple) DESC
  `);

  const bestMap = {};
  for (const b of bestPerformers) {
    bestMap[b.gp_name] = { company: b.company_name, multiple: b.multiple };
  }

  return { rows, bestMap };
}

export async function gpDetail(gpName) {
  // Find investments for this GP (fuzzy match on lead)
  const investments = await query(`
    SELECT
      i.company_name, i.invest_date, i.invested, i.unrealized_value, i.realized_value,
      i.net_value, i.multiple, i.status, i.market, i.round, i.instrument,
      COALESCE(
        (SELECT string_agg(t.name, ', ') FROM investment_theses it JOIN theses t ON t.id = it.thesis_id WHERE it.investment_id = i.id),
        ''
      ) AS theses
    FROM investments i
    WHERE LOWER(COALESCE(i.lead, '')) LIKE LOWER($1)
    ORDER BY i.invest_date DESC
  `, [`%${gpName}%`]);

  // Summary stats
  const stats = await query(`
    SELECT
      COALESCE(lead, 'Direct / Unknown') AS gp_name,
      COUNT(*) AS deal_count,
      SUM(invested) AS total_invested,
      AVG(invested) AS avg_check,
      SUM(COALESCE(realized_value, 0) + COALESCE(unrealized_value, 0)) AS total_value,
      SUM(COALESCE(realized_value, 0) + COALESCE(unrealized_value, invested)) /
        NULLIF(SUM(invested), 0) AS tvpi,
      SUM(CASE WHEN multiple IS NOT NULL THEN invested * multiple ELSE 0 END) /
        NULLIF(SUM(CASE WHEN multiple IS NOT NULL THEN invested ELSE 0 END), 0) AS weighted_avg_multiple,
      AVG(multiple) FILTER (WHERE multiple IS NOT NULL) AS avg_multiple,
      MAX(multiple) AS best_multiple,
      MIN(multiple) FILTER (WHERE multiple IS NOT NULL) AS worst_multiple,
      COUNT(*) FILTER (WHERE status = 'Live') AS live,
      COUNT(*) FILTER (WHERE status = 'Realized') AS realized,
      COUNT(*) FILTER (WHERE status = 'Closing') AS closing,
      MIN(invest_date) AS first_deal,
      MAX(invest_date) AS last_deal
    FROM investments
    WHERE LOWER(COALESCE(lead, '')) LIKE LOWER($1)
    GROUP BY COALESCE(lead, 'Direct / Unknown')
  `, [`%${gpName}%`]);

  // Thesis distribution
  const thesisDist = await query(`
    SELECT t.name AS thesis, COUNT(DISTINCT i.id) AS count, SUM(i.invested) AS total_invested
    FROM investments i
    JOIN investment_theses it ON it.investment_id = i.id
    JOIN theses t ON t.id = it.thesis_id
    WHERE LOWER(COALESCE(i.lead, '')) LIKE LOWER($1)
    GROUP BY t.name
    ORDER BY count DESC
  `, [`%${gpName}%`]);

  // Era breakdown
  const eras = await query(`
    SELECT
      CASE
        WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)'
        ELSE 'Conviction (2023+)'
      END AS era,
      COUNT(*) AS deal_count,
      SUM(invested) AS total_invested,
      AVG(invested) AS avg_check,
      AVG(multiple) FILTER (WHERE multiple IS NOT NULL) AS avg_multiple,
      SUM(COALESCE(realized_value, 0) + COALESCE(unrealized_value, invested)) /
        NULLIF(SUM(invested), 0) AS tvpi
    FROM investments
    WHERE LOWER(COALESCE(lead, '')) LIKE LOWER($1)
    GROUP BY CASE WHEN invest_date < '2023-01-01' THEN 'Exploration (2021-2022)' ELSE 'Conviction (2023+)' END
    ORDER BY era
  `, [`%${gpName}%`]);

  // Stage distribution
  const stageDist = await query(`
    SELECT
      COALESCE(stage_bucket, 'unknown') AS stage_bucket,
      COUNT(*) AS deal_count,
      SUM(COALESCE(computed_net_invested, invested)) AS net_invested,
      ROUND(
        SUM(COALESCE(computed_total_value, COALESCE(unrealized_value,0) + COALESCE(realized_value,0))) /
        NULLIF(SUM(COALESCE(computed_net_invested, invested)), 0), 2
      ) AS tvpi
    FROM investments
    WHERE LOWER(COALESCE(lead, '')) LIKE LOWER($1)
    GROUP BY COALESCE(stage_bucket, 'unknown')
    ORDER BY ARRAY_POSITION(
      ARRAY['pre-seed','seed','seed-ext','series-a','series-b','series-c','growth','fund','unknown'],
      COALESCE(stage_bucket, 'unknown')
    )
  `, [`%${gpName}%`]);

  return { investments, stats: stats[0] || null, thesisDist, eras, stageDist };
}
