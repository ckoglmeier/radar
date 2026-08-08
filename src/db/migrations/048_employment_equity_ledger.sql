-- Migration 048: typed Employment Equity positions, grants, lots, events,
-- valuation details, and issuer disclosures. Vesting schedules are deferred
-- until reviewed source evidence proves one is needed.

CREATE TABLE IF NOT EXISTS employment_equity_issuer_profiles (
  portfolio_entity_id UUID PRIMARY KEY REFERENCES portfolio_entities(id),
  relationship_status TEXT NOT NULL CHECK (
    relationship_status IN ('current_employee', 'former_employee', 'other')
  ),
  employment_start_date DATE,
  employment_end_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    employment_end_date IS NULL OR employment_start_date IS NULL OR
    employment_end_date >= employment_start_date
  )
);

CREATE TABLE IF NOT EXISTS employment_equity_positions (
  investment_id INT PRIMARY KEY REFERENCES investments(id),
  display_name TEXT NOT NULL,
  instrument_family TEXT NOT NULL CHECK (
    instrument_family IN ('ppu', 'common_stock', 'iso', 'nso', 'rsu', 'profits_interest', 'other')
  ),
  acquisition_origin TEXT NOT NULL DEFAULT 'employment' CHECK (
    acquisition_origin = 'employment'
  ),
  position_status TEXT NOT NULL DEFAULT 'active' CHECK (
    position_status IN ('active', 'partially_realized', 'realized', 'forfeited', 'archived')
  ),
  description TEXT,
  archived_at TIMESTAMPTZ,
  migration_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (position_status = 'archived' AND archived_at IS NOT NULL) OR
    (position_status <> 'archived' AND archived_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS employment_equity_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  grant_identifier TEXT,
  legal_instrument_name TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (
    instrument_type IN ('ppu', 'common_stock', 'iso', 'nso', 'rsu', 'profits_interest', 'other')
  ),
  grant_date DATE NOT NULL,
  service_start_date DATE,
  share_or_unit_class TEXT,
  units_granted NUMERIC(20,6) NOT NULL CHECK (units_granted > 0),
  units_vested_confirmed NUMERIC(20,6) CHECK (
    units_vested_confirmed IS NULL OR units_vested_confirmed BETWEEN 0 AND units_granted
  ),
  units_forfeited_confirmed NUMERIC(20,6) CHECK (
    units_forfeited_confirmed IS NULL OR units_forfeited_confirmed BETWEEN 0 AND units_granted
  ),
  units_expired_confirmed NUMERIC(20,6) CHECK (
    units_expired_confirmed IS NULL OR units_expired_confirmed BETWEEN 0 AND units_granted
  ),
  balance_as_of_date DATE,
  strike_price NUMERIC(18,6) CHECK (strike_price IS NULL OR strike_price >= 0),
  expiration_date DATE,
  hurdle_amount NUMERIC(18,2) CHECK (hurdle_amount IS NULL OR hurdle_amount >= 0),
  vesting_terms_summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'fully_vested', 'exercised', 'settled', 'forfeited', 'cancelled', 'expired')
  ),
  terms_document_id INT REFERENCES documents(id),
  migration_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expiration_date IS NULL OR expiration_date >= grant_date),
  CHECK (
    COALESCE(units_forfeited_confirmed, 0) +
    COALESCE(units_expired_confirmed, 0) <= units_granted
  ),
  CHECK (
    instrument_type NOT IN ('iso', 'nso') OR strike_price IS NOT NULL OR status = 'cancelled'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_grants_identifier
  ON employment_equity_grants(investment_id, grant_identifier)
  WHERE grant_identifier IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ee_grants_investment
  ON employment_equity_grants(investment_id, grant_date, id);

CREATE TABLE IF NOT EXISTS investment_lots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  grant_id UUID REFERENCES employment_equity_grants(id),
  acquisition_date DATE NOT NULL,
  tax_holding_start_date DATE,
  instrument_type TEXT NOT NULL CHECK (
    instrument_type IN (
      'ppu', 'common_stock', 'iso', 'nso', 'rsu', 'preferred_stock',
      'profits_interest', 'safe', 'convertible_note', 'other'
    )
  ),
  share_or_unit_class TEXT,
  units_acquired NUMERIC(20,6),
  units_remaining NUMERIC(20,6),
  acquisition_price_per_unit NUMERIC(18,6) CHECK (
    acquisition_price_per_unit IS NULL OR acquisition_price_per_unit >= 0
  ),
  fair_market_value_per_unit NUMERIC(18,6) CHECK (
    fair_market_value_per_unit IS NULL OR fair_market_value_per_unit >= 0
  ),
  fair_market_value_date DATE,
  cash_outlay NUMERIC(18,2) CHECK (cash_outlay IS NULL OR cash_outlay >= 0),
  tax_basis NUMERIC(18,2) CHECK (tax_basis IS NULL OR tax_basis >= 0),
  compensation_basis NUMERIC(18,2) CHECK (compensation_basis IS NULL OR compensation_basis >= 0),
  basis_as_of_date DATE,
  basis_source TEXT CHECK (
    basis_source IS NULL OR basis_source IN (
      'manual', 'grant_document', 'exercise_confirmation', 'tax_record',
      'company_statement', 'other'
    )
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'partially_disposed', 'disposed', 'forfeited')
  ),
  source_document_id INT REFERENCES documents(id),
  migration_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (units_acquired IS NULL AND units_remaining IS NULL) OR
    (units_acquired > 0 AND units_remaining BETWEEN 0 AND units_acquired)
  )
);

CREATE INDEX IF NOT EXISTS idx_investment_lots_position
  ON investment_lots(investment_id, acquisition_date, id);

CREATE TABLE IF NOT EXISTS employment_equity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  grant_id UUID REFERENCES employment_equity_grants(id),
  lot_id UUID REFERENCES investment_lots(id),
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'grant', 'vest', 'exercise', 'settlement', 'conversion',
      'distribution', 'sale', 'tender', 'repurchase', 'forfeiture',
      'expiration', 'split', 'recapitalization', 'basis_adjustment'
    )
  ),
  event_date DATE NOT NULL,
  units NUMERIC(20,6) CHECK (units IS NULL OR units > 0),
  gross_amount NUMERIC(18,2) CHECK (gross_amount IS NULL OR gross_amount >= 0),
  price_per_unit NUMERIC(18,6) CHECK (price_per_unit IS NULL OR price_per_unit >= 0),
  cash_flow_id INT UNIQUE REFERENCES cash_flows(id),
  source_document_id INT REFERENCES documents(id),
  notes TEXT,
  external_hash TEXT UNIQUE,
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  replacement_event_id UUID REFERENCES employment_equity_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (voided_at IS NULL AND void_reason IS NULL) OR
    (voided_at IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ee_events_position
  ON employment_equity_events(investment_id, event_date, id);

CREATE TABLE IF NOT EXISTS investment_lot_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id UUID NOT NULL REFERENCES investment_lots(id),
  event_id UUID NOT NULL REFERENCES employment_equity_events(id),
  cash_flow_id INT REFERENCES cash_flows(id),
  disposition_date DATE NOT NULL,
  units_disposed NUMERIC(20,6) NOT NULL CHECK (units_disposed > 0),
  gross_proceeds_allocated NUMERIC(18,2) CHECK (
    gross_proceeds_allocated IS NULL OR gross_proceeds_allocated >= 0
  ),
  tax_basis_allocated NUMERIC(18,2) CHECK (
    tax_basis_allocated IS NULL OR tax_basis_allocated >= 0
  ),
  allocation_method TEXT NOT NULL DEFAULT 'manual' CHECK (allocation_method = 'manual'),
  source_document_id INT REFERENCES documents(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, lot_id)
);

CREATE INDEX IF NOT EXISTS idx_lot_allocations_lot
  ON investment_lot_allocations(lot_id, disposition_date, id);

CREATE TABLE IF NOT EXISTS employment_equity_valuation_details (
  valuation_id INT PRIMARY KEY REFERENCES valuations(id),
  methodology TEXT NOT NULL CHECK (
    methodology IN ('company_statement', 'common_fmv', 'tender', 'waterfall', 'manual', 'other')
  ),
  vested_value NUMERIC(18,2) NOT NULL CHECK (vested_value >= 0),
  unvested_value NUMERIC(18,2) CHECK (unvested_value IS NULL OR unvested_value >= 0),
  common_fmv_per_unit NUMERIC(18,6) CHECK (
    common_fmv_per_unit IS NULL OR common_fmv_per_unit >= 0
  ),
  issuer_equity_value NUMERIC(18,2) CHECK (
    issuer_equity_value IS NULL OR issuer_equity_value >= 0
  ),
  hurdle_amount NUMERIC(18,2) CHECK (hurdle_amount IS NULL OR hurdle_amount >= 0),
  liquidity_haircut_pct NUMERIC(7,4) CHECK (
    liquidity_haircut_pct IS NULL OR liquidity_haircut_pct BETWEEN 0 AND 100
  ),
  confidence TEXT NOT NULL CHECK (
    confidence IN ('company_reported', 'calculated', 'estimated')
  ),
  source_document_id INT REFERENCES documents(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issuer_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_entity_id UUID NOT NULL REFERENCES portfolio_entities(id),
  document_id INT NOT NULL UNIQUE REFERENCES documents(id),
  disclosure_type TEXT NOT NULL CHECK (
    disclosure_type IN (
      'rule_701', 'plan_document', 'grant_agreement', '409a',
      'tender_notice', 'cap_table_statement', 'k1', 'tax_election',
      'exercise_confirmation', 'company_financials', 'other'
    )
  ),
  received_date DATE,
  financials_as_of_date DATE,
  period_start DATE,
  period_end DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_issuer_disclosures_entity
  ON issuer_disclosures(portfolio_entity_id, received_date DESC, id);

CREATE OR REPLACE FUNCTION validate_ee_position_link()
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
  IF linked_class IS DISTINCT FROM 'employment_equity'
     OR linked_entity_type IS DISTINCT FROM 'operating_company' THEN
    RAISE EXCEPTION 'Employment Equity record requires an Employment Equity position linked to an operating-company entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_ee_issuer_profile()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM portfolio_entities
     WHERE id = NEW.portfolio_entity_id AND entity_type = 'operating_company'
  ) THEN
    RAISE EXCEPTION 'Employment Equity issuer profile requires an operating-company entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_issuer_profiles_entity_guard ON employment_equity_issuer_profiles;
CREATE TRIGGER ee_issuer_profiles_entity_guard
  BEFORE INSERT OR UPDATE ON employment_equity_issuer_profiles
  FOR EACH ROW EXECUTE FUNCTION validate_ee_issuer_profile();

DROP TRIGGER IF EXISTS ee_positions_position_guard ON employment_equity_positions;
CREATE TRIGGER ee_positions_position_guard
  BEFORE INSERT OR UPDATE ON employment_equity_positions
  FOR EACH ROW EXECUTE FUNCTION validate_ee_position_link();

DROP TRIGGER IF EXISTS ee_grants_position_guard ON employment_equity_grants;
CREATE TRIGGER ee_grants_position_guard
  BEFORE INSERT OR UPDATE ON employment_equity_grants
  FOR EACH ROW EXECUTE FUNCTION validate_ee_position_link();

CREATE OR REPLACE FUNCTION validate_investment_lot_link()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  grant_investment_id INT;
BEGIN
  SELECT asset_class INTO linked_class FROM investments WHERE id = NEW.investment_id;
  IF linked_class NOT IN ('direct', 'employment_equity') THEN
    RAISE EXCEPTION 'investment lots require a Direct or Employment Equity position';
  END IF;
  IF NEW.grant_id IS NOT NULL THEN
    SELECT investment_id INTO grant_investment_id
      FROM employment_equity_grants WHERE id = NEW.grant_id;
    IF linked_class <> 'employment_equity' OR grant_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'lot grant belongs to another position';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS investment_lots_position_guard ON investment_lots;
CREATE TRIGGER investment_lots_position_guard
  BEFORE INSERT OR UPDATE ON investment_lots
  FOR EACH ROW EXECUTE FUNCTION validate_investment_lot_link();

CREATE OR REPLACE FUNCTION validate_ee_event_link()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  grant_investment_id INT;
  lot_investment_id INT;
  flow_investment_id INT;
  flow_type TEXT;
  flow_amount NUMERIC;
BEGIN
  SELECT asset_class INTO linked_class FROM investments WHERE id = NEW.investment_id;
  IF linked_class IS DISTINCT FROM 'employment_equity' THEN
    RAISE EXCEPTION 'Employment Equity event requires an Employment Equity position';
  END IF;
  IF NEW.grant_id IS NOT NULL THEN
    SELECT investment_id INTO grant_investment_id
      FROM employment_equity_grants WHERE id = NEW.grant_id;
    IF grant_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'event grant belongs to another position';
    END IF;
  END IF;
  IF NEW.lot_id IS NOT NULL THEN
    SELECT investment_id INTO lot_investment_id FROM investment_lots WHERE id = NEW.lot_id;
    IF lot_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'event lot belongs to another position';
    END IF;
  END IF;
  IF NEW.cash_flow_id IS NOT NULL THEN
    SELECT investment_id, type, amount
      INTO flow_investment_id, flow_type, flow_amount
      FROM cash_flows WHERE id = NEW.cash_flow_id;
    IF flow_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'event cash flow belongs to another position';
    END IF;
    IF NEW.event_type = 'exercise' AND NOT (flow_type = 'investment' AND flow_amount < 0) THEN
      RAISE EXCEPTION 'exercise requires a negative investment cash flow';
    END IF;
    IF NEW.event_type IN ('distribution', 'sale', 'tender', 'repurchase')
       AND NOT (flow_type = 'distribution' AND flow_amount > 0) THEN
      RAISE EXCEPTION 'cash return requires a positive distribution cash flow';
    END IF;
  END IF;
  IF NEW.event_type = 'exercise' AND NEW.cash_flow_id IS NULL THEN
    RAISE EXCEPTION 'exercise requires a negative investment cash flow';
  END IF;
  IF NEW.event_type IN ('exercise', 'settlement', 'forfeiture', 'expiration')
     AND NEW.units IS NULL THEN
    RAISE EXCEPTION 'Employment Equity unit event requires units';
  END IF;
  IF NEW.event_type IN ('distribution', 'sale', 'tender', 'repurchase')
     AND NEW.cash_flow_id IS NULL THEN
    RAISE EXCEPTION 'cash return requires a positive distribution cash flow';
  END IF;
  IF NEW.event_type IN ('grant', 'vest', 'settlement', 'forfeiture', 'expiration', 'basis_adjustment')
     AND NEW.cash_flow_id IS NOT NULL THEN
    RAISE EXCEPTION 'non-cash Employment Equity event cannot link a cash flow';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_events_link_guard ON employment_equity_events;
CREATE TRIGGER ee_events_link_guard
  BEFORE INSERT OR UPDATE ON employment_equity_events
  FOR EACH ROW EXECUTE FUNCTION validate_ee_event_link();

CREATE OR REPLACE FUNCTION protect_ee_event()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.investment_id IS DISTINCT FROM NEW.investment_id
     OR OLD.grant_id IS DISTINCT FROM NEW.grant_id
     OR OLD.lot_id IS DISTINCT FROM NEW.lot_id
     OR OLD.event_type IS DISTINCT FROM NEW.event_type
     OR OLD.event_date IS DISTINCT FROM NEW.event_date
     OR OLD.units IS DISTINCT FROM NEW.units
     OR OLD.gross_amount IS DISTINCT FROM NEW.gross_amount
     OR OLD.price_per_unit IS DISTINCT FROM NEW.price_per_unit
     OR OLD.cash_flow_id IS DISTINCT FROM NEW.cash_flow_id
     OR OLD.source_document_id IS DISTINCT FROM NEW.source_document_id
     OR OLD.external_hash IS DISTINCT FROM NEW.external_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'posted Employment Equity event facts are immutable';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'voided Employment Equity event cannot be edited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_events_immutable_guard ON employment_equity_events;
CREATE TRIGGER ee_events_immutable_guard
  BEFORE UPDATE ON employment_equity_events
  FOR EACH ROW EXECUTE FUNCTION protect_ee_event();

CREATE OR REPLACE FUNCTION protect_ee_cash_flow()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM employment_equity_events
     WHERE cash_flow_id = OLD.id AND voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'posted Employment Equity cash-flow facts are immutable; void and replace the event';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_cash_flows_immutable_guard ON cash_flows;
CREATE TRIGGER ee_cash_flows_immutable_guard
  BEFORE UPDATE OR DELETE ON cash_flows
  FOR EACH ROW EXECUTE FUNCTION protect_ee_cash_flow();

CREATE OR REPLACE FUNCTION validate_lot_allocation()
RETURNS TRIGGER AS $$
DECLARE
  lot_position_id INT;
  lot_remaining NUMERIC;
  event_position_id INT;
  event_flow_id INT;
  event_date_value DATE;
  event_type_value TEXT;
BEGIN
  SELECT investment_id, units_remaining
    INTO lot_position_id, lot_remaining
    FROM investment_lots WHERE id = NEW.lot_id;
  SELECT investment_id, cash_flow_id, event_date, event_type
    INTO event_position_id, event_flow_id, event_date_value, event_type_value
    FROM employment_equity_events WHERE id = NEW.event_id;
  IF lot_position_id IS DISTINCT FROM event_position_id
     OR event_type_value NOT IN ('sale', 'tender', 'repurchase') THEN
    RAISE EXCEPTION 'lot allocation requires a disposition event for the same position';
  END IF;
  IF event_flow_id IS NULL OR NEW.cash_flow_id IS DISTINCT FROM event_flow_id THEN
    RAISE EXCEPTION 'lot allocation must link the disposition cash flow';
  END IF;
  IF NEW.disposition_date IS DISTINCT FROM event_date_value THEN
    RAISE EXCEPTION 'lot allocation date must match the disposition event';
  END IF;
  IF lot_remaining IS NULL OR NEW.units_disposed > lot_remaining THEN
    RAISE EXCEPTION 'lot allocation exceeds remaining units';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lot_allocations_guard ON investment_lot_allocations;
CREATE TRIGGER lot_allocations_guard
  BEFORE INSERT OR UPDATE ON investment_lot_allocations
  FOR EACH ROW EXECUTE FUNCTION validate_lot_allocation();

CREATE OR REPLACE FUNCTION validate_ee_valuation_detail()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  parent_value NUMERIC;
BEGIN
  SELECT i.asset_class, v.net_value
    INTO linked_class, parent_value
    FROM valuations v
    JOIN investments i ON i.id = v.investment_id
   WHERE v.id = NEW.valuation_id;
  IF linked_class IS DISTINCT FROM 'employment_equity' THEN
    RAISE EXCEPTION 'Employment Equity valuation detail requires an Employment Equity position';
  END IF;
  IF parent_value IS DISTINCT FROM NEW.vested_value THEN
    RAISE EXCEPTION 'parent valuation net value must equal vested Employment Equity value';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ee_valuation_details_guard ON employment_equity_valuation_details;
CREATE TRIGGER ee_valuation_details_guard
  BEFORE INSERT OR UPDATE ON employment_equity_valuation_details
  FOR EACH ROW EXECUTE FUNCTION validate_ee_valuation_detail();

CREATE OR REPLACE FUNCTION validate_issuer_disclosure_link()
RETURNS TRIGGER AS $$
DECLARE
  document_entity_type TEXT;
  document_entity_id TEXT;
BEGIN
  SELECT entity_type, entity_id
    INTO document_entity_type, document_entity_id
    FROM documents WHERE id = NEW.document_id;
  IF document_entity_type IS DISTINCT FROM 'portfolio_entity'
     OR document_entity_id IS DISTINCT FROM NEW.portfolio_entity_id::text THEN
    RAISE EXCEPTION 'issuer disclosure document must attach to the same portfolio entity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issuer_disclosures_document_guard ON issuer_disclosures;
CREATE TRIGGER issuer_disclosures_document_guard
  BEFORE INSERT OR UPDATE ON issuer_disclosures
  FOR EACH ROW EXECUTE FUNCTION validate_issuer_disclosure_link();
