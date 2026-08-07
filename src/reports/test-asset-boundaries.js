#!/usr/bin/env node

import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import { withTenant, query, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { evalDiscover, evalValidate } from './evaluations.js';
import { portfolioDetail, reconcilePortfolio } from './portfolio.js';

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
    `radar-test-asset-boundaries-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const dbDir = path.join(tempDir, 'db');
  mkdirSync(tempDir, { recursive: true });

  try {
    await withTenant(`file:${dbDir}`, async () => {
      await runMigrations();

      for (const [companyName, assetClass, invested] of [
        ['Boundary Direct One', 'direct', 1000],
        ['Boundary Direct Two', 'direct', 1100],
        ['Boundary Direct Three', 'direct', 1200],
        ['Boundary Direct Four', 'direct', 1300],
        ['Boundary Direct Five', 'direct', 1400],
        ['Boundary Fund', 'fund', 2000],
        ['Boundary Employment', 'employment_equity', 3000],
        ['Boundary Merged', 'merged', 4000],
      ]) {
        const rows = await query(`
          INSERT INTO investments
            (company_name, status, invest_date, invested, unrealized_value,
             net_value, multiple, asset_class)
          VALUES ($1, 'Live', '2026-01-01', $2, $2, $2, 1, $3)
          RETURNING id
        `, [companyName, invested, assetClass]);
        await query(`
          INSERT INTO deal_evaluations
            (investment_id, eval_date, total_score, verdict, invested)
          VALUES ($1, '2026-01-01', 40, 'INVEST', TRUE)
        `, [rows[0].id]);
      }

      await test('evaluation discovery includes Direct positions only', async () => {
        const result = await evalDiscover({ since: '2026-01-01', until: '2026-12-31' });
        eq(result.n, 5, 'analytics input count');
        eq(result.n_total, 5, 'total input count');
      });

      await test('evaluation validation excludes non-direct linked evaluations', async () => {
        const result = await evalValidate({ since: '2026-01-01', until: '2026-12-31' });
        eq(result.deals.length, 5, 'deal count');
        eq(result.deals.every(row => row.company.startsWith('Boundary Direct ')), true);
      });

      await test('Direct portfolio detail cannot open another asset class', async () => {
        eq((await portfolioDetail('Boundary Direct One')).length, 1);
        eq((await portfolioDetail('Boundary Fund')).length, 0);
        eq((await portfolioDetail('Boundary Employment')).length, 0);
        eq((await portfolioDetail('Boundary Merged')).length, 0);
      });

      await test('portfolio reconciliation labels and excludes non-direct positions', async () => {
        const result = await reconcilePortfolio();
        eq(result.scope, 'direct');
        eq(result.excluded_non_direct.length, 3);
        eq(result.excluded_non_direct.map(row => row.asset_class).join(','), 'employment_equity,fund,merged');
        const serializedDefects = JSON.stringify({
          mismatched: result.mismatched,
          missing: result.missing_cash_flows,
          zero: result.zero_value,
          exact: result.exact_duplicates,
          possible: result.possible_duplicates,
        });
        for (const companyName of ['Boundary Fund', 'Boundary Employment', 'Boundary Merged']) {
          eq(serializedDefects.includes(companyName), false, `${companyName} reported as a Direct defect`);
        }
      });
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
