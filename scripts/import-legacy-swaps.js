// Auditable, read-only-by-default historical Discord swap stats import.
// Usage: node scripts/import-legacy-swaps.js --preview
//        node scripts/import-legacy-swaps.js --apply  (only after preview validation)
// Discord access in BOTH modes is GET-only. This script NEVER posts, edits or deletes Discord messages.
import 'dotenv/config';
import { URLSearchParams } from 'node:url';
import { randomUUID } from 'node:crypto';
import { REST, Routes } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';

const CHANNEL_ID = '1537472869947285675';
const OLD_BOT_ID = '1511078534649614336';
const NEW_BOT_ID = '1565170286137974976';
const USD_SCALE = 10n ** 18n;
const mode = process.argv[2] ?? '--preview';
const targetOrderOption = process.argv[3] ?? null;
if (process.argv.length > 4 || (targetOrderOption && targetOrderOption !== '--only-order=E92329')) {
  throw new Error('Only --only-order=E92329 is supported for a targeted final import');
}
const TARGET_ORDER = targetOrderOption ? 'E92329' : null;
const TARGET_AMOUNT_USD = '180.85';
if (!['--preview', '--apply'].includes(mode)) {
  throw new Error('Specify --preview (read-only) or --apply (transactional import).');
}
const config = loadConfig();
const rest = new REST({ version: '10' }).setToken(config.discordToken);
const pool = createPool(config);
const info = (event, data) => {
  // eslint-disable-next-line no-console
  console.log('LEGACY_IMPORT ' + JSON.stringify({ event, ...data }));
};

function toUsdUnits(value) {
  const input = String(value ?? '').trim().replaceAll(',', '');
  if (!/^(0|[1-9][0-9]{0,17})(?:\.([0-9]{1,18}))?$/.test(input)) {
    throw new Error('Invalid USD value');
  }
  const [whole, fraction = ''] = input.split('.');
  const units = BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(18, '0'));
  return units;
}
function usdString(units) {
  const base = units / USD_SCALE;
  const decimals = (units % USD_SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return decimals ? `${base}.${decimals}` : base.toString();
}
function amountForDb(value) { return usdString(value); }

function parseLegacyMessage(message) {
  if (String(message.author?.id) !== OLD_BOT_ID) return null; // Hard exclusion of all new-bot messages.
  if (!message.author?.bot) throw new Error('Legacy sender was not a bot account');
  if (message.embeds?.length !== 1) throw new Error('Expected exactly one completed-deal embed');
  const [embed] = message.embeds;
  if (String(embed.title).trim() !== '✅ Deal Complete') throw new Error('Unexpected legacy message title');

  const userMatch = /^Exchanged by\s+<@!?(\d{17,20})>\s*$/i.exec(String(message.content ?? '').trim());
  if (!userMatch) throw new Error('Cannot identify the original exchanging user');
  const description = String(embed.description ?? '');
  if (!/\b(?:total swap cost|network\s*\+\s*spread fee)\b/i.test(description)) throw new Error('Completed deal missing recognized swap cost marker');
  const usdSection = description.split('•')[0];
  const usdMatches = [...usdSection.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*→\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)];
  if (usdMatches.length !== 1) throw new Error('Expected exactly one USD sent/received pair');
  const amountUsd = toUsdUnits(usdMatches[0][1]);
  if (amountUsd <= 0n) throw new Error('Completed deal has no positive USD sent amount');
  // Existing live bot stats use the deposited/sent USD value, NOT the received USD or cost.
  const orderMatch = /^Order\s+([A-Fa-f0-9]{6})$/.exec(String(embed.footer?.text ?? '').trim());
  if (!orderMatch) throw new Error('Missing or invalid completed order reference');
  return {
    messageId: String(message.id),
    userId: userMatch[1],
    orderReference: orderMatch[1].toUpperCase(),
    amountUsd: amountForDb(amountUsd),
    amountUnits: amountUsd,
  };
}
function summarize(records) {
  const byUser = new Map();
  let totalUnits = 0n;
  for (const record of records) {
    const entry = byUser.get(record.userId) ?? { userId: record.userId, count: 0, units: 0n };
    entry.count++;
    entry.units += record.amountUnits;
    byUser.set(record.userId, entry);
    totalUnits += record.amountUnits;
  }
  return { byUser, totalUnits };
}

async function collectHistory() {
  const channel = await rest.get(Routes.channel(CHANNEL_ID));
  const guildId = String(channel.guild_id ?? '');
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Completed swaps channel is not attached to a guild');
  if (!config.guilds.some(guild => guild.guildId === guildId)) {
    throw new Error('Completed swaps channel is not in one of the configured bot guilds');
  }

  let before;
  let totalMessages = 0;
  let oldMessages = 0;
  let newMessages = 0;
  let pages = 0;
  const records = [];
  const errors = [];
  const seenMessages = new Set();
  const seenOrders = new Map();

  while (true) {
    const page = await rest.get(Routes.channelMessages(CHANNEL_ID), {
      query: new URLSearchParams({ limit: '100', ...(before ? { before } : {}) }),
    });
    if (!Array.isArray(page)) throw new Error('Unexpected Discord message history response');
    if (!page.length) break;
    pages++;
    totalMessages += page.length;
    before = page.at(-1).id;
    for (const message of page) {
      if (seenMessages.has(message.id)) {
        errors.push({ messageId: message.id, issue: 'Message appeared more than once in scan' });
        continue;
      }
      seenMessages.add(message.id);
      if (String(message.author?.id) === NEW_BOT_ID) { newMessages++; continue; }
      if (String(message.author?.id) !== OLD_BOT_ID) continue;
      oldMessages++;
      try {
        const record = parseLegacyMessage(message);
        const otherId = seenOrders.get(record.orderReference);
        if (otherId) {
          errors.push({ messageId: message.id, issue: 'Duplicate old order reference', otherId, order: record.orderReference });
          continue;
        }
        seenOrders.set(record.orderReference, record.messageId);
        records.push(record);
      } catch (error) {
        errors.push({ messageId: message.id, issue: error.message });
        // Sanitized examples help explain historical format changes; still read-only.
        if (errors.length <= 8 || errors.length % 20 === 0) {
          const redact = (value) => String(value ?? '')
            .replace(/0x[a-fA-F0-9]{40}/g, '[evm-address]')
            .replace(/bc1[a-zA-Z0-9]{20,}/g, '[btc-address]')
            .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,60}\b/g, '[chain-address]')
            .slice(0, 1200);
          info('format_issue', {
            messageId: message.id, issue: error.message,
            content: redact(message.content),
            embeds: (message.embeds ?? []).slice(0, 2).map(embed => ({
              title: redact(embed.title), description: redact(embed.description),
              fields: (embed.fields ?? []).map(field => ({
                name: redact(field.name), value: redact(field.value),
              })),
              footer: redact(embed.footer?.text),
            })),
          });
        }
      }
    }
    if (pages % 10 === 0) info('scan_progress', { pages, totalMessages, oldMessages, parsed: records.length });
  }
  if (oldMessages === 0) errors.push({ issue: 'No original bot messages were found; refusing empty migration' });
  return { guildId, totalMessages, oldMessages, newMessages, pages, records, errors };
}

async function readImportedRows(client, guildId) {
  const found = await client.query("SELECT to_regclass('legacy_swap_imports') AS import_table");
  if (!found.rows[0]?.import_table) return { available: false, byId: new Map() };
  const result = await client.query(
    'SELECT source_message_id, user_id, order_reference, amount_usd::TEXT AS amount_usd FROM legacy_swap_imports WHERE guild_id = $1 AND source_bot_id = $2',
    [guildId, OLD_BOT_ID],
  );
  return { available: true, byId: new Map(result.rows.map(row => [row.source_message_id, row])) };
}
function computePending(records, ledger, errors) {
  const pending = [];
  for (const record of records) {
    const imported = ledger.byId.get(record.messageId);
    if (!imported) { pending.push(record); continue; }
    if (imported.user_id !== record.userId
      || imported.order_reference !== record.orderReference
      || toUsdUnits(imported.amount_usd) !== record.amountUnits) {
      errors.push({ messageId: record.messageId, issue: 'Previously imported record does not match source message' });
    }
  }
  return pending;
}
async function readExistingStats(client, guildId) {
  const result = await client.query(
    'SELECT user_id, completed_swap_count::TEXT, total_amount_usd::TEXT FROM user_swap_stats WHERE guild_id = $1',
    [guildId],
  );
  return new Map(result.rows.map(row => [row.user_id, row]));
}

async function applyImport(scan) {
  const client = await pool.connect();
  const runId = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('legacy_swap_stats_import_' || $1))", [scan.guildId]);
    const ledger = await readImportedRows(client, scan.guildId);
    if (!ledger.available) throw new Error('Import ledger migration has not been deployed; run database migration 020 first');
    const errors = [];
    const pending = computePending(scan.records, ledger, errors);
    if (errors.length) throw new Error('Ledger conflicts detected: ' + JSON.stringify(errors));
    const { byUser } = summarize(pending);
    const before = await readExistingStats(client, scan.guildId);

    // Preserve an auditable snapshot of EVERY user whose totals will be modified.
    for (const user of byUser.values()) {
      const prior = before.get(user.userId);
      await client.query(
        `INSERT INTO legacy_swap_stat_backups
           (batch_id, guild_id, user_id, completed_swap_count_before, total_amount_usd_before)
         VALUES ($1::UUID, $2, $3, $4, $5)`,
        [runId, scan.guildId, user.userId, prior?.completed_swap_count ?? '0', prior?.total_amount_usd ?? '0'],
      );
    }

    const inserted = [];
    for (const record of pending) {
      const result = await client.query(
        `INSERT INTO legacy_swap_imports (guild_id, source_message_id, source_bot_id, user_id, order_reference, amount_usd)
         VALUES ($1, $2, $3, $4, $5, $6::NUMERIC)
         ON CONFLICT (guild_id, source_message_id) DO NOTHING
         RETURNING source_message_id`,
        [scan.guildId, record.messageId, OLD_BOT_ID, record.userId, record.orderReference, record.amountUsd],
      );
      if (result.rowCount !== 1) throw new Error('Unexpected concurrent duplicate insertion: ' + record.messageId);
      inserted.push(record);
    }
    for (const user of byUser.values()) {
      await client.query(
        `INSERT INTO user_swap_stats (guild_id, user_id, completed_swap_count, total_amount_usd)
         VALUES ($1, $2, $3::BIGINT, $4::NUMERIC)
         ON CONFLICT (guild_id, user_id) DO UPDATE
         SET completed_swap_count = user_swap_stats.completed_swap_count + EXCLUDED.completed_swap_count,
             total_amount_usd = user_swap_stats.total_amount_usd + EXCLUDED.total_amount_usd,
             updated_at = NOW()`,
        [scan.guildId, user.userId, user.count, amountForDb(user.units)],
      );
    }

    const after = await readExistingStats(client, scan.guildId);
    for (const user of byUser.values()) {
      const prior = before.get(user.userId);
      const updated = after.get(user.userId);
      if (BigInt(updated?.completed_swap_count ?? -1) !== BigInt(prior?.completed_swap_count ?? 0) + BigInt(user.count)
        || toUsdUnits(updated?.total_amount_usd ?? '0.0') !== (
          (prior && BigInt(prior.completed_swap_count) >= 0n ? toUsdUnits(prior.total_amount_usd) : 0n) + user.units
        )) {
        throw new Error('Post-write totals failed verification for user ' + user.userId);
      }
    }
    await client.query('COMMIT');
    info('applied', { runId, guildId: scan.guildId, importedSwaps: inserted.length, usersUpdated: byUser.size });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

try {
  info('start', { channelId: CHANNEL_ID, oldBotId: OLD_BOT_ID, newBotId: NEW_BOT_ID, mode, discordMode: 'GET_ONLY' });
  const fullScan = await collectHistory();
  let scan = fullScan;
  if (TARGET_ORDER) {
    const matches = fullScan.records.filter(record => record.orderReference === TARGET_ORDER);
    if (matches.length !== 1) throw new Error('Exactly one original-bot message must match order E92329; found ' + matches.length);
    if (matches[0].amountUsd !== TARGET_AMOUNT_USD) {
      throw new Error('Order E92329 USD sent value does not match the $180.85 shown in the source screenshot');
    }
    scan = { ...fullScan, oldMessages: 1, records: matches };
    const member = await rest.get(Routes.guildMember(scan.guildId, matches[0].userId)).catch(() => null);
    info('target_verified', {
      orderReference: TARGET_ORDER, messageId: matches[0].messageId,
      userId: matches[0].userId, amountUsd: matches[0].amountUsd,
      displayName: member?.nick ?? member?.user?.global_name ?? member?.user?.username ?? null,
      totalOldBotMessagesScanned: fullScan.oldMessages, totalMessagesScanned: fullScan.totalMessages,
    });
  }
  const client = await pool.connect();
  let pending;
  let ledger;
  let before;
  try {
    ledger = await readImportedRows(client, scan.guildId);
    pending = computePending(scan.records, ledger, scan.errors);
    before = await readExistingStats(client, scan.guildId);
  } finally {
    client.release();
  }
  const { byUser, totalUnits } = summarize(pending);
  info('scan_summary', {
    guildId: scan.guildId,
    channelId: CHANNEL_ID,
    totalMessages: scan.totalMessages,
    oldBotMessages: scan.oldMessages,
    newBotMessagesIgnored: scan.newMessages,
    parsedOldSwaps: scan.records.length,
    alreadyImported: scan.records.length - pending.length,
    pendingSwaps: pending.length,
    usersToUpdate: byUser.size,
    pendingVolumeUsd: usdString(totalUnits),
    feesSavedVsOnePercentUsd: usdString(totalUnits / 100n),
    errors: scan.errors,
    ...(TARGET_ORDER ? { targetOrder: TARGET_ORDER, oldBotMessagesScanned: fullScan.oldMessages } : {}),
  });
  for (const record of pending) {
    info('source_preview', { messageId: record.messageId, userId: record.userId, orderReference: record.orderReference, amountUsd: record.amountUsd });
  }
  for (const user of [...byUser.values()].sort((a, b) => (a.units > b.units ? -1 : a.units < b.units ? 1 : 0))) {
    const old = before.get(user.userId);
    const oldCount = BigInt(old?.completed_swap_count ?? 0);
    const oldUsd = old ? toUsdUnits(old.total_amount_usd) : 0n;
    info('user_preview', {
      userId: user.userId,
      existingSwaps: oldCount.toString(),
      existingVolumeUsd: usdString(oldUsd),
      historicalSwapsToAdd: user.count,
      historicalVolumeUsdToAdd: usdString(user.units),
      combinedSwaps: (oldCount + BigInt(user.count)).toString(),
      combinedVolumeUsd: usdString(oldUsd + user.units),
      combinedFeesSavedVsOnePercentUsd: usdString((oldUsd + user.units) / 100n),
    });
  }

  if (scan.errors.length) {
    if (mode === '--apply') throw new Error('Rejected: history contains unparseable/duplicate/conflicting records');
    info('preview_needs_review', { rejectedOldMessages: scan.errors.length, note: 'No changes made; revise older formats before applying.' });
  }
  if (scan.records.length !== scan.oldMessages && mode === '--apply') {
    throw new Error('Rejected: not every old-bot message was parsed');
  }
  if (mode === '--apply') {
    await applyImport(scan);
  } else {
    info('preview_complete', { note: 'NO database or Discord message changes; --apply was not used.' });
  }
} finally {
  await pool.end();
}
