-- Migration 011: Add CFO verdict field to deal_evaluations
--
-- The 4th council persona (Personal CFO) does not score deals — it assesses
-- portfolio construction fit and gives a Deploy/Defer/Pass verdict.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_cfo_verdict TEXT;  -- Deploy / Defer / Pass
