-- Migration 015: enforce one valuation snapshot per (investment_id, snapshot_date)
-- Why: createValuationSnapshot in src/models/investments.js used
-- ON CONFLICT DO NOTHING but the table had no matching unique constraint, so
-- re-imports on the same day silently inserted duplicate snapshots.
--
-- IMPORTANT: Run scripts/dedup-valuations.js --apply BEFORE this migration.
-- The unique constraint will fail to create if duplicates still exist.

ALTER TABLE valuations
  ALTER COLUMN investment_id SET NOT NULL;

ALTER TABLE valuations
  ADD CONSTRAINT valuations_investment_date_unique
  UNIQUE (investment_id, snapshot_date);
