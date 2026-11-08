import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { TicketService } from '../src/services/ticket-service.js';

const GUILD_ID = '1394554081246449807';
const OWNER_IDS = ['1412664174042943518', '807314019684712468', '807312682637197353'];

function createFixture() {
  const ticket = {
    id: 'ticket', user_id: 'customer', guild_id: GUILD_ID, channel_id: 'ticket-channel',
    state: 'OPEN', step: 'ACTIVE', state_data: {},
  };
  const repositories = {
    getTicket: vi.fn().mockResolvedValue(ticket),
    touchTicket: vi.fn().mockResolvedValue(ticket),
  };
  const service = new TicketService({
    client: {},
    repositories, catalogue: {}, coinPolicy: {}, emojis: {},
    oneClick: {}, qrService: {},
    config: {
      guildId: GUILD_ID,
      ticketOwnerIds: OWNER_IDS,
      guilds: [{
        guildId: GUILD_ID, panelChannelId: 'panel', ticketCategoryId: 'category',
        completedDealsChannelId: 'completed', transcriptChannelId: 'transcripts',
        vouchChannelId: 'vouch',
      }],
    },
    health: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  service.routeTicketInteraction = vi.fn().mockResolvedValue(undefined);
  service.privateReply = vi.fn().mockResolvedValue(undefined);
  return { ticket, service, repositories };
}

function interaction(userId, action = 'close', channelId = 'ticket-channel', guildId = GUILD_ID) {
  return {
    customId: `t:ticket:${action}`,
    user: { id: userId }, channelId, guildId,
    isButton: () => true,
    isChatInputCommand: () => false,
  };
}

describe('server owner ticket closing permissions', () => {
  it.each(OWNER_IDS)('allows owner ID %s to use the close action', async (id) => {
    const { service, ticket } = createFixture();
    const request = interaction(id);
    expect(await service.handleInteraction(request)).toBe(true);
    expect(service.routeTicketInteraction).toHaveBeenCalledWith(request, ticket, 'close');
  });

  it.each(['close-confirm', 'close-cancel'])('allows owner confirmation action %s', async (action) => {
    const { service } = createFixture();
    expect(await service.handleInteraction(interaction(OWNER_IDS[0], action))).toBe(true);
    expect(service.routeTicketInteraction).toHaveBeenCalledOnce();
  });

  it('still allows the customer to use all of their own ticket buttons', async () => {
    const { service } = createFixture();
    expect(await service.handleInteraction(interaction('customer', 'back'))).toBe(true);
    expect(service.routeTicketInteraction).toHaveBeenCalledOnce();
  });

  it('does not allow owners to change somebody else\'s quote or swap details', async () => {
    const { service } = createFixture();
    await service.handleInteraction(interaction(OWNER_IDS[0], 'back'));
    expect(service.routeTicketInteraction).not.toHaveBeenCalled();
    expect(service.privateReply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('Only the member'));
  });

  it('blocks other members from closing somebody else\'s ticket', async () => {
    const { service } = createFixture();
    await service.handleInteraction(interaction('random-member', 'close'));
    expect(service.routeTicketInteraction).not.toHaveBeenCalled();
  });

  it('blocks owners from using close buttons in a different channel or server', async () => {
    const { service } = createFixture();
    await service.handleInteraction(interaction(OWNER_IDS[0], 'close', 'another-channel'));
    await service.handleInteraction(interaction(OWNER_IDS[0], 'close', 'ticket-channel', 'another-server'));
    expect(service.routeTicketInteraction).not.toHaveBeenCalled();
  });

  it('grants access to pre-existing tickets when the bot restarts', async () => {
    const { service, ticket, repositories } = createFixture();
    const edit = vi.fn().mockResolvedValue(undefined);
    const channel = {
      type: ChannelType.GuildText,
      permissionOverwrites: { cache: new Map(), edit },
    };
    service.client.channels = { fetch: vi.fn().mockResolvedValue(channel) };
    repositories.listOpenTickets = vi.fn().mockResolvedValue([{ ...ticket, progress_message_id: null }]);
    service.ensureTicketHeader = vi.fn().mockResolvedValue(undefined);
    service.removeLegacyTicketFooters = vi.fn().mockResolvedValue(undefined);

    await service.reconcileOpenTickets();

    expect(edit).toHaveBeenCalledTimes(3);
    for (const id of OWNER_IDS) {
      expect(edit).toHaveBeenCalledWith(id, {
        ViewChannel: true, ReadMessageHistory: true,
      }, { type: 1, reason: 'Permit authorized server owners to close swap tickets' });
    }
  });

  it('does not overwrite existing access for an owner who can already view the ticket', async () => {
    const { service, ticket } = createFixture();
    const edit = vi.fn();
    const channel = {
      type: ChannelType.GuildText,
      permissionOverwrites: {
        cache: new Map(OWNER_IDS.map((id) => [
          id,
          { allow: { has: (bits) => bits.includes(PermissionFlagsBits.ViewChannel) && bits.includes(PermissionFlagsBits.ReadMessageHistory) } },
        ])),
        edit,
      },
    };
    service.client.channels = { fetch: vi.fn().mockResolvedValue(channel) };
    await service.ensureOwnerTicketAccess(ticket);
    expect(edit).not.toHaveBeenCalled();
  });
});
