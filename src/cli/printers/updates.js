// Pretty-printers for company updates.
import chalk from 'chalk';
import { readFileSync, existsSync } from 'fs';

function fmtMoney(n) {
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(0)}K`;
  return `$${num}`;
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toISOString().slice(0, 10); } catch { return '—'; }
}

function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return '';
  const sign = p >= 0 ? '+' : '';
  const txt = `(${sign}${(p * 100).toFixed(0)}%)`;
  return p >= 0 ? chalk.green(txt) : chalk.red(txt);
}

function fmtFlag(v) {
  return v ? chalk.green('✓') : chalk.dim('—');
}

export function printUpdatesList(rows) {
  if (rows.length === 0) {
    console.log(chalk.dim('\n  No updates found.\n'));
    return;
  }
  console.log('');
  console.log(chalk.bold('  Investor Updates'));
  console.log(chalk.dim(`  ${rows.length} result${rows.length === 1 ? '' : 's'}\n`));

  const header = '  ' +
    'ID'.padEnd(5) +
    'Date'.padEnd(12) +
    'Quarter'.padEnd(10) +
    'Company'.padEnd(22) +
    'ARR'.padEnd(10) +
    'Burn'.padEnd(10) +
    'Runway'.padEnd(9) +
    'Rev?'.padEnd(6) +
    'Fbk?';
  console.log(chalk.dim(header));
  console.log(chalk.dim('  ' + '-'.repeat(header.length - 2)));

  for (const r of rows) {
    const line = '  ' +
      String(r.id).padEnd(5) +
      fmtDate(r.update_date).padEnd(12) +
      (r.quarter || '—').slice(0, 9).padEnd(10) +
      (r.company_name || '—').slice(0, 21).padEnd(22) +
      fmtMoney(r.revenue_arr).padEnd(10) +
      fmtMoney(r.burn_rate).padEnd(10) +
      (r.runway_months != null ? `${Number(r.runway_months).toFixed(1)}mo` : '—').padEnd(9) +
      (r.has_review ? chalk.green('✓') : chalk.dim('—')).padEnd(15) +  // chalk escapes consume width
      (r.has_feedback ? chalk.green('✓') : chalk.dim('—'));
    console.log(r.investment_id ? chalk.white(line) : line);
  }
  console.log('');
}

export function printUpdateDetail(row, { notFoundId } = {}) {
  if (!row) {
    console.log(chalk.red(`\n  No update found with id: ${notFoundId || ''}\n`));
    return;
  }
  console.log('');
  console.log(chalk.bold(`  ${row.company_name}`) + chalk.dim(`  (${row.quarter || '—'})`));
  console.log(chalk.dim('  ' + '='.repeat(60)));
  console.log(`  Date:          ${fmtDate(row.update_date)}`);
  console.log(`  Source:        ${row.source || '—'}`);
  console.log(`  ARR:           ${fmtMoney(row.revenue_arr)}`);
  console.log(`  Burn:          ${fmtMoney(row.burn_rate)}`);
  console.log(`  Runway:        ${row.runway_months != null ? Number(row.runway_months).toFixed(1) + ' months' : '—'}`);
  console.log(`  Headcount:     ${row.headcount != null ? row.headcount : '—'}`);
  console.log(`  Cash on hand:  ${fmtMoney(row.cash_on_hand)}`);
  console.log(`  Attachment:    ${row.attachment_ref || '—'}`);
  console.log(`  Linked inv.:   ${row.investment_id ? chalk.green('#' + row.investment_id) : chalk.dim('unmatched')}`);
  console.log(`  Review:        ${fmtFlag(row.has_review)}`);
  console.log(`  Feedback:      ${fmtFlag(row.has_feedback)}`);
  console.log(`  File:          ${chalk.dim(row.file_path)}`);

  if (row.file_path && existsSync(row.file_path)) {
    console.log('');
    console.log(chalk.bold('  Content'));
    console.log(chalk.dim('  ' + '-'.repeat(60)));
    const text = readFileSync(row.file_path, 'utf-8');
    // Strip frontmatter for display
    const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    for (const line of body.split('\n')) {
      if (line.startsWith('## ')) console.log(chalk.cyan('  ' + line));
      else if (line.startsWith('# ')) console.log(chalk.bold('  ' + line));
      else console.log('  ' + line);
    }
  }
  console.log('');
}

export function printUpdateTimeline({ company, rows }) {
  if (!rows || rows.length === 0) {
    console.log(chalk.dim(`\n  No updates found for ${company}.\n`));
    return;
  }
  console.log('');
  console.log(chalk.bold(`  ${company} — Quarterly Timeline`) + chalk.dim(`  (${rows.length} update${rows.length === 1 ? '' : 's'})`));
  console.log(chalk.dim('  ' + '='.repeat(72)));

  const header = '  ' +
    'Quarter'.padEnd(10) +
    'Date'.padEnd(12) +
    'ARR'.padEnd(20) +
    'Burn'.padEnd(18) +
    'Runway'.padEnd(10) +
    'Headcount';
  console.log(chalk.dim(header));
  console.log(chalk.dim('  ' + '-'.repeat(header.length - 2)));

  for (const r of rows) {
    const arrStr = fmtMoney(r.revenue_arr) + ' ' + fmtPct(r.deltas?.revenue_arr);
    const burnStr = fmtMoney(r.burn_rate) + ' ' + fmtPct(r.deltas?.burn_rate);
    const runwayStr = r.runway_months != null ? `${Number(r.runway_months).toFixed(1)}mo` : '—';
    const hcStr = r.headcount != null ? String(r.headcount) : '—';
    console.log('  ' +
      (r.quarter || '—').padEnd(10) +
      fmtDate(r.update_date).padEnd(12) +
      arrStr.padEnd(28) +    // extra padding for chalk escapes
      burnStr.padEnd(26) +
      runwayStr.padEnd(10) +
      hcStr
    );
  }
  console.log('');
}
