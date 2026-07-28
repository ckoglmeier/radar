-- Migration 038: versioned, editable evaluation framework.
--
-- Bundled lens JSON remains the fail-safe seed. Each user edit writes a full
-- immutable snapshot here and atomically makes it active. Historical Council
-- evaluations keep their own rubric snapshot and lens hash.

CREATE TABLE IF NOT EXISTS lens_framework_versions (
  id SERIAL PRIMARY KEY,
  lens_name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest JSONB NOT NULL,
  rubric JSONB NOT NULL,
  rubric_secondary JSONB,
  kill_criteria JSONB NOT NULL,
  tagging_rules JSONB NOT NULL,
  gp_tiers JSONB NOT NULL,
  round_params JSONB NOT NULL,
  change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lens_name, version)
);
