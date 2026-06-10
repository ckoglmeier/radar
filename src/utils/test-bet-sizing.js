#!/usr/bin/env node

// Standalone tests for bet-sizing pipeline — no DB required.
// Tests pure functions: scoreToBand, scoreToTier, thesisToCluster, buildBetJson, buildPortfolioJson.
// Lens loader reads from disk (lenses/ck-conviction-era/).
// Run: node src/utils/test-bet-sizing.js

import { scoreToBand, scoreToTier, thesisToCluster, buildBetJson, buildPortfolioJson, loadBetSizingConfig } from './bet-sizing.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

function approx(actual, expected, tolerance = 0.001) {
  if (Math.abs(actual - expected) > tolerance)
    throw new Error(`expected ~${expected}, got ${actual}`);
}

// ============================================================
//  scoreToBand
// ============================================================

console.log('\n  scoreToBand\n');

test('score 50 → "44+"', () => eq(scoreToBand(50), '44+'));
test('score 44 → "44+"', () => eq(scoreToBand(44), '44+'));
test('score 43 → "39-43"', () => eq(scoreToBand(43), '39-43'));
test('score 39 → "39-43"', () => eq(scoreToBand(39), '39-43'));
test('score 38 → "30-38"', () => eq(scoreToBand(38), '30-38'));
test('score 30 → "30-38"', () => eq(scoreToBand(30), '30-38'));
test('score 29 → "<30"', () => eq(scoreToBand(29), '<30'));
test('score 0 → "<30"', () => eq(scoreToBand(0), '<30'));
test('score 1 → "<30"', () => eq(scoreToBand(1), '<30'));

// Boundary tests
test('exact boundary 44', () => eq(scoreToBand(44), '44+'));
test('exact boundary 39', () => eq(scoreToBand(39), '39-43'));
test('exact boundary 30', () => eq(scoreToBand(30), '30-38'));

// ============================================================
//  scoreToTier
// ============================================================

console.log('\n  scoreToTier\n');

test('score 50 → $10K', () => {
  const t = scoreToTier(50);
  eq(t.check, 10000);
  eq(t.tier, '$10K');
});

test('score 44 → $10K', () => {
  const t = scoreToTier(44);
  eq(t.check, 10000);
});

test('score 43 → $5K', () => {
  const t = scoreToTier(43);
  eq(t.check, 5000);
  eq(t.tier, '$5K');
});

test('score 39 → $5K', () => {
  eq(scoreToTier(39).check, 5000);
});

// 30-38 band retired 2026-04-17 — historically -24% IRR in conviction era.
// Deals in this band map to Pass / Defer, not a $2K check.
test('score 38 → Pass', () => {
  const t = scoreToTier(38);
  eq(t.check, 0);
  eq(t.tier, 'Pass');
});

test('score 30 → Pass', () => {
  eq(scoreToTier(30).check, 0);
  eq(scoreToTier(30).tier, 'Pass');
});

test('score 30-38 pass reason mentions historical band performance', () => {
  const t = scoreToTier(35);
  if (!/30-38|IRR|conviction/i.test(t.reason)) throw new Error(`reason should mention band history: ${t.reason}`);
});

test('score 29 → Pass', () => {
  const t = scoreToTier(29);
  eq(t.check, 0);
  eq(t.tier, 'Pass');
});

test('score 0 → Pass', () => {
  eq(scoreToTier(0).check, 0);
});

// Late-stage approved override
test('late-stage approved: score 30 → $10K', () => {
  const t = scoreToTier(30, true);
  eq(t.check, 10000);
  eq(t.tier, '$10K');
});

test('late-stage approved: score 0 → $10K', () => {
  const t = scoreToTier(0, true);
  eq(t.check, 10000);
});

test('late-stage approved: reason mentions late-stage', () => {
  const t = scoreToTier(30, true);
  if (!t.reason.includes('late-stage')) throw new Error(`reason should mention late-stage: ${t.reason}`);
});

// Reason field present
test('tier includes reason string', () => {
  const t = scoreToTier(42);
  if (typeof t.reason !== 'string' || t.reason.length === 0) throw new Error('missing reason');
});

// ============================================================
//  thesisToCluster
// ============================================================

console.log('\n  thesisToCluster\n');

test('known thesis "AI Infrastructure & Safety" maps to cluster', () => {
  const c = thesisToCluster('AI Infrastructure & Safety');
  if (!c || c === 'uncategorized') throw new Error(`expected a real cluster, got "${c}"`);
});

test('known thesis "Hard Tech That Reprices What\'s Possible" maps to cluster', () => {
  const c = thesisToCluster("Hard Tech That Reprices What's Possible");
  if (!c || c === 'uncategorized') throw new Error(`expected a real cluster, got "${c}"`);
});

test('known thesis "Intelligence for Physical Systems" maps to cluster', () => {
  const c = thesisToCluster('Intelligence for Physical Systems');
  if (!c || c === 'uncategorized') throw new Error(`expected a real cluster, got "${c}"`);
});

test('known thesis "Resilient Systems" maps to cluster', () => {
  const c = thesisToCluster('Resilient Systems');
  if (!c || c === 'uncategorized') throw new Error(`expected a real cluster, got "${c}"`);
});

test('unknown thesis → "uncategorized"', () => {
  eq(thesisToCluster('Blockchain Maximalism'), 'uncategorized');
});

test('null thesis → "uncategorized"', () => {
  eq(thesisToCluster(null), 'uncategorized');
});

test('undefined thesis → "uncategorized"', () => {
  eq(thesisToCluster(undefined), 'uncategorized');
});

test('empty string → "uncategorized"', () => {
  eq(thesisToCluster(''), 'uncategorized');
});

// ============================================================
//  buildBetJson
// ============================================================

console.log('\n  buildBetJson\n');

test('basic bet — has required fields', () => {
  const bet = buildBetJson({ name: 'TestCo', score: 40, round: 'Seed' });
  eq(bet.name, 'TestCo');
  if (!bet.distribution) throw new Error('missing distribution');
  if (!Array.isArray(bet.distribution.outcomes)) throw new Error('missing outcomes');
  if (!Array.isArray(bet.distribution.probs)) throw new Error('missing probs');
  if (typeof bet.confidence !== 'string') throw new Error('missing confidence');
  if (typeof bet.time_to_liquidity_years !== 'number') throw new Error('missing time_to_liquidity');
});

test('score 40 uses 39-43 band distribution', () => {
  const bet = buildBetJson({ name: 'A', score: 40, round: 'Seed' });
  // 39-43 band has 7 outcomes
  eq(bet.distribution.outcomes.length, 7);
  eq(bet.distribution.probs.length, 7);
});

test('score 35 uses 30-38 band distribution', () => {
  const bet = buildBetJson({ name: 'B', score: 35, round: 'Seed' });
  // 30-38 band has 6 outcomes
  eq(bet.distribution.outcomes.length, 6);
});

test('score 45 uses 44+ band distribution', () => {
  const bet = buildBetJson({ name: 'C', score: 45, round: 'Seed' });
  eq(bet.distribution.outcomes.length, 7);
});

test('score 20 uses <30 band distribution', () => {
  const bet = buildBetJson({ name: 'D', score: 20, round: 'Seed' });
  eq(bet.distribution.outcomes.length, 5);
});

test('round "Seed" → confidence low, time ~8y', () => {
  const bet = buildBetJson({ name: 'E', score: 40, round: 'Seed' });
  eq(bet.confidence, 'low');
  eq(bet.time_to_liquidity_years, 8);
});

test('round "Pre-Seed" → confidence very_low, time ~9y', () => {
  const bet = buildBetJson({ name: 'F', score: 40, round: 'Pre-Seed' });
  eq(bet.confidence, 'very_low');
  eq(bet.time_to_liquidity_years, 9);
});

test('round "Series A" → confidence low, time ~6y', () => {
  const bet = buildBetJson({ name: 'G', score: 40, round: 'Series A' });
  eq(bet.confidence, 'low');
  eq(bet.time_to_liquidity_years, 6);
});

test('round "Series C" → confidence medium, time ~3y', () => {
  const bet = buildBetJson({ name: 'H', score: 40, round: 'Series C' });
  eq(bet.confidence, 'medium');
  eq(bet.time_to_liquidity_years, 3);
});

test('round "Secondary" → confidence high, time ~2y', () => {
  const bet = buildBetJson({ name: 'I', score: 40, round: 'Secondary' });
  eq(bet.confidence, 'high');
  eq(bet.time_to_liquidity_years, 2);
});

test('unknown round → default params (low, 7y)', () => {
  const bet = buildBetJson({ name: 'J', score: 40, round: 'Bridge Round' });
  eq(bet.confidence, 'low');
  eq(bet.time_to_liquidity_years, 7);
});

test('null round → default params', () => {
  const bet = buildBetJson({ name: 'K', score: 40, round: null });
  eq(bet.confidence, 'low');
  eq(bet.time_to_liquidity_years, 7);
});

test('minCheck and maxCheck passed through', () => {
  const bet = buildBetJson({ name: 'L', score: 40, round: 'Seed', minCheck: 1000, maxCheck: 5000 });
  eq(bet.min_check, 1000);
  eq(bet.max_check, 5000);
});

test('default minCheck=2000, maxCheck=10000', () => {
  const bet = buildBetJson({ name: 'M', score: 40, round: 'Seed' });
  eq(bet.min_check, 2000);
  eq(bet.max_check, 10000);
});

test('cluster passed through', () => {
  const bet = buildBetJson({ name: 'N', score: 40, round: 'Seed', cluster: 'ai-infra' });
  eq(bet.cluster, 'ai-infra');
});

test('default cluster is "uncategorized"', () => {
  const bet = buildBetJson({ name: 'O', score: 40, round: 'Seed' });
  eq(bet.cluster, 'uncategorized');
});

test('late-stage approved → 44+ distribution band', () => {
  // Score 30 normally gets 30-38 (6 outcomes), but late-stage gets 44+ (7 outcomes)
  const bet = buildBetJson({ name: 'P', score: 30, round: 'Series D', isLateStageApproved: true });
  eq(bet.distribution.outcomes.length, 7);
});

test('late-stage approved → confidence medium', () => {
  const bet = buildBetJson({ name: 'Q', score: 30, round: 'Series D', isLateStageApproved: true });
  eq(bet.confidence, 'medium');
});

test('late-stage approved → time 3y', () => {
  const bet = buildBetJson({ name: 'R', score: 30, round: 'Series D', isLateStageApproved: true });
  eq(bet.time_to_liquidity_years, 3);
});

test('distribution override replaces lens distribution', () => {
  const custom = { outcomes: [0, 1, 5], probs: [0.5, 0.3, 0.2] };
  const bet = buildBetJson({ name: 'S', score: 40, round: 'Seed', distributionOverride: custom });
  eq(bet.distribution.outcomes, [0, 1, 5]);
  eq(bet.distribution.probs, [0.5, 0.3, 0.2]);
});

test('probs sum to ~1.0 for each band', () => {
  for (const score of [20, 35, 40, 45]) {
    const bet = buildBetJson({ name: 'test', score, round: 'Seed' });
    const sum = bet.distribution.probs.reduce((a, b) => a + b, 0);
    approx(sum, 1.0, 0.01);
  }
});

// ============================================================
//  buildPortfolioJson
// ============================================================

console.log('\n  buildPortfolioJson\n');

test('basic portfolio — has required fields', () => {
  const p = buildPortfolioJson(
    { risk_capital: 100000, floor: 60000 },
    { ytdDeployed: 5000, clusterExposures: {}, illiquidPct: 0.1 }
  );
  eq(p.risk_capital, 100000);
  eq(p.floor, 60000);
  eq(p.deployed, 5000);
  eq(p.total_illiquid_pct_of_investable, 0.1);
});

test('missing risk_capital throws', () => {
  let threw = false;
  try {
    buildPortfolioJson({ floor: 60000 }, {});
  } catch (e) {
    threw = true;
    if (!e.message.includes('risk_capital')) throw new Error(`wrong error: ${e.message}`);
  }
  if (!threw) throw new Error('should throw when risk_capital missing');
});

test('missing floor throws', () => {
  let threw = false;
  try {
    buildPortfolioJson({ risk_capital: 100000 }, {});
  } catch (e) {
    threw = true;
    if (!e.message.includes('floor')) throw new Error(`wrong error: ${e.message}`);
  }
  if (!threw) throw new Error('should throw when floor missing');
});

test('floor=0 is valid (does not throw)', () => {
  const p = buildPortfolioJson(
    { risk_capital: 100000, floor: 0 },
    {}
  );
  eq(p.floor, 0);
});

test('defaults for missing dbState fields', () => {
  const p = buildPortfolioJson({ risk_capital: 50000, floor: 30000 }, {});
  eq(p.deployed, 0);
  eq(p.unfunded_commitments, 0);
  eq(typeof p.cluster_exposures, 'object');
  eq(p.total_illiquid_pct_of_investable, 0);
});

test('default config overrides', () => {
  const p = buildPortfolioJson({ risk_capital: 50000, floor: 30000 }, {});
  eq(p.single_position_cap_pct, 0.05);
  eq(p.cluster_cap_pct, 0.25);
  eq(p.illiquid_ceiling_pct, 0.40);
  eq(p.opportunity_cost_rate, 0.07);
});

test('custom cap overrides', () => {
  const p = buildPortfolioJson(
    { risk_capital: 50000, floor: 30000, single_position_cap_pct: 0.10, cluster_cap_pct: 0.30 },
    {}
  );
  eq(p.single_position_cap_pct, 0.10);
  eq(p.cluster_cap_pct, 0.30);
});

test('cluster exposures passed through', () => {
  const exposures = { 'ai-infra': 15000, 'hard-tech': 8000 };
  const p = buildPortfolioJson(
    { risk_capital: 100000, floor: 60000 },
    { clusterExposures: exposures }
  );
  eq(p.cluster_exposures['ai-infra'], 15000);
  eq(p.cluster_exposures['hard-tech'], 8000);
});

test('annual_budget and ytd_deployed_this_year passed through', () => {
  const p = buildPortfolioJson(
    { risk_capital: 100000, floor: 60000, annual_budget: 40000 },
    { ytdDeployedThisYear: 18000 }
  );
  eq(p.annual_budget, 40000);
  eq(p.ytd_deployed_this_year, 18000);
});

test('annual_budget defaults to null when unset in config', () => {
  const p = buildPortfolioJson({ risk_capital: 100000, floor: 60000 }, {});
  eq(p.annual_budget, null);
  eq(p.ytd_deployed_this_year, 0);
});

// ============================================================
//  loadBetSizingConfig
// ============================================================

console.log('\n  loadBetSizingConfig\n');

test('returns an object (may be empty if no config file)', () => {
  const config = loadBetSizingConfig();
  if (typeof config !== 'object' || config === null) throw new Error('expected object');
});

// ============================================================
//  Integration: score → band → distribution → bet JSON
// ============================================================

console.log('\n  Integration: full pipeline\n');

test('score 42, Seed → complete bet JSON for Kelly', () => {
  const bet = buildBetJson({
    name: 'Integration Test Co',
    score: 42,
    round: 'Seed',
    cluster: 'ai-infra',
  });
  eq(bet.name, 'Integration Test Co');
  eq(bet.cluster, 'ai-infra');
  eq(bet.confidence, 'low');
  eq(bet.time_to_liquidity_years, 8);
  eq(bet.min_check, 2000);
  eq(bet.max_check, 10000);
  // 39-43 band
  eq(bet.distribution.outcomes.length, 7);
  approx(bet.distribution.probs.reduce((a, b) => a + b, 0), 1.0, 0.01);
});

test('score 32, Pre-Seed → Pass tier (30-38 retired)', () => {
  const tier = scoreToTier(32);
  const bet = buildBetJson({ name: 'Early Co', score: 32, round: 'Pre-Seed' });
  eq(tier.check, 0);
  eq(tier.tier, 'Pass');
  eq(bet.confidence, 'very_low');
  eq(bet.time_to_liquidity_years, 9);
});

// --- Summary ---

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
