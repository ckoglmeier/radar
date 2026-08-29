-- Migration 064: separate shared Fund vehicle identity from Position terms.
-- Why: several user Positions may reference one Fund without duplicating its
-- manager, strategy, vintage, or disclosure history.

CREATE TABLE IF NOT EXISTS fund_vehicle_profiles (
  entity_id UUID PRIMARY KEY REFERENCES investing_entities(entity_id),
  manager TEXT,
  strategy TEXT,
  vintage_year INT CHECK (
    vintage_year IS NULL OR vintage_year BETWEEN 1900 AND 2100
  ),
  description TEXT,
  review_state TEXT NOT NULL DEFAULT 'needs_review' CHECK (
    review_state IN ('needs_review', 'accepted', 'conflict')
  ),
  source_hash TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_profile_field_ownership (
  field_name TEXT PRIMARY KEY,
  ownership TEXT NOT NULL CHECK (
    ownership IN ('vehicle', 'position', 'compatibility_only', 'unresolved')
  ),
  manifest_version INT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
