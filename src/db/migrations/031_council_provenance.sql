-- Migration 031: Make Council evaluations reproducible and auditable.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_policy TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_policy_version INT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_instruction_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_lens_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_calibration_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_input_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_artifact_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_session_id TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_model_policy TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_score_adjusted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_run_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_evaluations_council_run_key
  ON deal_evaluations(council_run_key)
  WHERE council_run_key IS NOT NULL;
