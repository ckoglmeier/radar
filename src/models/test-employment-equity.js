import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, query, withAtomicWrite, withTenant } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createDocument, accessDocumentBytes } from './documents.js';
import {
  addEmploymentEquityGrant,
  addInvestmentLot,
  addIssuerDisclosure,
  archiveEmploymentEquityPosition,
  calculateEmploymentEquityValue,
  createEmploymentEquityIssuer,
  createEmploymentEquityPosition,
  employmentEquityGrantBalances,
  employmentEquityMetrics,
  employmentEquitySummary,
  getEmploymentEquityPosition,
  listEmploymentEquityPositions,
  recordBasisAdjustment,
  recordEmploymentEquityDisposition,
  recordEmploymentEquityDistribution,
  recordEmploymentEquityIssuerMark,
  recordEmploymentEquityValuation,
  recordExerciseOrPurchase,
  recordForfeitureOrExpiration,
  recordSettlement,
  restoreEmploymentEquityPosition,
} from './employment-equity.js';

const scratch = mkdtempSync(join(tmpdir(), 'radar-employment-equity-'));
const databaseUrl = `file:${join(scratch, 'db')}`;

function dateOnly(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

try {
  await withTenant(databaseUrl, async () => {
    await runMigrations();

    const guild = await createEmploymentEquityIssuer({
      legalName: 'Guild Education Test, Inc.',
      legalForm: 'c_corporation',
      jurisdiction: 'Delaware',
      relationshipStatus: 'former_employee',
      employmentStartDate: '2018-01-01',
      employmentEndDate: '2022-12-31',
    });
    const options = await createEmploymentEquityPosition({
      portfolioEntityId: guild.entity.id,
      displayName: '2019 ISO grant',
      instrumentFamily: 'iso',
      investDate: '2019-03-01',
      ownershipEntity: 'Individual',
      migrationKey: 'test:guild:iso-2019',
      firstGrant: {
        grantIdentifier: 'ISO-2019-1',
        legalInstrumentName: '2019 Equity Incentive Plan Option',
        instrumentType: 'iso',
        grantDate: '2019-03-01',
        unitsGranted: 1_000,
        unitsVestedConfirmed: 1_000,
        balanceAsOfDate: '2024-12-31',
        strikePrice: 1,
      },
      openingValuations: [{
        date: '2019-03-01',
        commonShareValuePerUnit: 1,
        taxFmvPerUnit: 1,
        confidence: 'calculated',
      }],
    });
    assert.equal(Number(options.valuations[0].valuation.net_value), 0);
    const common = await createEmploymentEquityPosition({
      portfolioEntityId: guild.entity.id,
      displayName: '2021 common stock purchase',
      instrumentFamily: 'common_stock',
      investDate: '2021-06-15',
      ownershipEntity: 'Individual',
      firstLot: {
        acquisitionDate: '2021-06-15',
        taxHoldingStartDate: '2021-06-15',
        instrumentType: 'common_stock',
        unitsAcquired: 50,
        acquisitionPricePerUnit: 2,
        cashOutlay: 100,
        taxBasis: 100,
        compensationBasis: 0,
        basisAsOfDate: '2021-06-15',
        basisSource: 'tax_record',
      },
    });
    assert.notEqual(options.investment.id, common.investment.id);
    assert.equal(options.investment.portfolio_entity_id, common.investment.portfolio_entity_id);

    const exercise = await recordExerciseOrPurchase(options.investment.id, {
      grantId: options.grant.id,
      date: '2023-04-01',
      units: 100,
      cashOutlay: 100,
      acquisitionPricePerUnit: 1,
      fairMarketValuePerUnit: 5,
      fairMarketValueDate: '2023-04-01',
      taxHoldingStartDate: '2023-04-01',
      taxBasis: 500,
      compensationBasis: 400,
      basisAsOfDate: '2023-04-01',
      externalHash: 'test:guild:exercise:1',
    });
    assert.equal((await recordExerciseOrPurchase(options.investment.id, {
      grantId: options.grant.id,
      date: '2023-04-01',
      units: 100,
      cashOutlay: 100,
      externalHash: 'test:guild:exercise:1',
    })).idempotent_replay, true);
    assert.equal(Number(exercise.cash_flow.amount), -100);
    assert.equal(Number(exercise.lot.cash_outlay), 100);
    assert.equal(Number(exercise.lot.tax_basis), 500);
    assert.equal(Number(exercise.lot.compensation_basis), 400);

    const balances = await employmentEquityGrantBalances(options.grant.id);
    assert.equal(balances.exercised_units, 100);
    assert.equal(balances.vested_unexercised_units, 900);
    const calculated = await calculateEmploymentEquityValue(options.investment.id, 10);
    assert.deepEqual(calculated, {
      common_fmv_per_unit: 10,
      option_intrinsic_value: 8_100,
      vested_unexercised_option_value: 8_100,
      owned_share_units: 100,
      owned_share_value: 1_000,
      vested_value: 9_100,
      unvested_value: 0,
    });
    const mark = await recordEmploymentEquityValuation(options.investment.id, {
      date: '2024-12-31',
      commonShareValuePerUnit: 10,
      taxFmvPerUnit: 4,
      confidence: 'calculated',
    });
    assert.equal(Number(mark.valuation.net_value), 9_100);
    assert.equal(Number(mark.details.vested_value), 9_100);
    assert.equal(Number(mark.details.unvested_value), 0);
    assert.equal(Number(mark.details.common_fmv_per_unit), 10);
    assert.equal(Number(mark.details.tax_fmv_per_unit), 4);
    const optionMetrics = await employmentEquityMetrics(options.investment.id);
    assert.equal(optionMetrics.starting_value, 0);
    assert.equal(optionMetrics.vested_value, 9_100);
    assert.equal(optionMetrics.value_change, 9_100);
    assert.equal(optionMetrics.valuation_count, 2);

    const taxMark = await recordEmploymentEquityIssuerMark(guild.entity.id, {
      markType: 'tax_409a',
      date: '2025-05-31',
      valuePerUnit: 6,
      confidence: 'company_reported',
      sourceFactKey: 'test:guild:409a:2025-05-31',
    });
    assert.equal(taxMark.valuations.length, 0, '409A is reference-only');

    const secondLot = await addInvestmentLot(common.investment.id, {
      acquisitionDate: '2022-02-01',
      taxHoldingStartDate: '2022-02-01',
      instrumentType: 'common_stock',
      unitsAcquired: 100,
      acquisitionPricePerUnit: 3.5,
      cashOutlay: 350,
      taxBasis: 375,
      compensationBasis: 25,
      basisAsOfDate: '2022-02-01',
      basisSource: 'tax_record',
    });
    const commonDetail = await getEmploymentEquityPosition(common.investment.id);
    assert.equal(commonDetail.lots.length, 2);
    assert.deepEqual(
      commonDetail.lots.map(row => [dateOnly(row.acquisition_date), Number(row.acquisition_price_per_unit)]),
      [['2021-06-15', 2], ['2022-02-01', 3.5]],
    );
    await assert.rejects(
      () => withAtomicWrite(async () => {
        await addInvestmentLot(common.investment.id, {
          acquisitionDate: '2023-01-01',
          instrumentType: 'common_stock',
          unitsAcquired: 10,
          acquisitionPricePerUnit: 4,
          cashOutlay: 40,
          taxBasis: 40,
          basisAsOfDate: '2023-01-01',
          basisSource: 'tax_record',
        });
        throw new Error('force outer Employment Equity rollback');
      }),
      /force outer Employment Equity rollback/,
    );
    assert.equal(
      (await getEmploymentEquityPosition(common.investment.id)).lots.length,
      2,
      'nested Employment Equity write participates in outer rollback',
    );

    const disposition = await recordEmploymentEquityDisposition(common.investment.id, {
      eventType: 'tender',
      date: '2025-01-15',
      amount: 600,
      allocations: [
        {
          lotId: commonDetail.lots[0].id,
          units: 20,
          grossProceedsAllocated: 200,
          taxBasisAllocated: 40,
        },
        {
          lotId: secondLot.id,
          units: 40,
          grossProceedsAllocated: 400,
          taxBasisAllocated: 150,
        },
      ],
      externalHash: 'test:guild:tender:1',
    });
    assert.equal(Number(disposition.cash_flow.amount), 600);
    assert.equal(disposition.allocations.length, 2);
    assert.equal(Number((await query(`SELECT units_remaining FROM investment_lots WHERE id = $1`, [secondLot.id]))[0].units_remaining), 60);
    await assert.rejects(
      () => recordEmploymentEquityDisposition(common.investment.id, {
        date: '2025-02-01',
        amount: 1,
        allocations: [{ lotId: secondLot.id, units: 61, grossProceedsAllocated: 1 }],
      }),
      /exceeds remaining units/,
    );

    const adjusted = await recordBasisAdjustment(common.investment.id, {
      lotId: secondLot.id,
      date: '2025-02-15',
      taxBasis: 300,
      reason: 'Updated tax record after tender allocation',
      basisSource: 'tax_record',
    });
    assert.equal(Number(adjusted.lot.tax_basis), 300);
    await recordEmploymentEquityDistribution(common.investment.id, {
      date: '2025-03-01', amount: 25, externalHash: 'test:guild:distribution:1',
    });
    const commonMetrics = await employmentEquityMetrics(common.investment.id);
    assert.equal(commonMetrics.realized_gross_proceeds, 600);
    assert.equal(commonMetrics.cash_distributions, 25);
    assert.equal(commonMetrics.remaining_cash_outlay, 270);
    assert.equal(commonMetrics.remaining_tax_basis, 240);
    assert.equal(commonMetrics.remaining_compensation_basis, 15);

    const rsuGrant = await addEmploymentEquityGrant(common.investment.id, {
      legalInstrumentName: 'RSU award', instrumentType: 'rsu', grantDate: '2022-01-01',
      unitsGranted: 10, unitsVestedConfirmed: 10,
    });
    const settlement = await recordSettlement(common.investment.id, {
      grantId: rsuGrant.id, date: '2024-01-01', units: 10,
      resultingInstrumentType: 'common_stock', taxBasis: 50, compensationBasis: 50,
    });
    assert.equal(settlement.event.cash_flow_id, null);

    const issuerMark = await recordEmploymentEquityIssuerMark(guild.entity.id, {
      markType: 'common_share_economic',
      date: '2025-06-30',
      valuePerUnit: 12,
      confidence: 'company_reported',
      sourceFactKey: 'test:guild:common:2025-06-30',
    });
    assert.equal(issuerMark.valuations.length, 2, 'one issuer mark derives all eligible positions');
    assert.equal(issuerMark.manual_positions.length, 0);
    assert.equal(
      Number((await query(`
        SELECT COUNT(*) AS count
          FROM employment_equity_valuation_details
         WHERE issuer_mark_id = $1
      `, [issuerMark.mark.id]))[0].count),
      2,
    );
    assert.equal((await recordEmploymentEquityIssuerMark(guild.entity.id, {
      markType: 'common_share_economic', date: '2025-06-30', valuePerUnit: 12,
    })).idempotent_replay, true);
    await assert.rejects(
      () => recordEmploymentEquityIssuerMark(guild.entity.id, {
        markType: 'common_share_economic', date: '2025-06-30', valuePerUnit: 13,
      }),
      error => error.code === 'ISSUER_MARK_DATE_CONFLICT',
    );
    await recordForfeitureOrExpiration(options.investment.id, {
      grantId: options.grant.id, eventType: 'expiration', date: '2025-03-01', units: 50,
    });
    assert.equal((await employmentEquityGrantBalances(options.grant.id)).vested_unexercised_units, 850);

    const artwork = await createEmploymentEquityIssuer({
      legalName: 'Artwork Archive Test LLC', legalForm: 'llc', relationshipStatus: 'former_employee',
    });
    const ppu = await createEmploymentEquityPosition({
      portfolioEntityId: artwork.entity.id,
      displayName: 'Employment-origin PPUs',
      instrumentFamily: 'ppu',
      investDate: '2020-05-01',
      firstGrant: {
        legalInstrumentName: 'Profits Participation Units Agreement',
        instrumentType: 'ppu', grantDate: '2020-05-01', unitsGranted: 100,
        unitsVestedConfirmed: 100, hurdleAmount: 1_000_000,
      },
    });
    await assert.rejects(() => calculateEmploymentEquityValue(ppu.investment.id, 10), /manually confirmed valuation/);
    const ppuMark = await recordEmploymentEquityValuation(ppu.investment.id, {
      date: '2024-12-31', vestedValue: 50_000, unvestedValue: 0,
      methodology: 'manual', confidence: 'estimated', hurdleAmount: 1_000_000,
    });
    assert.equal(Number(ppuMark.valuation.net_value), 50_000);
    const artworkIssuerMark = await recordEmploymentEquityIssuerMark(artwork.entity.id, {
      markType: 'common_share_economic', date: '2025-06-30', valuePerUnit: 20,
    });
    assert.equal(artworkIssuerMark.valuations.length, 0);
    assert.deepEqual(
      artworkIssuerMark.manual_positions.map(row => Number(row.investment_id)),
      [Number(ppu.investment.id)],
    );

    const disclosureDocument = await createDocument({
      entity_type: 'portfolio_entity',
      entity_id: guild.entity.id,
      filename: 'rule-701.pdf',
      mime: 'application/pdf',
      content: Buffer.from('private Rule 701 fixture'),
      confidentiality: 'confidential_company',
      processing_policy: 'local_only',
      sync_policy: 'local_only',
      executionMode: 'desktop',
    });
    await addIssuerDisclosure(guild.entity.id, {
      documentId: disclosureDocument.id,
      disclosureType: 'rule_701',
      receivedDate: '2025-04-01',
      financialsAsOfDate: '2024-12-31',
    });
    await assert.rejects(
      () => accessDocumentBytes({ documentId: disclosureDocument.id, purpose: 'model', executionMode: 'desktop' }),
      error => error.code === 'DOCUMENT_POLICY_DENIED',
    );
    assert.equal((await getEmploymentEquityPosition(options.investment.id)).disclosures.length, 1);

    await archiveEmploymentEquityPosition(ppu.investment.id);
    assert.equal((await listEmploymentEquityPositions()).length, 2);
    assert.equal((await listEmploymentEquityPositions({ includeArchived: true })).length, 3);
    await restoreEmploymentEquityPosition(ppu.investment.id);
    const summary = await employmentEquitySummary();
    assert.equal(summary.issuer_count, 2);
    assert.equal(summary.position_count, 3);
    assert.equal(summary.vested_value, 62_300, 'issuer mark fills every eligible linked position');

    await assert.rejects(
      () => query(`UPDATE cash_flows SET amount = 999 WHERE id = $1`, [exercise.cash_flow.id]),
      /immutable/,
    );
    await assert.rejects(
      () => query(`UPDATE employment_equity_events SET units = 99 WHERE id = $1`, [exercise.event.id]),
      /immutable/,
    );

    const before = Number((await query(`SELECT COUNT(*) AS count FROM investments`))[0].count);
    await assert.rejects(
      () => createEmploymentEquityPosition({
        portfolioEntityId: guild.entity.id,
        displayName: 'Rollback fixture',
        instrumentFamily: 'iso',
        investDate: '2026-01-01',
        migrationKey: 'test:guild:iso-2019',
      }),
      /migration_key|duplicate key/i,
    );
    assert.equal(Number((await query(`SELECT COUNT(*) AS count FROM investments`))[0].count), before);

    const [fundEntity] = await query(`
      INSERT INTO portfolio_entities (legal_name, normalized_name, entity_type)
      VALUES ('Not Employment Fund I', 'not employment fund i', 'fund_vehicle') RETURNING id
    `);
    const [fund] = await query(`
      INSERT INTO investments (portfolio_entity_id, company_name, invest_date, status, source, asset_class)
      VALUES ($1, 'Not Employment Fund I', '2024-01-01', 'Live', 'test', 'fund') RETURNING id
    `, [fundEntity.id]);
    await assert.rejects(
      () => addInvestmentLot(fund.id, {
        acquisitionDate: '2024-01-01', instrumentType: 'other', cashOutlay: 10,
      }),
      /Direct or Employment Equity/,
    );
  });

  console.log('Employment Equity model tests passed');
} finally {
  await closeDb();
  rmSync(scratch, { recursive: true, force: true });
}
