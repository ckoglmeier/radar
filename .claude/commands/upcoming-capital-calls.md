## Upcoming Capital Calls & Cash Needs

Forward-looking cash needs analysis — committed capital, expected calls, and liquidity planning.

### Steps

1. Run `node src/cli.js pipeline list --status committed --limit 100` — deals committed but not yet closed. These represent near-term capital calls.

2. Run `node src/cli.js portfolio performance --window ytd` — YTD cash position (deployed vs distributions received).

3. Run `node src/cli.js portfolio performance --window quarterly` — quarterly cash flow pattern to estimate typical call timing.

4. Run `node src/cli.js portfolio list --sort invest_date` — recent investments to see deployment cadence and check sizes.

5. Run `node src/cli.js portfolio list` and check any fund-style positions that may have uncalled capital commitments or scheduled distributions (see CLAUDE.local.md for the specific fund names and amounts in your portfolio).

### Analysis

Produce a cash needs forecast with:

- **Committed pipeline**: List every deal in "committed" status with expected check size. Sum total committed but uncalled capital.
- **Fund commitments**: Check any fund-style positions with uncalled capital or scheduled distributions (see CLAUDE.local.md for specific fund names, amounts, and distribution schedules).
- **Expected near-term calls**: Based on committed pipeline + fund obligations, what's the 30/60/90 day cash need?
- **Inflows expected**: Any known upcoming distributions from fund positions or partial exits? Check recent quarterly patterns for typical distribution timing.
- **Net cash position**: Expected outflows minus expected inflows over the next 90 days.
- **Remaining annual budget**: Annual target minus YTD deployed. How much dry powder remains for new deals? (See CLAUDE.local.md for current annual target.)
- **Liquidity recommendation**: Is there enough cash set aside for committed calls? Is there enough runway to take on new deals? Flag any crunch points.

Note: Radar doesn't yet have a formal cash_flow_projections table (it's a backlog TODO). This analysis is assembled from pipeline status, fund position knowledge, and historical patterns. Flag any estimates that are based on assumptions rather than hard data.
