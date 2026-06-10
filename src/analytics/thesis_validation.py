"""
thesis_validation.py — Score-to-outcome correlation and thesis discovery.

Two dispatcher entry points:
    handle_validate(data)  — does the rubric predict returns?
    handle_discover(data)  — are the current thesis clusters optimal?
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime


# ---------------------------------------------------------------------------
# Score bands (must match src/utils/bet-sizing.js)
# ---------------------------------------------------------------------------

BANDS = [
    ('<30', lambda s: s < 30),
    ('30-38', lambda s: 30 <= s < 39),
    ('39-43', lambda s: 39 <= s < 44),
    ('44+', lambda s: s >= 44),
]


def _band_for_score(score: float) -> str:
    for name, test in BANDS:
        if test(score):
            return name
    return '<30'


# ---------------------------------------------------------------------------
# Stats helpers (pure Python, no numpy)
# ---------------------------------------------------------------------------

def _mean(xs: list[float]) -> float | None:
    if not xs:
        return None
    return sum(xs) / len(xs)


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2


def _stddev(xs: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _spearman_rank_correlation(xs: list[float], ys: list[float]) -> float | None:
    """Spearman rank correlation coefficient between two equal-length lists."""
    n = len(xs)
    if n < 3:
        return None

    def _rank(vals):
        indexed = sorted(enumerate(vals), key=lambda t: t[1])
        ranks = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j < n - 1 and indexed[j + 1][1] == indexed[j][1]:
                j += 1
            avg_rank = (i + j) / 2.0 + 1.0  # 1-based
            for k in range(i, j + 1):
                ranks[indexed[k][0]] = avg_rank
            i = j + 1
        return ranks

    rx = _rank(xs)
    ry = _rank(ys)

    d_sq_sum = sum((a - b) ** 2 for a, b in zip(rx, ry))
    return 1.0 - (6.0 * d_sq_sum) / (n * (n ** 2 - 1))


def _win_rate(multiples: list[float], threshold: float = 1.0) -> float | None:
    """Fraction of multiples above threshold."""
    if not multiples:
        return None
    return sum(1 for m in multiples if m > threshold) / len(multiples)


# ---------------------------------------------------------------------------
# Core analysis
# ---------------------------------------------------------------------------

def _analyze(deals: list[dict]) -> dict:
    """Run the full thesis validation analysis."""

    # Filter to deals with both score and multiple
    scored = [d for d in deals if d.get('score') is not None and d.get('multiple') is not None]

    if len(scored) < 5:
        return {
            "error": f"Not enough data for analysis ({len(scored)} deals with both score and multiple, need >= 5)",
            "n": len(scored),
        }

    scores = [d['score'] for d in scored]
    multiples = [d['multiple'] for d in scored]

    # --- 1. Overall correlation ---
    spearman = _spearman_rank_correlation(scores, multiples)

    # Also correlate with IRR where available
    irr_deals = [d for d in scored if d.get('irr') is not None]
    irr_spearman = None
    if len(irr_deals) >= 5:
        irr_spearman = _spearman_rank_correlation(
            [d['score'] for d in irr_deals],
            [d['irr'] for d in irr_deals],
        )

    # --- 2. Per-band performance ---
    by_band = {}
    for band_name, _ in BANDS:
        band_deals = [d for d in scored if _band_for_score(d['score']) == band_name]
        band_multiples = [d['multiple'] for d in band_deals]
        band_irrs = [d['irr'] for d in band_deals if d.get('irr') is not None]

        by_band[band_name] = {
            'n': len(band_deals),
            'mean_multiple': _round(_mean(band_multiples)),
            'median_multiple': _round(_median(band_multiples)),
            'stddev_multiple': _round(_stddev(band_multiples)),
            'win_rate': _round(_win_rate(band_multiples)),  # % > 1.0x
            'big_winner_rate': _round(_win_rate(band_multiples, 3.0)),  # % > 3.0x
            'mean_irr': _round(_mean(band_irrs)),
            'n_irr': len(band_irrs),
        }

    # --- 3. Calibration: is the rubric monotonically predictive? ---
    band_order = ['<30', '30-38', '39-43', '44+']
    band_means = [by_band[b]['mean_multiple'] for b in band_order if by_band[b]['mean_multiple'] is not None]
    monotonic = all(a <= b for a, b in zip(band_means, band_means[1:])) if len(band_means) >= 2 else None

    # Invested vs passed: do invested deals actually score higher?
    invested_scores = [d['score'] for d in deals if d.get('invested')]
    passed_scores = [d['score'] for d in deals if not d.get('invested') and d.get('score') is not None]

    selectivity = {
        'invested_mean_score': _round(_mean(invested_scores)),
        'invested_median_score': _round(_median(invested_scores)),
        'passed_mean_score': _round(_mean(passed_scores)),
        'passed_median_score': _round(_median(passed_scores)),
        'invested_count': len(invested_scores),
        'passed_count': len(passed_scores),
    }

    # --- 4. Misses: where the rubric got it wrong ---
    # High score + bad outcome
    overrated = [
        {
            'company': d['company'],
            'score': d['score'],
            'multiple': d['multiple'],
            'status': d['status'],
            'verdict': d.get('verdict'),
        }
        for d in scored
        if d['score'] >= 35 and d['multiple'] is not None and d['multiple'] < 0.5
    ]
    overrated.sort(key=lambda d: d['score'], reverse=True)

    # Low score + great outcome
    underrated = [
        {
            'company': d['company'],
            'score': d['score'],
            'multiple': d['multiple'],
            'status': d['status'],
            'verdict': d.get('verdict'),
        }
        for d in scored
        if d['score'] < 30 and d['multiple'] is not None and d['multiple'] > 1.5
    ]
    underrated.sort(key=lambda d: d['multiple'], reverse=True)

    # --- 5. Summary verdict ---
    verdict_parts = []
    if spearman is not None:
        if spearman > 0.3:
            verdict_parts.append(f"Positive correlation (ρ={spearman:.2f}) — rubric has signal")
        elif spearman > 0.1:
            verdict_parts.append(f"Weak positive correlation (ρ={spearman:.2f}) — marginal signal")
        elif spearman > -0.1:
            verdict_parts.append(f"No meaningful correlation (ρ={spearman:.2f}) — rubric is not predictive")
        else:
            verdict_parts.append(f"Negative correlation (ρ={spearman:.2f}) — rubric may be counterproductive")

    if monotonic:
        verdict_parts.append("Band means are monotonically increasing — higher scores → higher returns")
    elif monotonic is False:
        verdict_parts.append("Band means are NOT monotonic — score bands don't map cleanly to outcomes")

    if overrated:
        verdict_parts.append(f"{len(overrated)} overrated deals (score ≥35 but <0.5x)")
    if underrated:
        verdict_parts.append(f"{len(underrated)} underrated deals (score <30 but >1.5x)")

    # --- 6. CFO verdict calibration ---
    cfo_calibration = _cfo_calibrate(deals)

    return {
        'n': len(scored),
        'n_total': len(deals),
        'correlation': {
            'spearman_score_vs_multiple': _round(spearman),
            'spearman_score_vs_irr': _round(irr_spearman),
            'n_with_irr': len(irr_deals),
        },
        'by_band': by_band,
        'calibration': {
            'monotonic': monotonic,
            'band_mean_multiples': {b: by_band[b]['mean_multiple'] for b in band_order},
        },
        'selectivity': selectivity,
        'misses': {
            'overrated': overrated,
            'underrated': underrated,
        },
        'cfo_calibration': cfo_calibration,
        'verdict': verdict_parts,
    }


def _cfo_calibrate(deals: list[dict]) -> dict:
    """Measure CFO verdict accuracy against known outcomes."""
    verdicts = ['Deploy', 'Defer', 'Pass']
    by_verdict: dict[str, list[float]] = {v: [] for v in verdicts}

    for d in deals:
        cfo = d.get('council_cfo_verdict')
        multiple = d.get('multiple')
        if cfo and multiple is not None:
            if cfo in by_verdict:
                by_verdict[cfo].append(multiple)

    result = {}
    for v in verdicts:
        ms = by_verdict[v]
        if not ms:
            result[v] = {'n': 0}
            continue
        result[v] = {
            'n': len(ms),
            'mean_multiple': _round(_mean(ms)),
            'median_multiple': _round(_median(ms)),
            'win_rate': _round(_win_rate(ms)),         # >1x
            'loss_rate': _round(_win_rate([-m for m in ms], -1.0)),  # <1x
        }

    # Correctness: Pass should avoid losses, Deploy should capture wins
    total_with_cfo = sum(result[v]['n'] for v in verdicts)
    pass_correct = None  # % of Pass verdicts that avoided loss (mult >= 1x → would-have-been-right)
    deploy_correct = None
    if result['Pass']['n'] > 0:
        pass_correct = _round(result['Pass'].get('win_rate'))  # >1x = Pass was wrong; <1x = Pass was right
        # Invert: Pass is correct when mult < 1x
        pass_losses = [m for m in by_verdict['Pass'] if m < 1.0]
        pass_correct = _round(len(pass_losses) / len(by_verdict['Pass'])) if by_verdict['Pass'] else None
    if result['Deploy']['n'] > 0:
        deploy_wins = [m for m in by_verdict['Deploy'] if m > 1.0]
        deploy_correct = _round(len(deploy_wins) / len(by_verdict['Deploy'])) if by_verdict['Deploy'] else None

    return {
        'by_verdict': result,
        'n_total_with_cfo_outcome': total_with_cfo,
        'pass_correct_rate': pass_correct,
        'deploy_correct_rate': deploy_correct,
    }


def _round(v, decimals=3):
    if v is None:
        return None
    return round(v, decimals)


# ---------------------------------------------------------------------------
# Dispatcher entry point
# ---------------------------------------------------------------------------

def handle_validate(data: dict) -> dict:
    """Validate thesis scoring against investment outcomes."""
    deals = data.get('deals', [])
    return _analyze(deals)


# ---------------------------------------------------------------------------
# Council signal analysis
# ---------------------------------------------------------------------------

def _council_analyze(deals: list[dict]) -> dict:
    """Compare council scores vs single-pass scores against outcomes."""

    # Filter to deals with council data + outcome
    council_deals = [
        d for d in deals
        if d.get('council_consensus') is not None
        and d.get('score') is not None
        and d.get('multiple') is not None
    ]

    if len(council_deals) < 3:
        return {
            "error": f"Not enough council-evaluated deals with outcomes ({len(council_deals)}, need >= 3)",
            "n": len(council_deals),
            "n_with_council": len([d for d in deals if d.get('council_consensus') is not None]),
        }

    scores = [d['score'] for d in council_deals]
    consensus = [d['council_consensus'] for d in council_deals]
    multiples = [d['multiple'] for d in council_deals]
    spreads = [d.get('council_spread', 0) for d in council_deals]

    # Correlation: single-pass vs outcome
    rho_single = _spearman_rank_correlation(scores, multiples)
    # Correlation: council consensus vs outcome
    rho_council = _spearman_rank_correlation(consensus, multiples)
    # Correlation: spread vs outcome (high spread = uncertain = worse?)
    rho_spread = _spearman_rank_correlation(spreads, multiples)

    # Per-voice correlation
    bull_scores = [d['council_bull'] for d in council_deals if d.get('council_bull') is not None]
    bear_scores = [d['council_bear'] for d in council_deals if d.get('council_bear') is not None]
    cal_scores = [d['council_calibrator'] for d in council_deals if d.get('council_calibrator') is not None]

    bull_mults = [d['multiple'] for d in council_deals if d.get('council_bull') is not None]
    bear_mults = [d['multiple'] for d in council_deals if d.get('council_bear') is not None]
    cal_mults = [d['multiple'] for d in council_deals if d.get('council_calibrator') is not None]

    rho_bull = _spearman_rank_correlation(bull_scores, bull_mults) if len(bull_scores) >= 3 else None
    rho_bear = _spearman_rank_correlation(bear_scores, bear_mults) if len(bear_scores) >= 3 else None
    rho_cal = _spearman_rank_correlation(cal_scores, cal_mults) if len(cal_scores) >= 3 else None

    # Score delta analysis: where council diverges from single-pass
    deltas = [d['council_consensus'] - d['score'] for d in council_deals]
    council_adjusts_up = [d for d in council_deals if d['council_consensus'] > d['score'] + 2]
    council_adjusts_down = [d for d in council_deals if d['council_consensus'] < d['score'] - 2]

    # High divergence deals
    high_div = [
        {
            'company': d.get('company', '?'),
            'score': d['score'],
            'consensus': d['council_consensus'],
            'spread': d.get('council_spread'),
            'bull': d.get('council_bull'),
            'bear': d.get('council_bear'),
            'calibrator': d.get('council_calibrator'),
            'multiple': d['multiple'],
            'status': d.get('status'),
        }
        for d in council_deals if (d.get('council_spread') or 0) > 10
    ]

    # Verdicts
    verdicts = []
    if rho_council is not None and rho_single is not None:
        delta_rho = (rho_council or 0) - (rho_single or 0)
        if delta_rho > 0.05:
            verdicts.append(
                f"Council consensus is MORE predictive than single-pass "
                f"(ρ={rho_council:.3f} vs ρ={rho_single:.3f}, Δ={delta_rho:+.3f})"
            )
        elif delta_rho < -0.05:
            verdicts.append(
                f"Single-pass is MORE predictive than council consensus "
                f"(ρ={rho_single:.3f} vs ρ={rho_council:.3f}, Δ={delta_rho:+.3f})"
            )
        else:
            verdicts.append(
                f"Council and single-pass have similar predictive power "
                f"(ρ={rho_single:.3f} vs ρ={rho_council:.3f})"
            )

    if rho_spread is not None and rho_spread < -0.2:
        verdicts.append(
            f"High council spread predicts worse outcomes (ρ={rho_spread:.3f}) — "
            f"disagreement is a negative signal"
        )

    # Which voice is most predictive?
    voice_rhos = [
        ('Bull', rho_bull),
        ('Bear', rho_bear),
        ('Calibrator', rho_cal),
    ]
    best_voice = max(voice_rhos, key=lambda v: v[1] or -999)
    if best_voice[1] is not None:
        verdicts.append(f"Most predictive voice: {best_voice[0]} (ρ={best_voice[1]:.3f})")

    return {
        'n': len(council_deals),
        'n_with_council': len([d for d in deals if d.get('council_consensus') is not None]),
        'correlation': {
            'single_pass_vs_outcome': _round(rho_single),
            'council_consensus_vs_outcome': _round(rho_council),
            'spread_vs_outcome': _round(rho_spread),
            'bull_vs_outcome': _round(rho_bull),
            'bear_vs_outcome': _round(rho_bear),
            'calibrator_vs_outcome': _round(rho_cal),
        },
        'score_delta': {
            'mean_delta': _round(_mean(deltas)),
            'adjusts_up': len(council_adjusts_up),
            'adjusts_down': len(council_adjusts_down),
        },
        'high_divergence_deals': high_div,
        'verdicts': verdicts,
    }


def handle_council_validate(data: dict) -> dict:
    """Compare council scores vs single-pass scores against outcomes."""
    deals = data.get('deals', [])
    return _council_analyze(deals)


# ---------------------------------------------------------------------------
# Thesis Discovery — data-driven cluster analysis
# ---------------------------------------------------------------------------

DEFAULT_ACTIVE_THESES = [
    'AI Infrastructure & Safety',
    "Hard Tech That Reprices What's Possible",
    'Intelligence for Physical Systems',
    'Resilient Systems',
]

MIN_GROUP_SIZE = 3  # minimum investments to consider a group meaningful


def _hold_years(invest_date_str: str | None) -> float | None:
    """Convert invest_date string to hold time in years from today."""
    if not invest_date_str:
        return None
    try:
        d = datetime.strptime(str(invest_date_str)[:10], '%Y-%m-%d').date()
        return (date.today() - d).days / 365.25
    except (ValueError, TypeError):
        return None


def _group_stats(investments: list[dict]) -> dict:
    """Compute performance stats for a group of investments."""
    multiples = [d['multiple'] for d in investments if d.get('multiple') is not None]
    irrs = [d['irr'] for d in investments if d.get('irr') is not None]

    if not multiples:
        return None

    mean_mult = _mean(multiples)
    n = len(multiples)

    # Time-to-positive-mark: hold time for investments currently > 1.0x
    winners_hold = []
    pending_hold = []
    for d in investments:
        if d.get('multiple') is None:
            continue
        hold = _hold_years(d.get('invest_date'))
        if hold is None:
            continue
        if d['multiple'] > 1.0:
            winners_hold.append(hold)
        else:
            pending_hold.append(hold)

    return {
        'n': n,
        'mean_multiple': _round(mean_mult),
        'median_multiple': _round(_median(multiples)),
        'stddev_multiple': _round(_stddev(multiples)),
        'win_rate': _round(_win_rate(multiples)),
        'big_winner_rate': _round(_win_rate(multiples, 3.0)),
        'mean_irr': _round(_mean(irrs)),
        'n_irr': len(irrs),
        # Quality score: rewards both performance and sample size
        'quality_score': _round(mean_mult * math.sqrt(n)) if mean_mult is not None else None,
        'companies': [d['company'] for d in investments if d.get('multiple') is not None],
        # Time-to-positive-mark
        'avg_hold_winners': _round(_mean(winners_hold), 1),
        'avg_hold_pending': _round(_mean(pending_hold), 1),
        'n_winners': len(winners_hold),
        'n_pending': len(pending_hold),
    }


def _scan_dimension(investments: list[dict], dim: str, label: str) -> list[dict]:
    """Group investments by a single dimension, compute stats per group."""
    groups = defaultdict(list)
    for inv in investments:
        if dim == 'theses':
            # Multi-valued: each investment can have multiple theses
            for thesis in (inv.get('theses') or []):
                if thesis:
                    groups[thesis].append(inv)
        else:
            val = inv.get(dim)
            if val and str(val).strip():
                groups[str(val).strip()].append(inv)

    results = []
    for name, members in groups.items():
        if len(members) < MIN_GROUP_SIZE:
            continue
        stats = _group_stats(members)
        if stats and stats['n'] >= MIN_GROUP_SIZE:
            results.append({
                'dimension': label,
                'group': name,
                **stats,
            })

    results.sort(key=lambda g: g.get('quality_score') or 0, reverse=True)
    return results


def _scan_combination(investments: list[dict], dim_a: str, dim_b: str,
                      label_a: str, label_b: str) -> list[dict]:
    """Group by pairs of attributes, find outperforming combos."""
    groups = defaultdict(list)
    for inv in investments:
        vals_a = inv.get('theses') if dim_a == 'theses' else [inv.get(dim_a)]
        vals_b = inv.get('theses') if dim_b == 'theses' else [inv.get(dim_b)]
        for va in (vals_a or [None]):
            for vb in (vals_b or [None]):
                if va and vb and str(va).strip() and str(vb).strip():
                    key = f"{va} + {vb}"
                    groups[key].append(inv)

    results = []
    for name, members in groups.items():
        if len(members) < MIN_GROUP_SIZE:
            continue
        stats = _group_stats(members)
        if stats and stats['n'] >= MIN_GROUP_SIZE:
            results.append({
                'dimension': f"{label_a} + {label_b}",
                'group': name,
                **stats,
            })

    results.sort(key=lambda g: g.get('quality_score') or 0, reverse=True)
    return results[:10]  # top 10 combos


def _discover(investments: list[dict], active_theses: list[str] | None = None) -> dict:
    """Run thesis discovery analysis."""
    active_theses = active_theses or DEFAULT_ACTIVE_THESES

    # Filter to investments with outcomes
    with_outcomes = [inv for inv in investments if inv.get('multiple') is not None]

    if len(with_outcomes) < 5:
        return {
            "error": f"Not enough data ({len(with_outcomes)} investments with outcomes, need >= 5)",
            "n": len(with_outcomes),
        }

    # Portfolio-wide baseline
    all_multiples = [inv['multiple'] for inv in with_outcomes]
    portfolio_mean = _mean(all_multiples)
    portfolio_stats = _group_stats(with_outcomes)

    # --- 1. Single-dimension scan ---
    dimensions = [
        ('theses', 'Thesis'),
        ('stage', 'Stage'),
        ('lead', 'Lead/GP'),
        ('market', 'Market'),
        ('round', 'Round'),
        ('instrument', 'Instrument'),
    ]

    all_groups = []
    by_dimension = {}
    for dim, label in dimensions:
        groups = _scan_dimension(with_outcomes, dim, label)
        by_dimension[label] = groups
        all_groups.extend(groups)

    # Sort all groups by quality score
    all_groups.sort(key=lambda g: g.get('quality_score') or 0, reverse=True)

    # --- 2. Active thesis assessment ---
    thesis_groups = {g['group']: g for g in by_dimension.get('Thesis', [])}
    active_assessment = []
    for thesis_name in active_theses:
        stats = thesis_groups.get(thesis_name)
        if not stats:
            active_assessment.append({
                'thesis': thesis_name,
                'n': 0,
                'mean_multiple': None,
                'verdict': 'no data',
                'rank': None,
            })
            continue

        # Find rank among all groups
        rank = next(
            (i + 1 for i, g in enumerate(all_groups) if g['group'] == thesis_name and g['dimension'] == 'Thesis'),
            None
        )

        mean = stats.get('mean_multiple') or 0
        if mean >= portfolio_mean * 1.2:
            verdict = 'strong — outperforming portfolio'
        elif mean >= portfolio_mean * 0.8:
            verdict = 'neutral — tracking portfolio'
        else:
            verdict = 'weak — underperforming portfolio'

        active_assessment.append({
            'thesis': thesis_name,
            'rank': rank,
            'rank_of': len(all_groups),
            **{k: v for k, v in stats.items() if k not in ('dimension', 'group', 'companies')},
            'verdict': verdict,
        })

    # --- 3. Promotion candidates ---
    # Groups that outperform the weakest active thesis
    active_means = [
        (thesis_groups[t]['mean_multiple'] or 0)
        for t in active_theses if t in thesis_groups and thesis_groups[t].get('mean_multiple')
    ]
    weakest_active_mean = min(active_means) if active_means else 0

    promotions = []
    for g in all_groups:
        if g['dimension'] == 'Thesis' and g['group'] in active_theses:
            continue  # skip current active theses
        if (g.get('mean_multiple') or 0) > weakest_active_mean and g['n'] >= MIN_GROUP_SIZE:
            promotions.append(g)

    # --- 4. Combination scan ---
    combo_pairs = [
        ('theses', 'stage', 'Thesis', 'Stage'),
        ('theses', 'lead', 'Thesis', 'Lead/GP'),
        ('stage', 'lead', 'Stage', 'Lead/GP'),
    ]
    top_combos = []
    for dim_a, dim_b, label_a, label_b in combo_pairs:
        combos = _scan_combination(with_outcomes, dim_a, dim_b, label_a, label_b)
        top_combos.extend(combos)

    top_combos.sort(key=lambda g: g.get('quality_score') or 0, reverse=True)
    top_combos = top_combos[:10]

    # --- 5. Summary ---
    verdicts = []
    underperforming = [a for a in active_assessment if 'weak' in a.get('verdict', '')]
    if underperforming:
        names = ', '.join(a['thesis'] for a in underperforming)
        verdicts.append(f"Underperforming active theses: {names}")
    if promotions:
        top_promo = promotions[0]
        verdicts.append(
            f"Top promotion candidate: {top_promo['group']} ({top_promo['dimension']}) "
            f"at {top_promo['mean_multiple']}x mean (n={top_promo['n']})"
        )
    if not underperforming and not promotions:
        verdicts.append("Current thesis structure appears well-calibrated to portfolio outcomes")

    return {
        'n': len(with_outcomes),
        'n_total': len(investments),
        'portfolio_baseline': {
            'mean_multiple': _round(portfolio_mean),
            'median_multiple': _round(_median(all_multiples)),
            'win_rate': _round(_win_rate(all_multiples)),
            'n': len(all_multiples),
        },
        'top_groups': [
            {k: v for k, v in g.items() if k != 'companies'}
            for g in all_groups[:15]
        ],
        'active_assessment': active_assessment,
        'promotions': [
            {k: v for k, v in g.items() if k != 'companies'}
            for g in promotions[:10]
        ],
        'top_combos': [
            {k: v for k, v in g.items() if k != 'companies'}
            for g in top_combos
        ],
        'by_dimension': {
            dim_label: [
                {k: v for k, v in g.items() if k != 'companies'}
                for g in groups
            ]
            for dim_label, groups in by_dimension.items()
        },
        'verdicts': verdicts,
    }


def handle_discover(data: dict) -> dict:
    """Discover optimal thesis clusters from investment outcomes."""
    investments = data.get('investments', [])
    active_theses = data.get('active_theses', None)
    return _discover(investments, active_theses)
