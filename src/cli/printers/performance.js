// Pretty-printers for time-windowed performance metrics.
import chalk from 'chalk';
import { formatMoney, formatMultiple, formatIRR } from '../../utils/format.js';

function fmtPct(n) {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function pctColor(n) {
  if (n == null) return chalk.dim;
  return n >= 0 ? chalk.green : chalk.red;
}

function tvpiColor(n) {
  if (n == null) return chalk.dim;
  if (n >= 2) return chalk.green;
  if (n >= 1) return chalk.white;
  return chalk.red;
}

function printWindow(label, w) {
  console.log(chalk.bold(`\n  ${label}`));
  console.log(chalk.dim(`  ${w.start_date} → ${w.end_date}`));
  console.log(`    Start value:   ${formatMoney(w.start_value)}`);
  console.log(`    End value:     ${formatMoney(w.end_value)}`);
  console.log(`    Value change:  ${pctColor(w.value_change_pct)(fmtPct(w.value_change_pct))}`);
  console.log(`    Cash in:       ${formatMoney(w.cash_in)}`);
  console.log(`    Cash out:      ${formatMoney(w.cash_out)}`);
  console.log(`    TVPI:          ${w.tvpi != null ? tvpiColor(w.tvpi)(formatMultiple(w.tvpi)) : '—'}`);
  console.log(`    DPI:           ${w.dpi != null ? formatMultiple(w.dpi) : '—'}`);
}

export function printPerformanceWindows(data, opts = {}) {
  const window = opts.window;

  if (!window || window === 'ytd') {
    printWindow('Year to Date', data.ytd);
  }

  if (!window || window === 'trailing12m') {
    printWindow('Trailing 12 Months', data.trailing12m);
  }

  if (!window || window === 'vintage') {
    console.log(chalk.bold('\n  Vintage Year Analysis'));
    console.log(chalk.dim('  ─'.repeat(50)));
    console.log(chalk.dim(`  ${'Year'.padEnd(6)} ${'Deals'.padStart(5)} ${'Invested'.padStart(12)} ${'Current'.padStart(12)} ${'Realized'.padStart(12)} ${'DPI'.padStart(7)} ${'TVPI'.padStart(7)} ${'IRR'.padStart(8)}`));
    console.log(chalk.dim('  ─'.repeat(55)));

    for (const r of data.byVintageYear) {
      const tvpi = r.tvpi != null ? formatMultiple(r.tvpi) : '—';
      const dpi = r.dpi != null ? formatMultiple(r.dpi) : '—';
      const irr = formatIRR(r.irr);
      const irrCol = r.irr != null ? (r.irr >= 0 ? chalk.green : chalk.red) : chalk.dim;
      console.log(
        `  ${String(r.vintage_year).padEnd(6)} ${String(r.deal_count).padStart(5)} ${formatMoney(r.invested).padStart(12)} ${formatMoney(r.current_value).padStart(12)} ${formatMoney(r.realized).padStart(12)} ${dpi.padStart(7)} ${tvpiColor(r.tvpi)(tvpi.padStart(7))} ${irrCol(irr.padStart(8))}`
      );
    }
  }

  if (!window || window === 'quarterly') {
    console.log(chalk.bold('\n  Quarterly Cash Flows'));
    console.log(chalk.dim('  ─'.repeat(40)));
    console.log(chalk.dim(`  ${'Quarter'.padEnd(9)} ${'Deployed'.padStart(12)} ${'Distrib.'.padStart(12)} ${'Net Flow'.padStart(12)}`));
    console.log(chalk.dim('  ─'.repeat(40)));

    for (const r of data.byQuarter) {
      const netColor = r.net_cash_flow >= 0 ? chalk.green : chalk.red;
      console.log(
        `  ${r.quarter.padEnd(9)} ${formatMoney(r.deployed).padStart(12)} ${formatMoney(r.distributions).padStart(12)} ${netColor(formatMoney(r.net_cash_flow).padStart(12))}`
      );
    }
  }

  console.log('');
}
