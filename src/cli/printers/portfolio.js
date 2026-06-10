// Pretty-printers for portfolio reports. Consume the JSON-shaped data from
// src/reports/portfolio.js and render it for the CLI. Web GUI consumers should
// call the report functions directly and skip this file.

import chalk from 'chalk';
import { formatMoney, formatMultiple, formatIRR } from '../../utils/format.js';
import { stageLabel, stageToBarbellGroup } from '../../utils/stage.js';

export function printPortfolioSummary(data) {
  const { summary: s, locked, lockedInvested = 0, top, byInstrument, byRound, byStage } = data;

  console.log(chalk.bold('\n  Portfolio Summary'));
  console.log(chalk.dim('  ─'.repeat(30)));

  console.log(`  Investments:     ${chalk.bold(s.total_investments)} total (${s.live} live, ${s.realized} realized, ${s.closing} closing)`);
  console.log(`  Locked values:   ${locked} investments (AngelList hasn't released data)`);
  console.log(`  Deployed:        ${chalk.green(formatMoney(s.total_invested))}`);
  console.log(`  Unrealized:      ${formatMoney(s.total_unrealized)}`);
  console.log(`  Realized:        ${formatMoney(s.total_realized)}`);
  console.log(`  Net value:       ${chalk.bold(formatMoney(s.total_net_value))}`);
  console.log(`  TVPI:            ${s.tvpi ? chalk.bold(formatMultiple(s.tvpi)) : '— (too many locked values)'}`);
  if (locked > 0 && s.tvpi) {
    console.log(chalk.yellow(`                   ⚠ Includes ${locked} locked positions (${formatMoney(lockedInvested)} deployed) assumed flat at 1.0x`));
  }
  const irrColor = s.irr != null ? (s.irr >= 0 ? chalk.green : chalk.red) : chalk.dim;
  console.log(`  IRR:             ${irrColor(formatIRR(s.irr))}`);
  const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';
  console.log(`  Period:          ${fmtDate(s.first_investment)} to ${fmtDate(s.last_investment)}`);

  console.log(chalk.bold('\n  Top Performers'));
  console.log(chalk.dim('  ─'.repeat(30)));
  for (const t of top) {
    const mult = formatMultiple(t.multiple);
    const color = t.multiple >= 2 ? chalk.green : t.multiple >= 1 ? chalk.white : chalk.red;
    console.log(`  ${color(mult.padStart(8))}  ${formatMoney(t.invested).padStart(12)} -> ${formatMoney(t.net_value).padStart(12)}  ${t.company_name}`);
  }

  console.log(chalk.bold('\n  By Instrument'));
  console.log(chalk.dim('  ─'.repeat(30)));
  for (const r of byInstrument) {
    console.log(`  ${r.instrument?.padEnd(20) || 'unknown'.padEnd(20)} ${String(r.count).padStart(4)} deals  ${formatMoney(r.total).padStart(12)}`);
  }

  console.log(chalk.bold('\n  By Round'));
  console.log(chalk.dim('  ─'.repeat(30)));
  for (const r of byRound) {
    console.log(`  ${(r.round || 'unknown').padEnd(20)} ${String(r.count).padStart(4)} deals  ${formatMoney(r.total).padStart(12)}`);
  }

  if (byStage) {
    console.log(chalk.bold('\n  By Stage (Barbell)'));
    console.log(chalk.dim('  ─'.repeat(50)));
    console.log(chalk.dim(`  ${'Stage'.padEnd(14)} ${'Group'.padEnd(8)} ${'Deals'.padStart(5)} ${'Deployed'.padStart(12)} ${'Realized'.padStart(12)} ${'Total Val'.padStart(12)} ${'DPI'.padStart(7)} ${'TVPI'.padStart(7)}`));
    console.log(chalk.dim('  ─'.repeat(50)));
    for (const r of byStage) {
      const dpi  = r.dpi  != null ? formatMultiple(r.dpi)  : '—';
      const tvpi = r.tvpi != null ? formatMultiple(r.tvpi) : '—';
      const tvpiColor = r.tvpi >= 2 ? chalk.green : r.tvpi >= 1 ? chalk.white : chalk.red;
      const group = stageToBarbellGroup(r.stage_bucket);
      const groupColor = group === 'Early' ? chalk.cyan : group === 'Late' ? chalk.yellow : chalk.white;
      console.log(`  ${stageLabel(r.stage_bucket).padEnd(14)} ${groupColor(group.padEnd(8))} ${String(r.count).padStart(5)} ${formatMoney(r.net_invested).padStart(12)} ${formatMoney(r.realized).padStart(12)} ${formatMoney(r.total_value).padStart(12)} ${dpi.padStart(7)} ${tvpiColor(tvpi.padStart(7))}`);
    }
  }

  console.log('');
}

export function printPortfolioList(rows) {
  console.log(chalk.bold('\n  Portfolio Investments'));
  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(chalk.dim(`  ${'Company'.padEnd(30)} ${'Date'.padEnd(12)} ${'Invested'.padStart(10)} ${'Value'.padStart(10)} ${'Mult'.padStart(8)} ${'IRR'.padStart(8)} ${'Status'.padEnd(10)} Thesis`));
  console.log(chalk.dim('  ─'.repeat(55)));

  for (const r of rows) {
    const mult = r.multiple != null ? formatMultiple(r.multiple) : 'locked';
    const multColor = r.multiple >= 2 ? chalk.green : r.multiple >= 1 ? chalk.white : r.multiple != null ? chalk.red : chalk.dim;
    const irr = formatIRR(r.irr);
    const irrCol = r.irr != null ? (r.irr >= 0 ? chalk.green : chalk.red) : chalk.dim;
    const statusColor = r.status === 'Realized' ? chalk.yellow : r.status === 'Closing' ? chalk.cyan : chalk.white;
    const thesisShort = r.theses ? r.theses.split(',')[0].replace('That Reprices What\'s Possible', '').trim() : '';

    console.log(
      `  ${r.company_name.padEnd(30).slice(0, 30)} ${(r.invest_date?.toISOString?.().slice(0, 10) || r.invest_date || '').toString().slice(0, 10).padEnd(12)} ${formatMoney(r.invested).padStart(10)} ${formatMoney(r.net_value).padStart(10)} ${multColor(mult.padStart(8))} ${irrCol(irr.padStart(8))} ${statusColor(r.status?.padEnd(10) || '')} ${chalk.dim(thesisShort)}`
    );
  }
  console.log(chalk.dim(`\n  ${rows.length} investments total\n`));
}

export function printPortfolioDetail(rows) {
  if (rows.length === 0) {
    console.log(chalk.red('\n  No matching investments found.\n'));
    return;
  }

  for (const r of rows) {
    console.log(chalk.bold(`\n  ${r.company_name}`));
    console.log(chalk.dim('  ─'.repeat(30)));
    console.log(`  Status:          ${r.status}`);
    console.log(`  Invested:        ${formatMoney(r.invested)} on ${formatDateValue(r.invest_date)}`);
    console.log(`  Net value:       ${r.net_value != null ? formatMoney(r.net_value) : chalk.dim('Locked')}`);
    console.log(`  Multiple:        ${r.multiple != null ? formatMultiple(r.multiple) : chalk.dim('Locked')}`);
    const detailIrrColor = r.irr != null ? (r.irr >= 0 ? chalk.green : chalk.red) : chalk.dim;
    console.log(`  IRR:             ${detailIrrColor(formatIRR(r.irr))}`);
    console.log(`  Round:           ${r.round || '—'}`);
    console.log(`  Market:          ${r.market || '—'}`);
    console.log(`  Instrument:      ${r.instrument || '—'}`);
    console.log(`  Lead:            ${r.lead || 'Direct'}`);
    console.log(`  Fund:            ${r.fund_name || '—'}`);
    console.log(`  Allocation:      ${formatMoney(r.allocation)}`);
    console.log(`  Round size:      ${formatMoney(r.round_size)}`);
    console.log(`  Valuation/Cap:   ${formatMoney(r.valuation_cap)} (${r.valuation_cap_type || '—'})`);
    if (r.discount) console.log(`  Discount:        ${r.discount}%`);
    console.log(`  Carry:           ${r.carry || '—'}`);
    if (r.share_class) console.log(`  Share class:     ${r.share_class}`);

    const theses = typeof r.theses === 'string' ? JSON.parse(r.theses) : r.theses;
    if (theses.length > 0) {
      console.log(chalk.bold('\n  Thesis Tags'));
      for (const t of theses) {
        const primary = t.is_primary ? chalk.green(' (primary)') : '';
        const weightTag = t.weight != null && t.weight !== 100 ? chalk.dim(` ${t.weight}%`) : '';
        console.log(`    ${t.name}${primary} [${t.confidence}]${weightTag}`);
      }
    }

    const history = typeof r.valuation_history === 'string' ? JSON.parse(r.valuation_history) : r.valuation_history;
    if (history.length > 0) {
      console.log(chalk.bold('\n  Valuation History'));
      for (const v of history) {
        console.log(`    ${v.date}  net: ${formatMoney(v.net)}  mult: ${v.multiple != null ? formatMultiple(v.multiple) : '—'}`);
      }
    }

    // Lot + QSBS info
    if (r.lot) {
      const years = (r.lot.holding_days / 365).toFixed(1);
      const qsbsStatus = r.lot.qsbs_5yr_met
        ? chalk.green('✓ 5yr met')
        : chalk.dim(`${r.lot.qsbs_5yr_date}`);
      if (r.is_multi_lot) {
        console.log(chalk.dim(`\n  Lot: ${formatMoney(r.invested)} on ${formatDateValue(r.invest_date)}  (${years}yr hold)  QSBS 5yr: ${qsbsStatus}`));
      } else {
        console.log(`\n  Holding:         ${years} years (${r.lot.holding_days} days)`);
        console.log(`  QSBS 5yr:        ${qsbsStatus}`);
      }
    }
  }
  console.log('');
}

function formatDateValue(d) {
  if (d == null) return '—';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

export function printReconciliation(data) {
  const {
    matched_count,
    mismatched,
    missing_cash_flows,
    orphan_cash_flows,
    zero_value = [],
    exact_duplicates = [],
    possible_duplicates = [],
  } = data;

  console.log(chalk.bold('\n  Portfolio Reconciliation'));
  console.log(chalk.dim('  ─'.repeat(40)));

  const total = matched_count + mismatched.length + missing_cash_flows.length;
  console.log(`  ${chalk.green(matched_count)} reconciled  |  ${chalk.red(mismatched.length)} mismatched  |  ${chalk.yellow(missing_cash_flows.length)} no cash_flows  |  ${total} total investments`);

  if (mismatched.length > 0) {
    console.log(chalk.bold.red(`\n  Mismatched (${mismatched.length})`));
    console.log(chalk.dim(`  ${'Company'.padEnd(32)} ${'Invested'.padStart(12)} ${'CF Invested'.padStart(12)} ${'Diff'.padStart(12)}`));
    console.log(chalk.dim('  ─'.repeat(40)));
    for (const r of mismatched) {
      const diffColor = Number(r.diff) > 0 ? chalk.red : chalk.yellow;
      console.log(`  ${r.company_name.padEnd(32).slice(0, 32)} ${formatMoney(r.invested).padStart(12)} ${formatMoney(r.cf_invested).padStart(12)} ${diffColor(formatMoney(r.diff).padStart(12))}`);
    }
  }

  if (missing_cash_flows.length > 0) {
    console.log(chalk.bold.yellow(`\n  No Cash Flows (${missing_cash_flows.length})`));
    console.log(chalk.dim(`  ${'Company'.padEnd(32)} ${'Invested'.padStart(12)}`));
    console.log(chalk.dim('  ─'.repeat(25)));
    for (const r of missing_cash_flows.slice(0, 20)) {
      console.log(`  ${r.company_name.padEnd(32).slice(0, 32)} ${formatMoney(r.invested).padStart(12)}`);
    }
    if (missing_cash_flows.length > 20) {
      console.log(chalk.dim(`  ... and ${missing_cash_flows.length - 20} more`));
    }
  }

  if (orphan_cash_flows.length > 0) {
    console.log(chalk.bold.yellow(`\n  Orphan Cash Flows (${orphan_cash_flows.length}) — unlinked to any investment`));
    console.log(chalk.dim(`  ${'Date'.padEnd(12)} ${'Type'.padEnd(14)} ${'Amount'.padStart(12)} ${'Company Raw'}`));
    console.log(chalk.dim('  ─'.repeat(35)));
    for (const r of orphan_cash_flows.slice(0, 20)) {
      const d = r.flow_date?.toISOString?.().slice(0, 10) || String(r.flow_date).slice(0, 10);
      console.log(`  ${d.padEnd(12)} ${(r.type || '').padEnd(14)} ${formatMoney(r.amount).padStart(12)} ${r.company_raw || chalk.dim('—')}`);
    }
    if (orphan_cash_flows.length > 20) {
      console.log(chalk.dim(`  ... and ${orphan_cash_flows.length - 20} more`));
    }
  }

  if (zero_value.length > 0) {
    console.log(chalk.bold.red(`\n  ⚠ Zero Value — Non-Exited (${zero_value.length}) — needs manual review`));
    console.log(chalk.dim(`  ${'Company'.padEnd(32)} ${'Invested'.padStart(12)} ${'Status'.padEnd(10)} ${'Date'}`));
    console.log(chalk.dim('  ─'.repeat(40)));
    for (const r of zero_value) {
      const d = r.invest_date?.toISOString?.().slice(0, 10) || String(r.invest_date).slice(0, 10);
      console.log(`  ${r.company_name.padEnd(32).slice(0, 32)} ${formatMoney(r.invested).padStart(12)} ${(r.status || '').padEnd(10)} ${d}`);
    }
    console.log(chalk.dim('  These positions are marked at 0.00x but not Realized — update status or valuation.'));
  }

  if (exact_duplicates.length > 0) {
    console.log(chalk.bold.red(`\n  Duplicate Investment Candidates (${exact_duplicates.length}) — same economic identity, multiple rows`));
    console.log(chalk.dim(`  ${'Company'.padEnd(28)} ${'Lead'.padEnd(20)} ${'Round'.padEnd(12)} ${'Invested'.padStart(10)}  ids → dates`));
    console.log(chalk.dim('  ─'.repeat(45)));
    for (const r of exact_duplicates) {
      const dates = (r.dates || []).map(formatDateValue).join(', ');
      const ids = (r.ids || []).join(', ');
      const statuses = (r.statuses || []).join('/');
      console.log(`  ${r.company_name.padEnd(28).slice(0, 28)} ${(r.lead || '—').padEnd(20).slice(0, 20)} ${(r.round || '—').padEnd(12).slice(0, 12)} ${formatMoney(r.invested).padStart(10)}  [${ids}] → ${dates}  ${chalk.dim(statuses)}`);
    }
    console.log(chalk.dim('  High-confidence duplicates — review and delete the extra row(s).'));
  }

  if (possible_duplicates.length > 0) {
    console.log(chalk.bold.yellow(`\n  Possible Duplicate / Multi-Lot Positions (${possible_duplicates.length}) — same company + source, multiple rows`));
    console.log(chalk.dim(`  ${'Company'.padEnd(28)} ${'Source'.padEnd(12)} ${'n'.padStart(3)}  rows`));
    console.log(chalk.dim('  ─'.repeat(45)));
    for (const r of possible_duplicates) {
      const dates = (r.dates || []).map(formatDateValue);
      const amounts = (r.invested_amounts || []).map(a => formatMoney(a));
      const leads = (r.leads || []).map(l => l || '—');
      const rounds = (r.rounds || []).map(rd => rd || '—');
      const ids = r.ids || [];
      console.log(`  ${r.company_name.padEnd(28).slice(0, 28)} ${(r.source || '').padEnd(12)} ${String(r.n).padStart(3)}`);
      for (let i = 0; i < ids.length; i++) {
        console.log(chalk.dim(`      id=${ids[i]}  ${dates[i]}  ${amounts[i].padStart(10)}  ${leads[i].padEnd(20).slice(0, 20)}  ${rounds[i]}`));
      }
    }
    console.log(chalk.dim('  Includes legitimate follow-on SPVs — review individually.'));
  }

  console.log('');
}
