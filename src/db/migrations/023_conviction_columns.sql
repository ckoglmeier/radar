-- Migration 023: conviction columns on investments
-- Why: store manual conviction scores directly on positions for Phase 8 Step 5.

ALTER TABLE investments ADD COLUMN IF NOT EXISTS conviction_now NUMERIC(4,1);
ALTER TABLE investments ADD COLUMN IF NOT EXISTS conviction_entry NUMERIC(4,1);
