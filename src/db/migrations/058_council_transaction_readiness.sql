-- Migration 058: Persist the transaction interpretation and explicit question resolution.

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS council_transaction_assessment JSONB;

ALTER TABLE council_followup_questions
  ADD COLUMN IF NOT EXISTS resolution_state TEXT NOT NULL DEFAULT 'open'
    CHECK (resolution_state IN ('open', 'resolved', 'insufficient'));

UPDATE council_followup_questions
SET resolution_state = 'resolved'
WHERE applied_evaluation_id IS NOT NULL
  AND resolution_state = 'open';
