#!/usr/bin/env node

// Regression tests for the dual-driver layer (PGlite + Neon).
// Uses a THROWAWAY PGlite database in os.tmpdir() — no real DB required.
// Run: node src/db/test-driver.js

import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { rmSync, mkdirSync } from 'fs';
import { withTenant, query, closeDb, exec, runSchema } from './index.js';
import { fileURLToPath, pathToFileURL } from 'url';

// Absolute file: URL to db/index.js, so a child spawned from ANY cwd can import
// it. (Interpolating a cwd-relative './src/db/index.js' only resolved from the
// repo root and silently failed elsewhere.)
const INDEX_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')).href;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(
      `${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

// Allocate a fresh temp directory for each test db URL to guarantee isolation.
function makeTmpUrl(suffix = '') {
  const dir = path.join(os.tmpdir(), `radar-test-driver-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
  mkdirSync(dir, { recursive: true });
  return `file:${dir}`;
}

console.log('\n  DB Driver Regression Tests\n');

// ----------------------------------------------------------------
// Test 1: DATE normalization — local-midnight guarantee
// Regression guard for the 6-hour Neon/PGlite skew bug.
// PGlite returns UTC-midnight Dates; the driver normalizes to local midnight.
// ----------------------------------------------------------------
await test('DATE normalization: value is a Date at LOCAL midnight (getHours()===0, getDate()===29)', async () => {
  const url = makeTmpUrl('date');
  await withTenant(url, async () => {
    await exec(`CREATE TABLE _test_date (d DATE)`);
    await query(`INSERT INTO _test_date (d) VALUES ($1)`, ['2021-04-29']);
    const rows = await query(`SELECT d FROM _test_date`);
    const d = rows[0].d;
    if (!(d instanceof Date)) throw new Error(`expected Date, got ${typeof d}: ${d}`);
    eq(d.getHours(),   0, 'getHours()');
    eq(d.getDate(), 29, 'getDate()');
  });
});

// ----------------------------------------------------------------
// Test 2: Rows shape — query() returns a plain array, not {rows}
// ----------------------------------------------------------------
await test('query() returns a plain array (not {rows})', async () => {
  const url = makeTmpUrl('rows');
  await withTenant(url, async () => {
    await exec(`CREATE TABLE _test_shape (x INT)`);
    await query(`INSERT INTO _test_shape (x) VALUES (42)`);
    const result = await query(`SELECT x FROM _test_shape`);
    if (!Array.isArray(result)) throw new Error(`expected Array, got ${typeof result}`);
    eq(result.length, 1, 'length');
    eq(result[0].x, 42, 'value');
  });
});

// ----------------------------------------------------------------
// Test 3: Param binding — numeric + text + null round-trip via $1/$2
// ----------------------------------------------------------------
await test('Param binding: numeric + text + null round-trip', async () => {
  const url = makeTmpUrl('params');
  await withTenant(url, async () => {
    await exec(`CREATE TABLE _test_params (n NUMERIC, t TEXT, v TEXT)`);
    await query(`INSERT INTO _test_params (n, t, v) VALUES ($1, $2, $3)`, [42.5, 'hello', null]);
    const rows = await query(`SELECT n, t, v FROM _test_params`);
    eq(Number(rows[0].n), 42.5, 'numeric');
    eq(rows[0].t, 'hello', 'text');
    if (rows[0].v !== null) throw new Error(`expected null, got ${rows[0].v}`);
  });
});

// ----------------------------------------------------------------
// Test 4: withTenant isolation — two different file: URLs are separate databases
// ----------------------------------------------------------------
await test('withTenant file: URL routes to PGlite; data NOT visible on a different file: URL', async () => {
  const urlA = makeTmpUrl('tenantA');
  const urlB = makeTmpUrl('tenantB');

  // Insert inside tenant A
  await withTenant(urlA, async () => {
    await exec(`CREATE TABLE _test_tenant (x INT)`);
    await query(`INSERT INTO _test_tenant (x) VALUES (99)`);
    const rows = await query(`SELECT x FROM _test_tenant`);
    eq(rows[0].x, 99, 'visible inside tenant A');
  });

  // Tenant B should have no such table (separate DB)
  await withTenant(urlB, async () => {
    let caught = false;
    try {
      await query(`SELECT x FROM _test_tenant`);
    } catch {
      caught = true;
    }
    if (!caught) throw new Error('tenant B saw tenant A table — isolation broken');
  });
});

// ----------------------------------------------------------------
// Test 5: closeDb() — after close, fresh query() re-initializes; child CLI exits clean
// ----------------------------------------------------------------
await test('closeDb(): a spawned child process with DATABASE_URL=file:... exits within 30s', async () => {
  const url = makeTmpUrl('close');

  // Open a DB via withTenant, do some work, then close
  await withTenant(url, async () => {
    await exec(`CREATE TABLE _test_close (x INT)`);
    await query(`INSERT INTO _test_close (x) VALUES (1)`);
  });
  await closeDb();

  // Verify re-init after close: query() in the main process should not crash
  await withTenant(url, async () => {
    const rows = await query(`SELECT x FROM _test_close`);
    eq(rows[0].x, 1, 're-init after close');
  });
  await closeDb();

  // Spawn a child process that runs a trivial CLI query with DATABASE_URL=file:...
  // The CLI must exit naturally (not hang because PGlite keeps the event loop open).
  const exitedClean = (() => {
    try {
      execSync(
        `node -e "import(process.env.RADAR_INDEX_URL).then(async m => { await m.withTenant(process.env.DATABASE_URL, async () => { await m.query('SELECT 1'); }); await m.closeDb(); })"`,
        {
          cwd: os.tmpdir(), // exists on every platform; the import uses an absolute URL
          timeout: 30000,
          stdio: 'pipe',
          env: { ...process.env, DATABASE_URL: url, RADAR_INDEX_URL: INDEX_URL },
        }
      );
      return true;
    } catch (err) {
      if (err.signal === 'SIGTERM' || err.status === null) return false; // timeout
      // Non-zero exit is still a clean exit for our purposes
      return true;
    }
  })();
  if (!exitedClean) throw new Error('child process did not exit within 30s — event-loop hang regression');
});

// ----------------------------------------------------------------
// Test 6: Multi-statement exec path — runSchema with two CREATE TABLE statements
// ----------------------------------------------------------------
await test('runSchema() with two CREATE TABLE statements in one string works on PGlite', async () => {
  const url = makeTmpUrl('schema');
  await withTenant(url, async () => {
    await runSchema(`
      CREATE TABLE IF NOT EXISTS _test_schema_a (id SERIAL PRIMARY KEY, val TEXT);
      CREATE TABLE IF NOT EXISTS _test_schema_b (id SERIAL PRIMARY KEY, num INT);
    `);
    await query(`INSERT INTO _test_schema_a (val) VALUES ($1)`, ['ok']);
    await query(`INSERT INTO _test_schema_b (num) VALUES ($1)`, [7]);
    const a = await query(`SELECT val FROM _test_schema_a`);
    const b = await query(`SELECT num FROM _test_schema_b`);
    eq(a[0].val, 'ok', 'table a');
    eq(b[0].num, 7, 'table b');
  });
});

// ----------------------------------------------------------------
// Cleanup: close all PGlite instances opened during this test run
// ----------------------------------------------------------------
await closeDb();

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
