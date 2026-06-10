## Thesis Strategic Review

Comprehensive review of thesis cluster performance and strategic alignment.

### Steps

1. Run `node src/cli.js thesis performance` — performance by thesis cluster (TVPI, deal count, best performers).

2. Run `node src/cli.js thesis eras` — Exploration vs Conviction era comparison.

3. Run `node src/cli.js thesis stages` — stage breakdown with barbell roll-up.

4. Run `node src/cli.js thesis untagged` — investments with no thesis tags.

5. Run `node src/cli.js portfolio treemap --group-by thesis` — composition by thesis cluster (current value).

6. Run `node src/cli.js portfolio treemap --group-by thesis --size-by invested` — composition by thesis cluster (capital deployed).

### Synthesis

Produce a thesis review with:

- **Scoreboard**: Rank the 4 active thesis clusters by TVPI. Which is carrying the portfolio? Which is lagging?
- **Capital allocation vs returns**: Compare each thesis's share of deployed capital vs its share of current portfolio value. Are returns concentrated where capital is?
- **Era evolution**: How did thesis alignment change from Exploration (2021-2022) to Conviction (2023+)? Is the Conviction era more thesis-disciplined?
- **Stage strategy**: Is the barbell strategy working? Are Early-stage bets generating asymmetric returns? Are Late-stage bets delivering DPI?
- **Untagged gap**: How many investments are untagged? What's their combined value? Are any worth tagging (i.e., non-trivial positions that should be categorized)?
- **Thesis gaps**: Are any of the 4 core theses underrepresented in recent deal flow? Should you actively source for a specific thesis?
- **Recommendation**: One paragraph on whether the thesis framework is working, what to double down on, and what to reconsider.

The 4 active thesis clusters are:
1. AI Infrastructure & Safety
2. Hard Tech That Reprices What's Possible
3. Intelligence for Physical Systems
4. Resilient Systems
