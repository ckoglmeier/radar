## Pipeline Review

Deal flow hygiene check — recent activity, status distribution, and ungraded deals.

### Steps

1. Run `node src/cli.js pipeline list --limit 50` — recent pipeline invites across all statuses.

2. Run `node src/cli.js pipeline list --status invite --limit 50` — open invites that haven't been acted on.

3. Run `node src/cli.js pipeline list --status committed --limit 50` — committed but not yet closed.

4. Run `node src/cli.js eval list` — all deal evaluations to cross-reference.

5. Run `node src/cli.js gp summary` — GP context for who's sending deals.

### Synthesis

Produce a pipeline review with:

- **Flow volume**: How many invites in the last 30 days? Last 90 days? Is deal flow increasing or decreasing?
- **Status distribution**: Count of invites by status (invite/committed/passed/invested/refunded). How many are stuck in "invite" status?
- **Ungraded deals**: Cross-reference pipeline invites against evaluations. Flag any invites that arrived but were never formally graded — especially if they came from top-tier GPs (see CLAUDE.local.md for your GP tier list).
- **Pass rate**: What % of pipeline invites became investments vs passes? Is the filter too tight or too loose?
- **GP activity**: Which GPs are most active in recent pipeline? Are the best-performing GPs still sending deal flow?
- **Stale invites**: Any invites in "invite" status older than 14 days? These are likely expired and should be marked as passed.
- **Action items**: Specific deals to review, GPs to follow up with, or pipeline hygiene tasks.
