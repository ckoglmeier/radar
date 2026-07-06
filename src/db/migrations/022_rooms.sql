-- Migration 022: rooms
-- Why: Persist presentational-first room layouts, holdings, pipeline items, and saved views for Phase 8.

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  cols JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_holdings (
  id SERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  investment_id INT REFERENCES investments(id) ON DELETE SET NULL,
  cells JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_pipeline (
  id SERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  pipeline_invite_id INT REFERENCES pipeline_invites(id) ON DELETE SET NULL,
  cells JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_views (
  id SERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cols JSONB DEFAULT '[]'::jsonb,
  cells JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_holdings_room ON room_holdings(room_id);
CREATE INDEX IF NOT EXISTS idx_room_holdings_investment ON room_holdings(investment_id);
CREATE INDEX IF NOT EXISTS idx_room_pipeline_room ON room_pipeline(room_id);
CREATE INDEX IF NOT EXISTS idx_room_pipeline_invite ON room_pipeline(pipeline_invite_id);
CREATE INDEX IF NOT EXISTS idx_room_views_room ON room_views(room_id);
