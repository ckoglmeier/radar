-- Preserve the tax/reference 409A separately from Radar's economic common-share mark.

ALTER TABLE employment_equity_valuation_details
  ADD COLUMN IF NOT EXISTS tax_fmv_per_unit NUMERIC(18,6) CHECK (
    tax_fmv_per_unit IS NULL OR tax_fmv_per_unit >= 0
  );
