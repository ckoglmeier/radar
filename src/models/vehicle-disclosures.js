import { query, withAtomicWrite } from '../db/index.js';
import {
  createIdentityReviewReceipt,
  resolveCanonicalEntityId,
} from './canonical-identity.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRESENCE = new Set(['undetermined', 'not_provided', 'explicitly_none', 'provided']);
const COMPLETENESS = new Set(['partial', 'complete', 'unknown']);
const EXTRACTION = new Set(['not_attempted', 'succeeded', 'failed', 'needs_review']);
const REVIEW = new Set(['needs_review', 'accepted', 'rejected', 'superseded']);
const RESOLUTION = new Set(['unresolved', 'provisional', 'confirmed', 'rejected']);
const HOLDING_STATUS = new Set(['active', 'realized', 'unknown']);
const CONFIDENCE = new Set(['confirmed', 'reported', 'calculated', 'estimated', 'unknown']);
const CONFIDENTIALITY = new Set(['standard', 'confidential_company', 'tax_sensitive']);
const PROCESSING = new Set(['local_only', 'model_allowed']);
const SYNC = new Set(['local_only', 'encrypted_backup_allowed']);

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalText(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

function assertUuid(value, label) {
  if (!UUID_PATTERN.test(String(value || ''))) throw new TypeError(`${label} must be a UUID`);
  return String(value);
}

function assertEnum(value, allowed, label) {
  const text = requiredText(value, label);
  if (!allowed.has(text)) throw new TypeError(`invalid ${label}: ${text}`);
  return text;
}

function isoDate(value, label, { nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  const text = requiredText(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new TypeError(`${label} must be an ISO date (YYYY-MM-DD)`);
  }
  return text;
}

function number(value, label, { nullable = true, min = null, max = null } = {}) {
  if (nullable && (value == null || value === '')) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a number`);
  if (min != null && parsed < min) throw new TypeError(`${label} must be at least ${min}`);
  if (max != null && parsed > max) throw new TypeError(`${label} must be at most ${max}`);
  return parsed;
}

function moneyFields(value, fields, label) {
  const amount = number(value, label);
  if (amount == null) {
    return { amount: null, currency: null, unitScale: null, basis: null, effectiveDate: null };
  }
  return {
    amount,
    currency: requiredText(fields.currency, `${label} currency`).toUpperCase(),
    unitScale: requiredText(fields.unitScale, `${label} unit scale`),
    basis: requiredText(fields.basis, `${label} basis`),
    effectiveDate: isoDate(fields.effectiveDate, `${label} effective date`, { nullable: true }),
  };
}

export function localPolicyContext(overrides = {}) {
  return {
    workspaceId: 'local',
    actor: 'local_user',
    purpose: 'portfolio_display',
    allowConfidential: true,
    allowModel: false,
    allowExport: false,
    allowBackup: false,
    ...overrides,
  };
}

export function policyAllows(row, context) {
  if (!context || !context.workspaceId || !context.actor || !context.purpose) {
    throw new TypeError('policy-aware read context is required');
  }
  if (row.confidentiality !== 'standard' && !context.allowConfidential) return false;
  if (row.processing_policy === 'local_only' && (context.allowModel || context.purpose === 'model')) return false;
  if (row.sync_policy === 'local_only' && (context.allowExport || context.allowBackup)) return false;
  return true;
}

async function vehicleEntity(vehicleEntityId) {
  assertUuid(vehicleEntityId, 'Vehicle Entity ID');
  const [row] = await query(`
    SELECT pe.*, ie.investing_entity_kind
      FROM portfolio_entities pe
      JOIN investing_entities ie ON ie.entity_id = pe.id
     WHERE pe.id = $1
  `, [vehicleEntityId]);
  if (!row || !['spv', 'fund_vehicle'].includes(row.investing_entity_kind)) {
    throw new Error('vehicle disclosure requires a reviewed SPV or Fund Investing Entity');
  }
  return row;
}

function disclosureState(fields) {
  const presence = assertEnum(fields.disclosurePresence || 'undetermined', PRESENCE, 'disclosure presence');
  const completeness = fields.holdingsCompleteness == null
    ? null
    : assertEnum(fields.holdingsCompleteness, COMPLETENESS, 'holdings completeness');
  const extraction = assertEnum(fields.extractionStatus || 'not_attempted', EXTRACTION, 'extraction status');
  const review = assertEnum(fields.reviewState || 'needs_review', REVIEW, 'review state');
  if (presence === 'provided' && completeness == null) {
    throw new TypeError('provided holdings require completeness: partial, complete, or unknown');
  }
  if (presence !== 'provided' && completeness != null) {
    throw new TypeError('holdings completeness is only valid when disclosure presence is provided');
  }
  if (review === 'accepted' && presence === 'undetermined') {
    throw new TypeError('undetermined disclosure cannot be accepted');
  }
  return { presence, completeness, extraction, review };
}

export async function createVehiclePortfolioSnapshot(fields = {}) {
  const vehicleEntityId = assertUuid(fields.vehicleEntityId, 'Vehicle Entity ID');
  const sourceReceiptNamespace = requiredText(fields.sourceReceiptNamespace, 'Source receipt namespace');
  const sourceReceiptId = requiredText(fields.sourceReceiptId, 'Source receipt ID');
  const boundaryKind = requiredText(fields.boundaryKind, 'Disclosure boundary kind');
  const boundaryLocator = requiredText(fields.boundaryLocator, 'Disclosure boundary locator');
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  const state = disclosureState(fields);
  const total = moneyFields(fields.reportedTotalPortfolioValue, {
    currency: fields.reportedValueCurrency,
    unitScale: fields.reportedValueUnitScale,
    basis: fields.reportedValueBasis,
    effectiveDate: fields.reportedValueEffectiveDate,
  }, 'Reported total portfolio value');
  const policy = {
    confidentiality: assertEnum(fields.confidentiality || 'confidential_company', CONFIDENTIALITY, 'confidentiality'),
    processingPolicy: assertEnum(fields.processingPolicy || 'local_only', PROCESSING, 'processing policy'),
    syncPolicy: assertEnum(fields.syncPolicy || 'encrypted_backup_allowed', SYNC, 'sync policy'),
  };
  await vehicleEntity(vehicleEntityId);

  return withAtomicWrite(async () => {
    const [existing] = await query(`
      SELECT * FROM vehicle_portfolio_snapshots
       WHERE source_receipt_namespace = $1 AND source_receipt_id = $2
         AND boundary_kind = $3 AND boundary_locator = $4
    `, [sourceReceiptNamespace, sourceReceiptId, boundaryKind, boundaryLocator]);
    if (existing) {
      if (existing.vehicle_entity_id !== vehicleEntityId || existing.source_hash !== sourceHash) {
        throw new Error('vehicle snapshot source receipt conflicts with another disclosure');
      }
      return { snapshot: existing, idempotent_replay: true };
    }
    const [snapshot] = await query(`
      INSERT INTO vehicle_portfolio_snapshots
        (vehicle_entity_id, source_receipt_namespace, source_receipt_id,
         boundary_kind, boundary_locator, source_document_id, source_hash,
         as_of_date, received_date, disclosure_presence, holdings_completeness,
         extraction_status, review_state, reported_holding_count,
         reported_total_portfolio_value, reported_value_currency,
         reported_value_unit_scale, reported_value_basis,
         reported_value_effective_date, confidentiality, processing_policy,
         sync_policy, supersedes_snapshot_id, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
              $19,$20,$21,$22,$23,$24,$25)
      RETURNING *
    `, [
      vehicleEntityId,
      sourceReceiptNamespace,
      sourceReceiptId,
      boundaryKind,
      boundaryLocator,
      fields.sourceDocumentId || null,
      sourceHash,
      isoDate(fields.asOfDate, 'As-of date', { nullable: true }),
      isoDate(fields.receivedDate, 'Received date'),
      state.presence,
      state.completeness,
      state.extraction,
      state.review,
      fields.reportedHoldingCount == null ? null : number(fields.reportedHoldingCount, 'Reported holding count', { min: 0 }),
      total.amount,
      total.currency,
      total.unitScale,
      total.basis,
      total.effectiveDate,
      policy.confidentiality,
      policy.processingPolicy,
      policy.syncPolicy,
      fields.supersedesSnapshotId ? assertUuid(fields.supersedesSnapshotId, 'Superseded snapshot ID') : null,
      state.review === 'accepted' ? requiredText(fields.reviewedBy, 'Reviewer') : null,
      state.review === 'accepted' ? new Date() : null,
    ]);
    return { snapshot, idempotent_replay: false };
  });
}

export async function reviewVehiclePortfolioSnapshot(snapshotId, fields = {}) {
  assertUuid(snapshotId, 'Snapshot ID');
  const state = disclosureState({ ...fields, reviewState: fields.reviewState || 'accepted' });
  if (!['accepted', 'rejected'].includes(state.review)) {
    throw new TypeError('snapshot review must accept or reject the interpretation');
  }
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  return withAtomicWrite(async () => {
    const [before] = await query(`
      SELECT * FROM vehicle_portfolio_snapshots WHERE id = $1 FOR UPDATE
    `, [snapshotId]);
    if (!before) throw new Error(`vehicle snapshot not found: ${snapshotId}`);
    if (['accepted', 'rejected', 'superseded'].includes(before.review_state)) {
      if (
        before.review_state === state.review &&
        before.disclosure_presence === state.presence &&
        before.holdings_completeness === state.completeness &&
        before.extraction_status === state.extraction
      ) return { snapshot: before, idempotent_replay: true };
      throw new Error('reviewed vehicle snapshot interpretation is terminal');
    }
    const [snapshot] = await query(`
      UPDATE vehicle_portfolio_snapshots
         SET disclosure_presence = $2, holdings_completeness = $3,
             extraction_status = $4, review_state = $5,
             reviewed_by = $6, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [snapshotId, state.presence, state.completeness, state.extraction, state.review, reviewedBy]);
    return { snapshot, idempotent_replay: false };
  });
}

export async function recordVehiclePortfolioDisclosure(fields = {}) {
  const claims = Array.isArray(fields.claims) ? fields.claims : [];
  return withAtomicWrite(async () => {
    const result = await createVehiclePortfolioSnapshot({
      ...fields,
      reviewState: fields.disclosurePresence === 'provided' ? 'needs_review' : 'accepted',
    });
    const recordedClaims = [];
    for (const claim of claims) {
      recordedClaims.push((await appendVehicleExposureClaim(result.snapshot.id, claim)).claim);
    }
    let snapshot = result.snapshot;
    if (fields.disclosurePresence === 'provided') {
      snapshot = (await reviewVehiclePortfolioSnapshot(snapshot.id, {
        disclosurePresence: fields.disclosurePresence,
        holdingsCompleteness: fields.holdingsCompleteness,
        extractionStatus: fields.extractionStatus || 'succeeded',
        reviewState: 'accepted',
        reviewedBy: fields.reviewedBy || 'local_user',
      })).snapshot;
    }
    return {
      snapshot,
      claims: recordedClaims,
      idempotent_replay: result.idempotent_replay,
    };
  });
}

export async function appendVehicleExposureClaim(snapshotId, fields = {}) {
  assertUuid(snapshotId, 'Snapshot ID');
  const sourceClaimId = requiredText(fields.sourceClaimId, 'Source claim ID');
  const rawTargetName = requiredText(fields.rawTargetName, 'Raw target name');
  const holdingStatus = assertEnum(fields.holdingStatus || 'unknown', HOLDING_STATUS, 'holding status');
  const confidence = assertEnum(fields.confidence || 'reported', CONFIDENCE, 'confidence');
  const value = moneyFields(fields.reportedValue, {
    currency: fields.valueCurrency,
    unitScale: fields.valueUnitScale,
    basis: fields.valueBasis,
    effectiveDate: fields.valueEffectiveDate,
  }, 'Reported holding value');
  const cost = moneyFields(fields.reportedCost, {
    currency: fields.costCurrency,
    unitScale: fields.costUnitScale,
    basis: fields.costBasis,
    effectiveDate: fields.costEffectiveDate,
  }, 'Reported holding cost');
  return withAtomicWrite(async () => {
    const [snapshot] = await query(`
      SELECT * FROM vehicle_portfolio_snapshots WHERE id = $1 FOR UPDATE
    `, [snapshotId]);
    if (!snapshot) throw new Error(`vehicle snapshot not found: ${snapshotId}`);
    if (snapshot.disclosure_presence !== 'provided') {
      throw new Error('exposure claims require disclosure presence provided');
    }
    const [existing] = await query(`
      SELECT * FROM vehicle_exposure_claims
       WHERE snapshot_id = $1 AND source_claim_id = $2
    `, [snapshotId, sourceClaimId]);
    if (existing) {
      if (existing.raw_target_name !== rawTargetName) {
        throw new Error('vehicle exposure source claim ID conflicts with another raw target');
      }
      return { claim: existing, idempotent_replay: true };
    }
    const [claim] = await query(`
      INSERT INTO vehicle_exposure_claims
        (snapshot_id, source_claim_id, raw_target_name, holding_status,
         stage, security, reported_cost, cost_currency, cost_unit_scale,
         cost_basis, cost_effective_date, ownership_percentage, units,
         reported_value, value_currency, value_unit_scale, value_basis,
         value_effective_date, source_citation, confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
              $17,$18,$19,$20)
      RETURNING *
    `, [
      snapshotId,
      sourceClaimId,
      rawTargetName,
      holdingStatus,
      optionalText(fields.stage),
      optionalText(fields.security),
      cost.amount,
      cost.currency,
      cost.unitScale,
      cost.basis,
      cost.effectiveDate,
      number(fields.ownershipPercentage, 'Ownership percentage', { min: 0, max: 1 }),
      number(fields.units, 'Units'),
      value.amount,
      value.currency,
      value.unitScale,
      value.basis,
      value.effectiveDate,
      optionalText(fields.sourceCitation),
      confidence,
    ]);
    return { claim, idempotent_replay: false };
  });
}

export async function resolveVehicleExposureClaim(claimId, fields = {}) {
  assertUuid(claimId, 'Exposure claim ID');
  const status = assertEnum(fields.resolutionStatus, RESOLUTION, 'resolution status');
  if (!['provisional', 'confirmed', 'rejected'].includes(status)) {
    throw new TypeError('review must confirm, provisionally resolve, or reject the exposure identity');
  }
  const targetEntityId = status === 'rejected'
    ? null
    : assertUuid(fields.targetEntityId, 'Target Entity ID');
  const reviewedBy = requiredText(fields.reviewedBy || 'local_user', 'Reviewer');
  const sourceHash = requiredText(fields.sourceHash, 'Source hash');
  return withAtomicWrite(async () => {
    const [claim] = await query(`SELECT * FROM vehicle_exposure_claims WHERE id = $1 FOR UPDATE`, [claimId]);
    if (!claim) throw new Error(`vehicle exposure claim not found: ${claimId}`);
    const canonicalTargetId = targetEntityId ? await resolveCanonicalEntityId(targetEntityId) : null;
    if (canonicalTargetId) {
      const [target] = await query(`SELECT id FROM portfolio_entities WHERE id = $1`, [canonicalTargetId]);
      if (!target) throw new Error('target Entity does not exist');
    }
    const receipt = await createIdentityReviewReceipt({
      subjectType: 'exposure',
      subjectId: claimId,
      action: 'resolve_vehicle_exposure',
      decision: { resolutionStatus: status, targetEntityId: canonicalTargetId },
      sourceHash,
      idempotencyKey: fields.idempotencyKey,
      reviewedBy,
    });
    const [updated] = await query(`
      UPDATE vehicle_exposure_claims
         SET target_entity_id = $2, resolution_status = $3,
             reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *
    `, [claimId, canonicalTargetId, status, reviewedBy]);
    return { claim: updated, ...receipt };
  });
}

export async function vehiclePortfolioRecord(vehicleEntityId, context) {
  const canonicalId = await resolveCanonicalEntityId(vehicleEntityId);
  await vehicleEntity(canonicalId);
  const snapshots = await query(`
    SELECT * FROM vehicle_portfolio_snapshots
     WHERE vehicle_entity_id = $1
     ORDER BY effective_snapshot_date DESC, created_at DESC, id
  `, [canonicalId]);
  const visibleSnapshots = snapshots.filter(row => policyAllows(row, context));
  if (visibleSnapshots.length === 0) return { vehicle_entity_id: canonicalId, snapshots: [] };
  const claims = await query(`
    SELECT vec.*, pe.legal_name AS target_legal_name,
           pe.identity_status AS target_identity_status
      FROM vehicle_exposure_claims vec
      LEFT JOIN portfolio_entities pe ON pe.id = vec.target_entity_id
      JOIN vehicle_portfolio_snapshots vps ON vps.id = vec.snapshot_id
     WHERE vps.vehicle_entity_id = $1
     ORDER BY vec.snapshot_id, vec.source_claim_id
  `, [canonicalId]);
  return {
    vehicle_entity_id: canonicalId,
    snapshots: visibleSnapshots.map(snapshot => ({
      ...snapshot,
      claims: claims.filter(claim => claim.snapshot_id === snapshot.id),
    })),
  };
}

export async function companyIndirectExposureRecord(companyEntityId, context) {
  const canonicalId = await resolveCanonicalEntityId(companyEntityId);
  const rows = await query(`
    SELECT vec.*, vps.vehicle_entity_id, vps.effective_snapshot_date,
           vps.disclosure_presence, vps.holdings_completeness,
           vps.confidentiality, vps.processing_policy, vps.sync_policy,
           pe.legal_name AS vehicle_name, ie.investing_entity_kind
      FROM vehicle_exposure_claims vec
      JOIN vehicle_portfolio_snapshots vps ON vps.id = vec.snapshot_id
      JOIN portfolio_entities pe ON pe.id = vps.vehicle_entity_id
      JOIN investing_entities ie ON ie.entity_id = vps.vehicle_entity_id
     WHERE vec.target_entity_id = $1
       AND vec.resolution_status IN ('provisional', 'confirmed')
       AND vps.review_state = 'accepted'
     ORDER BY vps.effective_snapshot_date DESC, pe.legal_name, vec.source_claim_id
  `, [canonicalId]);
  return rows.filter(row => policyAllows(row, context));
}
