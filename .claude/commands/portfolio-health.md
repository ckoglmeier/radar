## Portfolio Health Check

Run a comprehensive portfolio health briefing by executing these CLI commands and synthesizing the results into a narrative.

### Steps

1. Run `node src/cli.js portfolio summary` to get the top-level metrics (total investments, deployed capital, TVPI, locked valuations, top performers, stage breakdown).

2. Run `node src/cli.js portfolio performance` to get YTD, trailing 12M, vintage year, and quarterly cash flow data.

3. Run `node src/cli.js portfolio treemap --group-by thesis` to see composition by thesis cluster.

4. Run `node src/cli.js portfolio treemap --group-by lead --size-by current_value` to see GP concentration.

### Synthesis

After collecting all data, produce a briefing with these sections:

- **Headline**: One sentence — portfolio value, YTD return, TVPI
- **What's working**: Which thesis clusters, vintage years, and GPs are outperforming. Name specific companies driving returns.
- **What's not**: Underwater positions, thesis clusters underperforming, locked valuations limiting visibility
- **Concentration risk**: Top 3 GPs as % of portfolio value. Top 3 positions as % of portfolio value. Flag if any single GP or position exceeds 25%.
- **Cash flow health**: Net cash flow trend over the last 4 quarters — are distributions keeping pace with deployment?
- **Action items**: Specific things to investigate or act on (untagged investments, locked valuations, GP overconcentration, etc.)

Keep it concise — this is a weekly check-in, not a quarterly report.
