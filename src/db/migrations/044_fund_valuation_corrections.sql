-- Migration 044: permit narrowly scoped, audited same-day Fund NAV corrections.
-- Why: valuations remain unique per position/date; a reviewed manual correction
-- must update that one row without weakening append-only history elsewhere.

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

  RAISE EXCEPTION 'valuations table is append-only; INSERT corrections as new rows';
END;
$$ LANGUAGE plpgsql;
