-- Migration 059: canonical dated lifecycle facts for Direct positions.
--
-- This relation records disposition state only. Cash proceeds remain owned by
-- cash_flows and source evidence remains owned by documents. Historical status
-- labels are intentionally not backfilled because they do not establish dates.

CREATE TABLE IF NOT EXISTS direct_position_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investment_id INT NOT NULL REFERENCES investments(id),
  event_date DATE NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'partial_liquidity', 'full_exit', 'dissolution', 'write_off', 'abandonment'
    )
  ),
  remaining_interest TEXT NOT NULL CHECK (
    remaining_interest IN ('yes', 'no', 'unknown')
  ),
  cash_flow_id INT UNIQUE REFERENCES cash_flows(id),
  source_document_id INT REFERENCES documents(id),
  evidence_note TEXT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (NULLIF(BTRIM(idempotency_key), '') IS NOT NULL),
  voided_at TIMESTAMPTZ,
  void_reason TEXT,
  replacement_event_id UUID REFERENCES direct_position_lifecycle_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (voided_at IS NULL AND void_reason IS NULL AND replacement_event_id IS NULL) OR
    (voided_at IS NOT NULL AND NULLIF(BTRIM(void_reason), '') IS NOT NULL)
  ),
  CHECK (replacement_event_id IS NULL OR replacement_event_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_direct_lifecycle_position_date
  ON direct_position_lifecycle_events(investment_id, event_date, id);

CREATE OR REPLACE FUNCTION validate_direct_lifecycle_event()
RETURNS TRIGGER AS $$
DECLARE
  linked_class TEXT;
  flow_investment_id INT;
  flow_type TEXT;
  flow_amount NUMERIC;
  replacement_investment_id INT;
BEGIN
  SELECT asset_class INTO linked_class
    FROM investments WHERE id = NEW.investment_id;
  IF linked_class IS DISTINCT FROM 'direct' THEN
    RAISE EXCEPTION 'Direct lifecycle event requires a Direct position';
  END IF;

  IF NEW.cash_flow_id IS NOT NULL THEN
    SELECT investment_id, type, amount
      INTO flow_investment_id, flow_type, flow_amount
      FROM cash_flows WHERE id = NEW.cash_flow_id;
    IF flow_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'Direct lifecycle cash flow belongs to another position';
    END IF;
    IF flow_type IS DISTINCT FROM 'distribution' OR NOT (flow_amount > 0) THEN
      RAISE EXCEPTION 'Direct lifecycle proceeds require a positive distribution cash flow';
    END IF;
  END IF;

  IF NEW.event_type = 'partial_liquidity' AND NEW.remaining_interest = 'no' THEN
    RAISE EXCEPTION 'partial liquidity cannot record no remaining interest';
  END IF;
  IF NEW.event_type IN ('write_off', 'abandonment') AND NEW.cash_flow_id IS NOT NULL THEN
    RAISE EXCEPTION 'write-off and abandonment events cannot link proceeds';
  END IF;

  IF NEW.replacement_event_id IS NOT NULL THEN
    SELECT investment_id INTO replacement_investment_id
      FROM direct_position_lifecycle_events
     WHERE id = NEW.replacement_event_id;
    IF replacement_investment_id IS DISTINCT FROM NEW.investment_id THEN
      RAISE EXCEPTION 'replacement lifecycle event belongs to another position';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS direct_lifecycle_link_guard ON direct_position_lifecycle_events;
CREATE TRIGGER direct_lifecycle_link_guard
  BEFORE INSERT OR UPDATE ON direct_position_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION validate_direct_lifecycle_event();

CREATE OR REPLACE FUNCTION protect_direct_lifecycle_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Direct lifecycle events are append-only; void the event instead';
  END IF;
  IF OLD.investment_id IS DISTINCT FROM NEW.investment_id
     OR OLD.event_date IS DISTINCT FROM NEW.event_date
     OR OLD.event_type IS DISTINCT FROM NEW.event_type
     OR OLD.remaining_interest IS DISTINCT FROM NEW.remaining_interest
     OR OLD.cash_flow_id IS DISTINCT FROM NEW.cash_flow_id
     OR OLD.source_document_id IS DISTINCT FROM NEW.source_document_id
     OR OLD.evidence_note IS DISTINCT FROM NEW.evidence_note
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'posted Direct lifecycle facts are immutable';
  END IF;
  IF OLD.voided_at IS NOT NULL AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'voided Direct lifecycle event cannot be edited';
  END IF;
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NULL AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'Direct lifecycle event changes require a void';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS direct_lifecycle_immutable_guard ON direct_position_lifecycle_events;
CREATE TRIGGER direct_lifecycle_immutable_guard
  BEFORE UPDATE OR DELETE ON direct_position_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION protect_direct_lifecycle_event();

CREATE OR REPLACE FUNCTION protect_direct_lifecycle_cash_flow()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM direct_position_lifecycle_events
     WHERE cash_flow_id = OLD.id AND voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'linked Direct lifecycle proceeds are immutable; void and replace the lifecycle event';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS direct_lifecycle_cash_flow_guard ON cash_flows;
CREATE TRIGGER direct_lifecycle_cash_flow_guard
  BEFORE UPDATE OR DELETE ON cash_flows
  FOR EACH ROW EXECUTE FUNCTION protect_direct_lifecycle_cash_flow();
