/**
 * bet-sizing.js
 *
 * Adapter between Radar (rubric scores, DB portfolio state) and the Kelly
 * solver in src/scripts/size_bet.py.
 *
 * Tier thresholds and check amounts are configured in src/config/bet-sizing.json
 * (gitignored). Copy src/config/bet-sizing.json.example and fill in your numbers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { runAnalytics } from './analytics.js';
import { getDistributions, getThesisClusters, getRoundParams } from '../lenses/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Score → distribution + tier
// ---------------------------------------------------------------------------

export function scoreToBand(score) {
  if (score >= 44) return '44+';
  if (score >= 39) return '39-43';
  if (score >= 30) return '30-38';
  return '<30';
}

/**
 * Map a rubric score to a check tier using config from bet-sizing.json.
 * tiers must be an array of {min_score, check} sorted descending by min_score.
 * Returns { check, tier, reason }.
 */
export function scoreToTier(score, isLateStageApproved = false, config = null) {
  const cfg = config || loadBetSizingConfig();
  const lsaCheck = cfg.late_stage_approved_check ?? 0;
  if (isLateStageApproved) {
    const label = lsaCheck > 0 ? `$${(lsaCheck / 1000).toFixed(0)}K` : 'Pass';
    return { check: lsaCheck, tier: label, reason: 'late-stage approved (45+ or carve-out)' };
  }
  const tiers = cfg.tiers;
  if (!tiers || !Array.isArray(tiers) || tiers.length === 0) {
    throw new Error(
      'bet-sizing.json is missing "tiers". ' +
      'Copy src/config/bet-sizing.json.example to src/config/bet-sizing.json and fill in your numbers.'
    );
  }
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (score >= t.min_score) {
      const check = t.check ?? 0;
      const label = check > 0 ? `$${(check / 1000).toFixed(0)}K` : 'Pass';
      // Build a band label: upper bound is one below the previous tier's min_score,
      // or "+" if this is the top tier. Tiers are sorted descending by min_score.
      const prevTier = i > 0 ? tiers[i - 1] : null;
      const bandLabel = prevTier != null
        ? `${t.min_score}-${prevTier.min_score - 1}`
        : `${t.min_score}+`;
      const finalReason = check > 0
        ? `score ${bandLabel}`
        : `score ${bandLabel} (configured as pass)`;
      return { check, tier: label, reason: finalReason };
    }
  }
  return { check: 0, tier: 'Pass', reason: 'score below all configured tiers' };
}

// ---------------------------------------------------------------------------
// Round → Kelly parameters (loaded from active lens)
// ---------------------------------------------------------------------------

function roundParams(round) {
  const lensParams = getRoundParams();
  const defaultParams = lensParams.default || { confidence: 'low', time_to_liquidity_years: 7 };
  if (!round) return defaultParams;
  const key = round.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim();
  for (const [k, v] of Object.entries(lensParams.rounds || {})) {
    if (key.includes(k)) return v;
  }
  return defaultParams;
}

// Thesis cluster name → Kelly cluster label (loaded from active lens)
export function thesisToCluster(thesisName) {
  const clusters = getThesisClusters();
  return clusters[thesisName] || 'uncategorized';
}

// ---------------------------------------------------------------------------
// Build bet JSON for the solver
// ---------------------------------------------------------------------------

export function buildBetJson({
  name,
  score,
  round,
  minCheck = null,
  maxCheck = null,
  cluster = 'uncategorized',
  isLateStageApproved = false,
  distributionOverride = null,
  config = null,
}) {
  const cfg = config || loadBetSizingConfig();
  const resolvedMinCheck = minCheck ?? cfg.min_check ?? 0;
  const resolvedMaxCheck = maxCheck ?? cfg.max_check ?? Infinity;
  const band = isLateStageApproved ? '44+' : scoreToBand(score);
  const dist = distributionOverride || getDistributions()[band];
  const { confidence, time_to_liquidity_years } = roundParams(round);

  return {
    name,
    cluster,
    confidence: isLateStageApproved ? 'medium' : confidence,
    time_to_liquidity_years: isLateStageApproved ? 3 : time_to_liquidity_years,
    min_check: resolvedMinCheck,
    max_check: resolvedMaxCheck,
    distribution: {
      outcomes: dist.outcomes,
      probs: dist.probs,
    },
  };
}

// ---------------------------------------------------------------------------
// Build portfolio JSON from DB state + config
// ---------------------------------------------------------------------------

export function buildPortfolioJson(config, dbState) {
  const {
    risk_capital,
    floor,
    annual_budget,
    single_position_cap_pct = 0.05,
    cluster_cap_pct = 0.25,
    illiquid_ceiling_pct = 0.40,
    opportunity_cost_rate = 0.07,
  } = config;

  if (!risk_capital || floor == null) {
    throw new Error(
      'bet-sizing.json is missing risk_capital and/or floor. ' +
      'Edit src/config/bet-sizing.json with your personal risk capital parameters.'
    );
  }

  return {
    risk_capital,
    floor,
    deployed: dbState.ytdDeployed || 0,
    unfunded_commitments: 0,
    cluster_exposures: dbState.clusterExposures || {},
    total_illiquid_pct_of_investable: dbState.illiquidPct || 0,
    single_position_cap_pct,
    cluster_cap_pct,
    illiquid_ceiling_pct,
    opportunity_cost_rate,
    // Annual deployment pace — separate from risk_capital (total at-risk pool).
    // The solver enforces recommendation_high <= annual_budget_remaining when set.
    annual_budget: annual_budget ?? null,
    ytd_deployed_this_year: dbState.ytdDeployedThisYear ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Run the Kelly solver (shells out to Python)
// ---------------------------------------------------------------------------

export function runKelly(betJson, portfolioJson) {
  try {
    const data = runAnalytics('kelly', 'size_bet', { bet: betJson, portfolio: portfolioJson });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

export function loadBetSizingConfig() {
  const configPath = join(__dirname, '../config/bet-sizing.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}
