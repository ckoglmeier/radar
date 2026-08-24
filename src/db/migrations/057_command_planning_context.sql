-- Typed planning metadata makes review posture, confidence, and conversation
-- provenance durable alongside the immutable command proposal.

ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'write'
    CHECK (intent IN ('read', 'write', 'correct', 'workflow', 'navigate'));
ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS execution_preference TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (execution_preference IN ('review_required', 'apply_requested', 'unspecified'));
ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS planner_confidence TEXT NOT NULL DEFAULT 'high'
    CHECK (planner_confidence IN ('high', 'medium', 'low'));
ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS planner_warnings JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(planner_warnings) = 'array');
ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS conversation_context JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(conversation_context) = 'object');
ALTER TABLE command_proposals
  ADD COLUMN IF NOT EXISTS provenance_context JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provenance_context) = 'object');

CREATE OR REPLACE FUNCTION enforce_command_planning_context_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.intent IS DISTINCT FROM OLD.intent
     OR NEW.execution_preference IS DISTINCT FROM OLD.execution_preference
     OR NEW.planner_confidence IS DISTINCT FROM OLD.planner_confidence
     OR NEW.planner_warnings IS DISTINCT FROM OLD.planner_warnings
     OR NEW.conversation_context IS DISTINCT FROM OLD.conversation_context
     OR NEW.provenance_context IS DISTINCT FROM OLD.provenance_context THEN
    RAISE EXCEPTION 'command proposal planning context is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS command_planning_context_immutable ON command_proposals;

CREATE TRIGGER command_planning_context_immutable
BEFORE UPDATE ON command_proposals
FOR EACH ROW EXECUTE FUNCTION enforce_command_planning_context_immutable();
