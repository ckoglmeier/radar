-- Track Fund K-1 source updates by tax year. K-1 facts remain tax/reporting
-- evidence and do not become NAV or cash-ledger facts automatically.

ALTER TABLE investment_updates
  DROP CONSTRAINT investment_updates_update_kind_check;

ALTER TABLE investment_updates
  ADD CONSTRAINT investment_updates_update_kind_check CHECK (
    update_kind IN (
      'founder_update',
      'fund_update',
      'fund_k1',
      'employment_disclosure',
      'valuation_update',
      'financial_update',
      'general'
    )
  );

ALTER TABLE investment_updates
  ADD COLUMN IF NOT EXISTS tax_year INT;

ALTER TABLE investment_updates
  ADD CONSTRAINT investment_updates_tax_year_check CHECK (
    (update_kind = 'fund_k1' AND tax_year BETWEEN 1900 AND 2100)
    OR (update_kind <> 'fund_k1' AND tax_year IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_investment_updates_fund_k1
  ON investment_updates(investment_id, tax_year DESC, received_date DESC)
  WHERE update_kind = 'fund_k1';
