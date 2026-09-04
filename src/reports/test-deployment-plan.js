import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { runMigrations } from '../db/migrate.js';
import {
  getAnnualDeploymentPlan,
  listAnnualDeploymentPlanVersions,
  saveAnnualDeploymentPlan,
} from '../models/deployment-plans.js';
import { annualDeploymentPlanReport } from './deployment-plan.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-deployment-plan-'));

try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();

    const fallback = await getAnnualDeploymentPlan(2026, { fallbackAnnualBudget: 85000 });
    assert.equal(fallback.source, 'legacy_config');
    assert.equal(fallback.annual_budget, 85000);

    const [investment] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, asset_class)
      VALUES ('Deployment Test', 'Live', '2026-02-01', 10000, 'direct')
      RETURNING id
    `);
    await query(`
      INSERT INTO cash_flows
        (flow_date, type, amount, investment_id, reconciliation_status)
      VALUES ('2026-02-01', 'investment', -10000, $1, 'matched')
    `, [investment.id]);
    await query(`
      INSERT INTO pipeline_invites
        (company_name, deal_slug, status, allocation_usd, source)
      VALUES ('Committed Test', 'committed-test', 'committed', 5000, 'test')
    `);

    await saveAnnualDeploymentPlan({
      budgetYear: 2026,
      annualBudget: 80000,
      changeNote: 'Initial plan',
    });
    const second = await saveAnnualDeploymentPlan({
      budgetYear: 2026,
      annualBudget: 90000,
      changeNote: 'Raised after review',
    });
    assert.equal(second.version, 2);
    assert.equal(second.source, 'saved_plan');
    assert.equal((await listAnnualDeploymentPlanVersions(2026)).length, 2);

    const report = await annualDeploymentPlanReport({
      budgetYear: 2026,
      fallbackAnnualBudget: 85000,
    });
    assert.equal(report.source, 'saved_plan');
    assert.equal(report.annual_budget, 90000);
    assert.equal(report.deployed_this_year, 10000);
    assert.equal(report.unfunded_commitments, 5000);
    assert.equal(report.cash_remaining, 80000);
    assert.equal(report.available_after_commitments, 75000);
    assert.equal(report.utilization_pct, 1 / 9);

    const backup = await createDatabaseBackupPayload();
    assert.equal(
      backup.tables.find(table => table.table === 'annual_deployment_plan_versions')?.rows,
      2,
    );
    await query('DELETE FROM annual_deployment_plan_versions');
    assert.equal(await listAnnualDeploymentPlanVersions(2026).then(rows => rows.length), 0);
    await restoreDatabase({ content: backup.content });
    const restoredVersions = await listAnnualDeploymentPlanVersions(2026);
    assert.equal(restoredVersions.length, 2);
    assert.equal(Number(restoredVersions[0].annual_budget), 90000);
    assert.equal(Number(restoredVersions[1].annual_budget), 80000);
  });
  console.log('deployment-plan: fallback, immutable versions, cash deployment, commitments, and backup passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
