-- Migration 016: enforce cash_flow sign conventions via CHECK constraints
-- Why: one wrong-signed row silently skews IRR and net-invested math
-- (cash_flows comment says "signed: negative = capital out, positive = capital in").
-- deposit/withdrawal/adjustment rows can legitimately carry either sign; only
-- investment (outflow) and distribution/refund (inflows) have strict conventions.

ALTER TABLE cash_flows
  ADD CONSTRAINT cf_investment_negative
  CHECK (type <> 'investment' OR amount < 0);

ALTER TABLE cash_flows
  ADD CONSTRAINT cf_inflow_positive
  CHECK (type NOT IN ('distribution', 'refund') OR amount > 0);
