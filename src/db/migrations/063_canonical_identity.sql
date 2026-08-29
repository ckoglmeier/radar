-- Migration 063: canonical Entity subtypes, redirects, and Position identity.
-- Why: holders, legal issuers, operating Companies, and investment vehicles
-- need stable reviewed identities without replacing existing Position ledgers.

ALTER TABLE portfolio_entities
  ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE portfolio_entities
  ADD COLUMN IF NOT EXISTS entity_class TEXT;

ALTER TABLE portfolio_entities
  ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'confirmed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_entities_entity_class_check'
  ) THEN
    ALTER TABLE portfolio_entities
      ADD CONSTRAINT portfolio_entities_entity_class_check CHECK (
        entity_class IS NULL OR entity_class IN ('person', 'organization', 'vehicle', 'other')
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_entities_identity_status_check'
  ) THEN
    ALTER TABLE portfolio_entities
      ADD CONSTRAINT portfolio_entities_identity_status_check CHECK (
        identity_status IN ('provisional', 'confirmed', 'merge_candidate', 'retired')
      );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS companies (
  entity_id UUID PRIMARY KEY REFERENCES portfolio_entities(id),
  metadata_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investing_entities (
  entity_id UUID PRIMARY KEY REFERENCES portfolio_entities(id),
  investing_entity_kind TEXT NOT NULL CHECK (
    investing_entity_kind IN (
      'individual', 'household', 'llc', 'trust', 'spv', 'fund_vehicle', 'other'
    )
  ),
  manager_entity_id UUID REFERENCES portfolio_entities(id),
  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (
    lifecycle_status IN ('active', 'inactive', 'realized', 'retired')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investing_entities_kind
  ON investing_entities(investing_entity_kind, lifecycle_status);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES portfolio_entities(id),
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  source_id TEXT,
  review_state TEXT NOT NULL DEFAULT 'accepted' CHECK (
    review_state IN ('needs_review', 'accepted', 'rejected')
  ),
  provenance_note TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (entity_id, alias_normalized),
  UNIQUE (source_namespace, source_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_aliases_normalized
  ON entity_aliases(alias_normalized, review_state);

CREATE TABLE IF NOT EXISTS entity_redirects (
  superseded_entity_id UUID PRIMARY KEY REFERENCES portfolio_entities(id),
  canonical_entity_id UUID NOT NULL REFERENCES portfolio_entities(id),
  reason TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (superseded_entity_id <> canonical_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_redirects_canonical
  ON entity_redirects(canonical_entity_id);

CREATE OR REPLACE FUNCTION validate_entity_redirect()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE path(entity_id) AS (
      SELECT NEW.canonical_entity_id
      UNION ALL
      SELECT er.canonical_entity_id
        FROM entity_redirects er
        JOIN path p ON er.superseded_entity_id = p.entity_id
    )
    SELECT 1 FROM path WHERE entity_id = NEW.superseded_entity_id
  ) THEN
    RAISE EXCEPTION 'entity redirect would create a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_redirect_cycle_guard ON entity_redirects;
CREATE TRIGGER entity_redirect_cycle_guard
  BEFORE INSERT OR UPDATE ON entity_redirects
  FOR EACH ROW EXECUTE FUNCTION validate_entity_redirect();

CREATE TABLE IF NOT EXISTS identity_review_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('entity', 'position', 'alias', 'redirect', 'fund_profile', 'exposure')
  ),
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  decision JSONB NOT NULL,
  source_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  reviewed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS holder_entity_id UUID REFERENCES investing_entities(entity_id);

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS issuer_entity_id UUID REFERENCES portfolio_entities(id);

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS identity_review_status TEXT NOT NULL DEFAULT 'unresolved';

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS route_classification TEXT NOT NULL DEFAULT 'unresolved';

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS identity_receipt_id UUID REFERENCES identity_review_receipts(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investments_identity_review_status_check'
  ) THEN
    ALTER TABLE investments
      ADD CONSTRAINT investments_identity_review_status_check CHECK (
        identity_review_status IN ('unresolved', 'accepted')
      );
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investments_route_classification_check'
  ) THEN
    ALTER TABLE investments
      ADD CONSTRAINT investments_route_classification_check CHECK (
        route_classification IN ('direct_issuer', 'vehicle_interest', 'unresolved')
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_investments_holder_entity
  ON investments(holder_entity_id);

CREATE INDEX IF NOT EXISTS idx_investments_issuer_entity
  ON investments(issuer_entity_id);

CREATE INDEX IF NOT EXISTS idx_investments_identity_review
  ON investments(identity_review_status, route_classification);

CREATE OR REPLACE FUNCTION validate_position_canonical_identity()
RETURNS TRIGGER AS $$
DECLARE
  issuer_company BOOLEAN;
  issuer_vehicle_kind TEXT;
BEGIN
  IF NEW.identity_review_status = 'unresolved' THEN
    IF NEW.route_classification <> 'unresolved' THEN
      RAISE EXCEPTION 'unresolved Position identity requires unresolved route';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.holder_entity_id IS NULL OR NEW.issuer_entity_id IS NULL OR NEW.identity_receipt_id IS NULL THEN
    RAISE EXCEPTION 'accepted Position identity requires holder, issuer, and review receipt';
  END IF;

  IF NEW.route_classification = 'unresolved' THEN
    RAISE EXCEPTION 'accepted Position identity requires a reviewed route';
  END IF;

  IF NEW.route_classification = 'direct_issuer' THEN
    SELECT EXISTS (SELECT 1 FROM companies c WHERE c.entity_id = NEW.issuer_entity_id)
      INTO issuer_company;
    IF NOT issuer_company THEN
      RAISE EXCEPTION 'direct issuer route requires a reviewed Company issuer';
    END IF;
  ELSE
    SELECT investing_entity_kind
      INTO issuer_vehicle_kind
      FROM investing_entities
     WHERE entity_id = NEW.issuer_entity_id;
    IF issuer_vehicle_kind IS NULL OR issuer_vehicle_kind NOT IN ('spv', 'fund_vehicle') THEN
      RAISE EXCEPTION 'vehicle interest route requires a reviewed SPV or Fund issuer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS investments_canonical_identity_guard ON investments;
CREATE TRIGGER investments_canonical_identity_guard
  BEFORE INSERT OR UPDATE OF holder_entity_id, issuer_entity_id,
    identity_review_status, route_classification, identity_receipt_id
  ON investments
  FOR EACH ROW EXECUTE FUNCTION validate_position_canonical_identity();
