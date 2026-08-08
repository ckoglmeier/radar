-- Migration 047: remove the weak legacy uniqueness constraint only after
-- migration 046 backfills importer links and the importer uses them.

ALTER TABLE investments
  DROP CONSTRAINT IF EXISTS investments_company_name_invest_date_key;
