# Legacy Discord completed-swap statistics import

Migration target: Railway project `desirable-wisdom`, service `swap`, persistent PostgreSQL.

- Source Discord channel: `1537472869947285675`
- Retired bot ID: `1511078534649614336`
- Current bot ID: `1565170286137974976` (never included in historical imports)
- Guild: `1394554081246449807`

## Verified read-only baseline (2026-11-13)

A complete paginated Discord API scan reached the end of channel history.
There were **457 messages**, **447** authored by the retired bot and **10** authored by the current bot.
All 447 retired-bot messages had unique order references, a user mention and a parsable USD-sent amount.
Two known historical description labels were supported: "total swap cost" and "network + spread fee".
There were **36** users with old swaps, and old posted USD-sent amounts totaled **$63,499.11**.
At the current bot's existing 1%-of-volume display convention this is **$634.9911** fees saved before display rounding.

## Safety and provenance

- The scripts only use Discord REST GET requests. They never create, delete, edit or react to messages.
- Run `node scripts/import-legacy-swaps.js --preview` to scan and compare with current stats, without any database writes.
- Run `node scripts/import-legacy-swaps.js --apply` only after a full zero-error preview and `020_legacy_swap_stats_import.sql` are deployed.
- The importer stops if any old message cannot be parsed or a duplicate order reference or ledger conflict is detected.
- `legacy_swap_imports` records source message ID, source bot ID, order ref, user ID, and USD sent for idempotence.
- `legacy_swap_stat_backups` captures each affected user's original stats before the transactional update.
- Existing `user_swap_stats` totals are **incremented**, never replaced. Stats and `/leaderboard` read this same table.
- Transactions roll back if final per-user totals do not equal the previous totals plus newly imported records.
- **Remove the Railway pre-deploy import command after a successful one-time apply**, to keep future deployments ordinary.

This is a migration of posted historical USD-sent figures. The original completion embeds format fiat amounts to cents, so any sub-cent values not displayed historically cannot be reconstructed.

## Final one-order catch-up

The optional `--only-order=E92329` argument scopes the one-time importer to exactly one retired-bot completion message and checks that its posted USD-sent figure is $180.85. This protects every previously imported order from being modified. Run preview and verify user attribution before apply. No Discord messages are modified.
