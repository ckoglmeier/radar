// Document model — provenance artifacts + pending-intake staging.
// See docs/INTAKE_BUILD_PLAN.md ("Commit contract & artifact lifecycle" and
// "Provenance attachment matrix") in radar-app for the authoritative spec.
//
// Content is stored as raw BYTEA (verified byte-identical round-trip on the
// PGlite driver path — see test-documents.js). The public API here takes
// and returns Buffers regardless of storage encoding.

import { randomUUID, createHash } from 'crypto';
import { isPgliteActive, query } from '../db/index.js';

export const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB cap (documents table; hosted intake's transport cap is separate, enforced in the app layer)

// Attachment matrix (docs/INTAKE_BUILD_PLAN.md): the entity_type a document
// attaches to, mapped to the table its entity_id refers to.
export const ENTITY_TABLES = {
  investment: 'investments',
  pipeline_invite: 'pipeline_invites',
  company_update: 'company_updates',
  deal_evaluation: 'deal_evaluations',
  portfolio_entity: 'portfolio_entities',
  room_holding: 'room_holdings',
  file_vault_entry: 'file_vault_entries',
};

const CONFIDENTIALITY_VALUES = new Set(['standard', 'confidential_company', 'tax_sensitive', 'personal_sensitive']);
const PROCESSING_POLICY_VALUES = new Set(['local_only', 'model_allowed']);
const SYNC_POLICY_VALUES = new Set(['local_only', 'encrypted_backup_allowed']);
const BYTE_ACCESS_PURPOSES = new Set([
  'model',
  'local_processing',
  'backup',
  'export',
  'download',
  'support',
]);
const EXECUTION_MODES = new Set(['desktop', 'hosted']);

function toBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content);
}

async function assertEntityExists(entity_type, entity_id) {
  const table = ENTITY_TABLES[entity_type];
  if (!table) {
    throw new Error(`unknown entity_type: ${entity_type}`);
  }
  const rows = await query(`SELECT 1 FROM ${table} WHERE id::text = $1::text`, [entity_id]);
  if (rows.length === 0) {
    throw new Error(`${entity_type} not found: ${entity_id}`);
  }
}

function assertPolicyValue(values, value, label) {
  if (!values.has(value)) throw new TypeError(`invalid ${label}: ${value}`);
}

function documentPolicyDenied(message) {
  const error = new Error(message);
  error.code = 'DOCUMENT_POLICY_DENIED';
  return error;
}

async function resolveExecutionMode(executionMode) {
  if (executionMode != null) {
    if (!EXECUTION_MODES.has(executionMode)) {
      throw new TypeError(`invalid executionMode: ${executionMode}`);
    }
    return executionMode;
  }
  return (await isPgliteActive()) ? 'desktop' : 'hosted';
}

async function assertLocalOnlyStorageAllowed({ processing_policy, sync_policy, executionMode }) {
  if (processing_policy !== 'local_only' && sync_policy !== 'local_only') return;
  const mode = await resolveExecutionMode(executionMode);
  if (mode !== 'desktop' || !(await isPgliteActive())) {
    throw new Error('local_only documents require a desktop PGlite workspace');
  }
}

export async function createDocument({
  entity_type,
  entity_id,
  filename,
  mime,
  sha256,
  content,
  source = 'manual-upload',
  confidentiality = 'standard',
  processing_policy = 'model_allowed',
  sync_policy = 'encrypted_backup_allowed',
  executionMode,
}) {
  assertPolicyValue(CONFIDENTIALITY_VALUES, confidentiality, 'confidentiality');
  assertPolicyValue(PROCESSING_POLICY_VALUES, processing_policy, 'processing_policy');
  assertPolicyValue(SYNC_POLICY_VALUES, sync_policy, 'sync_policy');
  await assertLocalOnlyStorageAllowed({ processing_policy, sync_policy, executionMode });
  await assertEntityExists(entity_type, entity_id);

  const buf = toBuffer(content);
  if (buf.length > MAX_SIZE_BYTES) {
    throw new Error(`document exceeds ${MAX_SIZE_BYTES} byte cap: ${buf.length} bytes`);
  }

  const computedSha = createHash('sha256').update(buf).digest('hex');
  if (sha256 && sha256 !== computedSha) {
    throw new Error(`sha256 mismatch: expected ${sha256}, computed ${computedSha}`);
  }

  const rows = await query(`
    INSERT INTO documents
      (entity_type, entity_id, filename, mime, sha256, source, size_bytes,
       content, confidentiality, processing_policy, sync_policy)
    VALUES ($1, $2::text, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id, entity_type, entity_id, filename, mime, sha256, source,
              size_bytes, confidentiality, processing_policy, sync_policy,
              created_at
  `, [
    entity_type, entity_id, filename, mime ?? null, computedSha, source,
    buf.length, buf, confidentiality, processing_policy, sync_policy,
  ]);
  return rows[0];
}

// Metadata only — never returns content.
export async function listDocuments(entity_type, entity_id) {
  return query(`
    SELECT id, filename, mime, sha256, source, size_bytes, confidentiality,
           processing_policy, sync_policy, created_at
    FROM documents
    WHERE entity_type = $1 AND entity_id = $2::text
    ORDER BY created_at DESC, id DESC
  `, [entity_type, entity_id]);
}

// The only public path to persisted document bytes. Callers must state why
// and where the read occurs; policy and attachment integrity are checked
// before content is selected.
export async function accessDocumentBytes({ documentId, purpose, executionMode }) {
  if (!BYTE_ACCESS_PURPOSES.has(purpose)) {
    throw new TypeError(`invalid document byte-access purpose: ${purpose}`);
  }
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new TypeError(`invalid executionMode: ${executionMode}`);
  }

  const rows = await query(`
    SELECT id, entity_type, entity_id, filename, mime, sha256, source,
           size_bytes, confidentiality, processing_policy, sync_policy,
           created_at
      FROM documents
     WHERE id = $1
  `, [documentId]);
  const metadata = rows[0];
  if (!metadata) return null;

  await assertEntityExists(metadata.entity_type, metadata.entity_id);

  if (executionMode === 'hosted' && metadata.sync_policy === 'local_only') {
    throw documentPolicyDenied('document policy denies hosted access to local_only bytes');
  }
  if (purpose === 'model' && metadata.processing_policy !== 'model_allowed') {
    throw documentPolicyDenied('document policy denies model access');
  }
  if (purpose === 'local_processing' && executionMode !== 'desktop') {
    throw new Error('local_processing requires desktop execution');
  }
  if (['backup', 'export', 'support'].includes(purpose) && metadata.sync_policy === 'local_only') {
    throw documentPolicyDenied(`document policy denies ${purpose} access`);
  }
  if (purpose === 'support' && metadata.confidentiality === 'tax_sensitive') {
    throw documentPolicyDenied('document policy denies support access to tax_sensitive bytes');
  }

  const contentRows = await query(`SELECT content FROM documents WHERE id = $1`, [documentId]);
  return { ...metadata, content: contentRows[0].content };
}

// Duplicate detection for intake — metadata rows matching a content hash.
export async function findBySha(sha256) {
  return query(`
    SELECT id, entity_type, entity_id, filename, mime, sha256, source,
           size_bytes, confidentiality, processing_policy, sync_policy,
           created_at
    FROM documents
    WHERE sha256 = $1
    ORDER BY created_at DESC, id DESC
  `, [sha256]);
}

// Hygiene tool: documents whose referenced row no longer exists. Parents
// are never hard-deleted in this system, so this should stay empty in
// practice; one query per entity type keeps each query simple.
export async function orphanReport() {
  const orphans = [];
  for (const [entity_type, table] of Object.entries(ENTITY_TABLES)) {
    const rows = await query(`
      SELECT d.id, d.entity_type, d.entity_id, d.filename, d.created_at
      FROM documents d
      WHERE d.entity_type = $1
        AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id::text = d.entity_id)
    `, [entity_type]);
    orphans.push(...rows);
  }
  return orphans;
}

// --- Pending intake (preview → confirm staging) ---

export async function createPendingIntake({ filename, mime, sha256, content, preview, ttlHours = 24 }) {
  const buf = toBuffer(content);
  const id = randomUUID();
  const rows = await query(`
    INSERT INTO pending_intake (id, filename, mime, sha256, size_bytes, content, preview, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW() + make_interval(hours => $8::int))
    RETURNING id, filename, mime, sha256, size_bytes, preview, status, created_refs, created_at, expires_at
  `, [id, filename ?? null, mime ?? null, sha256, buf.length, buf, JSON.stringify(preview), ttlHours]);
  return rows[0];
}

// Returns null if missing or expired.
export async function getPendingIntake(id) {
  const rows = await query(`
    SELECT * FROM pending_intake
    WHERE id = $1 AND expires_at > NOW()
  `, [id]);
  return rows[0] || null;
}

export async function markPendingCommitted(id, created_refs) {
  const rows = await query(`
    UPDATE pending_intake
    SET status = 'committed', created_refs = $2::jsonb, content = $3
    WHERE id = $1
    RETURNING *
  `, [id, JSON.stringify(created_refs), Buffer.alloc(0)]);
  return rows[0] || null;
}

// Records created_refs progressively while the row STAYS 'pending' (does not
// flip status) — used by intakeCommit's ordered-writes + progressive-refs
// recovery path on the non-transactional (Neon) driver, so a retry after a
// partial failure sees what already succeeded instead of re-creating it. See
// docs/INTAKE_BUILD_PLAN.md "Commit contract & artifact lifecycle".
export async function updatePendingRefs(id, created_refs) {
  const rows = await query(`
    UPDATE pending_intake
    SET created_refs = $2::jsonb
    WHERE id = $1
    RETURNING *
  `, [id, JSON.stringify(created_refs)]);
  return rows[0] || null;
}

// Deletes expired preview receipts in either lifecycle state. Committed rows
// retain no staging bytes, but their replay metadata expires with the receipt.
export async function sweepExpiredPending() {
  const rows = await query(`
    DELETE FROM pending_intake
    WHERE expires_at <= NOW()
    RETURNING id
  `);
  return rows.length;
}
