#!/usr/bin/env node

// Focused DB-backed tests for transaction import wrappers.
// Uses throwaway PGlite databases and temp CSV fixtures — no real DB required.
//
// Run: DATABASE_URL=file:./.radar-test-local node src/import/test-transactions-db.js

import os from 'os';
import path from 'path';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { withTenant, query, closeDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { upsertInvestment } from '../models/investments.js';
import { importTransactionLedger, importTransactionRows } from './transactions.js';

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

function makeTmpDir(suffix = '') {
  const dir = path.join(
    os.tmpdir(),
    `radar-test-transactions-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function setupTenant(url) {
  await withTenant(url, async () => {
    await runMigrations();
    await upsertInvestment({
      company_name: 'Acme Robotics',
      status: 'Live',
      invest_date: '2026-03-01',
      invested: 1000,
      unrealized_value: 1200,
      realized_value: 0,
      net_value: 1200,
      multiple: 1.2,
      investment_entity: null,
      lead: null,
      investment_type: null,
      round: 'Seed',
      stage_bucket: 'seed',
      market: null,
      fund_name: null,
      allocation: null,
      instrument: null,
      round_size: null,
      valuation_cap_type: null,
      valuation_cap: null,
      discount: null,
      carry: null,
      share_class: null,
      source: 'angellist',
    });
  });
}

async function loadCashFlows(url) {
  return withTenant(url, async () => {
    return query(`
      SELECT type, amount, source, company_raw, investment_id, external_hash
      FROM cash_flows
      ORDER BY flow_date, id
    `);
  });
}

async function run() {
  const rows = [
    {
      Date: '2026-03-16',
      Transaction: 'Investment',
      Description: 'Investment in Acme Robotics',
      Amount: '-1000.00',
      Balance: '9000.00',
    },
    {
      Date: '2026-03-20',
      Transaction: 'Disbursement',
      Description: 'Acme Robotics - Distribution Proceeds - Example Ventures SPV',
      Amount: '250.00',
      Balance: '9250.00',
    },
  ];

  const tempDir = makeTmpDir();
  const csvPath = path.join(tempDir, 'ledger.csv');
  writeFileSync(
    csvPath,
    [
      'Date,Transaction,Description,Amount,Balance',
      ...rows.map(row => `${row.Date},${row.Transaction},${row.Description},${row.Amount},${row.Balance}`),
    ].join('\n')
  );

  const fileDbDir = makeTmpDir('-file-db');
  const rowsDbDir = makeTmpDir('-rows-db');
  const fileUrl = `file:${fileDbDir}`;
  const rowsUrl = `file:${rowsDbDir}`;

  try {
    await setupTenant(fileUrl);
    await setupTenant(rowsUrl);

    const fileResults = await withTenant(fileUrl, async () => {
      const first = await importTransactionLedger(csvPath);
      const second = await importTransactionLedger(csvPath);
      return { first, second };
    });

    const rowResults = await withTenant(rowsUrl, async () => {
      const first = await importTransactionRows(rows, { source: 'browser_upload' });
      const second = await importTransactionRows(rows, { source: 'browser_upload' });
      return { first, second };
    });

    await test('importTransactionRows dedups the same rows the file importer dedups', async () => {
      eq(fileResults.first.inserted, 2, 'file importer first inserted');
      eq(fileResults.first.skipped, 0, 'file importer first skipped');
      eq(fileResults.second.inserted, 0, 'file importer second inserted');
      eq(fileResults.second.skipped, 2, 'file importer second skipped');

      eq(rowResults.first.inserted, fileResults.first.inserted, 'rows first inserted');
      eq(rowResults.first.skipped, fileResults.first.skipped, 'rows first skipped');
      eq(rowResults.first.matched, fileResults.first.matched, 'rows first matched');
      eq(rowResults.second.inserted, fileResults.second.inserted, 'rows second inserted');
      eq(rowResults.second.skipped, fileResults.second.skipped, 'rows second skipped');
      eq(
        rowResults.first.unmatched_company_refs.join(','),
        fileResults.first.unmatched_company_refs.join(','),
        'unmatched company refs'
      );

      const fileFlows = await loadCashFlows(fileUrl);
      const rowFlows = await loadCashFlows(rowsUrl);
      eq(fileFlows.length, 2, 'file importer cash flow count');
      eq(rowFlows.length, 2, 'rows importer cash flow count');
      eq(fileFlows.map(r => r.external_hash).join(','), rowFlows.map(r => r.external_hash).join(','), 'hashes');
      eq(fileFlows[0].type, 'investment', 'investment type preserved');
      eq(Number(fileFlows[0].amount), -1000, 'investment sign preserved');
      eq(fileFlows[1].type, 'distribution', 'distribution type preserved');
      eq(Number(fileFlows[1].amount), 250, 'distribution sign preserved');
      eq(Number(rowFlows[0].investment_id) > 0, true, 'rows importer linked investment');
      eq(rowFlows[0].source, 'browser_upload', 'rows importer should honor source option');
    });
  } finally {
    await closeDb();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(fileDbDir, { recursive: true, force: true });
    rmSync(rowsDbDir, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
