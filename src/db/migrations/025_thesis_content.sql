-- Migration 025: rich thesis content columns + lens_config table.
-- Why: Phase 8 cloud lens storage (Track 0.3). Editable lens state becomes
--      relational data — thesis content moves from lens theses/*.json into the
--      theses table, and outcome distributions move into a one-row lens_config
--      table. See docs/phase8/RADAR_CLOUD_LENS_ARCHITECTURE.md §2.

ALTER TABLE theses ADD COLUMN IF NOT EXISTS belief            TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS proves_true       TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS proves_false      TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS open_question     TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS conviction_now    SMALLINT CHECK (conviction_now BETWEEN 0 AND 5);
ALTER TABLE theses ADD COLUMN IF NOT EXISTS conviction_entry  SMALLINT CHECK (conviction_entry BETWEEN 0 AND 5);
ALTER TABLE theses ADD COLUMN IF NOT EXISTS qualifications    JSONB;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS exclusions        JSONB;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS conviction_signal TEXT;

-- Partial unique index on lens_thesis_id (the stable per-lens slug).
-- Safe on a fresh DB: lens_thesis_id was added structurally in migration 010 but
-- is never written by any code today (the AngelList import matches on name), so
-- every existing row has NULL here and the WHERE clause excludes them. The seed
-- script (Step 3.4) is the first writer; the UI generate-then-check in saveThesis
-- relies on this constraint to guarantee slug uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS theses_lens_thesis_id_key
  ON theses (lens_thesis_id)
  WHERE lens_thesis_id IS NOT NULL;

-- Distributions: single validated JSONB value in a one-row table.
-- The id=1 CHECK enforces the single-row invariant.
CREATE TABLE IF NOT EXISTS lens_config (
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  distributions JSONB NOT NULL,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
