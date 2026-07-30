-- Migration 040: Durable Council run contract and store-once evidence records.

-- Normalize the legacy vocabulary before adding the shared constraint.
UPDATE council_runs
SET run_type = CASE run_type
  WHEN 'score' THEN 'initial'
  WHEN 'refresh' THEN 'research_refresh'
  WHEN 'followup' THEN 'founder_followup'
  WHEN 'replay' THEN 'controlled_replay'
  ELSE run_type
END;

ALTER TABLE council_runs
  ALTER COLUMN run_type SET DEFAULT 'initial';

ALTER TABLE council_runs
  DROP CONSTRAINT IF EXISTS council_runs_run_type_check;

ALTER TABLE council_runs
  ADD CONSTRAINT council_runs_run_type_check CHECK (
    run_type IN (
      'initial',
      'founder_followup',
      'research_refresh',
      'policy_refresh',
      'controlled_replay',
      'review_import'
    )
  );

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS request_key TEXT;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS parent_run_id INT
    REFERENCES council_runs(id) ON DELETE SET NULL;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 0;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS claim_token TEXT;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS model_started_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS facts_confirmed_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS model_authorized_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS source_manifest JSONB;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS source_coverage JSONB;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS research_snapshot JSONB;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS usage_snapshot JSONB;

ALTER TABLE council_runs
  ADD COLUMN IF NOT EXISTS evidence_contract_version INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_council_runs_request_key
  ON council_runs(request_key)
  WHERE request_key IS NOT NULL;

DROP INDEX IF EXISTS idx_council_runs_one_active_per_invite;

CREATE UNIQUE INDEX IF NOT EXISTS idx_council_runs_one_active_per_invite
  ON council_runs(pipeline_invite_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS council_run_events (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL REFERENCES council_runs(id) ON DELETE CASCADE,
  attempt_number INT NOT NULL DEFAULT 0,
  sequence INT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  phase TEXT,
  safe_detail TEXT,
  outcome JSONB,
  UNIQUE (run_id, attempt_number, sequence)
);

CREATE INDEX IF NOT EXISTS idx_council_run_events_cursor
  ON council_run_events(run_id, attempt_number, sequence);

CREATE TABLE IF NOT EXISTS council_run_dispatch (
  id SERIAL PRIMARY KEY,
  run_id INT NOT NULL UNIQUE REFERENCES council_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'delivered', 'cancelled')),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claim_token TEXT,
  delivery_attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_council_run_dispatch_pending
  ON council_run_dispatch(status, available_at, id);

-- The completed evaluation owns the durable run link. The older columns on
-- council_runs remain as compatibility projections through the v0.3 rollback
-- window, but are no longer foreign keys or independent sources of truth.
ALTER TABLE council_runs
  DROP CONSTRAINT IF EXISTS council_runs_previous_evaluation_id_fkey;

ALTER TABLE council_runs
  DROP CONSTRAINT IF EXISTS council_runs_evaluation_id_fkey;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_run_id INT
    REFERENCES council_runs(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_evaluations_council_run
  ON deal_evaluations(council_run_id)
  WHERE council_run_id IS NOT NULL;

UPDATE deal_evaluations de
SET council_run_id = cr.id
FROM council_runs cr
WHERE cr.evaluation_id = de.id
  AND de.council_run_id IS NULL;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS promotes_to_canonical BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_evidence_contract_version INT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_source_manifest_sha256 TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_source_coverage_sha256 TEXT;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_research_snapshot_sha256 TEXT;

UPDATE deal_evaluations
SET council_run_type = CASE council_run_type
  WHEN 'score' THEN 'initial'
  WHEN 'refresh' THEN 'research_refresh'
  WHEN 'followup' THEN 'founder_followup'
  WHEN 'replay' THEN 'controlled_replay'
  ELSE council_run_type
END
WHERE council_run_type IS NOT NULL;

UPDATE deal_evaluations de
SET promotes_to_canonical = FALSE
WHERE de.council_run_type IN ('controlled_replay', 'review_import')
   OR EXISTS (
     SELECT 1
     FROM council_runs cr
     WHERE cr.id = de.council_run_id
       AND cr.run_type IN ('controlled_replay', 'review_import')
   );

-- Existing runs become visible as migrated attempt history.
INSERT INTO council_run_events
  (run_id, attempt_number, sequence, occurred_at, event_type, phase, safe_detail)
SELECT
  id,
  attempt_number,
  1,
  started_at,
  'migrated',
  stage,
  'Run existed before the durable event contract'
FROM council_runs
ON CONFLICT (run_id, attempt_number, sequence) DO NOTHING;
