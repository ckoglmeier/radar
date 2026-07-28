-- Migration 039: durable, user-confirmed company aliases.
--
-- Aliases resolve imported names to a canonical company identity. They never
-- identify one investment lot; a company may still have multiple investments.

CREATE TABLE IF NOT EXISTS company_aliases (
  id SERIAL PRIMARY KEY,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL UNIQUE,
  canonical_company_name TEXT NOT NULL,
  canonical_normalized TEXT NOT NULL,
  provenance_source TEXT NOT NULL DEFAULT 'manual_match',
  provenance_note TEXT,
  confirmed_by TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_company_aliases_canonical
  ON company_aliases(canonical_normalized);
