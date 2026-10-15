import { randomUUID } from 'node:crypto';
import { isPgliteActive, query, withAtomicWrite } from '../db/index.js';

// Earned Equity company reviews (company-scoped, reusable across offers) and offer
// reviews (personal, per offer revision). Neither touches pipeline_invites,
// council_runs, deal_evaluations, ad_hoc_reviews or council_followups.
//
// Lifecycle: begin -> (running) -> complete | fail. A completed artifact is
// immutable (database trigger). Follow-ups are new rows linked by parent id.

export class EarnedEquityReviewError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EarnedEquityReviewError';
    this.code = code;
    this.details = details;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPANY_KINDS = ['initial', 'refresh', 'followup'];
const OFFER_KINDS = ['initial', 'followup'];
const GATES = ['supported', 'failed', 'unresolved'];

const json = value => (typeof value === 'string' ? JSON.parse(value) : value);
const isUnique = error => error?.code === '23505' || /unique|duplicate key/i.test(error?.message || '');

async function withReviewWrite(fn) {
  if (!(await isPgliteActive())) throw new Error('Earned Equity review writes require local PGlite transaction support');
  return withAtomicWrite(fn);
}

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new EarnedEquityReviewError('invalid_input', `${label} is required`);
  }
  return value.trim();
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new EarnedEquityReviewError('invalid_input', `${label} must be a sha256 hex string`);
  return value;
}

function companyRow(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq), id: row.id, portfolioEntityId: row.portfolio_entity_id, parentReviewId: row.parent_review_id,
    reviewKind: row.review_kind, lensId: row.lens_id, lensVersion: row.lens_version, policyVersion: row.policy_version,
    instructionHash: row.instruction_hash, sourceManifestHash: row.source_manifest_hash, runKey: row.run_key,
    status: row.status, stage: row.stage, artifact: row.artifact == null ? null : json(row.artifact),
    errorCode: row.error_code, usage: row.usage == null ? null : json(row.usage),
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function offerRow(row) {
  if (!row) return null;
  return {
    seq: Number(row.seq), id: row.id, offerRevisionId: row.offer_revision_id, companyReviewId: row.company_review_id,
    snapshotId: row.snapshot_id, parentReviewId: row.parent_review_id, reviewKind: row.review_kind, runKey: row.run_key,
    status: row.status, artifact: row.artifact == null ? null : json(row.artifact),
    errorCode: row.error_code, usage: row.usage == null ? null : json(row.usage),
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

// --- company reviews ----------------------------------------------------------------

export async function getCompanyReview(id) {
  const [row] = await query('SELECT * FROM earned_equity_company_reviews WHERE id = $1', [id]);
  return companyRow(row);
}

export async function findCompanyReviewByRunKey(runKey) {
  const [row] = await query('SELECT * FROM earned_equity_company_reviews WHERE run_key = $1', [requireHash(runKey, 'runKey')]);
  return companyRow(row);
}

/** A completed review with this run key, or null. This is the reuse lookup. */
export async function findCompletedCompanyReview(runKey) {
  const found = await findCompanyReviewByRunKey(runKey);
  return found?.status === 'completed' ? found : null;
}

export async function listCompanyReviews(portfolioEntityId) {
  const rows = await query('SELECT * FROM earned_equity_company_reviews WHERE portfolio_entity_id = $1 ORDER BY seq', [portfolioEntityId]);
  return rows.map(companyRow);
}

export async function latestCompletedCompanyReview(portfolioEntityId) {
  const [row] = await query(
    `SELECT * FROM earned_equity_company_reviews WHERE portfolio_entity_id = $1 AND status = 'completed' ORDER BY seq DESC LIMIT 1`,
    [portfolioEntityId],
  );
  return companyRow(row);
}

/** The follow-up chain from a review back to its root, oldest first. */
export async function companyReviewChain(id) {
  const chain = [];
  let cursor = await getCompanyReview(id);
  while (cursor) {
    chain.unshift(cursor);
    cursor = cursor.parentReviewId ? await getCompanyReview(cursor.parentReviewId) : null;
  }
  return chain;
}

/**
 * Claim a company review. Returns { state, review }:
 *  - reused: a completed review with this run key exists (no model call needed)
 *  - running: the same run is already in progress
 *  - restarted: a failed run with this key was reset to running
 *  - started: a new running review was created
 * Another running review for the same company raises review_in_progress.
 */
export async function beginCompanyReview(input) {
  const portfolioEntityId = requireText(input?.portfolioEntityId, 'portfolioEntityId', 64);
  if (!UUID.test(portfolioEntityId)) throw new EarnedEquityReviewError('invalid_input', 'portfolioEntityId must be a UUID');
  const reviewKind = input.reviewKind || 'initial';
  if (!COMPANY_KINDS.includes(reviewKind)) throw new EarnedEquityReviewError('invalid_input', `Unknown review kind: ${reviewKind}`);
  const parentReviewId = input.parentReviewId || null;
  if ((reviewKind === 'followup') !== (parentReviewId !== null)) {
    throw new EarnedEquityReviewError('invalid_input', 'Only a follow-up review has a parent, and a follow-up requires one');
  }
  const fields = {
    lensId: requireText(input.lensId, 'lensId'),
    lensVersion: requireText(String(input.lensVersion ?? ''), 'lensVersion'),
    policyVersion: requireText(String(input.policyVersion ?? ''), 'policyVersion'),
    instructionHash: requireHash(input.instructionHash, 'instructionHash'),
    sourceManifestHash: requireHash(input.sourceManifestHash, 'sourceManifestHash'),
    runKey: requireHash(input.runKey, 'runKey'),
  };
  return withReviewWrite(async () => {
    const existing = await findCompanyReviewByRunKey(fields.runKey);
    if (existing) {
      if (existing.portfolioEntityId !== portfolioEntityId) {
        throw new EarnedEquityReviewError('run_key_conflict', 'That run key belongs to another company');
      }
      if (existing.status === 'completed') return { state: 'reused', review: existing };
      if (existing.status === 'running') return { state: 'running', review: existing };
      try {
        await query(
          `UPDATE earned_equity_company_reviews SET status = 'running', stage = 'queued', error_code = NULL WHERE id = $1`,
          [existing.id],
        );
      } catch (error) {
        if (isUnique(error)) throw new EarnedEquityReviewError('review_in_progress', 'Another review of this company is already running');
        throw error;
      }
      return { state: 'restarted', review: await getCompanyReview(existing.id) };
    }
    if (parentReviewId) {
      const parent = await getCompanyReview(parentReviewId);
      if (!parent || parent.status !== 'completed') throw new EarnedEquityReviewError('invalid_parent', 'A follow-up needs a completed parent review');
      if (parent.portfolioEntityId !== portfolioEntityId) throw new EarnedEquityReviewError('invalid_parent', 'A follow-up must review the same company as its parent');
    }
    const [active] = await query(
      `SELECT id FROM earned_equity_company_reviews WHERE portfolio_entity_id = $1 AND status = 'running'`,
      [portfolioEntityId],
    );
    if (active) throw new EarnedEquityReviewError('review_in_progress', 'Another review of this company is already running');
    const id = input.id || randomUUID();
    try {
      await query(
        `INSERT INTO earned_equity_company_reviews
           (id, portfolio_entity_id, parent_review_id, review_kind, lens_id, lens_version, policy_version,
            instruction_hash, source_manifest_hash, run_key, status, stage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running', 'queued')`,
        [id, portfolioEntityId, parentReviewId, reviewKind, fields.lensId, fields.lensVersion, fields.policyVersion,
          fields.instructionHash, fields.sourceManifestHash, fields.runKey],
      );
    } catch (error) {
      if (isUnique(error)) throw new EarnedEquityReviewError('review_in_progress', 'Another review of this company is already running');
      throw error;
    }
    return { state: 'started', review: await getCompanyReview(id) };
  });
}

export async function setCompanyReviewStage(id, stage) {
  const rows = await query(
    `UPDATE earned_equity_company_reviews SET stage = $2 WHERE id = $1 AND status = 'running' RETURNING id`,
    [id, requireText(stage, 'stage', 64)],
  );
  if (!rows.length) throw new EarnedEquityReviewError('not_running', 'The review is not running');
}

function checkCompanyArtifact(artifact, row) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new EarnedEquityReviewError('invalid_artifact', 'Artifact must be an object');
  if (artifact.reviewMode !== 'earned_equity_company') throw new EarnedEquityReviewError('invalid_artifact', 'Artifact is not an Earned Equity company review');
  if (!GATES.includes(artifact.gate?.status)) throw new EarnedEquityReviewError('invalid_artifact', 'Artifact has no valid business gate');
  if (artifact.provenance?.runKey !== row.run_key) throw new EarnedEquityReviewError('invalid_artifact', 'Artifact run key does not match the review');
  if (artifact.company?.portfolioEntityId !== row.portfolio_entity_id) throw new EarnedEquityReviewError('invalid_artifact', 'Artifact company does not match the review');
}

export async function completeCompanyReview(id, { artifact, usage = null } = {}) {
  return withReviewWrite(async () => {
    const [row] = await query('SELECT * FROM earned_equity_company_reviews WHERE id = $1', [id]);
    if (!row) throw new EarnedEquityReviewError('not_found', 'Review not found');
    if (row.status !== 'running') throw new EarnedEquityReviewError('not_running', 'Only a running review can be completed');
    checkCompanyArtifact(artifact, row);
    await query(
      `UPDATE earned_equity_company_reviews
          SET status = 'completed', stage = 'completed', artifact = $2::jsonb, usage = $3::jsonb, error_code = NULL, completed_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(artifact), usage == null ? null : JSON.stringify(usage)],
    );
    return getCompanyReview(id);
  });
}

export async function failCompanyReview(id, { errorCode = 'review_failed', usage = null } = {}) {
  const rows = await query(
    `UPDATE earned_equity_company_reviews SET status = 'failed', error_code = $2, usage = $3::jsonb
      WHERE id = $1 AND status = 'running' RETURNING id`,
    [id, String(errorCode).slice(0, 80), usage == null ? null : JSON.stringify(usage)],
  );
  return rows.length > 0;
}

// --- offer reviews --------------------------------------------------------------------

export async function getOfferReview(id) {
  const [row] = await query('SELECT * FROM earned_equity_offer_reviews WHERE id = $1', [id]);
  return offerRow(row);
}

export async function findOfferReviewByRunKey(runKey) {
  const [row] = await query('SELECT * FROM earned_equity_offer_reviews WHERE run_key = $1', [requireHash(runKey, 'runKey')]);
  return offerRow(row);
}

export async function findCompletedOfferReview(runKey) {
  const found = await findOfferReviewByRunKey(runKey);
  return found?.status === 'completed' ? found : null;
}

export async function listOfferReviews(offerRevisionId) {
  const rows = await query('SELECT * FROM earned_equity_offer_reviews WHERE offer_revision_id = $1 ORDER BY seq', [offerRevisionId]);
  return rows.map(offerRow);
}

/** Same states as beginCompanyReview. An offer review is per offer revision. */
export async function beginOfferReview(input) {
  const offerRevisionId = requireText(input?.offerRevisionId, 'offerRevisionId', 128);
  const reviewKind = input.reviewKind || 'initial';
  if (!OFFER_KINDS.includes(reviewKind)) throw new EarnedEquityReviewError('invalid_input', `Unknown review kind: ${reviewKind}`);
  const parentReviewId = input.parentReviewId || null;
  if ((reviewKind === 'followup') !== (parentReviewId !== null)) {
    throw new EarnedEquityReviewError('invalid_input', 'Only a follow-up review has a parent, and a follow-up requires one');
  }
  const runKey = requireHash(input.runKey, 'runKey');
  const companyReviewId = input.companyReviewId || null;
  const snapshotId = input.snapshotId || null;
  return withReviewWrite(async () => {
    const existing = await findOfferReviewByRunKey(runKey);
    if (existing) {
      if (existing.offerRevisionId !== offerRevisionId) throw new EarnedEquityReviewError('run_key_conflict', 'That run key belongs to another offer');
      if (existing.status === 'completed') return { state: 'reused', review: existing };
      if (existing.status === 'running') return { state: 'running', review: existing };
      await query(`UPDATE earned_equity_offer_reviews SET status = 'running', error_code = NULL WHERE id = $1`, [existing.id]);
      return { state: 'restarted', review: await getOfferReview(existing.id) };
    }
    const [revision] = await query('SELECT id FROM earned_equity_offer_revisions WHERE id = $1', [offerRevisionId]);
    if (!revision) throw new EarnedEquityReviewError('not_found', 'Offer revision not found');
    if (snapshotId) {
      const [snapshot] = await query('SELECT offer_revision_id FROM earned_equity_analysis_snapshots WHERE id = $1', [snapshotId]);
      if (!snapshot || snapshot.offer_revision_id !== offerRevisionId) {
        throw new EarnedEquityReviewError('invalid_snapshot', 'The snapshot does not belong to this offer revision');
      }
    }
    if (companyReviewId) {
      const company = await getCompanyReview(companyReviewId);
      if (!company || company.status !== 'completed') throw new EarnedEquityReviewError('invalid_company_review', 'The company review must be completed');
    }
    if (parentReviewId) {
      const parent = await getOfferReview(parentReviewId);
      if (!parent || parent.status !== 'completed') throw new EarnedEquityReviewError('invalid_parent', 'A follow-up needs a completed parent offer review');
    }
    const id = input.id || randomUUID();
    await query(
      `INSERT INTO earned_equity_offer_reviews
         (id, offer_revision_id, company_review_id, snapshot_id, parent_review_id, review_kind, run_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')`,
      [id, offerRevisionId, companyReviewId, snapshotId, parentReviewId, reviewKind, runKey],
    );
    return { state: 'started', review: await getOfferReview(id) };
  });
}

export async function completeOfferReview(id, { artifact, usage = null } = {}) {
  return withReviewWrite(async () => {
    const [row] = await query('SELECT * FROM earned_equity_offer_reviews WHERE id = $1', [id]);
    if (!row) throw new EarnedEquityReviewError('not_found', 'Review not found');
    if (row.status !== 'running') throw new EarnedEquityReviewError('not_running', 'Only a running review can be completed');
    if (!artifact || typeof artifact !== 'object' || artifact.reviewMode !== 'earned_equity_offer') {
      throw new EarnedEquityReviewError('invalid_artifact', 'Artifact is not an Earned Equity offer review');
    }
    await query(
      `UPDATE earned_equity_offer_reviews
          SET status = 'completed', artifact = $2::jsonb, usage = $3::jsonb, error_code = NULL, completed_at = NOW()
        WHERE id = $1`,
      [id, JSON.stringify(artifact), usage == null ? null : JSON.stringify(usage)],
    );
    return getOfferReview(id);
  });
}

export async function failOfferReview(id, { errorCode = 'review_failed', usage = null } = {}) {
  const rows = await query(
    `UPDATE earned_equity_offer_reviews SET status = 'failed', error_code = $2, usage = $3::jsonb
      WHERE id = $1 AND status = 'running' RETURNING id`,
    [id, String(errorCode).slice(0, 80), usage == null ? null : JSON.stringify(usage)],
  );
  return rows.length > 0;
}

// --- purge ------------------------------------------------------------------------------

async function withMaintenance(fn) {
  return withReviewWrite(async () => {
    await query(`SELECT set_config('radar.earned_equity_maintenance', 'on', true)`);
    try {
      return await fn();
    } finally {
      await query(`SELECT set_config('radar.earned_equity_maintenance', 'off', true)`);
    }
  });
}

/**
 * Explicit company-review purge. Company reviews are not personal, so removing an
 * opportunity or group never removes them. A review that an offer review still
 * cites cannot be purged.
 */
export async function purgeCompanyReviews(portfolioEntityId) {
  return withMaintenance(async () => {
    const cited = await query(
      `SELECT DISTINCT r.id FROM earned_equity_offer_reviews o
         JOIN earned_equity_company_reviews r ON r.id = o.company_review_id
        WHERE r.portfolio_entity_id = $1`,
      [portfolioEntityId],
    );
    if (cited.length) {
      throw new EarnedEquityReviewError('in_use', 'An offer review still cites a company review for this company', { reviews: cited.length });
    }
    const rows = await query(
      'SELECT id, parent_review_id FROM earned_equity_company_reviews WHERE portfolio_entity_id = $1 ORDER BY seq DESC',
      [portfolioEntityId],
    );
    for (const row of rows) await query('DELETE FROM earned_equity_company_reviews WHERE id = $1', [row.id]);
    return { companyReviews: rows.length };
  });
}
