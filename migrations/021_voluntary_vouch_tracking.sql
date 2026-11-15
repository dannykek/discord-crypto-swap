-- Track only swaps created after this migration. All existing swaps remain untracked.
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS track_vouch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE swaps ALTER COLUMN track_vouch SET DEFAULT TRUE;

-- Independent of the swap/ticket retention lifecycle so a closed ticket
-- does not erase the customer's pending vouch or its audit trail.
CREATE TABLE IF NOT EXISTS swap_vouch_requests (
  swap_id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vouch_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VOUCHED')),
  vouch_message_id TEXT UNIQUE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  vouched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'PENDING' AND vouch_message_id IS NULL AND vouched_at IS NULL)
      OR (status = 'VOUCHED' AND vouch_message_id IS NOT NULL AND vouched_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS swap_vouch_requests_pending_user_idx
  ON swap_vouch_requests (guild_id, user_id, completed_at DESC)
  WHERE status = 'PENDING';
