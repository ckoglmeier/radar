import {
  dismissAttentionItem,
  listAttentionDismissals,
  restoreAllAttentionItems,
  restoreAttentionItem,
} from './attention-dismissals.js';
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

console.log('\n  attention dismissal tests\n');
await query(`DELETE FROM attention_dismissals`);

await test('dismissal is persisted', async () => {
  await dismissAttentionItem({ signalKey: 'quiet_founder:42:none', signalType: 'quiet_founder' });
  const rows = await listAttentionDismissals();
  if (rows.length !== 1 || rows[0].signal_key !== 'quiet_founder:42:none') {
    throw new Error('dismissal was not listed');
  }
});

await test('same signal is idempotent', async () => {
  await dismissAttentionItem({ signalKey: 'quiet_founder:42:none', signalType: 'quiet_founder' });
  const rows = await listAttentionDismissals();
  if (rows.length !== 1) throw new Error(`expected 1 dismissal, got ${rows.length}`);
});

await test('restored signal is visible again', async () => {
  const restored = await restoreAttentionItem('quiet_founder:42:none');
  if (!restored) throw new Error('dismissal was not restored');
  const rows = await listAttentionDismissals();
  if (rows.length !== 0) throw new Error('dismissal still exists');
});

await test('all cleared signals can be restored', async () => {
  await dismissAttentionItem({ signalKey: 'quiet_founder:42:none', signalType: 'quiet_founder' });
  await dismissAttentionItem({ signalKey: 'qsbs_window:8:soon', signalType: 'qsbs_window' });
  const restored = await restoreAllAttentionItems();
  if (restored.length !== 2) throw new Error(`expected 2 restored rows, got ${restored.length}`);
  const rows = await listAttentionDismissals();
  if (rows.length !== 0) throw new Error('dismissals still exist');
});

await query(`DELETE FROM attention_dismissals`);
console.log(`\n  ${passed} passed, ${failed} failed\n`);
await closeDb();
if (failed > 0) process.exit(1);
