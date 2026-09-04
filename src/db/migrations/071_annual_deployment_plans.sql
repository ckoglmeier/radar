-- Migration 071: immutable, year-specific investment deployment plans.
-- The latest version for a year and asset class is authoritative. Bundled
-- bet-sizing config remains a read fallback until the first plan is saved.

CREATE TABLE IF NOT EXISTS annual_deployment_plan_versions (
  id SERIAL PRIMARY KEY,
  budget_year INT NOT NULL CHECK (budget_year BETWEEN 2000 AND 2100),
  asset_class TEXT NOT NULL DEFAULT 'direct' CHECK (asset_class = 'direct'),
  annual_budget NUMERIC(14,2) NOT NULL CHECK (annual_budget >= 0),
  version INT NOT NULL CHECK (version > 0),
  supersedes_id INT REFERENCES annual_deployment_plan_versions(id),
  change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (budget_year, asset_class, version)
);

CREATE INDEX IF NOT EXISTS annual_deployment_plan_versions_lookup_idx
  ON annual_deployment_plan_versions (budget_year, asset_class, version DESC);
