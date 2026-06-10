// Pretty-printers for GP / source quality reports.
import chalk from 'chalk';
import { formatMoney, formatMultiple } from '../../utils/format.js';
import { stageLabel } from '../../utils/stage.js';

export function printGpSummary({ rows, bestMap }) {
  console.log(chalk.bold('\n  GP / Source Quality Analytics'));
  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(chalk.dim(
    `  ${'GP / Lead'.padEnd(28)} ${'Deals'.padStart(5)} ${'Deployed'.padStart(12)} ${'Avg Check'.padStart(12)} ${'Wt Mult'.padStart(8)} ${'Total Val'.padStart(12)} ${'TVPI'.padStart(8)} ${'Exits'.padStart(5)}  Best Performer`
  ));
  console.log(chalk.dim('  ─'.repeat(50)));

  for (const r of rows) {
    const wtMult = r.weighted_avg_multiple != null ? formatMultiple(r.weighted_avg_multiple) : '—';
    const tvpi = r.tvpi != null ? formatMultiple(r.tvpi) : '—';
    const best = bestMap[r.gp_name];
    const bestStr = best ? `${best.company} (${formatMultiple(best.multiple)})` : '—';

    const multColor = r.weighted_avg_multiple >= 2 ? chalk.green
      : r.weighted_avg_multiple >= 1 ? chalk.white
      : r.weighted_avg_multiple != null ? chalk.red
      : chalk.dim;

    console.log(
      `  ${r.gp_name.padEnd(28).slice(0, 28)} ${String(r.deal_count).padStart(5)} ${formatMoney(r.total_invested).padStart(12)} ${formatMoney(r.avg_check).padStart(12)} ${multColor(wtMult.padStart(8))} ${formatMoney(r.total_value).padStart(12)} ${tvpi.padStart(8)} ${String(r.realized_count).padStart(5)}  ${chalk.dim(bestStr)}`
    );
  }

  console.log(chalk.dim(`\n  ${rows.length} GP sources total\n`));
}

export function printGpDetail({ investments, stats, thesisDist, eras, stageDist }) {
  if (!stats || investments.length === 0) {
    console.log(chalk.red('\n  No investments found for that GP/lead.\n'));
    return;
  }

  const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';

  console.log(chalk.bold(`\n  GP Detail: ${stats.gp_name}`));
  console.log(chalk.dim('  ─'.repeat(40)));

  console.log(`  Deals:           ${stats.deal_count} (${stats.live} live, ${stats.realized} realized, ${stats.closing} closing)`);
  console.log(`  Total deployed:  ${chalk.green(formatMoney(stats.total_invested))}`);
  console.log(`  Avg check:       ${formatMoney(stats.avg_check)}`);
  console.log(`  Total value:     ${chalk.bold(formatMoney(stats.total_value))}`);
  console.log(`  TVPI:            ${stats.tvpi ? chalk.bold(formatMultiple(stats.tvpi)) : '—'}`);
  console.log(`  Wt avg multiple: ${stats.weighted_avg_multiple ? formatMultiple(stats.weighted_avg_multiple) : '—'}`);
  console.log(`  Avg multiple:    ${stats.avg_multiple ? formatMultiple(stats.avg_multiple) : '—'}`);
  console.log(`  Best multiple:   ${stats.best_multiple ? chalk.green(formatMultiple(stats.best_multiple)) : '—'}`);
  console.log(`  Worst multiple:  ${stats.worst_multiple != null ? chalk.red(formatMultiple(stats.worst_multiple)) : '—'}`);
  console.log(`  Period:          ${fmtDate(stats.first_deal)} to ${fmtDate(stats.last_deal)}`);

  // Investments table
  console.log(chalk.bold('\n  Investments'));
  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(chalk.dim(
    `  ${'Company'.padEnd(28)} ${'Date'.padEnd(12)} ${'Invested'.padStart(10)} ${'Value'.padStart(10)} ${'Mult'.padStart(8)} ${'Status'.padEnd(10)} Market`
  ));
  console.log(chalk.dim('  ─'.repeat(50)));

  for (const r of investments) {
    const mult = r.multiple != null ? formatMultiple(r.multiple) : 'locked';
    const multColor = r.multiple >= 2 ? chalk.green : r.multiple >= 1 ? chalk.white : r.multiple != null ? chalk.red : chalk.dim;
    const statusColor = r.status === 'Realized' ? chalk.yellow : r.status === 'Closing' ? chalk.cyan : chalk.white;
    const date = (r.invest_date?.toISOString?.().slice(0, 10) || r.invest_date || '').toString().slice(0, 10);

    console.log(
      `  ${r.company_name.padEnd(28).slice(0, 28)} ${date.padEnd(12)} ${formatMoney(r.invested).padStart(10)} ${formatMoney(r.net_value).padStart(10)} ${multColor(mult.padStart(8))} ${statusColor((r.status || '').padEnd(10))} ${chalk.dim(r.market || '—')}`
    );
  }

  // Thesis distribution
  if (thesisDist.length > 0) {
    console.log(chalk.bold('\n  Thesis Distribution'));
    console.log(chalk.dim('  ─'.repeat(30)));
    for (const t of thesisDist) {
      console.log(`    ${t.thesis.padEnd(40).slice(0, 40)} ${String(t.count).padStart(3)} deals  ${formatMoney(t.total_invested).padStart(12)}`);
    }
  }

  // Era breakdown
  if (eras.length > 0) {
    console.log(chalk.bold('\n  Era Breakdown'));
    console.log(chalk.dim('  ─'.repeat(30)));
    for (const e of eras) {
      console.log(chalk.bold(`\n    ${e.era}`));
      console.log(`      Deals:       ${e.deal_count}`);
      console.log(`      Deployed:    ${formatMoney(e.total_invested)}`);
      console.log(`      Avg check:   ${formatMoney(e.avg_check)}`);
      console.log(`      TVPI:        ${e.tvpi ? formatMultiple(e.tvpi) : '—'}`);
      console.log(`      Avg multiple: ${e.avg_multiple ? formatMultiple(e.avg_multiple) : '—'}`);
    }
  }

  // Stage distribution
  if (stageDist && stageDist.length > 0) {
    console.log(chalk.bold('\n  Stage Distribution'));
    console.log(chalk.dim('  ─'.repeat(30)));
    for (const s of stageDist) {
      const tvpi = s.tvpi != null ? formatMultiple(s.tvpi) : '—';
      const label = stageLabel(s.stage_bucket);
      console.log(`    ${label.padEnd(14)} ${String(s.deal_count).padStart(3)} deals  ${formatMoney(s.net_invested).padStart(12)}  TVPI ${tvpi}`);
    }
  }

  console.log('');
}
