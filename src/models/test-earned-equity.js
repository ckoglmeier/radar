import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createEmploymentEquityIssuer, createEmploymentEquityPosition,
  getEmploymentEquityPosition, updateEmploymentEquityPosition,
  recordExerciseOrPurchase } from './employment-equity.js';
import { annualDeploymentPlanReport } from '../reports/deployment-plan.js';
import { portfolioSummary } from '../reports/portfolio.js';
import { planCommandProposal, authorizeCommandProposal } from '../commands/service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-earned-equity-'));
try {
  await withTenant(`file:${join(scratch, 'db')}`, async () => {
    await runMigrations();
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Earned Co', relationshipStatus: 'other' });
    const base = { portfolioEntityId: issuer.entity.id, instrumentFamily: 'nso', investDate: '2026-10-14',
      description: 'Source-backed grant', firstGrant: { legalInstrumentName: 'Synthetic option', instrumentType: 'nso',
        grantDate: '2026-10-14', unitsGranted: 100, unitsVestedConfirmed: 100, balanceAsOfDate: '2026-10-14', strikePrice: 1 } };
    const legacy = await createEmploymentEquityPosition({ ...base, displayName: 'Legacy employee' });
    const history = await query('SELECT * FROM schema_migrations WHERE version < 83 ORDER BY version');
    await query('DELETE FROM schema_migrations WHERE version = 83');
    await query('ALTER TABLE employment_equity_positions DROP CONSTRAINT employment_equity_positions_acquisition_origin_check');
    await query("ALTER TABLE employment_equity_positions ADD CONSTRAINT employment_equity_positions_acquisition_origin_check CHECK (acquisition_origin = 'employment')");
    await query('ALTER TABLE employment_equity_issuer_profiles DROP CONSTRAINT employment_equity_issuer_profiles_relationship_status_check');
    await query("ALTER TABLE employment_equity_issuer_profiles ADD CONSTRAINT employment_equity_issuer_profiles_relationship_status_check CHECK (relationship_status IN ('current_employee','former_employee','other'))");
    assert.deepEqual((await runMigrations()).migrations, ['083_earned_equity_relationships']);
    assert.deepEqual(await query('SELECT * FROM schema_migrations WHERE version < 83 ORDER BY version'), history);
    assert.equal((await getEmploymentEquityPosition(legacy.investment.id)).acquisition_origin, 'employment');
    assert.equal((await runMigrations()).applied, 0);

    const advisorIssuer = await createEmploymentEquityIssuer({ legalName: 'Synthetic Advisory Co', relationshipStatus: 'advisor' });
    assert.equal(advisorIssuer.profile.relationship_status, 'advisor');
    const budgetBefore = await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 });
    const angelBefore = await portfolioSummary();
    const advisor = await createEmploymentEquityPosition({ ...base, displayName: 'Advisory award', acquisitionOrigin: 'advisory' });
    const boardPlan = await planCommandProposal([{ name: 'employment.create_position', input: {
      portfolioEntityId: issuer.entity.id, displayName: 'Board award', acquisitionOrigin: 'board',
      instrumentFamily: 'nso', investDate: '2026-10-14' } }],
      { originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: 'Record board grant' });
    const boardReceipt = await authorizeCommandProposal(boardPlan.proposal.id, boardPlan.proposal.command_set_hash,
      { authorizationKind: 'manual_ui', actorType: 'user', actorId: 'test', actorCapabilities: ['portfolio:apply:metadata'] });
    assert.equal(boardReceipt.receipt.commands[0].result.position.acquisition_origin, 'board');
    const id = advisor.investment.id;
    await recordExerciseOrPurchase(id, { grantId: advisor.grant.id, date: '2026-10-14', units: 10, cashOutlay: 10, externalHash: 'earned-exercise' });
    assert.equal((await getEmploymentEquityPosition(id)).acquisition_origin, 'advisory');
    assert.equal((await query('SELECT asset_class FROM investments WHERE id=$1', [id]))[0].asset_class, 'employment_equity');
    assert.deepEqual(await annualDeploymentPlanReport({ budgetYear: 2026, fallbackAnnualBudget: 65000 }), budgetBefore);
    assert.deepEqual(await portfolioSummary(), angelBefore);

    const planned = await planCommandProposal([{ name: 'employment.update_position', input: { investmentId: id, acquisitionOrigin: 'other' } }],
      { originSurface: 'manual_ui', actorType: 'user', actorId: 'test', intentText: 'Correct earned relationship' });
    await authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash,
      { authorizationKind: 'manual_ui', actorType: 'user', actorId: 'test', actorCapabilities: ['portfolio:apply:metadata'] });
    const corrected = await getEmploymentEquityPosition(id);
    assert.equal(corrected.acquisition_origin, 'other');
    assert.equal(corrected.description, 'Source-backed grant');
    await updateEmploymentEquityPosition(id, { displayName: 'Renamed advisory award' });
    assert.equal((await getEmploymentEquityPosition(id)).acquisition_origin, 'other');
    await assert.rejects(createEmploymentEquityPosition({ ...base, displayName: 'Invalid', acquisitionOrigin: 'purchased' }), /invalid earned equity relationship/);
    console.log('Earned Equity upgrade, relationship commands, exercise and Angel exclusion: PASS');
  });
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
