-- Migration 006: investments_effective view
-- Derives unrealized/realized/multiple from valuations + cash_flows,
-- making investments a pure fact table for reads.

CREATE OR REPLACE VIEW investments_effective AS
SELECT
  i.id, i.company_name, i.status, i.invest_date, i.invested,
  i.investment_entity, i.lead, i.investment_type, i.round, i.market,
  i.fund_name, i.allocation, i.instrument, i.round_size,
  i.valuation_cap_type, i.valuation_cap, i.discount, i.carry,
  i.share_class, i.source, i.notes, i.stage_bucket,
  i.created_at, i.updated_at,
  -- From latest valuation snapshot
  lv.unrealized_value AS eff_unrealized_value,
  lv.realized_value AS eff_realized_value,
  lv.net_value AS eff_net_value,
  lv.multiple AS eff_multiple,
  lv.snapshot_date AS eff_snapshot_date,
  -- From cash_flows aggregates
  COALESCE(cf.total_invested, 0) AS cf_total_invested,
  COALESCE(cf.total_returned, 0) AS cf_total_returned,
  COALESCE(cf.total_refunded, 0) AS cf_total_refunded,
  COALESCE(cf.net_invested, i.invested) AS cf_net_invested,
  -- Best-available derived values (prefer computed, then valuation, then raw).
  -- When unrealized_value is NULL (locked by AngelList), treat as flat (value = invested, multiple = 1.0).
  CASE WHEN i.unrealized_value IS NULL AND i.net_value IS NULL AND lv.net_value IS NULL
       THEN i.invested
       ELSE COALESCE(i.computed_total_value, lv.net_value, i.net_value)
  END AS best_total_value,
  CASE WHEN i.unrealized_value IS NULL AND i.multiple IS NULL AND lv.multiple IS NULL
       THEN 1.0
       ELSE COALESCE(i.computed_multiple, lv.multiple, i.multiple)
  END AS best_multiple,
  COALESCE(i.computed_realized, lv.realized_value, i.realized_value, 0) AS best_realized
FROM investments i
LEFT JOIN LATERAL (
  SELECT v.unrealized_value, v.realized_value, v.net_value, v.multiple, v.snapshot_date
  FROM valuations v WHERE v.investment_id = i.id
  ORDER BY v.snapshot_date DESC LIMIT 1
) lv ON true
LEFT JOIN LATERAL (
  SELECT
    SUM(CASE WHEN cf2.type = 'investment' THEN ABS(cf2.amount) ELSE 0 END) AS total_invested,
    SUM(CASE WHEN cf2.type IN ('distribution','deposit') THEN cf2.amount ELSE 0 END) AS total_returned,
    SUM(CASE WHEN cf2.type = 'refund' THEN cf2.amount ELSE 0 END) AS total_refunded,
    SUM(CASE WHEN cf2.type = 'investment' THEN ABS(cf2.amount) ELSE 0 END)
      - SUM(CASE WHEN cf2.type = 'refund' THEN cf2.amount ELSE 0 END) AS net_invested
  FROM cash_flows cf2 WHERE cf2.investment_id = i.id
) cf ON true;
