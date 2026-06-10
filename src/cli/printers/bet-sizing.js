/**
 * Printer for bet-size report output.
 */

import chalk from 'chalk';

export function printBetSize(data) {
  if (!data.found) {
    console.error(chalk.red(`\n  No evaluation found. Run 'radar eval import' first.\n`));
    process.exit(1);
  }

  console.log(chalk.bold(`\n  ${data.companyName}  —  Score: ${data.score}/50  —  Round: ${data.round}`));
  console.log(chalk.dim(`  Band: ${data.band}  |  Cluster: ${data.cluster || 'uncategorized'}`));
  console.log('');

  if (data.pass) {
    console.log(chalk.red(`  Rubric tier: PASS — ${data.tier?.reason || 'no check in conviction era'}.\n`));
    return;
  }

  console.log(`  Rubric tier:  ${chalk.green(data.tier.tier)}  (${data.tier.reason})`);

  // Distribution summary
  const dist = data.distribution;
  console.log(chalk.dim(`\n  Distribution (${data.band}):`));
  dist.outcomes.forEach((o, i) => {
    const bar = '\u2588'.repeat(Math.round(dist.probs[i] * 20));
    console.log(`    ${String(o + 'x').padEnd(6)} ${(dist.probs[i] * 100).toFixed(0).padStart(3)}%  ${bar}`);
  });
  console.log(`    EV: ${data.ev.toFixed(1)}x`);
  if (dist.calibration_note) console.log(chalk.dim(`    Note: ${dist.calibration_note}`));

  // Kelly sizing
  if (data.kellySkipped) {
    console.log(chalk.yellow('\n  Kelly sizing skipped — risk_capital and floor not set in src/config/bet-sizing.json'));
    console.log(chalk.dim('  Edit that file with your personal risk capital parameters to enable Kelly output.\n'));
    return;
  }

  if (data.kellyError) {
    console.log(chalk.yellow('\n  Kelly solver error: ' + data.kellyError));
    console.log('');
    return;
  }

  if (data.kelly) {
    const { recommendation_low: recLow, recommendation_high: recHigh, binding_constraint: binding, lenses } = data.kelly;

    console.log('\n  Kelly sizing:');
    console.log(`  Recommendation:      ${chalk.green('$' + recLow.toLocaleString())} – ${chalk.green('$' + recHigh.toLocaleString())}`);
    console.log(`  Binding constraint:  ${chalk.dim(binding)}`);
    console.log(chalk.dim('\n  Lenses:'));
    const keyLenses = ['illiquidity_adjusted', 'single_position_cap', 'cluster_cap_room', 'ruin_constrained_max', 'available_capital', 'annual_budget_remaining'];
    for (const key of keyLenses) {
      if (lenses[key] != null) {
        console.log(`    ${key.padEnd(30)} $${Math.round(lenses[key]).toLocaleString()}`);
      }
    }
    if (data.kelly.notes?.length) {
      for (const n of data.kelly.notes) console.log(chalk.yellow(`\n  ! ${n}`));
    }

    if (data.exceedCap) {
      const annualNote = data.exceedCap.annualRemaining != null
        ? ` and $${data.exceedCap.annualRemaining.toLocaleString()} (annual budget remaining)`
        : '';
      console.log(
        chalk.bold.yellow(
          `\n  \u2605 EXCEED-CAP FLAG: Kelly supports up to $${data.exceedCap.ilAdj.toLocaleString()} ` +
          `(illiquidity-adjusted), $${data.exceedCap.singleCap.toLocaleString()} (single-position cap)${annualNote}. ` +
          `Consider $${data.exceedCap.suggested.toLocaleString()} for this position.`
        )
      );
    }
  }

  console.log('');
}
