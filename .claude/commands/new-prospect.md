## New Prospect Evaluation: $ARGUMENTS

Full evaluation workflow for an inbound deal. "$ARGUMENTS" can be a company name, an AngelList URL, a forwarded pitch, or a brief description of the opportunity.

### Step 1: Dedup Check

First, check if this company already exists anywhere in Radar:

- Run `node src/cli.js portfolio detail "$ARGUMENTS"` — is it already in the portfolio?
- Run `node src/cli.js pipeline list --limit 200` and search for the company name — is it already in the pipeline?
- Run `node src/cli.js eval detail "$ARGUMENTS"` — has it already been evaluated?

If the company is already invested, say so and show the position details. If it's been evaluated before, show the prior score and verdict. If it's a repeat invite from a different GP, note both sources.

### Step 2: GP Context

Identify the GP/syndicate lead bringing this deal (from the pipeline invite, the pitch, or as provided).

- Run `node src/cli.js gp detail "<lead name>"` to get their track record, TVPI, deal count, and thesis alignment.
- Note their GP tier (check the investment-grading skill reference for the full tier list and your personal GP rankings).

### Step 3: Grade the Deal

Use the `/investment-grading` skill to run the full four-stage evaluation:

1. **Parse** the deal terms (round, valuation, allocation, instrument)
2. **Research** the company, market, and team
3. **Grade** against the rubric (Thesis Fit 25pts + Viability 25pts = 50pts total)
4. **Draft response** if applicable

Key rubric gates to flag (see CLAUDE.local.md for current thresholds):
- Low score → auto-pass in conviction era
- Late-stage deals need a higher bar (see local config for exact threshold)
- Kill criteria: >100x revenue multiple at Seed without Team=5/5, no product shipped, regulatory dependency without domain expertise

### Step 4: Sizing (if score warrants)

If the evaluation score clears the invest threshold:

- Run `node src/cli.js bet-size "$ARGUMENTS"` to get Kelly-based check sizing
- Note the tier recommendation (see CLAUDE.local.md for current tier amounts)
- Check deployment pace: run `node src/cli.js portfolio performance --window ytd` to see remaining annual budget

If the score is below 30, skip sizing and recommend a pass.

### Step 5: Decision Summary

Produce a one-page decision brief:

- **Company**: Name, round, valuation, lead
- **GP**: Track record summary, tier
- **Score**: Thesis Fit / Viability / Total, with key strengths and concerns
- **Verdict**: Invest / Pass / Needs More Info
- **Recommended check**: Tier + Kelly range (if investing)
- **Budget impact**: How this check affects remaining annual deployment budget
- **Response**: Draft response to the GP

If you decide to invest, remember to update the pipeline invite status to "committed" after committing.
