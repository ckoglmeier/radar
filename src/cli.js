#!/usr/bin/env node

import { program } from 'commander';
import chalk from 'chalk';
import { readFileSync, cpSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { runSchema } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { backupDatabase } from './db/backup.js';
import { importAngelListCSV, autoTagTheses } from './import/angellist.js';
import { importTransactionLedger, recomputeInvestmentReturns } from './import/transactions.js';
import { portfolioSummary, portfolioList, portfolioDetail, portfolioByStage, portfolioByStageWithBarbell, reconcilePortfolio } from './reports/portfolio.js';
import { printPortfolioSummary, printPortfolioList, printPortfolioDetail, printReconciliation } from './cli/printers/portfolio.js';
import { thesisPerformance, untaggedInvestments, eraAnalysis, stageBreakdown } from './reports/thesis.js';
import { printThesisPerformance, printUntagged, printEraAnalysis, printStageBreakdown } from './cli/printers/thesis.js';
import { performanceWindows } from './reports/performance.js';
import { printPerformanceWindows } from './cli/printers/performance.js';
import { treemapData } from './reports/treemap.js';
import { printTreemap } from './cli/printers/treemap.js';
import { roundToStageBucket } from './utils/stage.js';
import { ingestInviteMessages } from './sync/angellist-invites.js';
import { pipelineList, pipelineDetail, pipelineEvents } from './reports/pipeline.js';
import { printPipelineList, printPipelineDetail, printPipelineEvents } from './cli/printers/pipeline.js';
import { gpSummary, gpDetail } from './reports/gp.js';
import { printGpSummary, printGpDetail } from './cli/printers/gp.js';
import { linkCashFlowToInvestment } from './models/cash-flows.js';
import { linkInviteToInvestment } from './models/pipeline.js';
import { importDealLogs } from './models/evaluations.js';
import { evalList, evalDetail, evalValidate, evalDiscover, evalReconcile } from './reports/evaluations.js';
import { printEvalList, printEvalDetail, printEvalValidation, printEvalDiscover, printEvalReconcile } from './cli/printers/evaluations.js';
import { betSizeReport } from './reports/bet-sizing.js';
import { syncCouncilScores } from './lenses/sync-council-scores.js';
import { printBetSize } from './cli/printers/bet-sizing.js';
import { exportBeancount } from './export/beancount.js';
import { getActiveLens, loadLens, listAvailableLenses, resetLensCache } from './lenses/loader.js';
import { importUpdates, scaffoldUpdate } from './models/updates.js';
import { updatesList, updateDetail, updateTimeline } from './reports/updates.js';
import { councilEvaluate } from './council/evaluate.js';
import { AgentSdkProvider } from './providers/agent-sdk-provider.js';
import { resolveAuthMode, validateAuthStartup, formatAuthStatus, probeActiveCredential } from './providers/auth-mode.js';
import { printUpdatesList, printUpdateDetail, printUpdateTimeline } from './cli/printers/updates.js';
import { reextractIntake } from './intake/reextract.js';

program
  .name('radar')
  .description("CK's private-markets radar — portfolio, pipeline, and intelligence over time")
  .version('1.0.0');

// --- Database Setup ---
program
  .command('db:setup')
  .description('Initialize database schema (runs all pending migrations)')
  .action(async () => {
    try {
      const result = await runMigrations();
      if (result.applied === 0) {
        console.log(chalk.green('\n  Database is up to date.\n'));
      } else {
        for (const m of result.migrations) console.log(chalk.dim(`  Applied: ${m}`));
        console.log(chalk.green(`\n  Database initialized — ${result.applied} migration(s) applied.\n`));
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('db:backup')
  .description('Dump all table data from the active database to a local JSON file')
  .option('--out <dir>', 'output directory', './backups')
  .action(async (opts) => {
    try {
      const result = await backupDatabase({ outDir: opts.out });
      for (const t of result.tables) {
        if (t.rows > 0) console.log(chalk.dim(`  ${String(t.rows).padStart(6)}  ${t.table}`));
      }
      console.log(chalk.green(`\n  ${result.totalRows} rows → ${result.file}\n`));
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('db:migrate')
  .description('Run pending database migrations')
  .action(async () => {
    try {
      const result = await runMigrations();
      if (result.applied === 0) {
        console.log(chalk.green('\n  Already up to date.\n'));
      } else {
        for (const m of result.migrations) console.log(chalk.dim(`  Applied: ${m}`));
        console.log(chalk.green(`\n  ${result.applied} migration(s) applied.\n`));
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('intake:reextract')
  .description('Fill missing pipeline fields from stored intake provenance documents')
  .option('--dry-run', 'Print proposed changes without writing', false)
  .action(async (opts) => {
    try {
      const results = await reextractIntake({ dryRun: opts.dryRun });
      console.log(chalk.dim(`\n  Intake re-extraction ${opts.dryRun ? '(dry run)' : '(applied)'}`));
      if (results.length === 0) {
        console.log(chalk.green('  No fillable fields found.\n'));
        return;
      }
      for (const result of results) {
        console.log(`\n  ${chalk.cyan(result.company_name)} ${chalk.dim(`#${result.id}`)}`);
        for (const [field, change] of Object.entries(result.changes)) {
          console.log(`    ${field}: ${chalk.dim('NULL')} → ${change.to}`);
        }
      }
      const fieldCount = results.reduce((sum, result) => sum + Object.keys(result.changes).length, 0);
      console.log(chalk.green(`\n  ${opts.dryRun ? 'Would fill' : 'Filled'} ${fieldCount} field(s) across ${results.length} deal(s).\n`));
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Import ---
const importCmd = program.command('import').description('Import investment data');

importCmd
  .command('angellist <csv-path>')
  .description('Import AngelList CSV export')
  .action(async (csvPath) => {
    try {
      console.log(chalk.dim(`\n  Importing from ${csvPath}...`));
      const result = await importAngelListCSV(csvPath);
      console.log(chalk.green(`\n  Import complete.`));
      console.log(`  Total records:   ${result.total}`);
      console.log(`  New investments: ${result.imported}`);
      console.log(`  Updated:         ${result.skipped}`);
      console.log(`  Thesis tags:     ${result.tagged}`);

      // Show thesis tagging summary
      const tagged = result.results.filter(r => r.theses.length > 0);
      const untagged = result.results.filter(r => r.theses.length === 0);
      console.log(chalk.dim(`\n  ${tagged.length} investments auto-tagged, ${untagged.length} untagged`));
      if (untagged.length > 0 && untagged.length <= 20) {
        console.log(chalk.dim('  Untagged: ' + untagged.map(u => u.company).join(', ')));
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

importCmd
  .command('transactions <csv-path>')
  .description('Import AngelList individual transaction ledger (cash flows)')
  .option('--recompute', 'Recompute investment returns from cash_flows after import', false)
  .action(async (csvPath, opts) => {
    try {
      console.log(chalk.dim(`\n  Importing transaction ledger from ${csvPath}...`));
      const result = await importTransactionLedger(csvPath);
      console.log(chalk.green(`\n  Import complete.`));
      console.log(`  Total rows:          ${result.total}`);
      console.log(`  Inserted:            ${result.inserted}`);
      console.log(`  Skipped (dupe):      ${result.skipped}`);
      console.log(`  Errors:              ${result.errors}`);
      console.log(`  Linked to investment: ${result.matched}`);
      if (result.unmatched_company_refs.length > 0) {
        console.log(chalk.dim(`\n  Unmatched company references (${result.unmatched_company_refs.length}):`));
        console.log(chalk.dim('  ' + result.unmatched_company_refs.join(', ')));
      }

      if (opts.recompute) {
        console.log(chalk.dim('\n  Recomputing investment returns from cash_flows...'));
        const updates = await recomputeInvestmentReturns();
        console.log(chalk.green(`  Updated ${updates.length} investments.`));
      }

      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

importCmd
  .command('recompute-stages')
  .description('Backfill stage_bucket on all investments from their round field (idempotent)')
  .action(async () => {
    try {
      const { query } = await import('./db/index.js');
      const rows = await query(`SELECT id, round FROM investments`);
      let updated = 0;
      for (const r of rows) {
        const bucket = roundToStageBucket(r.round);
        await query(`UPDATE investments SET stage_bucket = $1 WHERE id = $2`, [bucket, r.id]);
        updated++;
      }
      const counts = await query(`
        SELECT stage_bucket, COUNT(*) AS n FROM investments
        GROUP BY stage_bucket ORDER BY n DESC
      `);
      console.log(chalk.green(`\n  Updated ${updated} investments.\n`));
      for (const c of counts) {
        console.log(`  ${(c.stage_bucket || 'unknown').padEnd(14)} ${c.n}`);
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

importCmd
  .command('recompute')
  .description('Recompute investment realized/multiple from cash_flows (no new import)')
  .action(async () => {
    try {
      console.log(chalk.dim('\n  Recomputing investment returns from cash_flows...'));
      const updates = await recomputeInvestmentReturns();
      console.log(chalk.green(`  Updated ${updates.length} investments.\n`));
      for (const u of updates.sort((a, b) => (b.multiple || 0) - (a.multiple || 0)).slice(0, 20)) {
        const name = u.company_name || `#${u.investment_id}`;
        console.log(`  ${chalk.cyan(name.padEnd(32))} dist=$${u.distributions.toFixed(2).padStart(10)} refund=$${u.refunds.toFixed(2).padStart(8)} mult=${(u.multiple || 0).toFixed(2)}x`);
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Portfolio ---
const portfolioCmd = program.command('portfolio').description('Portfolio views');

portfolioCmd
  .command('summary')
  .description('Portfolio overview with key metrics')
  .option('--since <date>', 'Only include investments from this date (YYYY-MM-DD)')
  .option('--until <date>', 'Only include investments through this date (YYYY-MM-DD)')
  .action(async (opts) => {
    try {
      const data = await portfolioSummary({ since: opts.since, until: opts.until });
      printPortfolioSummary(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('list')
  .description('List all investments')
  .option('-s, --sort <field>', 'Sort by field (invest_date, invested, multiple, company_name, net_value)', 'invest_date')
  .option('--since <date>', 'Only include investments from this date (YYYY-MM-DD)')
  .option('--until <date>', 'Only include investments through this date (YYYY-MM-DD)')
  .action(async (opts) => {
    try {
      const rows = await portfolioList(opts.sort, { since: opts.since, until: opts.until });
      printPortfolioList(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('by-stage')
  .description('DPI and TVPI broken down by stage bucket with barbell roll-up')
  .action(async () => {
    try {
      const rows = await portfolioByStage();
      // Re-use the stage breakdown printer from thesis (same shape)
      const { stageLabel, stageToBarbellGroup, BARBELL_GROUPS } = await import('./utils/stage.js');
      const { formatMoney: fm, formatMultiple: fmx } = await import('./utils/format.js');
      // Build barbell roll-up inline
      const barbellMap = {};
      for (const r of rows) {
        const g = stageToBarbellGroup(r.stage_bucket);
        if (!barbellMap[g]) barbellMap[g] = { group: g, n: 0, net_invested: 0, realized: 0, total_value: 0 };
        barbellMap[g].n           += Number(r.n);
        barbellMap[g].net_invested += Number(r.net_invested || 0);
        barbellMap[g].realized    += Number(r.realized || 0);
        barbellMap[g].total_value += Number(r.total_value || 0);
      }
      const barbell = ['Early', 'Mid', 'Late', 'Growth', 'Unknown']
        .filter(g => barbellMap[g])
        .map(g => {
          const b = barbellMap[g];
          return { ...b, dpi: b.net_invested > 0 ? b.realized / b.net_invested : null, tvpi: b.net_invested > 0 ? b.total_value / b.net_invested : null };
        });

      // Annotate rows with avg_check for printer compat
      const byStage = rows.map(r => ({ ...r, deal_count: r.n, avg_check: r.n > 0 ? r.net_invested / r.n : 0 }));
      printStageBreakdown({ byStage, barbell });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('performance')
  .description('Time-windowed performance metrics (YTD, trailing 12M, vintage year, quarterly)')
  .option('-w, --window <w>', 'Show only a specific window (ytd, trailing12m, vintage, quarterly)')
  .action(async (opts) => {
    try {
      const data = await performanceWindows();
      printPerformanceWindows(data, { window: opts.window });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('treemap')
  .description('Portfolio composition data for treemap visualization')
  .option('--size-by <dim>', 'Size dimension (invested, current_value)', 'current_value')
  .option('--group-by <dim>', 'Grouping (thesis, stage, vintage, lead)', 'thesis')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    try {
      const data = await treemapData({ sizeBy: opts.sizeBy, groupBy: opts.groupBy });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        printTreemap(data);
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('detail <company>')
  .description('Detailed view of a specific investment')
  .action(async (company) => {
    try {
      const rows = await portfolioDetail(company);
      printPortfolioDetail(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('override <company> <status>')
  .description('Set (or clear) a sticky status override on an investment (status: Live|Realized|Written Off|Closing|clear)')
  .action(async (company, status) => {
    try {
      const { query } = await import('./db/index.js');

      // Resolve company via fuzzy LIKE match (same pattern as portfolio detail)
      const rows = await query(
        `SELECT id, company_name, status AS current_status, status_override FROM investments WHERE LOWER(company_name) LIKE LOWER($1) ORDER BY invest_date`,
        [`%${company}%`]
      );

      if (rows.length === 0) {
        console.error(chalk.red(`\n  No investments found matching "${company}".\n`));
        process.exit(1);
      }

      // Group by company_name to detect multi-lot situations
      const companies = [...new Set(rows.map(r => r.company_name))];
      if (companies.length > 1) {
        console.error(chalk.red(`\n  Ambiguous: "${company}" matches multiple companies: ${companies.join(', ')}\n  Use a more specific name.\n`));
        process.exit(1);
      }

      const clearing = status === 'clear';

      for (const row of rows) {
        const oldStatus = row.status_override ?? row.current_status;
        if (clearing) {
          await query(
            `UPDATE investments SET status_override = NULL WHERE id = $1`,
            [row.id]
          );
          console.log(chalk.green(`\n  ${row.company_name} (id=${row.id}): status_override cleared.`));
          console.log(chalk.dim(`  Next CSV import will restore AngelList's status (currently: ${row.current_status}).\n`));
        } else {
          await query(
            `UPDATE investments SET status_override = $1, status = $1 WHERE id = $2`,
            [status, row.id]
          );
          console.log(chalk.green(`\n  ${row.company_name} (id=${row.id}): ${oldStatus} → ${status}`));
        }
      }

      if (!clearing && rows.length > 1) {
        console.log(chalk.dim(`  (Applied to all ${rows.length} lots of ${companies[0]})\n`));
      } else if (!clearing) {
        console.log('');
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('reconcile')
  .description('Check cash_flows vs investments for balance discrepancies')
  .action(async () => {
    try {
      const data = await reconcilePortfolio();
      printReconciliation(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

portfolioCmd
  .command('link <type> <id> <investment-id>')
  .description('Manually link an orphan record to an investment (type: cashflow or invite)')
  .action(async (type, id, investmentId) => {
    try {
      const { query } = await import('./db/index.js');

      // Validate the investment exists
      const inv = await query(`SELECT id, company_name FROM investments WHERE id = $1`, [investmentId]);
      if (inv.length === 0) {
        console.error(chalk.red(`\n  Investment #${investmentId} not found.\n`));
        process.exit(1);
      }

      if (type === 'cashflow' || type === 'cf') {
        const result = await linkCashFlowToInvestment(id, investmentId);
        if (!result) {
          console.error(chalk.red(`\n  Cash flow #${id} not found.\n`));
          process.exit(1);
        }
        console.log(chalk.green(`\n  Linked cash flow #${id} (${result.type} $${Number(result.amount).toFixed(2)}, "${result.company_raw}") → ${inv[0].company_name} (#${investmentId})\n`));
      } else if (type === 'invite' || type === 'pipeline') {
        const ok = await linkInviteToInvestment(id, investmentId);
        if (!ok) {
          console.error(chalk.red(`\n  Pipeline invite #${id} not found.\n`));
          process.exit(1);
        }
        console.log(chalk.green(`\n  Linked pipeline invite #${id} → ${inv[0].company_name} (#${investmentId})\n`));
      } else {
        console.error(chalk.red(`\n  Unknown type "${type}". Use "cashflow" or "invite".\n`));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Thesis ---
const thesisCmd = program.command('thesis').description('Thesis analysis');

thesisCmd
  .command('performance')
  .description('Performance by thesis cluster')
  .option('--since <date>', 'Only include investments from this date (YYYY-MM-DD)')
  .option('--until <date>', 'Only include investments through this date (YYYY-MM-DD)')
  .action(async (opts) => {
    try {
      const rows = await thesisPerformance({ since: opts.since, until: opts.until });
      printThesisPerformance(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

thesisCmd
  .command('untagged')
  .description('Show investments not tagged to any thesis')
  .action(async () => {
    try {
      const rows = await untaggedInvestments();
      printUntagged(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

thesisCmd
  .command('stages')
  .description('DPI and TVPI by stage bucket with barbell (Early/Mid/Late) roll-up')
  .action(async () => {
    try {
      const data = await stageBreakdown();
      printStageBreakdown(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

thesisCmd
  .command('eras')
  .description('Exploration vs Conviction era comparison')
  .action(async () => {
    try {
      const rows = await eraAnalysis();
      printEraAnalysis(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Sync ---
const syncCmd = program.command('sync').description('Sync external data sources');

syncCmd
  .command('invites')
  .description('Ingest AngelList invite emails from a JSON file (array of {messageId, subject, from, receivedAt, text, html})')
  .requiredOption('-f, --file <path>', 'Path to JSON file of raw Gmail messages')
  .action(async (opts) => {
    try {
      const raw = JSON.parse(readFileSync(opts.file, 'utf-8'));
      if (!Array.isArray(raw)) throw new Error('Input file must contain a JSON array');
      console.log(chalk.dim(`\n  Ingesting ${raw.length} message(s) from ${opts.file}...`));
      const stats = await ingestInviteMessages(raw);
      console.log(chalk.green(`\n  Sync run #${stats.runId} complete.`));
      console.log(`  Seen:      ${stats.seen}`);
      console.log(`  New:       ${stats.new}`);
      console.log(`  Changed:   ${stats.changed}`);
      console.log(`  Unchanged: ${stats.unchanged}`);
      console.log(`  Errors:    ${stats.errors}`);

      if (stats.inserted.length > 0) {
        console.log(chalk.dim('\n  New invites:'));
        for (const i of stats.inserted) {
          const matchTag = i.match === 'exact' || i.match === 'token'
            ? chalk.green(`[linked:${i.match}]`)
            : chalk.dim(`[${i.match}]`);
          console.log(`    ${chalk.cyan(i.company)} — ${i.lead || '—'} ${matchTag}`);
        }
      }
      if (stats.updated.length > 0) {
        console.log(chalk.dim('\n  Changed invites:'));
        for (const u of stats.updated) {
          console.log(`    ${chalk.yellow(u.company)} — ${u.changes.join(', ')}`);
        }
      }
      if (stats.errors > 0) {
        console.log(chalk.red('\n  Errors:'));
        for (const e of stats.errorDetails) {
          console.log(`    ${e.subject || e.messageId}: ${e.error}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Pipeline ---
const pipelineCmd = program.command('pipeline').description('Pipeline invite tracking');

pipelineCmd
  .command('list')
  .description('List pipeline invites')
  .option('-s, --status <status>', 'Filter by status (invite, committed, passed, invested, refunded)')
  .option('-l, --limit <n>', 'Max rows to show', '100')
  .action(async (opts) => {
    try {
      const rows = await pipelineList({ status: opts.status, limit: parseInt(opts.limit, 10) });
      printPipelineList(rows, { status: opts.status });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

pipelineCmd
  .command('detail <slug>')
  .description('Show full detail for a pipeline invite')
  .action(async (slug) => {
    try {
      const invite = await pipelineDetail(slug);
      printPipelineDetail(invite, { notFoundSlug: slug });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

pipelineCmd
  .command('events <slug>')
  .description('Show event log for a pipeline invite')
  .action(async (slug) => {
    try {
      const data = await pipelineEvents(slug);
      printPipelineEvents(data, { notFoundSlug: slug });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- GP / Source Quality ---
const gpCmd = program.command('gp').description('GP / source quality analytics');

gpCmd
  .command('summary')
  .description('Overview of all GPs ranked by deployed capital')
  .action(async () => {
    try {
      const data = await gpSummary();
      printGpSummary(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

gpCmd
  .command('detail <name>')
  .description('Deep dive on a single GP / syndicate lead')
  .action(async (name) => {
    try {
      const data = await gpDetail(name);
      printGpDetail(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Evaluations ---
const evalCmd = program.command('eval').description('Deal evaluation grading');

evalCmd
  .command('import')
  .description('Import deal-log markdown files from investment-grading/deal-log/')
  .option('--mode <mode>', 'Rubric mode for imported evals: standard (default) or secondary', 'standard')
  .action(async (opts) => {
    try {
      if (!process.env.DEAL_LOG_DIR) {
        console.error(chalk.red(`\n  Error: DEAL_LOG_DIR is not set. Add it to .env (path to your deal-log markdown directory).\n`));
        process.exit(1);
      }
      const dealLogDir = process.env.DEAL_LOG_DIR;
      console.log(chalk.dim(`\n  Importing deal evaluations from ${dealLogDir}...`));
      const result = await importDealLogs(undefined, { mode: opts.mode });
      console.log(chalk.green(`\n  Import complete.`));
      console.log(`  Total files:  ${result.total}`);
      console.log(`  Imported:     ${result.imported}`);
      console.log(`  Skipped:      ${result.skipped}`);
      console.log(`  Errors:       ${result.errors}`);

      if (result.imported > 0) {
        console.log(chalk.dim('\n  Imported:'));
        for (const d of result.details.filter(d => d.status === 'imported')) {
          let linked;
          if (d.investment_id) linked = chalk.green('[investment]');
          else if (d.pipeline_invite_id) linked = chalk.cyan('[pipeline]');
          else linked = chalk.dim('[unmatched]');
          const score = d.total_score != null ? `${d.total_score}/50` : '—';
          console.log(`    ${chalk.cyan(d.company)} — ${score} ${d.verdict || '—'} ${linked}`);
        }
      }
      if (result.errors > 0) {
        console.log(chalk.red('\n  Errors:'));
        for (const d of result.details.filter(d => d.status === 'error' || d.status === 'parse_error')) {
          console.log(`    ${d.file}: ${d.error}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('list')
  .description('List all deal evaluations')
  .action(async () => {
    try {
      const rows = await evalList();
      printEvalList(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('detail <company>')
  .description('Show detail for a single evaluation')
  .action(async (company) => {
    try {
      const row = await evalDetail(company);
      printEvalDetail(row, { notFoundSearch: company });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('validate')
  .description('Validate rubric: does score predict returns?')
  .option('--since <date>', 'Only investments on or after this date')
  .option('--until <date>', 'Only investments on or before this date')
  .option('--mode <mode>', 'Rubric mode filter: standard (default) or secondary', 'standard')
  .action(async (opts) => {
    try {
      const data = await evalValidate(opts);
      printEvalValidation(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('discover')
  .description('Discover optimal thesis clusters from investment outcomes')
  .option('--since <date>', 'Only investments on or after this date')
  .option('--until <date>', 'Only investments on or before this date')
  .action(async (opts) => {
    try {
      const data = await evalDiscover(opts);
      printEvalDiscover(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('sync-council')
  .description('Sync council scores from deal-log markdown files into deal_evaluations')
  .action(async () => {
    try {
      console.log(chalk.dim('\n  Syncing council scores from deal-log files...'));
      const result = await syncCouncilScores();
      console.log(chalk.green(`\n  Sync complete.`));
      console.log(`  Total files:  ${result.total}`);
      console.log(`  Updated:      ${result.updated}`);
      console.log(`  Skipped:      ${result.skipped}`);
      console.log(`  No data:      ${result.noData}`);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

evalCmd
  .command('reconcile')
  .description('Find pipeline passes that scored high in deal evaluations — missed opportunity check')
  .option('--threshold <n>', 'Minimum score to flag (default: 39)', '39')
  .action(async (opts) => {
    try {
      const data = await evalReconcile({ threshold: Number(opts.threshold) });
      printEvalReconcile(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Bet Sizing ---
program
  .command('bet-size <company>')
  .description('Kelly-based check sizing for a graded company')
  .option('--score <n>', 'Override rubric score (0-50)')
  .option('--round <r>', 'Override round (e.g. "Seed", "Series A")')
  .option('--min-check <n>', 'Minimum check size in dollars', '2000')
  .option('--late-stage-approved', 'Mark as late-stage approved (45+ or carve-out)')
  .option('--distribution <json>', 'Override distribution as JSON: {"outcomes":[...],"probs":[...]}')
  .action(async (company, opts) => {
    try {
      const data = await betSizeReport(company, opts);
      printBetSize(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Council ---
program
  .command('council <slug>')
  .description('Run the investment council on a pipeline deal (headless; writes + ingests a deal-log)')
  .option('--dry-run', 'Assemble and preview the session without calling the model')
  .option('--deal-log-dir <path>', 'Where to write the deal-log artifact (default: $DEAL_LOG_DIR)')
  .action(async (slug, opts) => {
    try {
      const invite = await pipelineDetail(slug);
      if (!invite) {
        console.error(chalk.red(`\n  No pipeline deal found for slug "${slug}".\n`));
        process.exit(1);
      }
      const deal = {
        company: invite.company_name,
        market: invite.market,
        round: invite.round,
        valuation_usd: invite.valuation_usd,
        lead_gp: invite.lead,
        carry_pct: invite.carry_pct,
        min_investment: invite.min_investment,
        allocation_usd: invite.allocation_usd,
        source: invite.source,
        notes: invite.notes || invite.raw_message || undefined,
      };

      if (opts.dryRun) {
        const out = await councilEvaluate(deal, { dryRun: true });
        console.log(chalk.bold(`\n  Council dry run — ${deal.company}\n`));
        console.log(`  Auth mode:   ${out.authMode}`);
        console.log(`  Calibration: ${out.calibrationMaturity}`);
        console.log(`  Models:      ${JSON.stringify(out.modelPolicy)}`);
        console.log(`  Tools:       ${out.request.tools.join(', ')}`);
        console.log(`  Subagents:   ${Object.keys(out.request.agents).join(', ')}`);
        console.log(`  Context:     ${out.request.context.length} chars assembled`);
        console.log(chalk.dim(`\n  (dry run — no model call, no deal-log written)\n`));
        return;
      }

      const dealLogDir = opts.dealLogDir || process.env.DEAL_LOG_DIR;
      if (!dealLogDir) {
        console.error(chalk.red('\n  Set --deal-log-dir or $DEAL_LOG_DIR (where the deal-log artifact is written).\n'));
        process.exit(1);
      }

      const authMode = resolveAuthMode(process.env);
      const provider = new AgentSdkProvider({ authMode, cwd: dealLogDir });
      const buildFallback = () => new AgentSdkProvider({ authMode: 'api_key', cwd: dealLogDir });

      console.log(chalk.dim(`\n  Running council (${authMode}) on ${deal.company}…\n`));
      const out = await councilEvaluate(deal, { provider, buildFallback, dealLogDir, env: process.env });
      if (out.usedFallback) {
        console.log(chalk.yellow(`  ⚠ fell back to api_key after a ${out.primaryErrorKind} condition on the subscription`));
      }

      const imp = await importDealLogs(dealLogDir);
      console.log(chalk.green(`  ✓ graded and ingested (${imp.imported} imported, ${imp.skipped} already present)`));
      console.log(`  Calibration: ${out.calibrationMaturity} · session: ${out.result.sessionId || 'n/a'}\n`);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program
  .command('auth:status')
  .description('Show the model auth mode; --probe reports the actually-winning credential')
  .option('--probe', 'Run a live probe (spawns a session; needs a real credential)')
  .action(async (opts) => {
    try {
      const { mode, selection } = validateAuthStartup(process.env);
      let apiKeySource = null;
      if (opts.probe) {
        apiKeySource = await probeActiveCredential(new AgentSdkProvider({ authMode: mode }));
      }
      console.log('\n  ' + formatAuthStatus(mode, selection, apiKeySource) + '\n');
    } catch (err) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Export ---
program
  .command('export:beancount [output-path]')
  .description('Export portfolio as a Beancount plain-text ledger file')
  .action(async (outputPath) => {
    try {
      console.log(chalk.dim('\n  Generating Beancount ledger...'));
      const result = await exportBeancount(outputPath);
      console.log(chalk.green(`\n  Export complete: ${result.path}`));
      console.log(`  Investments:   ${result.investments}`);
      console.log(`  Transactions:  ${result.transactions}`);
      console.log(`  Valuations:    ${result.valuations}`);
      console.log(`  Lines:         ${result.lines}`);
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Lens Management ---
const lens = program
  .command('lens')
  .description('Manage analytical lenses (thesis frameworks, rubrics, calibration data)');

lens
  .command('active')
  .description('Show the active lens and its configuration')
  .action(() => {
    try {
      const active = getActiveLens();
      const m = active.manifest;
      console.log(chalk.bold(`\n  Active Lens: ${m.name} v${m.version}`));
      console.log(chalk.dim(`  ${m.description}`));
      console.log(`\n  Author:     ${m.author?.name || 'unknown'}${m.author?.handle ? ` (@${m.author.handle})` : ''}`);
      console.log(`  Theses:     ${active.theses.filter(t => t.active).length} active`);
      console.log(`  License:    ${m.license || 'unspecified'}`);
      console.log(`  Created:    ${m.created || 'unknown'}`);
      console.log(`  Location:   ${active.dir}`);

      console.log(chalk.bold('\n  Thesis Clusters:'));
      for (const t of active.theses.filter(t => t.active)) {
        console.log(`    ${chalk.cyan(t.name)} (${t.id})`);
      }

      if (active.distributions?.bands) {
        const bands = Object.keys(active.distributions.bands);
        console.log(chalk.bold('\n  Calibrated Bands:'));
        for (const band of bands) {
          const b = active.distributions.bands[band];
          const ev = b.outcomes.reduce((s, o, i) => s + o * b.probs[i], 0);
          console.log(`    ${band.padEnd(6)} EV=${ev.toFixed(1)}x`);
        }
      }

      if (active.rubric) {
        const dims = active.rubric.sections.flatMap(s => s.dimensions);
        console.log(chalk.bold(`\n  Rubric: ${dims.length} dimensions, ${active.rubric.total_points} points total`));
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

lens
  .command('list')
  .description('List available lenses')
  .action(() => {
    try {
      const lenses = listAvailableLenses();
      const active = getActiveLens();
      if (lenses.length === 0) {
        console.log(chalk.dim('\n  No lenses found.\n'));
        return;
      }
      console.log(chalk.bold('\n  Available Lenses:\n'));
      for (const l of lenses) {
        const isActive = l.name === active.manifest.name;
        const marker = isActive ? chalk.green(' (active)') : '';
        console.log(`  ${chalk.cyan(l.name)} v${l.version}${marker}`);
        console.log(chalk.dim(`    ${l.description}`));
        console.log(`    Author: ${l.author?.name || 'unknown'} · Theses: ${l.thesis_count} · License: ${l.license || 'unspecified'}`);
        console.log('');
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

lens
  .command('inspect <path>')
  .description('Inspect a lens directory without installing it')
  .action((lensPath) => {
    try {
      const inspected = loadLens(lensPath);
      const m = inspected.manifest;
      console.log(chalk.bold(`\n  Lens: ${m.name} v${m.version}`));
      console.log(chalk.dim(`  ${m.description}\n`));
      console.log(`  Author:       ${m.author?.name || 'unknown'}`);
      console.log(`  License:      ${m.license || 'unspecified'}`);
      console.log(`  Theses:       ${inspected.theses.length}`);
      console.log(`  Has rubric:   ${inspected.rubric ? 'yes' : 'no'}`);
      console.log(`  Has tagging:  ${inspected.taggingRules?.rules?.length ? `yes (${inspected.taggingRules.rules.length} rules)` : 'no'}`);
      console.log(`  Has GP tiers: ${inspected.gpTiers?.tiers?.length ? 'yes' : 'no'}`);
      console.log(`  Has kills:    ${inspected.killCriteria?.automatic_pass?.length ? 'yes' : 'no'}`);
      console.log(`  Has dists:    ${inspected.distributions?.bands ? `yes (${Object.keys(inspected.distributions.bands).length} bands)` : 'no'}`);
      console.log(`  Has rounds:   ${inspected.roundParams?.rounds ? 'yes' : 'no'}`);

      if (inspected.theses.length > 0) {
        console.log(chalk.bold('\n  Theses:'));
        for (const t of inspected.theses) {
          console.log(`    ${chalk.cyan(t.name)} ${t.active ? '' : chalk.dim('(inactive)')}`);
          if (t.belief) console.log(chalk.dim(`      ${t.belief.slice(0, 100)}${t.belief.length > 100 ? '...' : ''}`));
        }
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error loading lens: ${err.message}\n`));
      process.exit(1);
    }
  });

lens
  .command('init [name]')
  .description('Scaffold a new blank lens from the built-in template')
  .action((name) => {
    const lensName = name || 'my-lens';
    if (!/^[a-zA-Z0-9_-]+$/.test(lensName)) {
      console.error(chalk.red(`\n  Unsafe lens name: "${lensName}" — only alphanumeric, hyphens, underscores allowed\n`));
      process.exit(1);
    }
    const templateDir = join(process.cwd(), 'lenses', '_template');
    const destDir = join(process.cwd(), 'lenses', lensName);

    if (!existsSync(templateDir)) {
      console.error(chalk.red(`\n  Template not found at ${templateDir}\n`));
      process.exit(1);
    }
    if (existsSync(destDir)) {
      console.error(chalk.red(`\n  Directory already exists: ${destDir}\n`));
      process.exit(1);
    }

    cpSync(templateDir, destDir, { recursive: true });

    // Patch manifest with the provided name and today's date
    const manifestPath = join(destDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    manifest.name = lensName;
    manifest.created = new Date().toISOString().slice(0, 10);
    manifest.updated = manifest.created;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    console.log(chalk.bold(`\n  Lens scaffolded: lenses/${lensName}/\n`));
    console.log('  Next steps:');
    console.log(chalk.dim('  1. Edit lenses/' + lensName + '/manifest.json — fill in name, description, author'));
    console.log(chalk.dim('  2. Edit theses/*.json — define your thesis clusters'));
    console.log(chalk.dim('  3. Edit tagging-rules.json — add market/company patterns'));
    console.log(chalk.dim('  4. Run: radar lens install lenses/' + lensName + ' --activate'));
    console.log('');
  });

lens
  .command('install <path>')
  .description('Install a lens from a local directory and optionally activate it')
  .option('--global', 'Install to ~/.radar/lenses/ instead of project-local lenses/')
  .option('--activate', 'Set as the active lens after installing (default: true)', true)
  .action((lensPath, opts) => {
    const resolved = resolve(lensPath);
    let installed;
    try {
      installed = loadLens(resolved);
    } catch (err) {
      console.error(chalk.red(`\n  Invalid lens at ${resolved}: ${err.message}\n`));
      process.exit(1);
    }

    const lensId = installed.manifest.name;

    // Validate lens name for filesystem safety
    if (!/^[a-zA-Z0-9_-]+$/.test(lensId)) {
      console.error(chalk.red(`\n  Unsafe lens name in manifest: "${lensId}" — only alphanumeric, hyphens, underscores allowed\n`));
      process.exit(1);
    }

    const homeDir = process.env.HOME || process.env.USERPROFILE;
    const destDir = opts.global
      ? join(homeDir, '.radar', 'lenses', lensId)
      : join(process.cwd(), 'lenses', lensId);

    // Don't overwrite unless source and dest are different directories
    if (resolve(resolved) !== resolve(destDir)) {
      if (existsSync(destDir)) {
        cpSync(resolved, destDir, { recursive: true, force: true });
      } else {
        mkdirSync(destDir, { recursive: true });
        cpSync(resolved, destDir, { recursive: true });
      }
    }

    if (opts.activate) {
      const configDir = opts.global
        ? join(homeDir, '.radar')
        : join(process.cwd(), '.radar');
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, 'config.json');
      let config = {};
      if (existsSync(configPath)) {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
      }
      // Write just the lens name — loader joins cwd + 'lenses' + this value
      config.active_lens = lensId;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      resetLensCache();
    }

    const m = installed.manifest;
    console.log(chalk.bold(`\n  Installed: ${m.name} v${m.version}`));
    console.log(`  Location:  ${destDir}`);
    if (opts.activate) console.log(chalk.green('  Active:    yes'));
    console.log('');
  });

lens
  .command('export')
  .description('Export the active lens to a versioned directory')
  .option('--out <dir>', 'Output directory (default: lenses/<name>-export-YYYY-MM-DD)')
  .action((opts) => {
    try {
      const active = getActiveLens();
      const today = new Date().toISOString().slice(0, 10);
      const outDir = opts.out
        ? resolve(opts.out)
        : join(process.cwd(), 'lenses', `${active.manifest.name}-export-${today}`);

      if (existsSync(outDir)) {
        console.error(chalk.red(`\n  Output directory already exists: ${outDir}\n`));
        process.exit(1);
      }

      mkdirSync(outDir, { recursive: true });
      cpSync(active.dir, outDir, { recursive: true });

      console.log(chalk.bold(`\n  Exported: ${active.manifest.name} v${active.manifest.version}`));
      console.log(`  Output:   ${outDir}`);
      console.log(chalk.dim('\n  To install this export: radar lens install ' + outDir));
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

lens
  .command('retag')
  .description('Re-run tagging rules from the active lens against all investments')
  .option('--dry-run', 'Show what would change without writing to DB')
  .action(async (opts) => {
    try {
      const { query } = await import('./db/index.js');

      const thesesRows = await query('SELECT id, name FROM theses');
      const thesisMap = {};
      for (const t of thesesRows) thesisMap[t.name] = t.id;

      const investments = await query('SELECT id, company_name, market FROM investments ORDER BY id');

      // Batch-load all existing tags to avoid N+1
      const existingTags = await query('SELECT investment_id, thesis_id FROM investment_theses');
      const tagSet = new Set(existingTags.map(t => `${t.investment_id}:${t.thesis_id}`));

      let newTags = 0;
      let alreadyTagged = 0;
      const changes = [];
      const inserts = [];

      for (const inv of investments) {
        const matches = autoTagTheses(inv.company_name, inv.market);
        if (matches.length === 0) continue;

        const weight = matches.length > 1 ? Math.round(100 / matches.length) : 100;
        for (let i = 0; i < matches.length; i++) {
          const thesisId = thesisMap[matches[i]];
          if (!thesisId) continue;

          if (tagSet.has(`${inv.id}:${thesisId}`)) {
            alreadyTagged++;
          } else {
            newTags++;
            changes.push({ company: inv.company_name, thesis: matches[i] });
            inserts.push([inv.id, thesisId, i === 0, weight]);
          }
        }
      }

      if (!opts.dryRun && inserts.length > 0) {
        for (const [investmentId, thesisId, isPrimary, weight] of inserts) {
          await query(
            `INSERT INTO investment_theses (investment_id, thesis_id, is_primary, confidence, tagged_by, weight)
             VALUES ($1, $2, $3, 'auto', 'system', $4)
             ON CONFLICT DO NOTHING`,
            [investmentId, thesisId, isPrimary, weight]
          );
        }
      }

      console.log(chalk.bold('\n  Retag complete:') + (opts.dryRun ? chalk.yellow(' (dry run)') : ''));
      console.log(`  Investments:   ${investments.length}`);
      console.log(`  New tags:      ${chalk.green(newTags)}`);
      console.log(`  Already tagged: ${alreadyTagged}`);
      if (changes.length > 0) {
        console.log(chalk.bold('\n  New tags:'));
        for (const c of changes) {
          console.log(`    ${c.company} → ${chalk.cyan(c.thesis)}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// --- Investor Updates ---
const updatesCmd = program.command('updates').description('Portfolio company quarterly updates');

updatesCmd
  .command('new <company>')
  .description('Scaffold a new update markdown file')
  .requiredOption('-q, --quarter <q>', 'Quarter (e.g. "Q1 2026")')
  .option('-d, --date <date>', 'Date received (YYYY-MM-DD, default: today)')
  .action(async (company, opts) => {
    try {
      const { path, created } = scaffoldUpdate({ company, quarter: opts.quarter, date: opts.date });
      if (created) {
        console.log(chalk.green(`\n  Created ${path}`));
        console.log(chalk.dim(`  Edit frontmatter metrics, paste the update into "From the Founders", then run: radar updates import\n`));
      } else {
        console.log(chalk.yellow(`\n  File already exists: ${path}\n`));
      }
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

updatesCmd
  .command('import [dir]')
  .description('Parse updates/*.md and upsert into company_updates')
  .action(async (dir) => {
    try {
      const result = await importUpdates(dir);
      console.log(chalk.green(`\n  Import complete.`));
      console.log(`  Total files:  ${result.total}`);
      console.log(`  Imported:     ${chalk.green(result.imported)}`);
      console.log(`  Updated:      ${chalk.cyan(result.updated)}`);
      console.log(`  Errors:       ${result.errors > 0 ? chalk.red(result.errors) : result.errors}`);
      if (result.errors > 0) {
        console.log(chalk.bold('\n  Errors:'));
        for (const d of result.details.filter(d => d.status === 'error' || d.status === 'parse_error')) {
          console.log(`    ${d.file}: ${d.error}`);
        }
      }
      console.log('');
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

updatesCmd
  .command('list')
  .description('List investor updates')
  .option('-c, --company <name>', 'Filter by company name')
  .option('--needs-review', 'Only show updates without Claude review')
  .option('--needs-feedback', 'Only show updates without CK feedback')
  .option('-l, --limit <n>', 'Max rows', '50')
  .action(async (opts) => {
    try {
      const rows = await updatesList({
        companyName: opts.company,
        limit: parseInt(opts.limit, 10),
        missingReview: !!opts.needsReview,
        missingFeedback: !!opts.needsFeedback,
      });
      printUpdatesList(rows);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

updatesCmd
  .command('detail <id>')
  .description('Show full detail + rendered markdown for an update')
  .action(async (id) => {
    try {
      const row = await updateDetail(parseInt(id, 10));
      printUpdateDetail(row, { notFoundId: id });
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

updatesCmd
  .command('timeline <company>')
  .description('Show metric evolution across updates for a company')
  .action(async (company) => {
    try {
      const data = await updateTimeline(company);
      printUpdateTimeline(data);
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${err.message}\n`));
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
// Close any embedded database so the process exits cleanly (PGlite holds
// the event loop open otherwise). No-op for network drivers.
const { closeDb } = await import('./db/index.js');
await closeDb();
