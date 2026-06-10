-- Private Market Investment Tracker Schema

CREATE TABLE IF NOT EXISTS investments (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL,
  status TEXT,
  invest_date DATE,
  invested NUMERIC(12,2),
  unrealized_value NUMERIC(12,2),
  realized_value NUMERIC(12,2),
  net_value NUMERIC(12,2),
  multiple NUMERIC(10,6),
  investment_entity TEXT,
  lead TEXT,
  investment_type TEXT,
  round TEXT,
  market TEXT,
  fund_name TEXT,
  allocation NUMERIC(14,2),
  instrument TEXT,
  round_size NUMERIC(14,2),
  valuation_cap_type TEXT,
  valuation_cap NUMERIC(16,2),
  discount NUMERIC(5,2),
  carry TEXT,
  share_class TEXT,
  source TEXT DEFAULT 'angellist',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_name, invest_date)
);

CREATE TABLE IF NOT EXISTS theses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_theses (
  investment_id INT REFERENCES investments(id) ON DELETE CASCADE,
  thesis_id INT REFERENCES theses(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT FALSE,
  confidence TEXT DEFAULT 'auto',
  tagged_by TEXT DEFAULT 'system',
  PRIMARY KEY (investment_id, thesis_id)
);

CREATE TABLE IF NOT EXISTS valuations (
  id SERIAL PRIMARY KEY,
  investment_id INT REFERENCES investments(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  unrealized_value NUMERIC(12,2),
  realized_value NUMERIC(12,2),
  net_value NUMERIC(12,2),
  multiple NUMERIC(10,6),
  source TEXT DEFAULT 'angellist',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_flows (
  id SERIAL PRIMARY KEY,
  investment_id INT REFERENCES investments(id) ON DELETE SET NULL,
  flow_date DATE NOT NULL,
  type TEXT NOT NULL, -- investment, refund, distribution, deposit, withdrawal, transfer, adjustment, fee
  subtype TEXT,       -- e.g., 'return_of_capital', 'secondary_sale', 'escrow_release', 'dissolution', 'closing_proceeds'
  amount NUMERIC(12,2) NOT NULL, -- signed: negative = capital out, positive = capital in
  running_balance NUMERIC(14,2),
  description TEXT,
  company_raw TEXT,   -- company name parsed from description (pre-match)
  spv_raw TEXT,       -- SPV / lead parsed from description
  source TEXT DEFAULT 'angellist_ledger',
  external_hash TEXT UNIQUE, -- for idempotent upserts: hash of (date|type|description|amount)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_flows_investment ON cash_flows(investment_id);
CREATE INDEX IF NOT EXISTS idx_cash_flows_date ON cash_flows(flow_date);
CREATE INDEX IF NOT EXISTS idx_cash_flows_type ON cash_flows(type);

-- deal_evaluations is defined after pipeline_invites below (forward reference)

CREATE TABLE IF NOT EXISTS pipeline_invites (
  id SERIAL PRIMARY KEY,
  -- Email source
  gmail_message_id TEXT UNIQUE,
  email_received_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'email',
  -- Identity
  deal_slug TEXT UNIQUE,
  company_name TEXT NOT NULL,
  company_aliases TEXT,
  -- Deal terms
  lead TEXT,
  co_investors TEXT,
  market TEXT,
  round TEXT,
  allocation_usd NUMERIC(14,2),
  min_investment_usd NUMERIC(12,2),
  carry_pct NUMERIC(5,2),
  syndicate_investment_usd NUMERIC(14,2),
  valuation_text TEXT,
  valuation_usd NUMERIC(16,2),
  -- Pitch
  gp_message TEXT,
  -- URLs
  dataroom_url TEXT,
  detail_url TEXT,
  -- State
  status TEXT NOT NULL DEFAULT 'invite',
  detail_synced_at TIMESTAMPTZ,
  detail_markdown_path TEXT,
  -- Linking
  investment_id INT REFERENCES investments(id) ON DELETE SET NULL,
  -- Bookkeeping
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_invites_status ON pipeline_invites(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_invites_company ON pipeline_invites(LOWER(company_name));

CREATE TABLE IF NOT EXISTS pipeline_events (
  id SERIAL PRIMARY KEY,
  invite_id INT REFERENCES pipeline_invites(id) ON DELETE CASCADE,
  event_date TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_invite ON pipeline_events(invite_id);

CREATE TABLE IF NOT EXISTS deal_evaluations (
  id SERIAL PRIMARY KEY,
  investment_id INT REFERENCES investments(id) ON DELETE CASCADE,
  pipeline_invite_id INT REFERENCES pipeline_invites(id) ON DELETE SET NULL,
  eval_date DATE,
  file_path TEXT,
  thesis_fit_score NUMERIC(4,1),
  viability_score NUMERIC(4,1),
  total_score NUMERIC(4,1),
  verdict TEXT,
  invested BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_evaluations_pipeline ON deal_evaluations(pipeline_invite_id);
CREATE INDEX IF NOT EXISTS idx_deal_evaluations_investment ON deal_evaluations(investment_id);

CREATE TABLE IF NOT EXISTS sync_runs (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  records_seen INT DEFAULT 0,
  records_new INT DEFAULT 0,
  records_changed INT DEFAULT 0,
  errors INT DEFAULT 0,
  notes TEXT
);

-- Stage bucket column (added post-initial schema; safe to re-run)
ALTER TABLE investments ADD COLUMN IF NOT EXISTS stage_bucket TEXT;
CREATE INDEX IF NOT EXISTS investments_stage_bucket_idx ON investments(stage_bucket);

-- Seed the 4 thesis clusters
INSERT INTO theses (name, description) VALUES
  ('AI Infrastructure & Safety', 'Inference/training compute, safety tooling, developer infrastructure, core models'),
  ('Hard Tech That Reprices What''s Possible', 'Fusion, launch/propulsion, autonomous machines, novel semiconductors, climate tech'),
  ('Intelligence for Physical Systems', 'Sensor-to-decision systems for logistics, agriculture, maritime, industrial IoT'),
  ('Resilient Systems', 'Human systems resilience (skills, workforce, credentialing) and ecological systems resilience (pollination, food systems, environmental monitoring)')
ON CONFLICT (name) DO NOTHING;
