// Gift dates survive a round trip in a time zone east of UTC (DATE values arrive at local midnight).
process.env.TZ = 'Asia/Tokyo';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { addRefund, createGift, getGift, givingReport, saveBudget } from '../models/giving.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-giving-tz-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const gift = await createGift({ workspaceId: 'local', organization: { name: 'Edge Org' }, gift: { amount_cents: 1000, paid_on: '2025-10-17', vehicle: 'direct' } });
    assert.equal((await getGift({ workspaceId: 'local', giftId: gift.id })).paid_on, '2025-10-17');
    assert.equal((await addRefund({ workspaceId: 'local', giftId: gift.id, amountCents: 100, refundedOn: '2026-03-01' })).refunded_on, '2026-03-01');
    // The first day of the window must stay inside it.
    assert.equal((await givingReport({ workspaceId: 'local', asOf: '2026-10-16' })).totals[0].net_cents, 900);
    const budget = await saveBudget({ workspaceId: 'local', budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'skipped' } });
    assert.deepEqual([budget.starts_on, budget.ends_on], ['2026-10-17', '2027-10-16']);
  });
  console.log('giving timezone: dates round-trip east of UTC');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
