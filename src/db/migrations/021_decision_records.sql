-- Migration 021: decision records
-- Why: Persist sealed investment decisions for the Phase 8 closed-loop workflow.

CREATE TABLE IF NOT EXISTS decision_records (
  id SERIAL PRIMARY KEY,
  investment_id INT REFERENCES investments(id) ON DELETE SET NULL,
  pipeline_invite_id INT REFERENCES pipeline_invites(id) ON DELETE SET NULL,
  deal_evaluation_id INT REFERENCES deal_evaluations(id) ON DELETE SET NULL,
  decision TEXT,
  what_was_known TEXT,
  what_was_believed TEXT,
  key_risks TEXT,
  bear_view TEXT,
  confidence SMALLINT CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 5)),
  chosen_size NUMERIC(12,2),
  sizing_basis JSONB,
  review_due DATE,
  sealed BOOLEAN DEFAULT FALSE,
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_records_investment ON decision_records(investment_id);
CREATE INDEX IF NOT EXISTS idx_decision_records_pipeline_invite ON decision_records(pipeline_invite_id);
CREATE INDEX IF NOT EXISTS idx_decision_records_deal_evaluation ON decision_records(deal_evaluation_id);
CREATE INDEX IF NOT EXISTS idx_decision_records_review_due ON decision_records(review_due);
