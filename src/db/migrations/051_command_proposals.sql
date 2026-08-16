-- Immutable, reviewable command proposals shared by Ask Radar, source-backed
-- updates, MCP, future API adapters, and migrated forms. Domain facts remain
-- in their typed ledgers; this table records approval and execution history.

CREATE TABLE IF NOT EXISTS command_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version INT NOT NULL CHECK (schema_version > 0),
  normalizer_version INT NOT NULL CHECK (normalizer_version > 0),
  registry_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'applied', 'rejected', 'stale', 'failed', 'superseded')
  ),
  origin_surface TEXT NOT NULL CHECK (
    origin_surface IN ('ask_radar', 'investment_update', 'mcp', 'api', 'manual_ui', 'import')
  ),
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  intent_text TEXT,
  source_document_id INT REFERENCES documents(id),
  source_update_id UUID REFERENCES investment_updates(id),
  commands JSONB NOT NULL CHECK (
    jsonb_typeof(commands) = 'array' AND jsonb_array_length(commands) > 0
  ),
  previews JSONB NOT NULL CHECK (jsonb_typeof(previews) = 'array'),
  command_set_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  supersedes_proposal_id UUID REFERENCES command_proposals(id),
  planner_provider TEXT,
  planner_model TEXT,
  planner_run_key TEXT,
  result JSONB,
  error_code TEXT,
  error_message TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (supersedes_proposal_id IS NULL OR supersedes_proposal_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_command_proposals_status
  ON command_proposals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_command_proposals_origin
  ON command_proposals(origin_surface, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_command_proposals_source_update
  ON command_proposals(source_update_id, created_at DESC)
  WHERE source_update_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_command_proposal_contract()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'terminal command proposals are immutable';
    END IF;
    IF NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.normalizer_version IS DISTINCT FROM OLD.normalizer_version
       OR NEW.registry_version IS DISTINCT FROM OLD.registry_version
       OR NEW.origin_surface IS DISTINCT FROM OLD.origin_surface
       OR NEW.actor_type IS DISTINCT FROM OLD.actor_type
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
       OR NEW.intent_text IS DISTINCT FROM OLD.intent_text
       OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
       OR NEW.source_update_id IS DISTINCT FROM OLD.source_update_id
       OR NEW.commands IS DISTINCT FROM OLD.commands
       OR NEW.previews IS DISTINCT FROM OLD.previews
       OR NEW.command_set_hash IS DISTINCT FROM OLD.command_set_hash
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.supersedes_proposal_id IS DISTINCT FROM OLD.supersedes_proposal_id
       OR NEW.planner_provider IS DISTINCT FROM OLD.planner_provider
       OR NEW.planner_model IS DISTINCT FROM OLD.planner_model
       OR NEW.planner_run_key IS DISTINCT FROM OLD.planner_run_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'command proposal payload is immutable';
    END IF;
    IF NEW.status = 'proposed' OR NEW.status NOT IN (
      'applied', 'rejected', 'stale', 'failed', 'superseded'
    ) THEN
      RAISE EXCEPTION 'invalid command proposal transition: % -> %', OLD.status, NEW.status;
    END IF;
  ELSIF NEW.status <> 'proposed' THEN
    RAISE EXCEPTION 'new command proposals must start proposed';
  END IF;

  IF NEW.status = 'proposed' THEN
    IF NEW.result IS NOT NULL OR NEW.error_code IS NOT NULL OR NEW.error_message IS NOT NULL
       OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
       OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'proposed command proposal has terminal fields';
    END IF;
  ELSIF NEW.status = 'applied' THEN
    IF NEW.result IS NULL OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL
       OR NEW.applied_at IS NULL OR NEW.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'applied command proposal requires receipt and reviewer';
    END IF;
  ELSIF NEW.status = 'rejected' THEN
    IF NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR NEW.result IS NOT NULL
       OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'rejected command proposal requires reviewer and no receipt';
    END IF;
  ELSIF NEW.status = 'failed' THEN
    IF NEW.error_code IS NULL OR NEW.result IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'failed command proposal requires an error and no receipt';
    END IF;
  ELSE
    IF NEW.result IS NOT NULL OR NEW.applied_at IS NOT NULL THEN
      RAISE EXCEPTION 'non-applied command proposal cannot carry a receipt';
    END IF;
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS command_proposals_contract ON command_proposals;

CREATE TRIGGER command_proposals_contract
BEFORE INSERT OR UPDATE ON command_proposals
FOR EACH ROW EXECUTE FUNCTION enforce_command_proposal_contract();
