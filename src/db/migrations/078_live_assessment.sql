-- Migration 078: durable conversational working assessments.
-- Why: preserve focused reasoning changes without rewriting Council evaluations.
CREATE TABLE IF NOT EXISTS live_assessment_sessions (
 evaluation_id INT PRIMARY KEY REFERENCES deal_evaluations(id) ON DELETE CASCADE,
 revision INT NOT NULL DEFAULT 0,
 assessment JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS live_assessment_turns (
 id UUID PRIMARY KEY,
 evaluation_id INT NOT NULL REFERENCES live_assessment_sessions(evaluation_id) ON DELETE CASCADE,
 base_revision INT NOT NULL,
 question TEXT NOT NULL,
 sources JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','complete','failed')),
 response JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS live_assessment_turns_evaluation ON live_assessment_turns(evaluation_id,created_at);
CREATE OR REPLACE FUNCTION admit_live_assessment_turn(p_id UUID,p_eval INT,p_revision INT,p_question TEXT,p_sources JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE s live_assessment_sessions; t live_assessment_turns;
BEGIN
 INSERT INTO live_assessment_sessions(evaluation_id) VALUES(p_eval) ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM live_assessment_sessions WHERE evaluation_id=p_eval FOR UPDATE;
 SELECT * INTO t FROM live_assessment_turns WHERE id=p_id;
 IF FOUND THEN
  IF t.evaluation_id<>p_eval OR t.question<>p_question THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
  RETURN jsonb_build_object('claimed',false,'turn',to_jsonb(t));
 END IF;
 UPDATE live_assessment_turns SET status='failed',finished_at=now() WHERE evaluation_id=p_eval AND status='running' AND created_at<now()-interval '10 minutes';
 IF EXISTS(SELECT 1 FROM live_assessment_turns WHERE evaluation_id=p_eval AND status='running') THEN RAISE EXCEPTION 'TURN_ACTIVE'; END IF;
 IF s.revision<>p_revision THEN RAISE EXCEPTION 'ASSESSMENT_CHANGED'; END IF;
 INSERT INTO live_assessment_turns(id,evaluation_id,base_revision,question,sources,status) VALUES(p_id,p_eval,p_revision,p_question,p_sources,'running') RETURNING * INTO t;
 RETURN jsonb_build_object('claimed',true,'turn',to_jsonb(t),'assessment',s.assessment);
END $$;
CREATE OR REPLACE FUNCTION complete_live_assessment_turn(p_id UUID,p_response JSONB)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE t live_assessment_turns; s live_assessment_sessions;
BEGIN
 SELECT * INTO t FROM live_assessment_turns WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'TURN_MISSING'; END IF;
 SELECT * INTO s FROM live_assessment_sessions WHERE evaluation_id=t.evaluation_id FOR UPDATE;
 SELECT * INTO t FROM live_assessment_turns WHERE id=p_id FOR UPDATE;
 IF t.status<>'running' OR s.revision<>t.base_revision THEN RAISE EXCEPTION 'ASSESSMENT_CHANGED'; END IF;
 IF p_response->'assessment'->>'policy' IS DISTINCT FROM 'live-assessment-v1'
 OR p_response->'assessment'->>'snapshotId' IS DISTINCT FROM p_id::text
 OR (p_response->'assessment'->>'revision')::INT IS DISTINCT FROM s.revision+1
 OR (p_response->'assessment'->>'parentRevision')::INT IS DISTINCT FROM s.revision
 THEN RAISE EXCEPTION 'ASSESSMENT_INVALID'; END IF;
 UPDATE live_assessment_turns SET status='complete',response=p_response,finished_at=now() WHERE id=p_id;
 UPDATE live_assessment_sessions SET revision=revision+1,assessment=p_response->'assessment' WHERE evaluation_id=t.evaluation_id;
END $$;
CREATE OR REPLACE FUNCTION live_assessment_turn_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status<>'running' OR NEW.id<>OLD.id OR NEW.evaluation_id<>OLD.evaluation_id OR NEW.base_revision<>OLD.base_revision OR NEW.question<>OLD.question OR NEW.sources<>OLD.sources THEN RAISE EXCEPTION 'TURN_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS live_assessment_turn_guard ON live_assessment_turns;
CREATE TRIGGER live_assessment_turn_guard BEFORE UPDATE ON live_assessment_turns FOR EACH ROW EXECUTE FUNCTION live_assessment_turn_guard();
