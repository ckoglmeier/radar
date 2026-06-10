-- Track which lens each thesis came from and maintain stable IDs across updates
ALTER TABLE theses ADD COLUMN IF NOT EXISTS lens_source TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS lens_thesis_id TEXT;

COMMENT ON COLUMN theses.lens_source IS 'Name of the lens plugin that created this thesis (e.g., ck-conviction-era)';
COMMENT ON COLUMN theses.lens_thesis_id IS 'Stable thesis ID within the lens (e.g., ai-infra). Used for cross-lens updates.';
