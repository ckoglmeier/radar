-- Command conversations, durable receipts, and the Active/Inactive thesis
-- lifecycle used by Radar 0.6 conversational editing.

ALTER TABLE theses ADD COLUMN IF NOT EXISTS inactive_at DATE;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS inactive_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_investment_theses_one_primary
  ON investment_theses(investment_id)
  WHERE is_primary = TRUE;

CREATE TABLE IF NOT EXISTS command_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL DEFAULT 'Command',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS command_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES command_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  result_kind TEXT CHECK (result_kind IN ('question', 'clarification', 'confirmation', 'receipt', 'refusal')),
  result JSONB,
  proposal_id UUID REFERENCES command_proposals(id),
  receipt_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_command_messages_thread
  ON command_messages(thread_id, created_at, id);

CREATE TABLE IF NOT EXISTS command_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID REFERENCES command_threads(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL REFERENCES command_proposals(id),
  command_set_hash TEXT NOT NULL,
  required_policy TEXT NOT NULL CHECK (required_policy IN ('confirm_inline', 'secure_input')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'expired')),
  expires_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (proposal_id, command_set_hash)
);

CREATE TABLE IF NOT EXISTS command_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID UNIQUE REFERENCES command_proposals(id),
  parent_receipt_id UUID REFERENCES command_receipts(id),
  receipt JSONB NOT NULL,
  undo_state JSONB NOT NULL,
  undone_at TIMESTAMPTZ,
  undo_receipt_id UUID REFERENCES command_receipts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'command_messages_receipt_id_fkey'
  ) THEN
    ALTER TABLE command_messages
      ADD CONSTRAINT command_messages_receipt_id_fkey
      FOREIGN KEY (receipt_id) REFERENCES command_receipts(id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_command_receipts_created
  ON command_receipts(created_at DESC);
