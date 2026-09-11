-- Migration 073: keep additive document writers compatible.
--
-- Older restore fixtures and internal import paths may insert original bytes
-- without the optional stored-size metadata. The byte accessor safely derives
-- that size from `content`; model-owned writes continue recording it eagerly.

ALTER TABLE documents
  ALTER COLUMN stored_size_bytes DROP NOT NULL;
