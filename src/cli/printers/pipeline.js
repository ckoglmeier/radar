// Pretty-printers for pipeline invites and their event log.
import chalk from 'chalk';

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
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

export function printPipelineList(rows, { status } = {}) {
  if (rows.length === 0) {
    console.log(chalk.dim('\n  No pipeline invites found.\n'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  Pipeline Invites') + (status ? chalk.dim(` (status=${status})`) : ''));
  console.log(chalk.dim(`  ${rows.length} result${rows.length === 1 ? '' : 's'}\n`));

  const header = '  ' +
    'Received'.padEnd(12) +
    'Company'.padEnd(28) +
    'Lead'.padEnd(22) +
    'Round'.padEnd(14) +
    'Valuation'.padEnd(12) +
    'Status';
  console.log(chalk.dim(header));
  console.log(chalk.dim('  ' + '-'.repeat(header.length - 2)));

  for (const r of rows) {
    const line = '  ' +
      fmtDate(r.email_received_at).padEnd(12) +
      (r.company_name || '—').slice(0, 27).padEnd(28) +
      (r.lead || '—').slice(0, 21).padEnd(22) +
      (r.round || '—').slice(0, 13).padEnd(14) +
      fmtMoney(r.valuation_usd).padEnd(12) +
      r.status;
    const colorFn = r.investment_id ? chalk.green : chalk.white;
    console.log(colorFn(line));
  }
  console.log('');
}

export function printPipelineDetail(invite, { notFoundSlug } = {}) {
  if (!invite) {
    console.log(chalk.red(`\n  No invite found with slug: ${notFoundSlug || ''}\n`));
    return;
  }

  console.log('');
  console.log(chalk.bold(`  ${invite.company_name}`) + chalk.dim(`  (${invite.deal_slug})`));
  console.log(chalk.dim('  ' + '='.repeat(60)));
  console.log(`  Status:        ${chalk.cyan(invite.status)}`);
  console.log(`  Received:      ${fmtDate(invite.email_received_at)}`);
  console.log(`  Lead:          ${invite.lead || '—'}`);
  console.log(`  Co-investors:  ${invite.co_investors || '—'}`);
  console.log(`  Market:        ${invite.market || '—'}`);
  console.log(`  Round:         ${invite.round || '—'}`);
  console.log(`  Valuation:     ${invite.valuation_text || '—'}`);
  console.log(`  Allocation:    ${fmtMoney(invite.allocation_usd)}`);
  console.log(`  Min invest:    ${fmtMoney(invite.min_investment_usd)}`);
  console.log(`  Syndicate in:  ${fmtMoney(invite.syndicate_investment_usd)}`);
  console.log(`  Carry:         ${invite.carry_pct != null ? invite.carry_pct + '%' : '—'}`);
  console.log(`  Dataroom:      ${invite.dataroom_url || '—'}`);
  console.log(`  Linked inv.:   ${invite.investment_id ? chalk.green('#' + invite.investment_id) : chalk.dim('unmatched')}`);

  if (invite.gp_message) {
    console.log('');
    console.log(chalk.bold('  GP Message'));
    console.log(chalk.dim('  ' + '-'.repeat(60)));
    const wrapped = invite.gp_message.split('\n').map(l => '  ' + l).join('\n');
    console.log(wrapped);
  }
  console.log('');
}

export function printPipelineEvents({ invite, events }, { notFoundSlug } = {}) {
  if (!invite) {
    console.log(chalk.red(`\n  No invite found with slug: ${notFoundSlug || ''}\n`));
    return;
  }
  console.log('');
  console.log(chalk.bold(`  Events for ${invite.company_name}`));
  console.log(chalk.dim('  ' + '-'.repeat(60)));
  if (events.length === 0) {
    console.log(chalk.dim('  (no events)\n'));
    return;
  }
  for (const e of events) {
    const when = fmtDate(e.event_date);
    const arrow = e.old_value != null && e.new_value != null
      ? `${chalk.dim(e.old_value)} → ${chalk.cyan(e.new_value)}`
      : e.new_value != null ? chalk.cyan(e.new_value) : '';
    console.log(`  ${chalk.dim(when)}  ${e.event_type.padEnd(16)} ${arrow}  ${chalk.dim(e.notes || '')}`);
  }
  console.log('');
}
