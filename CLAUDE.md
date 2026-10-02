# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:


Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Best practices for developing on Vercel

These defaults are optimized for AI coding agents (and humans) working on apps that deploy to Vercel.

- Treat Vercel Functions as stateless + ephemeral (no durable RAM/FS, no background daemons), use Blob or marketplace integrations for preserving state
- Edge Functions (standalone) are deprecated; prefer Vercel Functions
- Don't start new projects on Vercel KV/Postgres (both discontinued); use Marketplace Redis/Postgres instead
- Store secrets in Vercel Env Variables; not in git or `NEXT_PUBLIC_*`
- Provision Marketplace native integrations with `vercel integration add` (CI/agent-friendly)
- Sync env + project settings with `vercel env pull` / `vercel pull` when you need local/offline parity
- Use `waitUntil` for post-response work; avoid the deprecated Function `context` parameter
- Set Function regions near your primary data source; avoid cross-region DB/service roundtrips
- Tune Fluid Compute knobs (e.g., `maxDuration`, memory/CPU) for long I/O-heavy calls (LLMs, APIs)
- Use Runtime Cache for fast **regional** caching + tag invalidation (don't treat it as global KV)
- Use Cron Jobs for schedules; cron runs in UTC and triggers your production URL via HTTP GET
- Use Vercel Blob for uploads/media; Use Edge Config for small, globally-read config
- If Enable Deployment Protection is enabled, use a bypass secret to directly access them
- Add OpenTelemetry via `@vercel/otel` on Node; don't expect OTEL support on the Edge runtime
- Enable Web Analytics + Speed Insights early
- Use AI Gateway for model routing, set AI_GATEWAY_API_KEY, using a model string (e.g. 'anthropic/claude-sonnet-4.6'), Gateway is already default in AI SDK
  needed. Always curl https://ai-gateway.vercel.sh/v1/models first; never trust model IDs from memory
- For durable agent loops or untrusted code: use Workflow (pause/resume/state) + Sandbox; use Vercel MCP for secure infra access

---

# Radar

A private-markets radar CLI for tracking an angel investment portfolio, ingesting deal pipeline from Gmail, and building searchable intelligence across everything you see. Local-first with embedded PGlite; the Neon HTTP adapter has limited workflow support.

## Quick Start

```bash
# All commands
node src/cli.js --help

# Key commands
node src/cli.js portfolio summary
node src/cli.js portfolio summary --since 2024-01-01   # date-filtered view
node src/cli.js portfolio list --sort multiple
node src/cli.js portfolio detail <company>             # includes IRR, QSBS countdown, lot tracking
node src/cli.js portfolio performance          # YTD, trailing 12M, vintage year, quarterly
node src/cli.js portfolio treemap              # composition by thesis (--group-by stage/vintage/lead)
node src/cli.js thesis performance
node src/cli.js thesis performance --since 2023-01-01 --until 2024-12-31
node src/cli.js thesis eras
node src/cli.js thesis untagged
node src/cli.js portfolio reconcile                       # cash flow vs investment balance check
node src/cli.js portfolio link cashflow <id> <inv-id>     # link orphan cash flow to investment
node src/cli.js portfolio link invite <id> <inv-id>       # link pipeline invite to investment
node src/cli.js bet-size <company>                        # Kelly-based check sizing
node src/cli.js eval validate                              # score-to-outcome correlation
node src/cli.js eval validate --since 2023-01-01           # conviction-era only
node src/cli.js eval discover                              # data-driven thesis cluster analysis
node src/cli.js eval discover --since 2023-01-01           # conviction-era thesis discovery

# Quarterly investor updates (markdown files in updates/ are source of truth)
node src/cli.js updates new <company> -q "Q1 2026"         # scaffold a new update file
node src/cli.js updates import                              # parse updates/*.md → DB
node src/cli.js updates list [--needs-review|--needs-feedback]
node src/cli.js updates detail <id>
node src/cli.js updates timeline <company>

# Re-import AngelList CSV (upserts, safe to re-run)
node src/cli.js import angellist <csv-path>

# Pipeline ingest from Gmail invites (JSON file = array of raw messages)
node src/cli.js sync invites --file <path-to-messages.json>
node src/cli.js pipeline list [--status invite|committed|passed|invested|refunded]
node src/cli.js pipeline detail <deal-slug>
node src/cli.js pipeline events <deal-slug>

# Initialize/reset schema (runs all pending migrations)
node src/cli.js db:setup
node src/cli.js db:migrate
```

## Tech Stack

- **Runtime:** Node.js (ESM modules), Python 3 (analytics sidecar)
- **Database:** Local PGlite; limited Neon HTTP support. See docs/DATABASE_CAPABILITIES.md.
- **CLI:** `commander` + `chalk`
- **CSV:** `csv-parse`
- **Analytics:** Python 3 sidecar (`src/analytics/`) — Kelly solver, future stats/modeling. Called via JSON-over-stdin/stdout from Node.
- **No ORM.** Raw SQL via `sql.query(text, params)` in `src/db/index.js`

## Project Structure

```
src/
  cli.js              # CLI entry point, all command definitions
  cli/
    printers/         # CLI presentation layer (chalk formatting, console output)
      portfolio.js    # printPortfolioSummary, printPortfolioList, printPortfolioDetail
      performance.js  # printPerformanceWindows
      treemap.js      # printTreemap
      thesis.js       # printThesisPerformance, printUntagged, printEraAnalysis
      pipeline.js     # printPipelineList, printPipelineDetail, printPipelineEvents
      gp.js           # printGpSummary, printGpDetail
      evaluations.js  # printEvalList, printEvalDetail, printEvalValidation, printEvalDiscover
      updates.js      # printUpdatesList, printUpdateDetail, printUpdateTimeline
  db/
    schema.sql        # Postgres DDL (10 tables + thesis seed data) — reference copy; migrations are authoritative
    index.js          # Neon connection, query() and runSchema() helpers
    migrate.js        # Lightweight migration runner (schema_migrations tracking table)
    migrations/       # Numbered SQL migration files (001_initial_schema.sql, etc.)
    sync-runs.js      # withSyncRun() — wraps ingest operations with audit rows + error capture
  import/
    angellist.js      # CSV parser + importer with auto-thesis-tagging rules
    transactions.js   # AngelList transaction ledger → cash_flows
  sync/
    angellist-invites.js  # Orchestrator: raw emails → parsed → upsert → events
    parsers/
      angellist-invite.js # Pure parser + htmlToText for invite emails
  models/
    pipeline.js       # pipeline_invites CRUD + change detection + event log
    evaluations.js    # deal_evaluations CRUD, deal-log markdown parser, import from deal-log/
    updates.js        # company_updates CRUD, markdown parser (YAML frontmatter + section detection), scaffoldUpdate
  reports/            # Pure data fetchers (no formatting — return JSON-serializable objects)
    portfolio.js      # portfolioSummary, portfolioList, portfolioDetail
    performance.js    # performanceWindows — YTD, trailing 12M, vintage year, quarterly
    treemap.js        # treemapData — D3-compatible hierarchical composition data
    thesis.js         # thesisPerformance, untaggedInvestments, eraAnalysis
    pipeline.js       # pipelineList, pipelineDetail, pipelineEvents
    gp.js             # gpSummary, gpDetail
    evaluations.js    # evalList, evalDetail, evalValidate, evalDiscover
    updates.js        # updatesList, updateDetail, updateTimeline (with QoQ deltas)
  analytics/            # Python analytics sidecar (called via JSON-over-stdin/stdout)
    __init__.py
    __main__.py       # Dispatcher: routes {module, method, data} to handler functions
    kelly.py          # Kelly criterion solver — solve_kelly, size_bet, allocate_portfolio
    thesis_validation.py  # Score-to-outcome validation + data-driven thesis discovery
    test_kelly.py     # 35 standalone tests for solver math
    test_thesis_validation.py  # 62 tests for validation + discovery
  utils/
    format.js         # parseMoney, parseDate, formatMoney, formatMultiple, formatIRR
    irr.js            # Newton-Raphson XIRR solver — calculateIRR([{date, amount}]) → decimal or null
    analytics.js      # JS bridge to Python sidecar — runAnalytics(module, method, data)
    test-irr.js       # 14 unit tests for IRR calculator
    test-matching.js  # 27 tests for company name normalization + tokenization
    test-recompute.js # 10 tests for recompute math
    test-analytics.js # 6 tests for JS-Python bridge round-trip + error handling
    match.js          # matchCompanyToInvestment — fuzzy link invites → investments
    company-names.js  # normalize(), tokenize(), STOPWORDS — single source of truth for name matching
    bet-sizing.js     # Kelly criterion adapter, score-to-tier, distributions (calls runAnalytics)
    stage.js          # Stage bucket classification for pipeline analysis
```

## Historical schema overview (non-exhaustive; migrations are authoritative)

- `investments` — one row per position (unique on company_name + invest_date). `qsbs_eligible BOOLEAN` for Section 1202 tracking.
- `theses` — 4 core thesis clusters (active=true) + 8 general market tags (active=false)
- `investment_theses` — many-to-many, tracks confidence (auto/manual), tagged_by, and `weight INT DEFAULT 100` for fractional attribution across multiple theses
- `valuations` — time-series snapshots created on each CSV import
- `cash_flows` — capital calls, distributions, dividends, proceeds from AngelList transaction ledger. `fee_tax_units JSONB` for future fee/tax decomposition. `lot_investment_id` for FIFO lot tracking. Indexed on `(investment_id, flow_date)` for IRR queries.
- `deal_evaluations` — parsed from deal-log markdown files, linked to investments/pipeline_invites via fuzzy matcher. `radar eval import` ingests, `radar eval list/detail` queries.
- `company_updates` — queryable index of quarterly investor updates. Markdown files in `updates/<company-slug>/YYYY-QN.md` are the source of truth; YAML frontmatter holds metrics (arr, burn, runway, headcount, cash). Dedup key: `(company_name, quarter)`. `has_review`/`has_feedback` flags track whether the review and owner notes sections contain content. `radar updates import` re-parses, `radar updates list/detail/timeline` queries.
- `pipeline_invites` — one row per deal opportunity, dedup on `gmail_message_id` (state: invite/committed/passed/invested/refunded)
- `pipeline_events` — append-only event log per invite (status changes, field changes, invite_received)
- `sync_runs` — audit row per ingest run (source, counts, status, error_details JSONB). All ingesters wrapped via `withSyncRun()`.
- `schema_migrations` — tracks applied migration versions (version INT PK, name, applied_at)
- `gp_source` — (virtual, derived from investments.source) GP/syndicate lead analytics

## Historical example thesis clusters (not user defaults)

**Core (active):**
1. AI Infrastructure & Safety
2. Hard Tech That Reprices What's Possible
3. Intelligence for Physical Systems
4. Resilient Systems

**General market (inactive):** SaaS / Enterprise, Fintech, Crypto / Blockchain, Consumer, Food / Beverages, E-Commerce, Social, Investment Platforms

## IRR & Reporting Period Support

- **IRR (Internal Rate of Return):** Newton-Raphson XIRR solver in `src/utils/irr.js`. Computed from `cash_flows` (types: investment, distribution, refund, adjustment — excludes deposits/withdrawals) plus synthetic terminal cashflow for unrealized value at today's date. Shown at portfolio-level, per-investment, per-thesis, and per-vintage-year.
- **`--since` / `--until` flags:** Available on `portfolio summary`, `portfolio list`, and `thesis performance`. Filters by `invest_date` with parameterized SQL. IRR computation is scoped to the same date range.
- **Weighted thesis attribution:** When an investment maps to multiple theses, `weight` on `investment_theses` splits capital attribution proportionally (e.g., 50/50 for two theses). Default weight=100 preserves backward compatibility. Auto-tagging in `src/import/angellist.js` sets equal weights for multi-thesis matches.
- **QSBS lot tracking:** `portfolio detail` shows holding period in years and QSBS 5-year countdown per lot. Multi-lot investments (same company, different dates) display per-lot info.

## AngelList CSV Import Notes

- Row 1 is a confidentiality notice (skipped)
- Money fields: `"$1,000"` format — strip `$` and commas
- `"Locked"` = AngelList hasn't released valuation data → stored as NULL
- Upsert on (company_name, invest_date) — safe to re-import
- Auto-tagging rules in `THESIS_RULES` in `src/import/angellist.js`
- Some manual thesis tags exist (tagged_by='manual') — re-import won't overwrite these

## Pipeline Ingest (Gmail → pipeline_invites)

Invite emails from `portal@angellist.com` are auto-labeled `AngelList/Invites` via a Gmail filter (manually configured). The sync flow is:

1. Fetch raw messages from Gmail (via MCP tooling, Gmail API, or exported JSON) and build an array of `{ messageId, subject, from, receivedAt, html, text? }`.
2. Write the array to a JSON file and run `radarsync invites --file <path>`.
3. The orchestrator (`src/sync/angellist-invites.js`) parses each email via `parseInviteEmail`, then calls `upsertInvite` in `src/models/pipeline.js`.
4. Dedup is DB-only: `gmail_message_id UNIQUE` on `pipeline_invites`. Re-ingesting the same batch is idempotent.
5. On insert, `matchCompanyToInvestment` (`src/utils/match.js`) attempts to fuzzy-link the invite to an existing investment row.
6. Field changes on re-ingest (valuation, status, round, etc.) are recorded as rows in `pipeline_events`.

Manual Gmail filter setup (once): `from:portal@angellist.com subject:"invited you to invest"` → apply label `AngelList/Invites`.

Parser fixture: `src/sync/test-fixtures/angellist-invite-sample.html` runs a synthetic invite end-to-end without hitting the DB.

## Investor Updates (markdown → company_updates)

Quarterly updates from portfolio companies live as markdown files under `updates/<company-slug>/YYYY-QN.md`. Source of truth is the file; the `company_updates` table is a queryable index populated by `radar updates import`. File format + review workflow documented in `updates/README.md`.

Each file has three sections:
1. **From the Founders** — the raw update text (paste in)
2. **Review (Claude)** — bull/bear/net read + flagged followups (Claude appends in a conversation)
3. **Feedback** — owner's action items + questions for the founder

Frontmatter (YAML) holds the metrics that get parsed to DB columns. The `has_review` and `has_feedback` flags are derived from whether the corresponding sections contain non-placeholder content — import re-detects on every run, so editing a file and re-importing updates the flags. Review format is intentionally lighter than the investment-grading council (no Calibrator/CFO voices) — updates are monitoring, not a binary invest decision.

## Related Projects

See `CLAUDE.local.md` for paths to sibling projects (investment grading skill, deal-log, thesis reference).

## Roadmap and contributor checks

Use [docs/ROADMAP.md](docs/ROADMAP.md) for current scope and [CONTRIBUTING.md](CONTRIBUTING.md) for safe test commands. Historical speculative TODOs remain in Git history, not as instructions to implement already-shipped features. Use local PGlite for complete transactional workflows; see [database capabilities](docs/DATABASE_CAPABILITIES.md).
