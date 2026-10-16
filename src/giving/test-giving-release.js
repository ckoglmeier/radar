// Local release safety gates. Synthetic records only; every database is disposable.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { createGift, addRefund, addDafContribution, givingReport, saveLens, saveBudget,
  saveSnapshot, getSnapshot, exportGiving, resetGiving } from '../models/giving.js';
import { buildReport, trailingWindows } from './report.js';
import { localToday } from '../utils/date-only.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-giving-release-'));
const originalTZ = process.env.TZ;
try {
  assert.deepEqual(trailingWindows('2028-02-29').current, { after: '2027-02-28', through: '2028-02-29' });
  const reports = [];
  for (const zone of ['UTC', 'America/Denver', 'Asia/Tokyo']) {
    process.env.TZ = zone;
    reports.push(['2025-02-28', '2026-03-08', '2026-11-01'].map(asOf => buildReport({ asOf, gifts: [
      { id: 'leap', organization_id: 'org', organization_name: 'Fixture', amount_cents: 100, currency: 'USD', paid_on: '2024-02-29' },
    ] })));
  }
  assert.deepEqual(reports[0], reports[1]);
  assert.deepEqual(reports[1], reports[2]);
  assert.equal(reports[0][0].totals[0].net_cents, 100);
  process.env.TZ = 'America/Denver';
  assert.equal(localToday(new Date('2026-10-17T05:30:00Z')), '2026-10-16');
  let backup, exported, snapshot, protectedRows;
  const args = { workspaceId: 'local' };
  const sorted = tables => Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
  await withTenant(`file:${join(scratch, 'source')}`, async () => {
    await runMigrations();
    await query("INSERT INTO investments (company_name, invest_date, asset_class, source) VALUES ('Release safety fixture', '2024-01-01', 'direct', 'test')");
    protectedRows = await query('SELECT * FROM investments');
    const gift = await createGift({ ...args, organization: { name: 'Synthetic Giving Organization' }, gift: { amount_cents: 250000, paid_on: '2025-09-20', vehicle: 'daf_grant' } });
    await addDafContribution({ ...args, amountCents: 1000000, contributedOn: '2026-01-01' });
    await addRefund({ ...args, giftId: gift.id, amountCents: 10000, refundedOn: '2025-10-20' });
    await addRefund({ ...args, giftId: gift.id, amountCents: 2000 });
    const report = await givingReport({ ...args, asOf: '2026-10-16' });
    assert.equal(report.totals[0].net_cents, -10000, 'dated refund follows its own window; DAF funding excluded');
    assert.equal(report.prior_totals[0].net_cents, 248000, 'undated refund follows original gift');
    snapshot = await saveSnapshot({ ...args, kind: 'report', asOf: '2026-10-16', payload: report });
    await saveLens({ ...args, lens: { causes: [{ id: 'education', label: 'Education' }], priorities: [] } });
    await saveLens({ ...args, lens: { causes: [{ id: 'education', label: 'Learning' }], priorities: [] } });
    for (const amount_cents of [10000, 20000]) await saveBudget({ ...args, budget: { starts_on: '2026-10-17', ends_on: '2027-10-16', mode: 'custom', amount_cents } });
    await assert.rejects(query('UPDATE giving_lens_versions SET version = 99 WHERE version = 1'), /immutable/);
    await assert.rejects(query('UPDATE giving_budgets SET amount_cents = 0 WHERE version = 1'), /immutable/);
    assert.equal((await getSnapshot({ ...args, snapshotId: snapshot.id })).payload_sha256, snapshot.payload_sha256);
    exported = sorted((await exportGiving(args)).tables);
    backup = await createDatabaseBackupPayload({ includeLocalOnly: true });
  });
  await closeDb();
  await withTenant(`file:${join(scratch, 'restored')}`, async () => {
    await runMigrations();
    await restoreDatabase({ content: backup.content });
    assert.deepEqual(sorted((await exportGiving(args)).tables), exported, 'all sixteen Giving tables survive restore exactly');
    assert.equal((await getSnapshot({ ...args, snapshotId: snapshot.id })).payload_sha256, snapshot.payload_sha256);
    await assert.rejects(query("UPDATE giving_snapshots SET label = 'changed'"), /immutable/, 'restore preserves immutability triggers');
    await resetGiving(args);
    assert(Object.values((await exportGiving(args)).tables).every(rows => rows.length === 0));
    assert.deepEqual(await query('SELECT * FROM investments'), protectedRows, 'Giving reset leaves investment rows unchanged');
  });
  console.log('giving release gates: dates, refunds, DAF exclusion, immutable snapshots, all-table restore and reset isolation passed');
} finally {
  await closeDb();
  if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
  rmSync(scratch, { recursive: true, force: true });
}
