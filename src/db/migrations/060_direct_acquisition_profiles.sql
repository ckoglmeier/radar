-- Migration 060: typed acquisition and pricing facts for Direct positions.
--
-- The security held is not necessarily the financing round that priced the
-- acquisition. Historical investments.round values remain legacy hints and
-- are intentionally not backfilled into this relation.

CREATE TABLE IF NOT EXISTS direct_acquisition_profiles (
  investment_id INT PRIMARY KEY REFERENCES investments(id) ON DELETE CASCADE,
  acquisition_date DATE NOT NULL,
  acquisition_type TEXT NOT NULL CHECK (
    acquisition_type IN ('primary', 'secondary', 'mixed', 'unknown')
  ),
  security_class TEXT,
  pricing_reference_round TEXT,
  entry_post_money_valuation NUMERIC(18,2) CHECK (
    entry_post_money_valuation IS NULL OR entry_post_money_valuation >= 0
  ),
  entry_price_per_share NUMERIC(20,8) CHECK (
    entry_price_per_share IS NULL OR entry_price_per_share >= 0
  ),
  shares_acquired NUMERIC(20,8) CHECK (
    shares_acquired IS NULL OR shares_acquired >= 0
  ),
  shares_remaining NUMERIC(20,8) CHECK (
    shares_remaining IS NULL OR shares_remaining >= 0
  ),
  economic_parity_status TEXT NOT NULL CHECK (
    economic_parity_status IN ('confirmed', 'assumed', 'unknown', 'not_applicable')
  ),
  source_document_id INT REFERENCES documents(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    shares_acquired IS NULL OR shares_remaining IS NULL OR
    shares_remaining <= shares_acquired
  )
);

CREATE OR REPLACE FUNCTION validate_direct_acquisition_profile()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
BEGIN
  SELECT asset_class INTO linked_class
    FROM investments WHERE id = NEW.investment_id;
  IF linked_class IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION 'Direct acquisition profile requires a Direct position';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS direct_acquisition_profile_link_guard
  ON direct_acquisition_profiles;
CREATE TRIGGER direct_acquisition_profile_link_guard
  BEFORE INSERT OR UPDATE ON direct_acquisition_profiles
  FOR EACH ROW EXECUTE FUNCTION validate_direct_acquisition_profile();
