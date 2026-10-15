import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { isPgliteActive, query, withAtomicWrite } from '../db/index.js';
import { stableValue } from '../commands/canonical.js';
import { SCHEMAS, SCHEMA_VERSION } from '../../packages/earned-equity-core/schema.mjs';

// Prospective Earned Equity records. Nothing here touches investments, lots or
// the grant ledger: accepting an offer is a decision record only.

export class EarnedEquityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EarnedEquityError';
    this.code = code;
    this.details = details;
  }
}

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = {
  decisionGroup: ajv.compile(SCHEMAS.decisionGroup),
  opportunity: ajv.compile(SCHEMAS.opportunity),
  offerRevision: ajv.compile(SCHEMAS.offerRevision),
  scenarioSet: ajv.compile(SCHEMAS.scenarioSet),
  decisionRecord: ajv.compile(SCHEMAS.decisionRecord),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

// Error text names schema paths only, never submitted values (compensation terms).
function validate(kind, payload, label) {
  const check = validators[kind];
  if (!check(payload)) {
    const paths = [...new Set(check.errors.map(error => `${error.instancePath || '/'} ${error.message}`))].slice(0, 8);
    throw new EarnedEquityError('invalid_payload', `Invalid ${label}: ${paths.join('; ')}`, { paths });
  }
  return payload;
}

export const validateGroupPayload = payload => validate('decisionGroup', payload, 'decision group');
export const validateOfferRevisionPayload = payload => validate('offerRevision', payload, 'offer revision');
export const validateDecisionPayload = payload => validate('decisionRecord', payload, 'decision record');

function opportunityParts(payload, portfolioEntityId) {
  validate('opportunity', payload, 'opportunity');
  const inPayload = payload.portfolioEntityId ?? null;
  const entityId = portfolioEntityId === undefined ? inPayload : portfolioEntityId;
  if (entityId !== inPayload) {
    throw new EarnedEquityError('invalid_payload', 'Opportunity portfolioEntityId disagrees with the payload.');
  }
  if (entityId !== null && !UUID.test(entityId)) {
    throw new EarnedEquityError('invalid_payload', 'Invalid opportunity: portfolioEntityId must be a UUID or null');
  }
  return { stored: payload, portfolioEntityId: entityId };
}

export function validateOpportunityPayload(payload, portfolioEntityId) {
  return opportunityParts(payload, portfolioEntityId);
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function withEarnedEquityWrite(fn) {
  if (!(await isPgliteActive())) {
    throw new Error('Earned Equity writes require local PGlite transaction support');
  }
  return withAtomicWrite(fn);
}

function isUniqueViolation(error) {
  return error?.code === '23505' || /unique|duplicate key/i.test(error?.message || '');
}

// --- groups ---------------------------------------------------------------

function groupRow(row) {
  return {
    id: row.id, mode: row.mode, status: row.status, revision: row.revision,
    payload: json(row.payload), created_at: row.created_at, updated_at: row.updated_at,
  };
}

export async function getGroupRow(id) {
  const [row] = await query('SELECT * FROM earned_equity_decision_groups WHERE id = $1', [id]);
  return row ? groupRow(row) : null;
}

export async function createGroup(payload) {
  validateGroupPayload(payload);
  return withEarnedEquityWrite(async () => {
    if (await getGroupRow(payload.id)) throw new EarnedEquityError('already_exists', `Decision group already exists: ${payload.id}`);
    const [row] = await query(`
      INSERT INTO earned_equity_decision_groups (id, mode, status, revision, payload)
      VALUES ($1, $2, $3, 1, $4::jsonb) RETURNING *
    `, [payload.id, payload.mode, payload.status, JSON.stringify(payload)]);
    return groupRow(row);
  });
}

export async function updateGroup(id, expectedRevision, payload) {
  validateGroupPayload(payload);
  if (payload.id !== id) throw new EarnedEquityError('invalid_payload', 'Decision group id cannot change.');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new EarnedEquityError('invalid_payload', 'expectedRevision must be a positive integer.');
  }
  return withEarnedEquityWrite(async () => {
    const current = await getGroupRow(id);
    if (!current) throw new EarnedEquityError('not_found', `Decision group not found: ${id}`);
    if (current.mode !== payload.mode) throw new EarnedEquityError('invalid_payload', 'Decision group mode cannot change.');
    const rows = await query(`
      UPDATE earned_equity_decision_groups
         SET status = $3, payload = $4::jsonb, revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND revision = $2 RETURNING *
    `, [id, expectedRevision, payload.status, JSON.stringify(payload)]);
    if (!rows.length) {
      throw new EarnedEquityError('stale_revision', `Decision group is at revision ${current.revision}, not ${expectedRevision}.`,
        { currentRevision: current.revision });
    }
    return groupRow(rows[0]);
  });
}

// --- opportunities ----------------------------------------------------------

function opportunityRow(row) {
  return {
    ...json(row.payload), portfolioEntityId: row.portfolio_entity_id ?? null, revision: row.revision,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

export async function getOpportunityRow(id) {
  const [row] = await query('SELECT * FROM earned_equity_opportunities WHERE id = $1', [id]);
  return row ? opportunityRow(row) : null;
}

async function assertEntity(portfolioEntityId) {
  if (portfolioEntityId === null) return;
  const [entity] = await query('SELECT id FROM portfolio_entities WHERE id = $1', [portfolioEntityId]);
  if (!entity) throw new EarnedEquityError('not_found', 'Portfolio entity not found.');
}

export async function createOpportunity(payload, portfolioEntityId) {
  const { stored, portfolioEntityId: entityId } = opportunityParts(payload, portfolioEntityId);
  return withEarnedEquityWrite(async () => {
    const group = await getGroupRow(stored.groupId);
    if (!group) throw new EarnedEquityError('not_found', `Decision group not found: ${stored.groupId}`);
    await assertEntity(entityId);
    if (await getOpportunityRow(stored.id)) throw new EarnedEquityError('already_exists', `Opportunity already exists: ${stored.id}`);
    const [row] = await query(`
      INSERT INTO earned_equity_opportunities (id, group_id, portfolio_entity_id, relationship, lifecycle, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *
    `, [stored.id, stored.groupId, entityId, stored.relationship, stored.lifecycle, JSON.stringify(stored)]);
    return opportunityRow(row);
  });
}

export async function updateOpportunity(id, expectedRevision, payload, portfolioEntityId) {
  const { stored, portfolioEntityId: entityId } = opportunityParts(payload, portfolioEntityId);
  if (stored.id !== id) throw new EarnedEquityError('invalid_payload', 'Opportunity id cannot change.');
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new EarnedEquityError('invalid_payload', 'expectedRevision must be a positive integer.');
  }
  return withEarnedEquityWrite(async () => {
    const [current] = await query('SELECT * FROM earned_equity_opportunities WHERE id = $1', [id]);
    if (!current) throw new EarnedEquityError('not_found', `Opportunity not found: ${id}`);
    if (current.group_id !== stored.groupId) throw new EarnedEquityError('invalid_payload', 'Opportunity group cannot change.');
    if (current.relationship !== stored.relationship) throw new EarnedEquityError('invalid_payload', 'Opportunity relationship cannot change.');
    await assertEntity(entityId);
    const rows = await query(`
      UPDATE earned_equity_opportunities
         SET portfolio_entity_id = $3, lifecycle = $4, payload = $5::jsonb, revision = revision + 1, updated_at = NOW()
       WHERE id = $1 AND revision = $2 RETURNING *
    `, [id, expectedRevision, entityId, stored.lifecycle, JSON.stringify(stored)]);
    if (!rows.length) {
      throw new EarnedEquityError('stale_revision', `Opportunity is at revision ${current.revision}, not ${expectedRevision}.`,
        { currentRevision: current.revision });
    }
    return opportunityRow(rows[0]);
  });
}

// --- offer revisions ----------------------------------------------------------

function revisionRow(row) {
  return {
    id: row.id, opportunityId: row.opportunity_id, supersedesRevisionId: row.supersedes_revision_id,
    asOfDate: row.as_of_date, status: row.status, payload: json(row.payload),
    payloadSha256: row.payload_sha256, created_at: row.created_at,
  };
}

const REVISION_COLUMNS = `id, opportunity_id, supersedes_revision_id, as_of_date::text AS as_of_date,
  status, payload, payload_sha256, created_at`;

export async function headRevisionId(opportunityId) {
  const [row] = await query(`
    SELECT r.id FROM earned_equity_offer_revisions r
     WHERE r.opportunity_id = $1
       AND NOT EXISTS (SELECT 1 FROM earned_equity_offer_revisions s WHERE s.supersedes_revision_id = r.id)
  `, [opportunityId]);
  return row ? row.id : null;
}

export async function getOfferRevisionHistory(opportunityId) {
  const rows = await query(`SELECT ${REVISION_COLUMNS} FROM earned_equity_offer_revisions WHERE opportunity_id = $1 ORDER BY seq`, [opportunityId]);
  return rows.map(revisionRow);
}

export async function addOfferRevision(payload) {
  validateOfferRevisionPayload(payload);
  return withEarnedEquityWrite(async () => {
    const opportunity = await getOpportunityRow(payload.opportunityId);
    if (!opportunity) throw new EarnedEquityError('not_found', `Opportunity not found: ${payload.opportunityId}`);
    const [existing] = await query('SELECT id FROM earned_equity_offer_revisions WHERE id = $1', [payload.id]);
    if (existing) throw new EarnedEquityError('already_exists', `Offer revision already exists: ${payload.id}`);
    const head = await headRevisionId(payload.opportunityId);
    if ((payload.supersedesRevisionId ?? null) !== head) {
      throw new EarnedEquityError('stale_revision', 'The offer changed since it was reviewed; supersedesRevisionId must be the current head revision.',
        { headRevisionId: head });
    }
    try {
      const [row] = await query(`
        INSERT INTO earned_equity_offer_revisions
          (id, opportunity_id, supersedes_revision_id, as_of_date, status, payload, payload_sha256)
        VALUES ($1, $2, $3, $4::date, $5, $6::jsonb, $7)
        RETURNING ${REVISION_COLUMNS}
      `, [payload.id, payload.opportunityId, payload.supersedesRevisionId, payload.asOfDate, payload.status,
        JSON.stringify(payload), sha256(payload)]);
      return revisionRow(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new EarnedEquityError('stale_revision', 'Another revision already supersedes this head.');
      throw error;
    }
  });
}

// --- snapshots ------------------------------------------------------------------

function snapshotRow(row, stale = null) {
  return {
    id: row.id, offerRevisionId: row.offer_revision_id, scenarioSet: json(row.scenario_set),
    result: json(row.result), calculatorVersion: row.calculator_version, schemaVersion: row.schema_version,
    inputHash: row.input_hash, companyAssessmentRef: row.company_assessment_ref,
    benchmark: row.benchmark == null ? null : json(row.benchmark), created_at: row.created_at,
    ...(stale === null ? {} : { stale }),
  };
}

export function validateSnapshotInput(fields) {
  const { offerRevisionId, scenarioSet, result, calculatorVersion, inputHash } = fields || {};
  validate('scenarioSet', scenarioSet, 'scenario set');
  if (typeof offerRevisionId !== 'string' || !offerRevisionId || scenarioSet.offerRevisionId !== offerRevisionId) {
    throw new EarnedEquityError('invalid_payload', 'The scenario set must belong to the offer revision.');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new EarnedEquityError('invalid_payload', 'Snapshot result must be an object.');
  if (typeof calculatorVersion !== 'string' || !calculatorVersion) throw new EarnedEquityError('invalid_payload', 'calculatorVersion is required.');
  if (typeof inputHash !== 'string' || !SHA256.test(inputHash)) throw new EarnedEquityError('invalid_payload', 'inputHash must be a SHA-256 hex digest.');
  if (fields.benchmark != null && (typeof fields.benchmark !== 'object' || Array.isArray(fields.benchmark))) {
    throw new EarnedEquityError('invalid_payload', 'benchmark must be an object or null.');
  }
  if (fields.companyAssessmentRef != null && typeof fields.companyAssessmentRef !== 'string') {
    throw new EarnedEquityError('invalid_payload', 'companyAssessmentRef must be text or null.');
  }
}

export async function recordAnalysisSnapshot(fields) {
  validateSnapshotInput(fields);
  return withEarnedEquityWrite(async () => {
    const [revision] = await query('SELECT id FROM earned_equity_offer_revisions WHERE id = $1', [fields.offerRevisionId]);
    if (!revision) throw new EarnedEquityError('not_found', `Offer revision not found: ${fields.offerRevisionId}`);
    const [existing] = await query('SELECT * FROM earned_equity_analysis_snapshots WHERE offer_revision_id = $1 AND input_hash = $2',
      [fields.offerRevisionId, fields.inputHash]);
    if (existing) return { snapshot: snapshotRow(existing), idempotent: true };
    const [row] = await query(`
      INSERT INTO earned_equity_analysis_snapshots
        (id, offer_revision_id, scenario_set, result, calculator_version, schema_version, input_hash, company_assessment_ref, benchmark)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9::jsonb) RETURNING *
    `, [fields.id || randomUUID(), fields.offerRevisionId, JSON.stringify(fields.scenarioSet), JSON.stringify(fields.result),
      fields.calculatorVersion, SCHEMA_VERSION, fields.inputHash, fields.companyAssessmentRef ?? null,
      fields.benchmark == null ? null : JSON.stringify(fields.benchmark)]);
    return { snapshot: snapshotRow(row), idempotent: false };
  });
}

// --- decisions ------------------------------------------------------------------

function decisionRow(row) {
  return { id: row.id, groupId: row.group_id, payload: json(row.payload), decided_at: row.decided_at };
}

export async function latestDecision(groupId) {
  const [row] = await query('SELECT * FROM earned_equity_decisions WHERE group_id = $1 ORDER BY seq DESC LIMIT 1', [groupId]);
  return row ? decisionRow(row) : null;
}

// Structural and cross-record rules that need no database reads.
export function checkDecisionShape(payload) {
  const selected = payload.selectedOfferRevisionIds;
  if (new Set(selected).size !== selected.length) throw new EarnedEquityError('invalid_decision', 'An offer revision is selected twice.');
  if (payload.outcome === 'selected' && selected.length === 0) {
    throw new EarnedEquityError('invalid_decision', 'Outcome "selected" requires at least one selected offer revision.');
  }
  if (payload.outcome !== 'selected' && selected.length > 0) {
    throw new EarnedEquityError('invalid_decision', `Outcome "${payload.outcome}" cannot select an offer revision.`);
  }
  if (payload.gates.participation === 'learning_led_user_choice' && !payload.learningJudgment) {
    throw new EarnedEquityError('learning_judgment_required', 'A learning-led choice needs the user\'s learning judgment; Radar never infers it.');
  }
}

export async function recordDecision(payload) {
  validateDecisionPayload(payload);
  checkDecisionShape(payload);
  return withEarnedEquityWrite(async () => {
    const group = await getGroupRow(payload.groupId);
    if (!group) throw new EarnedEquityError('not_found', `Decision group not found: ${payload.groupId}`);
    const [duplicate] = await query('SELECT id FROM earned_equity_decisions WHERE id = $1', [payload.id]);
    if (duplicate) throw new EarnedEquityError('already_exists', `Decision already exists: ${payload.id}`);

    const selected = payload.selectedOfferRevisionIds;
    if (selected.length) {
      const rows = await query(`
        SELECT r.id, r.opportunity_id, o.group_id,
               EXISTS (SELECT 1 FROM earned_equity_offer_revisions s WHERE s.supersedes_revision_id = r.id) AS superseded
          FROM earned_equity_offer_revisions r
          JOIN earned_equity_opportunities o ON o.id = r.opportunity_id
         WHERE r.id = ANY($1::text[])
      `, [selected]);
      const byId = new Map(rows.map(row => [row.id, row]));
      for (const revisionId of selected) {
        const row = byId.get(revisionId);
        if (!row || row.group_id !== payload.groupId) {
          throw new EarnedEquityError('invalid_decision', `Selected offer revision does not belong to the group: ${revisionId}`);
        }
        if (row.superseded) throw new EarnedEquityError('invalid_decision', `Selected offer revision has been superseded: ${revisionId}`);
      }
      const opportunities = rows.map(row => row.opportunity_id);
      if (new Set(opportunities).size !== opportunities.length) {
        throw new EarnedEquityError('invalid_decision', 'Two revisions of the same opportunity cannot both be selected.');
      }
      if (group.mode === 'employment' && opportunities.length > 1) {
        throw new EarnedEquityError('invalid_decision', 'An employment group selects at most one opportunity.');
      }
    }
    if (payload.comparedSnapshotIds.length) {
      const rows = await query(`
        SELECT s.id, o.group_id FROM earned_equity_analysis_snapshots s
          JOIN earned_equity_offer_revisions r ON r.id = s.offer_revision_id
          JOIN earned_equity_opportunities o ON o.id = r.opportunity_id
         WHERE s.id = ANY($1::text[])
      `, [payload.comparedSnapshotIds]);
      const ok = new Set(rows.filter(row => row.group_id === payload.groupId).map(row => row.id));
      for (const snapshotId of payload.comparedSnapshotIds) {
        if (!ok.has(snapshotId)) throw new EarnedEquityError('invalid_decision', `Compared snapshot does not belong to the group: ${snapshotId}`);
      }
    }
    const [row] = await query(`
      INSERT INTO earned_equity_decisions (id, group_id, payload) VALUES ($1, $2, $3::jsonb) RETURNING *
    `, [payload.id, payload.groupId, JSON.stringify(payload)]);
    return decisionRow(row);
  });
}

// --- reads ------------------------------------------------------------------------

export async function listGroups({ status = null } = {}) {
  const rows = await query(`
    SELECT * FROM earned_equity_decision_groups
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at, id
  `, [status]);
  return rows.map(groupRow);
}

export async function getGroup(id) {
  const group = await getGroupRow(id);
  if (!group) return null;
  const opportunities = [];
  for (const row of await query('SELECT * FROM earned_equity_opportunities WHERE group_id = $1 ORDER BY created_at, id', [id])) {
    const revisions = await getOfferRevisionHistory(row.id);
    const superseded = new Set(revisions.map(revision => revision.supersedesRevisionId).filter(Boolean));
    const head = revisions.find(revision => !superseded.has(revision.id)) || null;
    opportunities.push({ ...opportunityRow(row), headRevision: head, revisions });
  }
  // A snapshot is stale when its revision is no longer its opportunity's head.
  const snapshots = (await query(`
    SELECT s.*, EXISTS (SELECT 1 FROM earned_equity_offer_revisions n WHERE n.supersedes_revision_id = s.offer_revision_id) AS stale
      FROM earned_equity_analysis_snapshots s
      JOIN earned_equity_offer_revisions r ON r.id = s.offer_revision_id
      JOIN earned_equity_opportunities o ON o.id = r.opportunity_id
     WHERE o.group_id = $1 ORDER BY s.seq
  `, [id])).map(row => snapshotRow(row, row.stale === true));
  return { ...group, opportunities, snapshots, latestDecision: await latestDecision(id) };
}

// --- purge ------------------------------------------------------------------------

// Deliberate removal of a private offer tree. The append-only triggers allow
// deletes only while this transaction-local flag is on.
async function withMaintenance(fn) {
  return withEarnedEquityWrite(async () => {
    await query(`SELECT set_config('radar.earned_equity_maintenance', 'on', true)`);
    try {
      return await fn();
    } finally {
      await query(`SELECT set_config('radar.earned_equity_maintenance', 'off', true)`);
    }
  });
}

async function purgeOpportunityRows(groupId, opportunityIds) {
  const revisions = (await query('SELECT id FROM earned_equity_offer_revisions WHERE opportunity_id = ANY($1::text[])', [opportunityIds])).map(row => row.id);
  const snapshots = (await query('SELECT id FROM earned_equity_analysis_snapshots WHERE offer_revision_id = ANY($1::text[])', [revisions])).map(row => row.id);
  const revisionSet = new Set(revisions);
  const snapshotSet = new Set(snapshots);
  // A decision that selects or compared anything being removed would dangle.
  let decisions = 0;
  for (const row of await query('SELECT id, payload FROM earned_equity_decisions WHERE group_id = $1', [groupId])) {
    const payload = json(row.payload);
    if (payload.selectedOfferRevisionIds.some(id => revisionSet.has(id)) || payload.comparedSnapshotIds.some(id => snapshotSet.has(id))) {
      await query('DELETE FROM earned_equity_decisions WHERE id = $1', [row.id]);
      decisions += 1;
    }
  }
  await query('DELETE FROM earned_equity_analysis_snapshots WHERE offer_revision_id = ANY($1::text[])', [revisions]);
  await query('DELETE FROM earned_equity_offer_revisions WHERE opportunity_id = ANY($1::text[])', [opportunityIds]);
  await query('DELETE FROM earned_equity_opportunities WHERE id = ANY($1::text[])', [opportunityIds]);
  return { opportunities: opportunityIds.length, revisions: revisions.length, snapshots: snapshots.length, decisions };
}

export async function purgeEarnedEquityOpportunity(id) {
  return withMaintenance(async () => {
    const [row] = await query('SELECT group_id FROM earned_equity_opportunities WHERE id = $1', [id]);
    if (!row) throw new EarnedEquityError('not_found', `Opportunity not found: ${id}`);
    return purgeOpportunityRows(row.group_id, [id]);
  });
}

export async function purgeEarnedEquityGroup(id) {
  return withMaintenance(async () => {
    if (!(await getGroupRow(id))) throw new EarnedEquityError('not_found', `Decision group not found: ${id}`);
    const ids = (await query('SELECT id FROM earned_equity_opportunities WHERE group_id = $1', [id])).map(row => row.id);
    const counts = await purgeOpportunityRows(id, ids);
    const rest = await query('DELETE FROM earned_equity_decisions WHERE group_id = $1 RETURNING id', [id]);
    await query('DELETE FROM earned_equity_decision_groups WHERE id = $1', [id]);
    return { ...counts, decisions: counts.decisions + rest.length, group: 1 };
  });
}
