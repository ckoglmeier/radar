-- Reconcile local workspaces whose version 073 was legacy document writers.
-- Keep existing scored runs and review artifacts unchanged.
ALTER TABLE council_runs ADD COLUMN IF NOT EXISTS review_mode TEXT NOT NULL
  DEFAULT 'personalized' CHECK (review_mode IN ('personalized', 'ad_hoc'));
CREATE TABLE IF NOT EXISTS ad_hoc_reviews (
  id SERIAL PRIMARY KEY,
  council_run_id INTEGER NOT NULL UNIQUE REFERENCES council_runs(id) ON DELETE CASCADE,
  contract_version INTEGER NOT NULL CHECK (contract_version > 0),
  artifact JSONB NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
