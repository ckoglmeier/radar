// Document model — provenance artifacts + pending-intake staging.
// See docs/INTAKE_BUILD_PLAN.md ("Commit contract & artifact lifecycle" and
// "Provenance attachment matrix") in radar-app for the authoritative spec.
//
// Content is stored as BYTEA: initially raw, then optionally as a verified,
// lossless single-file ZIP after processing. The public API here takes and
// returns the original Buffer regardless of storage encoding.

import { randomUUID, createHash } from 'crypto';
import { isPgliteActive, query } from '../db/index.js';
import { createDocumentArchive, openDocumentArchive } from './document-archive.js';

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
const CONTENT_ENCODING_IDENTITY = 'identity';
const CONTENT_ENCODING_ZIP = 'zip-deflate-v1';
export const DEFAULT_COMPACTION_MIN_SAVINGS_RATIO = 0.10;

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
       content, stored_size_bytes, confidentiality, processing_policy, sync_policy)
    VALUES ($1, $2::text, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id, entity_type, entity_id, filename, mime, sha256, source,
              size_bytes, stored_size_bytes, content_encoding, archive_sha256,
              compaction_checked_at, compacted_at, confidentiality,
              processing_policy, sync_policy, created_at
  `, [
    entity_type, entity_id, filename, mime ?? null, computedSha, source,
    buf.length, buf, buf.length, confidentiality, processing_policy, sync_policy,
  ]);
  return rows[0];
}

// Metadata only — never returns content.
export async function listDocuments(entity_type, entity_id) {
  return query(`
    SELECT id, filename, mime, sha256, source, size_bytes, stored_size_bytes,
           content_encoding, archive_sha256, compaction_checked_at, compacted_at,
           confidentiality, processing_policy, sync_policy, created_at
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
           size_bytes, stored_size_bytes, content_encoding, archive_sha256,
           compaction_checked_at, compacted_at, confidentiality,
           processing_policy, sync_policy, created_at
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

  const [stored] = await query(`
    SELECT content, content_encoding, archive_sha256, stored_size_bytes
      FROM documents
     WHERE id = $1
  `, [documentId]);
  if (!stored) return null;

  const persisted = toBuffer(stored.content);
  const recordedStoredSize = stored.stored_size_bytes == null
    ? persisted.length
    : Number(stored.stored_size_bytes);
  if (recordedStoredSize !== persisted.length) {
    throw new Error(`document ${documentId} stored-size verification failed`);
  }

  let content;
  if (stored.content_encoding === CONTENT_ENCODING_IDENTITY) {
    content = persisted;
  } else if (stored.content_encoding === CONTENT_ENCODING_ZIP) {
    const archiveSha = createHash('sha256').update(persisted).digest('hex');
    if (!stored.archive_sha256 || archiveSha !== stored.archive_sha256) {
      throw new Error(`document ${documentId} archive sha256 verification failed`);
    }
    content = openDocumentArchive(persisted);
  } else {
    throw new Error(`document ${documentId} has unsupported content encoding: ${stored.content_encoding}`);
  }

  if (content.length !== Number(metadata.size_bytes)
    || createHash('sha256').update(content).digest('hex') !== metadata.sha256) {
    throw new Error(`document ${documentId} original sha256 or size verification failed`);
  }

  // A processing read is the lifecycle signal that the canonical upload has
  // been consumed. Compaction is best-effort and never blocks that consumer;
  // compactDocument remains public so maintenance jobs can retry explicitly.
  if (stored.content_encoding === CONTENT_ENCODING_IDENTITY
    && metadata.compaction_checked_at == null
    && ['model', 'local_processing'].includes(purpose)) {
    try {
      await compactDocument(documentId, { originalContent: content });
    } catch {
      // Preserve the verified original and allow the processing operation to
      // continue. A later maintenance pass may retry the compaction.
    }
  }

  return { ...metadata, content };
}

// Replace raw evidence bytes with a verified, lossless single-file ZIP only
// when doing so clears the configured savings threshold. The original hash and
// byte count remain canonical; concurrent attempts are resolved atomically by
// the UPDATE predicate.
export async function compactDocument(documentId, {
  minSavingsRatio = DEFAULT_COMPACTION_MIN_SAVINGS_RATIO,
  originalContent = null,
  forceRecheck = false,
} = {}) {
  if (!Number.isFinite(minSavingsRatio) || minSavingsRatio < 0 || minSavingsRatio >= 1) {
    throw new TypeError('minSavingsRatio must be at least 0 and less than 1');
  }

  const [row] = await query(`
    SELECT id, filename, sha256, size_bytes, content, content_encoding,
           archive_sha256, stored_size_bytes, compaction_checked_at, compacted_at
      FROM documents
     WHERE id = $1
  `, [documentId]);
  if (!row) return null;
  if (row.content_encoding !== CONTENT_ENCODING_IDENTITY) {
    return {
      document_id: row.id,
      status: 'already_compacted',
      original_size_bytes: Number(row.size_bytes),
      stored_size_bytes: Number(row.stored_size_bytes),
    };
  }
  if (row.compaction_checked_at && !forceRecheck) {
    return {
      document_id: row.id,
      status: 'previously_skipped',
      original_size_bytes: Number(row.size_bytes),
      stored_size_bytes: Number(row.stored_size_bytes),
    };
  }

  const original = originalContent == null ? toBuffer(row.content) : toBuffer(originalContent);
  if (original.length !== Number(row.size_bytes)
    || createHash('sha256').update(original).digest('hex') !== row.sha256) {
    throw new Error(`document ${documentId} cannot be compacted: original verification failed`);
  }

  const archive = createDocumentArchive(original, row.filename);
  const restored = openDocumentArchive(archive);
  if (restored.length !== original.length
    || createHash('sha256').update(restored).digest('hex') !== row.sha256) {
    throw new Error(`document ${documentId} cannot be compacted: ZIP verification failed`);
  }

  const savingsBytes = original.length - archive.length;
  const savingsRatio = original.length === 0 ? 0 : savingsBytes / original.length;
  if (savingsBytes <= 0 || savingsRatio < minSavingsRatio) {
    await query(`
      UPDATE documents
         SET compaction_checked_at = NOW(), stored_size_bytes = octet_length(content)
       WHERE id = $1 AND content_encoding = $2
    `, [documentId, CONTENT_ENCODING_IDENTITY]);
    return {
      document_id: row.id,
      status: 'skipped',
      original_size_bytes: original.length,
      stored_size_bytes: original.length,
      candidate_size_bytes: archive.length,
      savings_ratio: savingsRatio,
    };
  }

  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const updated = await query(`
    UPDATE documents
       SET content = $2,
           content_encoding = $3,
           archive_sha256 = $4,
           stored_size_bytes = $5,
           compaction_checked_at = NOW(),
           compacted_at = NOW()
     WHERE id = $1 AND content_encoding = $6
     RETURNING id
  `, [
    documentId, archive, CONTENT_ENCODING_ZIP, archiveSha256, archive.length,
    CONTENT_ENCODING_IDENTITY,
  ]);
  if (updated.length === 0) {
    return {
      document_id: row.id,
      status: 'concurrent_update',
      original_size_bytes: original.length,
      stored_size_bytes: original.length,
    };
  }
  return {
    document_id: row.id,
    status: 'compacted',
    original_size_bytes: original.length,
    stored_size_bytes: archive.length,
    savings_bytes: savingsBytes,
    savings_ratio: savingsRatio,
    archive_sha256: archiveSha256,
  };
}

// Duplicate detection for intake — metadata rows matching a content hash.
export async function findBySha(sha256) {
  return query(`
    SELECT id, entity_type, entity_id, filename, mime, sha256, source,
           size_bytes, stored_size_bytes, content_encoding, archive_sha256,
           compaction_checked_at, compacted_at, confidentiality,
           processing_policy, sync_policy, created_at
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

export async function discardPendingIntake(id) {
  const rows = await query(`
    UPDATE pending_intake
       SET content = $2,
           expires_at = LEAST(expires_at, NOW())
     WHERE id = $1 AND status = 'pending'
    RETURNING id, created_refs
  `, [id, Buffer.alloc(0)]);
  const row = rows[0];
  if (!row) return null;

  if (!row.created_refs || Object.keys(row.created_refs).length === 0) {
    await query(`DELETE FROM pending_intake WHERE id = $1 AND status = 'pending'`, [id]);
    return { id: row.id, deleted: true };
  }
  return { id: row.id, deleted: false };
}

// Desktop quit and crash-recovery cleanup must not leave preview bytes on
// disk. Progressive refs remain just long enough to diagnose a partial
// non-transactional write, but the source bytes are cleared immediately.
export async function expirePendingIntakeBytes() {
  const rows = await query(`
    UPDATE pending_intake
       SET content = $1,
           expires_at = LEAST(expires_at, NOW())
     WHERE status = 'pending'
    RETURNING id
  `, [Buffer.alloc(0)]);
  return rows.length;
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
