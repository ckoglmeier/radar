-- Migration 072: versioned workspace-owned sizing limits.
-- Why: user capital settings must not live in an installed application file.
CREATE TABLE IF NOT EXISTS workspace_sizing_versions (
  id SERIAL PRIMARY KEY,
  version INT NOT NULL UNIQUE CHECK (version > 0),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  change_note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
