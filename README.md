# Radar

Decision infrastructure for private market investors.

---

I built Radar because no tool existed for how serious angels actually operate. I see mid-hundreds of opportunities a year and invest in roughly ten. I started in spreadsheets and scripts years ago, then — with Claude's help — built something coherent: software that tracks not just what I own, but how I decide, why I invested, and whether my reasoning holds up over time as results come in.

---

## What Radar does

- **Portfolio tracking** — positions, valuations over time, cash flows, IRR (XIRR), TVPI/DPI, QSBS lot tracking, vintage-year and stage analysis
- **Thesis attribution** — tag every investment to the investment theses that motivated it, then measure whether thesis-driven bets actually outperform
- **Deal pipeline** — ingest inbound deal invites, track status changes through an append-only event log, link invites to investments when you wire
- **Evaluation grading** — import structured deal evaluations (markdown), then validate the rubric: does your score actually predict returns? (`eval validate` computes Spearman correlation, per-band performance, and calibration)
- **Investment council** — run an adversarial council (Bull / Bear / Calibrator / CFO) over a deal against your own lens and calibration, write the diagnosis to your deal log, and ingest it — all headless via the Claude Agent SDK. Bills against a pay-per-token API key *or* your Claude subscription. See [docs/COUNCIL_AUTH.md](docs/COUNCIL_AUTH.md)
- **Bet sizing** — Kelly-criterion check sizing from your score bands and outcome distributions, with portfolio-level caps
- **GP / source quality** — which syndicate leads actually make you money
- **Quarterly updates** — investor updates as markdown files with a queryable metrics index (ARR, burn, runway, headcount over time)

Everything is CLI-first. Report functions return pure JSON, so a web UI can sit on top later.

## The lens system

Your investment theses, tagging rules, scoring rubric, kill criteria, GP tiers, and outcome distributions live in a **lens** — a directory of plain JSON files, separate from the engine. The repo ships with an empty, fully documented template; your own calibration stays in `~/.radar/`, outside the repo.

```bash
node src/cli.js lens init my-lens       # scaffold lenses/my-lens/ from the template
# edit lenses/my-lens/*.json — see lenses/_template/README.md for every field
# activate it: {"active_lens": "my-lens"} in .radar/config.json
node src/cli.js lens active             # confirm what's loaded
node src/cli.js lens retag              # apply your tagging rules to imported positions
```

To keep your lens out of the repo entirely, move it to `~/.radar/lenses/<name>` — user-level lenses are found by the same name lookup and take precedence.

Lenses are portable and shareable — export yours with `lens export`, install someone else's with `lens install`. The engine is open source; your judgment is the config.

## Quick Start

> Full configuration runbook — clone to fully-configured, with verify steps per stage: **[docs/SETUP.md](docs/SETUP.md)**

### Prerequisites

- Node.js v20+
- Python 3.9+ (analytics sidecar — Kelly solver, rubric validation; stdlib only, no pip installs)
- A database — zero-setup local embedded database (`DATABASE_URL=file:./radar.db`) or any PostgreSQL / [Neon](https://neon.tech) connection string

### Install

```bash
git clone https://github.com/ckoglmeier/radar.git
cd radar
npm install
npm run setup-hooks   # pre-commit hook: blocks sensitive files, runs the test gate
```

### Configure

```bash
cp .env.example .env                # choose local embedded or Postgres (see .env.example)
node src/cli.js db:setup            # run all migrations
node src/cli.js lens init my-lens   # create your lens (see above)
```

Optional config, each with a documented `.example` beside it (the real files are gitignored — they hold your numbers):

| File | Used by | Purpose |
|------|---------|---------|
| `src/config/bet-sizing.json` | `bet-size` | Risk capital, annual budget, score→check tiers |
| `src/config/lead-prefixes.json` | `import transactions` | Syndicate-lead names to strip when parsing SPV descriptions |
| `DEAL_LOG_DIR` in `.env` | `eval import` | Path to your deal-evaluation markdown directory |

### Import your portfolio

Positions and transactions come in via CSV import. The bundled importer today is the AngelList export connector (more sources planned). If your data lives elsewhere, you can adapt the connector or insert rows directly — the schema is plain SQL in `src/db/migrations/`.

```bash
node src/cli.js import angellist path/to/portfolio.csv        # positions
node src/cli.js import transactions path/to/transactions.csv  # cash-flow ledger
```

### Explore

```bash
node src/cli.js portfolio summary
node src/cli.js portfolio list --sort multiple
node src/cli.js portfolio detail "Company Name"
node src/cli.js portfolio performance
node src/cli.js thesis performance
node src/cli.js eval validate
```

---

## Commands

### Portfolio

| Command | Description |
|---------|-------------|
| `portfolio summary` | Portfolio overview with key metrics (`--since`/`--until` for date windows) |
| `portfolio list` | All investments — sort by date, invested, multiple, name, net value |
| `portfolio detail <company>` | Full detail: IRR, valuation history, QSBS 5-year countdown, lot tracking |
| `portfolio performance` | YTD, trailing 12M, vintage-year, and quarterly cash-flow views |
| `portfolio treemap` | Composition by thesis, stage, vintage, or lead |
| `portfolio by-stage` | DPI/TVPI by stage bucket |
| `portfolio override <company> <status\|clear>` | Sticky status override that survives re-imports |
| `portfolio reconcile` | Cash flows vs positions: mismatches, orphans, duplicates |
| `portfolio link <type> <id> <inv-id>` | Manually link an orphan cash flow or invite |

### Thesis

| Command | Description |
|---------|-------------|
| `thesis performance` | Performance by thesis cluster, with weighted attribution |
| `thesis untagged` | Investments not tagged to any thesis |
| `thesis eras` | Era-over-era comparison (`--since`/`--until`) |
| `thesis stages` | DPI/TVPI by stage with barbell roll-up |

### Evaluation & Sizing

| Command | Description |
|---------|-------------|
| `eval import` | Parse deal-evaluation markdown from `DEAL_LOG_DIR` into the DB |
| `eval list` / `eval detail <company>` | Browse graded evaluations |
| `eval validate` | Does your score predict returns? Correlation, band performance, calibration, misses |
| `eval discover` | Data-driven thesis cluster discovery from actual outcomes |
| `eval reconcile` | Pipeline passes that scored high — what did you walk away from? |
| `bet-size <company>` | Kelly-based check sizing for a graded company |

### Council & AI auth

| Command | Description |
|---------|-------------|
| `council <slug>` | Run the adversarial council on a pipeline deal; writes + ingests a deal-log (`--dry-run` to preview) |
| `auth:status [--probe]` | Show the model auth mode; `--probe` reports the credential that actually wins |

Model calls route through the Claude Agent SDK. Set `RADAR_AUTH_MODE=api_key`
(default) to bill an `ANTHROPIC_API_KEY`, or `subscription` to bill your Claude
subscription's Agent-SDK credit (run `claude setup-token` first; single-user /
local only). Full guide: [docs/COUNCIL_AUTH.md](docs/COUNCIL_AUTH.md).

### Pipeline & GP

| Command | Description |
|---------|-------------|
| `pipeline list` / `detail <slug>` / `events <slug>` | Inbound deal invites with full event history |
| `sync invites --file <json>` | Ingest invite emails (AngelList invite format today) |
| `gp summary` / `gp detail <name>` | Syndicate-lead quality: deployed, returned, performance |

### Updates & Lens

| Command | Description |
|---------|-------------|
| `updates new <company> -q "Q1 2026"` | Scaffold a quarterly update file (markdown is the source of truth) |
| `updates import` / `list` / `detail <id>` / `timeline <company>` | Queryable metrics index over update files |
| `lens active` / `list` / `init` / `inspect` / `install` / `export` / `retag` | Manage thesis frameworks |

### Data

| Command | Description |
|---------|-------------|
| `db:setup` / `db:migrate` | Initialize schema / run pending migrations |
| `export:beancount [path]` | Export the portfolio as a Beancount plain-text ledger |

---

## Tech stack

- **Runtime:** Node.js (ESM), plus a Python 3 analytics sidecar called via JSON-over-stdin (Kelly solver, statistical validation — standard library only)
- **Database:** Embedded PGlite (local, zero-setup) or PostgreSQL via `@neondatabase/serverless` (Neon / any Postgres)
- **AI:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) behind a single provider seam — subscription (OAuth) or API-key billing; per-persona model tiering via subagents
- **CLI:** `commander` + `chalk`
- **No ORM.** Raw parameterized SQL. Intentional at this scale.
- **Layering:** `src/reports/` returns pure data; `src/cli/printers/` formats it. A future web GUI reuses the report layer untouched.

## Tests

```bash
npm test   # 730+ assertions across Node + Python suites; also runs as the pre-commit gate
```

Test suites are fully self-contained — synthetic fixtures, no external files or personal data required.

## License

Licensed under AGPL-3.0 — anyone hosting a modified version commercially must open-source their changes back to the community.

---

*Theses sharpen slow,*
*each bet a question answered —*
*the signal compounds.*

*— from CK's desk*
