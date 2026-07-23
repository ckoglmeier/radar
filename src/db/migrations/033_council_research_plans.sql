-- Migration 033: Persist structured Council research plans.
-- Why: Planning sessions should become a dataset for deterministic seed questions.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_research_plan_hash TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_research_plan JSONB;
