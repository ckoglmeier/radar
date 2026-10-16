-- Migration 091: Giving settings (the ongoing-intake opt-in).
-- Why: ongoing intake is a separate, explicit opt-in that a one-time import can never turn on.
-- Until a real email connector is authorized, the only mode is 'simulated' (labeled sample batches).

CREATE TABLE IF NOT EXISTS giving_settings (
  workspace_id TEXT PRIMARY KEY,
  ongoing_intake JSONB NOT NULL DEFAULT '{"enabled": false}'::jsonb CHECK (jsonb_typeof(ongoing_intake) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE giving_transitions DROP CONSTRAINT IF EXISTS giving_transitions_subject_type_check;
ALTER TABLE giving_transitions ADD CONSTRAINT giving_transitions_subject_type_check CHECK (subject_type IN ('request', 'pledge', 'gift', 'refund',
  'daf_contribution', 'source', 'source_item', 'organization', 'lens', 'budget', 'snapshot', 'settings'));
