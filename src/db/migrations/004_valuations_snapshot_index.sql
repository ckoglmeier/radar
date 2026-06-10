-- Composite index for efficient portfolioValueAsOf() lateral join queries
CREATE INDEX IF NOT EXISTS idx_valuations_investment_date
  ON valuations (investment_id, snapshot_date DESC);
