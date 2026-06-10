## Company Lookup: $ARGUMENTS

Look up everything Radar knows about the company "$ARGUMENTS" by running these commands. Some may return no results — that's fine, just report what exists.

### Steps

1. Run `node src/cli.js portfolio detail "$ARGUMENTS"` — check if this company is in the portfolio. If found, note investment date, amount, current value, multiple, thesis tags, and valuation history.

2. Run `node src/cli.js pipeline list --limit 200` and search the output for the company name (case-insensitive, partial match). If found in pipeline, note the status, lead, round, valuation, and when the invite arrived.

3. Run `node src/cli.js eval detail "$ARGUMENTS"` — check if a deal evaluation exists. If found, note the scores, verdict, and whether it was invested.

4. If the company IS in the portfolio and HAS an evaluation, run `node src/cli.js bet-size "$ARGUMENTS"` to show the Kelly sizing analysis.

5. Run `node src/cli.js gp summary` and identify which GP/lead brought this deal (cross-reference from portfolio detail or pipeline data).

### Output

Produce a single company profile card:

- **Status**: Portfolio position / Pipeline invite / Evaluated / Unknown
- **Investment**: Date, amount, current value, multiple (if invested)
- **Deal terms**: Round, valuation, lead, allocation (from pipeline or portfolio)
- **Evaluation**: Score, verdict, thesis fit (if evaluated)
- **GP context**: Who brought the deal, their overall track record (TVPI, deal count)
- **Valuation history**: If available, show the trajectory
- **Related**: Any other investments from the same GP or in the same thesis cluster

If the company is not found anywhere, say so clearly and suggest checking spelling or trying partial names.
