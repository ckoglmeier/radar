-- Migration 013: status override column
-- Why: AngelList CSV is the source of truth for status, but some positions
-- (e.g. a position written off privately but still listed Live upstream) need a
-- sticky manual override that survives re-imports.

ALTER TABLE investments ADD COLUMN IF NOT EXISTS status_override TEXT;
