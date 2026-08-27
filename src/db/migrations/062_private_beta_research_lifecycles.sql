-- Minimal durable lifecycle fields for the existing Command thread and
-- investment-update authorities. These are workflow-specific records, not a
-- general job queue.

ALTER TABLE command_threads
  ADD COLUMN IF NOT EXISTS active_request_id UUID REFERENCES command_messages(id),
  ADD COLUMN IF NOT EXISTS active_request_state TEXT,
  ADD COLUMN IF NOT EXISTS active_request_stage TEXT,
  ADD COLUMN IF NOT EXISTS active_request_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_request_stage_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_request_terminal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_request_cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS active_request_failure_code TEXT;

ALTER TABLE command_threads DROP CONSTRAINT IF EXISTS command_threads_request_state_check;
ALTER TABLE command_threads ADD CONSTRAINT command_threads_request_state_check CHECK (
  active_request_state IS NULL OR active_request_state IN ('queued','running','completed','failed','timed_out','cancelled')
);
ALTER TABLE command_threads DROP CONSTRAINT IF EXISTS command_threads_request_stage_check;
ALTER TABLE command_threads ADD CONSTRAINT command_threads_request_stage_check CHECK (
  active_request_stage IS NULL OR active_request_stage IN ('queued','interpreting','research','planning','review_ready','complete','failed','cancelled')
);
ALTER TABLE command_threads DROP CONSTRAINT IF EXISTS command_threads_request_failure_check;
ALTER TABLE command_threads ADD CONSTRAINT command_threads_request_failure_check CHECK (
  active_request_failure_code IS NULL OR active_request_failure_code IN (
    'credential_required','provider_unavailable','provider_disconnected','turn_limit',
    'deadline','source_unavailable','validation_failed','cancelled','unexpected'
  )
);

ALTER TABLE investment_updates
  ADD COLUMN IF NOT EXISTS operational_stage TEXT,
  ADD COLUMN IF NOT EXISTS analysis_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS analysis_stage_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS analysis_terminal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS failure_code TEXT;

ALTER TABLE investment_updates DROP CONSTRAINT IF EXISTS investment_updates_operational_stage_check;
ALTER TABLE investment_updates ADD CONSTRAINT investment_updates_operational_stage_check CHECK (
  operational_stage IS NULL OR operational_stage IN ('queued','extraction','research','validation','review_ready','complete','failed','cancelled')
);
ALTER TABLE investment_updates DROP CONSTRAINT IF EXISTS investment_updates_failure_code_check;
ALTER TABLE investment_updates ADD CONSTRAINT investment_updates_failure_code_check CHECK (
  failure_code IS NULL OR failure_code IN (
    'credential_required','provider_unavailable','provider_disconnected','turn_limit',
    'deadline','source_unavailable','validation_failed','cancelled','unexpected'
  )
);

UPDATE investment_updates
   SET operational_stage = CASE status
     WHEN 'stored' THEN 'complete'
     WHEN 'pending' THEN 'queued'
     WHEN 'complete' THEN 'complete'
     WHEN 'failed' THEN 'failed'
   END
 WHERE operational_stage IS NULL;
