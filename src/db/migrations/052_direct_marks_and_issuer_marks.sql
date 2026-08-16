-- First-class Direct valuation corrections and Employment issuer mark history.

CREATE TABLE IF NOT EXISTS employment_equity_issuer_marks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_entity_id UUID NOT NULL REFERENCES portfolio_entities(id),
  mark_type TEXT NOT NULL CHECK (mark_type IN ('common_share_economic', 'tax_409a')),
  mark_date DATE NOT NULL,
  value_per_unit NUMERIC(18,6) NOT NULL CHECK (value_per_unit >= 0),
  confidence TEXT NOT NULL CHECK (confidence IN ('company_reported', 'calculated', 'estimated')),
  source_document_id INT REFERENCES documents(id),
  source_fact_key TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (portfolio_entity_id, mark_type, mark_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_issuer_marks_source_fact
  ON employment_equity_issuer_marks(source_fact_key)
  WHERE source_fact_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ee_issuer_marks_entity_date
  ON employment_equity_issuer_marks(portfolio_entity_id, mark_type, mark_date DESC);

ALTER TABLE employment_equity_valuation_details
  ADD COLUMN IF NOT EXISTS issuer_mark_id UUID
    REFERENCES employment_equity_issuer_marks(id);

CREATE INDEX IF NOT EXISTS idx_ee_valuation_details_issuer_mark
  ON employment_equity_valuation_details(issuer_mark_id)
  WHERE issuer_mark_id IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_issuer_mark_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Employment Equity issuer marks are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_issuer_marks_immutable ON employment_equity_issuer_marks;
CREATE TRIGGER ee_issuer_marks_immutable
  BEFORE UPDATE OR DELETE ON employment_equity_issuer_marks
  FOR EACH ROW EXECUTE FUNCTION prevent_issuer_mark_mutation();

CREATE OR REPLACE FUNCTION prevent_valuation_update()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'valuations table is append-only; INSERT corrections as new rows';
  END IF;

  SELECT asset_class INTO linked_class
    FROM investments WHERE id = OLD.investment_id;

  IF current_setting('radar.allow_fund_valuation_correction', TRUE) = 'on'
     AND linked_class = 'fund'
     AND OLD.source = 'fund_manual'
     AND NEW.source = 'fund_manual'
     AND OLD.id = NEW.id
     AND OLD.investment_id = NEW.investment_id
     AND OLD.snapshot_date = NEW.snapshot_date
     AND OLD.created_at = NEW.created_at THEN
    RETURN NEW;
  END IF;

  IF current_setting('radar.allow_direct_valuation_correction', TRUE) = 'on'
     AND linked_class = 'direct'
     AND OLD.source = 'direct_manual'
     AND NEW.source = 'direct_manual'
     AND OLD.id = NEW.id
     AND OLD.investment_id = NEW.investment_id
     AND OLD.snapshot_date = NEW.snapshot_date
     AND OLD.created_at = NEW.created_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'valuations table is append-only; INSERT corrections as new rows';
END;
$$ LANGUAGE plpgsql;
