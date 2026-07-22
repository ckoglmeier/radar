-- Migration 027: deal_evaluations.company_name
--
-- An evaluation's identity was resolvable only by JOIN — matched
-- investment or linked pipeline invite. Evals for passed deals have
-- neither (no investment was ever created; pre-pipeline evals have no
-- invite), so they rendered nameless everywhere ("—") even though the
-- company name sits in their markdown heading and filename. These are
-- exactly the rows where the eval IS the only record of the deal —
-- pass memory must carry its own identity.
--
-- The importer has always parsed the company name from the heading (it
-- uses it for matching) — it just never persisted it. It does now.
-- Backfill for existing rows: src/db/backfill-eval-companies.js
-- (idempotent; parses raw_content, falls back to the filename slug).

ALTER TABLE deal_evaluations
  ADD COLUMN IF NOT EXISTS company_name TEXT;
