-- Migration 009: Add council evaluation fields to deal_evaluations
--
-- The investment council runs 3 personas (Bull, Bear, Calibrator) independently
-- scoring a deal. These fields store their scores and the spread/divergence
-- for later signal comparison against single-pass scores and outcomes.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_bull_score NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS council_bear_score NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS council_calibrator_score NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS council_spread NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS council_consensus NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS council_divergence TEXT;  -- LOW / MODERATE / HIGH
