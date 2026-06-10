-- Migration 014: company_updates
-- Why: Track quarterly investor updates from portfolio companies. Markdown files
-- in updates/ are the source of truth; this table is the queryable index.

CREATE TABLE IF NOT EXISTS company_updates (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  investment_id INT REFERENCES investments(id) ON DELETE SET NULL,
  update_date DATE NOT NULL,
  quarter TEXT,
  revenue_arr NUMERIC(14,2),
  burn_rate NUMERIC(14,2),
  runway_months NUMERIC(5,1),
  headcount INT,
  cash_on_hand NUMERIC(14,2),
  source TEXT DEFAULT 'email',
  attachment_ref TEXT,
  file_path TEXT NOT NULL,
  has_review BOOLEAN DEFAULT false,
  has_feedback BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_name, quarter)
);

CREATE INDEX IF NOT EXISTS idx_company_updates_company ON company_updates(LOWER(company_name));
CREATE INDEX IF NOT EXISTS idx_company_updates_date ON company_updates(update_date DESC);
CREATE INDEX IF NOT EXISTS idx_company_updates_investment ON company_updates(investment_id);
