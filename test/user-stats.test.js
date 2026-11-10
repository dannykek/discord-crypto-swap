import { describe, expect, it, vi } from 'vitest';
import { leaderboardPayload, payoutClosingPayload, statusUpdateEmbed, userStatsPayload } from '../src/discord/views.js';
import { TicketService } from '../src/services/ticket-service.js';
import { completedSwapAmountUsd } from '../src/utils/amounts.js';

const stats = {
  completed_swap_count: '4',
  total_amount_usd: '12500.5',
  fees_saved_usd: '125.005',
};

describe('user swap stats', () => {
  it('registers stats commands and removes stale global and guild /mutuals commands', async () => {
    const statsCommand = { name: 'stats', edit: vi.fn().mockResolvedValue(undefined) };
    const globalMutuals = { name: 'mutuals', delete: vi.fn().mockResolvedValue(undefined) };
    const guildMutuals = { name: 'mutuals', delete: vi.fn().mockResolvedValue(undefined) };
    const commands = {
      fetch: vi.fn().mockResolvedValue({ find: (predicate) => [statsCommand, guildMutuals].find(predicate) }),
      create: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TicketService({
      client: {
        application: {
          commands: {
            fetch: vi.fn().mockResolvedValue({ find: (predicate) => [globalMutuals].find(predicate) }),
          },
        },
        guilds: { fetch: vi.fn().mockResolvedValue({ id: 'guild', commands }) },
      },
      repositories: {}, catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: { info: vi.fn() },
    });

    await service.initializeCommands();

    expect(statsCommand.edit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'stats',
      options: [expect.objectContaining({ name: 'user', type: 6, required: false })],
    }));
    expect(commands.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'leaderboard' }));
    expect(globalMutuals.delete).toHaveBeenCalledOnce();
    expect(guildMutuals.delete).toHaveBeenCalledOnce();
  });

  it('uses the matched executable quote amount for completed volume', () => {
    expect(completedSwapAmountUsd({
      amount_usd_requested: '130',
      executable_quote: { quote: { amountInUsd: '127.35' } },
      last_status_response: { swapDetails: { depositedAmountUsd: '128' } },
    })).toBe('127.35');
  });

  it('keeps cumulative stats out of completion messages', () => {
    const success = statusUpdateEmbed({ status: 'SUCCESS' }, { userStats: stats }).toJSON();
    expect(success.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Your total exchanged' }));
    expect(success.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Fees saved vs. 1%' }));

    const closing = payoutClosingPayload(
      'owner',
      { destination_asset_id: 'usdt', executable_quote: { quote: { amountOutFormatted: '100' } } },
      { status: 'PROCESSING' },
      { getAsset: () => ({ symbol: 'USDT' }) },
      'ticket',
      new Date(Date.now() + 60_000),
    ).embeds[0].toJSON();
    expect(closing.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Your total exchanged' }));
    expect(closing.fields ?? []).not.toContainEqual(expect.objectContaining({ name: 'Fees saved vs. 1%' }));
  });

  it('renders /stats publicly for the requesting member', async () => {
    const repositories = { getUserSwapStats: vi.fn().mockResolvedValue(stats) };
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: {},
      coinPolicy: {},
      emojis: {},
      oneClick: {},
      qrService: {},
      config: { guildId: 'guild' },
      health: {},
      logger: {},
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'stats',
      guildId: 'guild',
      user: { id: 'user', username: 'Requester', displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/user/profile.png') },
      options: { getUser: vi.fn().mockReturnValue(null) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.handleInteraction(interaction)).resolves.toBe(true);

    expect(interaction.deferReply).toHaveBeenCalledWith();
    expect(repositories.getUserSwapStats).toHaveBeenCalledWith('guild', 'user', {
      includeSwapId: null,
      includeAmountUsd: null,
    });
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe("✦ Requester's Swap Stats");
    expect(embed.thumbnail.url).toBe('https://cdn.discordapp.com/avatars/user/profile.png');
    expect(interaction.user.displayAvatarURL).toHaveBeenCalledWith({ extension: 'png', size: 256 });
    expect(embed.fields).toEqual([
      { name: 'Total exchanged', value: '**$12,500.50**', inline: false },
      { name: 'Fees saved vs. 1%', value: '**$125.01**', inline: true },
      { name: 'Completed swaps', value: '**4**', inline: true },
    ]);
    expect(embed.footer.text).toContain('Danny’s Crypto Swap');
  });

  it('allows /stats to show another Discord user', async () => {
    const repositories = { getUserSwapStats: vi.fn().mockResolvedValue(stats) };
    const service = new TicketService({
      client: {}, repositories, catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: {},
    });
    const selectedUser = {
      id: 'other-user',
      username: 'SomeoneElse',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/other-user/global.png'),
    };
    const selectedMember = {
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/guilds/guild/users/other-user/avatars/server.png'),
    };
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'stats',
      guildId: 'guild',
      user: { id: 'requester', username: 'Requester' },
      options: { getUser: vi.fn().mockReturnValue(selectedUser), getMember: vi.fn().mockReturnValue(selectedMember) },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await service.handleInteraction(interaction);

    expect(repositories.getUserSwapStats).toHaveBeenCalledWith('guild', 'other-user', {
      includeSwapId: null,
      includeAmountUsd: null,
    });
    const embed = interaction.editReply.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.title).toBe("✦ SomeoneElse's Swap Stats");
    expect(embed.thumbnail.url).toBe('https://cdn.discordapp.com/guilds/guild/users/other-user/avatars/server.png');
    expect(selectedMember.displayAvatarURL).toHaveBeenCalledWith({ extension: 'png', size: 256 });
    expect(selectedUser.displayAvatarURL).not.toHaveBeenCalled();
  });

  it('renders the first server leaderboard page with purple styling and navigation', async () => {
    const userIds = [
      '100000000000000001',
      '100000000000000002',
      '100000000000000003',
      '100000000000000004',
      '100000000000000005',
      '100000000000000006',
    ];
    const entries = Array.from({ length: 5 }, (_, index) => ({
      user_id: userIds[index],
      completed_swap_count: String(6 - index),
      total_amount_usd: String((6 - index) * 1000),
    }));
    const repositories = {
      getUserSwapLeaderboardPage: vi.fn().mockResolvedValue({
        entries, total: 6, page: 0, pages: 2, pageSize: 5,
      }),
    };
    const service = new TicketService({
      client: {},
      repositories,
      catalogue: {}, coinPolicy: {}, emojis: {}, oneClick: {}, qrService: {},
      config: { guildId: 'guild' }, health: {}, logger: {},
    });
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'leaderboard',
      guildId: 'guild',
      user: { id: 'requester' },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(service.handleInteraction(interaction)).resolves.toBe(true);

    expect(repositories.getUserSwapLeaderboardPage).toHaveBeenCalledWith('guild', 0, 5);
    const payload = interaction.editReply.mock.calls[0][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe('✦ Server Swap Leaderboard');
    expect(embed.color).toBe(0x9892E8);
    expect(embed.description).toContain('🥇');
    expect(embed.description).toContain('<@100000000000000001>');
    expect(embed.description).toContain('$6,000.00');
    expect(embed.description).toContain('🥉');
    expect(embed.description).toContain('**#4**');
    expect(embed.description).not.toContain('Fees saved');
    expect(embed.footer.text).toContain('Page 1 of 2');
    expect(payload.allowedMentions).toEqual({ parse: [] });
    const buttons = payload.components[0].toJSON().components;
    expect(buttons.map((button) => button.custom_id)).toEqual(['lb:p:0', 'lb:p:1']);
    expect(buttons.map((button) => button.disabled)).toEqual([true, false]);
  });

  it('allows anyone in the configured server to page through the entire leaderboard', async () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      user_id: `1000000000000000${index + 11}`,
      total_amount_usd: String(1000 - index * 10),
      completed_swap_count: String(10 - index),
    }));
    const repositories = {
      getUserSwapLeaderboardPage: vi.fn().mockResolvedValue({
        entries, total: 12, page: 1, pages: 3, pageSize: 5,
      }),
    };
    const service = new TicketService({
      client: {}, repositories, catalogue: {}, coinPolicy: {}, emojis: {},
      oneClick: {}, qrService: {}, config: { guildId: 'guild' }, health: {}, logger: {},
    });
    const interaction = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'lb:p:1',
      guildId: 'guild',
      user: { id: 'another-member' },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    await expect(service.handleInteraction(interaction)).resolves.toBe(true);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(repositories.getUserSwapLeaderboardPage).toHaveBeenCalledWith('guild', 1, 5);
    const payload = interaction.editReply.mock.calls[0][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('**#6**');
    expect(embed.description).toContain('**#10**');
    expect(embed.footer.text).toContain('Page 2 of 3');
    const buttons = payload.components[0].toJSON().components;
    expect(buttons.map((button) => button.custom_id)).toEqual(['lb:p:0', 'lb:p:2']);
    expect(buttons.every((button) => !button.disabled)).toBe(true);
  });

  it('rejects invalid buttons and does not serve another guilds leaderboard', async () => {
    const repositories = { getUserSwapLeaderboardPage: vi.fn() };
    const service = new TicketService({
      client: {}, repositories, catalogue: {}, coinPolicy: {}, emojis: {},
      oneClick: {}, qrService: {}, config: { guildId: 'guild' }, health: {}, logger: {},
    });
    service.privateReply = vi.fn();
    const badPage = {
      isChatInputCommand: () => false, isButton: () => true,
      customId: 'lb:p:not-a-number', guildId: 'guild',
    };
    await expect(service.handleInteraction(badPage)).resolves.toBe(true);
    expect(service.privateReply).toHaveBeenCalledOnce();
    expect(repositories.getUserSwapLeaderboardPage).not.toHaveBeenCalled();
    service.privateReply.mockClear();
    const otherGuild = { ...badPage, customId: 'lb:p:1', guildId: 'other-guild' };
    await expect(service.handleInteraction(otherGuild)).resolves.toBe(true);
    expect(service.privateReply).toHaveBeenCalledOnce();
    expect(repositories.getUserSwapLeaderboardPage).not.toHaveBeenCalled();
  });

  it('has a clean branded footer and degrades safely without an avatar', () => {
    const embed = userStatsPayload(stats).embeds[0].toJSON();
    expect(embed.title).toBe('✦ Swap Stats');
    expect(embed).not.toHaveProperty('description');
    expect(embed).not.toHaveProperty('thumbnail');
    expect(embed.footer.text).toBe('Danny’s Crypto Swap • Completed exchanges');
  });

  it('uses the selected user avatar when a guild-specific avatar is unavailable', () => {
    const user = {
      username: 'Example',
      displayAvatarURL: vi.fn().mockReturnValue('https://cdn.discordapp.com/avatars/123/avatar.png'),
    };
    const embed = userStatsPayload(null, user).embeds[0].toJSON();
    expect(embed.thumbnail.url).toBe('https://cdn.discordapp.com/avatars/123/avatar.png');
    expect(embed.fields.map((field) => field.value)).toEqual(['**$0.00**', '**$0.00**', '**0**']);
  });

  it('shows an empty leaderboard cleanly and disables navigation on a single page', () => {
    const payload = leaderboardPayload([], { page: 0, pages: 1, total: 0, pageSize: 5 });
    const embed = payload.embeds[0].toJSON();
    expect(embed.description).toContain('No completed swaps');
    expect(embed.footer.text).toContain('Page 1 of 1');
    expect(payload.components).toEqual([]);
    const lastPage = leaderboardPayload([{
      user_id: '100000000000000020', completed_swap_count: '2', total_amount_usd: '55',
    }], { page: 2, pages: 3, total: 11, pageSize: 5 });
    const buttons = lastPage.components[0].toJSON().components;
    expect(buttons.map((button) => button.disabled)).toEqual([false, true]);
    expect(lastPage.embeds[0].toJSON().description).toContain('**#11**');
  });
});
