-- Migration 041: add stable portfolio entity and position identity.
-- Why: multiple positions can belong to one legal entity, while each fund
-- vehicle remains a distinct entity. Semantic links are populated only by the
-- reviewed identity-manifest command.

CREATE TABLE IF NOT EXISTS portfolio_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_key UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('operating_company', 'fund_vehicle', 'other')
  ),
  legal_form TEXT CHECK (
    legal_form IS NULL OR
    legal_form IN ('llc', 'c_corporation', 'limited_partnership', 'other')
  ),
  jurisdiction TEXT,
  website TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_entities_normalized_name
  ON portfolio_entities(normalized_name, entity_type);

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS position_key UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_investments_position_key
  ON investments(position_key);

ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS portfolio_entity_id UUID REFERENCES portfolio_entities(id);

CREATE INDEX IF NOT EXISTS idx_investments_portfolio_entity
  ON investments(portfolio_entity_id);

CREATE INDEX IF NOT EXISTS idx_investments_asset_class
  ON investments(asset_class);

ALTER TABLE company_aliases
  ADD COLUMN IF NOT EXISTS portfolio_entity_id UUID REFERENCES portfolio_entities(id);

CREATE INDEX IF NOT EXISTS idx_company_aliases_portfolio_entity
  ON company_aliases(portfolio_entity_id);
