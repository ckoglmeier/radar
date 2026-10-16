import { createHash, randomUUID } from 'node:crypto';
import { isPgliteActive, query, withAtomicWrite } from '../db/index.js';
import {
  accessDocumentBytes, alreadyCommittedError, createDocument, createPendingIntake, getPendingIntake, markPendingCommitted,
} from './documents.js';
import { extractHtmlText, extractPdfText } from '../intake/extract-text.js';
import {
  OfferDocumentError, reviewOfferDocumentText, validateProposal,
} from '../intake/offer-documents.js';

// Persistence for Earned Equity offer-document reviews. A review row is an immutable
// PROPOSAL; its only permitted change is the guarded status transition
// (proposed -> confirmed | rejected), enforced again by a trigger in migration 085.
// Nothing here creates offer revisions, grants or positions, and nothing logs document
// text, quotes, filenames or amounts.

export { OfferDocumentError };

export const OFFER_ENTITY_TYPE = 'earned_equity_opportunity';
const OFFER_CONFIDENTIALITY = 'personal_sensitive';

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function withDocumentWrite(fn) {
  if (!(await isPgliteActive())) throw new Error('Earned Equity document writes require local PGlite transaction support');
  return withAtomicWrite(fn);
}

function reviewRow(row) {
  return {
    id: row.id, seq: Number(row.seq), opportunityId: row.opportunity_id, documentId: row.document_id,
    documentSha256: row.document_sha256, docClass: row.doc_class, extractionVersion: row.extraction_version,
    status: row.status, proposal: json(row.proposal), confirmedOfferRevisionId: row.confirmed_offer_revision_id,
    created_at: row.created_at, status_changed_at: row.status_changed_at,
  };
}

const REVIEW_COLUMNS = `seq, id, opportunity_id, document_id, document_sha256, doc_class, extraction_version, status,
  proposal, confirmed_offer_revision_id, created_at, status_changed_at`;

// --- documents ----------------------------------------------------------------------

// Offer documents are personal: personal_sensitive, and local_only unless the user opts in.
export async function attachOfferDocument({ opportunityId, filename, mime = null, content, modelAllowed = false }) {
  if (typeof filename !== 'string' || !filename) throw new OfferDocumentError('invalid_input', 'filename is required.');
  const [opportunity] = await query('SELECT id FROM earned_equity_opportunities WHERE id = $1', [opportunityId]);
  if (!opportunity) throw new OfferDocumentError('not_found', 'Opportunity not found.');
  const document = await createDocument({
    entity_type: OFFER_ENTITY_TYPE, entity_id: opportunityId, filename, mime, content,
    source: 'manual-upload', confidentiality: OFFER_CONFIDENTIALITY,
    processing_policy: modelAllowed === true ? 'model_allowed' : 'local_only',
  });
  return document;
}

// Bytes reach the database through staging (the File Vault pattern) so a command carries only the
// staged id: file bytes, names and text never enter command proposals or receipts.
export const OFFER_STAGING_TYPE = 'earned_equity_offer_document';

export async function stageOfferDocument({ filename, mime = null, content }) {
  if (typeof filename !== 'string' || !filename) throw new OfferDocumentError('invalid_input', 'filename is required.');
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.length === 0) throw new OfferDocumentError('invalid_input', 'Choose a document to upload.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return createPendingIntake({ filename, mime, sha256, content: bytes, preview: { type: OFFER_STAGING_TYPE, sha256 } });
}

const DOCUMENT_META = `id, entity_type, entity_id, sha256, size_bytes, confidentiality, processing_policy, sync_policy`;

// Attaches a staged document to an opportunity (personal_sensitive, local_only processing). A retry
// of an already-committed staging id replays the same document.
export async function attachOfferDocumentFromPending({ previewId, opportunityId }) {
  return withDocumentWrite(async () => {
    const pending = await getPendingIntake(previewId);
    if (!pending || pending.preview?.type !== OFFER_STAGING_TYPE) throw new OfferDocumentError('not_found', 'The staged upload is missing or expired.');
    if (pending.status === 'committed') {
      const [doc] = await query(`SELECT ${DOCUMENT_META} FROM documents WHERE id = $1`, [pending.created_refs?.document_id ?? null]);
      if (!doc || doc.entity_type !== OFFER_ENTITY_TYPE || doc.entity_id !== opportunityId) {
        throw new OfferDocumentError('already_committed', 'This staged upload was already attached elsewhere.');
      }
      return { document: doc, idempotent_replay: true };
    }
    const created = await attachOfferDocument({ opportunityId, filename: pending.filename, mime: pending.mime, content: pending.content, modelAllowed: false });
    if (!await markPendingCommitted(previewId, { document_id: created.id, opportunity_id: opportunityId })) throw alreadyCommittedError(previewId);
    const [doc] = await query(`SELECT ${DOCUMENT_META} FROM documents WHERE id = $1`, [created.id]);
    return { document: doc, idempotent_replay: false };
  });
}

// Explicit consent is the only way a document becomes readable by a model.
export async function setOfferDocumentModelConsent({ documentId, allowed, userConfirmed }) {
  if (userConfirmed !== true) throw new OfferDocumentError('consent_required', 'Model access requires explicit user consent.');
  if (typeof allowed !== 'boolean') throw new OfferDocumentError('invalid_input', 'allowed must be a boolean.');
  const rows = await query(`
    UPDATE documents SET processing_policy = $2
     WHERE id = $1 AND entity_type = $3
    RETURNING id, processing_policy
  `, [documentId, allowed ? 'model_allowed' : 'local_only', OFFER_ENTITY_TYPE]);
  if (!rows.length) throw new OfferDocumentError('not_found', 'Offer document not found.');
  return rows[0];
}

// Text out of the stored bytes. Unreadable input is reported as a failure, never as empty text.
export async function extractOfferDocumentText({ content, mime = '', filename = '' }) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const lowerMime = String(mime || '').toLowerCase();
  const lowerName = String(filename || '').toLowerCase();
  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    const text = await extractPdfText(buf);
    if (!text) return { text: null, failure: { code: 'pdf_text_unavailable', message: 'No text layer could be read from this PDF. It may be a scan that needs OCR.' } };
    return { text, failure: null };
  }
  const raw = buf.toString('utf-8');
  if (raw.includes('�') || (raw.match(/[\x00-\x08\x0E-\x1F]/g) || []).length / Math.max(raw.length, 1) > 0.02) {
    return { text: null, failure: { code: 'unreadable_binary', message: 'This file is not readable text and its format is not supported.' } };
  }
  const looksHtml = lowerMime === 'text/html' || lowerName.endsWith('.html') || lowerName.endsWith('.htm') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(raw);
  return { text: looksHtml ? extractHtmlText(raw) : raw, failure: null };
}

function assertOfferDocument(meta) {
  if (!meta || meta.entity_type !== OFFER_ENTITY_TYPE) throw new OfferDocumentError('not_found', 'Offer document not found.');
}

// purpose 'model' enforces processing_policy in the engine (accessDocumentBytes denies unless model_allowed).
export async function loadOfferDocumentText({ documentId, purpose = 'local_processing', executionMode = 'desktop' }) {
  if (!['local_processing', 'model'].includes(purpose)) throw new TypeError(`invalid purpose: ${purpose}`);
  const doc = await accessDocumentBytes({ documentId, purpose, executionMode });
  assertOfferDocument(doc);
  const { text, failure } = await extractOfferDocumentText({ content: doc.content, mime: doc.mime, filename: doc.filename });
  return {
    document: {
      id: doc.id, opportunityId: doc.entity_id, sha256: doc.sha256, mime: doc.mime,
      confidentiality: doc.confidentiality, processingPolicy: doc.processing_policy,
    },
    text, extractionFailure: failure,
  };
}

// Deterministic pass over a stored document. `text` is returned for an optional in-memory AI
// pass by the caller; it is never persisted by this module.
export async function analyzeOfferDocument({ documentId, executionMode = 'desktop' }) {
  const loaded = await loadOfferDocumentText({ documentId, purpose: 'local_processing', executionMode });
  const proposal = reviewOfferDocumentText({
    text: loaded.text, documentSha256: loaded.document.sha256, documentId: loaded.document.id,
    extractionFailure: loaded.extractionFailure,
  });
  return { document: loaded.document, text: loaded.text, proposal };
}

// --- reviews ------------------------------------------------------------------------

export async function recordDocumentReview({ opportunityId, documentId, proposal }) {
  validateProposal(proposal);
  const [doc] = await query('SELECT id, sha256, entity_type, entity_id FROM documents WHERE id = $1', [documentId]);
  if (!doc || doc.entity_type !== OFFER_ENTITY_TYPE || doc.entity_id !== opportunityId) {
    throw new OfferDocumentError('not_found', 'The document is not attached to this opportunity.');
  }
  if (doc.sha256 !== proposal.documentSha256) {
    throw new OfferDocumentError('hash_mismatch', 'The proposal was built from different document bytes.');
  }
  const status = proposal.failure ? 'failed' : 'proposed';
  const [row] = await query(`
    INSERT INTO earned_equity_document_reviews
      (id, opportunity_id, document_id, document_sha256, doc_class, extraction_version, status, proposal)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    RETURNING ${REVIEW_COLUMNS}
  `, [randomUUID(), opportunityId, documentId, doc.sha256, proposal.docClass, proposal.extractionVersion, status, JSON.stringify(proposal)]);
  return reviewRow(row);
}

export async function getDocumentReview(id) {
  const [row] = await query(`SELECT ${REVIEW_COLUMNS} FROM earned_equity_document_reviews WHERE id = $1`, [id]);
  return row ? reviewRow(row) : null;
}

export async function listDocumentReviews(opportunityId, { documentId = null, status = null } = {}) {
  const rows = await query(`
    SELECT ${REVIEW_COLUMNS} FROM earned_equity_document_reviews
     WHERE opportunity_id = $1 AND ($2::int IS NULL OR document_id = $2::int) AND ($3::text IS NULL OR status = $3)
     ORDER BY seq
  `, [opportunityId, documentId, status]);
  return rows.map(reviewRow);
}

// proposed -> confirmed, recorded after the user's approval produced an offer revision.
export async function confirmDocumentReview({ id, offerRevisionId }) {
  const [revision] = await query('SELECT id, opportunity_id FROM earned_equity_offer_revisions WHERE id = $1', [offerRevisionId]);
  const review = await getDocumentReview(id);
  if (!review) throw new OfferDocumentError('not_found', 'Document review not found.');
  if (!revision || revision.opportunity_id !== review.opportunityId) {
    throw new OfferDocumentError('invalid_input', 'The offer revision does not belong to this review’s opportunity.');
  }
  const rows = await query(`
    UPDATE earned_equity_document_reviews
       SET status = 'confirmed', confirmed_offer_revision_id = $2, status_changed_at = NOW()
     WHERE id = $1 AND status = 'proposed'
    RETURNING ${REVIEW_COLUMNS}
  `, [id, offerRevisionId]);
  if (!rows.length) throw new OfferDocumentError('invalid_transition', `A ${review.status} review cannot be confirmed.`);
  return reviewRow(rows[0]);
}

export async function rejectDocumentReview(id) {
  const review = await getDocumentReview(id);
  if (!review) throw new OfferDocumentError('not_found', 'Document review not found.');
  const rows = await query(`
    UPDATE earned_equity_document_reviews
       SET status = 'rejected', status_changed_at = NOW()
     WHERE id = $1 AND status = 'proposed'
    RETURNING ${REVIEW_COLUMNS}
  `, [id]);
  if (!rows.length) throw new OfferDocumentError('invalid_transition', `A ${review.status} review cannot be rejected.`);
  return reviewRow(rows[0]);
}

// --- purge --------------------------------------------------------------------------

// Deletes the reviews and the attached document bytes for an opportunity. Call it BEFORE
// the opportunity/offer-revision purge (reviews reference both). It nests inside an outer
// atomic write and restores the maintenance flag it found, so an outer purge keeps its own.
export async function purgeEarnedEquityDocumentsForOpportunity(opportunityId) {
  return withDocumentWrite(async () => {
    const [before] = await query(`SELECT current_setting('radar.earned_equity_maintenance', true) AS value`);
    await query(`SELECT set_config('radar.earned_equity_maintenance', 'on', true)`);
    try {
      const reviews = await query('DELETE FROM earned_equity_document_reviews WHERE opportunity_id = $1 RETURNING id', [opportunityId]);
      const documents = await query('DELETE FROM documents WHERE entity_type = $1 AND entity_id = $2::text RETURNING id', [OFFER_ENTITY_TYPE, opportunityId]);
      return { reviews: reviews.length, documents: documents.length };
    } finally {
      await query(`SELECT set_config('radar.earned_equity_maintenance', $1, true)`, [before?.value || 'off']);
    }
  });
}
