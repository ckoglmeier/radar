-- Source-backed updates shared by Direct, Fund, and Employment Equity
-- investments. The original document remains authoritative; interpretations
-- are derived, reviewable records and never mutate portfolio facts directly.

CREATE TABLE IF NOT EXISTS investment_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  source_document_id INT NOT NULL UNIQUE REFERENCES documents(id),
  previous_update_id UUID REFERENCES investment_updates(id),
  update_kind TEXT NOT NULL CHECK (
    update_kind IN (
      'founder_update',
      'fund_update',
      'employment_disclosure',
      'valuation_update',
      'financial_update',
      'general'
    )
  ),
  title TEXT,
  received_date DATE NOT NULL,
  processing_mode TEXT NOT NULL CHECK (processing_mode IN ('store_only', 'interpret')),
  status TEXT NOT NULL CHECK (status IN ('stored', 'pending', 'complete', 'failed')),
  summary TEXT,
  observed_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  evaluation_signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  model TEXT,
  error_message TEXT,
  interpreted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investment_updates_investment
  ON investment_updates(investment_id, received_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_investment_updates_status
  ON investment_updates(status, created_at DESC);
