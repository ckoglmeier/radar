-- Migration 066: reviewed canonical Company fact history.
-- Why: Company metadata supplied through Direct, Fund/SPV, or Employment
-- sources should be reviewed once and reused without copying economic facts.

CREATE TABLE IF NOT EXISTS company_fact_registry (
  fact_key TEXT PRIMARY KEY,
  value_type TEXT NOT NULL CHECK (
    value_type IN ('text', 'date', 'integer', 'decimal', 'money', 'entity_reference', 'json')
  ),
  registry_version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_entity_id UUID NOT NULL REFERENCES companies(entity_id),
  fact_key TEXT NOT NULL REFERENCES company_fact_registry(fact_key),
  value JSONB NOT NULL,
  effective_date DATE,
  effective_end_date DATE,
  source_namespace TEXT NOT NULL,
  source_claim_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_document_id INT REFERENCES documents(id),
  confidence TEXT NOT NULL DEFAULT 'reported' CHECK (
    confidence IN ('confirmed', 'reported', 'calculated', 'estimated', 'unknown')
  ),
  confidentiality TEXT NOT NULL DEFAULT 'confidential_company' CHECK (
    confidentiality IN ('standard', 'confidential_company', 'tax_sensitive')
  ),
  processing_policy TEXT NOT NULL DEFAULT 'local_only' CHECK (
    processing_policy IN ('local_only', 'model_allowed')
  ),
  sync_policy TEXT NOT NULL DEFAULT 'encrypted_backup_allowed' CHECK (
    sync_policy IN ('local_only', 'encrypted_backup_allowed')
  ),
  policy_version INT NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  review_state TEXT NOT NULL DEFAULT 'needs_review' CHECK (
    review_state IN ('needs_review', 'accepted', 'rejected')
  ),
  supersedes_fact_id UUID REFERENCES company_facts(id),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_entity_id, source_namespace, source_claim_id, fact_key),
  CHECK (effective_end_date IS NULL OR effective_date IS NULL OR effective_end_date >= effective_date),
  CHECK (
    review_state <> 'accepted' OR
    (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_company_facts_company_key
  ON company_facts(company_entity_id, fact_key, review_state, effective_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_company_facts_review
  ON company_facts(review_state, created_at);

CREATE TABLE IF NOT EXISTS company_fact_field_ownership (
  field_name TEXT PRIMARY KEY,
  ownership TEXT NOT NULL CHECK (
    ownership IN ('canonical_fact', 'projection', 'compatibility_only', 'unresolved')
  ),
  manifest_version INT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION protect_accepted_company_fact()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.review_state = 'accepted' AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'accepted Company facts are immutable; append a superseding fact';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_facts_accepted_guard ON company_facts;
CREATE TRIGGER company_facts_accepted_guard
  BEFORE UPDATE ON company_facts
  FOR EACH ROW EXECUTE FUNCTION protect_accepted_company_fact();
