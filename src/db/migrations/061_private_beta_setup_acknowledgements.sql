-- Private Beta setup stores only versioned acknowledgements. Credentials,
-- workspace state, backup state, and provider health remain derived locally.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS beta_setup_version INT
    CHECK (beta_setup_version IS NULL OR beta_setup_version >= 0);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS beta_setup_completed_at TIMESTAMPTZ;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS beta_setup_dismissed_version INT
    CHECK (beta_setup_dismissed_version IS NULL OR beta_setup_dismissed_version >= 0);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS beta_setup_dismissed_at TIMESTAMPTZ;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS provider_egress_disclosure_version INT
    CHECK (provider_egress_disclosure_version IS NULL OR provider_egress_disclosure_version >= 0);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS provider_egress_disclosure_acknowledged_at TIMESTAMPTZ;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS update_disclosure_version INT
    CHECK (update_disclosure_version IS NULL OR update_disclosure_version >= 0);

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS update_disclosure_acknowledged_at TIMESTAMPTZ;
