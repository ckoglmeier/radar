-- Review is separate from interpretation: Radar may retain a useful readback
-- even when the user decides that no portfolio fact should change.

ALTER TABLE investment_updates
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
    review_status IN (
      'not_required',
      'pending_review',
      'reviewed_no_changes',
      'interpretation_rejected',
      'changes_applied'
    )
  ),
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS review_note TEXT;

UPDATE investment_updates
   SET review_status = 'pending_review'
 WHERE status = 'complete'
   AND review_status = 'not_required';

UPDATE investment_updates u
   SET review_status = 'changes_applied',
       reviewed_at = cp.reviewed_at,
       reviewed_by = cp.reviewed_by
  FROM command_proposals cp
 WHERE cp.source_update_id = u.id
   AND cp.status = 'applied';

CREATE INDEX IF NOT EXISTS idx_investment_updates_review
  ON investment_updates(review_status, received_date DESC)
  WHERE review_status = 'pending_review';
