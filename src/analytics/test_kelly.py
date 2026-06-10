#!/usr/bin/env python3
"""
Standalone tests for the Kelly solver — no framework, pass/fail counters.
Matches the test pattern from src/utils/test-irr.js.

Run:  python3 src/analytics/test_kelly.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure analytics package is importable
_src_dir = str(Path(__file__).resolve().parent.parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from analytics.kelly import (
    solve_kelly,
    expected_log_wealth,
    _validate_distribution,
    size_bet,
    handle_size_bet,
    load_bet,
    load_portfolio,
    Distribution,
    Bet,
    PortfolioState,
    CONFIDENCE_HAIRCUTS,
)

passed = 0
failed = 0


def test(name, actual, expected, tolerance=1e-4):
    global passed, failed
    if isinstance(expected, float):
        if abs(actual - expected) < tolerance:
            print(f"  \u2713 {name}")
            passed += 1
        else:
            print(f"  \u2717 {name}: expected {expected}, got {actual}")
            failed += 1
    elif actual == expected:
        print(f"  \u2713 {name}")
        passed += 1
    else:
        print(f"  \u2717 {name}: expected {expected}, got {actual}")
        failed += 1


def test_raises(name, fn, exc_type=ValueError):
    global passed, failed
    try:
        fn()
        print(f"  \u2717 {name}: expected {exc_type.__name__} but no exception raised")
        failed += 1
    except exc_type:
        print(f"  \u2713 {name}")
        passed += 1
    except Exception as e:
        print(f"  \u2717 {name}: expected {exc_type.__name__} but got {type(e).__name__}: {e}")
        failed += 1


print("\n  solve_kelly tests\n")

# Positive EV: coin flip paying 2x with 60% chance
f = solve_kelly([0.0, 2.0], [0.4, 0.6])
test("positive EV bet (60% chance of 2x)", f > 0, True)
test("positive EV bet fraction reasonable", 0.1 < f < 0.5, True)

# Negative EV: coin flip paying 2x with 30% chance
f = solve_kelly([0.0, 2.0], [0.7, 0.3])
test("negative EV bet returns 0", f, 0.0)

# Zero EV: break-even bet
f = solve_kelly([0.0, 2.0], [0.5, 0.5])
test("zero EV bet returns 0", f, 0.0)

# Strong positive EV
f = solve_kelly([0.0, 10.0], [0.5, 0.5])
test("strong positive EV returns nonzero", f > 0, True)

# All break-even
f = solve_kelly([1.0], [1.0])
test("all break-even returns 0", f, 0.0)


print("\n  _validate_distribution tests\n")

test_raises("mismatched lengths", lambda: _validate_distribution([1.0, 2.0], [0.5]))
test_raises("empty distribution", lambda: _validate_distribution([], []))
test_raises("probs don't sum to 1", lambda: _validate_distribution([1.0, 2.0], [0.3, 0.3]))
test_raises("negative probability", lambda: _validate_distribution([1.0, 2.0], [1.5, -0.5]))

# Valid distribution should not raise
try:
    _validate_distribution([0.0, 1.0, 3.0], [0.5, 0.3, 0.2])
    print("  \u2713 valid distribution does not raise")
    passed += 1
except Exception as e:
    print(f"  \u2717 valid distribution raised: {e}")
    failed += 1


print("\n  confidence haircut tests\n")

demo_dist = Distribution(
    outcomes=[0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
    probs=[0.65, 0.10, 0.05, 0.08, 0.07, 0.04, 0.01],
)
portfolio = PortfolioState(risk_capital=2_000_000, floor=1_200_000)

# Low confidence should produce smaller recommendation than high
bet_low = Bet("test", demo_dist, time_to_liquidity_years=0, confidence="low")
bet_high = Bet("test", demo_dist, time_to_liquidity_years=0, confidence="high")
res_low = size_bet(bet_low, portfolio)
res_high = size_bet(bet_high, portfolio)
test("high confidence > low confidence recommendation",
     res_high.recommendation_high > res_low.recommendation_high, True)

# very_low < low
bet_vlow = Bet("test", demo_dist, time_to_liquidity_years=0, confidence="very_low")
res_vlow = size_bet(bet_vlow, portfolio)
test("very_low < low confidence recommendation",
     res_vlow.recommendation_high < res_low.recommendation_high, True)


print("\n  illiquidity haircut tests\n")

# Longer time = smaller sizing
bet_short = Bet("test", demo_dist, time_to_liquidity_years=2, confidence="low")
bet_long = Bet("test", demo_dist, time_to_liquidity_years=10, confidence="low")
res_short = size_bet(bet_short, portfolio)
res_long = size_bet(bet_long, portfolio)
test("shorter liquidity > longer liquidity",
     res_short.recommendation_high > res_long.recommendation_high, True)

# Zero time = no haircut beyond confidence
bet_zero_t = Bet("test", demo_dist, time_to_liquidity_years=0, confidence="low")
res_zero_t = size_bet(bet_zero_t, portfolio)
kelly_raw = solve_kelly(demo_dist.outcomes, demo_dist.probs)
expected_no_illiq = kelly_raw * CONFIDENCE_HAIRCUTS["low"] * 2_000_000
test("zero time-to-liquidity = confidence haircut only",
     abs(res_zero_t.lenses["illiquidity_adjusted"] - expected_no_illiq) < 1.0, True)


print("\n  binding constraint tests\n")

# Cluster cap binding: put most capital already in the cluster
port_cluster = PortfolioState(
    risk_capital=2_000_000, floor=1_000_000,
    cluster_exposures={"test-cluster": 490_000},
    cluster_cap_pct=0.25,  # 500K cap
)
bet_cluster = Bet("test", demo_dist, time_to_liquidity_years=5, confidence="low", cluster="test-cluster")
res_cluster = size_bet(bet_cluster, port_cluster)
test("cluster cap is binding", res_cluster.binding_constraint, "cluster_cap")

# Ruin constraint binding: floor very close to risk capital
port_ruin = PortfolioState(risk_capital=100_000, floor=99_000)
bet_ruin = Bet("test", demo_dist, time_to_liquidity_years=5, confidence="high")
res_ruin = size_bet(bet_ruin, port_ruin)
test("ruin constraint is binding", res_ruin.binding_constraint, "ruin_constraint")

# Below minimum check
port_normal = PortfolioState(risk_capital=50_000, floor=48_000)
bet_min = Bet("test", demo_dist, time_to_liquidity_years=5, confidence="low", min_check=100_000)
res_min = size_bet(bet_min, port_normal)
test("below minimum check", res_min.binding_constraint, "below_minimum_check")
test("below minimum check recommendation is 0", res_min.recommendation_high, 0.0)


print("\n  handle_size_bet round-trip tests\n")

demo_payload = {
    "bet": {
        "name": "Demo angel check",
        "cluster": "ai-workforce",
        "confidence": "low",
        "time_to_liquidity_years": 8,
        "min_check": 25000,
        "max_check": 250000,
        "distribution": {
            "outcomes": [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
            "probs": [0.65, 0.10, 0.05, 0.08, 0.07, 0.04, 0.01],
        },
    },
    "portfolio": {
        "risk_capital": 2_000_000,
        "floor": 1_200_000,
        "deployed": 400_000,
        "unfunded_commitments": 150_000,
        "cluster_exposures": {"ai-workforce": 200_000},
        "total_illiquid_pct_of_investable": 0.15,
        "investable_assets": 5_000_000,
    },
}

result = handle_size_bet(demo_payload)
test("handle_size_bet returns bet_name", result["bet_name"], "Demo angel check")
test("handle_size_bet has lenses", "lenses" in result, True)
test("handle_size_bet has recommendation_low", "recommendation_low" in result, True)
test("handle_size_bet has recommendation_high", "recommendation_high" in result, True)
test("handle_size_bet has binding_constraint", "binding_constraint" in result, True)
test("handle_size_bet recommendation_low > 0", result["recommendation_low"] > 0, True)
test("handle_size_bet recommendation_high >= recommendation_low",
     result["recommendation_high"] >= result["recommendation_low"], True)

# Verify specific lens keys
expected_lenses = ["naive_kelly_raw", "illiquidity_adjusted", "single_position_cap",
                   "cluster_cap_room", "ruin_constrained_max", "available_capital"]
for lens in expected_lenses:
    test(f"handle_size_bet has lens '{lens}'", lens in result["lenses"], True)


print("\n  negative EV tests\n")

neg_dist = Distribution(outcomes=[0.0, 0.5], probs=[0.8, 0.2])
bet_neg = Bet("neg_ev", neg_dist, time_to_liquidity_years=5, confidence="low")
res_neg = size_bet(bet_neg, portfolio)
test("negative EV binding constraint", res_neg.binding_constraint, "negative_ev")
test("negative EV recommendation is 0", res_neg.recommendation_high, 0.0)
test("negative EV has note", len(res_neg.notes) > 0, True)


print("\n  annual_budget_remaining constraint tests\n")

# Shared distribution — high EV, high confidence, short horizon so the
# illiquidity-adjusted Kelly is well above the $5k budget remainder we're
# testing against. This keeps annual_budget_remaining as the binding cap.
pos_dist = Distribution(outcomes=[0.0, 1.0, 10.0], probs=[0.3, 0.4, 0.3])
bet_annual = Bet(
    "budget_bound", pos_dist,
    time_to_liquidity_years=2, confidence="high",
    max_check=50000,
)

# Case 1: annual_budget unset → existing caps bind; new lens absent.
port_no_budget = PortfolioState(risk_capital=100000, floor=0)
res_no_budget = size_bet(bet_annual, port_no_budget)
test("no annual_budget → lens absent", "annual_budget_remaining" in res_no_budget.lenses, False)
test("no annual_budget → binding not annual_budget_remaining",
     res_no_budget.binding_constraint != "annual_budget_remaining", True)

# Case 2: annual_budget set with $4k remaining → strictly tighter than the
# $5k single_position_cap (5% of $100k), so annual_budget binds.
port_tight = PortfolioState(
    risk_capital=100000, floor=0,
    annual_budget=40000, ytd_deployed_this_year=36000,
)
res_tight = size_bet(bet_annual, port_tight)
test("annual_budget lens present", res_tight.lenses.get("annual_budget_remaining"), 4000.0)
test("annual_budget binds recommendation", res_tight.recommendation_high, 4000.0)
test("annual_budget is binding constraint", res_tight.binding_constraint, "annual_budget_remaining")

# Case 3: check >= 50% of remaining → warning note emitted.
note_text = " ".join(res_tight.notes)
test("annual-pace warning note present", "remaining annual budget" in note_text, True)

# Case 4: annual_budget set but plenty of room → lens present but not binding.
port_loose = PortfolioState(
    risk_capital=100000, floor=0,
    annual_budget=40000, ytd_deployed_this_year=0,
)
res_loose = size_bet(bet_annual, port_loose)
test("annual_budget lens present (loose)", res_loose.lenses.get("annual_budget_remaining"), 40000.0)
test("annual_budget not binding when loose",
     res_loose.binding_constraint != "annual_budget_remaining", True)

# Case 5: ytd >= budget → remaining clamps to 0 (not negative).
port_over = PortfolioState(
    risk_capital=100000, floor=0,
    annual_budget=40000, ytd_deployed_this_year=42000,
)
res_over = size_bet(bet_annual, port_over)
test("annual_budget remaining clamped at 0", res_over.lenses.get("annual_budget_remaining"), 0.0)

# Case 6: load_portfolio passes fields through from dict.
p_loaded = load_portfolio({
    "risk_capital": 100000, "floor": 0,
    "annual_budget": 40000, "ytd_deployed_this_year": 18000,
})
test("load_portfolio carries annual_budget", p_loaded.annual_budget, 40000)
test("load_portfolio carries ytd_deployed_this_year", p_loaded.ytd_deployed_this_year, 18000)
test("annual_budget_remaining() computes correctly", p_loaded.annual_budget_remaining(), 22000.0)


print(f"\n  {passed} passed, {failed} failed\n")
sys.exit(1 if failed > 0 else 0)
