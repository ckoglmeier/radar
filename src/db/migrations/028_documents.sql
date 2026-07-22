-- Migration 028: documents + pending_intake
-- Why: Universal Intake (Tier 1) provenance foundation. See
--      docs/INTAKE_BUILD_PLAN.md ("Commit contract & artifact lifecycle" and
--      "Provenance attachment matrix").

-- documents: the original artifact behind a domain row (or a manually
-- attached file), byte-identical, for provenance.
--
-- Polymorphic-ref integrity strategy (no cross-table FK in Postgres):
-- (a) the CHECK constraint below restricts entity_type to the fixed
--     attachment-matrix enum; (b) the model layer (src/models/documents.js)
--     runs an existence check — SELECT 1 FROM <mapped table> WHERE id=$1 —
--     before insert; (c) parents in this system are never hard-deleted
--     (soft-delete/sealed conventions elsewhere), so orphaning is
--     structural-rare. orphanReport() in the model is a hygiene query, not
--     an enforced constraint.
--
-- BYTEA verified byte-identical on the PGlite driver path (round-trip test
-- with random bytes incl. null bytes, sha256 compared before/after) — see
-- src/models/test-documents.js. Content is stored as raw BYTEA, not
-- base64/TEXT.

CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('investment', 'pipeline_invite', 'company_update', 'deal_evaluation')),
  entity_id INT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual-upload' CHECK (source IN ('manual-upload', 'intake', 'email-forward')),
  size_bytes INT NOT NULL,
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256);

-- pending_intake: staging for the preview → confirm lifecycle. intakePreview
-- persists the artifact + parsed preview here server-side so intakeCommit
-- never trusts client-held state; the client sends back only preview_id
-- (this row's id) and its explicit overrides. preview_id is the
-- idempotency key for commit (NOT sha256 — the same artifact may
-- legitimately attach to more than one entity). Expired/committed rows are
-- swept opportunistically, not by cron.

CREATE TABLE IF NOT EXISTS pending_intake (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT,
  mime TEXT,
  sha256 TEXT NOT NULL,
  size_bytes INT NOT NULL,
  content BYTEA NOT NULL,
  preview JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed')),
  created_refs JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_intake_expires ON pending_intake(expires_at);
