import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDocument } from '../models/documents.js';
import { authorizeCommandProposal, planCommandProposal, undoCommandReceipt } from './service.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-employment-commands-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const actorCapabilities = ['portfolio:apply:additive', 'portfolio:apply:metadata'];

async function run(name, input, key, authorizationKind = 'explicit_imperative') {
  const planned = await planCommandProposal([{ name, input }], {
    originSurface: 'manual_ui', actorType: 'user', actorId: 'test',
    intentText: key, idempotencyKey: `employment-lifecycle:${key}`,
  });
  return authorizeCommandProposal(planned.proposal.id, planned.proposal.command_set_hash, {
    authorizationKind, actorId: 'test', actorCapabilities,
  });
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();
    const issuer = await run('employment.create_issuer', {
      legalName: 'Command Employer', relationshipStatus: 'current_employee',
      employmentStartDate: '2024-01-01', employmentEndDate: null,
    }, 'issuer');
    const entityId = issuer.receipt.commands[0].result.entity.id;

    const position = await run('employment.create_position', {
      portfolioEntityId: entityId, displayName: 'Founder common',
      instrumentFamily: 'common_stock', investDate: '2024-01-01',
      ownershipEntity: null, description: 'Founder shares', firstGrant: null,
      firstLot: {
        grantId: null, acquisitionDate: '2024-01-01', taxHoldingStartDate: '2024-01-01',
        instrumentType: 'common_stock', shareOrUnitClass: 'Common', unitsAcquired: 100,
        acquisitionPricePerUnit: 0.01, fairMarketValuePerUnit: 1,
        fairMarketValueDate: '2024-01-01', cashOutlay: 1,
        taxBasis: 1, compensationBasis: 0, basisAsOfDate: '2024-01-01', basisSource: 'manual',
      },
      openingValuations: [{
        date: '2024-01-01', vestedValue: 100, unvestedValue: 0,
        commonShareValuePerUnit: 1, taxFmvPerUnit: 1,
        methodology: 'common_fmv', confidence: 'calculated', notes: 'Opening value',
      }],
    }, 'position');
    const positionId = Number(position.receipt.commands[0].result.investment.id);
    const lotId = position.receipt.commands[0].result.lot.id;

    const archived = await run('employment.set_active', { investmentId: positionId, active: false }, 'archive');
    assert.ok((await query('SELECT archived_at FROM employment_equity_positions WHERE investment_id = $1', [positionId]))[0].archived_at);
    await undoCommandReceipt(archived.receipt.id, { actorId: 'test', actorCapabilities });

    const grant = await run('employment.add_grant', {
      investmentId: positionId,
      fields: {
        grantIdentifier: 'ISO-1', legalInstrumentName: '2025 ISO', instrumentType: 'iso',
        grantDate: '2025-01-01', unitsGranted: 10, unitsVestedConfirmed: 10,
        balanceAsOfDate: '2025-01-01', strikePrice: 1,
        expirationDate: '2035-01-01', hurdleAmount: null, vestingTermsSummary: 'Fully vested',
      },
    }, 'grant');
    const grantId = grant.receipt.commands[0].result.id;

    assert.equal((await run('employment.add_lot', {
      investmentId: positionId,
      fields: {
        grantId: null, acquisitionDate: '2025-01-15', taxHoldingStartDate: '2025-01-15',
        instrumentType: 'common_stock', shareOrUnitClass: 'Common', unitsAcquired: 5,
        acquisitionPricePerUnit: 1, fairMarketValuePerUnit: 2,
        fairMarketValueDate: '2025-01-15', cashOutlay: 5,
        taxBasis: 5, compensationBasis: 0, basisAsOfDate: '2025-01-15', basisSource: 'manual',
      },
    }, 'lot')).status, 'applied');

    assert.equal((await run('employment.record_exercise', {
      investmentId: positionId,
      fields: {
        grantId, date: '2025-02-01', units: 2, cashOutlay: 2,
        acquisitionPricePerUnit: 1, fairMarketValuePerUnit: 2,
        fairMarketValueDate: '2025-02-01', taxHoldingStartDate: '2025-02-01',
        taxBasis: 2, compensationBasis: 0, basisAsOfDate: '2025-02-01',
        notes: 'Exercise', externalHash: 'employment-command-exercise',
      },
    }, 'exercise')).status, 'applied');

    assert.equal((await run('employment.record_settlement', {
      investmentId: positionId,
      fields: {
        grantId, date: '2025-02-15', units: 2, fairMarketValuePerUnit: 2,
        fairMarketValueDate: '2025-02-15', taxHoldingStartDate: '2025-02-15',
        taxBasis: 4, compensationBasis: 4, basisAsOfDate: '2025-02-15',
        notes: 'Settlement', externalHash: 'employment-command-settlement',
      },
    }, 'settlement')).status, 'applied');

    assert.equal((await run('employment.record_distribution', {
      investmentId: positionId,
      fields: { date: '2025-03-01', amount: 10, description: 'Dividend', externalHash: 'employment-command-distribution' },
    }, 'distribution')).status, 'applied');

    assert.equal((await run('employment.record_disposition', {
      investmentId: positionId,
      fields: {
        eventType: 'sale', date: '2025-03-01', amount: 3, pricePerUnit: 3,
        description: 'Partial sale', externalHash: 'employment-command-disposition',
        allocations: [{ lotId, units: 1, grossProceedsAllocated: 3, taxBasisAllocated: 0.01 }],
      },
    }, 'disposition')).status, 'applied');

    const basis = await run('employment.adjust_basis', {
      investmentId: positionId,
      fields: {
        lotId, date: '2025-03-02', basisSource: 'tax_record', reason: 'Correct basis',
        externalHash: 'employment-command-basis', cashOutlay: 1, taxBasis: 2, compensationBasis: 0,
      },
    }, 'basis');
    assert.equal(basis.status, 'confirmation_required');
    assert.equal((await run('employment.adjust_basis', {
      investmentId: positionId,
      fields: {
        lotId, date: '2025-03-02', basisSource: 'tax_record', reason: 'Correct basis',
        externalHash: 'employment-command-basis', cashOutlay: 1, taxBasis: 2, compensationBasis: 0,
      },
    }, 'basis', 'inline_confirmation')).status, 'applied');

    const disclosureDocument = await createDocument({
      entity_type: 'portfolio_entity', entity_id: entityId,
      filename: 'command-update.pdf', mime: 'application/pdf',
      content: Buffer.from('Employment command disclosure fixture'),
      confidentiality: 'confidential_company', processing_policy: 'local_only',
      sync_policy: 'local_only', executionMode: 'desktop',
    });
    assert.equal((await run('employment.add_disclosure', {
      investmentId: positionId, portfolioEntityId: entityId, documentId: disclosureDocument.id,
      disclosureType: 'company_financials', receivedDate: '2025-04-01',
      financialsAsOfDate: '2025-03-31', notes: 'Quarterly update',
    }, 'disclosure')).status, 'applied');
  });
  console.log('Employment commands: create, lifecycle Undo, grant, lot, exercise, settlement, distribution, disposition, basis, and disclosure passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
