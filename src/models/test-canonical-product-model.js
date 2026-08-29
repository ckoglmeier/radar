import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDatabaseBackupPayload, restoreDatabase } from '../db/backup.js';
import { commandMetadata } from '../commands/service.js';
import {
  canonicalIdentityCandidates,
  canonicalIdentityReviewQueue,
  createEntityRedirect,
  createReviewedEntity,
  linkPositionIdentity,
  resolveCanonicalEntityId,
} from './canonical-identity.js';
import {
  appendVehicleExposureClaim,
  companyIndirectExposureRecord,
  createVehiclePortfolioSnapshot,
  localPolicyContext,
  resolveVehicleExposureClaim,
  reviewVehiclePortfolioSnapshot,
  vehiclePortfolioRecord,
} from './vehicle-disclosures.js';
import {
  acceptCompanyFact,
  canonicalCompanyRecord,
  companyFactHistory,
  proposeCompanyFact,
} from './company-facts.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-canonical-model-'));
const databaseUrl = `file:${join(scratch, 'db')}`;
const restoreUrl = `file:${join(scratch, 'restore')}`;

async function reviewedEntity(sourceId, fields) {
  return createReviewedEntity({
    sourceNamespace: 'canonical-model-test',
    sourceId,
    idempotencyKey: `entity:${sourceId}`,
    sourceHash: `hash:${sourceId}`,
    reviewedBy: 'test_reviewer',
    ...fields,
  });
}

try {
  let backupContent;
  let expectedCompanyEntityId;
  let expectedVehicleEntityId;
  await withTenant(databaseUrl, async () => {
    const migrated = await runMigrations();
    assert.ok(migrated.migrations.includes('063_canonical_identity'));
    assert.ok(migrated.migrations.includes('066_company_facts'));

    const holder = await reviewedEntity('holder', {
      legalName: 'CK Test Holdings LLC',
      entityType: 'other',
      entityClass: 'organization',
      investingEntityKind: 'llc',
    });
    const company = await reviewedEntity('acme', {
      legalName: 'Acme Robotics, Inc.',
      entityType: 'operating_company',
      entityClass: 'organization',
      company: true,
    });
    const formerCompany = await reviewedEntity('acme-former', {
      legalName: 'Acme Machines, Inc.',
      entityType: 'operating_company',
      entityClass: 'organization',
      company: true,
    });
    const vehicle = await reviewedEntity('spv', {
      legalName: 'Acme Access SPV I, LLC',
      entityType: 'other',
      entityClass: 'vehicle',
      investingEntityKind: 'spv',
    });
    expectedCompanyEntityId = company.entity.id;
    expectedVehicleEntityId = vehicle.entity.id;

    const [directPosition] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, invested, net_value, asset_class, source)
      VALUES ('Acme Robotics', 'Live', '2024-01-15', 10000, 12000, 'direct', 'test')
      RETURNING *
    `);
    const linked = await linkPositionIdentity(directPosition.id, {
      holderEntityId: holder.entity.id,
      issuerEntityId: company.entity.id,
      routeClassification: 'direct_issuer',
      sourceHash: 'position:direct:1',
      idempotencyKey: 'position:direct:1',
      reviewedBy: 'test_reviewer',
    });
    assert.equal(linked.position.identity_review_status, 'accepted');
    assert.equal(linked.position.issuer_entity_id, company.entity.id);
    const linkedReplay = await linkPositionIdentity(directPosition.id, {
      holderEntityId: holder.entity.id,
      issuerEntityId: company.entity.id,
      routeClassification: 'direct_issuer',
      sourceHash: 'position:direct:1',
      idempotencyKey: 'position:direct:1',
      reviewedBy: 'test_reviewer',
    });
    assert.equal(linkedReplay.idempotent_replay, true);

    const redirect = await createEntityRedirect({
      supersededEntityId: formerCompany.entity.id,
      canonicalEntityId: company.entity.id,
      reason: 'Reviewed former legal name',
      sourceHash: 'redirect:acme:1',
      idempotencyKey: 'redirect:acme:1',
      reviewedBy: 'test_reviewer',
    });
    assert.equal(await resolveCanonicalEntityId(formerCompany.entity.id), company.entity.id);
    assert.equal(redirect.redirect.canonical_entity_id, company.entity.id);
    await assert.rejects(
      () => createEntityRedirect({
        supersededEntityId: company.entity.id,
        canonicalEntityId: formerCompany.entity.id,
        reason: 'Invalid reverse redirect',
        sourceHash: 'redirect:cycle',
        idempotencyKey: 'redirect:cycle',
        reviewedBy: 'test_reviewer',
      }),
      /cycle/,
    );

    const noDisclosure = await createVehiclePortfolioSnapshot({
      vehicleEntityId: vehicle.entity.id,
      sourceReceiptNamespace: 'quarterly-letter',
      sourceReceiptId: '2025-q1',
      boundaryKind: 'document',
      boundaryLocator: 'entire-document',
      sourceHash: 'spv-q1',
      receivedDate: '2025-04-15',
      disclosurePresence: 'not_provided',
      extractionStatus: 'not_attempted',
      reviewState: 'accepted',
      reviewedBy: 'test_reviewer',
      processingPolicy: 'local_only',
      syncPolicy: 'encrypted_backup_allowed',
    });
    assert.equal(noDisclosure.snapshot.disclosure_presence, 'not_provided');
    assert.equal(noDisclosure.snapshot.extraction_status, 'not_attempted');

    const disclosed = await createVehiclePortfolioSnapshot({
      vehicleEntityId: vehicle.entity.id,
      sourceReceiptNamespace: 'quarterly-letter',
      sourceReceiptId: '2025-q2',
      boundaryKind: 'table',
      boundaryLocator: 'portfolio-companies',
      sourceHash: 'spv-q2',
      asOfDate: '2025-06-30',
      receivedDate: '2025-07-15',
      disclosurePresence: 'provided',
      holdingsCompleteness: 'partial',
      extractionStatus: 'succeeded',
      reportedHoldingCount: 2,
      reportedTotalPortfolioValue: 5000000,
      reportedValueCurrency: 'USD',
      reportedValueUnitScale: 'units',
      reportedValueBasis: 'manager_reported_nav',
      reportedValueEffectiveDate: '2025-06-30',
      processingPolicy: 'local_only',
      syncPolicy: 'encrypted_backup_allowed',
    });
    const claim = await appendVehicleExposureClaim(disclosed.snapshot.id, {
      sourceClaimId: 'row-1',
      rawTargetName: 'ACME Robotics',
      holdingStatus: 'active',
      reportedCost: 1000000,
      costCurrency: 'USD',
      costUnitScale: 'units',
      costBasis: 'manager_reported_cost',
      costEffectiveDate: '2025-06-30',
      reportedValue: 1600000,
      valueCurrency: 'USD',
      valueUnitScale: 'units',
      valueBasis: 'manager_reported_nav',
      valueEffectiveDate: '2025-06-30',
      confidence: 'reported',
    });
    await appendVehicleExposureClaim(disclosed.snapshot.id, {
      sourceClaimId: 'row-2',
      rawTargetName: 'ACME Robotics',
      holdingStatus: 'active',
    });
    await resolveVehicleExposureClaim(claim.claim.id, {
      resolutionStatus: 'confirmed',
      targetEntityId: company.entity.id,
      sourceHash: 'spv-q2:row-1:resolution',
      idempotencyKey: 'spv-q2:row-1:resolution',
      reviewedBy: 'test_reviewer',
    });
    await reviewVehiclePortfolioSnapshot(disclosed.snapshot.id, {
      disclosurePresence: 'provided',
      holdingsCompleteness: 'partial',
      extractionStatus: 'succeeded',
      reviewState: 'accepted',
      reviewedBy: 'test_reviewer',
    });

    const localContext = localPolicyContext();
    const vehicleRecord = await vehiclePortfolioRecord(vehicle.entity.id, localContext);
    assert.equal(vehicleRecord.snapshots.length, 2);
    const acceptedDisclosure = vehicleRecord.snapshots.find(row => row.id === disclosed.snapshot.id);
    assert.equal(acceptedDisclosure.claims.length, 2, 'same raw name is preserved as two source claims');
    assert.equal(acceptedDisclosure.claims.filter(row => row.resolution_status === 'confirmed').length, 1);
    const modelContext = localPolicyContext({ purpose: 'model', allowModel: true });
    assert.equal((await vehiclePortfolioRecord(vehicle.entity.id, modelContext)).snapshots.length, 0);
    const indirect = await companyIndirectExposureRecord(company.entity.id, localContext);
    assert.equal(indirect.length, 1);
    assert.equal(indirect[0].vehicle_entity_id, vehicle.entity.id);

    const fact = await proposeCompanyFact({
      companyEntityId: company.entity.id,
      factKey: 'sector',
      value: 'Industrial automation',
      effectiveDate: '2025-06-30',
      sourceNamespace: 'quarterly-letter',
      sourceClaimId: 'acme-sector-v1',
      sourceHash: 'acme-sector-v1',
      processingPolicy: 'local_only',
      syncPolicy: 'encrypted_backup_allowed',
    });
    await acceptCompanyFact(fact.fact.id, { reviewedBy: 'test_reviewer' });
    assert.equal((await companyFactHistory(company.entity.id, 'sector', localContext)).length, 1);
    assert.equal((await companyFactHistory(company.entity.id, 'sector', modelContext)).length, 0);
    await assert.rejects(
      () => query(`UPDATE company_facts SET value = '"Other"'::jsonb WHERE id = $1`, [fact.fact.id]),
      /immutable/,
    );
    const replacement = await proposeCompanyFact({
      companyEntityId: company.entity.id,
      factKey: 'sector',
      value: 'Robotics',
      effectiveDate: '2025-07-01',
      sourceNamespace: 'company-update',
      sourceClaimId: 'acme-sector-v2',
      sourceHash: 'acme-sector-v2',
      supersedesFactId: fact.fact.id,
      processingPolicy: 'local_only',
      syncPolicy: 'encrypted_backup_allowed',
    });
    await acceptCompanyFact(replacement.fact.id, { reviewedBy: 'test_reviewer' });
    const companyRecord = await canonicalCompanyRecord(company.entity.id, localContext);
    assert.equal(companyRecord.current_facts.length, 1);
    assert.equal(companyRecord.current_facts[0].value, 'Robotics');
    assert.equal(companyRecord.issued_positions.length, 1);
    assert.equal(companyRecord.indirect_exposures.length, 1);

    const [positionTotals] = await query(`
      SELECT COUNT(*)::int AS positions, SUM(net_value)::numeric AS net_value
        FROM investments WHERE asset_class <> 'merged'
    `);
    assert.equal(positionTotals.positions, 1);
    assert.equal(Number(positionTotals.net_value), 12000, 'look-through claims never enter Position totals');

    const backup = await createDatabaseBackupPayload();
    backupContent = backup.content;
    for (const table of [
      'companies', 'investing_entities', 'vehicle_portfolio_snapshots',
      'vehicle_exposure_claims', 'company_fact_registry', 'company_facts',
    ]) {
      assert.ok(backup.tables.some(row => row.table === table), `${table} is included in backup`);
    }

    const [unresolved] = await query(`
      INSERT INTO investments
        (company_name, status, invest_date, asset_class, source)
      VALUES ('Needs Identity Review', 'Live', '2025-08-01', 'direct', 'test')
      RETURNING id
    `);
    const queue = await canonicalIdentityReviewQueue();
    assert.ok(queue.positions.some(row => Number(row.id) === Number(unresolved.id)));
    assert.ok(queue.exposures.some(row => row.raw_target_name === 'ACME Robotics'));
    const candidates = await canonicalIdentityCandidates();
    assert.ok(candidates.some(row => row.id === holder.entity.id && row.investing_entity_kind === 'llc'));
    assert.ok(candidates.some(row => row.id === company.entity.id && row.is_company));

    await proposeCompanyFact({
      companyEntityId: company.entity.id,
      factKey: 'headquarters',
      value: 'Private local value',
      sourceNamespace: 'manual',
      sourceClaimId: 'local-only',
      sourceHash: 'local-only',
      processingPolicy: 'local_only',
      syncPolicy: 'local_only',
    });
    await assert.rejects(() => createDatabaseBackupPayload(), /backup denied/);

    const commands = new Set(commandMetadata().commands.map(command => command.name));
    for (const name of [
      'identity.prepare', 'identity.create', 'identity.link_position',
      'identity.redirect', 'identity.resolve_exposure', 'fund.record_disclosure',
    ]) assert.ok(commands.has(name), `${name} is available to UI, Command, and adapters`);
  });

  await withTenant(restoreUrl, async () => {
    await runMigrations();
    await restoreDatabase({ content: backupContent });
    const [restoredCompany] = await query(
      `SELECT COUNT(*)::int AS count FROM companies WHERE entity_id = $1`,
      [expectedCompanyEntityId],
    );
    const [restoredVehicle] = await query(
      `SELECT COUNT(*)::int AS count FROM investing_entities WHERE entity_id = $1`,
      [expectedVehicleEntityId],
    );
    const [restoredDisclosures] = await query(`
      SELECT COUNT(*)::int AS snapshots,
             (SELECT COUNT(*)::int FROM vehicle_exposure_claims) AS claims,
             (SELECT COUNT(*)::int FROM company_facts) AS facts
        FROM vehicle_portfolio_snapshots
    `);
    assert.equal(restoredCompany.count, 1, 'Company stable ID survives restore');
    assert.equal(restoredVehicle.count, 1, 'vehicle stable ID survives restore');
    assert.equal(restoredDisclosures.snapshots, 2);
    assert.equal(restoredDisclosures.claims, 2);
    assert.equal(restoredDisclosures.facts, 2);
  });

  console.log('canonical product model: identity, look-through, facts, policy, totals, and restore passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
