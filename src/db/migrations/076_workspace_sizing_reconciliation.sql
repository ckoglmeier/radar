-- Reconcile local workspaces whose version 072 was document compaction.
-- Preserve the historical ledger and all existing sizing versions.
CREATE TABLE IF NOT EXISTS workspace_sizing_versions (
  id SERIAL PRIMARY KEY,
  version INT NOT NULL UNIQUE CHECK (version > 0),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  change_note TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
