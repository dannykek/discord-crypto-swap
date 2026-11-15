import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';
import { Repositories } from '../src/db/repositories.js';

const GUILD = '1394554081246449807';
const VOUCH_CHANNEL = '1394567035324731463';
const USER = '123456789012345678';
const TARGET = '<@1412664174042943518>';
const COPY = 'Vouch ' + TARGET + ' $42 (LTC → USDT BEP 20)';

function makeService({ repositories = {}, client = {}, health = { isReady: () => true } } = {}) {
  return new TicketService({
    client,
    repositories,
    catalogue: {},
    coinPolicy: {},
    emojis: {},
    oneClick: {},
    qrService: {},
    config: { guildId: GUILD, vouchChannelId: VOUCH_CHANNEL },
    health,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe('voluntary and mobile-friendly vouch tracking', () => {
  it('recognizes only real customer messages in the configured vouch channel', async () => {
    const send = vi.fn().mockResolvedValue({});
    const recordVouchSubmission = vi.fn().mockResolvedValue({
      swap_id: '5d0c420c-412a-40b1-925e-c147210c7336',
    });
    const getOpenTicketByChannel = vi.fn().mockResolvedValue(null);
    const service = makeService({
      repositories: { recordVouchSubmission, getOpenTicketByChannel },
      client: { users: { fetch: vi.fn().mockResolvedValue({ send }) } },
    });
    const message = {
      id: '1500000000000000001',
      guildId: GUILD,
      channelId: VOUCH_CHANNEL,
      author: { id: USER, bot: false },
      content: 'Loved the swap! Vouch ' + TARGET + ' $42 (LTC → USDT BEP 20)',
      createdAt: new Date('2026-11-15T17:00:00Z'),
    };
    await expect(service.handleMessage(message)).resolves.toBe(true);
    expect(recordVouchSubmission).toHaveBeenCalledWith(
      GUILD, USER, message.id, message.content, message.createdAt,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].embeds[0].toJSON().title).toContain('Vouch received');

    await expect(service.handleMessage({ ...message, id: '1500000000000000002',
      content: 'Hi there' })).resolves.toBe(false);
    await expect(service.handleMessage({ ...message, id: '1500000000000000003',
      author: { id: USER, bot: true } })).resolves.toBe(false);
    await expect(service.handleMessage({ ...message, id: '1500000000000000004',
      channelId: '1500000000000000005' })).resolves.toBe(false);
    expect(recordVouchSubmission).toHaveBeenCalledOnce();
  });

  it('reminds on the next swap, DMs a standalone vouch, and lets the user continue', async () => {
    const pending = { swap_id: 'swap-one', user_id: USER, guild_id: GUILD,
      vouch_text: COPY, completed_at: new Date('2026-11-15T12:00:00Z') };
    const send = vi.fn().mockResolvedValue({});
    const repositories = { listPendingVouchRequests: vi.fn().mockResolvedValue([pending]) };
    const service = makeService({
      repositories,
      client: { users: { fetch: vi.fn() } },
    });
    const interaction = {
      guildId: GUILD,
      user: { id: USER, username: 'member', send },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    await service.startTicket(interaction);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ content: COPY, allowedMentions: { parse: [] } });
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reminder = interaction.editReply.mock.calls[0][0];
    expect(reminder.embeds[0].toJSON().description).toContain('Vouching is voluntary');
    expect(reminder.embeds[0].toJSON().description).toContain('On mobile?');
    expect(reminder.components[0].toJSON().components.map(x => x.label)).toEqual([
      'Continue to Swap', 'Resend Vouch Text', 'Open Vouch Channel',
    ]);
    const buttonId = reminder.components[0].toJSON().components[0].custom_id;
    const continueInteraction = { customId: buttonId, guildId: GUILD,
      user: { id: USER }, isButton: () => true };
    const resume = vi.spyOn(service, 'startTicket').mockResolvedValue(undefined);
    await service.handleInteraction(continueInteraction);
    expect(resume).toHaveBeenCalledWith(continueInteraction, null, { skipVouchReminder: true });
  });

  it('preserves a quote selection when a customer chooses Continue to Swap', async () => {
    const service = makeService();
    const send = vi.fn().mockResolvedValue({});
    const selection = { originAssetId: 'LTC', destinationAssetId: 'USDT', amountBase: '1000' };
    const interaction = {
      guildId: GUILD, user: { id: USER, send },
      editReply: vi.fn(),
    };
    await service.offerVouchReminder(interaction, { vouchChannelId: VOUCH_CHANNEL },
      { vouch_text: COPY }, selection);
    const buttonId = interaction.editReply.mock.calls[0][0].components[0].toJSON()
      .components[0].custom_id;
    const resume = vi.spyOn(service, 'startTicket').mockResolvedValue();
    const response = { customId: buttonId, guildId: GUILD, user: { id: USER },
      isButton: () => true };
    await service.handleInteraction(response);
    expect(resume).toHaveBeenCalledWith(response, selection, { skipVouchReminder: true });
  });

  it('sends the copyable vouch again on request without forcing a new ticket', async () => {
    const service = makeService();
    const send = vi.fn().mockResolvedValue({});
    const requester = { guildId: GUILD, user: { id: USER, send }, editReply: vi.fn() };
    await service.offerVouchReminder(requester, { vouchChannelId: VOUCH_CHANNEL },
      { vouch_text: COPY }, null);
    const row = requester.editReply.mock.calls[0][0].components[0].toJSON();
    const resend = {
      customId: row.components[1].custom_id,
      guildId: GUILD, user: { id: USER, send }, isButton: () => true,
      reply: vi.fn(),
    };
    await service.handleInteraction(resend);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({ content: COPY, allowedMentions: { parse: [] } });
    expect(resend.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: 64 }),
    );
  });

  it('maps a matching posted vouch to its swap and never credits the same message twice', async () => {
    const early = new Date('2026-11-15T13:00:00Z');
    const late = new Date('2026-11-15T14:00:00Z');
    const posted = new Date('2026-11-15T15:00:00Z');
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [
        { swap_id: 'newer', vouch_text: 'Vouch ' + TARGET + ' $22 (ETH → BTC)', completed_at: late },
        { swap_id: 'older', vouch_text: COPY, completed_at: early },
      ] })
      .mockResolvedValueOnce({ rows: [{ swap_id: 'older', user_id: USER, vouch_text: COPY }] }) };
    const repos = new Repositories(pool);
    expect(await repos.recordVouchSubmission(GUILD, USER, 'message-1',
      COPY, posted)).toMatchObject({ swap_id: 'older' });
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][1][0]).toBe('older');
    expect(pool.query.mock.calls[1][1][1]).toBe('message-1');
    expect(pool.query.mock.calls[1][1][3]).toBe(GUILD);
    expect(pool.query.mock.calls[1][1][4]).toBe(USER);
  });

  it('does not count a message posted before the swap completed', async () => {
    const pool = { query: vi.fn().mockResolvedValue({
      rows: [{ swap_id: 'future-swap', vouch_text: COPY,
        completed_at: new Date('2026-11-16T10:00:00Z') }],
    }) };
    const repos = new Repositories(pool);
    await expect(repos.recordVouchSubmission(GUILD, USER, 'old-vouch', COPY,
      new Date('2026-11-15T10:00:00Z'))).resolves.toBeNull();
    expect(pool.query).toHaveBeenCalledOnce();
  });
});
