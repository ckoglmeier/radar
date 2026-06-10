## Radar Command Dictionary

Print the full list of available Radar slash commands and CLI commands. This is the quick reference.

### Slash Commands (composite analysis workflows)

| Command | Description |
|---------|-------------|
| `/portfolio-health` | Full portfolio briefing — summary, YTD/T12M performance, composition by thesis |
| `/company <name>` | Everything Radar knows about a company — portfolio, pipeline, evaluations, bet sizing |
| `/gp-review <name>` | Deep dive on a GP/syndicate lead — deal history, thesis alignment, performance vs average |
| `/deployment-pace` | YTD deployment tracking against annual target, quarterly cash flows, remaining budget |
| `/thesis-check` | Strategic thesis review — all 4 clusters, era comparison, untagged investments |
| `/pipeline-review` | Deal flow hygiene — recent invites, status distribution, ungraded deals |
| `/upcoming-capital-calls` | Forward-looking cash needs — uncalled commitments, expected capital calls, liquidity planning |
| `/new-prospect <company>` | Full deal evaluation — dedup, GP context, investment grading, bet sizing, decision brief |
| `/radar` | This dictionary |

### CLI Commands (individual queries)

Run these directly with `node src/cli.js <command>`:

**Portfolio:** `portfolio summary` · `portfolio list [--sort field]` · `portfolio detail <company>` · `portfolio performance [--window ytd|trailing12m|vintage|quarterly]` · `portfolio treemap [--group-by thesis|stage|vintage|lead] [--size-by invested|current_value]` · `portfolio by-stage`

**Thesis:** `thesis performance` · `thesis eras` · `thesis stages` · `thesis untagged`

**Pipeline:** `pipeline list [--status invite|committed|passed|invested|refunded]` · `pipeline detail <slug>` · `pipeline events <slug>`

**GP/Source:** `gp summary` · `gp detail <name>`

**Evaluations:** `eval list` · `eval detail <company>` · `eval import`

**Bet Sizing:** `bet-size <company> [--score N] [--round R]`

**Import:** `import angellist <csv>` · `import transactions <csv> [--recompute]` · `import recompute` · `import recompute-stages`

**Database:** `db:setup` · `db:migrate`

Print this reference cleanly formatted for quick scanning.
