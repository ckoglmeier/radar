-- Migration 005: Beancount-inspired integrity layer
-- Valuations immutability trigger, investment_events audit log, cash_flows double-entry columns

-- 1. Valuations immutability trigger
CREATE OR REPLACE FUNCTION prevent_valuation_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'valuations table is append-only; INSERT corrections as new rows';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER valuations_immutable
  BEFORE UPDATE OR DELETE ON valuations
  FOR EACH ROW EXECUTE FUNCTION prevent_valuation_update();

-- 2. Investment events (mirrors pipeline_events pattern)
CREATE TABLE IF NOT EXISTS investment_events (
  id SERIAL PRIMARY KEY,
  investment_id INT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  event_date TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  notes TEXT
);

CREATE INDEX idx_investment_events_investment ON investment_events(investment_id);
CREATE INDEX idx_investment_events_date ON investment_events(event_date DESC);

-- 3. Cash flows: contra_account for lightweight double-entry, lot tracking columns
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS contra_account TEXT;
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC(14,6);
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS cost_date DATE;
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS units NUMERIC(14,6);
