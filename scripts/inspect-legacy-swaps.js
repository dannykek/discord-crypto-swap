// One-time, read-only inspection of a Discord completed-swaps channel.
// Does not send, edit, react to, or delete Discord messages; does not access the database.
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const CHANNEL_ID = '1537472869947285675';
const OLD_APP_ID = '1511078534649614336';
const NEW_APP_ID = '1565170286137974976';
const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('Missing DISCORD_TOKEN');

const rest = new REST({ version: '10' }).setToken(token);
const clip = (v, max = 900) => String(v ?? '')
  .replace(/0x[a-fA-F0-9]{40}/g, '[evm-address]')
  .replace(/bc1[a-zA-HJ-NP-Z0-9]{20,}/g, '[btc-address]')
  .replace(/\b[1-9A-HJ-NP-Za-km-z]{32,60}\b/g, '[chain-address]')
  .replace(/\s+/g, ' ').trim().slice(0, max);
const log = (event, data) => console.log('LEGACY_SCAN ' + JSON.stringify({ event, ...data }));

let before;
let pages = 0;
let allMessages = 0;
let oldBotMessages = 0;
let newBotMessages = 0;
let otherBotMessages = 0;
let userMessages = 0;
const authors = new Map();
const layouts = new Map();
const samples = [];
const firstAndLast = [];

log('starting', { channelId: CHANNEL_ID, oldAppId: OLD_APP_ID, mode: 'READ_ONLY' });
while (true) {
  const batch = await rest.get(Routes.channelMessages(CHANNEL_ID), { query: new URLSearchParams({ limit: '100', ...(before ? { before } : {}) }) });
  if (!Array.isArray(batch)) throw new Error('Discord returned an unexpected history response');
  if (!batch.length) break;
  pages++;
  allMessages += batch.length;
  const oldest = batch.at(-1);
  before = oldest.id;
  firstAndLast.push({ newest: batch[0].id, oldest: oldest.id });
  for (const msg of batch) {
    const botId = String(msg.application_id ?? '');
    const authorId = String(msg.author?.id ?? '');
    const isOld = authorId === OLD_APP_ID || botId === OLD_APP_ID;
    const isNew = authorId === NEW_APP_ID || botId === NEW_APP_ID;
    authors.set(authorId, (authors.get(authorId) ?? 0) + 1);
    if (isNew) { newBotMessages++; continue; }
    if (!isOld) {
      if (msg.author?.bot) otherBotMessages++;
      else userMessages++;
      continue;
    }
    oldBotMessages++;
    const embedSignature = (msg.embeds ?? []).map(e =>
      [e.title ?? '', (e.fields ?? []).map(f => f.name).join(' / ')].join(' :: ')
    ).join(' || ');
    const layout = embedSignature || (msg.content ? '[text only]' : '[no text]');
    layouts.set(layout, (layouts.get(layout) ?? 0) + 1);
    if (samples.length < 12 && (!samples.some(s => s.layout === layout) || samples.length < 3)) {
      samples.push({
        id: msg.id,
        authorId,
        applicationId: msg.application_id ?? null,
        timestamp: msg.timestamp,
        layout,
        content: clip(msg.content, 1000),
        embeds: (msg.embeds ?? []).slice(0, 3).map(e => ({
          title: clip(e.title, 200),
          description: clip(e.description, 1300),
          fields: (e.fields ?? []).slice(0, 20).map(f => ({ name: clip(f.name, 150), value: clip(f.value, 550) })),
          footer: clip(e.footer?.text, 150),
        })),
      });
    }
  }
  if (pages % 10 === 0) log('progress', { pages, allMessages, oldBotMessages });
}
log('summary', {
  pages, allMessages, oldBotMessages, newBotMessages, otherBotMessages, userMessages,
  oldestMessageId: firstAndLast.at(-1)?.oldest ?? null,
  newestMessageId: firstAndLast[0]?.newest ?? null,
  distinctAuthors: authors.size,
  topAuthors: [...authors].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, count]) => ({ id, count })),
  layouts: [...layouts].sort((a, b) => b[1] - a[1]).map(([layout, count]) => ({ layout: clip(layout, 300), count })),
});
for (const sample of samples) log('sample', sample);
log('complete', { note: 'Read-only scan; no messages or database records were modified.' });
