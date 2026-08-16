import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createFund } from '../models/funds.js';
import { createEmploymentEquityIssuer, createEmploymentEquityPosition } from '../models/employment-equity.js';
import { setConviction } from '../models/investments.js';
import { applyCommandProposal, commandMetadata, planCommandProposal, previewCommand } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-command-service-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata'];

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    assert.equal(commandMetadata().commands.length, 14);

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
