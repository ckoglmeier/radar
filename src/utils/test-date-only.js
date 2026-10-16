// Calendar dates must not shift by time zone or DST. Re-runs itself under UTC, a UTC−
// zone with DST (America/Denver) and a UTC+ zone (Asia/Tokyo).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.DATE_ONLY_TZ_CHILD) {
  for (const tz of ['UTC', 'America/Denver', 'Asia/Tokyo']) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TZ: tz, DATE_ONLY_TZ_CHILD: '1' }, stdio: 'inherit' });
  }
  console.log('date-only: UTC, America/Denver and Asia/Tokyo passed');
} else {
  const { addDaysIso, addYearsIso, dateOnly, daysBetweenIso, localToday } = await import('./date-only.js');
  const { legacyInvestmentSourceKey } = await import('../models/investments.js');
  const tz = process.env.TZ;

  // How pg and PGlite deliver DATE '2026-03-01': a Date at local midnight.
  const dbDate = new Date(2026, 2, 1);
  assert.equal(dateOnly(dbDate), '2026-03-01', `${tz}: DATE read from the database`);
  assert.equal(dateOnly('2026-03-01'), '2026-03-01');
  assert.equal(dateOnly('2026-03-01T23:30:00Z'), '2026-03-01');
  assert.equal(dateOnly(null), null);
  assert.equal(dateOnly('not a date'), null);
  // A timestamp (not local midnight) keeps its UTC date, as before.
  assert.equal(dateOnly(new Date('2026-03-01T12:34:56Z')), '2026-03-01');

  // Across the March and November DST changes in America/Denver.
  assert.equal(addDaysIso('2026-03-01', 30), '2026-03-31', `${tz}: across spring DST`);
  assert.equal(addDaysIso('2026-10-20', 30), '2026-11-19', `${tz}: across fall DST`);
  assert.equal(addDaysIso(dbDate, 1), '2026-03-02');
  assert.equal(addYearsIso('2021-03-01', 5), '2026-03-01');
  assert.equal(daysBetweenIso('2026-03-01', '2026-03-31'), 30, `${tz}: day count across DST`);
  assert.equal(daysBetweenIso(dbDate, '2026-03-02'), 1);

  // "Today" is the local calendar date, never the UTC one.
  const instant = new Date('2026-03-01T20:00:00Z');
  assert.equal(localToday(instant), { UTC: '2026-03-01', 'America/Denver': '2026-03-01', 'Asia/Tokyo': '2026-03-02' }[tz], `${tz}: local today`);
  const evening = new Date('2026-03-02T03:00:00Z');
  assert.equal(localToday(evening), { UTC: '2026-03-02', 'America/Denver': '2026-03-01', 'Asia/Tokyo': '2026-03-02' }[tz], `${tz}: evening today`);
  assert.equal(localToday(), dateOnly(new Date(new Date().setHours(0, 0, 0, 0))));

  // The same investment keyed from a DB Date or a string gets the same key.
  assert.equal(legacyInvestmentSourceKey('Acme', dbDate), legacyInvestmentSourceKey('Acme', '2026-03-01'), `${tz}: investment key`);

  // Round trip through a real embedded database.
  const { closeDb, query, withTenant } = await import('../db/index.js');
  const scratch = mkdtempSync(join(tmpdir(), 'radar-date-only-'));
  try {
    await withTenant(`file:${join(scratch, 'db')}`, async () => {
      const [row] = await query(`SELECT DATE '2026-03-01' AS d`);
      assert.equal(dateOnly(row.d), '2026-03-01', `${tz}: PGlite DATE round trip`);

      // Future-date checks use the local date. Clock pinned to 2026-03-01T20:00Z: in Tokyo it is
      // already the morning of 2026-03-02 while the UTC date is still 2026-03-01.
      const { runMigrations } = await import('../db/migrate.js');
      await runMigrations();
      const { updateInvestmentUpdateMetadata } = await import('../models/investment-updates.js');
      const { recordEmploymentEquityIssuerMark } = await import('../models/employment-equity.js');
      const { mock } = await import('node:test');
      const today = localToday(instant);
      const tomorrow = addDaysIso(today, 1);
      const future = /cannot be in the future/;
      const rejection = async promise => { try { await promise; return null; } catch (error) { return error.message; } };
      mock.timers.enable({ apis: ['Date'], now: instant });
      try {
        assert.doesNotMatch(await rejection(updateInvestmentUpdateMetadata('00000000-0000-4000-8000-000000000000', { receivedDate: today })) || '', future, `${tz}: received today is allowed`);
        assert.match(await rejection(updateInvestmentUpdateMetadata('00000000-0000-4000-8000-000000000000', { receivedDate: tomorrow })) || '', future, `${tz}: received tomorrow is refused`);
        const mark = date => recordEmploymentEquityIssuerMark('00000000-0000-4000-8000-000000000000', { currency: 'USD', markType: 'tax_409a', date, valuePerUnit: 1 });
        assert.doesNotMatch(await rejection(mark(today)) || '', future, `${tz}: issuer mark dated today is allowed`);
        assert.match(await rejection(mark(tomorrow)) || '', future, `${tz}: issuer mark dated tomorrow is refused`);
      } finally {
        mock.timers.reset();
      }
    });
  } finally {
    await closeDb();
    rmSync(scratch, { recursive: true, force: true });
  }
}
