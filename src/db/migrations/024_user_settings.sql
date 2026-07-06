-- Migration 024: durable per-user settings for app state.
-- Why: Phase 8 onboarding needs a server-side home for the onboarded flag.

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  onboarded BOOLEAN NOT NULL DEFAULT FALSE,
  onboarding_track TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
