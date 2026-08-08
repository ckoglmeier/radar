import { randomUUID } from 'node:crypto';
import { isPgliteActive, query } from '../db/index.js';
import { normalize } from '../utils/company-names.js';

const POSITION_STATUSES = new Set(['active', 'partially_realized', 'realized', 'forfeited', 'archived']);
const INSTRUMENTS = new Set(['ppu', 'common_stock', 'iso', 'nso', 'rsu', 'profits_interest', 'other']);
const LOT_INSTRUMENTS = new Set([
  'ppu', 'common_stock', 'iso', 'nso', 'rsu', 'preferred_stock',
  'profits_interest', 'safe', 'convertible_note', 'other',
]);
const GRANT_STATUSES = new Set([
  'active', 'fully_vested', 'exercised', 'settled', 'forfeited', 'cancelled', 'expired',
]);
const DISPOSITION_TYPES = new Set(['sale', 'tender', 'repurchase']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function isoDate(value, label) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return date;
}

function optionalDate(value, label) {
  return value == null || value === '' ? null : isoDate(value, label);
}

function number(value, label, { positive = false, nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || (positive ? amount <= 0 : amount < 0)) {
    throw new TypeError(`${label} must be ${positive ? 'positive' : 'non-negative'}`);
  }
  return amount;
}

function assertEnum(value, allowed, label) {
  if (!allowed.has(value)) throw new TypeError(`invalid ${label}: ${value}`);
  return value;
}

function assertUsd(currency) {
  if (currency != null && String(currency).toUpperCase() !== 'USD') {
    throw new TypeError('Employment Equity currently supports USD workspace amounts only');
  }
}

function dateOnly(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

async function withEmploymentEquityWrite(fn) {
  if (!(await isPgliteActive())) {
    throw new Error('Employment Equity writes require local PGlite transaction support');
  }
  await query('BEGIN');
  try {
    const result = await fn();
    await query('COMMIT');
    return result;
  } catch (error) {
    try { await query('ROLLBACK'); } catch { /* preserve operation error */ }
    throw error;
  }
}

async function position(investmentId, { lock = false } = {}) {
  const [row] = await query(`
    SELECT i.*, pe.legal_name, pe.entity_type, eep.instrument_family,
           eep.position_status, eep.display_name, eep.archived_at
      FROM investments i
      LEFT JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
      LEFT JOIN employment_equity_positions eep ON eep.investment_id = i.id
     WHERE i.id = $1
     ${lock ? 'FOR UPDATE OF i' : ''}
  `, [investmentId]);
  if (!row) throw new Error(`investment not found: ${investmentId}`);
  if (row.asset_class !== 'employment_equity' || row.entity_type !== 'operating_company') {
    throw new Error('Employment Equity operation requires an Employment Equity position linked to an operating-company entity');
  }
  if (!row.instrument_family) throw new Error(`Employment Equity profile not found: ${investmentId}`);
  return row;
}

async function grant(grantId, investmentId = null, { lock = false } = {}) {
  const [row] = await query(`
    SELECT * FROM employment_equity_grants WHERE id = $1
    ${lock ? 'FOR UPDATE' : ''}
  `, [grantId]);
  if (!row) throw new Error(`Employment Equity grant not found: ${grantId}`);
  if (investmentId != null && Number(row.investment_id) !== Number(investmentId)) {
    throw new Error('grant belongs to another position');
  }
  return row;
}

async function lot(lotId, investmentId = null, { lock = false } = {}) {
  const [row] = await query(`
    SELECT * FROM investment_lots WHERE id = $1
    ${lock ? 'FOR UPDATE' : ''}
  `, [lotId]);
  if (!row) throw new Error(`investment lot not found: ${lotId}`);
  if (investmentId != null && Number(row.investment_id) !== Number(investmentId)) {
    throw new Error('lot belongs to another position');
  }
  return row;
}

async function insertIssuerProfile(portfolioEntityId, fields) {
  const relationshipStatus = fields.relationshipStatus || 'other';
  const [profile] = await query(`
    INSERT INTO employment_equity_issuer_profiles
      (portfolio_entity_id, relationship_status, employment_start_date, employment_end_date)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [
    portfolioEntityId,
    relationshipStatus,
    optionalDate(fields.employmentStartDate, 'Employment start date'),
    optionalDate(fields.employmentEndDate, 'Employment end date'),
  ]);
  return profile;
}

export async function createEmploymentEquityIssuer(fields = {}) {
  const legalName = requiredText(fields.legalName, 'Legal name');
  return withEmploymentEquityWrite(async () => {
    const [entity] = await query(`
      INSERT INTO portfolio_entities
        (legal_name, normalized_name, entity_type, legal_form, jurisdiction, website, description)
      VALUES ($1, $2, 'operating_company', $3, $4, $5, $6)
      RETURNING *
    `, [
      legalName,
      normalize(legalName),
      optionalText(fields.legalForm),
      optionalText(fields.jurisdiction),
      optionalText(fields.website),
      optionalText(fields.description),
    ]);
    const profile = await insertIssuerProfile(entity.id, fields);
    return { entity, profile };
  });
}

export async function createEmploymentEquityIssuerProfile(portfolioEntityId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const [entity] = await query(`SELECT * FROM portfolio_entities WHERE id = $1 FOR UPDATE`, [portfolioEntityId]);
    if (!entity || entity.entity_type !== 'operating_company') {
      throw new Error('Employment Equity issuer profile requires an operating-company entity');
    }
    const [existing] = await query(`
      SELECT * FROM employment_equity_issuer_profiles WHERE portfolio_entity_id = $1
    `, [portfolioEntityId]);
    if (existing) return { profile: existing, idempotent_replay: true };
    return { profile: await insertIssuerProfile(portfolioEntityId, fields), idempotent_replay: false };
  });
}

export async function updateEmploymentEquityIssuerProfile(portfolioEntityId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const [current] = await query(`
      SELECT * FROM employment_equity_issuer_profiles WHERE portfolio_entity_id = $1 FOR UPDATE
    `, [portfolioEntityId]);
    if (!current) throw new Error(`Employment Equity issuer profile not found: ${portfolioEntityId}`);
    const [profile] = await query(`
      UPDATE employment_equity_issuer_profiles
         SET relationship_status = $2,
             employment_start_date = $3,
             employment_end_date = $4,
             updated_at = NOW()
       WHERE portfolio_entity_id = $1
       RETURNING *
    `, [
      portfolioEntityId,
      fields.relationshipStatus || current.relationship_status,
      fields.employmentStartDate === undefined ? current.employment_start_date : optionalDate(fields.employmentStartDate, 'Employment start date'),
      fields.employmentEndDate === undefined ? current.employment_end_date : optionalDate(fields.employmentEndDate, 'Employment end date'),
    ]);
    return profile;
  });
}

async function insertGrant(investmentId, fields) {
  const instrumentType = assertEnum(fields.instrumentType, INSTRUMENTS, 'grant instrument');
  const unitsGranted = number(fields.unitsGranted, 'Units granted', { positive: true });
  const status = assertEnum(fields.status || 'active', GRANT_STATUSES, 'grant status');
  const [row] = await query(`
    INSERT INTO employment_equity_grants
      (investment_id, grant_identifier, legal_instrument_name, instrument_type,
       grant_date, service_start_date, share_or_unit_class, units_granted,
       units_vested_confirmed, units_forfeited_confirmed, units_expired_confirmed,
       balance_as_of_date, strike_price, expiration_date, hurdle_amount,
       vesting_terms_summary, status, terms_document_id, migration_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    RETURNING *
  `, [
    investmentId,
    optionalText(fields.grantIdentifier),
    requiredText(fields.legalInstrumentName, 'Legal instrument name'),
    instrumentType,
    isoDate(fields.grantDate, 'Grant date'),
    optionalDate(fields.serviceStartDate, 'Service start date'),
    optionalText(fields.shareOrUnitClass),
    unitsGranted,
    number(fields.unitsVestedConfirmed, 'Confirmed vested units', { nullable: true }),
    number(fields.unitsForfeitedConfirmed, 'Confirmed forfeited units', { nullable: true }),
    number(fields.unitsExpiredConfirmed, 'Confirmed expired units', { nullable: true }),
    optionalDate(fields.balanceAsOfDate, 'Balance as-of date'),
    number(fields.strikePrice, 'Strike price', { nullable: true }),
    optionalDate(fields.expirationDate, 'Expiration date'),
    number(fields.hurdleAmount, 'Hurdle amount', { nullable: true }),
    optionalText(fields.vestingTermsSummary),
    status,
    fields.termsDocumentId || null,
    optionalText(fields.migrationKey),
  ]);
  return row;
}

async function insertLot(investmentId, fields) {
  const instrumentType = assertEnum(fields.instrumentType, LOT_INSTRUMENTS, 'lot instrument');
  const unitsAcquired = number(fields.unitsAcquired, 'Units acquired', { positive: true, nullable: true });
  const unitsRemaining = fields.unitsRemaining == null ? unitsAcquired
    : number(fields.unitsRemaining, 'Units remaining', { nullable: true });
  const [row] = await query(`
    INSERT INTO investment_lots
      (investment_id, grant_id, acquisition_date, tax_holding_start_date,
       instrument_type, share_or_unit_class, units_acquired, units_remaining,
       acquisition_price_per_unit, fair_market_value_per_unit, fair_market_value_date,
       cash_outlay, tax_basis, compensation_basis, basis_as_of_date, basis_source,
       source_document_id, migration_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING *
  `, [
    investmentId,
    fields.grantId || null,
    isoDate(fields.acquisitionDate, 'Acquisition date'),
    optionalDate(fields.taxHoldingStartDate, 'Tax holding start date'),
    instrumentType,
    optionalText(fields.shareOrUnitClass),
    unitsAcquired,
    unitsRemaining,
    number(fields.acquisitionPricePerUnit, 'Acquisition price per unit', { nullable: true }),
    number(fields.fairMarketValuePerUnit, 'Fair market value per unit', { nullable: true }),
    optionalDate(fields.fairMarketValueDate, 'Fair market value date'),
    number(fields.cashOutlay, 'Cash outlay', { nullable: true }),
    number(fields.taxBasis, 'Tax basis', { nullable: true }),
    number(fields.compensationBasis, 'Compensation basis', { nullable: true }),
    optionalDate(fields.basisAsOfDate, 'Basis as-of date'),
    optionalText(fields.basisSource),
    fields.sourceDocumentId || null,
    optionalText(fields.migrationKey),
  ]);
  return row;
}

export async function createEmploymentEquityPosition(fields = {}) {
  assertUsd(fields.currency);
  const portfolioEntityId = requiredText(fields.portfolioEntityId, 'Portfolio entity ID');
  const displayName = requiredText(fields.displayName, 'Position display name');
  const instrumentFamily = assertEnum(fields.instrumentFamily, INSTRUMENTS, 'instrument family');
  const investDate = isoDate(fields.investDate || fields.firstGrant?.grantDate || fields.firstLot?.acquisitionDate, 'Position date');
  return withEmploymentEquityWrite(async () => {
    const [entity] = await query(`SELECT * FROM portfolio_entities WHERE id = $1 FOR UPDATE`, [portfolioEntityId]);
    if (!entity || entity.entity_type !== 'operating_company') {
      throw new Error('Employment Equity position requires a reviewed operating-company entity');
    }
    const [issuerProfile] = await query(`
      SELECT * FROM employment_equity_issuer_profiles WHERE portfolio_entity_id = $1
    `, [portfolioEntityId]);
    if (!issuerProfile) throw new Error('Employment Equity issuer profile must exist before creating a position');
    const status = assertEnum(fields.positionStatus || 'active', POSITION_STATUSES, 'position status');
    const [investment] = await query(`
      INSERT INTO investments
        (portfolio_entity_id, company_name, status, invest_date, investment_entity,
         investment_type, instrument, source, notes, asset_class)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'employment_equity_manual',$8,'employment_equity')
      RETURNING *
    `, [
      portfolioEntityId,
      entity.legal_name,
      status === 'realized' ? 'Realized' : status === 'forfeited' ? 'Written Off' : 'Live',
      investDate,
      optionalText(fields.ownershipEntity),
      instrumentFamily,
      optionalText(fields.instrument),
      optionalText(fields.notes),
    ]);
    const [typedPosition] = await query(`
      INSERT INTO employment_equity_positions
        (investment_id, display_name, instrument_family, position_status,
         description, archived_at, migration_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [
      investment.id,
      displayName,
      instrumentFamily,
      status,
      optionalText(fields.description),
      status === 'archived' ? new Date() : null,
      optionalText(fields.migrationKey),
    ]);
    const firstGrant = fields.firstGrant ? await insertGrant(investment.id, fields.firstGrant) : null;
    const firstLot = fields.firstLot ? await insertLot(investment.id, {
      ...fields.firstLot,
      grantId: fields.firstLot.grantId || firstGrant?.id || null,
    }) : null;
    return { investment, position: typedPosition, grant: firstGrant, lot: firstLot };
  });
}

export async function addEmploymentEquityGrant(investmentId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    return insertGrant(investmentId, fields);
  });
}

export async function updateGrantTerms(grantId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const current = await grant(grantId, null, { lock: true });
    await position(current.investment_id, { lock: true });
    const status = fields.status === undefined ? current.status
      : assertEnum(fields.status, GRANT_STATUSES, 'grant status');
    const [updated] = await query(`
      UPDATE employment_equity_grants
         SET units_vested_confirmed = $2,
             units_forfeited_confirmed = $3,
             units_expired_confirmed = $4,
             balance_as_of_date = $5,
             vesting_terms_summary = $6,
             status = $7,
             updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [
      grantId,
      fields.unitsVestedConfirmed === undefined ? current.units_vested_confirmed : number(fields.unitsVestedConfirmed, 'Confirmed vested units', { nullable: true }),
      fields.unitsForfeitedConfirmed === undefined ? current.units_forfeited_confirmed : number(fields.unitsForfeitedConfirmed, 'Confirmed forfeited units', { nullable: true }),
      fields.unitsExpiredConfirmed === undefined ? current.units_expired_confirmed : number(fields.unitsExpiredConfirmed, 'Confirmed expired units', { nullable: true }),
      fields.balanceAsOfDate === undefined ? current.balance_as_of_date : optionalDate(fields.balanceAsOfDate, 'Balance as-of date'),
      fields.vestingTermsSummary === undefined ? current.vesting_terms_summary : optionalText(fields.vestingTermsSummary),
      status,
    ]);
    return updated;
  });
}

export async function addInvestmentLot(investmentId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const [parent] = await query(`SELECT asset_class FROM investments WHERE id = $1 FOR UPDATE`, [investmentId]);
    if (!parent || !['direct', 'employment_equity'].includes(parent.asset_class)) {
      throw new Error('investment lot requires a Direct or Employment Equity position');
    }
    if (fields.grantId) await grant(fields.grantId, investmentId);
    return insertLot(investmentId, fields);
  });
}

async function insertCashFlow(investmentId, { date, amount, type, subtype, description, externalHash }) {
  const [flow] = await query(`
    INSERT INTO cash_flows
      (investment_id, flow_date, type, subtype, amount, description, company_raw,
       source, external_hash, reconciliation_status, reconciled_at)
    SELECT $1,$2,$3,$4,$5,$6,company_name,'employment_equity_manual',$7,'matched',NOW()
      FROM investments WHERE id = $1
    RETURNING *
  `, [investmentId, date, type, subtype, amount, description, externalHash]);
  return flow;
}

async function eventByHash(externalHash) {
  if (!externalHash) return null;
  const [event] = await query(`SELECT * FROM employment_equity_events WHERE external_hash = $1`, [externalHash]);
  return event || null;
}

export async function recordExerciseOrPurchase(investmentId, fields = {}) {
  assertUsd(fields.currency);
  const eventDate = isoDate(fields.date, 'Exercise date');
  const units = number(fields.units, 'Units', { positive: true });
  const cashOutlay = number(fields.cashOutlay, 'Cash outlay', { positive: true });
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const linkedGrant = await grant(fields.grantId, investmentId, { lock: true });
    const key = optionalText(fields.externalHash) || `ee-exercise:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const balances = await employmentEquityGrantBalances(linkedGrant.id);
    if (units > balances.vested_unexercised_units) {
      throw new Error('exercise units exceed vested unexercised grant balance');
    }
    const flow = await insertCashFlow(investmentId, {
      date: eventDate,
      amount: -cashOutlay,
      type: 'investment',
      subtype: 'employee_equity_exercise',
      description: optionalText(fields.description) || `Exercise ${linkedGrant.legal_instrument_name}`,
      externalHash: `ee-cash:${key}`,
    });
    const acquiredLot = await insertLot(investmentId, {
      grantId: linkedGrant.id,
      acquisitionDate: eventDate,
      taxHoldingStartDate: fields.taxHoldingStartDate,
      instrumentType: fields.resultingInstrumentType || 'common_stock',
      shareOrUnitClass: fields.shareOrUnitClass || linkedGrant.share_or_unit_class,
      unitsAcquired: units,
      acquisitionPricePerUnit: fields.acquisitionPricePerUnit ?? linkedGrant.strike_price,
      fairMarketValuePerUnit: fields.fairMarketValuePerUnit,
      fairMarketValueDate: fields.fairMarketValueDate,
      cashOutlay,
      taxBasis: fields.taxBasis,
      compensationBasis: fields.compensationBasis,
      basisAsOfDate: fields.basisAsOfDate,
      basisSource: fields.basisSource || 'exercise_confirmation',
      sourceDocumentId: fields.sourceDocumentId,
    });
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, grant_id, lot_id, event_type, event_date, units,
         gross_amount, price_per_unit, cash_flow_id, source_document_id, notes, external_hash)
      VALUES ($1,$2,$3,'exercise',$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      investmentId, linkedGrant.id, acquiredLot.id, eventDate, units, cashOutlay,
      fields.acquisitionPricePerUnit ?? linkedGrant.strike_price,
      flow.id, fields.sourceDocumentId || null, optionalText(fields.notes), key,
    ]);
    return { event, cash_flow: flow, lot: acquiredLot, idempotent_replay: false };
  });
}

export async function recordSettlement(investmentId, fields = {}) {
  const eventDate = isoDate(fields.date, 'Settlement date');
  const units = number(fields.units, 'Units', { positive: true });
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const linkedGrant = await grant(fields.grantId, investmentId, { lock: true });
    const key = optionalText(fields.externalHash) || `ee-settlement:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const acquiredLot = await insertLot(investmentId, {
      grantId: linkedGrant.id,
      acquisitionDate: eventDate,
      taxHoldingStartDate: fields.taxHoldingStartDate,
      instrumentType: fields.resultingInstrumentType || 'common_stock',
      shareOrUnitClass: fields.shareOrUnitClass || linkedGrant.share_or_unit_class,
      unitsAcquired: units,
      acquisitionPricePerUnit: fields.acquisitionPricePerUnit,
      fairMarketValuePerUnit: fields.fairMarketValuePerUnit,
      fairMarketValueDate: fields.fairMarketValueDate,
      cashOutlay: fields.cashOutlay,
      taxBasis: fields.taxBasis,
      compensationBasis: fields.compensationBasis,
      basisAsOfDate: fields.basisAsOfDate,
      basisSource: fields.basisSource,
      sourceDocumentId: fields.sourceDocumentId,
    });
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, grant_id, lot_id, event_type, event_date, units,
         price_per_unit, source_document_id, notes, external_hash)
      VALUES ($1,$2,$3,'settlement',$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [
      investmentId, linkedGrant.id, acquiredLot.id, eventDate, units,
      fields.acquisitionPricePerUnit ?? null, fields.sourceDocumentId || null,
      optionalText(fields.notes), key,
    ]);
    return { event, lot: acquiredLot, idempotent_replay: false };
  });
}

export async function recordEmploymentEquityDistribution(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const date = isoDate(fields.date, 'Distribution date');
    const amount = number(fields.amount, 'Distribution amount', { positive: true });
    const key = optionalText(fields.externalHash) || `ee-distribution:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const flow = await insertCashFlow(investmentId, {
      date, amount, type: 'distribution', subtype: optionalText(fields.subtype) || 'employee_equity_distribution',
      description: optionalText(fields.description), externalHash: `ee-cash:${key}`,
    });
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, event_type, event_date, gross_amount, cash_flow_id,
         source_document_id, notes, external_hash)
      VALUES ($1,'distribution',$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [investmentId, date, amount, flow.id, fields.sourceDocumentId || null, optionalText(fields.notes), key]);
    return { event, cash_flow: flow, idempotent_replay: false };
  });
}

export async function recordEmploymentEquityDisposition(investmentId, fields = {}) {
  assertUsd(fields.currency);
  const eventType = assertEnum(fields.eventType || 'sale', DISPOSITION_TYPES, 'disposition event type');
  const date = isoDate(fields.date, 'Disposition date');
  const amount = number(fields.amount, 'Gross proceeds', { positive: true });
  if (!Array.isArray(fields.allocations) || fields.allocations.length === 0) {
    throw new TypeError('Manual lot allocations are required');
  }
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const key = optionalText(fields.externalHash) || `ee-disposition:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const allocations = [];
    let totalUnits = 0;
    let allocatedProceeds = 0;
    for (const input of fields.allocations) {
      const linkedLot = await lot(input.lotId, investmentId, { lock: true });
      const units = number(input.units, 'Allocated units', { positive: true });
      if (linkedLot.units_remaining == null || units > Number(linkedLot.units_remaining)) {
        throw new Error('lot allocation exceeds remaining units');
      }
      const proceeds = number(input.grossProceedsAllocated, 'Allocated gross proceeds');
      const basis = number(input.taxBasisAllocated, 'Allocated tax basis', { nullable: true });
      totalUnits += units;
      allocatedProceeds += proceeds;
      allocations.push({ input, lot: linkedLot, units, proceeds, basis });
    }
    if (Math.abs(allocatedProceeds - amount) > 0.005) {
      throw new Error('allocated gross proceeds must equal the disposition cash movement');
    }
    const flow = await insertCashFlow(investmentId, {
      date, amount, type: 'distribution', subtype: eventType,
      description: optionalText(fields.description), externalHash: `ee-cash:${key}`,
    });
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, event_type, event_date, units, gross_amount,
         price_per_unit, cash_flow_id, source_document_id, notes, external_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
    `, [
      investmentId, eventType, date, totalUnits, amount,
      fields.pricePerUnit == null ? null : number(fields.pricePerUnit, 'Price per unit'),
      flow.id, fields.sourceDocumentId || null, optionalText(fields.notes), key,
    ]);
    const inserted = [];
    for (const allocation of allocations) {
      const [row] = await query(`
        INSERT INTO investment_lot_allocations
          (lot_id, event_id, cash_flow_id, disposition_date, units_disposed,
           gross_proceeds_allocated, tax_basis_allocated, source_document_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
      `, [
        allocation.lot.id, event.id, flow.id, date, allocation.units,
        allocation.proceeds, allocation.basis, allocation.input.sourceDocumentId || null,
      ]);
      inserted.push(row);
      const remaining = Number(allocation.lot.units_remaining) - allocation.units;
      await query(`
        UPDATE investment_lots
           SET units_remaining = $2::numeric,
               status = CASE WHEN $2::numeric = 0 THEN 'disposed' ELSE 'partially_disposed' END,
               updated_at = NOW()
         WHERE id = $1
      `, [allocation.lot.id, remaining]);
    }
    await query(`
      UPDATE employment_equity_positions SET position_status = 'partially_realized', updated_at = NOW()
       WHERE investment_id = $1 AND position_status = 'active'
    `, [investmentId]);
    return { event, cash_flow: flow, allocations: inserted, idempotent_replay: false };
  });
}

export async function recordForfeitureOrExpiration(investmentId, fields = {}) {
  const eventType = fields.eventType;
  if (!['forfeiture', 'expiration'].includes(eventType)) throw new TypeError('event type must be forfeiture or expiration');
  const units = number(fields.units, 'Units', { positive: true });
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const linkedGrant = await grant(fields.grantId, investmentId, { lock: true });
    const key = optionalText(fields.externalHash) || `ee-${eventType}:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const field = eventType === 'forfeiture' ? 'units_forfeited_confirmed' : 'units_expired_confirmed';
    const next = Number(linkedGrant[field] || 0) + units;
    await query(`
      UPDATE employment_equity_grants
         SET ${field} = $2, balance_as_of_date = $3, updated_at = NOW()
       WHERE id = $1
    `, [linkedGrant.id, next, isoDate(fields.date, 'Event date')]);
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, grant_id, event_type, event_date, units,
         source_document_id, notes, external_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      investmentId, linkedGrant.id, eventType, isoDate(fields.date, 'Event date'), units,
      fields.sourceDocumentId || null, optionalText(fields.notes), key,
    ]);
    return { event, idempotent_replay: false };
  });
}

export async function recordBasisAdjustment(investmentId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const linkedLot = await lot(fields.lotId, investmentId, { lock: true });
    const date = isoDate(fields.date, 'Basis adjustment date');
    const key = optionalText(fields.externalHash) || `ee-basis:${randomUUID()}`;
    const existing = await eventByHash(key);
    if (existing) return { event: existing, idempotent_replay: true };
    const values = {
      cashOutlay: fields.cashOutlay === undefined ? linkedLot.cash_outlay : number(fields.cashOutlay, 'Cash outlay', { nullable: true }),
      taxBasis: fields.taxBasis === undefined ? linkedLot.tax_basis : number(fields.taxBasis, 'Tax basis', { nullable: true }),
      compensationBasis: fields.compensationBasis === undefined ? linkedLot.compensation_basis : number(fields.compensationBasis, 'Compensation basis', { nullable: true }),
    };
    const reason = requiredText(fields.reason, 'Adjustment reason');
    await query(`
      UPDATE investment_lots
         SET cash_outlay = $2, tax_basis = $3, compensation_basis = $4,
             basis_as_of_date = $5, basis_source = $6, updated_at = NOW()
       WHERE id = $1
    `, [linkedLot.id, values.cashOutlay, values.taxBasis, values.compensationBasis, date, optionalText(fields.basisSource) || 'manual']);
    const [event] = await query(`
      INSERT INTO employment_equity_events
        (investment_id, lot_id, event_type, event_date, source_document_id, notes, external_hash)
      VALUES ($1,$2,'basis_adjustment',$3,$4,$5,$6)
      RETURNING *
    `, [
      investmentId, linkedLot.id, date, fields.sourceDocumentId || null,
      JSON.stringify({ reason, before: {
        cash_outlay: linkedLot.cash_outlay,
        tax_basis: linkedLot.tax_basis,
        compensation_basis: linkedLot.compensation_basis,
      }, after: values }), key,
    ]);
    return { event, lot: await lot(linkedLot.id), idempotent_replay: false };
  });
}

export async function employmentEquityGrantBalances(grantId) {
  const linkedGrant = await grant(grantId);
  const [events] = await query(`
    SELECT
      COALESCE(SUM(units) FILTER (WHERE event_type = 'exercise' AND voided_at IS NULL), 0) AS exercised,
      COALESCE(SUM(units) FILTER (WHERE event_type = 'forfeiture' AND voided_at IS NULL), 0) AS forfeited_events,
      COALESCE(SUM(units) FILTER (WHERE event_type = 'expiration' AND voided_at IS NULL), 0) AS expired_events
      FROM employment_equity_events WHERE grant_id = $1
  `, [grantId]);
  const vested = Number(linkedGrant.units_vested_confirmed || 0);
  const exercised = Number(events.exercised || 0);
  const forfeited = Math.max(Number(linkedGrant.units_forfeited_confirmed || 0), Number(events.forfeited_events || 0));
  const expired = Math.max(Number(linkedGrant.units_expired_confirmed || 0), Number(events.expired_events || 0));
  return {
    grant_id: grantId,
    units_granted: Number(linkedGrant.units_granted),
    vested_units: vested,
    exercised_units: exercised,
    forfeited_units: forfeited,
    expired_units: expired,
    vested_unexercised_units: Math.max(vested - exercised - forfeited - expired, 0),
    unvested_units: Math.max(Number(linkedGrant.units_granted) - vested - forfeited, 0),
  };
}

export async function calculateEmploymentEquityValue(investmentId, commonFmvPerUnit) {
  await position(investmentId);
  const fmv = number(commonFmvPerUnit, 'Common FMV per unit');
  const grants = await query(`SELECT * FROM employment_equity_grants WHERE investment_id = $1`, [investmentId]);
  if (grants.some(row => ['ppu', 'profits_interest', 'other'].includes(row.instrument_type))) {
    throw new Error('PPU, profits-interest, and other instruments require a manually confirmed valuation');
  }
  let optionIntrinsicValue = 0;
  let unvestedContingentValue = 0;
  for (const row of grants) {
    const balances = await employmentEquityGrantBalances(row.id);
    if (['iso', 'nso'].includes(row.instrument_type)) {
      const intrinsic = Math.max(fmv - Number(row.strike_price), 0);
      optionIntrinsicValue += intrinsic * balances.vested_unexercised_units;
      unvestedContingentValue += intrinsic * balances.unvested_units;
    } else if (row.instrument_type === 'rsu') {
      unvestedContingentValue += fmv * balances.unvested_units;
    }
  }
  const [owned] = await query(`
    SELECT COALESCE(SUM(units_remaining), 0) AS units
      FROM investment_lots
     WHERE investment_id = $1 AND units_remaining IS NOT NULL
       AND status IN ('active', 'partially_disposed')
  `, [investmentId]);
  const ownedShareUnits = Number(owned.units || 0);
  const ownedShareValue = fmv * ownedShareUnits;
  return {
    common_fmv_per_unit: fmv,
    option_intrinsic_value: optionIntrinsicValue,
    vested_unexercised_option_value: optionIntrinsicValue,
    owned_share_units: ownedShareUnits,
    owned_share_value: ownedShareValue,
    vested_value: optionIntrinsicValue + ownedShareValue,
    unvested_value: unvestedContingentValue,
  };
}

export async function recordEmploymentEquityValuation(investmentId, fields = {}) {
  assertUsd(fields.currency);
  return withEmploymentEquityWrite(async () => {
    await position(investmentId, { lock: true });
    const snapshotDate = isoDate(fields.date, 'Valuation date');
    const calculated = fields.vestedValue == null
      ? await calculateEmploymentEquityValue(investmentId, fields.commonFmvPerUnit)
      : null;
    const vestedValue = fields.vestedValue == null
      ? calculated.vested_value
      : number(fields.vestedValue, 'Vested value');
    const unvestedValue = fields.unvestedValue === undefined
      ? calculated?.unvested_value ?? null
      : number(fields.unvestedValue, 'Unvested value', { nullable: true });
    const [existing] = await query(`
      SELECT v.*, d.unvested_value
        FROM valuations v
        LEFT JOIN employment_equity_valuation_details d ON d.valuation_id = v.id
       WHERE v.investment_id = $1 AND v.snapshot_date = $2
    `, [investmentId, snapshotDate]);
    if (existing) {
      if (Number(existing.net_value) === vestedValue &&
          (existing.unvested_value == null ? unvestedValue == null : Number(existing.unvested_value) === unvestedValue)) {
        return { valuation: existing, calculation: calculated, idempotent_replay: true };
      }
      throw new Error('a different Employment Equity valuation already exists for this date');
    }
    const [valuation] = await query(`
      INSERT INTO valuations
        (investment_id, snapshot_date, unrealized_value, realized_value, net_value, source)
      VALUES ($1,$2,$3,0,$3,'employment_equity_manual')
      RETURNING *
    `, [investmentId, snapshotDate, vestedValue]);
    const [details] = await query(`
      INSERT INTO employment_equity_valuation_details
        (valuation_id, methodology, vested_value, unvested_value,
         common_fmv_per_unit, issuer_equity_value, hurdle_amount,
         liquidity_haircut_pct, confidence, source_document_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      valuation.id,
      fields.methodology || (calculated ? 'common_fmv' : 'manual'),
      vestedValue,
      unvestedValue,
      fields.commonFmvPerUnit == null ? null : number(fields.commonFmvPerUnit, 'Common FMV per unit'),
      number(fields.issuerEquityValue, 'Issuer equity value', { nullable: true }),
      number(fields.hurdleAmount, 'Hurdle amount', { nullable: true }),
      number(fields.liquidityHaircutPct, 'Liquidity haircut percent', { nullable: true }),
      fields.confidence || (calculated ? 'calculated' : 'estimated'),
      fields.sourceDocumentId || null,
      optionalText(fields.notes),
    ]);
    return { valuation, details, calculation: calculated, idempotent_replay: false };
  });
}

export async function addIssuerDisclosure(portfolioEntityId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const [profile] = await query(`
      SELECT portfolio_entity_id FROM employment_equity_issuer_profiles WHERE portfolio_entity_id = $1
    `, [portfolioEntityId]);
    if (!profile) throw new Error('issuer disclosure requires an Employment Equity issuer profile');
    const [row] = await query(`
      INSERT INTO issuer_disclosures
        (portfolio_entity_id, document_id, disclosure_type, received_date,
         financials_as_of_date, period_start, period_end, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [
      portfolioEntityId,
      fields.documentId,
      requiredText(fields.disclosureType, 'Disclosure type'),
      optionalDate(fields.receivedDate, 'Received date'),
      optionalDate(fields.financialsAsOfDate, 'Financials as-of date'),
      optionalDate(fields.periodStart, 'Period start'),
      optionalDate(fields.periodEnd, 'Period end'),
      optionalText(fields.notes),
    ]);
    return row;
  });
}

export async function updateEmploymentEquityPosition(investmentId, fields = {}) {
  return withEmploymentEquityWrite(async () => {
    const current = await position(investmentId, { lock: true });
    const status = fields.positionStatus === undefined ? current.position_status
      : assertEnum(fields.positionStatus, POSITION_STATUSES, 'position status');
    const [updated] = await query(`
      UPDATE employment_equity_positions
         SET display_name = $2, position_status = $3, description = $4,
             archived_at = CASE WHEN $3 = 'archived' THEN COALESCE(archived_at, NOW()) ELSE NULL END,
             updated_at = NOW()
       WHERE investment_id = $1 RETURNING *
    `, [
      investmentId,
      fields.displayName === undefined ? current.display_name : requiredText(fields.displayName, 'Position display name'),
      status,
      fields.description === undefined ? current.description : optionalText(fields.description),
    ]);
    return updated;
  });
}

export function archiveEmploymentEquityPosition(investmentId) {
  return updateEmploymentEquityPosition(investmentId, { positionStatus: 'archived' });
}

export function restoreEmploymentEquityPosition(investmentId) {
  return updateEmploymentEquityPosition(investmentId, { positionStatus: 'active' });
}

export async function employmentEquityMetrics(investmentId) {
  await position(investmentId);
  const lots = await query(`
    SELECT units_acquired, units_remaining, cash_outlay, tax_basis, compensation_basis
      FROM investment_lots WHERE investment_id = $1
        AND status IN ('active', 'partially_disposed')
  `, [investmentId]);
  const remainingBasis = key => {
    const known = lots.filter(row => row[key] != null);
    if (known.length === 0) return null;
    return known.reduce((sum, row) => {
      const ratio = row.units_acquired == null ? 1 : Number(row.units_remaining) / Number(row.units_acquired);
      return sum + Number(row[key]) * ratio;
    }, 0);
  };
  const [cash] = await query(`
    SELECT
      COALESCE(SUM(cf.amount) FILTER (WHERE e.event_type IN ('sale','tender','repurchase')), 0) AS realized_proceeds,
      COALESCE(SUM(cf.amount) FILTER (WHERE e.event_type = 'distribution'), 0) AS distributions
      FROM employment_equity_events e
      JOIN cash_flows cf ON cf.id = e.cash_flow_id
     WHERE e.investment_id = $1 AND e.voided_at IS NULL
  `, [investmentId]);
  const [valuation] = await query(`
    SELECT v.snapshot_date, d.vested_value, d.unvested_value
      FROM employment_equity_valuation_details d
      JOIN valuations v ON v.id = d.valuation_id
     WHERE v.investment_id = $1
     ORDER BY v.snapshot_date DESC, v.id DESC LIMIT 1
  `, [investmentId]);
  const taxBasis = remainingBasis('tax_basis');
  const cashOutlay = remainingBasis('cash_outlay');
  const vestedValue = valuation?.vested_value == null ? null : Number(valuation.vested_value);
  return {
    remaining_cash_outlay: cashOutlay,
    remaining_tax_basis: taxBasis,
    remaining_compensation_basis: remainingBasis('compensation_basis'),
    vested_value: vestedValue,
    unvested_contingent_value: valuation?.unvested_value == null ? null : Number(valuation.unvested_value),
    valuation_date: valuation?.snapshot_date || null,
    realized_gross_proceeds: Number(cash.realized_proceeds || 0),
    cash_distributions: Number(cash.distributions || 0),
    unrealized_gain_vs_tax_basis: vestedValue == null || taxBasis == null ? null : vestedValue - taxBasis,
    cash_on_cash_multiple: vestedValue == null || !(cashOutlay > 0)
      ? null : (vestedValue + Number(cash.realized_proceeds || 0) + Number(cash.distributions || 0)) / cashOutlay,
  };
}

export async function listEmploymentEquityPositions({ includeArchived = false } = {}) {
  const rows = await query(`
    SELECT i.id AS investment_id, i.position_key, i.invest_date, i.investment_entity,
           i.portfolio_entity_id, pe.legal_name, pe.legal_form, eep.*
      FROM employment_equity_positions eep
      JOIN investments i ON i.id = eep.investment_id
      JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
     WHERE ($1::boolean OR eep.archived_at IS NULL)
     ORDER BY LOWER(pe.legal_name), i.invest_date, i.id
  `, [includeArchived]);
  return Promise.all(rows.map(async row => ({ ...row, metrics: await employmentEquityMetrics(row.investment_id) })));
}

export async function getEmploymentEquityPosition(investmentId) {
  const rows = await listEmploymentEquityPositions({ includeArchived: true });
  const base = rows.find(row => Number(row.investment_id) === Number(investmentId));
  if (!base) return null;
  const [grants, lots, events, valuations, disclosures] = await Promise.all([
    query(`SELECT * FROM employment_equity_grants WHERE investment_id = $1 ORDER BY grant_date, id`, [investmentId]),
    query(`SELECT * FROM investment_lots WHERE investment_id = $1 ORDER BY acquisition_date, id`, [investmentId]),
    query(`SELECT * FROM employment_equity_events WHERE investment_id = $1 ORDER BY event_date DESC, created_at DESC`, [investmentId]),
    query(`
      SELECT v.*, d.methodology, d.vested_value, d.unvested_value,
             d.common_fmv_per_unit, d.confidence, d.notes AS detail_notes
        FROM valuations v JOIN employment_equity_valuation_details d ON d.valuation_id = v.id
       WHERE v.investment_id = $1 ORDER BY v.snapshot_date DESC, v.id DESC
    `, [investmentId]),
    query(`
      SELECT d.*, doc.filename, doc.confidentiality, doc.processing_policy, doc.sync_policy
        FROM issuer_disclosures d JOIN documents doc ON doc.id = d.document_id
       WHERE d.portfolio_entity_id = $1 ORDER BY d.received_date DESC NULLS LAST, d.created_at DESC
    `, [base.portfolio_entity_id]),
  ]);
  const grantsWithBalances = await Promise.all(grants.map(async row => ({
    ...row, balances: await employmentEquityGrantBalances(row.id),
  })));
  return { ...base, grants: grantsWithBalances, lots, events, valuations, disclosures };
}

export async function employmentEquitySummary() {
  const positions = await listEmploymentEquityPositions();
  const issuers = new Set(positions.map(row => row.portfolio_entity_id));
  const sumKnown = key => positions.reduce((sum, row) => sum + Number(row.metrics[key] || 0), 0);
  return {
    issuer_count: issuers.size,
    position_count: positions.length,
    remaining_cash_outlay: sumKnown('remaining_cash_outlay'),
    remaining_tax_basis: sumKnown('remaining_tax_basis'),
    remaining_compensation_basis: sumKnown('remaining_compensation_basis'),
    vested_value: sumKnown('vested_value'),
    unvested_contingent_value: sumKnown('unvested_contingent_value'),
    realized_gross_proceeds: sumKnown('realized_gross_proceeds'),
    cash_distributions: sumKnown('cash_distributions'),
  };
}
