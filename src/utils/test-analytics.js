/**
 * Standalone tests for the JS analytics bridge.
 * Matches the test pattern from test-irr.js — no framework.
 *
 * Run:  node src/utils/test-analytics.js
 */

import { runAnalytics } from './analytics.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, msg = 'assertion failed') {
  if (!condition) throw new Error(msg);
}

const demoPayload = {
  bet: {
    name: 'Demo angel check',
    cluster: 'ai-workforce',
    confidence: 'low',
    time_to_liquidity_years: 8,
    min_check: 25000,
    max_check: 250000,
    distribution: {
      outcomes: [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
      probs: [0.65, 0.10, 0.05, 0.08, 0.07, 0.04, 0.01],
    },
  },
  portfolio: {
    risk_capital: 2000000,
    floor: 1200000,
    deployed: 400000,
    unfunded_commitments: 150000,
    cluster_exposures: { 'ai-workforce': 200000 },
    total_illiquid_pct_of_investable: 0.15,
    investable_assets: 5000000,
  },
};

console.log('\n  runAnalytics round-trip tests\n');

test('kelly size_bet returns valid result', () => {
  const result = runAnalytics('kelly', 'size_bet', demoPayload);
  assert(result.bet_name === 'Demo angel check', `bet_name: ${result.bet_name}`);
  assert(typeof result.lenses === 'object', 'lenses is object');
  assert(result.recommendation_high > 0, `recommendation_high: ${result.recommendation_high}`);
  assert(result.recommendation_low > 0, `recommendation_low: ${result.recommendation_low}`);
  assert(typeof result.binding_constraint === 'string', 'binding_constraint is string');
});

test('kelly size_bet lenses has expected keys', () => {
  const result = runAnalytics('kelly', 'size_bet', demoPayload);
  const expected = ['naive_kelly_raw', 'illiquidity_adjusted', 'single_position_cap',
    'cluster_cap_room', 'ruin_constrained_max', 'available_capital'];
  for (const key of expected) {
    assert(key in result.lenses, `missing lens: ${key}`);
    assert(typeof result.lenses[key] === 'number', `lens ${key} is not a number`);
  }
});

test('kelly allocate_portfolio returns valid result', () => {
  const result = runAnalytics('kelly', 'allocate_portfolio', {
    bets: [demoPayload.bet],
    portfolio: demoPayload.portfolio,
    pool: 100000,
  });
  assert(typeof result.allocations === 'object', 'allocations is object');
  assert(typeof result.pool === 'number', 'pool is number');
  assert(typeof result.pool_remaining === 'number', 'pool_remaining is number');
});

console.log('\n  runAnalytics error handling tests\n');

test('unknown module throws', () => {
  let threw = false;
  try {
    runAnalytics('nonexistent', 'foo', {});
  } catch (err) {
    threw = true;
    assert(err.message.includes('nonexistent'), `error message: ${err.message}`);
  }
  assert(threw, 'should have thrown');
});

test('unknown method throws', () => {
  let threw = false;
  try {
    runAnalytics('kelly', 'nonexistent_method', {});
  } catch (err) {
    threw = true;
    assert(err.message.includes('nonexistent_method'), `error message: ${err.message}`);
  }
  assert(threw, 'should have thrown');
});

test('invalid data throws', () => {
  let threw = false;
  try {
    runAnalytics('kelly', 'size_bet', { bad: 'data' });
  } catch (err) {
    threw = true;
    // Should get a Python KeyError or similar
    assert(err.message.includes('Analytics error'), `error message: ${err.message}`);
  }
  assert(threw, 'should have thrown');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
