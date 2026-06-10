"""
kelly.py — Kelly-based position sizing for private markets investing.

Core math, dataclasses, and sizing logic extracted from src/scripts/size_bet.py.
This module is pure computation — no CLI, no formatting, no I/O.

Dispatcher entry points:
    handle_size_bet(data)              -> dict (SizingResult)
    handle_allocate_portfolio(data)    -> dict (allocation result)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Optional


# ---------------------------------------------------------------------------
# Core math: multi-outcome Kelly solver
# ---------------------------------------------------------------------------

def expected_log_wealth(f: float, outcomes: list[float], probs: list[float]) -> float:
    """Expected log wealth from betting fraction f on a distribution.

    outcomes: gross multiples (0.0 = total loss, 1.0 = break even, 3.0 = 3x).
              Values < 0 are allowed for fraud/structural loss (e.g., -0.5 = lose 150%).
    probs:    probabilities, must sum to 1.
    """
    total = 0.0
    for p, m in zip(probs, outcomes):
        r = m - 1.0  # net return
        val = 1.0 + f * r
        if val <= 0:
            return float("-inf")
        total += p * math.log(val)
    return total


def solve_kelly(
    outcomes: list[float],
    probs: list[float],
    f_min: float = 0.0,
    f_max: float = 0.999,
) -> float:
    """Solve multi-outcome Kelly: argmax over f of E[log(1 + f*r)].

    Uses golden-section-style bracketing followed by refinement. No scipy needed.
    Returns f* as a fraction of bankroll (0.0 to ~1.0).
    """
    _validate_distribution(outcomes, probs)

    # Short-circuit: if EV of net return is <= 0, Kelly says bet nothing
    ev_net = sum(p * (m - 1.0) for p, m in zip(probs, outcomes))
    if ev_net <= 0:
        return 0.0

    # Coarse grid search
    best_f, best_v = 0.0, expected_log_wealth(0.0, outcomes, probs)
    n_coarse = 2000
    for i in range(1, n_coarse):
        f = f_min + (f_max - f_min) * i / n_coarse
        v = expected_log_wealth(f, outcomes, probs)
        if v > best_v:
            best_v, best_f = v, f

    # Fine refinement around best
    span = (f_max - f_min) / n_coarse
    for i in range(-500, 501):
        f = best_f + span * i / 500
        if f_min <= f <= f_max:
            v = expected_log_wealth(f, outcomes, probs)
            if v > best_v:
                best_v, best_f = v, f

    return max(0.0, best_f)


def _validate_distribution(outcomes: list[float], probs: list[float]) -> None:
    if len(outcomes) != len(probs):
        raise ValueError("outcomes and probs must be the same length")
    if not outcomes:
        raise ValueError("distribution must have at least one outcome")
    s = sum(probs)
    if abs(s - 1.0) > 1e-6:
        raise ValueError(f"probabilities must sum to 1.0 (got {s:.4f})")
    for p in probs:
        if p < 0:
            raise ValueError("probabilities must be non-negative")


# ---------------------------------------------------------------------------
# Input/output types
# ---------------------------------------------------------------------------

CONFIDENCE_HAIRCUTS = {
    "high":       0.50,   # priced secondary with observable NAV/comps
    "medium":     0.33,   # Series B+ with real revenue
    "low":        0.25,   # seed, mostly thesis + founder conviction
    "very_low":   0.18,   # pre-seed, deck-level
}


@dataclass
class Distribution:
    """Payoff distribution as gross multiples + probabilities."""
    outcomes: list[float]
    probs: list[float]

    def ev(self) -> float:
        return sum(p * m for p, m in zip(self.probs, self.outcomes))

    def ev_net(self) -> float:
        return self.ev() - 1.0


@dataclass
class Bet:
    name: str
    distribution: Distribution
    time_to_liquidity_years: float
    confidence: str = "low"               # high / medium / low / very_low
    cluster: str = "uncategorized"
    min_check: float = 0.0                # minimum viable check ($)
    max_check: float = float("inf")       # maximum sensible check ($)
    worst_case_loss_multiplier: float = 1.0  # fraction of check lost in bad case (1.0 = total loss)


@dataclass
class PortfolioState:
    risk_capital: float                        # total risk capital ($)
    floor: float                               # hard bankroll floor ($)
    deployed: float = 0.0                      # already-called capital ($)
    unfunded_commitments: float = 0.0          # capital committed but not called
    cluster_exposures: dict[str, float] = field(default_factory=dict)  # $ deployed by cluster
    total_illiquid_pct_of_investable: float = 0.0  # current illiquid % (0.0-1.0)

    # Caps
    single_position_cap_pct: float = 0.05      # 5% of risk capital
    cluster_cap_pct: float = 0.25              # 25% of risk capital per cluster
    illiquid_ceiling_pct: float = 0.40         # 40% of investable assets
    investable_assets: Optional[float] = None  # total investable (for illiquid ceiling); defaults to risk_capital
    opportunity_cost_rate: float = 0.07        # lambda for illiquidity haircut

    # Annual deployment pace — separate from risk_capital (total at-risk pool).
    # If annual_budget is set, the solver caps recommendation_high at
    # (annual_budget - ytd_deployed_this_year). None disables the constraint.
    annual_budget: Optional[float] = None
    ytd_deployed_this_year: float = 0.0

    def available(self) -> float:
        return self.risk_capital - self.deployed - self.unfunded_commitments

    def annual_budget_remaining(self) -> Optional[float]:
        if self.annual_budget is None:
            return None
        return max(0.0, self.annual_budget - self.ytd_deployed_this_year)

    def ruin_max_dollars(self, worst_case_loss_multiplier: float = 1.0) -> float:
        """Largest check such that, if it goes to zero (or worst case),
        the bankroll still clears the floor."""
        headroom = self.risk_capital - self.floor
        return max(0.0, headroom / max(worst_case_loss_multiplier, 1e-9))

    def cluster_room_dollars(self, cluster: str) -> float:
        cap = self.cluster_cap_pct * self.risk_capital
        current = self.cluster_exposures.get(cluster, 0.0)
        return max(0.0, cap - current)

    def single_position_cap_dollars(self) -> float:
        return self.single_position_cap_pct * self.risk_capital

    def illiquid_ceiling_room_dollars(self) -> float:
        inv = self.investable_assets or self.risk_capital
        cap = self.illiquid_ceiling_pct * inv
        current = self.total_illiquid_pct_of_investable * inv
        return max(0.0, cap - current)


@dataclass
class SizingResult:
    bet_name: str
    lenses: dict[str, float]              # lens name -> dollars
    recommendation_low: float
    recommendation_high: float
    binding_constraint: str
    notes: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Single-bet sizing
# ---------------------------------------------------------------------------

def size_bet(bet: Bet, portfolio: PortfolioState) -> SizingResult:
    """Run the full adjusted Kelly recipe and return all lenses + recommendation.

    Every dollar figure is computed against portfolio.risk_capital.
    """
    notes: list[str] = []

    # Step 1: raw multi-outcome Kelly (as fraction of risk capital)
    f_raw = solve_kelly(bet.distribution.outcomes, bet.distribution.probs)

    # Step 2: confidence haircut
    k = CONFIDENCE_HAIRCUTS.get(bet.confidence, 0.25)
    f_confidence = f_raw * k

    # Step 3: illiquidity haircut (time-value of locked capital)
    T = max(0.0, bet.time_to_liquidity_years)
    lam = portfolio.opportunity_cost_rate
    f_illiquid = f_confidence / (1.0 + lam * T)

    # Convert to dollars
    RC = portfolio.risk_capital
    dollars = {
        "naive_kelly_raw":          f_raw * RC,
        "fractional_kelly_quarter": f_raw * 0.25 * RC,
        "fractional_kelly_half":    f_raw * 0.50 * RC,
        f"confidence_kelly_{bet.confidence}": f_confidence * RC,
        "illiquidity_adjusted":     f_illiquid * RC,
        "single_position_cap":      portfolio.single_position_cap_dollars(),
        "cluster_cap_room":         portfolio.cluster_room_dollars(bet.cluster),
        "ruin_constrained_max":     portfolio.ruin_max_dollars(bet.worst_case_loss_multiplier),
        "illiquid_ceiling_room":    portfolio.illiquid_ceiling_room_dollars(),
        "available_capital":        portfolio.available(),
        "max_check":                bet.max_check if bet.max_check != float("inf") else RC,
    }
    annual_remaining = portfolio.annual_budget_remaining()
    if annual_remaining is not None:
        dollars["annual_budget_remaining"] = annual_remaining

    # Binding constraint: minimum of all active caps
    active_caps = {
        "illiquidity_adjusted_fractional_kelly": dollars["illiquidity_adjusted"],
        "single_position_cap":  dollars["single_position_cap"],
        "cluster_cap":          dollars["cluster_cap_room"],
        "ruin_constraint":      dollars["ruin_constrained_max"],
        "illiquid_ceiling":     dollars["illiquid_ceiling_room"],
        "available_capital":    dollars["available_capital"],
        "max_check":            dollars["max_check"],
    }
    if annual_remaining is not None:
        active_caps["annual_budget_remaining"] = annual_remaining
    binding_name = min(active_caps, key=active_caps.get)
    binding_value = active_caps[binding_name]

    # Recommendation range: 75% to 100% of the binding cap (with fractional-Kelly ceiling).
    # If binding is already fractional Kelly, the range is [quarter Kelly, binding].
    rec_high = max(0.0, binding_value)
    if binding_name == "illiquidity_adjusted_fractional_kelly":
        rec_low = max(0.0, rec_high * 0.75)
    else:
        rec_low = max(0.0, min(dollars["illiquidity_adjusted"], rec_high))
        if rec_low > rec_high:
            rec_low = rec_high

    # Guards
    if rec_high < bet.min_check:
        notes.append(
            f"Binding constraint ({binding_name}) produces a size "
            f"(${rec_high:,.0f}) below the minimum viable check "
            f"(${bet.min_check:,.0f}). Recommendation: pass or renegotiate terms."
        )
        rec_low = 0.0
        rec_high = 0.0
        binding_name = "below_minimum_check"

    if bet.distribution.ev_net() <= 0:
        notes.append("Distribution has non-positive expected net return — Kelly says bet zero.")
        rec_low = 0.0
        rec_high = 0.0
        binding_name = "negative_ev"

    # Annual-pace warning: surface when a single deal consumes half or more
    # of the remaining annual deployment budget.
    if annual_remaining is not None and annual_remaining > 0 and rec_high >= 0.5 * annual_remaining:
        pct = 100.0 * rec_high / annual_remaining
        notes.append(
            f"This check is {pct:.0f}% of the remaining annual budget "
            f"(${rec_high:,.0f} of ${annual_remaining:,.0f})."
        )

    return SizingResult(
        bet_name=bet.name,
        lenses=dollars,
        recommendation_low=rec_low,
        recommendation_high=rec_high,
        binding_constraint=binding_name,
        notes=notes,
    )


# ---------------------------------------------------------------------------
# Multi-bet portfolio allocation
# ---------------------------------------------------------------------------

def allocate_portfolio(
    bets: list[Bet],
    portfolio: PortfolioState,
    pool: Optional[float] = None,
    step_pct: float = 0.001,   # 0.1% of risk capital per fill increment
) -> dict:
    """Greedy allocation across candidate bets by marginal expected log wealth per dollar.

    Respects every cap in the PortfolioState: ruin, cluster, single-position,
    illiquid ceiling, and pool.

    Correlation is handled through cluster caps -- bets in the same cluster
    consume shared room. That's the operationally meaningful version; fully
    joint log-wealth optimization across a correlation matrix is left for a
    future version.

    Returns a dict with allocations, binding constraints per bet, and bets
    that were crowded out.
    """
    if pool is None:
        pool = portfolio.available()

    # Per-bet ceilings from single-bet sizing (before pool allocation)
    per_bet_ceilings: dict[str, float] = {}
    per_bet_results: dict[str, SizingResult] = {}
    for bet in bets:
        res = size_bet(bet, portfolio)
        per_bet_results[bet.name] = res
        per_bet_ceilings[bet.name] = res.recommendation_high

    # Running state
    allocations = {bet.name: 0.0 for bet in bets}
    cluster_used: dict[str, float] = dict(portfolio.cluster_exposures)
    pool_remaining = pool
    illiquid_room = portfolio.illiquid_ceiling_room_dollars()
    single_cap = portfolio.single_position_cap_dollars()
    ruin_max_by_bet = {
        b.name: portfolio.ruin_max_dollars(b.worst_case_loss_multiplier) for b in bets
    }

    step = step_pct * portfolio.risk_capital  # dollar increment per fill

    def marginal_log_wealth_per_dollar(bet: Bet, current_allocation: float) -> float:
        """Marginal E[log(1 + f*r)] per dollar at the current fraction."""
        f_now = current_allocation / portfolio.risk_capital
        f_next = f_now + step / portfolio.risk_capital
        if f_next >= 0.999:
            return float("-inf")
        v_now = expected_log_wealth(f_now, bet.distribution.outcomes, bet.distribution.probs)
        v_next = expected_log_wealth(f_next, bet.distribution.outcomes, bet.distribution.probs)
        if v_next == float("-inf") or v_now == float("-inf"):
            return float("-inf")
        return (v_next - v_now) / step

    binding_by_bet: dict[str, str] = {}

    while pool_remaining >= step and illiquid_room >= step:
        # Pick the bet with the highest marginal contribution that can still be filled
        best_bet = None
        best_marginal = -float("inf")
        for bet in bets:
            if allocations[bet.name] + step > per_bet_ceilings[bet.name]:
                binding_by_bet.setdefault(bet.name, "per_bet_ceiling")
                continue
            if allocations[bet.name] + step > single_cap:
                binding_by_bet.setdefault(bet.name, "single_position_cap")
                continue
            if allocations[bet.name] + step > ruin_max_by_bet[bet.name]:
                binding_by_bet.setdefault(bet.name, "ruin_constraint")
                continue
            cluster_after = cluster_used.get(bet.cluster, 0.0) + step
            cluster_cap = portfolio.cluster_cap_pct * portfolio.risk_capital
            if cluster_after > cluster_cap:
                binding_by_bet.setdefault(bet.name, "cluster_cap")
                continue
            marginal = marginal_log_wealth_per_dollar(bet, allocations[bet.name])
            if marginal > best_marginal:
                best_marginal = marginal
                best_bet = bet

        if best_bet is None or best_marginal <= 0:
            break  # nothing more to do productively

        # Fill
        allocations[best_bet.name] += step
        cluster_used[best_bet.cluster] = cluster_used.get(best_bet.cluster, 0.0) + step
        pool_remaining -= step
        illiquid_room -= step

    # Determine binding constraint for each bet at the final allocation
    for bet in bets:
        if allocations[bet.name] == 0:
            binding_by_bet.setdefault(bet.name, "crowded_out_or_negative_marginal")
        elif pool_remaining < step:
            binding_by_bet.setdefault(bet.name, "pool_exhausted")
        else:
            binding_by_bet.setdefault(bet.name, "marginal_log_wealth_zero")

    # Drop tiny allocations below the minimum check
    for bet in bets:
        if 0 < allocations[bet.name] < bet.min_check:
            binding_by_bet[bet.name] = "below_min_check_after_allocation"
            pool_remaining += allocations[bet.name]
            cluster_used[bet.cluster] -= allocations[bet.name]
            allocations[bet.name] = 0.0

    return {
        "pool": pool,
        "pool_remaining": pool_remaining,
        "allocations": allocations,
        "binding_constraints": binding_by_bet,
        "standalone_sizing": {
            name: {
                "recommendation_low": r.recommendation_low,
                "recommendation_high": r.recommendation_high,
                "binding_constraint": r.binding_constraint,
            }
            for name, r in per_bet_results.items()
        },
        "cluster_usage_after": cluster_used,
    }


# ---------------------------------------------------------------------------
# JSON loading helpers
# ---------------------------------------------------------------------------

def load_bet(d: dict) -> Bet:
    return Bet(
        name=d["name"],
        distribution=Distribution(
            outcomes=d["distribution"]["outcomes"],
            probs=d["distribution"]["probs"],
        ),
        time_to_liquidity_years=d.get("time_to_liquidity_years", 8),
        confidence=d.get("confidence", "low"),
        cluster=d.get("cluster", "uncategorized"),
        min_check=d.get("min_check", 0),
        max_check=d.get("max_check", float("inf")),
        worst_case_loss_multiplier=d.get("worst_case_loss_multiplier", 1.0),
    )


def load_portfolio(d: dict) -> PortfolioState:
    return PortfolioState(
        risk_capital=d["risk_capital"],
        floor=d["floor"],
        deployed=d.get("deployed", 0),
        unfunded_commitments=d.get("unfunded_commitments", 0),
        cluster_exposures=d.get("cluster_exposures", {}),
        total_illiquid_pct_of_investable=d.get("total_illiquid_pct_of_investable", 0.0),
        single_position_cap_pct=d.get("single_position_cap_pct", 0.05),
        cluster_cap_pct=d.get("cluster_cap_pct", 0.25),
        illiquid_ceiling_pct=d.get("illiquid_ceiling_pct", 0.40),
        investable_assets=d.get("investable_assets"),
        opportunity_cost_rate=d.get("opportunity_cost_rate", 0.07),
        annual_budget=d.get("annual_budget"),
        ytd_deployed_this_year=d.get("ytd_deployed_this_year", 0.0),
    )


# ---------------------------------------------------------------------------
# Dispatcher entry points (called by __main__.py)
# ---------------------------------------------------------------------------

def handle_size_bet(data: dict) -> dict:
    """Size a single bet. Input: {"bet": {...}, "portfolio": {...}}"""
    bet = load_bet(data["bet"])
    portfolio = load_portfolio(data["portfolio"])
    res = size_bet(bet, portfolio)
    return {
        "bet_name": res.bet_name,
        "lenses": res.lenses,
        "recommendation_low": res.recommendation_low,
        "recommendation_high": res.recommendation_high,
        "binding_constraint": res.binding_constraint,
        "notes": res.notes,
    }


def handle_allocate_portfolio(data: dict) -> dict:
    """Allocate across multiple bets. Input: {"bets": [...], "portfolio": {...}, "pool": ...}"""
    bets = [load_bet(b) for b in data["bets"]]
    portfolio = load_portfolio(data["portfolio"])
    pool = data.get("pool")
    return allocate_portfolio(bets, portfolio, pool=pool)
