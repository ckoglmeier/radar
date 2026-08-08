-- Migration 042: add typed Fund profiles, notices, and transaction metadata.
-- Why: Fund commitments, notices, settled cash, and NAV require distinct facts
-- with database-enforced links to Fund positions.

CREATE TABLE IF NOT EXISTS fund_profiles (
  investment_id INT PRIMARY KEY REFERENCES investments(id),
  manager TEXT,
  strategy TEXT,
  vintage_year INT CHECK (
    vintage_year IS NULL OR vintage_year BETWEEN 1900 AND 2100
  ),
  commitment NUMERIC(14,2) CHECK (
    commitment IS NULL OR commitment >= 0
  ),
  fund_status TEXT NOT NULL DEFAULT 'active' CHECK (
    fund_status IN ('active', 'harvesting', 'realized', 'written_off')
  ),
  description TEXT,
  archived_at TIMESTAMPTZ,
  migration_source_room_holding_id INT UNIQUE REFERENCES room_holdings(id) ON DELETE SET NULL,
  migration_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fund_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  notice_type TEXT NOT NULL CHECK (notice_type IN ('capital_call', 'distribution')),
  notice_date DATE NOT NULL,
  due_date DATE,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  description TEXT,
  external_hash TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (due_date IS NULL OR due_date >= notice_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_notices_investment
  ON fund_notices(investment_id, notice_date DESC);

CREATE TABLE IF NOT EXISTS fund_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  cash_flow_id INT NOT NULL UNIQUE REFERENCES cash_flows(id),
  notice_id UUID REFERENCES fund_notices(id),
  activity_type TEXT NOT NULL CHECK (
    activity_type IN ('contribution', 'distribution', 'fee')
  ),
  external_hash TEXT UNIQUE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (voided_at IS NULL AND void_reason IS NULL) OR
    (voided_at IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_fund_transactions_investment
  ON fund_transactions(investment_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fund_transactions_current_notice
  ON fund_transactions(notice_id)
  WHERE notice_id IS NOT NULL AND voided_at IS NULL;

CREATE OR REPLACE FUNCTION validate_fund_position_link()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  linked_entity_type TEXT;
BEGIN
  SELECT i.asset_class, pe.entity_type
    INTO linked_class, linked_entity_type
    FROM investments i
    LEFT JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
   WHERE i.id = NEW.investment_id;

  IF linked_class IS DISTINCT FROM 'fund' OR linked_entity_type IS DISTINCT FROM 'fund_vehicle' THEN
    RAISE EXCEPTION 'fund record requires a Fund position linked to a fund_vehicle entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fund_profiles_position_guard ON fund_profiles;
CREATE TRIGGER fund_profiles_position_guard
  BEFORE INSERT OR UPDATE ON fund_profiles
  FOR EACH ROW EXECUTE FUNCTION validate_fund_position_link();

DROP TRIGGER IF EXISTS fund_notices_position_guard ON fund_notices;
CREATE TRIGGER fund_notices_position_guard
  BEFORE INSERT OR UPDATE ON fund_notices
  FOR EACH ROW EXECUTE FUNCTION validate_fund_position_link();

CREATE OR REPLACE FUNCTION validate_fund_transaction_link()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  linked_entity_type TEXT;
  flow_investment_id INT;
  flow_type TEXT;
  flow_amount NUMERIC;
  notice_investment_id INT;
BEGIN
  SELECT i.asset_class, pe.entity_type
    INTO linked_class, linked_entity_type
    FROM investments i
    LEFT JOIN portfolio_entities pe ON pe.id = i.portfolio_entity_id
   WHERE i.id = NEW.investment_id;

  IF linked_class IS DISTINCT FROM 'fund' OR linked_entity_type IS DISTINCT FROM 'fund_vehicle' THEN
    RAISE EXCEPTION 'fund transaction requires a Fund position linked to a fund_vehicle entity';
  END IF;

  SELECT investment_id, type, amount
    INTO flow_investment_id, flow_type, flow_amount
    FROM cash_flows
   WHERE id = NEW.cash_flow_id;

  IF flow_investment_id IS DISTINCT FROM NEW.investment_id THEN
    RAISE EXCEPTION 'fund transaction cash flow belongs to another position';
  END IF;
  IF NEW.activity_type = 'contribution' AND NOT (flow_type = 'investment' AND flow_amount < 0) THEN
    RAISE EXCEPTION 'contribution requires a negative investment cash flow';
  END IF;
  IF NEW.activity_type = 'distribution' AND NOT (flow_type IN ('distribution', 'refund') AND flow_amount > 0) THEN
    RAISE EXCEPTION 'distribution requires a positive distribution or refund cash flow';
  END IF;
  IF NEW.activity_type = 'fee' AND NOT (flow_type = 'fee' AND flow_amount < 0) THEN
    RAISE EXCEPTION 'fee requires a negative fee cash flow';
  END IF;

  IF NEW.notice_id IS NOT NULL THEN
    SELECT investment_id INTO notice_investment_id
      FROM fund_notices WHERE id = NEW.notice_id;
    IF notice_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'fund transaction notice belongs to another position';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fund_transactions_link_guard ON fund_transactions;
CREATE TRIGGER fund_transactions_link_guard
  BEFORE INSERT OR UPDATE ON fund_transactions
  FOR EACH ROW EXECUTE FUNCTION validate_fund_transaction_link();

CREATE OR REPLACE FUNCTION protect_posted_fund_transaction()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.investment_id IS DISTINCT FROM NEW.investment_id
     OR OLD.cash_flow_id IS DISTINCT FROM NEW.cash_flow_id
     OR OLD.notice_id IS DISTINCT FROM NEW.notice_id
     OR OLD.activity_type IS DISTINCT FROM NEW.activity_type
     OR OLD.external_hash IS DISTINCT FROM NEW.external_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'posted fund transaction facts are immutable';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'voided fund transaction cannot be edited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fund_transactions_immutable_guard ON fund_transactions;
CREATE TRIGGER fund_transactions_immutable_guard
  BEFORE UPDATE ON fund_transactions
  FOR EACH ROW EXECUTE FUNCTION protect_posted_fund_transaction();

CREATE OR REPLACE FUNCTION protect_fund_cash_flow()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM fund_transactions
     WHERE cash_flow_id = OLD.id AND voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'posted Fund cash-flow facts are immutable; void and replace the Fund transaction';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fund_cash_flows_immutable_guard ON cash_flows;
CREATE TRIGGER fund_cash_flows_immutable_guard
  BEFORE UPDATE OR DELETE ON cash_flows
  FOR EACH ROW EXECUTE FUNCTION protect_fund_cash_flow();

CREATE OR REPLACE FUNCTION protect_fund_notice()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.investment_id IS DISTINCT FROM NEW.investment_id
     OR OLD.notice_type IS DISTINCT FROM NEW.notice_type
     OR OLD.notice_date IS DISTINCT FROM NEW.notice_date
     OR OLD.due_date IS DISTINCT FROM NEW.due_date
     OR OLD.amount IS DISTINCT FROM NEW.amount
     OR OLD.external_hash IS DISTINCT FROM NEW.external_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Fund notice facts are immutable';
  END IF;
  IF OLD.status IN ('settled', 'cancelled') AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'settled or cancelled Fund notice cannot be edited';
  END IF;
  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'settled', 'cancelled') THEN
    RAISE EXCEPTION 'invalid Fund notice status transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fund_notices_immutable_guard ON fund_notices;
CREATE TRIGGER fund_notices_immutable_guard
  BEFORE UPDATE ON fund_notices
  FOR EACH ROW EXECUTE FUNCTION protect_fund_notice();
