#!/usr/bin/env node

import os from 'os';
import path from 'path';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { withTenant, query, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { exportBeancount } from './beancount.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    failed++;
  }
}

function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}: ` : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run() {
  const tempDir = path.join(
    os.tmpdir(),
    `radar-test-beancount-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const dbDir = path.join(tempDir, 'db');
  const outputPath = path.join(tempDir, 'portfolio.beancount');
  mkdirSync(tempDir, { recursive: true });

  try {
    const result = await withTenant(`file:${dbDir}`, async () => {
      await runMigrations();

      for (const [companyName, assetClass, invested] of [
        ['Boundary Direct Company', 'direct', 1000],
        ['Boundary Fund Vehicle', 'fund', 2000],
        ['Boundary Employment Award', 'employment_equity', 3000],
        ['Boundary Merged Source', 'merged', 4000],
      ]) {
        const rows = await query(`
          INSERT INTO investments
            (company_name, status, invest_date, invested, unrealized_value,
             net_value, multiple, asset_class)
          VALUES ($1, 'Live', '2026-01-01', $2, $2, $2, 1, $3)
          RETURNING id
        `, [companyName, invested, assetClass]);
        const investmentId = rows[0].id;
        await query(`
          INSERT INTO cash_flows (investment_id, flow_date, type, amount)
          VALUES ($1, '2026-01-01', 'investment', $2)
        `, [investmentId, -invested]);
        await query(`
          INSERT INTO valuations
            (investment_id, snapshot_date, unrealized_value, net_value, multiple, source)
          VALUES ($1, '2026-06-30', $2, $2, 1, 'test')
        `, [investmentId, invested]);
      }

      return exportBeancount(outputPath);
    });

    const content = readFileSync(outputPath, 'utf8');

    await test('Beancount exports only Direct positions, flows, and valuations', async () => {
      eq(result.investments, 1, 'investment count');
      eq(result.transactions, 1, 'transaction count');
      eq(result.valuations, 1, 'valuation count');
      eq(content.includes('Boundary Direct Company'), true, 'Direct position missing');
      for (const excluded of ['Boundary Fund Vehicle', 'Boundary Employment Award', 'Boundary Merged Source']) {
        eq(content.includes(excluded), false, `${excluded} leaked`);
      }
    });
  } finally {
    await closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(error => {
  console.error('FATAL:', error);
  process.exit(1);
});
