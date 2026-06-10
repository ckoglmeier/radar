-- Status tracking columns on sync_runs (previously inline in sync-runs.js)
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE sync_runs ADD COLUMN IF NOT EXISTS error_details JSONB;
