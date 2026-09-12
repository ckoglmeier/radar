// DocumentStore — the only interface intake (and any future caller outside
// the model layer) should use to touch provenance documents. Wraps
// src/models/documents.js so the storage strategy can change behind this
// seam without callers changing: BYTEA-in-Postgres holds either original
// bytes or Radar's verified lossless ZIP representation. The Desktop shell
// can later slot a filesystem or object-storage strategy behind this same
// interface. intakeCommit/intakePreview call DocumentStore, not
// models/documents.js, for document (not pending_intake) operations.
//
// pending_intake staging (createPendingIntake/getPendingIntake/
// markPendingCommitted/updatePendingRefs/sweepExpiredPending) is intake's
// own preview->confirm protocol state, not a "document" — it stays a direct
// models/documents.js import in src/intake/index.js rather than routed
// through this interface.

import {
  createDocument,
  accessDocumentBytes,
  compactDocument,
  listDocuments,
  findBySha,
} from '../models/documents.js';

export const DocumentStore = {
  // Creates a provenance document. See models/documents.js#createDocument for
  // the full contract (entity existence check, sha256 verification, 10MB cap).
  put(args) {
    return createDocument(args);
  },
  // Full row including content, policy-gated by declared purpose and mode.
  get(documentId, { purpose, executionMode }) {
    return accessDocumentBytes({ documentId, purpose, executionMode });
  },
  // Losslessly replace raw bytes with a verified ZIP when the archive clears
  // Radar's savings threshold. Returns a status; never changes provenance.
  compact(documentId, options) {
    return compactDocument(documentId, options);
  },
  // Metadata only (never content) for an entity_type + entity_id.
  list(entityType, entityId) {
    return listDocuments(entityType, entityId);
  },
  // Duplicate detection — metadata rows matching a content hash.
  findBySha(sha256) {
    return findBySha(sha256);
  },
};
