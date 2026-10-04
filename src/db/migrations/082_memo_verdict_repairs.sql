-- Migration 082: preserve original evaluation records before recommendation repair.
-- Why: transaction recommendations must not contradict the saved final verdict.
CREATE TABLE IF NOT EXISTS memo_verdict_repairs (
  evaluation_id INTEGER PRIMARY KEY REFERENCES deal_evaluations(id) ON DELETE CASCADE,
  original_evaluation JSONB NOT NULL,
  repaired_content_hash TEXT,
  repaired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
