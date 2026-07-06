#!/usr/bin/env node

// Integration tests for the composed attention report.
// Run: node src/reports/test-attention.js

import { query } from '../db/index.js';
import { upsertInvestment } from '../models/investments.js';
import { createRoom, addPipelineItem } from '../models/rooms.js';
import { attentionReport, clusterExposure, relatedDeals } from './attention.js';

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
    throw new Error(`${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, msg = 'expected truthy value') {
  if (!value) throw new Error(msg);
}

const BASE_INVESTMENT = {
  status: 'Live',
  invested: 5000,
  unrealized_value: 5000,
  realized_value: 0,
  net_value: 5000,
  multiple: 1,
  investment_entity: null,
  lead: 'Apex Syndicate',
  investment_type: null,
  round: 'Seed',
  stage_bucket: 'seed',
  market: 'Robotics',
  fund_name: null,
  allocation: null,
  instrument: null,
  round_size: null,
  valuation_cap_type: null,
  valuation_cap: null,
  discount: null,
  carry: null,
  share_class: null,
  source: 'test',
};

async function cleanup(stamp) {
  const companies = [`ZZATTN QSBS ${stamp}`, `ZZATTN Quiet ${stamp}`, `ZZATTN Related ${stamp}`];
  const investmentRows = await query(
    `SELECT id FROM investments WHERE company_name = ANY($1::text[])`,
    [companies]
  );
  const ids = investmentRows.map(row => row.id);

  if (ids.length > 0) {
    await query(`DELETE FROM company_updates WHERE investment_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM investment_theses WHERE investment_id = ANY($1::int[])`, [ids]);
    await query(`DELETE FROM investments WHERE id = ANY($1::int[])`, [ids]);
  }
  await query(`DELETE FROM room_pipeline WHERE cells::text LIKE $1`, [`%${stamp}%`]);
  await query(`DELETE FROM rooms WHERE name LIKE $1`, [`ZZATTN Room ${stamp}%`]);
}

async function run() {
  const stamp = Date.now();
  const qsbsCompany = `ZZATTN QSBS ${stamp}`;
  const quietCompany = `ZZATTN Quiet ${stamp}`;
  const relatedCompany = `ZZATTN Related ${stamp}`;

  try {
    await cleanup(stamp);

    const qsbs = await upsertInvestment({
      ...BASE_INVESTMENT,
      company_name: qsbsCompany,
      invest_date: '2021-01-15',
      market: 'Robotics',
    });
    await query(`UPDATE investments SET qsbs_eligible = TRUE WHERE id = $1`, [qsbs.id]);

    const quiet = await upsertInvestment({
      ...BASE_INVESTMENT,
      company_name: quietCompany,
      invest_date: '2024-01-01',
      market: 'Robotics',
    });
    await query(`
      INSERT INTO company_updates (company_name, investment_id, update_date, quarter, file_path)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (company_name, quarter) DO UPDATE
        SET investment_id = EXCLUDED.investment_id,
            update_date = EXCLUDED.update_date,
            file_path = EXCLUDED.file_path
    `, [quietCompany, quiet.id, '2024-01-01', `Q1 ${stamp}`, `/tmp/${stamp}.md`]);

    const related = await upsertInvestment({
      ...BASE_INVESTMENT,
      company_name: relatedCompany,
      invest_date: '2024-02-01',
      market: 'Robotics',
      invested: 9000,
      net_value: 12000,
      multiple: 1.333333,
    });

    const thesisRows = await query(`SELECT id FROM theses WHERE active = TRUE ORDER BY id LIMIT 1`);
    if (thesisRows.length > 0) {
      await query(`
        INSERT INTO investment_theses (investment_id, thesis_id, weight)
        VALUES ($1, $2, 100), ($3, $2, 100)
        ON CONFLICT DO NOTHING
      `, [quiet.id, thesisRows[0].id, related.id]);
    }

    const room = await createRoom({
      name: `ZZATTN Room ${stamp}`,
      cols: [{ key: 'company' }, { key: 'kind' }],
    });
    await addPipelineItem(room.id, {
      cells: { company: `Capital Call ${stamp}`, kind: 'capital_call', amount: '$25k' },
    });

    await test('attentionReport composes real QSBS, quiet-founder, and room-capital-call queues', async () => {
      const report = await attentionReport({
        today: '2026-01-01',
        qsbsWindowDays: 90,
        quietDays: 120,
        reconcileThreshold: 39,
        limit: 20,
      });

      ok(report.queues.qsbs.some(item => item.company_name === qsbsCompany), 'QSBS item should be present');
      const qsbsItem = report.queues.qsbs.find(item => item.company_name === qsbsCompany);
      eq(qsbsItem.qsbs_5yr_date, '2026-01-15');
      eq(qsbsItem.qsbs_5yr_met, false);

      ok(report.queues.quiet_founders.some(item => item.company_name === quietCompany), 'quiet founder should be present');
      const quietItem = report.queues.quiet_founders.find(item => item.company_name === quietCompany);
      eq(quietItem.latest_update_date, '2024-01-01');
      ok(quietItem.days_since_update > 120, 'quiet founder should be over threshold');

      ok(
        report.queues.room_capital_calls.some(item => item.cells.company === `Capital Call ${stamp}`),
        'room capital call should be present'
      );
    });

    await test('clusterExposure and relatedDeals use market/thesis filters', async () => {
      const exposure = await clusterExposure({ market: 'Robotics', limit: 50 });
      ok(exposure.companies.some(row => row.company_name === quietCompany), 'exposure includes quiet company');
      ok(exposure.companies.some(row => row.company_name === relatedCompany), 'exposure includes related company');
      ok(exposure.invested >= 14000, 'exposure sums invested capital');

      const relatedRows = await relatedDeals({
        companyName: quietCompany,
        market: 'Robotics',
        limit: 50,
      });
      ok(relatedRows.some(row => row.company_name === relatedCompany), 'related deal found');
      ok(!relatedRows.some(row => row.company_name === quietCompany), 'source company excluded');
    });
  } finally {
    await cleanup(stamp);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
