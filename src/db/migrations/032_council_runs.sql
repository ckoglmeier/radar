-- Migration 032: Persist Council execution state across page navigation.

CREATE TABLE IF NOT EXISTS council_runs (
  id SERIAL PRIMARY KEY,
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id) ON DELETE CASCADE,
  previous_evaluation_id INT REFERENCES deal_evaluations(id) ON DELETE SET NULL,
  evaluation_id INT REFERENCES deal_evaluations(id) ON DELETE SET NULL,
  run_key TEXT,
  run_type TEXT NOT NULL DEFAULT 'score',
  status TEXT NOT NULL DEFAULT 'running',
  stage TEXT NOT NULL DEFAULT 'queued',
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_council_runs_invite_started
  ON council_runs(pipeline_invite_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_council_runs_one_active_per_invite
  ON council_runs(pipeline_invite_id)
  WHERE status = 'running';

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_run_type TEXT;

-- Legacy imports occasionally captured a partial section subtotal as the total.
-- Prefer complete section arithmetic; fall back to the recorded Calibrator score.
UPDATE deal_evaluations
SET total_score = CASE
      WHEN thesis_fit_score IS NOT NULL AND viability_score IS NOT NULL
        THEN thesis_fit_score + viability_score
      ELSE council_calibrator_score
    END,
    council_score_adjusted = TRUE
WHERE council_calibrator_score IS NOT NULL
  AND (
    total_score IS NULL
    OR ABS(
      total_score - CASE
        WHEN thesis_fit_score IS NOT NULL AND viability_score IS NOT NULL
          THEN thesis_fit_score + viability_score
        ELSE council_calibrator_score
      END
    ) > 0.1
  );
