#!/usr/bin/env python3
"""
size_bet.py — CLI interface for Kelly-based position sizing.

Core logic lives in src/analytics/kelly.py. This file is a thin CLI wrapper
that provides demo mode, human-readable formatting, and file-based input.

USAGE

  Library:
      from analytics.kelly import solve_kelly, size_bet, allocate_portfolio

  CLI:
      python -m scripts.size_bet single <bet.json>
      python -m scripts.size_bet portfolio <portfolio.json>
      python -m scripts.size_bet --demo

The JSON schemas are documented at the bottom of this file.

Pure Python — no numpy/scipy required.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Ensure analytics package is importable when running as standalone script
_src_dir = str(Path(__file__).resolve().parent.parent)
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

from analytics.kelly import (  # noqa: E402
    solve_kelly,
    size_bet,
    allocate_portfolio,
    load_bet,
    load_portfolio,
    SizingResult,
    PortfolioState,
)


# ---------------------------------------------------------------------------
# Rendering (CLI-only presentation — not in the analytics package)
# ---------------------------------------------------------------------------

def format_single_result(res: SizingResult) -> str:
    lines = [f"\n=== Sizing: {res.bet_name} ===\n"]
    lines.append(f"Recommendation: ${res.recommendation_low:,.0f} – ${res.recommendation_high:,.0f}")
    lines.append(f"Binding constraint: {res.binding_constraint}\n")
    lines.append("Lenses (in dollars):")
    width = max(len(k) for k in res.lenses)
    for k, v in res.lenses.items():
        lines.append(f"  {k:<{width}}  ${v:>14,.0f}")
    if res.notes:
        lines.append("\nNotes:")
        for n in res.notes:
            lines.append(f"  - {n}")
    return "\n".join(lines) + "\n"


def format_portfolio_result(result: dict, portfolio: PortfolioState) -> str:
    RC = portfolio.risk_capital
    lines = ["\n=== Multi-bet allocation ===\n"]
    lines.append(f"Pool: ${result['pool']:,.0f}")
    lines.append(f"Pool remaining after allocation: ${result['pool_remaining']:,.0f}\n")
    lines.append("Allocations:")
    for name, amt in result["allocations"].items():
        pct = amt / RC * 100 if RC else 0
        binding = result["binding_constraints"].get(name, "")
        standalone = result["standalone_sizing"].get(name, {})
        standalone_high = standalone.get("recommendation_high", 0)
        lines.append(
            f"  {name:<25}  ${amt:>12,.0f}  ({pct:5.2f}% of RC)   "
            f"standalone ceiling: ${standalone_high:,.0f}   binding: {binding}"
        )
    lines.append("\nCluster usage after allocation:")
    for cluster, exposure in result["cluster_usage_after"].items():
        pct = exposure / RC * 100 if RC else 0
        lines.append(f"  {cluster:<25}  ${exposure:>12,.0f}  ({pct:5.2f}% of RC)")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

DEMO_ANGEL = {
    "name": "Demo angel check",
    "cluster": "ai-workforce",
    "confidence": "low",
    "time_to_liquidity_years": 8,
    "min_check": 25_000,
    "max_check": 250_000,
    "distribution": {
        "outcomes": [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
        "probs":    [0.65, 0.10, 0.05, 0.08, 0.07, 0.04, 0.01],
    },
}

DEMO_PORTFOLIO = {
    "risk_capital": 2_000_000,
    "floor": 1_200_000,
    "deployed": 400_000,
    "unfunded_commitments": 150_000,
    "cluster_exposures": {
        "ai-workforce": 200_000,
        "edtech": 100_000,
        "fintech": 100_000,
    },
    "total_illiquid_pct_of_investable": 0.15,
    "investable_assets": 5_000_000,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0

    if argv[1] == "--demo":
        bet = load_bet(DEMO_ANGEL)
        portfolio = load_portfolio(DEMO_PORTFOLIO)
        res = size_bet(bet, portfolio)
        print(format_single_result(res))

        # Also demo portfolio allocation with 3 candidates
        candidates = [
            DEMO_ANGEL,
            {**DEMO_ANGEL, "name": "Demo edtech seed", "cluster": "edtech"},
            {**DEMO_ANGEL, "name": "Demo fintech growth",
             "cluster": "fintech", "confidence": "medium",
             "distribution": {
                 "outcomes": [0.0, 0.5, 1.0, 2.0, 4.0, 8.0],
                 "probs":    [0.35, 0.15, 0.10, 0.20, 0.15, 0.05],
             }},
        ]
        bets = [load_bet(c) for c in candidates]
        portfolio_result = allocate_portfolio(bets, portfolio, pool=300_000)
        print(format_portfolio_result(portfolio_result, portfolio))
        return 0

    if argv[1] == "single":
        use_json = "--json" in argv
        path = argv[3] if use_json else argv[2]
        with open(path) as f:
            payload = json.load(f)
        bet = load_bet(payload["bet"])
        portfolio = load_portfolio(payload["portfolio"])
        res = size_bet(bet, portfolio)
        if use_json:
            print(json.dumps({
                "bet_name": res.bet_name,
                "lenses": res.lenses,
                "recommendation_low": res.recommendation_low,
                "recommendation_high": res.recommendation_high,
                "binding_constraint": res.binding_constraint,
                "notes": res.notes,
            }))
        else:
            print(format_single_result(res))
        return 0

    if argv[1] == "portfolio":
        with open(argv[2]) as f:
            payload = json.load(f)
        bets = [load_bet(b) for b in payload["bets"]]
        portfolio = load_portfolio(payload["portfolio"])
        pool = payload.get("pool")
        result = allocate_portfolio(bets, portfolio, pool=pool)
        print(format_portfolio_result(result, portfolio))
        return 0

    print(f"Unknown command: {argv[1]}")
    print(__doc__)
    return 1


# ---------------------------------------------------------------------------
# JSON schemas (for reference)
# ---------------------------------------------------------------------------

SCHEMA_DOC = """
Single-bet JSON:
{
  "bet": {
    "name": "Company X angel",
    "cluster": "ai-workforce",
    "confidence": "low",               // high | medium | low | very_low
    "time_to_liquidity_years": 8,
    "min_check": 25000,
    "max_check": 250000,
    "worst_case_loss_multiplier": 1.0,  // optional, use >1 for fraud/clawback risk
    "distribution": {
      "outcomes": [0.0, 0.5, 1.0, 3.0, 10.0, 30.0, 100.0],
      "probs":    [0.65, 0.10, 0.05, 0.08, 0.07, 0.04, 0.01]
    }
  },
  "portfolio": {
    "risk_capital": 2000000,
    "floor": 1200000,
    "deployed": 400000,
    "unfunded_commitments": 150000,
    "cluster_exposures": {"ai-workforce": 200000, "edtech": 100000},
    "total_illiquid_pct_of_investable": 0.15,
    "investable_assets": 5000000,
    "single_position_cap_pct": 0.05,
    "cluster_cap_pct": 0.25,
    "illiquid_ceiling_pct": 0.40,
    "opportunity_cost_rate": 0.07
  }
}

Multi-bet JSON:
{
  "bets":      [ ... list of bet objects ... ],
  "portfolio": { ... portfolio object ... },
  "pool":      300000    // optional; defaults to portfolio.available()
}
"""


if __name__ == "__main__":
    sys.exit(main(sys.argv))
