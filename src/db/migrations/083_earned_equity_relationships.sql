-- Earned equity includes compensation for employment, advisory and board service.
-- Keep the historical asset class/table/API identifiers and existing origins.
ALTER TABLE employment_equity_positions
  DROP CONSTRAINT IF EXISTS employment_equity_positions_acquisition_origin_check;
ALTER TABLE employment_equity_positions
  ADD CONSTRAINT employment_equity_positions_acquisition_origin_check
  CHECK (acquisition_origin IN ('employment', 'advisory', 'board', 'other'));

ALTER TABLE employment_equity_issuer_profiles
  DROP CONSTRAINT IF EXISTS employment_equity_issuer_profiles_relationship_status_check;
ALTER TABLE employment_equity_issuer_profiles
  ADD CONSTRAINT employment_equity_issuer_profiles_relationship_status_check
  CHECK (relationship_status IN ('current_employee', 'former_employee', 'advisor', 'board_member', 'other'));
