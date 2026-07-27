import {
  consolidatePositions,
  keepPositionsSeparate,
  positionDuplicateGroups,
  resolveCashFlows,
} from './reconciliation.js';
import { closeDb, query } from '../db/index.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    failed++;
  }
}

const stamp = Date.now();
const companyName = `Reconciliation Test ${stamp}`;
const flowHash = suffix => `reconciliation-${stamp}-${suffix}`;

console.log('\n  transaction reconciliation tests\n');

const positions = await query(
  `INSERT INTO investments
     (company_name, status, invest_date, invested, unrealized_value, net_value, multiple, source)
   VALUES
     ($1, 'Live', '2025-01-01', 1000, 1000, 1000, 1, 'test'),
     ($1, 'Live', '2025-02-01', 1000, 1000, 1000, 1, 'test')
   RETURNING id, invest_date`,
  [companyName],
);
const targetId = Number(positions[0].id);
const sourceId = Number(positions[1].id);

const flows = await query(
  `INSERT INTO cash_flows
     (investment_id, flow_date, type, amount, company_raw, source, external_hash)
   VALUES
     (NULL, '2025-01-01', 'investment', -100, 'Ignore Me', 'test', $1),
     (NULL, '2025-01-02', 'investment', -200, 'Route Me', 'test', $2),
     ($3, '2025-02-01', 'investment', -1000, $4, 'test', $5)
   RETURNING id`,
  [flowHash('ignore'), flowHash('fund'), sourceId, companyName, flowHash('linked')],
);

await test('ignore is persisted and removed from pending work', async () => {
  const result = await resolveCashFlows({
    cashFlowIds: [flows[0].id],
    action: 'ignored',
    note: 'Not a portfolio transaction',
  });
  if (result.length !== 1 || result[0].reconciliation_status !== 'ignored') {
    throw new Error('ignore disposition was not persisted');
  }
});

await test('fund routing is persisted for the future Funds surface', async () => {
  const result = await resolveCashFlows({
    cashFlowIds: [flows[1].id],
    action: 'fund',
    note: 'LP capital call',
  });
  if (result.length !== 1 || result[0].reconciliation_status !== 'fund') {
    throw new Error('fund disposition was not persisted');
  }
});

await test('duplicate positions can be reviewed as separate', async () => {
  const before = await positionDuplicateGroups();
  if (!before.some(group => group.positions.some(row => Number(row.id) === targetId))) {
    throw new Error('duplicate group was not detected');
  }
  await keepPositionsSeparate([targetId, sourceId]);
  const after = await positionDuplicateGroups();
  if (after.some(group => group.positions.some(row => Number(row.id) === targetId))) {
    throw new Error('reviewed duplicate group remained visible');
  }
});

await test('consolidation preserves source and moves linked records', async () => {
  await consolidatePositions({
    targetInvestmentId: targetId,
    sourceInvestmentIds: [sourceId],
  });
  const source = (await query(
    `SELECT asset_class FROM investments WHERE id = $1`,
    [sourceId],
  ))[0];
  if (source.asset_class !== 'merged') throw new Error('source position was not archived as merged');

  const moved = (await query(
    `SELECT investment_id FROM cash_flows WHERE id = $1`,
    [flows[2].id],
  ))[0];
  if (Number(moved.investment_id) !== targetId) throw new Error('cash flow was not moved');

  const audit = await query(
    `SELECT id FROM investment_consolidations
      WHERE source_investment_id = $1 AND target_investment_id = $2`,
    [sourceId, targetId],
  );
  if (audit.length !== 1) throw new Error('consolidation audit row is missing');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
await closeDb();
if (failed > 0) process.exit(1);
