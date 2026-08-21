-- Migration 055: household file vault.
--
-- Vault entries hold the human-facing organization for private household
-- records. The original bytes remain in the audited documents store so they
-- retain the same integrity, policy, backup, and download controls as every
-- other Radar artifact.

CREATE TABLE IF NOT EXISTS file_vault_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'life_insurance',
      'home_insurance',
      'auto_insurance',
      'umbrella_insurance',
      'estate',
      'tax',
      'identity',
      'investments',
      'other'
    )
  ),
  related_entity_type TEXT CHECK (related_entity_type IN ('investment', 'portfolio_entity')),
  related_entity_id TEXT,
  related_label TEXT,
  owner_name TEXT,
  document_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
      'room_holding',
      'file_vault_entry'
    )
  );

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_confidentiality_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_confidentiality_check CHECK (
    confidentiality IN (
      'standard',
      'confidential_company',
      'tax_sensitive',
      'personal_sensitive'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_vault_document
  ON documents(entity_type, entity_id)
  WHERE entity_type = 'file_vault_entry';

CREATE INDEX IF NOT EXISTS idx_file_vault_category
  ON file_vault_entries(category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_file_vault_related_entity
  ON file_vault_entries(related_entity_type, related_entity_id, created_at DESC)
  WHERE related_entity_type IS NOT NULL AND related_entity_id IS NOT NULL;
