import { createHash, randomUUID } from 'node:crypto';
import { isPgliteActive, query, withAtomicWrite } from '../db/index.js';
import { stableValue } from '../commands/canonical.js';
import { normalize } from '../utils/company-names.js';
import {
  EarnedEquityError, latestDecision, updateOpportunity,
} from './earned-equity-opportunities.js';
import {
  addEmploymentEquityGrant, createEmploymentEquityIssuer, createEmploymentEquityIssuerProfile,
  createEmploymentEquityPosition,
} from './employment-equity.js';

// The only path from an accepted offer to a holding. It runs on an explicit,
// user-confirmed request, never as a side effect of a decision, and it never
// computes vesting: units vested are exactly what the user confirmed.
// Error text names fields only, never submitted values (compensation terms).

const INSTRUMENTS = ['iso', 'nso'];
const CADENCES = ['monthly', 'quarterly', 'annual', 'performance', 'other'];
const ACCELERATIONS = ['none', 'single_trigger', 'double_trigger', 'unknown'];
const CONFIRMED_KEYS = ['legalInstrumentName', 'instrumentType', 'grantDate', 'unitsGranted', 'strikePrice', 'expirationDate',
  'serviceStartDate', 'vesting', 'unitsVestedConfirmed', 'balanceAsOfDate', 'boardApproval', 'termsDocumentId'];
const VESTING_KEYS = ['commencementDate', 'totalMonths', 'cliffMonths', 'cadence', 'acceleration'];
const MAX_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

const invalid = message => new EarnedEquityError('invalid_payload', message);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function isoDate(value, label) {
  const date = typeof value === 'string' ? value : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw invalid(`Invalid confirmed grant: ${label} must be an ISO date`);
  }
  return date;
}

function unitsString(value, label, { allowZero }) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalid(`Invalid confirmed grant: ${label} must be an integer string`);
  const units = BigInt(value);
  if (units > MAX_UNITS || (!allowZero && units === 0n)) throw invalid(`Invalid confirmed grant: ${label} is out of range`);
  return units;
}

function monthCount(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 240) throw invalid(`Invalid confirmed grant: ${label} must be 0-240 months`);
  return value;
}

// Deterministic, factual sentence from the confirmed schedule only.
export function describeVesting(vesting) {
  const cadence = { monthly: 'monthly', quarterly: 'quarterly', annual: 'annual' }[vesting.cadence];
  const acceleration = {
    none: 'no acceleration', single_trigger: 'single-trigger acceleration',
    double_trigger: 'double-trigger acceleration', unknown: 'acceleration unknown',
  }[vesting.acceleration];
  if (vesting.totalMonths === 0) return `Vests in full on ${vesting.commencementDate}, ${acceleration}`;
  const head = cadence
    ? `${vesting.totalMonths}-month ${cadence} vesting from ${vesting.commencementDate}`
    : `${vesting.totalMonths}-month ${vesting.cadence === 'performance' ? 'performance-based' : 'custom'} vesting schedule from ${vesting.commencementDate}`;
  const cliff = vesting.cliffMonths === 0 ? 'no cliff' : `${vesting.cliffMonths}-month cliff`;
  return `${head}, ${cliff}, ${acceleration}`;
}

// Validates and normalizes the user's confirmation. Returns the stored form.
export function validateConfirmedGrant(confirmed) {
  if (!isObject(confirmed)) throw invalid('Invalid confirmed grant: an object is required');
  // Board approval and instrument are checked first so their specific codes win.
  if (confirmed.boardApproval !== 'approved') {
    throw new EarnedEquityError('grant_not_approved', 'The grant is not confirmed as board-approved; no holding is created until it is.');
  }
  if (!INSTRUMENTS.includes(confirmed.instrumentType)) {
    throw new EarnedEquityError('instrument_unsupported', 'Only ISO and NSO grants can be linked in this version.');
  }
  for (const key of Object.keys(confirmed)) if (!CONFIRMED_KEYS.includes(key)) throw invalid(`Invalid confirmed grant: unknown field ${key}`);
  if (typeof confirmed.legalInstrumentName !== 'string' || !confirmed.legalInstrumentName.trim() || confirmed.legalInstrumentName.length > 200) {
    throw invalid('Invalid confirmed grant: legalInstrumentName is required');
  }
  const grantDate = isoDate(confirmed.grantDate, 'grantDate');
  const unitsGranted = unitsString(confirmed.unitsGranted, 'unitsGranted', { allowZero: false });
  const vestedText = confirmed.unitsVestedConfirmed ?? '0';
  const unitsVested = unitsString(vestedText, 'unitsVestedConfirmed', { allowZero: true });
  if (unitsVested > unitsGranted) {
    throw new EarnedEquityError('invalid_vested_units', 'Confirmed vested units cannot exceed units granted.');
  }
  if (typeof confirmed.strikePrice !== 'string' || !/^\d+(\.\d{1,6})?$/.test(confirmed.strikePrice)) {
    throw invalid('Invalid confirmed grant: strikePrice must be a decimal string');
  }
  const expirationDate = confirmed.expirationDate == null ? null : isoDate(confirmed.expirationDate, 'expirationDate');
  if (expirationDate && expirationDate < grantDate) throw invalid('Invalid confirmed grant: expirationDate precedes grantDate');
  const serviceStartDate = confirmed.serviceStartDate == null ? null : isoDate(confirmed.serviceStartDate, 'serviceStartDate');
  const balanceAsOfDate = isoDate(confirmed.balanceAsOfDate, 'balanceAsOfDate');
  const v = confirmed.vesting;
  if (!isObject(v)) throw invalid('Invalid confirmed grant: vesting is required');
  for (const key of Object.keys(v)) if (!VESTING_KEYS.includes(key)) throw invalid(`Invalid confirmed grant: unknown vesting field ${key}`);
  const vesting = {
    commencementDate: isoDate(v.commencementDate, 'vesting.commencementDate'),
    totalMonths: monthCount(v.totalMonths, 'vesting.totalMonths'),
    cliffMonths: monthCount(v.cliffMonths, 'vesting.cliffMonths'),
    cadence: v.cadence, acceleration: v.acceleration,
  };
  if (vesting.cliffMonths > vesting.totalMonths) throw invalid('Invalid confirmed grant: cliff exceeds the vesting period');
  if (!CADENCES.includes(vesting.cadence)) throw invalid('Invalid confirmed grant: vesting.cadence is not recognised');
  if (!ACCELERATIONS.includes(vesting.acceleration)) throw invalid('Invalid confirmed grant: vesting.acceleration is not recognised');
  const termsDocumentId = confirmed.termsDocumentId ?? null;
  if (termsDocumentId !== null && (!Number.isInteger(termsDocumentId) || termsDocumentId < 1)) {
    throw invalid('Invalid confirmed grant: termsDocumentId must be a document id');
  }
  return {
    legalInstrumentName: confirmed.legalInstrumentName.trim(), instrumentType: confirmed.instrumentType, grantDate,
    unitsGranted: String(unitsGranted), strikePrice: confirmed.strikePrice, expirationDate, serviceStartDate, vesting,
    unitsVestedConfirmed: String(unitsVested), balanceAsOfDate, boardApproval: 'approved', termsDocumentId,
  };
}

export function validateLinkInput(input) {
  if (!isObject(input)) throw invalid('Invalid grant link: an object is required');
  for (const key of ['decisionId', 'offerRevisionId', 'componentId']) {
    if (typeof input[key] !== 'string' || !input[key]) throw invalid(`Invalid grant link: ${key} is required`);
  }
  if (input.existingInvestmentId != null && (!Number.isInteger(input.existingInvestmentId) || input.existingInvestmentId < 1)) {
    throw invalid('Invalid grant link: existingInvestmentId must be a position id');
  }
  if (input.legalName != null && (typeof input.legalName !== 'string' || input.legalName.length > 200)) {
    throw invalid('Invalid grant link: legalName must be text');
  }
  return validateConfirmedGrant(input.confirmed);
}

const hashOf = value => createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
const json = value => (typeof value === 'string' ? JSON.parse(value) : value);

function linkRow(row) {
  return {
    id: row.id, decisionId: row.decision_id, offerRevisionId: row.offer_revision_id, grantComponentId: row.grant_component_id,
    investmentId: Number(row.investment_id), grantId: row.grant_id, confirmedTerms: json(row.confirmed_terms), created_at: row.created_at,
  };
}

async function existingLink(offerRevisionId, componentId) {
  const [row] = await query('SELECT * FROM earned_equity_grant_links WHERE offer_revision_id = $1 AND grant_component_id = $2',
    [offerRevisionId, componentId]);
  return row ? linkRow(row) : null;
}

export async function listGrantLinks({ offerRevisionId = null, investmentId = null } = {}) {
  const rows = await query(`
    SELECT * FROM earned_equity_grant_links
     WHERE ($1::text IS NULL OR offer_revision_id = $1) AND ($2::int IS NULL OR investment_id = $2)
     ORDER BY seq
  `, [offerRevisionId, investmentId]);
  return rows.map(linkRow);
}

// Read-only facts for previews: what linking would do, without terms or amounts.
export async function inspectLinkTarget({ decisionId, offerRevisionId, componentId, existingInvestmentId = null }) {
  const [revision] = await query(`
    SELECT r.id, r.payload, o.id AS opportunity_id, o.group_id, o.portfolio_entity_id
      FROM earned_equity_offer_revisions r JOIN earned_equity_opportunities o ON o.id = r.opportunity_id
     WHERE r.id = $1`, [offerRevisionId]);
  if (!revision) throw new EarnedEquityError('not_found', `Offer revision not found: ${offerRevisionId}`);
  const link = await existingLink(offerRevisionId, componentId);
  const latest = await latestDecision(revision.group_id);
  return {
    existingLinkId: link?.id ?? null, existingInvestmentId: link?.investmentId ?? null,
    latestDecisionId: latest?.id ?? null,
    decisionSelectsRevision: Boolean(latest && latest.id === decisionId && latest.payload.outcome === 'selected'
      && latest.payload.selectedOfferRevisionIds.includes(offerRevisionId)),
    componentExists: json(revision.payload).grants.some(component => component.componentId === componentId),
    opportunityId: revision.opportunity_id, hasIssuer: revision.portfolio_entity_id !== null,
    targetPosition: existingInvestmentId,
  };
}

async function guardedTarget(opportunity, existingInvestmentId) {
  const entityId = opportunity.portfolio_entity_id;
  if (!entityId) throw new EarnedEquityError('entity_required', 'Add the grant to an existing position only after the opportunity is linked to its company.');
  const [row] = await query(`
    SELECT i.id, i.portfolio_entity_id, i.asset_class, eep.investment_id AS typed
      FROM investments i LEFT JOIN employment_equity_positions eep ON eep.investment_id = i.id
     WHERE i.id = $1`, [existingInvestmentId]);
  if (!row || row.asset_class !== 'employment_equity' || !row.typed) {
    throw new EarnedEquityError('not_found', `Earned Equity position not found: ${existingInvestmentId}`);
  }
  if (row.portfolio_entity_id !== entityId) {
    throw new EarnedEquityError('position_mismatch', 'The position belongs to a different company than this opportunity.');
  }
}

export async function linkConfirmedGrant(input) {
  const confirmed = validateLinkInput(input);
  if (!(await isPgliteActive())) throw new Error('Earned Equity writes require local PGlite transaction support');
  const { decisionId, offerRevisionId, componentId, existingInvestmentId = null, legalName = null } = input;
  return withAtomicWrite(async () => {
    // Repeat calls return the existing link; the unique constraints back this up under concurrency.
    const repeat = await existingLink(offerRevisionId, componentId);
    if (repeat) {
      return { link: repeat, created: false, positionCreated: false, issuerCreated: false, target: 'existing_link',
        termsDiffer: hashOf(repeat.confirmedTerms) !== hashOf(confirmed) };
    }
    const [revision] = await query(`
      SELECT r.id, r.payload, r.opportunity_id FROM earned_equity_offer_revisions r WHERE r.id = $1`, [offerRevisionId]);
    if (!revision) throw new EarnedEquityError('not_found', `Offer revision not found: ${offerRevisionId}`);
    const [opportunity] = await query('SELECT * FROM earned_equity_opportunities WHERE id = $1 FOR UPDATE', [revision.opportunity_id]);
    const latest = await latestDecision(opportunity.group_id);
    if (!latest || latest.id !== decisionId) {
      throw new EarnedEquityError('decision_superseded', 'This is not the latest decision for the group; record or reopen the current decision first.');
    }
    if (latest.payload.outcome !== 'selected' || !latest.payload.selectedOfferRevisionIds.includes(offerRevisionId)) {
      throw new EarnedEquityError('decision_not_selected', 'The latest decision does not select this offer revision.');
    }
    if (!json(revision.payload).grants.some(component => component.componentId === componentId)) {
      throw new EarnedEquityError('not_found', `Grant component not found in the offer revision: ${componentId}`);
    }

    const grantFields = {
      legalInstrumentName: confirmed.legalInstrumentName, instrumentType: confirmed.instrumentType, grantDate: confirmed.grantDate,
      unitsGranted: confirmed.unitsGranted, strikePrice: confirmed.strikePrice, expirationDate: confirmed.expirationDate,
      serviceStartDate: confirmed.serviceStartDate, unitsVestedConfirmed: confirmed.unitsVestedConfirmed,
      balanceAsOfDate: confirmed.balanceAsOfDate, termsDocumentId: confirmed.termsDocumentId,
      vestingTermsSummary: describeVesting(confirmed.vesting),
    };

    // An explicit position wins; otherwise a later component of the same opportunity joins its earlier position.
    let targetInvestmentId = existingInvestmentId; let target = 'explicit';
    if (targetInvestmentId === null) {
      const [prior] = await query(`
        SELECT l.investment_id FROM earned_equity_grant_links l
          JOIN earned_equity_offer_revisions r ON r.id = l.offer_revision_id
         WHERE r.opportunity_id = $1 ORDER BY l.seq LIMIT 1`, [opportunity.id]);
      if (prior) { targetInvestmentId = Number(prior.investment_id); target = 'prior_link'; }
    }
    let investmentId; let grantRow; let positionCreated = false; let issuerCreated = false;
    if (targetInvestmentId !== null) {
      await guardedTarget(opportunity, targetInvestmentId);
      grantRow = await addEmploymentEquityGrant(targetInvestmentId, grantFields);
      investmentId = targetInvestmentId;
    } else {
      target = 'new_position';
      let entityId = opportunity.portfolio_entity_id;
      if (entityId) {
        const [entity] = await query('SELECT entity_type FROM portfolio_entities WHERE id = $1', [entityId]);
        if (!entity || entity.entity_type !== 'operating_company') {
          throw new EarnedEquityError('invalid_target', 'The linked company is not an operating company.');
        }
        await createEmploymentEquityIssuerProfile(entityId, { relationshipStatus: 'other' });
      } else {
        if (typeof legalName !== 'string' || !legalName.trim()) {
          throw new EarnedEquityError('legal_name_required', 'The opportunity has no company yet; provide its legal name.');
        }
        const [clash] = await query(`SELECT id FROM portfolio_entities WHERE entity_type = 'operating_company' AND normalized_name = $1`, [normalize(legalName.trim())]);
        if (clash) throw new EarnedEquityError('issuer_exists', 'A company with this name already exists; link the opportunity to it first.');
        const created = await createEmploymentEquityIssuer({ legalName: legalName.trim(), relationshipStatus: 'other' });
        entityId = created.entity.id;
        issuerCreated = true;
        // Opportunities are mutable; the revision guard keeps this write honest.
        const payload = { ...json(opportunity.payload), portfolioEntityId: entityId };
        await updateOpportunity(opportunity.id, opportunity.revision, payload, entityId);
      }
      const [entity] = await query('SELECT legal_name FROM portfolio_entities WHERE id = $1', [entityId]);
      const made = await createEmploymentEquityPosition({
        portfolioEntityId: entityId, displayName: `${entity.legal_name} ${confirmed.instrumentType.toUpperCase()} grant`,
        instrumentFamily: confirmed.instrumentType, investDate: confirmed.grantDate,
        acquisitionOrigin: opportunity.relationship, firstGrant: grantFields,
      });
      investmentId = Number(made.investment.id);
      grantRow = made.grant;
      positionCreated = true;
    }

    const [row] = await query(`
      INSERT INTO earned_equity_grant_links
        (id, decision_id, offer_revision_id, grant_component_id, investment_id, grant_id, confirmed_terms)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *
    `, [randomUUID(), decisionId, offerRevisionId, componentId, investmentId, grantRow.id, JSON.stringify(confirmed)]);
    return { link: linkRow(row), grant: grantRow, created: true, positionCreated, issuerCreated, target, termsDiffer: false };
  });
}
