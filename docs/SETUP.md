# Setting Up Radar — Configuration Runbook

This walks you from a fresh clone to a fully configured install running against **your** portfolio and **your** judgment. Each stage ends with a verify step — don't move on until it passes.

A useful mental model: **the engine is open source; your judgment is config.** Everything personal lives in files git never sees:

| What | Where | Created in |
|------|-------|-----------|
| Database credentials, deal-log path | `.env` | Stage 2 |
| Your portfolio data | your database (local or Postgres) | Stage 3 |
| Your theses, rubric, tagging rules, GP tiers | a lens (`lenses/<name>/` or `~/.radar/lenses/<name>/`) | Stage 4 |
| Active-lens selection | `.radar/config.json` or `~/.radar/config.json` | Stage 4 |
| Risk capital, budget, check tiers | `src/config/bet-sizing.json` | Stage 5 |
| Syndicate-lead names for SPV parsing | `src/config/lead-prefixes.json` | Stage 6 (optional) |

---

## Stage 1 — Prerequisites & install

You need Node v20+ and Python 3.9+ (standard library only — no pip installs). A database is required but there are two options: a zero-setup local embedded database (no account, no external service) or a hosted PostgreSQL / [Neon](https://neon.tech) connection. See Stage 2 for both paths.

```bash
node --version     # must be >= 20
python3 --version  # must be >= 3.9

git clone https://github.com/ckoglmeier/radar.git
cd radar
npm install
npm run setup-hooks
```

`setup-hooks` activates the pre-commit gate: it blocks accidental commits of CSVs/PDFs/`.env` and runs the test suite before every commit. If you plan to commit your own changes, you want this on.

**Verify:**
```bash
npm test
```
All suites should pass with no configuration at all — tests are self-contained. (The suites that touch a database will need `DATABASE_URL` set; if you haven't done Stage 2 yet, any failure mentioning `DATABASE_URL` is expected and resolves after the next stage.)

---

## Stage 2 — Database

```bash
cp .env.example .env
# Choose one of the two DATABASE_URL options in .env:
#   Easy/local:  DATABASE_URL=file:./radar.db       (embedded, zero external setup)
#   Remote:      DATABASE_URL=postgresql://...       (Neon free tier or any Postgres)
node src/cli.js db:setup
```

**Local embedded** (`file:./radar.db`) uses PGlite — a WASM build of Postgres that persists to a local directory. No account, no network, no service to run. This is the fastest way to get started. The file is gitignored by default.

**Remote** (`postgresql://...`) is the production-grade path. Neon's free tier is plenty for a personal portfolio; any Postgres connection string works.

`db:setup` runs every migration in `src/db/migrations/` in order and is safe to re-run — applied migrations are tracked in a `schema_migrations` table. `db:migrate` does the same thing later, when you pull a version with new migrations.

**Verify:**
```bash
node src/cli.js portfolio summary
```
You should get a clean, empty summary — zero investments, no errors. If you see a connection error, fix `DATABASE_URL` before continuing.

---

## Stage 3 — Import your portfolio

The bundled importer is the AngelList export connector. If you invest through AngelList:

```bash
node src/cli.js import angellist path/to/portfolio.csv        # positions + valuations
node src/cli.js import transactions path/to/transactions.csv  # cash-flow ledger (enables IRR/DPI)
```

Both are idempotent — re-importing the same file is safe, and re-importing a newer export updates valuations and records the changes.

**Not on AngelList?** The schema is plain SQL (`src/db/migrations/001_initial_schema.sql` is the readable reference). The minimum viable row is an insert into `investments` (company_name, invest_date, invested, status); add rows to `cash_flows` (type `investment`, negative amount, plus any `distribution` rows, positive) to get IRR and DPI. Adapting `src/import/angellist.js` to your platform's export format is the intended extension point.

**Verify:**
```bash
node src/cli.js portfolio summary          # totals match what you imported
node src/cli.js portfolio list --sort invested
node src/cli.js portfolio reconcile        # cash flows vs positions; orphans are normal
                                           # if you skipped the transactions import
```

---

## Stage 4 — Your lens

A lens is your investment framework as data: thesis definitions, auto-tagging rules, scoring rubric, kill criteria, GP tiers, and outcome distributions. Radar ships with an empty documented template and does nothing thesis-related until you create one.

```bash
node src/cli.js lens init my-lens     # scaffolds lenses/my-lens/ from the template
```

Now edit the JSON files in `lenses/my-lens/`. **[lenses/_template/README.md](../lenses/_template/README.md) is the authoritative field-by-field guide** — read it alongside this. The practical order:

1. **`manifest.json`** — name, your handle. Two minutes.
2. **`theses/*.json`** — one file per thesis. This is the real work: the `belief` statement, what qualifies, what's excluded. Two or three theses is a fine start; you can add more as your thinking sharpens.
3. **`tagging-rules.json`** — maps market keywords and company names to your theses, so imports auto-tag. Start with market patterns only; add company patterns as you notice misses (`thesis untagged` shows you what fell through).
4. **`rubric.json` + `kill-criteria.json`** — your scoring dimensions and automatic passes. If you don't have a grading practice yet, keep the template structure and calibrate later — an imperfect rubric you actually use beats a perfect one you don't.
5. **`distributions.json`** — outcome probabilities per score band, used by bet sizing. **Cold-start guidance:** you have no outcome data yet, so start from public venture base rates (roughly: most seed checks return <1x, a small minority drive all returns) and make your top band only modestly more optimistic than your bottom one. Overconfident distributions produce oversized Kelly checks. Revisit after `eval validate` gives you real calibration data.
6. **`gp-tiers.json` / `round-params.json`** — optional at the start; fill in as your syndicate relationships and stage assumptions take shape.

Activate it:

```bash
mkdir -p .radar
echo '{"active_lens": "my-lens"}' > .radar/config.json
node src/cli.js lens active           # confirm
node src/cli.js lens retag            # apply your tagging rules to imported positions
```

Prefer to keep your lens out of the working tree? Move it: `mkdir -p ~/.radar/lenses && mv lenses/my-lens ~/.radar/lenses/` — name lookup checks `~/.radar/lenses/` first, and `~/.radar/config.json` works as a global fallback for the activation. A user-level lens directory is also a natural thing to version as its own private git repo.

**Verify:**
```bash
node src/cli.js lens active            # shows my-lens, not _template
node src/cli.js thesis performance     # your theses appear with attributed capital
node src/cli.js thesis untagged        # whatever your rules didn't catch
```

---

## Stage 5 — Bet-sizing config

`bet-size` refuses to run until you give it your numbers — there are no defaults, deliberately.

```bash
cp src/config/bet-sizing.json.example src/config/bet-sizing.json
# edit src/config/bet-sizing.json (gitignored)
```

How to think about each field on a cold start:

- **`risk_capital`** — the total you could lose across all private positions without changing your life. Not your net worth; the carve-out.
- **`floor`** — the level you refuse to let total deployment breach. The gap between risk_capital and floor is what Kelly sizes against.
- **`annual_budget`** — soft cap on yearly deployment. Used for pacing context, not enforcement.
- **`tiers`** — score thresholds → check sizes, first match wins, descending. Two tiers is a sane start (a conviction check at your high band, a standard check below it, 0 = pass below your bar). Resist a "small exploratory check" tier — small checks compound into untracked sprawl.
- **`min_check` / `max_check`** — platform minimum and your personal ceiling; Kelly output is clamped to this range.
- **caps** (`single_position_cap_pct`, `cluster_cap_pct`, `illiquid_ceiling_pct`) — the example defaults (5% / 25% / 40%) are reasonable; tighten if concentration worries you.

Note: `bet-size <company>` looks up the company's **graded evaluation** in the database, so it becomes fully useful after Stage 6's deal-log import (use `--score N` to override the score on a specific run, e.g. while grading live).

**Verify:**
```bash
node src/cli.js bet-size SomeCompany
# Before config: a clear "copy the example" error.
# After config + an evaluation exists: a sizing recommendation with tier, Kelly lenses, and caps.
```

---

## Stage 6 — Optional integrations

Add these when the workflow exists in your practice; nothing else depends on them.

**Deal evaluations** (`eval import`) — if you grade deals as markdown files, set `DEAL_LOG_DIR` in `.env` to that directory. Run `node src/cli.js eval import`, then `eval list`. The parser's expected format is shown by the synthetic examples in `src/models/test-fixtures/deal-log/`. Once you have ~20+ graded deals with outcomes, `eval validate` tells you whether your rubric actually predicts returns — and feeds recalibration of `distributions.json`.

**SPV lead prefixes** (`import transactions`) — only matters if your transaction ledger has disbursement rows like `"<Lead Name> <Company> SPV"`. Copy `src/config/lead-prefixes.json.example` to `lead-prefixes.json` and list your syndicate leads (longest names first). Skip it until `portfolio reconcile` shows orphan distributions that should have matched.

**Pipeline invites** (`sync invites --file <json>`) — ingests deal-invite emails (AngelList invite format today) into a tracked pipeline with an event log. See CLAUDE.md's pipeline section for the message-array shape.

**Quarterly updates** (`updates new/import`) — investor updates as markdown files under `updates/<company>/`, with metrics in frontmatter. `updates timeline <company>` then charts ARR/burn/runway across quarters. Format spec: [updates/README.md](../updates/README.md).

---

## Final checklist

```bash
npm test                                  # everything green
node src/cli.js portfolio summary         # your portfolio, correct totals
node src/cli.js portfolio detail "<your largest position>"   # IRR + lot info render
node src/cli.js lens active               # your lens, not _template
node src/cli.js thesis performance        # capital attributed across your theses
node src/cli.js bet-size "<a graded company>"                # sizing works end-to-end
```

If all six pass, you're fully configured. From here the loop is: import fresh exports as they arrive, grade deals, `eval validate` quarterly, and recalibrate your lens as the data tells you where your judgment is miscalibrated — which is the entire point.
