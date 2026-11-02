ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS completion_summary_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_summary_abandoned_at TIMESTAMPTZ;
