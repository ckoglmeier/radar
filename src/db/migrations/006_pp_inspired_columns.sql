-- Portfolio Performance-inspired schema additions (2026-04-12)
-- Weighted thesis attribution, transaction unit decomposition, FIFO lot tracking

-- Weighted thesis attribution: weight column (100 = 100%, default preserves current behavior)
ALTER TABLE investment_theses ADD COLUMN IF NOT EXISTS weight INT DEFAULT 100;

-- Transaction unit decomposition: attach fees/taxes to cash flow rows
-- Named 'fee_tax_units' to avoid conflict with 005's 'units' (share count)
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS fee_tax_units JSONB DEFAULT '[]';

-- FIFO lot tracking: link distributions to specific investment lots
ALTER TABLE cash_flows ADD COLUMN IF NOT EXISTS lot_investment_id INT REFERENCES investments(id);

-- QSBS eligibility flag (manual for now)
ALTER TABLE investments ADD COLUMN IF NOT EXISTS qsbs_eligible BOOLEAN DEFAULT false;

-- Composite index for IRR queries (investment_id + flow_date)
CREATE INDEX IF NOT EXISTS idx_cash_flows_investment_date ON cash_flows(investment_id, flow_date);
