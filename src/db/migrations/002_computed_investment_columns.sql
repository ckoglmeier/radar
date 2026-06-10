-- Computed return columns on investments (previously inline in transactions.js)
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_realized NUMERIC(14,2);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_refunds NUMERIC(14,2);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_net_invested NUMERIC(14,2);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_total_value NUMERIC(14,2);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_multiple NUMERIC(10,4);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ;
