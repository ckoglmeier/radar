-- Migration 043: enforce negative Fund fee cash-flow signs.
-- Why: fees are outflows and must not silently inflate Fund performance.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cf_fee_negative'
  ) THEN
    ALTER TABLE cash_flows
      ADD CONSTRAINT cf_fee_negative
      CHECK (type <> 'fee' OR amount < 0);
  END IF;
END;
$$;
