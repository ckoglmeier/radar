-- Migration 034: Make Council uncertainty and founder follow-up durable.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_dimension_scores JSONB;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_evidence_assessments JSONB;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_rubric_snapshot JSONB;

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_parent_evaluation_id INT
    REFERENCES deal_evaluations(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS council_followup_questions (
  id SERIAL PRIMARY KEY,
  pipeline_invite_id INT NOT NULL REFERENCES pipeline_invites(id) ON DELETE CASCADE,
  evaluation_id INT NOT NULL REFERENCES deal_evaluations(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  question TEXT NOT NULL,
  why_it_matters TEXT,
  rubric_dimension TEXT,
  priority TEXT NOT NULL DEFAULT 'helpful'
    CHECK (priority IN ('critical', 'helpful')),
  current_likert NUMERIC(3,1),
  upside_likert NUMERIC(3,1),
  downside_likert NUMERIC(3,1),
  upside_points NUMERIC(5,1),
  downside_points NUMERIC(5,1),
  answer TEXT,
  answer_source TEXT NOT NULL DEFAULT 'founder',
  answered_at TIMESTAMPTZ,
  applied_evaluation_id INT REFERENCES deal_evaluations(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(evaluation_id, question_key)
);

CREATE INDEX IF NOT EXISTS idx_council_followups_invite
  ON council_followup_questions(pipeline_invite_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_council_followups_pending
  ON council_followup_questions(pipeline_invite_id)
  WHERE answer IS NOT NULL AND applied_evaluation_id IS NULL;
