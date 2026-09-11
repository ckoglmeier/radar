-- Migration 072: lossless evidence compaction.
--
-- `sha256` and `size_bytes` continue to identify the exact original upload.
-- `content` may now hold either those original bytes or Radar's deterministic
-- single-file ZIP representation. The model layer is the only supported byte
-- access path and always restores + verifies the original before returning it.

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS content_encoding TEXT NOT NULL DEFAULT 'identity';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS stored_size_bytes INT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS archive_sha256 TEXT;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS compaction_checked_at TIMESTAMPTZ;

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS compacted_at TIMESTAMPTZ;

UPDATE documents
   SET stored_size_bytes = octet_length(content)
 WHERE stored_size_bytes IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_compaction_candidates
  ON documents(content_encoding, compaction_checked_at);
