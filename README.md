# Radar

Decision infrastructure for private market investors.

---

I've made over 150 investments in startups and scale-ups since 2019. What started as a learning exercise became a system — one that now consistently outperforms top-quartile venture benchmarks. Radar is the software behind that system.

I built Radar because no tool existed for how serious angels actually operate. I see mid-hundreds of opportunities a year and invest in roughly ten. I started in spreadsheets and scripts years ago, then — with Claude's help — built something coherent: software that tracks not just what I own, but how I decide, why I invested, and whether my reasoning holds up over time as results come in.

This turned me from a spray-and-pray investor into a focused machine, constrained no longer by decision quality — only by my capital pool. And it's working. Over the last three years my TVPI and DPI have been well above top-quartile market standards.\*

_\*TVPI for 2023 and 2024 cohorts: 1.94x vs ~1.2–1.5x top quartile; DPI: 0.20x vs 0.0x._

---

## Quick Start

### Prerequisites

- Node.js (v20+)
- PostgreSQL database (we use [Neon](https://neon.tech) — free tier works)

### Install

```bash
git clone <repo-url>
cd radar
npm install
npm run setup-hooks   # or: git config core.hooksPath hooks
```

The pre-commit hook blocks sensitive files (CSVs, PDFs, `.env`) and runs the test gate before every commit.

### Configure

```bash
cp .env.example .env
# Add your Postgres connection string to .env
```

### Initialize

```bash
node src/cli.js db:setup      # Run all migrations
```

### Import your portfolio

Positions and transactions come in via CSV import. The bundled importer today is the AngelList export connector (more sources planned). If your data lives elsewhere, you can adapt the connector or insert rows directly.

```bash
# Import positions from an AngelList portfolio CSV export
node src/cli.js import angellist path/to/portfolio.csv

# Import transaction ledger for cash flows (AngelList transactions export)
node src/cli.js import transactions path/to/transactions.csv
```

### Explore

```bash
node src/cli.js portfolio summary
node src/cli.js portfolio list --sort multiple
node src/cli.js portfolio detail "Company Name"
node src/cli.js portfolio performance --window vintage
node src/cli.js thesis performance
```

---

## Commands

### Portfolio

| Command | Description |
|---------|-------------|
| `radar portfolio summary` | Portfolio overview with key metrics |
| `radar portfolio list` | List all investments (sort by date, invested, multiple, name, net value) |
| `radar portfolio detail <company>` | Full detail including IRR, QSBS countdown, lot tracking |
| `radar portfolio performance` | Time-windowed metrics (YTD, trailing 12M, vintage year, quarterly) |
| `radar portfolio treemap` | Composition by thesis, stage, vintage, or lead investor |
| `radar portfolio by-stage` | DPI/TVPI by stage bucket with barbell roll-up |
| `radar portfolio reconcile` | Check cash flows vs investments for discrepancies |

### Thesis

| Command | Description |
|---------|-------------|
| `radar thesis performance` | Performance by thesis cluster |
| `radar thesis untagged` | Investments not tagged to any thesis |
| `radar thesis eras` | Exploration vs Conviction era comparison |
| `radar thesis stages` | DPI/TVPI by stage with barbell roll-up |

### Pipeline

| Command | Description |
|---------|-------------|
| `radar pipeline list` | List pipeline invites (filter by status) |
| `radar pipeline detail <slug>` | Full detail for a pipeline invite |
| `radar pipeline events <slug>` | Event log for a pipeline invite |

### GP / Source Quality

| Command | Description |
|---------|-------------|
| `radar gp summary` | All GPs ranked by deployed capital and performance |
| `radar gp detail <name>` | Deep dive on a single GP or syndicate lead |

### Deal Evaluation

| Command | Description |
|---------|-------------|
| `radar eval import` | Import graded deal evaluations |
| `radar eval list` | List all evaluations with verdicts |
| `radar eval detail <company>` | Full evaluation detail |

### Bet Sizing

| Command | Description |
|---------|-------------|
| `radar bet-size <company>` | Kelly-based check sizing recommendation |

### Import & Sync

| Command | Description |
|---------|-------------|
| `radar import angellist <csv>` | Import positions from an AngelList portfolio CSV export (first bundled connector) |
| `radar import transactions <csv>` | Import cash-flow ledger from an AngelList transactions CSV export |
| `radar sync invites --file <json>` | Ingest deal invites from a Gmail JSON export (AngelList invite emails today) |

### Database

| Command | Description |
|---------|-------------|
| `radar db:setup` | Initialize schema (runs all migrations) |
| `radar db:migrate` | Run pending migrations |

---

## Tech Stack

- **Runtime:** Node.js (ESM modules)
- **Database:** PostgreSQL via `@neondatabase/serverless`
- **CLI:** `commander` + `chalk`
- **No ORM.** Raw SQL. Intentional at this scale.

---

## License

Licensed under AGPL-3.0 — anyone hosting a modified version commercially must open-source their changes back to the community.

---

*Theses sharpen slow,*
*each bet a question answered —*
*the signal compounds.*

*— from CK's desk*
