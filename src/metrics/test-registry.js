import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { gpSummary } from '../reports/gp.js';
import { performanceWindows, cashFlowsInRange } from '../reports/performance.js';
import { portfolioSummary } from '../reports/portfolio.js';
import { stageBreakdown, thesisPerformance } from '../reports/thesis.js';
import { metricQuery } from './registry.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-metric-registry-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

function approx(actual, expected, tolerance = 1e-8) {
  assert.ok(
    Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

async function insertInvestment(fields) {
  const [row] = await query(`
    INSERT INTO investments
      (company_name, status, invest_date, invested, unrealized_value,
       realized_value, net_value, multiple, lead, market, stage_bucket, asset_class)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
  `, [
    fields.company_name,
    fields.status ?? 'Live',
    fields.invest_date,
    fields.invested,
    fields.unrealized_value ?? null,
    fields.realized_value ?? null,
    fields.net_value ?? null,
    fields.multiple ?? null,
    fields.lead ?? null,
    fields.market ?? null,
    fields.stage_bucket ?? null,
    fields.asset_class ?? 'direct',
  ]);
  return Number(row.id);
}

async function insertFlow(investmentId, date, type, amount) {
  await query(
    `INSERT INTO cash_flows (investment_id, flow_date, type, amount) VALUES ($1,$2,$3,$4)`,
    [investmentId, date, type, amount],
  );
}

async function insertValuation(investmentId, date, netValue, unrealizedValue = netValue) {
  await query(`
    INSERT INTO valuations (investment_id, snapshot_date, net_value, unrealized_value, realized_value)
    VALUES ($1,$2,$3,$4,0)
  `, [investmentId, date, netValue, unrealizedValue]);
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const [thesis] = await query(`SELECT id FROM theses WHERE active = TRUE ORDER BY id LIMIT 1`);

    const northstar = await insertInvestment({
      company_name: 'Northstar Materials', invest_date: '2023-01-01', invested: 100,
      unrealized_value: 60, realized_value: 20, net_value: 80, multiple: 0.8,
      lead: 'Polar Ventures', market: 'Aerospace', stage_bucket: 'seed',
    });
    await insertFlow(northstar, '2023-01-01', 'investment', -100);
    await insertFlow(northstar, '2025-05-01', 'distribution', 20);
    await insertValuation(northstar, '2024-01-01', 60);
    await insertValuation(northstar, '2026-01-01', 80, 60);
    await query(
      `INSERT INTO investment_theses (investment_id, thesis_id, weight) VALUES ($1,$2,100)`,
      [northstar, thesis.id],
    );

    const orbital = await insertInvestment({
      company_name: 'Orbital Forge', invest_date: '2024-02-01', invested: 200,
      lead: 'Polar Ventures', market: 'Aerospace', stage_bucket: 'series-a',
    });
    await insertFlow(orbital, '2024-02-01', 'investment', -200);

    const tidal = await insertInvestment({
      company_name: 'Tidal Works', invest_date: '2023-06-01', invested: 50,
      unrealized_value: 50, net_value: 50, multiple: 1,
      lead: 'Harbor Capital', market: 'Climate', stage_bucket: 'pre-seed',
    });
    await insertFlow(tidal, '2023-06-01', 'investment', -50);
    await insertValuation(tidal, '2026-02-01', 50);

    const fund = await insertInvestment({
      company_name: 'Excluded Access Fund', invest_date: '2023-01-01', invested: 1000,
      asset_class: 'fund', lead: 'Fund Manager', market: 'Diversified', stage_bucket: 'fund',
    });
    await insertFlow(fund, '2023-01-01', 'investment', -1000);

    // Adapter differential: the registry must preserve the existing report
    // values for the report shapes it wraps.
    const scalarTvpi = await metricQuery({ metric: 'tvpi' });
    const { summary } = await portfolioSummary();
    approx(scalarTvpi.rows[0].value, summary.tvpi);

    const vintageTvpi = await metricQuery({ metric: 'tvpi', groupBy: ['vintage'] });
    const { byVintageYear } = await performanceWindows();
    for (const existing of byVintageYear) {
      const row = vintageTvpi.rows.find(candidate => Number(candidate.group.vintage) === existing.vintage_year);
      assert.ok(row, `registry vintage ${existing.vintage_year} exists`);
      approx(row.value, existing.tvpi);
      assert.equal(row.details.invested, Number(existing.invested));
      assert.equal(row.details.current_value, Number(existing.current_value));
      approx(row.details.current_value / row.details.invested, row.value, 0.001);
    }

    const thesisTvpi = await metricQuery({ metric: 'tvpi', groupBy: ['thesis'] });
    const existingTheses = await thesisPerformance();
    for (const existing of existingTheses.filter(row => row.tvpi != null)) {
      const row = thesisTvpi.rows.find(candidate => candidate.group.thesis === existing.thesis);
      assert.ok(row, `registry thesis ${existing.thesis} exists`);
      approx(row.value, existing.tvpi);
    }

    const gpTvpi = await metricQuery({ metric: 'tvpi', groupBy: ['gp'] });
    const { rows: existingGps } = await gpSummary();
    for (const existing of existingGps) {
      const row = gpTvpi.rows.find(candidate => candidate.group.gp === existing.gp_name);
      assert.ok(row, `registry GP ${existing.gp_name} exists`);
      approx(row.value, existing.tvpi);
    }

    const stageDpi = await metricQuery({ metric: 'dpi', groupBy: ['stage'] });
    const { byStage } = await stageBreakdown();
    for (const existing of byStage) {
      const row = stageDpi.rows.find(candidate => candidate.group.stage === existing.stage_bucket);
      assert.ok(row, `registry stage ${existing.stage_bucket} exists`);
      if (existing.dpi == null) assert.equal(row.value, null);
      else approx(row.value, existing.dpi);
    }

    // Composable dimensions are evaluated deterministically without SQL from
    // the caller.
    const grouped = await metricQuery({
      metric: 'dpi',
      groupBy: ['gp', 'vintage'],
      filters: { market: 'Aerospace' },
    });
    assert.deepEqual(
      grouped.rows.map(row => row.group),
      [
        { gp: 'Polar Ventures', vintage: '2023' },
        { gp: 'Polar Ventures', vintage: '2024' },
      ],
    );

    // Zero-tolerance historical coverage guard names the missing position.
    const unavailable = await metricQuery({
      metric: 'period_return',
      window: { since: '2025-01-01', until: '2026-07-22' },
    });
    assert.equal(unavailable.rows[0].value, null);
    assert.equal(unavailable.rows[0].coverage.state, 'unavailable');
    assert.deepEqual(
      unavailable.rows[0].coverage.missing_opening_positions,
      [{ id: tidal, company_name: 'Tidal Works' }],
    );

    const available = await metricQuery({
      metric: 'period_return',
      window: { since: '2025-01-01', until: '2026-07-22' },
      excludeIds: [tidal],
    });
    assert.equal(available.rows[0].coverage.state, 'available');
    assert.notEqual(available.rows[0].value, null);

    const deployed = await metricQuery({
      metric: 'deployed',
      window: { since: '2023-01-01', until: '2026-07-22' },
    });
    const existingFlows = await cashFlowsInRange('2023-01-01', '2026-07-22');
    assert.equal(deployed.rows[0].value, existingFlows.cash_out);
    assert.equal(deployed.rows[0].value, 350, 'fund cash flow is excluded');

    assert.deepEqual(scalarTvpi.rows[0].coverage, {
      state: 'descriptive',
      positions: 3,
      marked: 2,
      value_share_marked: 130 / 330,
      unmarked_positions: [{ id: orbital, company_name: 'Orbital Forge' }],
    });
  });

  console.log('metric registry: adapter and coverage tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
