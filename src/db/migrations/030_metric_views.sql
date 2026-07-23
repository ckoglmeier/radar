-- Migration 030: metric views
-- Why: Persist named, validated MetricQuery parameters that the Performance analyst re-runs live.

CREATE TABLE IF NOT EXISTS metric_views (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  query JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
