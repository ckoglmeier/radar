#!/usr/bin/env node

// One-time cleanup: collapse duplicate valuation snapshots.
//
// Background: createValuationSnapshot in src/models/investments.js used
// `INSERT ... ON CONFLICT DO NOTHING` without a unique constraint, so re-runs
// of an import on the same day silently inserted duplicate rows. This script
// keeps the lowest id (first write) per (investment_id, snapshot_date) group.
//
// First-write-wins is a deliberate choice: it matches the behavior the missing
// unique constraint *would* have produced. Some duplicate groups have
// divergent values across snapshots (the second import had refreshed marks);
// preflight surfaces the count so the operator sees what's about to collapse.
//
// The valuations table has a BEFORE DELETE trigger (valuations_immutable). We
// disable it for the cleanup and re-enable it in a finally block so the
// trigger never stays off if the script crashes mid-run.
//
// Usage:
//   node scripts/dedup-valuations.js          # dry run, prints summary
//   node scripts/dedup-valuations.js --apply  # actually delete duplicates

import { query } from '../src/db/index.js';

async function main() {
  const apply = process.argv.includes('--apply');

  const groups = await query(`
    SELECT investment_id, snapshot_date, COUNT(*) AS n,
           COUNT(DISTINCT unrealized_value) AS unreal_v,
           COUNT(DISTINCT realized_value)  AS real_v,
           COUNT(DISTINCT net_value)       AS net_v,
           COUNT(DISTINCT multiple)        AS mult_v
    FROM valuations
    GROUP BY investment_id, snapshot_date
    HAVING COUNT(*) > 1
    ORDER BY n DESC, investment_id
  `);

  if (groups.length === 0) {
    console.log('No duplicate valuation snapshots found. Nothing to do.');
    return;
  }

  const totalRowsToDelete = groups.reduce((s, g) => s + (Number(g.n) - 1), 0);
  const valueDivergent = groups.filter(g =>
    Number(g.unreal_v) > 1 || Number(g.real_v) > 1 ||
    Number(g.net_v) > 1 || Number(g.mult_v) > 1
  );

  console.log(`Found ${groups.length} duplicate (investment_id, snapshot_date) groups.`);
  console.log(`Rows to delete (keeping lowest id per group): ${totalRowsToDelete}`);
  console.log(`Groups with value-divergent duplicates: ${valueDivergent.length}`);
  console.log('');
  console.log('Top 10 largest groups:');
  for (const g of groups.slice(0, 10)) {
    const date = new Date(g.snapshot_date).toISOString().slice(0, 10);
    console.log(`  inv=${g.investment_id} ${date}  n=${g.n}  unreal_v=${g.unreal_v} real_v=${g.real_v} net_v=${g.net_v} mult_v=${g.mult_v}`);
  }

  if (!apply) {
    console.log('\nDry run. Pass --apply to execute the dedup.');
    return;
  }

  console.log('\nApplying dedup...');
  let triggerDisabled = false;
  try {
    await query(`ALTER TABLE valuations DISABLE TRIGGER valuations_immutable`);
    triggerDisabled = true;

    const result = await query(`
      DELETE FROM valuations a
      USING valuations b
      WHERE a.id > b.id
        AND a.investment_id = b.investment_id
        AND a.snapshot_date = b.snapshot_date
      RETURNING a.id
    `);
    console.log(`Deleted ${result.length} duplicate snapshot rows.`);
  } finally {
    if (triggerDisabled) {
      await query(`ALTER TABLE valuations ENABLE TRIGGER valuations_immutable`);
      console.log('Trigger valuations_immutable re-enabled.');
    }
  }

  const remaining = await query(`
    SELECT COUNT(*)::int AS n FROM (
      SELECT 1 FROM valuations
      GROUP BY investment_id, snapshot_date
      HAVING COUNT(*) > 1
    ) sub
  `);
  console.log(`Remaining duplicate groups: ${remaining[0].n}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
