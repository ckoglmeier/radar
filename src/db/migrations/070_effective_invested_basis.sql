-- Migration 070: expose the lifecycle-aware invested basis used by returns.
-- Gross contributions remain available as cf_total_invested and the recorded
-- source fact remains investments.invested. Reports use best_invested_basis,
-- which nets linked refunds when a cash ledger exists.

CREATE OR REPLACE VIEW investments_effective AS
SELECT
  i.id, i.company_name,
  CASE
    WHEN closed.is_closed AND closed.close_event_type IN ('write_off', 'abandonment')
      THEN 'Written Off'
    WHEN closed.is_closed THEN 'Realized'
    ELSE COALESCE(i.status_override, i.status)
  END AS status,
  i.invest_date, i.invested,
  i.investment_entity, i.lead, i.investment_type, i.round, i.market,
  i.fund_name, i.allocation, i.instrument, i.round_size,
  i.valuation_cap_type, i.valuation_cap, i.discount, i.carry,
  i.share_class, i.source, i.notes, i.stage_bucket,
  i.created_at, i.updated_at,
  lv.unrealized_value AS eff_unrealized_value,
  lv.realized_value AS eff_realized_value,
  lv.net_value AS eff_net_value,
  lv.multiple AS eff_multiple,
  lv.snapshot_date AS eff_snapshot_date,
  COALESCE(cf.total_invested, 0) AS cf_total_invested,
  COALESCE(cf.total_returned, 0) AS cf_total_returned,
  COALESCE(cf.total_refunded, 0) AS cf_total_refunded,
  CASE WHEN cf.investment_count > 0 THEN cf.net_invested ELSE i.invested END AS cf_net_invested,
  CASE
    WHEN closed.is_closed THEN closed.realized_proceeds
    WHEN i.unrealized_value IS NULL AND i.net_value IS NULL AND lv.net_value IS NULL
      THEN i.invested
    ELSE COALESCE(i.computed_total_value, lv.net_value, i.net_value)
  END AS best_total_value,
  CASE
    WHEN closed.is_closed THEN closed.realized_proceeds /
      NULLIF(CASE WHEN cf.investment_count > 0 THEN cf.net_invested ELSE i.invested END, 0)
    WHEN i.unrealized_value IS NULL AND i.multiple IS NULL AND lv.multiple IS NULL
      THEN 1.0
    ELSE COALESCE(i.computed_multiple, lv.multiple, i.multiple)
  END AS best_multiple,
  CASE
    WHEN closed.is_closed THEN closed.realized_proceeds
    ELSE COALESCE(i.computed_realized, lv.realized_value, i.realized_value, 0)
  END AS best_realized,
  i.status_override,
  CASE
    WHEN closed.is_closed THEN 0::numeric(12,2)
    ELSE COALESCE(lv.unrealized_value, i.unrealized_value, i.invested)
  END AS best_unrealized_value,
  i.asset_class,
  closed.is_closed AS lifecycle_closed,
  closed.close_date AS effective_close_date,
  closed.close_event_type AS effective_close_event_type,
  -- Appended for CREATE OR REPLACE VIEW compatibility.
  CASE
    WHEN cf.investment_count > 0 THEN GREATEST(cf.net_invested, 0)
    ELSE i.invested
  END AS best_invested_basis
FROM investments i
LEFT JOIN LATERAL (
  SELECT v.unrealized_value, v.realized_value, v.net_value, v.multiple, v.snapshot_date
  FROM valuations v WHERE v.investment_id = i.id
  ORDER BY v.snapshot_date DESC, v.id DESC LIMIT 1
) lv ON true
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE cf2.type = 'investment') AS investment_count,
    SUM(CASE WHEN cf2.type = 'investment' THEN ABS(cf2.amount) ELSE 0 END) AS total_invested,
    SUM(CASE WHEN cf2.type IN ('distribution','deposit') THEN cf2.amount ELSE 0 END) AS total_returned,
    SUM(CASE WHEN cf2.type = 'distribution' AND cf2.amount > 0
              AND cf2.reconciliation_status = 'matched' THEN cf2.amount ELSE 0 END) AS matched_distributions,
    MAX(CASE WHEN cf2.type = 'distribution' AND cf2.amount > 0
              AND cf2.reconciliation_status = 'matched' THEN cf2.flow_date END) AS latest_distribution_date,
    SUM(CASE WHEN cf2.type = 'refund' THEN cf2.amount ELSE 0 END) AS total_refunded,
    SUM(CASE WHEN cf2.type = 'investment' THEN ABS(cf2.amount) ELSE 0 END)
      - SUM(CASE WHEN cf2.type = 'refund' THEN cf2.amount ELSE 0 END) AS net_invested
  FROM cash_flows cf2 WHERE cf2.investment_id = i.id
) cf ON true
LEFT JOIN LATERAL (
  SELECT e.event_date, e.event_type
  FROM direct_position_lifecycle_events e
  WHERE e.investment_id = i.id
    AND e.voided_at IS NULL
    AND e.event_type IN ('full_exit', 'dissolution', 'write_off', 'abandonment')
    AND e.remaining_interest = 'no'
  ORDER BY e.event_date DESC, e.created_at DESC, e.id DESC
  LIMIT 1
) terminal ON true
CROSS JOIN LATERAL (
  SELECT
    (COALESCE(i.status_override, i.status) IN ('Realized', 'Written Off') OR terminal.event_date IS NOT NULL) AS is_closed,
    COALESCE(terminal.event_date, cf.latest_distribution_date) AS close_date,
    terminal.event_type AS close_event_type,
    GREATEST(
      COALESCE(i.computed_realized, lv.realized_value, i.realized_value, 0),
      COALESCE(cf.matched_distributions, 0)
    ) AS realized_proceeds
) closed
WHERE i.asset_class = 'direct';
