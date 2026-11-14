-- Auditable, idempotent import ledger for completed swaps posted by the retired Discord bot.
-- The migration only creates tables. Historical totals are added separately after a validated dry run.
CREATE TABLE IF NOT EXISTS legacy_swap_imports (
  guild_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  order_reference TEXT NOT NULL,
  amount_usd NUMERIC(38, 18) NOT NULL CHECK (amount_usd > 0),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, source_message_id),
  CONSTRAINT legacy_swap_imports_unique_order UNIQUE (guild_id, source_bot_id, order_reference)
);

CREATE INDEX IF NOT EXISTS legacy_swap_imports_user_idx
  ON legacy_swap_imports (guild_id, user_id);

-- Restore point of the affected users' swap totals before each historical batch is applied.
CREATE TABLE IF NOT EXISTS legacy_swap_stat_backups (
  batch_id UUID NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  completed_swap_count_before BIGINT NOT NULL CHECK (completed_swap_count_before >= 0),
  total_amount_usd_before NUMERIC(38, 18) NOT NULL CHECK (total_amount_usd_before >= 0),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (batch_id, guild_id, user_id)
);
