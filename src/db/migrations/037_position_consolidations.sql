-- Migration 037: preserve an audit record when duplicate investment rows are
-- consolidated. Source rows remain in investments with asset_class='merged';
-- direct-portfolio reports therefore stop counting them without deleting the
-- historical source record.

CREATE TABLE IF NOT EXISTS investment_consolidations (
  id SERIAL PRIMARY KEY,
  source_investment_id INT NOT NULL UNIQUE REFERENCES investments(id),
  target_investment_id INT NOT NULL REFERENCES investments(id),
  source_snapshot JSONB NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_investment_id <> target_investment_id)
);

CREATE INDEX IF NOT EXISTS idx_investment_consolidations_target
  ON investment_consolidations(target_investment_id, merged_at DESC);

CREATE TABLE IF NOT EXISTS position_duplicate_reviews (
  group_key TEXT PRIMARY KEY,
  investment_ids JSONB NOT NULL,
  resolution TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
