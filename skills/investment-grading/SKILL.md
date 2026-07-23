---
name: investment-grading
description: Run Radar's headless investment Council against an injected investor lens and calibration. Use for Radar pipeline evaluations and portfolio reevaluations that require sourced research, independent Bull and Bear judgments, calibrated rubric choices, and a durable deal-log record.
---

# Investment Grading — Headless Council

Run a complete, reproducible investment evaluation without a human checkpoint.
Radar injects the deal, lens, calibration, output schemas, and model policy.
Treat those injected inputs as authoritative.

## Invariants

- Research before scoring.
- Preserve full decision-relevant research depth; optimize repeated context, not
  diligence coverage.
- Freeze one Evidence Ledger before Bull or Bear evaluates the deal.
- Prevent Bull, Bear, Calibrator, and portfolio action from adding research.
- Let models choose 1–5 rubric values; let Radar compute points and verdicts.
- Keep independent evidence, judgment, and deterministic arithmetic separate.
- Mark missing information rather than inventing it.
- Keep every output concise enough to serve a decision.

## Runtime role contracts

Radar loads only the contract required for the active stage:

- Research planner: [references/planner.md](references/planner.md) — prioritize
  Radar's deterministic question bank and add only deal-specific gaps
- Research: [references/research.md](references/research.md)
- Bull: [references/bull.md](references/bull.md)
- Bear: [references/bear.md](references/bear.md)
- Calibrator: [references/calibrator.md](references/calibrator.md)
- Portfolio action: [references/cfo.md](references/cfo.md)

Do not combine these files into one model prompt. Role isolation is part of the
Council's cost, consistency, and provenance contract.

## Workflow

1. Plan the decision-critical research questions against the deal and rubric.
2. Research founders, company, financing, traction, economics,
   differentiation, competition, market, and external forces.
3. Freeze the sourced Evidence Ledger, Team Dossier, and Company Context.
4. Run Bull and Bear independently against the same ledger and rubric.
5. Reconcile their choices against the rubric and investor calibration.
6. Have Radar calculate canonical scores and the verdict.
7. Produce the compact portfolio action requested by Radar.
8. Let Radar render and persist the deal-log artifact.

## Evidence and uncertainty

Label evidence as `Supplied`, `Verified`, `Conflicting`, or `Unavailable`.
Independent evidence overrides pitch claims where they conflict. An unavailable
fact is not automatically a negative fact, but a stage-critical absence can cap
the relevant rubric dimension.

## Output discipline

Return only the structured schema supplied for the active stage.

- Use rubric dimension names exactly as injected.
- Give one concise rationale per dimension.
- Avoid biographies, duplicated summaries, and generic market exposition.
- Limit key arguments to the facts that can change the decision.
- Keep moves up, moves down, and questions concrete and answerable.
- Never include model reasoning or chain-of-thought in the artifact.

Radar owns artifact formatting, score arithmetic, verdict bands, provenance,
and persistence.
