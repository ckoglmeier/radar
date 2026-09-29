-- Adopt the host tables previously created lazily by the desktop app.
-- Existing rows and constraints are preserved on upgrade.
CREATE TABLE IF NOT EXISTS radar_host_proposals (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id),
  base_evaluation_id INT NOT NULL REFERENCES deal_evaluations(id),
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  diff_summary JSONB NOT NULL CHECK (jsonb_typeof(diff_summary) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','applied','rejected','superseded','expired')),
  origin TEXT NOT NULL DEFAULT 'host' CHECK (origin = 'host'),
  result_evaluation_id INT REFERENCES deal_evaluations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS radar_host_proposals_invite ON radar_host_proposals(pipeline_invite_id, created_at DESC);

CREATE TABLE IF NOT EXISTS radar_host_job_requests (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id),
  kind TEXT NOT NULL CHECK (kind IN ('full_evaluation','reassessment')),
  base_evaluation_id INT REFERENCES deal_evaluations(id),
  host_proposal_id UUID,
  idempotency_key TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  plan_snapshot JSONB NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'array'),
  plan_fingerprint TEXT NOT NULL,
  estimate JSONB NOT NULL CHECK (jsonb_typeof(estimate) = 'object'),
  approvable BOOLEAN NOT NULL,
  blocked_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected','cancelled','expired')),
  origin TEXT NOT NULL DEFAULT 'host' CHECK (origin = 'host'),
  approved_plan JSONB,
  run_id INT REFERENCES council_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS radar_host_job_requests_invite ON radar_host_job_requests(pipeline_invite_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS radar_host_job_requests_run ON radar_host_job_requests(run_id) WHERE run_id IS NOT NULL;
