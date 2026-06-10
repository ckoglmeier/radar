-- Migration 012: Add eval_mode to deal_evaluations
--
-- Tracks which rubric mode was used for a given evaluation.
-- 'standard' = default early-stage rubric (Capital Efficiency, Compounding Structure)
-- 'secondary' = pre-IPO / secondary trade rubric (Time to Liquidity, Exit Path Clarity)

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS eval_mode TEXT NOT NULL DEFAULT 'standard';
