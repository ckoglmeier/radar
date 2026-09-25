-- Browser imports are replay-safe and never imply an assessment or decision.
CREATE TABLE IF NOT EXISTS radar_browser_captures (
  capture_hash TEXT PRIMARY KEY CHECK (length(capture_hash) = 64),
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id),
  source_url TEXT NOT NULL,
  provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
