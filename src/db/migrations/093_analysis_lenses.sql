-- Migration 093: Reusable named analysis lenses.
-- Why: custom per-analysis preferences can be saved explicitly without replacing a plan.
CREATE TABLE IF NOT EXISTS analysis_lenses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('angel', 'giving')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_lenses_name ON analysis_lenses(workspace_id, category, lower(name));
