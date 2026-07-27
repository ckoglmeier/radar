-- Migration 036: persist operator disposition for imported cash flows.
--
-- Unlinked cash may be pending direct-position reconciliation, intentionally
-- ignored, or routed to the future Funds surface. Matching remains represented
-- by investment_id; the status makes every manual disposition auditable.

ALTER TABLE cash_flows
  ADD COLUMN IF NOT EXISTS reconciliation_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE cash_flows
  ADD COLUMN IF NOT EXISTS reconciliation_note TEXT;

ALTER TABLE cash_flows
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;

UPDATE cash_flows
SET reconciliation_status = 'matched',
    reconciled_at = COALESCE(reconciled_at, created_at)
WHERE investment_id IS NOT NULL
  AND reconciliation_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cash_flows_reconciliation
  ON cash_flows(reconciliation_status, investment_id);
