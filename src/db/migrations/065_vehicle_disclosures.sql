-- Migration 065: append-only Fund/SPV disclosure snapshots and raw holdings.
-- Why: vehicle look-through must preserve exactly what a source reported
-- without creating user Positions or allocating aggregate value.

CREATE TABLE IF NOT EXISTS vehicle_portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_entity_id UUID NOT NULL REFERENCES investing_entities(entity_id),
  source_receipt_namespace TEXT NOT NULL,
  source_receipt_id TEXT NOT NULL,
  boundary_kind TEXT NOT NULL,
  boundary_locator TEXT NOT NULL,
  source_document_id INT REFERENCES documents(id),
  source_hash TEXT NOT NULL,
  as_of_date DATE,
  received_date DATE NOT NULL,
  effective_snapshot_date DATE GENERATED ALWAYS AS (COALESCE(as_of_date, received_date)) STORED,
  disclosure_presence TEXT NOT NULL DEFAULT 'undetermined' CHECK (
    disclosure_presence IN ('undetermined', 'not_provided', 'explicitly_none', 'provided')
  ),
  holdings_completeness TEXT CHECK (
    holdings_completeness IS NULL OR holdings_completeness IN ('partial', 'complete', 'unknown')
  ),
  extraction_status TEXT NOT NULL DEFAULT 'not_attempted' CHECK (
    extraction_status IN ('not_attempted', 'succeeded', 'failed', 'needs_review')
  ),
  review_state TEXT NOT NULL DEFAULT 'needs_review' CHECK (
    review_state IN ('needs_review', 'accepted', 'rejected', 'superseded')
  ),
  reported_holding_count INT CHECK (
    reported_holding_count IS NULL OR reported_holding_count >= 0
  ),
  reported_total_portfolio_value NUMERIC(24,6) CHECK (
    reported_total_portfolio_value IS NULL OR reported_total_portfolio_value >= 0
  ),
  reported_value_currency TEXT,
  reported_value_unit_scale TEXT,
  reported_value_basis TEXT,
  reported_value_effective_date DATE,
  confidentiality TEXT NOT NULL DEFAULT 'confidential_company' CHECK (
    confidentiality IN ('standard', 'confidential_company', 'tax_sensitive')
  ),
  processing_policy TEXT NOT NULL DEFAULT 'local_only' CHECK (
    processing_policy IN ('local_only', 'model_allowed')
  ),
  sync_policy TEXT NOT NULL DEFAULT 'encrypted_backup_allowed' CHECK (
    sync_policy IN ('local_only', 'encrypted_backup_allowed')
  ),
  supersedes_snapshot_id UUID REFERENCES vehicle_portfolio_snapshots(id),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_receipt_namespace, source_receipt_id, boundary_kind, boundary_locator),
  CHECK (
    (disclosure_presence = 'provided' AND holdings_completeness IS NOT NULL) OR
    (disclosure_presence <> 'provided' AND holdings_completeness IS NULL)
  ),
  CHECK (
    review_state <> 'accepted' OR disclosure_presence <> 'undetermined'
  ),
  CHECK (
    reported_total_portfolio_value IS NULL OR
    (reported_value_currency IS NOT NULL AND reported_value_unit_scale IS NOT NULL AND
     reported_value_basis IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_snapshots_vehicle_date
  ON vehicle_portfolio_snapshots(vehicle_entity_id, effective_snapshot_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_snapshots_review
  ON vehicle_portfolio_snapshots(review_state, extraction_status);

CREATE TABLE IF NOT EXISTS vehicle_exposure_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES vehicle_portfolio_snapshots(id),
  source_claim_id TEXT NOT NULL,
  raw_target_name TEXT NOT NULL,
  target_entity_id UUID REFERENCES portfolio_entities(id),
  resolution_status TEXT NOT NULL DEFAULT 'unresolved' CHECK (
    resolution_status IN ('unresolved', 'provisional', 'confirmed', 'rejected')
  ),
  holding_status TEXT NOT NULL DEFAULT 'unknown' CHECK (
    holding_status IN ('active', 'realized', 'unknown')
  ),
  stage TEXT,
  security TEXT,
  reported_cost NUMERIC(24,6) CHECK (
    reported_cost IS NULL OR reported_cost >= 0
  ),
  cost_currency TEXT,
  cost_unit_scale TEXT,
  cost_basis TEXT,
  cost_effective_date DATE,
  ownership_percentage NUMERIC(12,8) CHECK (
    ownership_percentage IS NULL OR ownership_percentage BETWEEN 0 AND 1
  ),
  units NUMERIC(24,8),
  reported_value NUMERIC(24,6) CHECK (
    reported_value IS NULL OR reported_value >= 0
  ),
  value_currency TEXT,
  value_unit_scale TEXT,
  value_basis TEXT,
  value_effective_date DATE,
  source_citation TEXT,
  confidence TEXT NOT NULL DEFAULT 'reported' CHECK (
    confidence IN ('confirmed', 'reported', 'calculated', 'estimated', 'unknown')
  ),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_id, source_claim_id),
  CHECK (
    (resolution_status IN ('provisional', 'confirmed') AND target_entity_id IS NOT NULL) OR
    (resolution_status IN ('unresolved', 'rejected') AND target_entity_id IS NULL)
  ),
  CHECK (
    reported_cost IS NULL OR
    (cost_currency IS NOT NULL AND cost_unit_scale IS NOT NULL AND cost_basis IS NOT NULL)
  ),
  CHECK (
    reported_value IS NULL OR
    (value_currency IS NOT NULL AND value_unit_scale IS NOT NULL AND value_basis IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_vehicle_exposures_target
  ON vehicle_exposure_claims(target_entity_id, resolution_status);

CREATE INDEX IF NOT EXISTS idx_vehicle_exposures_snapshot
  ON vehicle_exposure_claims(snapshot_id, source_claim_id);

CREATE OR REPLACE FUNCTION validate_vehicle_snapshot_entity()
RETURNS TRIGGER AS $$
DECLARE
  vehicle_kind TEXT;
BEGIN
  SELECT investing_entity_kind INTO vehicle_kind
    FROM investing_entities WHERE entity_id = NEW.vehicle_entity_id;
  IF vehicle_kind IS NULL OR vehicle_kind NOT IN ('spv', 'fund_vehicle') THEN
    RAISE EXCEPTION 'vehicle snapshot requires a reviewed SPV or Fund investing entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_snapshot_entity_guard ON vehicle_portfolio_snapshots;
CREATE TRIGGER vehicle_snapshot_entity_guard
  BEFORE INSERT OR UPDATE OF vehicle_entity_id ON vehicle_portfolio_snapshots
  FOR EACH ROW EXECUTE FUNCTION validate_vehicle_snapshot_entity();

CREATE OR REPLACE FUNCTION protect_vehicle_exposure_source()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
     OR OLD.source_claim_id IS DISTINCT FROM NEW.source_claim_id
     OR OLD.raw_target_name IS DISTINCT FROM NEW.raw_target_name
     OR OLD.holding_status IS DISTINCT FROM NEW.holding_status
     OR OLD.stage IS DISTINCT FROM NEW.stage
     OR OLD.security IS DISTINCT FROM NEW.security
     OR OLD.reported_cost IS DISTINCT FROM NEW.reported_cost
     OR OLD.ownership_percentage IS DISTINCT FROM NEW.ownership_percentage
     OR OLD.units IS DISTINCT FROM NEW.units
     OR OLD.reported_value IS DISTINCT FROM NEW.reported_value
     OR OLD.value_currency IS DISTINCT FROM NEW.value_currency
     OR OLD.value_unit_scale IS DISTINCT FROM NEW.value_unit_scale
     OR OLD.value_basis IS DISTINCT FROM NEW.value_basis
     OR OLD.value_effective_date IS DISTINCT FROM NEW.value_effective_date
     OR OLD.source_citation IS DISTINCT FROM NEW.source_citation
     OR OLD.confidence IS DISTINCT FROM NEW.confidence
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'vehicle exposure source facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicle_exposure_source_guard ON vehicle_exposure_claims;
CREATE TRIGGER vehicle_exposure_source_guard
  BEFORE UPDATE ON vehicle_exposure_claims
  FOR EACH ROW EXECUTE FUNCTION protect_vehicle_exposure_source();
