-- Migration 029: fund-named pooled vehicles are not direct positions.
-- Migration 026 defaulted existing investments to 'direct', so correct rows
-- whose names contain the whole word "Fund". "Fundamental" does not match.

UPDATE investments
SET asset_class = 'fund',
    updated_at = NOW()
WHERE asset_class = 'direct'
  AND company_name ~* '(^|[^[:alnum:]_])fund([^[:alnum:]_]|$)';
