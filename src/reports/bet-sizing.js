/**
 * Report layer for bet-size command.
 * Fetches evaluation + portfolio state from DB, runs Kelly solver,
 * returns a JSON-serializable result object.
 */

import { query } from '../db/index.js';
import {
  buildBetJson, buildPortfolioJson, runKelly,
  scoreToTier, scoreToBand,
  thesisToCluster, loadBetSizingConfig,
} from '../utils/bet-sizing.js';
import { getDistributions } from '../lenses/loader.js';

export async function betSizeReport(company, opts = {}) {
  // 1. Look up the company's latest eval + primary thesis
  const evalRow = await query(`
    SELECT
      e.total_score,
      e.thesis_fit_score,
      e.viability_score,
      e.verdict,
      i.round,
      i.company_name,
      t.name AS primary_thesis
    FROM deal_evaluations e
    LEFT JOIN investments i ON i.id = e.investment_id
    LEFT JOIN pipeline_invites pi ON pi.id = e.pipeline_invite_id
    LEFT JOIN investment_theses it ON it.investment_id = e.investment_id AND it.is_primary = true
    LEFT JOIN theses t ON t.id = it.thesis_id
    WHERE LOWER(COALESCE(i.company_name, pi.company_name)) LIKE LOWER($1)
    ORDER BY e.eval_date DESC NULLS LAST
    LIMIT 1
  `, [`%${company}%`]);

  const row = evalRow[0];
  if (!row) return { found: false };

  const score = opts.score != null
    ? parseFloat(opts.score)
    : parseFloat(row.total_score ?? (parseFloat(row.thesis_fit_score || 0) + parseFloat(row.viability_score || 0)));

  const round = opts.round || row.round || 'Seed';
  const isLateStageApproved = !!opts.lateStageApproved;
  const cluster = thesisToCluster(row.primary_thesis);

  // Load config once; provides tier thresholds, check amounts, and risk capital.
  const config = loadBetSizingConfig();
  const minCheck = parseInt(opts.minCheck || config.min_check || 0, 10);
  const maxCheck = config.max_check || Infinity;

  let distributionOverride = null;
  if (opts.distribution) {
    distributionOverride = typeof opts.distribution === 'string'
      ? JSON.parse(opts.distribution)
      : opts.distribution;
  }

  // 2. Tier + distribution
  const tier = scoreToTier(score, isLateStageApproved, config);
  const band = isLateStageApproved ? '44+' : scoreToBand(score);
  const dist = distributionOverride || getDistributions()[band];
  const ev = dist.outcomes.reduce((s, o, i) => s + o * dist.probs[i], 0);

  const result = {
    found: true,
    companyName: row.company_name,
    score,
    round,
    band,
    cluster,
    tier,
    distribution: dist,
    ev,
  };

  // 3. If score < 30, it's a pass — no Kelly needed
  if (tier.check === 0) {
    result.pass = true;
    return result;
  }
  result.pass = false;

  // 4. Kelly sizing (requires configured risk capital)
  if (!config.risk_capital || config.floor == null) {
    result.kellySkipped = true;
    return result;
  }
  result.kellySkipped = false;

  // Build portfolio state from DB
  const deployedRows = await query(`
    SELECT SUM(invested) AS illiquid
    FROM investments
    WHERE asset_class = 'direct'
      AND (status != 'Realized' OR (unrealized_value IS NOT NULL AND unrealized_value > 0))
  `);
  const clusterRows = await query(`
    SELECT t.name, SUM(i.invested) AS exposure
    FROM investments i
    JOIN investment_theses it ON it.investment_id = i.id AND it.is_primary = true
    JOIN theses t ON t.id = it.thesis_id
    WHERE t.active = true
      AND i.asset_class = 'direct'
      AND (i.status != 'Realized' OR (i.unrealized_value IS NOT NULL AND i.unrealized_value > 0))
    GROUP BY t.name
  `);
  // Year-to-date cash deployed (current calendar year). Drives annual_budget_remaining.
  const ytdThisYearRows = await query(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS ytd
    FROM cash_flows
    WHERE type = 'investment'
      AND flow_date >= date_trunc('year', CURRENT_DATE)
  `);

  const ytdDeployed = parseFloat(deployedRows[0]?.illiquid || 0);
  const ytdDeployedThisYear = parseFloat(ytdThisYearRows[0]?.ytd || 0);
  const clusterExposures = {};
  for (const r of clusterRows) {
    clusterExposures[thesisToCluster(r.name)] = parseFloat(r.exposure);
  }
  const illiquidPct = config.investable_assets
    ? ytdDeployed / config.investable_assets
    : 0;

  const betJson = buildBetJson({
    name: row.company_name,
    score,
    round,
    minCheck,
    maxCheck,
    cluster,
    isLateStageApproved,
    distributionOverride,
  });

  const portfolioJson = buildPortfolioJson(config, {
    ytdDeployed,
    ytdDeployedThisYear,
    clusterExposures,
    illiquidPct,
  });
  const kellyResult = runKelly(betJson, portfolioJson);

  if (kellyResult.ok) {
    result.kelly = kellyResult.data;
    // Exceed-cap flag — only fires when the structural caps would support
    // a larger check than max_check. The suggestion must also respect the
    // annual deployment budget (when configured) so we don't recommend
    // blowing the year's cap on one deal.
    const ilAdj = kellyResult.data.lenses?.['illiquidity_adjusted'] || 0;
    const singleCap = kellyResult.data.lenses?.['single_position_cap'] || 0;
    const annualRemaining = kellyResult.data.lenses?.['annual_budget_remaining'];
    const naturalCeiling = Math.min(ilAdj, singleCap);
    if (kellyResult.data.binding_constraint === 'max_check' && naturalCeiling > betJson.max_check * 1.2) {
      const ceilings = [naturalCeiling, singleCap];
      if (annualRemaining != null) ceilings.push(annualRemaining);
      const effectiveCeiling = Math.min(...ceilings);
      result.exceedCap = {
        ilAdj: Math.round(ilAdj),
        singleCap: Math.round(singleCap),
        annualRemaining: annualRemaining != null ? Math.round(annualRemaining) : null,
        suggested: Math.round(effectiveCeiling / 500) * 500,
      };
    }
  } else {
    result.kellyError = kellyResult.error;
  }

  return result;
}
