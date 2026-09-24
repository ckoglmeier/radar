-- Drafts are editable. Submitted update payloads are immutable evidence snapshots.
CREATE TABLE IF NOT EXISTS radar_assessment_drafts (
  pipeline_invite_id INT PRIMARY KEY REFERENCES pipeline_invites(id),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS radar_assessment_updates (
  id UUID PRIMARY KEY,
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id),
  base_evaluation_id INT NOT NULL REFERENCES deal_evaluations(id),
  run_id INT UNIQUE NOT NULL REFERENCES council_runs(id),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  evaluation_id INT REFERENCES deal_evaluations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS radar_assessment_updates_invite
  ON radar_assessment_updates(pipeline_invite_id, created_at DESC);
CREATE OR REPLACE FUNCTION radar_assessment_update_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.pipeline_invite_id IS DISTINCT FROM OLD.pipeline_invite_id
    OR NEW.base_evaluation_id IS DISTINCT FROM OLD.base_evaluation_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.evaluation_id IS NOT NULL AND NEW.evaluation_id IS DISTINCT FROM OLD.evaluation_id) THEN
    RAISE EXCEPTION 'Submitted assessment updates are immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS radar_assessment_update_guard ON radar_assessment_updates;
CREATE TRIGGER radar_assessment_update_guard BEFORE UPDATE ON radar_assessment_updates
  FOR EACH ROW EXECUTE FUNCTION radar_assessment_update_guard();
