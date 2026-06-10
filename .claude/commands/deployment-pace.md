## Deployment Pace Check

Track YTD deployment against the annual target and assess cash flow health.

### Steps

1. Run `node src/cli.js portfolio performance --window ytd` — get YTD cash in/out and value change.

2. Run `node src/cli.js portfolio performance --window quarterly` — get quarterly cash flow history.

3. Run `node src/cli.js portfolio list --sort invest_date` and look at the most recent investments to see what's been deployed this year and to which companies.

### Analysis

Produce a deployment pace report:

- **YTD deployed**: Total capital out this year. Compare to the annual target — what % of budget is used? At current pace, will you hit, undershoot, or overshoot?
- **Quarterly run rate**: Average quarterly deployment over the last 4 quarters. Is the pace accelerating or decelerating?
- **YTD distributions**: Cash returned this year. Net cash position (distributions minus deployments).
- **Recent deals**: List current-year investments with amounts — are check sizes consistent with the tier framework?
- **Remaining budget**: Annual target minus YTD deployed. How many deals does that support at each tier?
- **Recommendation**: Should deployment be throttled, maintained, or accelerated? Consider remaining budget, pipeline quality, and time left in the year.

Reference: See CLAUDE.local.md for the current annual target and tier framework amounts (personal config, not stored in this file).
