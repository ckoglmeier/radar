## GP Review: $ARGUMENTS

Deep dive on GP/syndicate lead "$ARGUMENTS". Run these commands and synthesize into an assessment.

### Steps

1. Run `node src/cli.js gp detail "$ARGUMENTS"` — get their full deal history, deployed capital, weighted multiple, thesis breakdown, and era breakdown.

2. Run `node src/cli.js gp summary` — get the full GP leaderboard to contextualize this GP's rank and how they compare to portfolio averages.

3. Run `node src/cli.js portfolio performance --window vintage` — get vintage year data to see if this GP's deals align with the better-performing vintages.

4. Run `node src/cli.js pipeline list --limit 200` and filter for deals from this GP to see recent pipeline activity (invites not yet invested).

### Synthesis

Produce a GP assessment with:

- **Overview**: Deal count, total deployed, TVPI, rank among all GPs
- **Track record**: Best and worst performers. Weighted multiple vs portfolio average. DPI (have they returned cash?).
- **Thesis alignment**: What % of their deals map to the 4 active thesis clusters vs general market tags? Are they bringing deals that fit the active thesis clusters?
- **Vintage quality**: Are their deals concentrated in good vintages (2022-2024) or the exploration era?
- **Pipeline activity**: Recent invites from this GP — are they still active in the flow?
- **Verdict**: One paragraph — should you continue allocating to this GP, increase exposure, or reduce? Base this on data, not vibes.
