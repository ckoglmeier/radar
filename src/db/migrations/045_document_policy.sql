-- Migration 045: document attachment identity + enforceable privacy policy.
-- Existing rows retain their prior effective behavior through explicit
-- defaults. Employment Equity callers opt into more restrictive values.

ALTER TABLE documents
  ALTER COLUMN entity_id TYPE TEXT USING entity_id::text;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_entity_type_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_entity_type_check CHECK (
    entity_type IN (
      'investment',
      'pipeline_invite',
      'company_update',
      'deal_evaluation',
      'portfolio_entity',
      'room_holding'
    )
  );

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS confidentiality TEXT NOT NULL DEFAULT 'standard';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS processing_policy TEXT NOT NULL DEFAULT 'model_allowed';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS sync_policy TEXT NOT NULL DEFAULT 'encrypted_backup_allowed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_confidentiality_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_confidentiality_check CHECK (
        confidentiality IN ('standard', 'confidential_company', 'tax_sensitive')
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_processing_policy_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_processing_policy_check CHECK (
        processing_policy IN ('local_only', 'model_allowed')
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_sync_policy_check'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_sync_policy_check CHECK (
        sync_policy IN ('local_only', 'encrypted_backup_allowed')
      );
  END IF;
END
$$;
