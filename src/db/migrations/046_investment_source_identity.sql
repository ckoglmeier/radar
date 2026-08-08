-- Migration 046: stable importer links before removing the legacy
-- (company_name, invest_date) uniqueness constraint.

CREATE TABLE IF NOT EXISTS investment_source_identities (
  id SERIAL PRIMARY KEY,
  investment_id INT NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_key)
);

CREATE INDEX IF NOT EXISTS idx_investment_source_identities_investment
  ON investment_source_identities(investment_id);

CREATE INDEX IF NOT EXISTS idx_investments_company_date_lookup
  ON investments(company_name, invest_date);

INSERT INTO investment_source_identities
  (investment_id, source, source_key, key_version)
SELECT
  id,
  COALESCE(NULLIF(BTRIM(source), ''), 'legacy'),
  'legacy-v1:' || MD5(
    company_name || CHR(31) || COALESCE(TO_CHAR(invest_date, 'YYYY-MM-DD'), '')
  ),
  1
FROM investments
WHERE asset_class <> 'merged'
ON CONFLICT DO NOTHING;
