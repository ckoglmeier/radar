// Pretty-printers for thesis reports.
import chalk from 'chalk';
import { formatMoney, formatMultiple, formatIRR } from '../../utils/format.js';
import { stageLabel, stageToBarbellGroup } from '../../utils/stage.js';

export function printThesisPerformance(rows) {
  console.log(chalk.bold('\n  Thesis Performance'));
  console.log(chalk.dim('  ─'.repeat(40)));

  for (const r of rows) {
    console.log(chalk.bold(`\n  ${r.thesis}`));
    console.log(`    Deals:         ${r.deal_count} (${r.live} live, ${r.realized} realized)`);
    console.log(`    Invested:      ${formatMoney(r.total_invested)}`);
    console.log(`    Net value:     ${formatMoney(r.total_net_value)}`);
    console.log(`    TVPI:          ${r.tvpi ? formatMultiple(r.tvpi) : '—'}`);
    const irrColor = r.irr != null ? (r.irr >= 0 ? chalk.green : chalk.red) : chalk.dim;
    console.log(`    IRR:           ${irrColor(formatIRR(r.irr))}`);
    console.log(`    Avg multiple:  ${r.avg_multiple ? formatMultiple(r.avg_multiple) : '—'}`);
    console.log(`    Best multiple: ${r.best_multiple ? formatMultiple(r.best_multiple) : '—'}`);
    const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';
    console.log(`    Period:        ${fmtDate(r.first_deal)} to ${fmtDate(r.last_deal)}`);
  }

  console.log('');
}

export function printUntagged(rows) {
  if (rows.length === 0) {
    console.log(chalk.green('\n  All investments are tagged to a thesis.\n'));
    return;
  }

  console.log(chalk.bold(`\n  Untagged Investments (${rows.length})`));
  console.log(chalk.dim('  ─'.repeat(40)));
  console.log(chalk.dim(`  ${'Company'.padEnd(30)} ${'Date'.padEnd(12)} ${'Invested'.padStart(10)} ${'Market'.padEnd(25)} Round`));

  for (const r of rows) {
    console.log(
      `  ${r.company_name.padEnd(30).slice(0, 30)} ${(r.invest_date || '').toString().slice(0, 10).padEnd(12)} ${formatMoney(r.invested).padStart(10)} ${(r.market || '—').padEnd(25).slice(0, 25)} ${r.round || '—'}`
    );
  }
  console.log('');
}

export function printStageBreakdown({ byStage, barbell }) {
  console.log(chalk.bold('\n  Stage Breakdown'));
  console.log(chalk.dim('  ─'.repeat(55)));
  console.log(chalk.dim(`  ${'Stage'.padEnd(14)} ${'Deals'.padStart(5)} ${'Deployed'.padStart(12)} ${'Avg Check'.padStart(10)} ${'Realized'.padStart(12)} ${'Total Val'.padStart(12)} ${'DPI'.padStart(7)} ${'TVPI'.padStart(7)}`));
  console.log(chalk.dim('  ─'.repeat(55)));

  for (const r of byStage) {
    const dpi  = r.dpi  != null ? formatMultiple(r.dpi)  : '—';
    const tvpi = r.tvpi != null ? formatMultiple(r.tvpi) : '—';
    const tvpiColor = r.tvpi >= 2 ? chalk.green : r.tvpi >= 1 ? chalk.white : chalk.red;
    console.log(`  ${stageLabel(r.stage_bucket).padEnd(14)} ${String(r.deal_count).padStart(5)} ${formatMoney(r.net_invested).padStart(12)} ${formatMoney(r.avg_check).padStart(10)} ${formatMoney(r.realized).padStart(12)} ${formatMoney(r.total_value).padStart(12)} ${dpi.padStart(7)} ${tvpiColor(tvpi.padStart(7))}`);
  }

  console.log(chalk.bold('\n  Barbell Roll-up'));
  console.log(chalk.dim('  ─'.repeat(55)));
  console.log(chalk.dim(`  ${'Group'.padEnd(10)} ${'Deals'.padStart(5)} ${'Deployed'.padStart(12)} ${'Realized'.padStart(12)} ${'Total Val'.padStart(12)} ${'DPI'.padStart(7)} ${'TVPI'.padStart(7)}  Note`));
  console.log(chalk.dim('  ─'.repeat(55)));

  const notes = {
    Early:  'QSBS-eligible · asymmetric upside',
    Mid:    'transition / growth equity',
    Late:   'shorter time-to-liquidity · DPI velocity',
    Growth: 'pre-IPO / near-liquidity',
  };
  for (const b of barbell) {
    const dpi  = b.dpi  != null ? formatMultiple(b.dpi)  : '—';
    const tvpi = b.tvpi != null ? formatMultiple(b.tvpi) : '—';
    const groupColor = b.group === 'Early' ? chalk.cyan : b.group === 'Late' ? chalk.yellow : chalk.white;
    const tvpiColor  = b.tvpi >= 2 ? chalk.green : b.tvpi >= 1 ? chalk.white : chalk.red;
    console.log(`  ${groupColor(b.group.padEnd(10))} ${String(b.deal_count).padStart(5)} ${formatMoney(b.net_invested).padStart(12)} ${formatMoney(b.realized).padStart(12)} ${formatMoney(b.total_value).padStart(12)} ${dpi.padStart(7)} ${tvpiColor(tvpi.padStart(7))}  ${chalk.dim(notes[b.group] || '')}`);
  }

  console.log('');
}

export function printEraAnalysis(rows) {
  console.log(chalk.bold('\n  Era Analysis'));
  console.log(chalk.dim('  ─'.repeat(40)));

  for (const r of rows) {
    console.log(chalk.bold(`\n  ${r.era}`));
    console.log(`    Deals:         ${r.deal_count}`);
    console.log(`    Total invested: ${formatMoney(r.total_invested)}`);
    console.log(`    Avg check:     ${formatMoney(r.avg_check)}`);
    console.log(`    Net value:     ${formatMoney(r.total_net_value)}`);
    console.log(`    TVPI:          ${r.tvpi ? formatMultiple(r.tvpi) : '—'}`);
    console.log(`    Avg multiple:  ${r.avg_multiple ? formatMultiple(r.avg_multiple) : '—'}`);
  }
  console.log('');
}
