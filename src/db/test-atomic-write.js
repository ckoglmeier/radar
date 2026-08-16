#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeDb,
  exec,
  query,
  withAtomicWrite,
  withTenant,
  writeCapabilities,
} from './index.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-atomic-write-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

try {
  await withTenant(databaseUrl, async () => {
    await exec(`
      CREATE TABLE atomic_write_events (
        id SERIAL PRIMARY KEY,
        writer TEXT NOT NULL,
        step INT NOT NULL
      )
    `);

    assert.deepEqual(await writeCapabilities(), {
      proposalApply: 'transactional',
      serializedWrites: true,
      driver: 'pglite',
      hosted: false,
    });

    await assert.rejects(
      () => withAtomicWrite(async () => {
        assert.deepEqual(await writeCapabilities(), {
          proposalApply: 'transactional',
          serializedWrites: true,
          driver: 'pglite',
          hosted: false,
        });
        await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('outer', 1)`);
        await withAtomicWrite(async () => {
          await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('nested', 1)`);
        });
        throw new Error('force outer rollback');
      }),
      /force outer rollback/,
    );
    assert.equal(
      Number((await query(`SELECT COUNT(*) AS count FROM atomic_write_events`))[0].count),
      0,
      'a nested write must not commit independently of its outer owner',
    );

    let releaseFirst;
    let firstStarted;
    const firstEntered = new Promise(resolve => { firstStarted = resolve; });
    const firstMayFinish = new Promise(resolve => { releaseFirst = resolve; });
    let secondEntered = false;

    const first = withAtomicWrite(async () => {
      await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('first', 1)`);
      firstStarted();
      await firstMayFinish;
      await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('first', 2)`);
    });
    await firstEntered;

    const second = withAtomicWrite(async () => {
      secondEntered = true;
      await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('second', 1)`);
      await query(`INSERT INTO atomic_write_events (writer, step) VALUES ('second', 2)`);
    });

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(secondEntered, false, 'a second writer entered before the first transaction finished');
    releaseFirst();
    await Promise.all([first, second]);

    const rows = await query(`
      SELECT writer, step
        FROM atomic_write_events
       ORDER BY id
    `);
    assert.deepEqual(rows, [
      { writer: 'first', step: 1 },
      { writer: 'first', step: 2 },
      { writer: 'second', step: 1 },
      { writer: 'second', step: 2 },
    ]);
  });

  console.log('atomic writes: capabilities, nesting, rollback, and serialization passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
