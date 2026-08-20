import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createFund } from '../models/funds.js';
import { createEmploymentEquityIssuer, createEmploymentEquityPosition } from '../models/employment-equity.js';
import { setConviction } from '../models/investments.js';
import { applyCommandProposal, commandMetadata, planCommandProposal, previewCommand, reviseCommandProposal } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-command-service-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata'];

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    assert.equal(commandMetadata().commands.length, 17);

    const [direct] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, source, asset_class)
      VALUES ('Command Direct', 'Live', '2024-01-01', 1000, 'manual', 'direct')
      RETURNING *
    `);
    const fund = await createFund({
      legalName: 'Command Fund I', commitmentDate: '2024-01-01',
      commitment: 10_000, fundStatus: 'active', currency: 'USD',
    });
    const issuer = await createEmploymentEquityIssuer({ legalName: 'Command Employer, Inc.' });
    const employment = await createEmploymentEquityPosition({
      portfolioEntityId: issuer.entity.id,
      displayName: 'Command option grant', instrumentFamily: 'iso', investDate: '2024-01-01',
      firstGrant: {
        legalInstrumentName: 'Command ISO', instrumentType: 'iso',
        grantDate: '2024-01-01', unitsGranted: 100, unitsVestedConfirmed: 100, strikePrice: 1,
      },
    });

    const employmentEdit = await planCommandProposal([{
      name: 'employment.update_position',
      input: {
        investmentId: employment.investment.id,
        displayName: 'Edited option grant',
        investDate: '2024-02-01',
        ownershipEntity: 'Individual',
        cashOutlay: 125,
        description: 'Corrected after initial entry',
      },
      provenance: { kind: 'user_attested', evidence: 'Submitted through the Employment Equity edit form.' },
    }], {
      originSurface: 'manual_ui', actorType: 'user', actorId: 'fixture',
      intentText: 'Edit Employment Equity reporting details',
      idempotencyKey: 'command:test:employment-edit',
    });
    assert.equal(employmentEdit.proposal.previews[0].after.find(row => row.field === 'cash_outlay').value, 125);
    await applyCommandProposal(
      employmentEdit.proposal.id,
      employmentEdit.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    );
    const [editedEmployment] = await query(`SELECT invest_date, investment_entity, invested FROM investments WHERE id = $1`, [employment.investment.id]);
    assert.equal(dateOnly(editedEmployment.invest_date), '2024-02-01');
    assert.equal(editedEmployment.investment_entity, 'Individual');
    assert.equal(Number(editedEmployment.invested), 125);
    assert.equal(Number((await query(`SELECT cash_outlay FROM investment_lots WHERE investment_id = $1`, [employment.investment.id]))[0].cash_outlay), 125);

    const vintageProposal = await planCommandProposal([{
      name: 'fund.set_vintage_year',
      input: { investmentId: fund.investment.id, vintageYear: 2022 },
      provenance: { kind: 'user_attested', evidence: 'User supplied the vintage year.' },
    }], {
      originSurface: 'ask_radar', actorType: 'user', actorId: 'fixture',
      intentText: 'Add a 2022 vintage year to Command Fund I',
      idempotencyKey: 'command:test:fund-vintage',
    });
    assert.deepEqual(vintageProposal.proposal.previews[0].before, [
      { field: 'vintage_year', value: null },
    ]);
    assert.deepEqual(vintageProposal.proposal.previews[0].after, [
      { field: 'vintage_year', value: 2022 },
    ]);
    await assert.rejects(
      () => reviseCommandProposal(
        vintageProposal.proposal.id,
        vintageProposal.proposal.command_set_hash,
        [{ commandId: JSON.parse(JSON.stringify(vintageProposal.proposal.commands))[0].id, input: { investmentId: fund.investment.id } }],
        { reviewedBy: 'fixture' },
      ),
      error => error.code === 'PROPOSAL_EDIT_NOT_ALLOWED',
    );
    const vintageCommand = (typeof vintageProposal.proposal.commands === 'string'
      ? JSON.parse(vintageProposal.proposal.commands)
      : vintageProposal.proposal.commands)[0];
    const vintageRevision = await reviseCommandProposal(
      vintageProposal.proposal.id,
      vintageProposal.proposal.command_set_hash,
      [{ commandId: vintageCommand.id, input: { vintageYear: 2023 } }],
      { reviewedBy: 'fixture' },
    );
    assert.equal(vintageRevision.proposal.status, 'superseded');
    assert.equal(vintageRevision.replacement.status, 'proposed');
    assert.deepEqual(vintageRevision.replacement.previews[0].after, [
      { field: 'vintage_year', value: 2023 },
    ]);
    await applyCommandProposal(
      vintageRevision.replacement.id,
      vintageRevision.replacement.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    );
    assert.equal(Number((await query(
      `SELECT vintage_year FROM fund_profiles WHERE investment_id = $1`,
      [fund.investment.id],
    ))[0].vintage_year), 2023);

    const combinedCallProposal = await planCommandProposal([{
      name: 'fund.create_and_settle_capital_call',
      input: {
        investmentId: fund.investment.id,
        noticeDate: '2025-01-15',
        settlementDate: '2025-01-15',
        amount: 2_500,
        currency: 'USD',
        description: 'Requested and settled together',
      },
      provenance: { kind: 'user_attested', evidence: 'Submitted through the Fund activity form.' },
    }], {
      originSurface: 'manual_ui', actorType: 'user', actorId: 'fixture',
      intentText: 'Record a requested and settled capital call',
      idempotencyKey: 'command:test:combined-capital-call',
    });
    assert.deepEqual(combinedCallProposal.proposal.previews[0].after, [
      { field: 'capital_call', value: 2_500, as_of: '2025-01-15' },
      { field: 'settled_contribution', value: 2_500, as_of: '2025-01-15' },
    ]);
    await applyCommandProposal(
      combinedCallProposal.proposal.id,
      combinedCallProposal.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    );
    const [combinedNotice] = await query(`
      SELECT fn.status, ft.activity_type, cf.flow_date::text AS flow_date, cf.amount
        FROM fund_notices fn
        JOIN fund_transactions ft ON ft.notice_id = fn.id
        JOIN cash_flows cf ON cf.id = ft.cash_flow_id
       WHERE fn.investment_id = $1 AND fn.amount = 2500
    `, [fund.investment.id]);
    assert.equal(combinedNotice.status, 'settled');
    assert.equal(combinedNotice.activity_type, 'contribution');
    assert.equal(String(combinedNotice.flow_date).slice(0, 10), '2025-01-15');
    assert.equal(Number(combinedNotice.amount), -2_500);

    const overrideProposal = await planCommandProposal([{
      name: 'reporting.override_field',
      input: {
        resourceType: 'fund_profile', resourceId: fund.investment.id,
        field: 'manager', value: 'Incisive Capital',
        reason: 'No dedicated Fund manager command exists.',
      },
      provenance: { kind: 'user_attested', evidence: 'User supplied the manager.' },
    }], {
      originSurface: 'ask_radar', actorType: 'user', actorId: 'fixture',
      intentText: 'Set the manager', idempotencyKey: 'command:test:override',
    });
    const overrideCommand = (typeof overrideProposal.proposal.commands === 'string'
      ? JSON.parse(overrideProposal.proposal.commands)
      : overrideProposal.proposal.commands)[0];
    await assert.rejects(
      () => applyCommandProposal(
        overrideProposal.proposal.id,
        overrideProposal.proposal.command_set_hash,
        { reviewedBy: 'fixture', actorCapabilities },
      ),
      error => error.code === 'COMMAND_OVERRIDE_PERMISSION_REQUIRED',
    );
    assert.equal((await query(
      `SELECT status FROM command_proposals WHERE id = $1`,
      [overrideProposal.proposal.id],
    ))[0].status, 'proposed', 'missing override permission leaves the proposal reviewable');
    const overrideAuthorization = [{
      commandId: overrideCommand.id,
      commandHash: overrideCommand.command_hash,
      permission: 'single_use',
      grantedBy: 'fixture',
      reason: 'I reviewed and approve this one override.',
    }];
    await assert.rejects(
      () => applyCommandProposal(
        overrideProposal.proposal.id,
        overrideProposal.proposal.command_set_hash,
        { reviewedBy: 'fixture', actorCapabilities, overrideAuthorizations: overrideAuthorization },
      ),
      error => error.code === 'COMMAND_CAPABILITY_DENIED'
        && error.details.required_capabilities.includes('portfolio:apply:override'),
    );
    assert.equal((await query(
      `SELECT status FROM command_proposals WHERE id = $1`,
      [overrideProposal.proposal.id],
    ))[0].status, 'proposed', 'missing capability also leaves the proposal reviewable');
    const overrideApplied = await applyCommandProposal(
      overrideProposal.proposal.id,
      overrideProposal.proposal.command_set_hash,
      {
        reviewedBy: 'fixture',
        actorCapabilities: [...actorCapabilities, 'portfolio:apply:override'],
        overrideAuthorizations: overrideAuthorization,
      },
    );
    assert.equal(overrideApplied.receipt.override_authorizations.length, 1);
    assert.equal(overrideApplied.receipt.override_authorizations[0].permission, 'single_use');
    assert.equal((await query(
      `SELECT manager FROM fund_profiles WHERE investment_id = $1`,
      [fund.investment.id],
    ))[0].manager, 'Incisive Capital');

    await assert.rejects(
      () => previewCommand({
        name: 'reporting.override_field',
        input: {
          resourceType: 'employment_position', resourceId: employment.investment.id,
          field: 'manager', value: 'Not allowed', reason: 'Fixture',
        },
      }),
      error => error.code === 'COMMAND_OVERRIDE_NOT_ALLOWLISTED',
    );

    await assert.rejects(
      () => previewCommand({
        name: 'fund.record_nav', input: { investmentId: direct.id, date: '2025-01-01', nav: 1, currency: 'USD' },
      }),
      error => error.code === 'WRONG_TARGET_TYPE',
    );

    const proposed = await planCommandProposal([
      {
        name: 'direct.record_valuation',
        input: { investmentId: direct.id, date: '2025-06-30', unrealizedValue: 1_500, currency: 'USD' },
        provenance: { kind: 'user_attested', evidence: 'Command test' },
      },
      {
        name: 'fund.record_nav',
        input: { investmentId: fund.investment.id, date: '2025-06-30', nav: 8_000, currency: 'USD' },
        provenance: { kind: 'user_attested', evidence: 'Command test' },
      },
    ], {
      originSurface: 'ask_radar', actorType: 'user', actorId: 'fixture',
      intentText: 'Update direct and fund values', idempotencyKey: 'command:test:success',
    });
    const applied = await applyCommandProposal(
      proposed.proposal.id,
      proposed.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    );
    assert.equal(applied.receipt.commands.length, 2);
    assert.equal((await applyCommandProposal(
      proposed.proposal.id,
      proposed.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    )).idempotent_replay, true);
    assert.equal(Number((await query(`SELECT net_value FROM investments WHERE id = $1`, [direct.id]))[0].net_value), 1_500);
    assert.equal(Number((await query(`SELECT net_value FROM valuations WHERE investment_id = $1`, [fund.investment.id]))[0].net_value), 8_000);

    const staleCandidate = await planCommandProposal([{
      name: 'direct.set_conviction', input: { investmentId: direct.id, now: 4, entry: 3 },
    }], {
      originSurface: 'mcp', actorType: 'mcp_client', idempotencyKey: 'command:test:stale',
    });
    await setConviction(direct.id, { now: 2, entry: 2 });
    const stale = await applyCommandProposal(
      staleCandidate.proposal.id,
      staleCandidate.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    );
    assert.equal(stale.stale, true);
    assert.equal(stale.proposal.status, 'stale');
    assert.equal(Number((await query(`SELECT conviction_now FROM investments WHERE id = $1`, [direct.id]))[0].conviction_now), 2);

    const rollbackCandidate = await planCommandProposal([
      { name: 'direct.set_conviction', input: { investmentId: direct.id, now: 5, entry: 5 } },
      { name: 'employment.update_position', input: { investmentId: employment.investment.id, displayName: ' ' } },
    ], {
      originSurface: 'api', actorType: 'api_client', idempotencyKey: 'command:test:rollback',
    });
    await assert.rejects(
      () => applyCommandProposal(
        rollbackCandidate.proposal.id,
        rollbackCandidate.proposal.command_set_hash,
        { reviewedBy: 'fixture', actorCapabilities },
      ),
      /display name is required/i,
    );
    assert.equal(Number((await query(`SELECT conviction_now FROM investments WHERE id = $1`, [direct.id]))[0].conviction_now), 2, 'command one rolled back');
    assert.equal((await query(`SELECT status FROM command_proposals WHERE id = $1`, [rollbackCandidate.proposal.id]))[0].status, 'failed');

    const cashFlows = await query(`
      INSERT INTO cash_flows
        (flow_date, type, amount, company_raw, source, external_hash, reconciliation_status)
      VALUES
        ('2025-01-01', 'adjustment', 10, 'Command Direct', 'test', 'tier-b-1', 'pending'),
        ('2025-01-02', 'adjustment', 20, 'Command Direct', 'test', 'tier-b-2', 'pending')
      RETURNING id
    `);
    const tierB = await planCommandProposal([
      { name: 'transaction.match_to_position', input: { cashFlowIds: [cashFlows[0].id], investmentId: direct.id } },
      { name: 'transaction.classify', input: { cashFlowIds: [cashFlows[1].id], action: 'ignored', note: 'Reviewed fixture' } },
      { name: 'company.save_alias', input: { canonicalInvestmentId: direct.id, alias: 'CD Ventures' } },
    ], {
      originSurface: 'manual_ui', actorType: 'user', idempotencyKey: 'command:test:tier-b',
    });
    const tierBApplied = await applyCommandProposal(
      tierB.proposal.id,
      tierB.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities: [...actorCapabilities, 'portfolio:apply:reconciliation'] },
    );
    assert.equal(tierBApplied.receipt.commands.length, 3);
    const classified = await query(`SELECT id, investment_id, reconciliation_status FROM cash_flows WHERE id = ANY($1::int[]) ORDER BY id`, [cashFlows.map(row => row.id)]);
    assert.equal(Number(classified[0].investment_id), Number(direct.id));
    assert.equal(classified[0].reconciliation_status, 'matched');
    assert.equal(classified[1].reconciliation_status, 'ignored');
    assert.equal((await query(`SELECT canonical_company_name FROM company_aliases WHERE alias = 'CD Ventures'`))[0].canonical_company_name, 'Command Direct');

    const [parallelDirect] = await query(`
      INSERT INTO investments (company_name, status, invested, source, asset_class)
      VALUES ('Parallel Command Direct', 'Live', 200, 'manual', 'direct') RETURNING id
    `);
    const parallelPlans = await Promise.all([
      planCommandProposal([{ name: 'direct.record_valuation', input: { investmentId: direct.id, date: '2025-07-31', unrealizedValue: 1_700, currency: 'USD' } }], {
        originSurface: 'manual_ui', actorType: 'user', idempotencyKey: 'command:test:parallel-a',
      }),
      planCommandProposal([{ name: 'direct.record_valuation', input: { investmentId: parallelDirect.id, date: '2025-07-31', unrealizedValue: 300, currency: 'USD' } }], {
        originSurface: 'mcp', actorType: 'mcp_client', idempotencyKey: 'command:test:parallel-b',
      }),
    ]);
    const parallelReceipts = await Promise.all(parallelPlans.map(plan => applyCommandProposal(
      plan.proposal.id,
      plan.proposal.command_set_hash,
      { reviewedBy: 'fixture', actorCapabilities },
    )));
    assert.equal(parallelReceipts.every(result => result.proposal.status === 'applied'), true);
    assert.equal(Number((await query(`SELECT net_value FROM investments WHERE id = $1`, [parallelDirect.id]))[0].net_value), 300);
  });
  console.log('Command service tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
