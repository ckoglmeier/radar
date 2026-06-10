// Text summary printer for treemap data (stopgap until web GUI).
import chalk from 'chalk';
import { formatMoney, formatMultiple } from '../../utils/format.js';

const DOT = {
  green: chalk.green('\u25cf'),
  yellow: chalk.yellow('\u25cf'),
  red: chalk.red('\u25cf'),
  gray: chalk.dim('\u25cf'),
};

export function printTreemap(data) {
  console.log(chalk.bold(`\n  Portfolio Composition — grouped by ${data.groupBy}, sized by ${data.sizeBy}`));
  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(chalk.dim(`  ${''.padEnd(3)} ${'Group'.padEnd(32)} ${'Count'.padStart(5)} ${'Size'.padStart(12)} ${'Invested'.padStart(12)} ${'Current'.padStart(12)} ${'TVPI'.padStart(7)}`));
  console.log(chalk.dim('  ─'.repeat(50)));

  for (const group of data.children) {
    const dot = DOT[group.color_bucket] || DOT.gray;
    const tvpi = group.tvpi != null ? formatMultiple(group.tvpi) : '—';
    const tvpiColor = group.tvpi >= 2 ? chalk.green : group.tvpi >= 1 ? chalk.white : chalk.red;
    console.log(
      `  ${dot}  ${chalk.bold(group.name.padEnd(32).slice(0, 32))} ${String(group.count).padStart(5)} ${formatMoney(group.size).padStart(12)} ${formatMoney(group.invested).padStart(12)} ${formatMoney(group.current_value).padStart(12)} ${tvpiColor(tvpi.padStart(7))}`
    );
  }

  // Totals
  const totalSize = data.children.reduce((s, g) => s + g.size, 0);
  const totalInvested = data.children.reduce((s, g) => s + g.invested, 0);
  const totalCurrent = data.children.reduce((s, g) => s + g.current_value, 0);
  const totalCount = data.children.reduce((s, g) => s + g.count, 0);
  const totalTvpi = totalInvested > 0 ? totalCurrent / totalInvested : null;

  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(
    `  ${''.padEnd(3)} ${chalk.bold('TOTAL'.padEnd(32))} ${String(totalCount).padStart(5)} ${formatMoney(totalSize).padStart(12)} ${formatMoney(totalInvested).padStart(12)} ${formatMoney(totalCurrent).padStart(12)} ${totalTvpi != null ? formatMultiple(totalTvpi).padStart(7) : '—'.padStart(7)}`
  );

  console.log('');
}
