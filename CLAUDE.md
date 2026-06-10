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

A private-markets radar CLI for tracking an angel investment portfolio, ingesting deal pipeline from Gmail, and building searchable intelligence across everything you see. Backed by Neon (serverless Postgres).

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
- **Database:** Neon (Postgres) via `@neondatabase/serverless` — connection string in `.env`
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

## Database Schema (12 tables)

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

## Thesis Clusters

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

## TODO

### Priority: High Impact
- [ ] Unlock locked valuations — some investments show NULL valuation; estimate from last known round prices
- [x] GP/source quality analytics — `radar gp summary` and `radar gp detail <name>` implemented
- [x] Investment grading integration — `radar eval import` parses deal-log markdown into deal_evaluations, links to investments/pipeline via fuzzy matcher. `radar eval list/detail` for querying.
- [ ] Partial exit tracking — surface partial exits with actual proceeds once data is available

### Priority: Strategic
- [ ] Public deal submission page — a lightweight public webpage where founders can submit a deck or AngelList URL and get a quick read on fit against your theses. Same intake pipeline used for inbound deals. Goal: widen top-of-funnel sourcing, capture structured data on every submission (stage, sector, thesis fit), and feed submissions into the same pipeline_invites + deal_evaluations flow Radar already uses. Stack TBD (lean toward simple — same direction as the web GUI). Consider: auto-scoring via the investment grading skill on submission, a "not a fit" auto-response for obvious misses, and a dashboard view of submission volume by thesis/stage over time.
- [ ] Missed opportunities audit — pull prospective investments that were passed on (pipeline_invites with status=passed, plus any deal-log files with Pass verdicts) and evaluate whether any became significant outcomes. Identify misses under the current framework and ask: would the rubric have caught them, or is there a pattern in what we're filtering out?
- [ ] Optimal budget analysis — model what total annual deployment amount maximizes risk-adjusted returns given the check-sizing framework. Account for: expected deal count per tier per year, concentration risk, and the soft-cap nature of annual targets.
- [ ] Forward-pipeline-adjusted sizing — the Kelly solver (`src/analytics/kelly.py`) treats `annual_budget_remaining` as *capacity*, not *pace*. It doesn't know that writing a check now displaces expected deals later in the year. Add a `forward_pipeline_reserve` parameter to `PortfolioState`: at time T in the year, reserve Y% of remaining budget for expected future deals based on historical rate (from `eval validate` deal/year by band). Surface the reserve calculation as a new lens.
- [ ] Investment grading skill review — after running the skill on many deals, assess: (1) are scores being calibrated correctly or drifting optimistic/pessimistic? (2) should we add a "council" format (bear/bull/devil's advocate voices scoring independently before synthesis)? (3) are the rubric anchors still right for current market conditions? (4) what patterns are emerging across passed vs. considered deals that should update the kill criteria or GP tier list? Run this as a meta-analysis against the full deal-log.
- [x] Architecture review — matcher N+1 fix (universe param), sync_runs audit wrapper, company-names.js extraction, reports/printers split (web GUI prerequisite). Deferred: golden tests, investments_effective view, Python analytics sidecar.
- [ ] Build a web GUI — interface to view portfolio, pipeline, and deal analyses in a browser. Should surface: portfolio summary/list/detail, pipeline list/detail/events, and deal-log markdown renders. Stack TBD (lean toward simple: Next.js or plain Express + htmx, nothing that requires a build step for a single-user tool). **Prerequisite met:** reports/printers split is done — all report functions return pure data, printers are CLI-only in `src/cli/printers/`. **Design constraint:** thesis definitions and grading rubrics must be stored as exportable plain files (JSON/MD), not only DB rows — this is the "config-as-shareable-unit" foundation for the community layer.
- [ ] Sonar (company tracker) — proactive deal sourcing and watchlist. Two modes: (1) `/sonar <market/thesis area>` slash command researches a landscape, identifies promising startups, and surfaces candidates — cross-references portfolio (already invested?), pipeline (already seen?), and thesis fit (scores well?). Output: ranked candidate list with company, stage, lead investors, thesis fit, and suggested next action (watch, reach out, wait for invite). (2) Persistent watchlist — add companies by name or URL to monitor like a stock ticker. Track key signals: funding rounds, valuation changes, leadership moves, product launches. CLI: `radar sonar search <area>`, `radar sonar watch add <company>`, `radar sonar watch list`, `radar sonar watch detail <company>`. Distinct from pipeline_invites (inbound deal invitations) — this is the outbound counterpart to `/new-prospect`.
- [ ] Connector plugin architecture (Phase 2-3) — model layer extraction done (upsertInvestment, createValuationSnapshot, insertCashFlow). Next: create `src/connectors/` with three resource-type interfaces (holdings, transactions, pipeline), shared runners, and registry. Wrap existing AngelList importers as first connector, then add a second. Design doc: `steampipe_research.md` + plan in `.claude/plans/`.
- [ ] Concentration analysis — top positions as % of portfolio value, track intentional vs accidental concentration
- [x] Vintage year analysis — implemented as `radar portfolio performance` with per-vintage-year TVPI/DPI and quarterly cash flow views. Also supports YTD and trailing 12M windows.
- [ ] Mark-to-market (Phase 5) — re-import CSVs to track valuation changes over time, manual overrides for non-AngelList
- [x] Historical thesis validation — `radar eval validate` (score-to-outcome correlation, Spearman ρ, per-band performance, calibration, misses) + `radar eval discover` (data-driven cluster analysis, active thesis assessment, promotion candidates, combination scan). Both support `--since`/`--until` for era-scoped analysis.
- [ ] Community layer (Obsidian-inspired) — when Radar opens to external users: (1) thesis definitions + grading rubrics stored as plain JSON/MD files, shareable via Git ("config-as-shareable-unit"); (2) public GitHub repo with a manifest file for community-contributed configs (thesis templates, sector models, GP tier lists) — PRs for submissions, zero infra; (3) Catalyst-style one-time supporter tiers granting early access + contributor identity, not feature unlocks; (4) contributor badge/role system from day one. Prerequisite: web GUI.

### Priority: Future — Multi-user / Hosted Mode
If Radar becomes a hosted multi-user product, these are prerequisites. Not needed for single-user CLI/web GUI. Inspired by Ghostfolio's multi-tenant architecture (studied ideas only — no code borrowed due to AGPL-3.0 license).
- [ ] Auth — OAuth or magic link (avoid WebAuthn complexity for v1)
- [ ] Tenant isolation — two approaches: (a) row-level `user_id` FK on every table + scoped queries, or (b) per-user Postgres schema (Actual Budget's model — each user gets their own schema, avoids FK/scoping complexity). Evaluate tradeoffs when multi-user work begins.
- [ ] API layer — Express or Hono wrapping existing report functions with auth middleware. Reports already return pure JSON — just add routing + guards
- [ ] Frontend — the web GUI TODO becomes multi-tenant-aware (user-scoped data, login flow)
- [x] Schema migrations — `src/db/migrate.js` with numbered `.sql` files in `src/db/migrations/`. `radar db:migrate` runs pending migrations. Existing schema is migration 001; computed columns and sync_runs columns extracted to 002/003. Migration 006 adds PP-inspired columns (weight, fee_tax_units, lot_investment_id, qsbs_eligible, cash_flows index).
- [ ] Background job queue — pg-boss (Postgres-native) for concurrent ingest operations (Gmail sync per user). Single-user sync is fine synchronous
- [ ] Rate limiting + abuse protection
- [ ] Billing — Stripe integration, deferred until product-market fit is clear

### Priority: Backlog
- [ ] Fix the Gmail grabber — the `mcp__gmail_*` connector in Claude Code returned `net::ERR_FAILED` on every call during the first end-to-end pipeline test. Until it's reliable, the ingest flow is HTML-file-based only. Options: reconnect/reauthorize the existing MCP server, switch to a Node-side Gmail API client (google-auth-library + googleapis) invoked directly from `radarsync invites`, or export `.mbox` → JSON as a workaround. Goal: `radarsync invites` (no `--file`) pulls everything under `AngelList/Invites` since the last successful `sync_runs` row.
- [ ] Activity feed ingest from Gmail — same pattern as pipeline invites (investor updates, distribution notices, capital calls). Dropped from initial build to focus on pipeline. Cash events should land in `cash_flows`.
- [ ] Pipeline detail-page enrichment — `radarpipeline enrich <slug>` pulls the AngelList detail page (via browser scrape or detail URL fetch) so the grading skill has full deal context.
- [ ] Pipeline state reconciliation — browser scrape of `/pipeline/invites` to detect passes/refunds (emails don't announce status changes).
- [ ] Cash flow tracking — record capital calls, distributions, dividends, sale proceeds
- [ ] Cash flow forecasting (planning layer, separate from ledger) — a `cash_flow_projections` table for forward-looking cash planning, distinct from the factual `cash_flows` ledger. Design intent: two categories of events. **Inflows:** scheduled distributions from fund positions, pending distributions from partial exits, return-of-capital as positions exit, future platform distributions. **Outflows:** uncalled capital from fund commitments, estimated tax obligations on realized gains (derivable from `cash_flows` by year, net of QSBS-eligible positions held 5+ years), annual deployment budget. Tax logic must handle both gains (obligation) and losses (offsets/harvesting opportunities). CLI target: `radar cashflow forecast [--months 24]` showing net position over a rolling window. Projections link to `cash_flows` via `fulfilled_at` timestamp when the actual event lands.
- [ ] Integrate fund investments — non-AngelList fund-style positions tracked as funds (NAV-based or per-unit). See `CLAUDE.local.md` for specific fund names and amounts.
- [ ] Import pre-exploration era investments from crowd platforms
- [ ] Get outcome data from crowdfunding platforms (Republic, StartEngine, WeFunder) — positions may be written off but some may have had exits, conversions, or partial returns. Log into each platform and pull current status, any distributions received, and final marks. Update investments rows accordingly.
- [ ] Integrate real estate crowdfunding platform — positions and returns not yet in Radar. Pull account history and import as a fund-style position (separate asset class from angel investments).
- [ ] Markdown report export — generate portfolio reports to `reports/` directory
- [ ] Pipeline PDF parsing — extract data from AngelList pipeline export
- [ ] Deck/document ingestion — PDF parsing via Claude API for inbound opportunities
