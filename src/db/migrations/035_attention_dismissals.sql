-- Migration 035: durable dismissals for computed Cockpit attention signals.
-- The signal key includes the source record and signal state, so a materially
-- changed signal can appear again without deleting the prior dismissal.

CREATE TABLE IF NOT EXISTS attention_dismissals (
  signal_key TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
