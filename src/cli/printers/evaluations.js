// Pretty-printers for deal evaluations.
import chalk from 'chalk';
import { basename } from 'path';
import { formatMultiple, formatIRR } from '../../utils/format.js';

function companyFromPath(filePath) {
  if (!filePath) return '—';
  const fn = basename(filePath);
  // Strip date prefix and .md suffix, then title-case the slug
  const slug = fn.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');
  return slug
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function fmtDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

function fmtScore(s) {
  if (s == null) return '—';
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

function verdictColor(verdict) {
  if (!verdict) return chalk.dim;
  const v = verdict.toLowerCase();
  if (v.includes('strong')) return chalk.green;
  if (v.includes('worth') || v.includes('exploring')) return chalk.yellow;
  if (v.includes('pass')) return chalk.red;
  return chalk.white;
}

export function printEvalList(rows) {
  if (rows.length === 0) {
    console.log(chalk.dim('\n  No deal evaluations found. Run: node src/cli.js eval import\n'));
    return;
  }

  console.log('');
  console.log(chalk.bold('  Deal Evaluations'));
  console.log(chalk.dim(`  ${rows.length} evaluation${rows.length === 1 ? '' : 's'}\n`));

  const header = '  ' +
    'Date'.padEnd(12) +
    'Company'.padEnd(30) +
    'Thesis'.padEnd(8) +
    'Viab.'.padEnd(8) +
    'Total'.padEnd(8) +
    'Verdict'.padEnd(24) +
    'Inv?'.padEnd(6) +
    'Linked';
  console.log(chalk.dim(header));
  console.log(chalk.dim('  ' + '-'.repeat(header.length - 2)));

  for (const r of rows) {
    const company = companyFromPath(r.file_path);
    const vColor = verdictColor(r.verdict);
    const line = '  ' +
      fmtDate(r.eval_date).padEnd(12) +
      company.slice(0, 29).padEnd(30) +
      fmtScore(r.thesis_fit_score).padEnd(8) +
      fmtScore(r.viability_score).padEnd(8) +
      fmtScore(r.total_score).padEnd(8) +
      vColor((r.verdict || '—').slice(0, 23).padEnd(24)) +
      (r.invested ? chalk.green('Y') : chalk.dim('N')).padEnd(6) +
      (r.investment_id
        ? chalk.green('Inv')
        : r.pipeline_invite_id
          ? chalk.cyan(`Pipe/${(r.pipe_status || '?').slice(0, 4)}`)
          : chalk.dim('—'));
    console.log(line);
  }

  // Score distribution stats
  const scored = rows.filter(r => r.total_score != null);
  if (scored.length > 0) {
    const scores = scored.map(r => Number(r.total_score));
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const median = scores.sort((a, b) => a - b)[Math.floor(scores.length / 2)];

    const strong = rows.filter(r => r.verdict && r.verdict.toLowerCase().includes('strong')).length;
    const exploring = rows.filter(r => r.verdict && r.verdict.toLowerCase().includes('exploring')).length;
    const pass = rows.filter(r => r.verdict && r.verdict.toLowerCase().includes('pass')).length;

    console.log('');
    console.log(chalk.bold('  Score Distribution'));
    console.log(chalk.dim('  ' + '-'.repeat(40)));
    console.log(`  Scored:     ${scored.length} / ${rows.length}`);
    console.log(`  Average:    ${avg.toFixed(1)}`);
    console.log(`  Median:     ${median.toFixed(1)}`);
    console.log(`  Range:      ${min.toFixed(1)} – ${max.toFixed(1)}`);
    console.log('');
    console.log(chalk.bold('  Verdict Breakdown'));
    console.log(chalk.dim('  ' + '-'.repeat(40)));
    console.log(`  ${chalk.green('Strong Fit:')}      ${strong}`);
    console.log(`  ${chalk.yellow('Worth Exploring:')} ${exploring}`);
    console.log(`  ${chalk.red('Likely Pass:')}     ${pass}`);
  }

  console.log('');
}

export function printEvalDetail(row, { notFoundSearch } = {}) {
  if (!row) {
    console.log(chalk.red(`\n  No evaluation found matching: ${notFoundSearch || ''}\n`));
    return;
  }

  const company = companyFromPath(row.file_path);
  const vColor = verdictColor(row.verdict);

  console.log('');
  console.log(chalk.bold(`  ${company}`));
  console.log(chalk.dim('  ' + '='.repeat(60)));
  console.log(`  Date:            ${fmtDate(row.eval_date)}`);
  console.log(`  File:            ${chalk.dim(row.file_path || '—')}`);
  console.log(`  Thesis Fit:      ${fmtScore(row.thesis_fit_score)}`);
  console.log(`  Viability:       ${fmtScore(row.viability_score)}`);
  console.log(`  Total Score:     ${chalk.bold(fmtScore(row.total_score))}`);
  console.log(`  Verdict:         ${vColor(row.verdict || '—')}`);
  console.log(`  Invested:        ${row.invested ? chalk.green('Yes') : chalk.dim('No')}`);
  console.log(`  Linked to inv.:  ${row.investment_id ? chalk.green('#' + row.investment_id) : chalk.dim('—')}`);
  console.log(`  Linked to pipe.: ${row.pipeline_invite_id ? chalk.cyan('#' + row.pipeline_invite_id + ' (' + (row.pipe_status || '?') + ')') : chalk.dim('—')}`);
  console.log('');
}

export function printEvalValidation(data) {
  if (data.error) {
    console.log(chalk.red(`\n  ${data.error}\n`));
    return;
  }

  console.log(chalk.bold('\n  Thesis Validation — Score vs. Outcome'));
  console.log(chalk.dim('  ─'.repeat(40)));
  console.log(`  ${data.n} deals with score + outcome (${data.n_total} total evaluated)\n`);

  // Verdict summary
  if (data.verdict && data.verdict.length > 0) {
    for (const v of data.verdict) {
      const color = v.includes('Positive') || v.includes('monotonic') ? chalk.green
        : v.includes('Negative') || v.includes('NOT') || v.includes('overrated') ? chalk.red
        : chalk.yellow;
      console.log(`  ${color('▸')} ${v}`);
    }
    console.log('');
  }

  // Correlation
  const corr = data.correlation;
  console.log(chalk.bold('  Correlation'));
  console.log(chalk.dim('  ─'.repeat(30)));
  const rhoColor = (v) => {
    if (v == null) return chalk.dim('—');
    if (v > 0.3) return chalk.green(v.toFixed(3));
    if (v > 0.1) return chalk.yellow(v.toFixed(3));
    if (v > -0.1) return chalk.dim(v.toFixed(3));
    return chalk.red(v.toFixed(3));
  };
  console.log(`  Score vs Multiple (Spearman ρ):  ${rhoColor(corr.spearman_score_vs_multiple)}`);
  if (corr.spearman_score_vs_irr != null) {
    console.log(`  Score vs IRR (Spearman ρ):       ${rhoColor(corr.spearman_score_vs_irr)}  (n=${corr.n_with_irr})`);
  }

  // Per-band performance
  console.log(chalk.bold('\n  Performance by Score Band'));
  console.log(chalk.dim('  ─'.repeat(50)));
  console.log(chalk.dim(`  ${'Band'.padEnd(10)} ${'N'.padStart(4)} ${'Mean'.padStart(8)} ${'Median'.padStart(8)} ${'Win%'.padStart(7)} ${'3x+%'.padStart(7)} ${'IRR'.padStart(8)}`));
  console.log(chalk.dim('  ─'.repeat(50)));

  const bandOrder = ['<30', '30-38', '39-43', '44+'];
  for (const band of bandOrder) {
    const b = data.by_band[band];
    if (!b || b.n === 0) continue;
    const meanMult = b.mean_multiple != null ? formatMultiple(b.mean_multiple) : '—';
    const medianMult = b.median_multiple != null ? formatMultiple(b.median_multiple) : '—';
    const winRate = b.win_rate != null ? (b.win_rate * 100).toFixed(0) + '%' : '—';
    const bigWin = b.big_winner_rate != null ? (b.big_winner_rate * 100).toFixed(0) + '%' : '—';
    const irr = b.mean_irr != null ? formatIRR(b.mean_irr) : '—';

    const meanColor = b.mean_multiple >= 2 ? chalk.green
      : b.mean_multiple >= 1 ? chalk.white
      : b.mean_multiple != null ? chalk.red : chalk.dim;

    console.log(`  ${band.padEnd(10)} ${String(b.n).padStart(4)} ${meanColor(meanMult.padStart(8))} ${medianMult.padStart(8)} ${winRate.padStart(7)} ${bigWin.padStart(7)} ${irr.padStart(8)}`);
  }

  // Calibration
  console.log(chalk.bold('\n  Calibration'));
  console.log(chalk.dim('  ─'.repeat(30)));
  const cal = data.calibration;
  if (cal.monotonic === true) {
    console.log(`  ${chalk.green('✓')} Band means are monotonically increasing`);
  } else if (cal.monotonic === false) {
    console.log(`  ${chalk.red('✗')} Band means are NOT monotonic — rubric has blind spots`);
  }
  const bandMeans = cal.band_mean_multiples;
  const barWidth = 40;
  const maxMean = Math.max(...Object.values(bandMeans).filter(v => v != null), 1);
  for (const band of bandOrder) {
    const v = bandMeans[band];
    if (v == null) continue;
    const bar = '█'.repeat(Math.max(1, Math.round(v / maxMean * barWidth)));
    const color = v >= 2 ? chalk.green : v >= 1 ? chalk.white : chalk.red;
    console.log(`  ${band.padEnd(8)} ${color(bar)} ${formatMultiple(v)}`);
  }

  // Selectivity
  const sel = data.selectivity;
  if (sel.invested_count > 0 && sel.passed_count > 0) {
    console.log(chalk.bold('\n  Selectivity'));
    console.log(chalk.dim('  ─'.repeat(30)));
    console.log(`  Invested deals:  avg score ${sel.invested_mean_score?.toFixed(1) || '—'}  (n=${sel.invested_count})`);
    console.log(`  Passed deals:    avg score ${sel.passed_mean_score?.toFixed(1) || '—'}  (n=${sel.passed_count})`);
    const gap = sel.invested_mean_score != null && sel.passed_mean_score != null
      ? sel.invested_mean_score - sel.passed_mean_score : null;
    if (gap != null) {
      const gapColor = gap > 5 ? chalk.green : gap > 0 ? chalk.yellow : chalk.red;
      console.log(`  Score gap:       ${gapColor(gap.toFixed(1) + ' points')} ${gap > 0 ? '(invested score higher — good)' : '(no separation — concerning)'}`);
    }
  }

  // Misses
  const misses = data.misses;
  if (misses.overrated.length > 0) {
    console.log(chalk.bold.red(`\n  Overrated (${misses.overrated.length}) — scored ≥35 but <0.5x`));
    console.log(chalk.dim(`  ${'Company'.padEnd(28)} ${'Score'.padStart(6)} ${'Multiple'.padStart(8)} ${'Status'}`));
    console.log(chalk.dim('  ─'.repeat(30)));
    for (const d of misses.overrated) {
      console.log(`  ${d.company.padEnd(28).slice(0, 28)} ${String(d.score).padStart(6)} ${formatMultiple(d.multiple).padStart(8)} ${d.status || ''}`);
    }
  }

  if (misses.underrated.length > 0) {
    console.log(chalk.bold.yellow(`\n  Underrated (${misses.underrated.length}) — scored <30 but >1.5x`));
    console.log(chalk.dim(`  ${'Company'.padEnd(28)} ${'Score'.padStart(6)} ${'Multiple'.padStart(8)} ${'Status'}`));
    console.log(chalk.dim('  ─'.repeat(30)));
    for (const d of misses.underrated) {
      console.log(`  ${d.company.padEnd(28).slice(0, 28)} ${String(d.score).padStart(6)} ${formatMultiple(d.multiple).padStart(8)} ${d.status || ''}`);
    }
  }

  // CFO calibration
  const cfo = data.cfo_calibration;
  if (cfo && cfo.n_total_with_cfo_outcome > 0) {
    console.log(chalk.bold(`\n  CFO Verdict Calibration`));
    console.log(chalk.dim('  ─'.repeat(50)));
    console.log(chalk.dim(`  ${'Verdict'.padEnd(10)} ${'N'.padStart(4)} ${'Mean'.padStart(8)} ${'Median'.padStart(8)} ${'Win%'.padStart(7)} ${'Correct%'.padStart(10)}`));
    console.log(chalk.dim('  ─'.repeat(50)));

    const verdicts = ['Deploy', 'Defer', 'Pass'];
    for (const v of verdicts) {
      const b = cfo.by_verdict[v];
      if (!b || b.n === 0) continue;
      const mean = b.mean_multiple != null ? formatMultiple(b.mean_multiple) : '—';
      const median = b.median_multiple != null ? formatMultiple(b.median_multiple) : '—';
      const win = b.win_rate != null ? (b.win_rate * 100).toFixed(0) + '%' : '—';

      let correct = '—';
      let correctColor = chalk.dim;
      if (v === 'Pass' && cfo.pass_correct_rate != null) {
        correct = (cfo.pass_correct_rate * 100).toFixed(0) + '%';
        correctColor = cfo.pass_correct_rate > 0.6 ? chalk.green : cfo.pass_correct_rate > 0.4 ? chalk.yellow : chalk.red;
      } else if (v === 'Deploy' && cfo.deploy_correct_rate != null) {
        correct = (cfo.deploy_correct_rate * 100).toFixed(0) + '%';
        correctColor = cfo.deploy_correct_rate > 0.6 ? chalk.green : cfo.deploy_correct_rate > 0.4 ? chalk.yellow : chalk.red;
      }

      const verdictColor = v === 'Deploy' ? chalk.green : v === 'Defer' ? chalk.yellow : chalk.red;
      console.log(`  ${verdictColor(v.padEnd(10))} ${String(b.n).padStart(4)} ${mean.padStart(8)} ${median.padStart(8)} ${win.padStart(7)} ${correctColor(correct.padStart(10))}`);
    }
    console.log(chalk.dim(`\n  (${cfo.n_total_with_cfo_outcome} deals with both CFO verdict and known outcome)`));
    console.log(chalk.dim(`  Correct% = Pass avoided loss (<1x) · Deploy captured win (>1x)`));
  }

  console.log('');
}

export function printEvalDiscover(data) {
  if (data.error) {
    console.log(chalk.red(`\n  ${data.error}\n`));
    return;
  }

  console.log(chalk.bold('\n  Thesis Discovery — Data-Driven Cluster Analysis'));
  console.log(chalk.dim('  ─'.repeat(40)));
  console.log(`  ${data.n} investments with outcomes (${data.n_total} total)\n`);

  // Portfolio baseline
  const bl = data.portfolio_baseline;
  console.log(chalk.bold('  Portfolio Baseline'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log(`  Mean multiple:   ${formatMultiple(bl.mean_multiple)}`);
  console.log(`  Median multiple: ${formatMultiple(bl.median_multiple)}`);
  console.log(`  Win rate (>1x):  ${bl.win_rate != null ? (bl.win_rate * 100).toFixed(0) + '%' : '—'}`);

  // Verdicts
  if (data.verdicts && data.verdicts.length > 0) {
    console.log('');
    for (const v of data.verdicts) {
      const color = v.includes('well-calibrated') ? chalk.green
        : v.includes('Underperforming') ? chalk.red
        : chalk.yellow;
      console.log(`  ${color('▸')} ${v}`);
    }
  }

  // Top performing groups
  if (data.top_groups && data.top_groups.length > 0) {
    console.log(chalk.bold('\n  Top Performing Groups (by quality score)'));
    console.log(chalk.dim('  ─'.repeat(55)));
    console.log(chalk.dim(`  ${'Dimension'.padEnd(12)} ${'Group'.padEnd(28)} ${'N'.padStart(4)} ${'Mean'.padStart(8)} ${'Median'.padStart(8)} ${'Win%'.padStart(7)} ${'QScore'.padStart(8)}`));
    console.log(chalk.dim('  ─'.repeat(55)));

    for (const g of data.top_groups) {
      const meanMult = g.mean_multiple != null ? formatMultiple(g.mean_multiple) : '—';
      const medianMult = g.median_multiple != null ? formatMultiple(g.median_multiple) : '—';
      const winRate = g.win_rate != null ? (g.win_rate * 100).toFixed(0) + '%' : '—';
      const qScore = g.quality_score != null ? g.quality_score.toFixed(1) : '—';

      const meanColor = g.mean_multiple >= bl.mean_multiple * 1.2 ? chalk.green
        : g.mean_multiple >= bl.mean_multiple * 0.8 ? chalk.white
        : g.mean_multiple != null ? chalk.red : chalk.dim;

      console.log(`  ${(g.dimension || '').padEnd(12).slice(0, 12)} ${(g.group || '').padEnd(28).slice(0, 28)} ${String(g.n).padStart(4)} ${meanColor(meanMult.padStart(8))} ${medianMult.padStart(8)} ${winRate.padStart(7)} ${qScore.padStart(8)}`);
    }
  }

  // Active thesis assessment
  if (data.active_assessment && data.active_assessment.length > 0) {
    console.log(chalk.bold('\n  Active Thesis Assessment'));
    console.log(chalk.dim('  ─'.repeat(50)));
    for (const a of data.active_assessment) {
      const vColor = a.verdict.includes('strong') ? chalk.green
        : a.verdict.includes('neutral') ? chalk.yellow
        : a.verdict.includes('no data') ? chalk.dim
        : chalk.red;
      const mult = a.mean_multiple != null ? formatMultiple(a.mean_multiple) : '—';
      const rank = a.rank != null ? `#${a.rank}/${a.rank_of}` : '—';
      const ttm = a.avg_hold_winners != null ? `${a.avg_hold_winners}y` : '—';
      const pending = a.n_pending != null ? `${a.n_pending}` : '—';
      console.log(`  ${a.thesis}`);
      console.log(`    ${mult} mean  n=${a.n || 0}  rank=${rank}  ${vColor(a.verdict)}`);
      console.log(chalk.dim(`    time to +mark: ${ttm} avg (${a.n_winners || 0} marked, ${pending} pending)`));
    }
  }

  // Promotion candidates
  if (data.promotions && data.promotions.length > 0) {
    console.log(chalk.bold.yellow(`\n  Promotion Candidates (outperforming weakest active thesis)`));
    console.log(chalk.dim('  ─'.repeat(50)));
    console.log(chalk.dim(`  ${'Dimension'.padEnd(12)} ${'Group'.padEnd(28)} ${'N'.padStart(4)} ${'Mean'.padStart(8)} ${'QScore'.padStart(8)}`));
    console.log(chalk.dim('  ─'.repeat(50)));
    for (const p of data.promotions) {
      const meanMult = p.mean_multiple != null ? formatMultiple(p.mean_multiple) : '—';
      const qScore = p.quality_score != null ? p.quality_score.toFixed(1) : '—';
      console.log(`  ${(p.dimension || '').padEnd(12).slice(0, 12)} ${chalk.yellow((p.group || '').padEnd(28).slice(0, 28))} ${String(p.n).padStart(4)} ${chalk.green(meanMult.padStart(8))} ${qScore.padStart(8)}`);
    }
  }

  // Top combinations
  if (data.top_combos && data.top_combos.length > 0) {
    console.log(chalk.bold('\n  Top Combinations (2-attribute clusters)'));
    console.log(chalk.dim('  ─'.repeat(55)));
    console.log(chalk.dim(`  ${'Dimensions'.padEnd(18)} ${'Combination'.padEnd(32)} ${'N'.padStart(4)} ${'Mean'.padStart(8)} ${'QScore'.padStart(8)}`));
    console.log(chalk.dim('  ─'.repeat(55)));
    for (const c of data.top_combos) {
      const meanMult = c.mean_multiple != null ? formatMultiple(c.mean_multiple) : '—';
      const qScore = c.quality_score != null ? c.quality_score.toFixed(1) : '—';
      const meanColor = c.mean_multiple >= bl.mean_multiple * 1.2 ? chalk.green : chalk.white;
      console.log(`  ${(c.dimension || '').padEnd(18).slice(0, 18)} ${(c.group || '').padEnd(32).slice(0, 32)} ${String(c.n).padStart(4)} ${meanColor(meanMult.padStart(8))} ${qScore.padStart(8)}`);
    }
  }

  console.log('');
}

export function printEvalReconcile(data) {
  const { threshold, linked, unlinked, total } = data;

  console.log(chalk.bold('\n  Pipeline Reconciliation — High-Score Passes'));
  console.log(chalk.dim(`  Pipeline invites with status=passed that scored ≥${threshold}/50 in deal evaluations`));
  console.log(chalk.dim('  ─'.repeat(40)));

  if (total === 0) {
    console.log(chalk.green(`\n  No high-score passes found. All pipeline passes scored below ${threshold}/50.\n`));
    return;
  }

  console.log(chalk.yellow(`\n  ${total} deal${total === 1 ? '' : 's'} passed at pipeline stage but scored ≥${threshold}/50\n`));

  const all = [
    ...linked.map(r => ({ ...r, linkType: 'linked' })),
    ...unlinked.map(r => ({ ...r, linkType: 'unlinked' })),
  ].sort((a, b) => (b.total_score || 0) - (a.total_score || 0));

  const header = '  ' +
    'Score'.padStart(5) + '  ' +
    'Company'.padEnd(28) +
    'Round'.padEnd(14) +
    'Lead GP'.padEnd(20) +
    'CFO'.padEnd(8) +
    'Verdict';
  console.log(chalk.dim(header));
  console.log(chalk.dim('  ' + '─'.repeat(header.length - 2)));

  for (const r of all) {
    const score = r.total_score != null ? String(r.total_score) : '—';
    const scoreColor = r.total_score >= 44 ? chalk.green
      : r.total_score >= 39 ? chalk.yellow
      : chalk.white;
    const line = '  ' +
      scoreColor(score.padStart(5)) + '  ' +
      (r.company_name || '—').slice(0, 27).padEnd(28) +
      (r.round || '—').slice(0, 13).padEnd(14) +
      (r.lead_gp || '—').slice(0, 19).padEnd(20) +
      (r.council_cfo_verdict || '—').padEnd(8) +
      (r.verdict || '—').slice(0, 40);
    console.log(line);
  }

  console.log(chalk.dim(`\n  These deals warrant manual review — the rubric scored them as worth exploring`));
  console.log(chalk.dim(`  but they were passed at the pipeline stage before full evaluation.\n`));
}
