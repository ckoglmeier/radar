-- Migration 020: add raw_content cache column to company_updates and deal_evaluations
-- Why: markdown files remain the source of truth, but web/hosted consumers need to render
-- content without filesystem access. raw_content caches the full file text (frontmatter
-- included) at import time so the DB is self-contained for read-only API consumers.

ALTER TABLE company_updates ADD COLUMN IF NOT EXISTS raw_content TEXT;
ALTER TABLE deal_evaluations ADD COLUMN IF NOT EXISTS raw_content TEXT;
